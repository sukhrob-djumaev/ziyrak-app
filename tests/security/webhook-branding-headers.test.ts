import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("@/lib/prisma/raw-client", async (original) => original());

vi.mock("@/lib/integrations/http-dispatcher", () => ({
  dispatchHttpRequest: vi.fn(async () => ({ ok: true, status: 200, statusText: "OK" })),
}));
import { prisma } from "@/lib/prisma/raw-client";
import {
  seedBusiness,
  addMember,
  cleanupBusiness,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";
import { jobQueue } from "@/lib/jobs/queue";
import { retryDelivery } from "@/lib/integrations/webhook-delivery";
import { DELIVER_WEBHOOK_JOB, type DeliverWebhookPayload } from "@/lib/jobs/job-types";
import { handleDeliverWebhook } from "@/lib/jobs/handlers/deliver-webhook";
import { generateSignature } from "@/lib/integrations/webhook-delivery";
import { dispatchHttpRequest } from "@/lib/integrations/http-dispatcher";

/**
 * R5 branding transition: outgoing webhooks carry the Ziyrak names and keep the legacy
 * `X-Owly-Signature` header (same value) so existing receivers keep verifying.
 */
let a: SeededBusiness;
const SECRET = "r5-fixture-webhook-secret";

beforeEach(async () => {
  a = await seedBusiness("webhook-brand");
  vi.mocked(dispatchHttpRequest).mockClear();
  vi.stubEnv("WEBHOOK_SECRET", SECRET);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupBusiness(a.businessId);
});

describe("R5 outgoing webhook identity", () => {
  it("sends Ziyrak user agent and signature, plus the legacy Owly signature with the same value", async () => {
    const webhook = await prisma.webhook.create({
      data: {
        businessId: a.businessId,
        name: "Synthetic hook",
        url: "https://example.invalid/hook",
        triggerOn: "ticket.created",
      },
    });
    const payload = { synthetic: true };
    const delivery = await prisma.webhookDelivery.create({
      data: {
        businessId: a.businessId,
        webhookId: webhook.id,
        event: "ticket.created",
        payload,
        status: "failed",
      },
    });
    const ctx: TenantContext = {
      businessId: a.businessId,
      role: null,
      actor: { kind: "system_job", jobId: randomUUID(), jobType: DELIVER_WEBHOOK_JOB },
      dataConnection: "shared-default",
    };
    const queued: DeliverWebhookPayload[] = [];
    vi.spyOn(jobQueue, "enqueue").mockImplementation(async (type, p) => {
      if (type === DELIVER_WEBHOOK_JOB) queued.push(p as DeliverWebhookPayload);
      return "paused-webhook-fixture";
    });
    const admin = await addMember(a.businessId, "admin", "webhook-brand-admin");
    expect(await retryDelivery(admin.ctx, delivery.id)).toBe(true);
    await handleDeliverWebhook(ctx, queued[0]);
    const headers = vi.mocked(dispatchHttpRequest).mock.calls[0][1].headers as Record<
      string,
      string
    >;
    const expected = generateSignature(JSON.stringify(payload), SECRET);
    expect(headers["User-Agent"]).toBe("Ziyrak-Webhook/1.0");
    expect(headers["X-Ziyrak-Signature"]).toBe(expected);
    expect(headers["X-Owly-Signature"]).toBe(expected);
  });
});
