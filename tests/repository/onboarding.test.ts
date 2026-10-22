import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

/** PLAN.md P3 — resumable onboarding: live readiness, a recorded test reply, explicit activation, inactive workspace gate. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { provisionBusiness } from "@/lib/platform/provisioning";
import { aiProviderRegistry } from "@/lib/ai/providers/registry";
import { OpenAIProvider } from "@/lib/ai/providers/openai";
import { AIProviderError, type AIProvider, type CompletionResult } from "@/lib/ai/providers/types";
import { encryptAIProviderCredential } from "@/lib/ai/config";
import { getOnboardingState, runOnboardingTestReply, activateWorkspace } from "@/lib/onboarding/service";
import { processInboundMessage } from "@/lib/conversations/inbound";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { acquirePolicyLock, releasePolicyLock } from "../helpers/policy-lock";

let provider: AIProvider;
let calls = 0;
const ok = (text: string): CompletionResult => ({ type: "text", text, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } });
const businessIds: string[] = [];
const userIds: string[] = [];

async function workspace(opts: { verified?: boolean } = {}) {
  const r = await provisionBusiness({
    businessName: "Onboarding Co",
    ownerUsername: `ob_${randomUUID().slice(0, 12)}`,
    ownerPassword: "Correct-horse-9",
    ownerEmail: `ob-${randomUUID()}@example.test`,
  });
  businessIds.push(r.businessId);
  userIds.push(r.userId);
  if (opts.verified) {
    await prisma.user.update({ where: { id: r.userId }, data: { emailVerifiedAt: new Date() } });
    await prisma.workspaceAiAllowance.update({ where: { businessId: r.businessId }, data: { status: "active" } });
  }
  const ctx: TenantContext = {
    businessId: r.businessId,
    role: "owner",
    actor: { kind: "user", userId: r.userId },
    dataConnection: "shared-default",
    resourceScope: { kind: "workspace", customerProfileAccess: "write" },
  };
  return { ...r, ctx };
}
async function withKnowledge(ctx: TenantContext) {
  const db = getScopedPrisma(ctx);
  const category = await db.category.create({ data: { name: "General" } });
  await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Opening hours", content: "We open 9 to 5." } });
}
async function withChannel(businessId: string) {
  await prisma.channelConnection.create({ data: { businessId, type: "webchat", name: "Web", isActive: true } });
}

beforeAll(async () => {
  await acquirePolicyLock();
  aiProviderRegistry.register("openai", () => provider);
  await prisma.aiServicePolicy.deleteMany({});
  await prisma.aiServicePolicy.create({
    data: {
      kind: "generation", version: 1, active: true, displayName: "Standard", provider: "openai", model: "m",
      credentialRef: await encryptAIProviderCredential("openai", "platform-key"),
    },
  });
});
afterAll(async () => {
  aiProviderRegistry.register("openai", ({ apiKey }) => new OpenAIProvider(apiKey));
  await prisma.aiServicePolicy.deleteMany({});
  await prisma.business.deleteMany({ where: { id: { in: businessIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await releasePolicyLock();
});
beforeEach(() => {
  calls = 0;
  provider = {
    name: "fake",
    capabilities: { toolCalling: true, streaming: false, multimodal: false },
    complete: async () => {
      calls++;
      return ok("We open from 9 to 5.");
    },
  };
});

describe("state", () => {
  it("is not applicable to a workspace that never had onboarding", async () => {
    const r = await provisionBusiness({ businessName: "Legacy Co", ownerUsername: `lg_${randomUUID().slice(0, 12)}`, ownerPassword: "Correct-horse-9" });
    businessIds.push(r.businessId);
    userIds.push(r.userId);
    const state = await getOnboardingState({ businessId: r.businessId, userId: r.userId });
    expect(state.applicable).toBe(false);
  });

  it("reports each step from live data and survives a reload", async () => {
    const w = await workspace();
    let state = await getOnboardingState({ businessId: w.businessId, userId: w.userId });
    expect(state).toMatchObject({ applicable: true, activated: false, emailVerified: false });
    expect(state.steps.map((s) => [s.id, s.status])).toEqual([
      ["knowledge", "pending"], ["channel", "pending"], ["test_reply", "pending"], ["activation", "pending"],
    ]);
    await withKnowledge(w.ctx);
    await withChannel(w.businessId);
    state = await getOnboardingState({ businessId: w.businessId, userId: w.userId });
    expect(state.steps.slice(0, 2).map((s) => s.status)).toEqual(["done", "done"]);
  });
});

describe("test reply", () => {
  it("is refused until the owner's email is verified, and makes no provider call", async () => {
    const w = await workspace();
    await withKnowledge(w.ctx);
    const res = await runOnboardingTestReply(w.ctx, w.userId);
    expect(res).toMatchObject({ ok: false, code: "EMAIL_NOT_VERIFIED" });
    expect(calls).toBe(0);
  });

  it("passes with a real answer, persists, and is visible after reload", async () => {
    const w = await workspace({ verified: true });
    await withKnowledge(w.ctx);
    expect(await runOnboardingTestReply(w.ctx, w.userId)).toMatchObject({ ok: true });
    const state = await getOnboardingState({ businessId: w.businessId, userId: w.userId });
    expect(state.steps.find((s) => s.id === "test_reply")?.status).toBe("done");
  });

  it("records a failure with a customer-readable reason and never provider text", async () => {
    const w = await workspace({ verified: true });
    await withKnowledge(w.ctx);
    provider = {
      name: "broken", capabilities: { toolCalling: false, streaming: false, multimodal: false },
      complete: async () => {
        throw new AIProviderError("provider_unavailable", "upstream 503 sk-secret-fragment", false);
      },
    };
    const res = await runOnboardingTestReply(w.ctx, w.userId);
    expect(res.ok).toBe(false);
    const state = await getOnboardingState({ businessId: w.businessId, userId: w.userId });
    const step = state.steps.find((s) => s.id === "test_reply")!;
    expect(step.status).toBe("failed");
    expect(JSON.stringify(step) + JSON.stringify(res)).not.toMatch(/sk-|503|upstream/);
    expect(step.detail).toBeTruthy();
    // A later success replaces the failure.
    provider = { ...provider, complete: async () => ok("Fine now.") };
    expect(await runOnboardingTestReply(w.ctx, w.userId)).toMatchObject({ ok: true });
  });

  it("refuses a non-owner", async () => {
    const w = await workspace({ verified: true });
    await withKnowledge(w.ctx);
    expect(await runOnboardingTestReply({ ...w.ctx, role: "admin" }, w.userId)).toMatchObject({ ok: false, code: "OWNER_REQUIRED" });
  });
});

describe("activation", () => {
  it("is refused while any required step is unmet, naming what is missing", async () => {
    const w = await workspace({ verified: true });
    const res = await activateWorkspace(w.ctx, w.userId);
    expect(res).toMatchObject({ ok: false, code: "STEPS_INCOMPLETE" });
    expect((res as { missing: string[] }).missing).toEqual(["knowledge", "channel", "test_reply"]);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: w.businessId } })).activatedAt).toBeNull();
  });

  it("is refused for an unverified owner even if everything else is done", async () => {
    const w = await workspace();
    await withKnowledge(w.ctx);
    await withChannel(w.businessId);
    await prisma.onboardingState.update({ where: { businessId: w.businessId }, data: { testReplyStatus: "passed", testReplyAt: new Date() } });
    expect(await activateWorkspace(w.ctx, w.userId)).toMatchObject({ ok: false, code: "EMAIL_NOT_VERIFIED" });
  });

  it("succeeds once, only for the owner, and is idempotent", async () => {
    const w = await workspace({ verified: true });
    await withKnowledge(w.ctx);
    await withChannel(w.businessId);
    await runOnboardingTestReply(w.ctx, w.userId);
    expect(await activateWorkspace({ ...w.ctx, role: "admin" }, w.userId)).toMatchObject({ ok: false, code: "OWNER_REQUIRED" });
    expect(await activateWorkspace(w.ctx, w.userId)).toMatchObject({ ok: true });
    expect(await activateWorkspace(w.ctx, w.userId)).toMatchObject({ ok: true });
    const state = await getOnboardingState({ businessId: w.businessId, userId: w.userId });
    expect(state).toMatchObject({ activated: true });
    expect(state.steps.at(-1)?.status).toBe("done");
  });
});

describe("inactive workspace gate", () => {
  const event = (businessId: string, text: string) =>
    buildMessageReceivedEvent({
      businessId, channel: "api", connectionId: "internal-chat-api",
      payload: { text, customerName: "Visitor", customerContact: "visitor-1" },
    });

  it("keeps the customer message, sends a neutral setup notice and makes no AI call before activation", async () => {
    const w = await workspace({ verified: true });
    const result = await processInboundMessage(w.ctx, event(w.businessId, "Hello?"));
    expect(calls).toBe(0);
    expect(result.response).toMatch(/being set up/i);
    expect(await prisma.message.count({ where: { conversation: { businessId: w.businessId }, role: "customer" } })).toBe(1);
  });

  it("answers normally once activated", async () => {
    const w = await workspace({ verified: true });
    await withKnowledge(w.ctx);
    await withChannel(w.businessId);
    await runOnboardingTestReply(w.ctx, w.userId);
    await activateWorkspace(w.ctx, w.userId);
    calls = 0;
    const result = await processInboundMessage(w.ctx, event(w.businessId, "When do you open?"));
    expect(calls).toBeGreaterThan(0);
    expect(result.response).toBe("We open from 9 to 5.");
  });
});
