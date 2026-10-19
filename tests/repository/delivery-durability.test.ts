import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import {
  ensureDelivery,
  prepareDelivery,
  dispatchDelivery,
  recoverDelivery,
} from "@/lib/conversations/delivery";
import { authorizeSeededFollowup } from "../helpers/followup-fixtures";
import { authorizeFollowupSubmission } from "@/lib/tools/followup-authority";
import type { TenantContext } from "@/lib/tenancy/context";
import { SEND_FOLLOWUP_JOB } from "@/lib/jobs/job-types";
import { registerChannelAdapter } from "@/lib/channels/registry";
import type { SendResult } from "@/lib/channels/types";
let business: SeededBusiness, connectionId: string;
const channel = "durability-test";
let send: (text: string) => Promise<SendResult>;
beforeAll(async () => {
  business = await seedBusiness("delivery-durability");
  connectionId = (
    await prisma.channelConnection.create({
      data: {
        businessId: business.businessId,
        type: channel,
        name: "Synthetic durability provider",
        isActive: true,
      },
    })
  ).id;
  registerChannelAdapter(channel, {
    type: channel,
    capabilities: {
      supportsMedia: false,
      supportsTemplates: false,
      supportsTypingIndicator: false,
      supportsDeliveryReceipts: false,
      supportsMultipleConnections: true,
    },
    validateInbound: async () => ({ kind: "rejected", reason: "test" }),
    getStatus: async () => ({ connected: true }),
    sendMessage: async (_ctx, _id, _to, content) => send(content.text),
  });
});
afterAll(async () => {
  if (business) await cleanupBusiness(business.businessId);
});
function worker(): TenantContext {
  return {
    ...business.ctx,
    role: null,
    authorization: undefined,
    actor: { kind: "system_job", jobId: randomUUID(), jobType: SEND_FOLLOWUP_JOB },
  };
}
const dispatch = (id: string) => dispatchDelivery(worker(), id, authorizeFollowupSubmission);
async function fixture(response?: string) {
  const conv = await prisma.conversation.create({
    data: {
      businessId: business.businessId,
      channel,
      customerContact: "synthetic-recipient",
      metadata: { channelConnectionId: connectionId },
    },
  });
  // Controlled real authority prerequisite; this suite targets transport durability.
  const action = await prisma.actionExecution.create({
    data: {
      businessId: business.businessId,
      conversationId: conv.id,
      tool: "schedule_followup",
      status: "scheduled",
      requestedBy: business.ownerUserId,
      input: { message: response ?? "Persisted reply" },
      idempotencyKey: randomUUID(),
    },
  });
  await authorizeSeededFollowup(business.ctx, action.id, conv.id, connectionId);
  const input = {
    operationKey: randomUUID(),
    kind: "followup" as const,
    actionId: action.id,
    conversationId: conv.id,
    channel,
    connectionId,
    recipient: conv.customerContact,
    response,
  };
  const op = await ensureDelivery(business.ctx, input);
  return { conv, input, op };
}
describe("delivery durability (real Postgres, controlled synthetic provider faults)", () => {
  it("reuses a persisted reply after a known refusal without replaying preparation", async () => {
    const f = await fixture();
    let prepared = 0,
      attempts = 0;
    send = async (text) => {
      expect(text).toBe("Persisted reply");
      return ++attempts === 1
        ? { success: false, outcome: "rejected", retryable: true }
        : { success: true, providerMessageId: "synthetic-accepted" };
    };
    const prepare = async () => {
      prepared++;
      return { conversationId: f.conv.id, response: "Persisted reply" };
    };
    await prepareDelivery(business.ctx, f.op, prepare);
    expect((await dispatch(f.op.id)).status).toBe("rejected");
    const reloaded = await ensureDelivery({ ...business.ctx }, f.input);
    await prepareDelivery({ ...business.ctx }, reloaded, prepare);
    expect((await dispatch(f.op.id)).status).toBe("accepted");
    await dispatch(f.op.id);
    expect(prepared).toBe(1);
    expect(attempts).toBe(2);
    expect(
      await prisma.message.count({ where: { conversationId: f.conv.id, role: "assistant" } })
    ).toBe(1);
  });
  it("blocks resend after external acceptance and a real transcript transaction failure", async () => {
    const f = await fixture("Faulted persistence reply");
    let attempts = 0;
    send = async () => {
      attempts++;
      return { success: true, providerMessageId: "synthetic-provider-accepted" };
    };
    // Test-owned trigger affects only this UUID in the isolated test database.
    const suffix = randomUUID().replaceAll("-", "");
    const trigger = "delivery_fault_" + suffix;
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."conversationId" = '${f.conv.id}' THEN RAISE EXCEPTION 'controlled transcript persistence fault'; END IF; RETURN NEW; END $$`
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON "Message" FOR EACH ROW EXECUTE FUNCTION ${trigger}()`
    );
    try {
      const result = await dispatch(f.op.id);
      expect(result.status).toBe("unknown");
      expect(result.providerMessageId).toBe("synthetic-provider-accepted");
      expect(await prisma.message.count({ where: { conversationId: f.conv.id } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON "Message"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }
    await dispatch(f.op.id);
    expect(attempts).toBe(1);
    await recoverDelivery(business.ctx, f.op.id, {
      decision: "confirm_accepted",
      reason: "Synthetic provider acceptance verified",
      requestId: randomUUID(),
    });
    expect(await prisma.message.count({ where: { conversationId: f.conv.id } })).toBe(1);
  });
  it("keeps completed preparation side effects for review and never replays them", async () => {
    const f = await fixture();
    let preparations = 0,
      sends = 0;
    send = async () => {
      sends++;
      return { success: true };
    };
    const prepare = async (record: (id: string) => Promise<void>) => {
      preparations++;
      await record(f.conv.id);
      await prisma.internalNote.create({
        data: {
          businessId: business.businessId,
          conversationId: f.conv.id,
          content: "Synthetic completed side effect",
          authorName: "Test",
        },
      });
      throw new Error("Controlled crash after a completed tool side effect");
    };
    await expect(prepareDelivery(business.ctx, f.op, prepare)).rejects.toThrow("Controlled crash");
    const resumed = await prepareDelivery({ ...business.ctx }, f.op, prepare);
    expect(resumed.status).toBe("preparation_interrupted");
    expect(resumed.response).toBeNull();
    await dispatch(f.op.id);
    expect(preparations).toBe(1);
    expect(sends).toBe(0);
    expect(await prisma.internalNote.count({ where: { conversationId: f.conv.id } })).toBe(1);
    await expect(
      recoverDelivery(business.ctx, f.op.id, {
        decision: "resend",
        reason: "Reviewed completed side effect",
        requestId: randomUUID(),
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("allows one external dispatch when workers compete for the same saved reply", async () => {
    const f = await fixture("Concurrent reply");
    let attempts = 0;
    send = async () => {
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { success: true };
    };
    const results = await Promise.allSettled([dispatch(f.op.id), dispatch(f.op.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(attempts).toBe(1);
    expect(
      (await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: f.op.id } })).status
    ).toBe("accepted");
  });
});
