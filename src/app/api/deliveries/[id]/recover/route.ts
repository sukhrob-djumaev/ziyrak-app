import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { recoverDelivery } from "@/lib/conversations/delivery";
import { toErrorResponse } from "@/lib/observability/errors";
import { jobQueue } from "@/lib/jobs/queue";
import { RETRY_DELIVERY_JOB, type RetryDeliveryPayload } from "@/lib/jobs/job-types";
import "@/lib/jobs/bootstrap";
const schema = z
  .object({
    decision: z.enum(["confirm_accepted", "cancel", "resend"]),
    reason: z.string().trim().min(5).max(500),
    requestId: z.string().uuid(),
    acknowledgeDuplicateRisk: z.boolean().optional(),
  })
  .strict();
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth(request, "actions:approve");
  if (!isAuthenticated(ctx)) return ctx;
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success)
    return NextResponse.json(
      { error: { message: "Provide a valid decision and reason." } },
      { status: 400 }
    );
  try {
    const { id } = await params;
    const op = await recoverDelivery(ctx, id, input.data);
    if (op.status === "ready")
      await jobQueue.enqueue<RetryDeliveryPayload>(
        RETRY_DELIVERY_JOB,
        { businessId: ctx.businessId, deliveryId: op.id },
        {
          idempotencyKey: "recovery:" + op.id + ":" + input.data.requestId,
          singletonKey: op.conversationId ?? op.id,
        }
      );
    return NextResponse.json({ id: op.id, status: op.status });
  } catch (error) {
    return toErrorResponse(error);
  }
}
