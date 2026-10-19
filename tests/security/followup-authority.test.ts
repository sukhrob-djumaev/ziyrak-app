import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { generateToken, verifyToken, revokeToken } from "@/lib/identity/auth";
import type { TenantContext } from "@/lib/tenancy/context";
import { toolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/builtin";
import { jobQueue } from "@/lib/jobs/queue";
import { PgBossJobQueue } from "@/lib/jobs/pgboss-job-queue";
import { handleSendFollowup } from "@/lib/jobs/handlers/send-followup";
import { handleRetryDelivery } from "@/lib/jobs/handlers/retry-delivery";
import {
  SEND_FOLLOWUP_JOB,
  RETRY_DELIVERY_JOB,
  type SendFollowupPayload,
} from "@/lib/jobs/job-types";
import { registerChannelAdapter } from "@/lib/channels/registry";
import { dispatchDelivery, ensureDelivery } from "@/lib/conversations/delivery";

let a: SeededBusiness, ctx: TenantContext, token: string, membershipId: string;
let sent: ReturnType<typeof vi.fn>, schedule: ReturnType<typeof vi.spyOn>;
let queued: SendFollowupPayload[];
const CHANNEL = "test-deferred-followup";
beforeEach(async () => {
  a = await seedBusiness("followup-authority");
  const member = await prisma.membership.findFirstOrThrow({
    where: { businessId: a.businessId, userId: a.ownerUserId },
  });
  membershipId = member.id;
  token = generateToken(a.ownerUserId);
  const session = verifyToken(token)!;
  ctx = {
    ...a.ctx,
    authorization: {
      kind: "membership",
      userId: a.ownerUserId,
      membershipId,
      sessionJti: session.jti,
      sessionExpiresAt: session.exp,
    },
  };
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
  schedule = vi.spyOn(jobQueue, "schedule").mockImplementation(async (_type, payload) => {
    queued.push(payload as SendFollowupPayload);
    return "paused-authority-fixture";
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupBusiness(a.businessId);
  await prisma.revokedToken.deleteMany({ where: { userId: a.ownerUserId } });
  await prisma.user.deleteMany({ where: { id: a.ownerUserId } });
});
async function conversation() {
  const connection = await prisma.channelConnection.create({
    data: {
      businessId: a.businessId,
      type: CHANNEL,
      name: "Synthetic follow-up destination",
      isActive: true,
    },
  });
  const row = await prisma.conversation.create({
    data: {
      businessId: a.businessId,
      channel: CHANNEL,
      customerContact: "synthetic-recipient",
      metadata: { channelConnectionId: connection.id },
    },
  });
  return { row, connection };
}
const worker = (type = SEND_FOLLOWUP_JOB): TenantContext => ({
  businessId: a.businessId,
  role: null,
  actor: { kind: "system_job", jobId: randomUUID(), jobType: type },
  dataConnection: "shared-default",
});
async function submit(c: Awaited<ReturnType<typeof conversation>>, actor = ctx) {
  const idempotencyKey = "authority:" + randomUUID();
  const result = await toolRegistry.execute(
    actor,
    "schedule_followup",
    { conversationId: c.row.id, message: "Synthetic saved follow-up", delayHours: 1 },
    { idempotencyKey }
  );
  const action = await prisma.actionExecution.findFirst({
    where: { businessId: a.businessId, idempotencyKey },
  });
  return { result, action };
}
async function boundLegacy(c: Awaited<ReturnType<typeof conversation>>) {
  const action = await prisma.actionExecution.create({
    data: {
      businessId: a.businessId,
      conversationId: c.row.id,
      tool: "schedule_followup",
      status: "scheduled",
      requestedBy: "ai",
      idempotencyKey: "legacy:" + randomUUID(),
      input: { message: "Legacy bound message" },
    },
  });
  return {
    action,
    payload: {
      businessId: a.businessId,
      conversationId: c.row.id,
      connectionId: c.connection.id,
      channel: CHANNEL,
      to: c.row.customerContact,
      message: "Legacy bound message",
      idempotencyKey: action.idempotencyKey,
    },
  };
}
describe("P1 scheduled follow-up origin and submission boundary, isolated Postgres", () => {
  it("persists exact immutable authority before enqueue and ignores caller runtime admission fields", async () => {
    const c = await conversation();
    schedule.mockImplementationOnce(async (_type, payload) => {
      const p = payload as SendFollowupPayload;
      const action = await prisma.actionExecution.findUniqueOrThrow({
        where: {
          businessId_idempotencyKey: { businessId: a.businessId, idempotencyKey: p.idempotencyKey },
        },
      });
      expect(action.authorizationSnapshot).toMatchObject({
        version: 1,
        operation: "schedule_followup",
        jobType: SEND_FOLLOWUP_JOB,
        businessId: a.businessId,
        actionId: action.id,
        conversationId: c.row.id,
        connectionId: c.connection.id,
        mode: "direct_tool",
      });
      queued.push(p);
      return "persisted-before-enqueue";
    });
    const result = await toolRegistry.execute(
      ctx,
      "schedule_followup",
      { conversationId: c.row.id, message: "Explicit caller intent", delayHours: 1 },
      { idempotencyKey: "runtime-forgery", admission: "human_approval" } as never
    );
    expect(result.status).toBe("scheduled");
    expect(queued).toHaveLength(1);
  });
  it("denies bare AI origin before any queue submission", async () => {
    const c = await conversation(),
      result = await submit(c, {
        ...ctx,
        role: null,
        actor: { kind: "ai_agent", conversationId: c.row.id, model: "stand-in" },
        authorization: undefined,
      });
    expect(result.result.success).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });
  it("fails a bound legacy action with missing provenance without an adapter call", async () => {
    const c = await conversation(),
      old = await boundLegacy(c);
    await handleSendFollowup(worker(), old.payload);
    expect(sent).not.toHaveBeenCalled();
    expect(
      (await prisma.actionExecution.findUniqueOrThrow({ where: { id: old.action.id } })).status
    ).toBe("failed");
  });
  it("blocks demoted current membership and observes the fresh human origin after AI retag", async () => {
    const c = await conversation(),
      ai = {
        ...ctx,
        role: null,
        actor: { kind: "ai_agent" as const, conversationId: c.row.id, model: "stand-in" },
      };
    const { result, action } = await submit(c, ai);
    expect(result.status).toBe("scheduled");
    expect(action?.authorizationSnapshot).toMatchObject({
      mode: "internal_chat_ai",
      identity: { origin: { kind: "membership", membershipId } },
    });
    await prisma.membership.update({ where: { id: membershipId }, data: { role: "viewer" } });
    await handleSendFollowup(worker(), queued[0]);
    expect(sent).not.toHaveBeenCalled();
  });
  it("preserves recorded human intent after logout and never restores a human actor at the adapter", async () => {
    const c = await conversation(),
      { result } = await submit(c);
    expect(result.status).toBe("scheduled");
    await revokeToken(token);
    await handleSendFollowup(worker(), queued[0]);
    expect(sent).toHaveBeenCalledTimes(1);
    const actual = sent.mock.calls[0][0] as TenantContext;
    expect(actual.role).toBeNull();
    expect(actual.actor.kind).toBe("system_job");
    expect(actual.authorization).toMatchObject({
      kind: "delegated_job",
      allowedOperations: ["messages:create"],
    });
  });
  it("default-denies direct follow-up dispatch with no authorizer and keeps the unsent outcome known", async () => {
    const c = await conversation(),
      old = await boundLegacy(c),
      job = worker();
    const op = await ensureDelivery(job, {
      operationKey: "followup:" + old.action.id,
      kind: "followup",
      actionId: old.action.id,
      conversationId: c.row.id,
      connectionId: c.connection.id,
      channel: CHANNEL,
      recipient: c.row.customerContact,
      response: old.payload.message,
    });
    const result = await dispatchDelivery(job, op.id);
    expect(sent).not.toHaveBeenCalled();
    expect(result.status).toBe("rejected");
    expect(result.retryable).toBe(false);
  });
  it("rechecks origin on actual retry handler rather than trusting an already created delivery", async () => {
    const c = await conversation(),
      { result, action } = await submit(c);
    expect(result.status).toBe("scheduled");
    const op = await ensureDelivery(worker(), {
      operationKey: "followup:" + action!.id,
      kind: "followup",
      actionId: action!.id,
      conversationId: c.row.id,
      connectionId: c.connection.id,
      channel: CHANNEL,
      recipient: c.row.customerContact,
      response: queued[0].message,
    });
    await prisma.membership.delete({ where: { id: membershipId } });
    await handleRetryDelivery(worker(RETRY_DELIVERY_JOB), {
      businessId: a.businessId,
      deliveryId: op.id,
    });
    expect(sent).not.toHaveBeenCalled();
    expect(
      (await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: op.id } })).status
    ).toBe("rejected");
  });
});

describe("P1 dispatch seam and accepted checkpoint regressions", () => {
  it("rejects malformed callback origins and missing operation arrays as permanent unsent refusals", async () => {
    const c = await conversation();
    for (const authorization of [
      {
        kind: "delegated_job",
        allowedOperations: ["messages:create"],
        origin: { kind: "membership" },
      },
      {
        kind: "delegated_job",
        allowedOperations: ["messages:create"],
        origin: { kind: "membership", userId: a.ownerUserId, membershipId, token: "not-permitted" },
      },
      {
        kind: "delegated_job",
        allowedOperations: ["messages:create"],
        origin: {
          kind: "provider_inbound",
          receiptId: randomUUID(),
          deliveryOperationId: randomUUID(),
          conversationId: randomUUID(),
          connectionId: c.connection.id,
        },
      },
      {
        kind: "delegated_job",
        origin: { kind: "membership", userId: a.ownerUserId, membershipId },
      },
    ]) {
      const old = await boundLegacy(c),
        job = worker();
      const op = await ensureDelivery(job, {
        operationKey: "followup:" + old.action.id,
        kind: "followup",
        actionId: old.action.id,
        conversationId: c.row.id,
        connectionId: c.connection.id,
        channel: CHANNEL,
        recipient: c.row.customerContact,
        response: old.payload.message,
      });
      const outcome = await dispatchDelivery(
        job,
        op.id,
        async (_worker, binding) =>
          ({
            ...job,
            resourceScope: { kind: "workspace", customerProfileAccess: "write" },
            authorization,
            workBinding: {
              conversationId: binding.conversationId,
              actionExecutionId: binding.actionId,
              deliveryOperationId: binding.deliveryId,
            },
          }) as never
      );
      expect(sent).not.toHaveBeenCalled();
      expect(outcome.status).toBe("rejected");
      expect(outcome.retryable).toBe(false);
    }
  });
  it("projects already accepted legacy delivery after authority loss without reauthorizing or submitting again", async () => {
    const c = await conversation(),
      old = await boundLegacy(c),
      job = worker();
    const op = await ensureDelivery(job, {
      operationKey: "followup:" + old.action.id,
      kind: "followup",
      actionId: old.action.id,
      conversationId: c.row.id,
      connectionId: c.connection.id,
      channel: CHANNEL,
      recipient: c.row.customerContact,
      response: old.payload.message,
    });
    await prisma.deliveryOperation.update({
      where: { id: op.id },
      data: { status: "accepted", providerMessageId: "synthetic-prior-acceptance" },
    });
    await prisma.membership.delete({ where: { id: membershipId } });
    await handleSendFollowup(job, old.payload);
    expect(sent).not.toHaveBeenCalled();
    expect(
      (await prisma.actionExecution.findUniqueOrThrow({ where: { id: old.action.id } })).status
    ).toBe("succeeded");
  });
});

describe("P1 revocation during final destination lookup", () => {
  it("a membership change issued during admission waits behind the fence; a change committed before it blocks sending", async () => {
    const c = await conversation(),
      scheduled = await submit(c);
    expect(scheduled.result.status).toBe("scheduled");
    const barrier = await pauseFinalIdentity(),
      pending = handleSendFollowup(worker(), queued[0]);
    try {
      await barrierReady(barrier.ready);
      const { getScopedPrisma } = await import("@/lib/tenancy/scoped-prisma");
      const write = getScopedPrisma(ctx).membership.update({
        where: { id: membershipId },
        data: { role: "viewer" },
      });
      await expectWriterBlocked(write);
      barrier.release();
      await pending;
      await write;
      expect(sent).toHaveBeenCalledTimes(1);
      const operation = await prisma.deliveryOperation.findFirstOrThrow({
        where: { actionId: scheduled.action!.id },
      });
      expect(operation.status).toBe("accepted");
    } finally {
      barrier.release();
      await pending.catch(() => {});
      barrier.spy.mockRestore();
    }
  });
  it("a membership demotion committed before admission blocks sending as a known unsent refusal", async () => {
    const c = await conversation(),
      scheduled = await submit(c);
    expect(scheduled.result.status).toBe("scheduled");
    const { getScopedPrisma } = await import("@/lib/tenancy/scoped-prisma");
    await getScopedPrisma(ctx).membership.update({
      where: { id: membershipId },
      data: { role: "viewer" },
    });
    await handleSendFollowup(worker(), queued[0]);
    expect(sent).not.toHaveBeenCalled();
    const action = await prisma.actionExecution.findUniqueOrThrow({
      where: { id: scheduled.action!.id },
    });
    expect(action.status).toBe("failed");
    expect(await prisma.deliveryOperation.count({ where: { actionId: action.id } })).toBe(0);
  });
});

async function disableFollowupPolicy() {
  const { getScopedPrisma } = await import("@/lib/tenancy/scoped-prisma");
  return getScopedPrisma(ctx).toolPolicy.upsert({
    where: { businessId_tool: { businessId: a.businessId, tool: "schedule_followup" } },
    create: {
      businessId: a.businessId,
      tool: "schedule_followup",
      enabledForTenant: false,
      allowedForAI: true,
      allowedForHumanRoles: ["owner"],
    },
    update: { enabledForTenant: false },
  });
}
/** The admission fence must hold an authority-reducing writer until admission commits. */
async function expectWriterBlocked(write: Promise<unknown>) {
  const settled = write.then(
    () => "done",
    () => "done"
  );
  const state = await Promise.race([
    settled,
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 750)),
  ]);
  expect(state).toBe("blocked");
}
async function pauseFinalIdentity(nth = 2) {
  const identityApi = await import("@/lib/tenancy/deferred-origin"),
    original = identityApi.refreshDeferredIdentity;
  let entered!: () => void,
    release!: () => void,
    count = 0;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const spy = vi
    .spyOn(identityApi, "refreshDeferredIdentity")
    .mockImplementation(async (...args) => {
      const facts = await original(...args);
      if (++count === nth) {
        entered();
        await hold;
      }
      return facts;
    });
  return { ready, release, spy };
}
async function barrierReady(ready: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Final identity barrier not reached")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
describe("P1 final identity wait admission interleavings", () => {
  it("a policy change committed before admission blocks sending", async () => {
    const c = await conversation();
    expect((await submit(c)).result.status).toBe("scheduled");
    await disableFollowupPolicy();
    await handleSendFollowup(worker(), queued[0]);
    expect(sent).not.toHaveBeenCalled();
  });
  it("a policy change issued during admission waits behind the fence; the admitted attempt is sent once", async () => {
    const c = await conversation();
    expect((await submit(c)).result.status).toBe("scheduled");
    const barrier = await pauseFinalIdentity(),
      pending = handleSendFollowup(worker(), queued[0]);
    try {
      await barrierReady(barrier.ready);
      const write = disableFollowupPolicy();
      await expectWriterBlocked(write);
      barrier.release();
      await pending;
      await write;
      expect(sent).toHaveBeenCalledTimes(1);
      const { resolveEffectiveToolPolicy } = await import("@/lib/tools/policy");
      expect((await resolveEffectiveToolPolicy(ctx, "schedule_followup")).enabledForTenant).toBe(
        false
      );
    } finally {
      barrier.release();
      await pending.catch(() => {});
      barrier.spy.mockRestore();
    }
  });
  it("a retirement issued during admission waits behind the fence and never restores content", async () => {
    const c = await conversation();
    expect((await submit(c)).result.status).toBe("scheduled");
    const barrier = await pauseFinalIdentity(),
      pending = handleSendFollowup(worker(), queued[0]);
    try {
      await barrierReady(barrier.ready);
      const { remove } = await import("@/lib/conversations/service");
      const write = remove(ctx, c.row.id);
      await expectWriterBlocked(write);
      barrier.release();
      await pending.catch(() => {});
      await write;
      expect(sent.mock.calls.length).toBeLessThanOrEqual(1);
      const restored = await prisma.message.findMany({
        where: { conversationId: c.row.id, content: { contains: "Synthetic follow-up" } },
      });
      expect(restored).toEqual([]);
    } finally {
      barrier.release();
      await pending.catch(() => {});
      barrier.spy.mockRestore();
    }
  });
  it("does not submit after current API key expiry crosses final identity return", async () => {
    const c = await conversation(),
      expiresAt = new Date(Date.now() + 60_000);
    const key = await prisma.apiKey.create({
      data: {
        businessId: a.businessId,
        name: "Synthetic expiring deferred key",
        keyPrefix: "fixture:" + randomUUID(),
        keyHash: randomUUID(),
        role: "agent",
        scopeMode: "workspace",
        customerProfileAccess: "read",
        scopeOrigin: "issuer",
        issuedByUserId: a.ownerUserId,
        expiresAt,
      },
    });
    const keyCtx: TenantContext = {
      ...ctx,
      role: "agent",
      actor: { kind: "api_key", apiKeyId: key.id },
      resourceScope: { kind: "workspace", customerProfileAccess: "read" },
      authorization: { kind: "api_key", apiKeyId: key.id },
    };
    expect((await submit(c, keyCtx)).result.status).toBe("scheduled");
    const barrier = await pauseFinalIdentity(),
      pending = handleSendFollowup(worker(), queued[0]);
    try {
      await barrierReady(barrier.ready);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(expiresAt.getTime() + 1));
      barrier.release();
      await pending;
      expect(sent).not.toHaveBeenCalled();
    } finally {
      barrier.release();
      await pending.catch(() => {});
      vi.useRealTimers();
      barrier.spy.mockRestore();
    }
  });
});

// Supplemental integration coverage. Durable inbound rows are a controlled
// synthetic prerequisite, not evidence of provider signature/inbound acceptance.
async function providerActor(c: Awaited<ReturnType<typeof conversation>>) {
  const { buildMessageReceivedEvent } = await import("@/lib/events/types");
  const { registerInboundEvent } = await import("@/lib/events/inbound-receipt");
  const event = buildMessageReceivedEvent({
    businessId: a.businessId,
    channel: CHANNEL,
    connectionId: c.connection.id,
    externalId: randomUUID(),
    conversationId: c.row.id,
    payload: { text: "Synthetic follow-up request", customerContact: c.row.customerContact },
  });
  const { receiptId } = await registerInboundEvent(worker(), {
    source: CHANNEL,
    externalEventId: event.source.externalId!,
    eventType: event.type,
    correlationId: event.correlationId,
    event,
  });
  const inbound = await ensureDelivery(worker(), {
    operationKey: "receipt:" + receiptId,
    kind: "inbound",
    receiptId,
    conversationId: c.row.id,
    channel: CHANNEL,
    connectionId: c.connection.id,
    recipient: c.row.customerContact,
  });
  await prisma.deliveryOperation.update({
    where: { id: inbound.id },
    data: { status: "preparing" },
  });
  const actor: TenantContext = {
    ...worker(),
    actor: { kind: "ai_agent", conversationId: c.row.id, model: "stand-in" },
    authorization: undefined,
    workBinding: { conversationId: c.row.id, receiptId, deliveryOperationId: inbound.id },
  };
  return { actor, inbound, receiptId };
}
describe("P1 actual producer mode and current policy integration", () => {
  it("sends a provider-origin schedule after unrelated human removal with a fixed connection-only job", async () => {
    const c = await conversation(),
      p = await providerActor(c),
      { result, action } = await submit(c, p.actor);
    expect(result.status).toBe("scheduled");
    expect(action?.authorizationSnapshot).toMatchObject({
      mode: "provider_ai",
      provider: {
        origin: {
          kind: "provider_inbound",
          receiptId: p.receiptId,
          deliveryOperationId: p.inbound.id,
          conversationId: c.row.id,
          connectionId: c.connection.id,
        },
      },
    });
    await prisma.membership.delete({ where: { id: membershipId } });
    await handleSendFollowup(worker(), queued[0]);
    expect(sent).toHaveBeenCalledTimes(1);
    const actual = sent.mock.calls[0][0] as TenantContext;
    expect(actual.role).toBeNull();
    expect(actual.actor.kind).toBe("system_job");
    expect(actual.resourceScope).toEqual({
      kind: "connections",
      connectionIds: [c.connection.id],
      customerProfileAccess: "none",
    });
    expect(actual.authorization).toMatchObject({
      kind: "delegated_job",
      allowedOperations: ["messages:create"],
      origin: { kind: "provider_inbound", receiptId: p.receiptId },
    });
  });
  it("blocks provider-origin work after its actual receipt is cancelled without falling back to an owner", async () => {
    const c = await conversation(),
      p = await providerActor(c);
    expect((await submit(c, p.actor)).result.status).toBe("scheduled");
    await prisma.inboundEventReceipt.update({
      where: { id: p.receiptId },
      data: { processingStatus: "cancelled" },
    });
    await handleSendFollowup(worker(), queued[0]);
    expect(sent).not.toHaveBeenCalled();
  });
  it("rechecks AI policy for a saved provider schedule without substituting human role allowances", async () => {
    const c = await conversation(),
      p = await providerActor(c);
    expect((await submit(c, p.actor)).result.status).toBe("scheduled");
    await prisma.toolPolicy.upsert({
      where: { businessId_tool: { businessId: a.businessId, tool: "schedule_followup" } },
      create: {
        businessId: a.businessId,
        tool: "schedule_followup",
        enabledForTenant: true,
        allowedForAI: false,
        allowedForHumanRoles: ["owner"],
      },
      update: { allowedForAI: false },
    });
    await handleSendFollowup(worker(), queued[0]);
    expect(sent).not.toHaveBeenCalled();
  });
  it("captures the actual approver and preserves approval semantics after requester membership loss", async () => {
    const { addMember } = await import("../helpers/tenant-fixtures");
    const requester = await addMember(a.businessId, "agent", "followup-requester");
    try {
      const c = await conversation();
      await prisma.toolPolicy.upsert({
        where: { businessId_tool: { businessId: a.businessId, tool: "schedule_followup" } },
        create: {
          businessId: a.businessId,
          tool: "schedule_followup",
          enabledForTenant: true,
          allowedForAI: true,
          allowedForHumanRoles: [],
          requiresHumanApproval: true,
        },
        update: { requiresHumanApproval: true, allowedForHumanRoles: [] },
      });
      const { result, action } = await submit(c, {
        ...requester.ctx,
        role: null,
        actor: { kind: "ai_agent", conversationId: c.row.id, model: "stand-in" },
      });
      expect(result.status).toBe("pending_approval");
      expect(schedule).not.toHaveBeenCalled();
      await prisma.membership.deleteMany({
        where: { businessId: a.businessId, userId: requester.userId },
      });
      expect((await toolRegistry.approve(ctx, action!.id)).status).toBe("scheduled");
      expect(
        (await prisma.actionExecution.findUniqueOrThrow({ where: { id: action!.id } }))
          .authorizationSnapshot
      ).toMatchObject({
        mode: "human_approval",
        identity: { origin: { kind: "membership", userId: a.ownerUserId, membershipId } },
      });
      await handleSendFollowup(worker(), queued[0]);
      expect(sent).toHaveBeenCalledTimes(1);
      expect((sent.mock.calls[0][0] as TenantContext).authorization).toMatchObject({
        actorUserId: a.ownerUserId,
      });
    } finally {
      await prisma.user.deleteMany({ where: { id: requester.userId } });
    }
  });
  it("retains the saved connection ceiling even when the current member still has full workspace scope", async () => {
    const c = await conversation();
    const { result } = await submit(c, {
      ...ctx,
      resourceScope: {
        kind: "connections",
        connectionIds: [c.connection.id],
        customerProfileAccess: "none",
      },
    });
    expect(result.status).toBe("scheduled");
    await handleSendFollowup(worker(), queued[0]);
    expect(sent).toHaveBeenCalledTimes(1);
    expect((sent.mock.calls[0][0] as TenantContext).resourceScope).toEqual({
      kind: "connections",
      connectionIds: [c.connection.id],
      customerProfileAccess: "none",
    });
  });
});

describe("P1 real pg-boss follow-up retry authority", () => {
  it("blocks pg-boss's actual retry after membership loss following a known unsent refusal", async () => {
    const { PgBossJobQueue } = await import("@/lib/jobs/pgboss-job-queue");
    const c = await conversation(),
      { result, action } = await submit(c);
    expect(result.status).toBe("scheduled");
    const schema = "authority_retry_" + randomUUID().replaceAll("-", "");
    const queue = new PgBossJobQueue(process.env.DATABASE_URL!, { schema });
    let pickups = 0;
    sent.mockImplementation(async () => {
      // First attempt is known not accepted. Its later queue retry must resolve
      // exact current authority, not use the original job or delivery snapshot.
      await prisma.membership.delete({ where: { id: membershipId } });
      return { success: false, outcome: "rejected", retryable: true };
    });
    queue.registerHandler<SendFollowupPayload>(SEND_FOLLOWUP_JOB, async (actual, payload) => {
      pickups++;
      expect(actual.actor).toMatchObject({ kind: "system_job", jobType: SEND_FOLLOWUP_JOB });
      await handleSendFollowup(actual, payload);
    });
    try {
      await queue.start();
      await queue.enqueue(SEND_FOLLOWUP_JOB, queued[0]);
      const deadline = Date.now() + 25_000;
      for (;;) {
        const saved = await prisma.actionExecution.findUniqueOrThrow({ where: { id: action!.id } });
        if (pickups >= 2 && saved.status === "failed") break;
        if (Date.now() >= deadline)
          throw new Error("Real pg-boss revocation retry did not complete");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(pickups).toBe(2);
      expect(sent).toHaveBeenCalledTimes(1);
      const operation = await prisma.deliveryOperation.findFirstOrThrow({
        where: { actionId: action!.id },
      });
      expect(operation.status).toBe("rejected");
      expect(operation.attempts).toBe(1);
      expect(await prisma.message.count({ where: { conversationId: c.row.id } })).toBe(0);
    } finally {
      await queue.stop();
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }, 35_000);
});

describe("P1 erasure racing an admitted follow-up attempt (transport held)", () => {
  async function heldTransport(result: unknown) {
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>((resolve) => {
        release = resolve;
      }),
      reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
    sent.mockImplementation(async () => {
      entered();
      await hold;
      return result;
    });
    return { release, reached };
  }
  async function eraseWhileHeld(result: unknown) {
    const c = await conversation(),
      scheduled = await submit(c);
    expect(scheduled.result.status).toBe("scheduled");
    const transport = await heldTransport(result),
      pending = handleSendFollowup(worker(), queued[0]);
    await Promise.race([
      transport.reached,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Transport not reached")), 8000)
      ),
    ]);
    const { remove } = await import("@/lib/conversations/service");
    await remove(ctx, c.row.id);
    const marker = await prisma.deliveryOperation.findFirstOrThrow({
      where: { businessId: a.businessId, operationKey: "followup:" + scheduled.action!.id },
    });
    transport.release();
    await pending.catch(() => {});
    const settled = await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: marker.id } });
    return { c, marker, settled };
  }
  it("keeps a sanitized unresolved marker while transport is held, then records an accepted outcome without restoring content", async () => {
    const { c, marker, settled } = await eraseWhileHeld({
      success: true,
      providerMessageId: "synthetic-late-accept",
    });
    expect(marker).toMatchObject({
      status: "unknown",
      conversationId: null,
      actionId: null,
      receiptId: null,
      recipient: "",
    });
    expect(marker.retiredAt).not.toBeNull();
    expect(marker.response).toBe("[REDACTED - GDPR]");
    expect(settled.status).toBe("accepted");
    expect(settled.providerMessageId).toBe("synthetic-late-accept");
    expect(settled.recipient).toBe("");
    expect(settled.claimToken).toBeNull();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(
      await prisma.message.count({
        where: { businessId: a.businessId, content: { contains: "Synthetic follow-up" } },
      })
    ).toBe(0);
    expect(await prisma.conversation.count({ where: { id: c.row.id } })).toBe(0);
  });
  it("keeps the marker unresolved when the held transport result is uncertain", async () => {
    const { settled } = await eraseWhileHeld({ success: false, outcome: "unknown" });
    expect(settled.status).toBe("unknown");
    expect(settled.retiredAt).not.toBeNull();
    expect(settled.conversationId).toBeNull();
    expect(settled.recipient).toBe("");
    expect(sent).toHaveBeenCalledTimes(1);
  });
  it("records a known refusal without retry or content after erasure", async () => {
    const { settled } = await eraseWhileHeld({
      success: false,
      outcome: "rejected",
      retryable: true,
    });
    expect(settled.status).toBe("rejected");
    expect(settled.retryable).toBe(false);
    expect(settled.recipient).toBe("");
    expect(settled.response).toBe("[REDACTED - GDPR]");
  });
  it("never offers a retired marker for recovery or resend", async () => {
    const { settled } = await eraseWhileHeld({ success: false, outcome: "unknown" });
    const { listDeliveryRecovery, recoverDelivery } = await import("@/lib/conversations/delivery");
    const listed = await listDeliveryRecovery(ctx);
    expect(listed.map((row) => row.id)).not.toContain(settled.id);
    await expect(
      recoverDelivery(ctx, settled.id, {
        decision: "resend",
        reason: "synthetic recovery attempt",
        acknowledgeDuplicateRisk: true,
        requestId: randomUUID(),
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe("P1 admission concurrency and fence release", () => {
  it("two workers racing one follow-up produce exactly one claim and one submission", async () => {
    const c = await conversation(),
      scheduled = await submit(c);
    expect(scheduled.result.status).toBe("scheduled");
    const results = await Promise.allSettled([
      handleSendFollowup(worker(), queued[0]),
      handleSendFollowup(worker(), queued[0]),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
    const rows = await prisma.deliveryOperation.findMany({
      where: { operationKey: "followup:" + scheduled.action!.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("accepted");
    expect(rows[0].attempts).toBe(1);
  });
  it("releases both fences before transport: an adapter scoped write cannot deadlock", async () => {
    const c = await conversation(),
      scheduled = await submit(c);
    expect(scheduled.result.status).toBe("scheduled");
    const { getScopedPrisma } = await import("@/lib/tenancy/scoped-prisma");
    let wrote = false;
    sent.mockImplementation(async () => {
      await Promise.race([
        getScopedPrisma(ctx).toolPolicy.upsert({
          where: { businessId_tool: { businessId: a.businessId, tool: "schedule_followup" } },
          create: {
            businessId: a.businessId,
            tool: "schedule_followup",
            enabledForTenant: true,
            allowedForAI: true,
            allowedForHumanRoles: ["owner"],
          },
          update: { enabledForTenant: true },
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Fence still held during transport")), 5000)
        ),
      ]);
      wrote = true;
      return { success: true, providerMessageId: "synthetic-fence-released" };
    });
    await handleSendFollowup(worker(), queued[0]);
    expect(wrote).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe("P1 real pg-boss retry revocation (isolated queue schema)", () => {
  it("does not resubmit a refused follow-up after authority is revoked between attempts", async () => {
    const c = await conversation(),
      scheduled = await submit(c);
    expect(scheduled.result.status).toBe("scheduled");
    sent.mockReset();
    sent
      .mockResolvedValueOnce({ success: false, outcome: "rejected", retryable: true })
      .mockResolvedValue({ success: true, providerMessageId: "synthetic-must-not-send" });
    const schema = "followup_retry_" + randomUUID().replaceAll("-", "");
    const queue = new PgBossJobQueue(process.env.DATABASE_URL!, { schema });
    queue.registerHandler(SEND_FOLLOWUP_JOB, handleSendFollowup);
    const until = async (check: () => Promise<boolean> | boolean, ms: number, what: string) => {
      const deadline = Date.now() + ms;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };
    try {
      await queue.start();
      await queue.enqueue(SEND_FOLLOWUP_JOB, queued[0]);
      await until(() => sent.mock.calls.length === 1, 30_000, "first submission");
      await disableFollowupPolicy();
      await until(
        async () =>
          (
            await prisma.actionExecution.findUniqueOrThrow({ where: { id: scheduled.action!.id } })
          ).errorMessage?.includes("Saved follow-up authority is unavailable") === true,
        90_000,
        "revoked retry refusal"
      );
      expect(sent).toHaveBeenCalledTimes(1);
    } finally {
      await queue.stop();
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }, 150_000);
});

describe("P1 admission failure directions and retired markers (dispatch level)", () => {
  it("a claim that committed before an admission completion failure never reaches the adapter and stays sending", async () => {
    const c = await conversation(),
      scheduled = await submit(c);
    expect(scheduled.result.status).toBe("scheduled");
    const tenancy = await import("@/lib/tenancy/scoped-prisma"),
      original = tenancy.withAdmissionSession;
    const spy = vi.spyOn(tenancy, "withAdmissionSession").mockImplementationOnce((async (
      ...args: Parameters<typeof original>
    ) => {
      await original(...args);
      throw new Error("admission completion failed after the claim committed");
    }) as typeof original);
    try {
      await handleSendFollowup(worker(), queued[0]).catch(() => {});
    } finally {
      spy.mockRestore();
    }
    expect(sent).not.toHaveBeenCalled();
    const op = await prisma.deliveryOperation.findFirstOrThrow({
      where: { operationKey: "followup:" + scheduled.action!.id },
    });
    expect(op.status).toBe("sending");
    expect(op.attempts).toBe(1);
    expect(op.claimToken).not.toBeNull();
  });
  it("redacts every private column of a retired marker and refuses a queued retry of it", async () => {
    const c = await conversation(),
      scheduled = await submit(c);
    expect(scheduled.result.status).toBe("scheduled");
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve)),
      reached = new Promise<void>((resolve) => (entered = resolve));
    sent.mockImplementation(async () => {
      entered();
      await hold;
      return { success: false, outcome: "unknown" };
    });
    const pending = handleSendFollowup(worker(), queued[0]);
    await reached;
    const { remove } = await import("@/lib/conversations/service");
    await remove(ctx, c.row.id);
    const marker = await prisma.deliveryOperation.findFirstOrThrow({
      where: { operationKey: "followup:" + scheduled.action!.id },
    });
    expect(marker.metadata).toEqual({});
    expect(marker.recoveryLog).toEqual([]);
    expect(marker.response).toBe("[REDACTED - GDPR]");
    release();
    await pending.catch(() => {});
    await handleRetryDelivery(worker(), { businessId: a.businessId, deliveryId: marker.id });
    expect(sent).toHaveBeenCalledTimes(1);
  });
  it("keeps a marker for an already-uncertain attempted operation instead of cancelling or deleting it", async () => {
    const c = await conversation(),
      scheduled = await submit(c);
    expect(scheduled.result.status).toBe("scheduled");
    sent.mockResolvedValue({ success: false, outcome: "unknown" });
    await handleSendFollowup(worker(), queued[0]);
    const before = await prisma.deliveryOperation.findFirstOrThrow({
      where: { operationKey: "followup:" + scheduled.action!.id },
    });
    expect(before).toMatchObject({ status: "unknown", attempts: 1 });
    const { remove } = await import("@/lib/conversations/service");
    await remove(ctx, c.row.id);
    const after = await prisma.deliveryOperation.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toMatchObject({
      status: "unknown",
      conversationId: null,
      actionId: null,
      recipient: "",
    });
    expect(after.retiredAt).not.toBeNull();
    expect(after.response).toBe("[REDACTED - GDPR]");
  });
});
