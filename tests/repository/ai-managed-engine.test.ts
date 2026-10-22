import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * PLAN.md P2 — chat() on a managed workspace meters every provider attempt
 * (including tool-loop iterations and the retry), refuses without calling the
 * provider when the allowance is gone, and hands the conversation to a human.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

const ledger = vi.hoisted(() => ({ down: false }));
vi.mock("@/lib/ai/allowance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/allowance")>();
  return {
    ...actual,
    reserveAllowance: (...args: Parameters<typeof actual.reserveAllowance>) => {
      if (ledger.down) throw new Error("db down");
      return actual.reserveAllowance(...args);
    },
  };
});

import { prisma } from "@/lib/prisma/raw-client";
import { chat } from "@/lib/ai/engine";
import { aiProviderRegistry } from "@/lib/ai/providers/registry";
import { OpenAIProvider } from "@/lib/ai/providers/openai";
import { FakeAIProvider } from "@/lib/ai/providers/fake";
import { AIProviderError, type AIProvider, type CompletionResult } from "@/lib/ai/providers/types";
import { encryptAIProviderCredential } from "@/lib/ai/config";
import { getAllowanceUsage } from "@/lib/ai/allowance";
import { acquirePolicyLock, releasePolicyLock } from "../helpers/policy-lock";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
let conversationId: string;
let provider: AIProvider & { requests?: unknown[] };

const text = (t: string, total = 40): CompletionResult => ({
  type: "text",
  text: t,
  usage: { promptTokens: total - 10, completionTokens: 10, totalTokens: total },
});

beforeAll(async () => {
  await acquirePolicyLock();
  a = await seedBusiness("ai-managed-engine");
  aiProviderRegistry.register("openai", () => provider);
});
afterAll(async () => {
  aiProviderRegistry.register("openai", ({ apiKey }) => new OpenAIProvider(apiKey));
  await prisma.aiServicePolicy.deleteMany({});
  await cleanupBusiness(a.businessId);
  await releasePolicyLock();
});
beforeEach(async () => {
  await prisma.aiServicePolicy.deleteMany({});
  await prisma.aiServicePolicy.create({
    data: {
      kind: "generation",
      version: 1,
      active: true,
      displayName: "Standard",
      provider: "openai",
      model: "gpt-managed",
      credentialRef: await encryptAIProviderCredential("openai", "platform-key"),
      maxTokens: 200,
    },
  });
  await prisma.aiUsageReservation.deleteMany({ where: { businessId: a.businessId } });
  await prisma.workspaceAiAllowance.upsert({
    where: { businessId: a.businessId },
    create: { businessId: a.businessId, mode: "managed", generationLimitTokens: 10_000 },
    update: { mode: "managed", status: "active", generationLimitTokens: 10_000 },
  });
  const convo = await prisma.conversation.create({
    data: { businessId: a.businessId, channel: "webchat", customerName: "C", customerContact: "c" },
  });
  conversationId = convo.id;
  provider = new FakeAIProvider([text("hello from the model", 40)]);
});

describe("chat() on a managed workspace", () => {
  it("settles actual usage and replies normally", async () => {
    const reply = await chat(a.ctx, conversationId, "Hi there");
    expect(reply).toBe("hello from the model");
    expect(await getAllowanceUsage(a.businessId, "generation")).toMatchObject({ used: 40, reserved: 0 });
    expect((provider as FakeAIProvider).requests[0].model).toBe("gpt-managed");
  });

  it("does not call the provider once exhausted; replies with the fallback and escalates", async () => {
    await prisma.workspaceAiAllowance.update({ where: { businessId: a.businessId }, data: { generationLimitTokens: 5 } });
    const reply = await chat(a.ctx, conversationId, "Hi there");
    expect((provider as FakeAIProvider).requests).toHaveLength(0);
    expect(reply).toMatch(/team member/i);
    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(convo.status).toBe("escalated");
    // The customer message and the fallback reply are preserved.
    const messages = await prisma.message.findMany({ where: { conversationId } });
    expect(messages.map((m) => m.role).sort()).toEqual(["assistant", "customer"]);
  });

  it("fails closed with the same handoff when the ledger is down", async () => {
    ledger.down = true;
    let reply: string;
    try {
      reply = await chat(a.ctx, conversationId, "Hi there");
    } finally {
      ledger.down = false;
    }
    expect((provider as FakeAIProvider).requests).toHaveLength(0);
    expect(reply).toMatch(/team member/i);
  });

  it("meters the retry as a second billable attempt", async () => {
    let calls = 0;
    provider = {
      name: "flaky",
      capabilities: { toolCalling: true, streaming: false, multimodal: false },
      async complete() {
        calls += 1;
        if (calls === 1) throw new AIProviderError("timeout", "slow", true);
        return text("second try", 30);
      },
    };
    const reply = await chat(a.ctx, conversationId, "Hi there");
    expect(reply).toBe("second try");
    const usage = await getAllowanceUsage(a.businessId, "generation");
    // First attempt: unknown outcome, reserved bound stays charged; second: settled to 30.
    expect(usage.used).toBeGreaterThan(30);
    expect(usage.reserved).toBe(0);
  });

  it("a missing platform policy gives the existing not-configured notice, with no provider call", async () => {
    await prisma.aiServicePolicy.deleteMany({});
    const reply = await chat(a.ctx, conversationId, "Hi there");
    expect(reply).toMatch(/not configured/i);
    expect((provider as FakeAIProvider).requests).toHaveLength(0);
  });
});
