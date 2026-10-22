import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Credential-gated LIVE evaluation for PLAN.md R2 (AI decision quality). Runs the retained case set
 * (tests/integration/r2-cases/*.json) through the real managed path: platform policy -> real OpenAI ->
 * chat() -> escalation decision, with real Postgres and real knowledge retrieval. Scoring and thresholds:
 * tests/helpers/r2-scoring.ts (docs/r2-ai-decision-quality-proposal-2026-10-22.md).
 *
 *   OPENAI_API_KEY=sk-... R2_SET=development|evaluation [R2_REPS=3] [R2_MODEL=gpt-4o-mini] [R2_OUT=/path/result.json] \
 *     npx vitest run --config vitest.integration.config.ts tests/integration/ai-decision-quality-live.test.ts
 *
 * Skips without a key (a skip is not a pass). Refuses OPENAI_BASE_URL (a stand-in is not OpenAI). The
 * development set is for tuning; the evaluation set is frozen and only asserts thresholds. Cost: roughly
 * (cases x reps x turns) chat completions plus a few embeddings.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { chat } from "@/lib/ai/engine";
import { encryptAIProviderCredential, encryptEmbeddingProviderCredential } from "@/lib/ai/config";
import * as knowledgeService from "@/lib/knowledge/service";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { jobQueue } from "@/lib/jobs/queue";
import type { FakeJobQueue } from "@/lib/jobs/fake-job-queue";
import { acquirePolicyLock, releasePolicyLock } from "../helpers/policy-lock";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { scoreTurn, summarize, type Turn, type TurnScore } from "../helpers/r2-scoring";

interface Case {
  id: string;
  category: string;
  domain: string;
  business: string;
  knowledge: { title: string; content: string }[];
  tool: string | null;
  secretElsewhere: boolean;
  turns: Turn[];
}
const apiKey = process.env.OPENAI_API_KEY;
const setName = process.env.R2_SET === "evaluation" ? "evaluation" : "development";
const reps = Math.max(1, Number(process.env.R2_REPS ?? 3));
const model = process.env.R2_MODEL ?? "gpt-4o-mini";
const dir = join(__dirname, "r2-cases");
const cases = (JSON.parse(readFileSync(join(dir, `${setName}.json`), "utf8")) as { cases: Case[] }).cases;
const shared = JSON.parse(readFileSync(join(dir, "shared.json"), "utf8")) as { secret: { title: string; content: string } };

describe.skipIf(!apiKey)(`LIVE R2 decision-quality evaluation (${setName}) -> real OpenAI`, () => {
  const businesses = new Map<string, SeededBusiness>();
  let secretOwner: SeededBusiness;
  let policyVersions: unknown[] = [];

  async function addKnowledge(b: SeededBusiness, entries: { title: string; content: string }[]) {
    const category = await getScopedPrisma(b.ctx).category.create({ data: { name: "r2" } });
    for (const e of entries) await knowledgeService.createEntry(b.ctx, { categoryId: category.id, title: e.title, content: e.content });
    await (jobQueue as FakeJobQueue).__drainForTests();
  }

  beforeAll(async () => {
    if (process.env.OPENAI_BASE_URL) throw new Error("Unset OPENAI_BASE_URL — this evaluation must reach the real OpenAI API.");
    await acquirePolicyLock();
    await prisma.aiServicePolicy.deleteMany({});
    await prisma.aiServicePolicy.create({
      data: {
        kind: "generation", version: 1, active: true, displayName: "R2 evaluation", provider: "openai", model,
        credentialRef: await encryptAIProviderCredential("openai", apiKey!), maxTokens: 400, temperature: 0.2,
      },
    });
    await prisma.aiServicePolicy.create({
      data: {
        kind: "embedding", version: 1, active: true, displayName: "R2 evaluation", provider: "openai", model: "text-embedding-3-small",
        credentialRef: await encryptEmbeddingProviderCredential("openai", apiKey!),
      },
    });
    policyVersions = (await prisma.aiServicePolicy.findMany({ where: { active: true }, select: { kind: true, version: true, provider: true, model: true } }));
    const seed = async (label: string) => {
      const b = await seedBusiness(label);
      await prisma.workspaceAiAllowance.create({ data: { businessId: b.businessId, mode: "managed", generationLimitTokens: 5_000_000, embeddingLimitTokens: 5_000_000 } });
      return b;
    };
    secretOwner = await seed("r2-secret");
    await addKnowledge(secretOwner, [shared.secret]);
    for (const c of cases) {
      if (businesses.has(c.domain)) continue;
      const b = await seed(`r2-${c.domain}`);
      await addKnowledge(b, c.knowledge);
      await prisma.toolPolicy.create({ data: { businessId: b.businessId, tool: "send_internal_email", enabledForTenant: true, allowedForAI: true } });
      businesses.set(c.domain, b);
    }
  }, 600_000);
  afterAll(async () => {
    await prisma.aiServicePolicy.deleteMany({});
    for (const b of [...businesses.values(), secretOwner]) if (b) await cleanupBusiness(b.businessId);
    await releasePolicyLock();
  }, 120_000);

  it(`scores the ${setName} set against the proposal thresholds`, async () => {
    const results: { category: string; id: string; rep: number; turn: number; score: TurnScore; reply: string }[] = [];
    for (let rep = 1; rep <= reps; rep++) {
      for (const c of cases) {
        const b = businesses.get(c.domain)!;
        const convo = await prisma.conversation.create({ data: { businessId: b.businessId, channel: "webchat", customerName: "Eval", customerContact: `${c.id}-${rep}` } });
        for (const [i, turn] of c.turns.entries()) {
          await prisma.conversation.update({ where: { id: convo.id }, data: { status: "active" } });
          const toolsBefore = await prisma.actionExecution.count({ where: { businessId: b.businessId, conversationId: convo.id } });
          const reply = await chat(b.ctx, convo.id, turn.user);
          const escalated = (await prisma.conversation.findUniqueOrThrow({ where: { id: convo.id } })).status === "escalated";
          const toolCalled = c.tool ? (await prisma.actionExecution.count({ where: { businessId: b.businessId, conversationId: convo.id } })) > toolsBefore : undefined;
          results.push({ category: c.category, id: c.id, rep, turn: i, score: scoreTurn(c.category, turn, { reply, escalated, toolCalled }), reply });
        }
      }
    }
    const lines = summarize(results);
    const out = {
      set: setName, reps, provider: "openai", model, policies: policyVersions, at: new Date().toISOString(),
      inconclusive: results.filter((r) => r.score.inconclusive).length, turns: results.length, summary: lines,
      failures: results.filter((r) => !r.score.pass && !r.score.inconclusive).map((r) => ({ id: r.id, rep: r.rep, turn: r.turn, reply: r.reply.slice(0, 300), score: r.score })),
    };
    if (process.env.R2_OUT) writeFileSync(process.env.R2_OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ ...out, failures: out.failures.length }, null, 2));
    // Only the frozen evaluation set gates; the development set is for tuning.
    if (setName === "evaluation") expect(lines.filter((l) => !l.met)).toEqual([]);
  }, 3_600_000);
});
