import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import {
  seedBusiness,
  addMember,
  cleanupBusiness,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";
import { jobQueue } from "@/lib/jobs/queue";
import {
  EXECUTE_CAMPAIGN_JOB,
  RETRY_DELIVERY_JOB,
  type ExecuteCampaignPayload,
} from "@/lib/jobs/job-types";
import { handleRetryDelivery } from "@/lib/jobs/handlers/retry-delivery";
import { recoverDelivery } from "@/lib/conversations/delivery";
import { handleExecuteCampaign } from "@/lib/jobs/handlers/execute-campaign";
import { startCampaignRun } from "@/lib/campaigns/campaign-run";
import { generateToken, verifyToken, revokeToken } from "@/lib/identity/auth";
import { registerChannelAdapter } from "@/lib/channels/registry";
import { deleteCustomerData } from "@/lib/customers/gdpr";
import { retirementContext } from "@/lib/tenancy/work-lifecycle";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { retireConversationWork } from "@/lib/conversations/retire-work";

/**
 * P1 campaign execution: the requester's authority is saved when the run is created and
 * rechecked per recipient at the single sending admission; the worker sends only the frozen
 * run copy, at most once per recipient. Real isolated Postgres, no provider.
 */
const CHANNEL = "test-campaign-run";
let a: SeededBusiness;
let sent: ReturnType<typeof vi.fn>;
let queued: ExecuteCampaignPayload[];
let connectionId: string;

beforeEach(async () => {
  a = await seedBusiness("campaign-run");
  queued = [];
  sent = vi.fn().mockResolvedValue({ success: true, providerMessageId: "synthetic-accepted" });
  registerChannelAdapter(CHANNEL, {
    type: CHANNEL,
    capabilities: {
      supportsMedia: false,
      supportsTemplates: false,
      supportsTypingIndicator: false,
      supportsDeliveryReceipts: false,
      supportsMultipleConnections: true,
    },
    validateInbound: async () => ({ kind: "rejected", reason: "controlled fixture" }),
    sendMessage: sent,
    getStatus: async () => ({ connected: true }),
  });
  vi.spyOn(jobQueue, "enqueue").mockImplementation(async (type, payload) => {
    if (type === EXECUTE_CAMPAIGN_JOB) queued.push(payload as ExecuteCampaignPayload);
    return "paused-campaign-fixture";
  });
  connectionId = (
    await prisma.channelConnection.create({
      data: {
        businessId: a.businessId,
        type: CHANNEL,
        name: "Synthetic campaign line",
        isActive: true,
      },
    })
  ).id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupBusiness(a.businessId);
});

const worker = (): TenantContext => ({
  businessId: a.businessId,
  role: null,
  actor: { kind: "system_job", jobId: randomUUID(), jobType: EXECUTE_CAMPAIGN_JOB },
  dataConnection: "shared-default",
});
async function customers(n: number) {
  const rows = [];
  for (let i = 0; i < n; i++)
    rows.push(
      await prisma.customer.create({
        data: {
          businessId: a.businessId,
          name: `C${i}`,
          phone: `+1555000${i}${randomUUID().slice(0, 4)}`,
        },
      })
    );
  return rows;
}
async function campaign(message = "Synthetic offer") {
  return prisma.campaign.create({
    data: { businessId: a.businessId, name: "Run", channel: CHANNEL, message, segments: [] },
  });
}
/** A human requester with a real membership; owner ctx lacks a session binding, so use a member. */
async function requester(role = "admin") {
  const member = await addMember(a.businessId, role, "campaign-requester");
  return member;
}
async function start(ctx: TenantContext, campaignId: string) {
  const result = await startCampaignRun(ctx, campaignId);
  const payload = queued.at(-1)!;
  return { result, payload };
}
const run = (payload: ExecuteCampaignPayload) => handleExecuteCampaign(worker(), payload);
const ops = (runId: string) =>
  prisma.deliveryOperation.findMany({
    where: { businessId: a.businessId, campaignRunId: runId },
    orderBy: { operationKey: "asc" },
  });

describe("P1 campaign run: saved authority and frozen content", () => {
  it("creates a run with a saved requester snapshot and queues only ids", async () => {
    const who = await requester();
    const [c1] = await customers(1);
    const camp = await campaign();
    const { result, payload } = await start(who.ctx, camp.id);
    expect(result.targetCount).toBe(1);
    expect(payload).toEqual({ businessId: a.businessId, runId: result.runId });
    const row = await prisma.campaignRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(row.message).toBe("Synthetic offer");
    expect(row.connectionId).toBe(connectionId);
    expect(row.targetCustomerIds).toEqual([c1.id]);
    expect(JSON.stringify(row.authorizationSnapshot)).toContain(who.userId);
  });

  it("sends the frozen message to the frozen targets after the campaign is edited", async () => {
    const who = await requester();
    const [c1] = await customers(1);
    const camp = await campaign("Frozen text");
    const { payload } = await start(who.ctx, camp.id);
    await prisma.campaign.update({ where: { id: camp.id }, data: { message: "Edited later" } });
    await customers(1); // a later customer must not join the run
    await run(payload);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][3]).toMatchObject({ text: "Frozen text" });
    const [op] = await ops(payload.runId);
    expect(op.operationKey).toBe(`campaign:${payload.runId}:${c1.id}`);
    expect(op.status).toBe("accepted");
    expect(op.kind).toBe("campaign");
  });

  it("records each accepted send as an assistant message and counts only accepted sends", async () => {
    const who = await requester();
    await customers(2);
    const { payload } = await start(who.ctx, (await campaign()).id);
    await run(payload);
    const finished = await prisma.campaignRun.findUniqueOrThrow({ where: { id: payload.runId } });
    expect(finished.status).toBe("completed");
    const camp = await prisma.campaign.findFirstOrThrow({ where: { businessId: a.businessId } });
    expect(camp.sentCount).toBe(2);
    const messages = await prisma.message.findMany({
      where: { businessId: a.businessId, role: "assistant" },
    });
    expect(messages).toHaveLength(2);
  });
});

describe("P1 campaign run: requester authority is rechecked at admission", () => {
  for (const [label, change] of [
    [
      "removed membership",
      async (userId: string) => {
        await prisma.membership.deleteMany({ where: { businessId: a.businessId, userId } });
      },
    ],
    [
      "demotion below automation:create",
      async (userId: string) => {
        await prisma.membership.updateMany({
          where: { businessId: a.businessId, userId },
          data: { role: "agent" },
        });
      },
    ],
    [
      "restriction to another connection",
      async (userId: string) => {
        const other = await prisma.channelConnection.create({
          data: { businessId: a.businessId, type: CHANNEL, name: "Other", isActive: true },
        });
        const m = await prisma.membership.findFirstOrThrow({
          where: { businessId: a.businessId, userId },
        });
        await prisma.membership.update({ where: { id: m.id }, data: { scopeMode: "connections" } });
        await prisma.membershipConnectionScope.create({
          data: { businessId: a.businessId, membershipId: m.id, connectionId: other.id },
        });
      },
    ],
  ] as const) {
    it(`sends nothing after ${label} between execute and send`, async () => {
      const who = await requester();
      await customers(2);
      const { payload } = await start(who.ctx, (await campaign()).id);
      await change(who.userId);
      await run(payload);
      expect(sent).not.toHaveBeenCalled();
      const rows = await ops(payload.runId);
      for (const op of rows) {
        expect(["rejected", "pending", "ready"]).toContain(op.status);
        expect(op.status).not.toBe("accepted");
      }
    });
  }

  it("creates no recipient conversations and cancels the run when the requester lost authority before it began", async () => {
    const who = await requester();
    await customers(3);
    const { payload } = await start(who.ctx, (await campaign()).id);
    await prisma.membership.deleteMany({ where: { businessId: a.businessId, userId: who.userId } });
    await run(payload);
    expect(sent).not.toHaveBeenCalled();
    expect(
      await prisma.conversation.count({
        where: {
          businessId: a.businessId,
          metadata: { path: ["campaignRunId"], equals: payload.runId },
        },
      })
    ).toBe(0);
    expect(await ops(payload.runId)).toHaveLength(0);
    expect(
      (await prisma.campaignRun.findUniqueOrThrow({ where: { id: payload.runId } })).status
    ).toBe("cancelled");
  });

  it("stops the remaining recipients when authority is revoked mid-run", async () => {
    const who = await requester();
    await customers(3);
    const { payload } = await start(who.ctx, (await campaign()).id);
    sent.mockImplementationOnce(async () => {
      await prisma.membership.deleteMany({
        where: { businessId: a.businessId, userId: who.userId },
      });
      return { success: true, providerMessageId: "first" };
    });
    await run(payload);
    expect(sent).toHaveBeenCalledTimes(1);
    const statuses = (await ops(payload.runId)).map((o) => o.status);
    expect(statuses.filter((s) => s === "accepted")).toHaveLength(1);
  });
});

describe("P1 campaign run: schedules survive the requester's logout", () => {
  it("still sends after the requester's session is revoked, as a bounded delegated job", async () => {
    const who = await requester();
    const token = generateToken(who.userId);
    const session = verifyToken(token)!;
    const ctx: TenantContext = {
      ...who.ctx,
      authorization: {
        kind: "membership",
        userId: who.userId,
        membershipId: (who.ctx.authorization as { membershipId: string }).membershipId,
        sessionJti: session.jti,
        sessionExpiresAt: session.exp,
      },
    };
    await customers(2);
    const { payload } = await start(ctx, (await campaign()).id);
    await revokeToken(token); // logout
    await run(payload);
    expect(sent).toHaveBeenCalledTimes(2);
    const actual = sent.mock.calls[0][0] as TenantContext;
    expect(actual.role).toBeNull();
    expect(actual.actor.kind).toBe("system_job");
    expect(actual.authorization).toMatchObject({
      kind: "delegated_job",
      allowedOperations: ["messages:create"],
    });
    await prisma.revokedToken.deleteMany({ where: { userId: who.userId } });
  });
});

describe("P1 campaign run: at most one send per recipient", () => {
  it("a redelivered job after completion sends nothing more", async () => {
    const who = await requester();
    await customers(2);
    const { payload } = await start(who.ctx, (await campaign()).id);
    await run(payload);
    await run(payload);
    expect(sent).toHaveBeenCalledTimes(2);
    expect(await ops(payload.runId)).toHaveLength(2);
  });

  it("a retry after a partial run sends only the recipients not yet attempted", async () => {
    const who = await requester();
    await customers(3);
    const { payload } = await start(who.ctx, (await campaign()).id);
    sent.mockImplementationOnce(async () => ({ success: true, providerMessageId: "one" }));
    sent.mockImplementationOnce(async () => {
      throw new Error("worker crashed mid-send");
    });
    await run(payload).catch(() => undefined);
    const firstPass = sent.mock.calls.length;
    await run(payload);
    // The crashed recipient is "unknown" and is never auto-resent; the accepted one is not repeated.
    expect(sent.mock.calls.length).toBeLessThanOrEqual(3);
    expect(sent.mock.calls.length).toBeGreaterThanOrEqual(firstPass);
    const rows = await ops(payload.runId);
    expect(rows).toHaveLength(3);
    expect(rows.filter((o) => o.status === "accepted").length).toBeLessThanOrEqual(2);
    expect(new Set(rows.map((o) => o.operationKey)).size).toBe(3);
  });

  it("two workers on one run send each recipient once", async () => {
    const who = await requester();
    await customers(4);
    const { payload } = await start(who.ctx, (await campaign()).id);
    await Promise.allSettled([run(payload), run(payload)]);
    expect(sent).toHaveBeenCalledTimes(4);
  });
});

describe("P1 campaign run: start-time boundaries", () => {
  it("refuses a requester without automation:create", async () => {
    const who = await requester("agent");
    await customers(1);
    await expect(startCampaignRun(who.ctx, (await campaign()).id)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(queued).toHaveLength(0);
  });

  it("refuses a connection-restricted requester whose scope excludes the campaign connection", async () => {
    const who = await requester();
    const other = await prisma.channelConnection.create({
      data: { businessId: a.businessId, type: "other-type", name: "Other", isActive: true },
    });
    const restricted: TenantContext = {
      ...who.ctx,
      resourceScope: {
        kind: "connections",
        connectionIds: [other.id],
        customerProfileAccess: "read",
      },
    };
    await customers(1);
    await expect(startCampaignRun(restricted, (await campaign()).id)).rejects.toBeDefined();
    expect(queued).toHaveLength(0);
  });

  it("refuses another workspace's campaign with the not-found shape", async () => {
    const b = await seedBusiness("campaign-run-b");
    try {
      const foreign = await prisma.campaign.create({
        data: {
          businessId: b.businessId,
          name: "Foreign",
          channel: CHANNEL,
          message: "x",
          segments: [],
        },
      });
      const who = await requester();
      await expect(startCampaignRun(who.ctx, foreign.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    } finally {
      await cleanupBusiness(b.businessId);
    }
  });

  it("refuses a worker payload naming another workspace's run", async () => {
    const b = await seedBusiness("campaign-run-c");
    try {
      const who = await requester();
      await customers(1);
      const { payload } = await start(who.ctx, (await campaign()).id);
      await handleExecuteCampaign(
        { ...worker(), businessId: b.businessId },
        { businessId: b.businessId, runId: payload.runId }
      );
      expect(sent).not.toHaveBeenCalled();
    } finally {
      await cleanupBusiness(b.businessId);
    }
  });

  it("refuses a second run while one is still pending or running", async () => {
    const who = await requester();
    await customers(1);
    const camp = await campaign();
    await startCampaignRun(who.ctx, camp.id);
    await expect(startCampaignRun(who.ctx, camp.id)).rejects.toMatchObject({
      code: "CAMPAIGN_RUN_ACTIVE",
    });
    expect(queued).toHaveLength(1);
  });

  it("does not send when the campaign has no active connection and says so", async () => {
    const who = await requester();
    await customers(1);
    const camp = await prisma.campaign.create({
      data: {
        businessId: a.businessId,
        name: "No line",
        channel: "no-line",
        message: "x",
        segments: [],
      },
    });
    await expect(startCampaignRun(who.ctx, camp.id)).rejects.toBeDefined();
    expect(queued).toHaveLength(0);
  });
});

describe("P1 campaign run: erasure", () => {
  it("retires an unsent recipient operation with its conversation and never sends it afterwards", async () => {
    const who = await requester();
    await customers(2);
    const { payload } = await start(who.ctx, (await campaign()).id);
    // The first send revokes the requester, so the second recipient is prepared but refused at admission.
    sent.mockImplementationOnce(async () => {
      await prisma.membership.deleteMany({
        where: { businessId: a.businessId, userId: who.userId },
      });
      return { success: true, providerMessageId: "first" };
    });
    await run(payload);
    const unsent = (await ops(payload.runId)).filter((o) => o.status !== "accepted");
    expect(unsent).toHaveLength(1);
    // Recipient order comes from an unordered query: retire whichever recipient was left unsent.
    const conversation = { id: unsent[0].conversationId! };
    await retireConversationWork(getScopedPrisma(retirementContext(worker())), [conversation.id]);
    await run(payload);
    expect(sent).toHaveBeenCalledTimes(1);
    const op = await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: unsent[0].id } });
    expect(op.retiredAt).not.toBeNull();
    expect(op.recipient).toBe("");
    expect(op.response).toBe("[REDACTED - GDPR]");
  });
});

describe("P1 campaign run: review hardening", () => {
  it("two simultaneous starts create exactly one run", async () => {
    const who = await requester();
    await customers(2);
    const camp = await campaign();
    const results = await Promise.allSettled([
      startCampaignRun(who.ctx, camp.id),
      startCampaignRun(who.ctx, camp.id),
      startCampaignRun(who.ctx, camp.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.campaignRun.count({ where: { businessId: a.businessId } })).toBe(1);
    expect(queued).toHaveLength(1);
  });

  it("a failed enqueue cancels the run so the campaign can be started again", async () => {
    const who = await requester();
    await customers(1);
    const camp = await campaign();
    vi.mocked(jobQueue.enqueue).mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(startCampaignRun(who.ctx, camp.id)).rejects.toThrow("queue unavailable");
    const [failed] = await prisma.campaignRun.findMany({ where: { businessId: a.businessId } });
    expect(failed.status).toBe("cancelled");
    await expect(startCampaignRun(who.ctx, camp.id)).resolves.toMatchObject({ targetCount: 1 });
  });

  it("sends nothing when the requester is re-scoped to specific channels after starting", async () => {
    const who = await requester();
    await customers(2);
    const { payload } = await start(who.ctx, (await campaign()).id);
    const m = await prisma.membership.findFirstOrThrow({
      where: { businessId: a.businessId, userId: who.userId },
    });
    await prisma.membership.update({ where: { id: m.id }, data: { scopeMode: "connections" } });
    await prisma.membershipConnectionScope.create({
      data: { businessId: a.businessId, membershipId: m.id, connectionId },
    });
    await run(payload);
    expect(sent).not.toHaveBeenCalled();
  });

  it("per-recipient keys, not only the finished-run shortcut, prevent a second send", async () => {
    const who = await requester();
    await customers(3);
    const { payload } = await start(who.ctx, (await campaign()).id);
    await run(payload);
    await prisma.campaignRun.update({ where: { id: payload.runId }, data: { status: "running" } });
    await run(payload);
    expect(sent).toHaveBeenCalledTimes(3);
  });

  it("never re-sends a recipient whose outcome was uncertain, and sends the rest exactly once", async () => {
    const who = await requester();
    await customers(3);
    const { payload } = await start(who.ctx, (await campaign()).id);
    sent.mockResolvedValueOnce({ success: true, providerMessageId: "one" });
    sent.mockRejectedValueOnce(new Error("worker crashed mid-send"));
    await run(payload);
    await prisma.campaignRun.update({ where: { id: payload.runId }, data: { status: "running" } });
    await run(payload);
    expect(sent).toHaveBeenCalledTimes(3);
    const statuses = (await ops(payload.runId)).map((o) => o.status).sort();
    expect(statuses).toEqual(["accepted", "accepted", "unknown"]);
  });

  it("customer erasure removes the customer from unfinished runs and nothing is sent to them", async () => {
    const who = await requester();
    const [c1, c2] = await customers(2);
    const { payload } = await start(who.ctx, (await campaign()).id);
    await deleteCustomerData(a.ctx, c2.id, true);
    const row = await prisma.campaignRun.findUniqueOrThrow({ where: { id: payload.runId } });
    expect(row.targetCustomerIds).toEqual([c1.id]);
    await run(payload);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe("P1 recovery resend: the approving person is rechecked at admission", () => {
  /** One recipient whose first send is uncertain, then a human approves a resend. */
  async function resendReady() {
    const requesterMember = await requester();
    const approver = await addMember(a.businessId, "admin", "recovery-approver");
    await customers(1);
    const { payload } = await start(requesterMember.ctx, (await campaign()).id);
    sent.mockRejectedValueOnce(new Error("worker crashed mid-send"));
    await run(payload);
    const [op] = await ops(payload.runId);
    expect(op.status).toBe("unknown");
    await recoverDelivery(approver.ctx, op.id, {
      decision: "resend",
      reason: "synthetic recovery decision",
      acknowledgeDuplicateRisk: true,
      requestId: randomUUID(),
    });
    const retry = () =>
      handleRetryDelivery(
        {
          ...worker(),
          actor: { kind: "system_job", jobId: randomUUID(), jobType: RETRY_DELIVERY_JOB },
        },
        { businessId: a.businessId, deliveryId: op.id }
      );
    return { op, approver, requesterMember, retry };
  }

  it("resends once when both the requester and the approver still hold authority", async () => {
    const { op, retry } = await resendReady();
    await retry();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(
      (await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: op.id } })).status
    ).toBe("accepted");
  });

  for (const [label, change] of [
    [
      "removed approver",
      (a2: { userId: string }) =>
        prisma.membership.deleteMany({ where: { businessId: a.businessId, userId: a2.userId } }),
    ],
    [
      "demoted approver",
      (a2: { userId: string }) =>
        prisma.membership.updateMany({
          where: { businessId: a.businessId, userId: a2.userId },
          data: { role: "agent" },
        }),
    ],
  ] as const) {
    it(`does not resend after a ${label}`, async () => {
      const { op, approver, retry } = await resendReady();
      await change(approver);
      await retry().catch(() => undefined);
      expect(sent).toHaveBeenCalledTimes(1);
      const row = await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: op.id } });
      expect(row.status).not.toBe("accepted");
    });
  }

  it("does not resend when the original requester lost authority even if the approver is valid", async () => {
    const { requesterMember, retry } = await resendReady();
    await prisma.membership.deleteMany({
      where: { businessId: a.businessId, userId: requesterMember.userId },
    });
    await retry().catch(() => undefined);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("does not resend when the approver is now limited to other channels", async () => {
    const { approver, retry } = await resendReady();
    const other = await prisma.channelConnection.create({
      data: { businessId: a.businessId, type: "other-type", name: "Other", isActive: true },
    });
    const m = await prisma.membership.findFirstOrThrow({
      where: { businessId: a.businessId, userId: approver.userId },
    });
    await prisma.membership.update({ where: { id: m.id }, data: { scopeMode: "connections" } });
    await prisma.membershipConnectionScope.create({
      data: { businessId: a.businessId, membershipId: m.id, connectionId: other.id },
    });
    await retry().catch(() => undefined);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an approved resend that recorded no approver membership", async () => {
    const { op, retry } = await resendReady();
    const row = await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: op.id } });
    const log = (row.recoveryLog as Record<string, unknown>[]).map((entry) => {
      const { actorMembershipId: _removed, ...rest } = entry;
      void _removed;
      return rest;
    });
    await prisma.deliveryOperation.update({ where: { id: op.id }, data: { recoveryLog: log } });
    await retry().catch(() => undefined);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
