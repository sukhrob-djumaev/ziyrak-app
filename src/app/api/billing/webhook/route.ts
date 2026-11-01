import { NextRequest, NextResponse } from "next/server";
import { readBoundedBody, PayloadTooLargeError, BodyDeadlineError, DEFAULT_PUBLIC_BODY_BYTES } from "@/lib/http/bounded-body";
import { getPaymentProvider } from "@/lib/billing/providers";
import { ProviderError } from "@/lib/billing/providers/types";
import { recordProviderEvent } from "@/lib/billing/provider-events";
import { jobQueue } from "@/lib/jobs/queue";
import { PROCESS_PROVIDER_EVENT_JOB } from "@/lib/jobs/job-types";
import { logger } from "@/lib/observability/logger";

/**
 * L5.1 - payment provider webhook. Order matters: bounded read, then signature, and only then any database work, so an
 * unauthenticated caller can cost us nothing but a capped read and an HMAC. A verified event is stored before we answer
 * 200 (the provider will not resend after that); processing happens in the control-plane job.
 */
export async function POST(request: NextRequest) {
  const provider = getPaymentProvider();
  if (!provider) return NextResponse.json({ status: "disabled" }, { status: 404 });

  let rawBody: Buffer;
  try {
    rawBody = await readBoundedBody(request, DEFAULT_PUBLIC_BODY_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return NextResponse.json({ status: "payload_too_large" }, { status: 413 });
    if (error instanceof BodyDeadlineError) return NextResponse.json({ status: "request_timeout" }, { status: 408 });
    throw error;
  }

  let event;
  try {
    event = provider.verifyWebhook(rawBody, request.headers.get("stripe-signature") ?? "", new Date());
  } catch (error) {
    if (error instanceof ProviderError) return NextResponse.json({ status: "invalid_signature" }, { status: 400 });
    throw error;
  }

  try {
    const { id, created } = await recordProviderEvent(provider.name, event, rawBody);
    if (created) await jobQueue.enqueue(PROCESS_PROVIDER_EVENT_JOB, { businessId: "", eventId: id }, { singletonKey: id });
    return NextResponse.json({ status: created ? "received" : "duplicate" });
  } catch (error) {
    // Not stored or not queued: answer 5xx so the provider redelivers.
    logger.error("[billing-webhook] could not store or queue event", error);
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
