import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

/**
 * Durable knowledge-entry embedding indexing (PLAN.md §25.2's
 * `index-knowledge-entry` job, §21.5/§22.2, the Phase 4/7 follow-up that
 * no caller ever invoked `indexKnowledgeEntry()`), against real Postgres:
 *
 * - create/update → a durable, tenant-scoped indexing job (never a
 *   synchronous embedding call inside the request);
 * - worker → an embedding stored with provenance (provider, model,
 *   dimensions, content hash) for exactly the content it embedded;
 * - stale results never overwrite newer content;
 * - provider failure leaves the entry saved and keyword-retrievable, stores
 *   no fake vector, and a later retry stores it exactly once;
 * - each business only ever uses its own embedding configuration, and a
 *   job can never touch another business's entry.
 *
 * The embedding provider is a deterministic fake routed through the real
 * `EmbeddingProviderRegistry` seam — no real provider is called.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { logger } from "@/lib/observability/logger";
import { AIProviderError } from "@/lib/ai/providers/types";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { encryptAIProviderCredential, encryptEmbeddingProviderCredential } from "@/lib/ai/config";
import { getDefaultBusinessId } from "@/lib/tenancy/default-business";
import { generateToken } from "@/lib/identity/auth";
import { provisionBusiness } from "@/lib/platform/provisioning";
import * as knowledgeService from "@/lib/knowledge/service";
import { knowledgeRetriever } from "@/lib/knowledge/retriever";
import { indexKnowledgeEntry, knowledgeContentHash, readStoredEmbedding, enqueueBusinessKnowledgeReindex } from "@/lib/knowledge/indexing";
import { handleIndexKnowledgeEntry } from "@/lib/jobs/handlers/index-knowledge-entry";
import { jobQueue } from "@/lib/jobs/queue";
import { INDEX_KNOWLEDGE_ENTRY_JOB } from "@/lib/jobs/job-types";
import type { FakeJobQueue } from "@/lib/jobs/fake-job-queue";
import { PgBossJobQueue } from "@/lib/jobs/pgboss-job-queue";
import type { TenantContext } from "@/lib/tenancy/context";
import { seedBusiness, cleanupBusiness, findOrCreateDefaultBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { createRequest, parseJsonResponse } from "../helpers/request";
import {
  ScriptedEmbeddingProvider,
  conceptVector,
  routeEmbeddingRegistry,
  retryableEmbeddingError,
  nonRetryableEmbeddingError,
} from "../helpers/embedding-fakes";

const fakeQueue = jobQueue as FakeJobQueue;

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let providerA: ScriptedEmbeddingProvider;
let providerB: ScriptedEmbeddingProvider;
let registrySpy: ReturnType<typeof routeEmbeddingRegistry>;
/** Every credential the registry was asked to build a provider for, in order. */
const keysUsed: string[] = [];

async function configureEmbeddingKey(business: SeededBusiness, apiKey: string) {
  const db = getScopedPrisma(business.ctx);
  const embeddingCredentialRef = await encryptEmbeddingProviderCredential("openai", apiKey);
  await db.businessConfig.upsert({
    where: { businessId: business.businessId },
    update: { embeddingProvider: "openai", embeddingCredentialRef },
    create: { businessId: business.businessId, embeddingProvider: "openai", embeddingCredentialRef },
  });
}

async function createCategory(ctx: TenantContext, name: string) {
  return getScopedPrisma(ctx).category.create({ data: { name } });
}

async function readEntry(ctx: TenantContext, id: string) {
  return getScopedPrisma(ctx).knowledgeEntry.findUnique({ where: { id } });
}

beforeAll(async () => {
  businessA = await seedBusiness("knowledge-indexing-a");
  businessB = await seedBusiness("knowledge-indexing-b");
  await configureEmbeddingKey(businessA, "sk-business-a-embedding");
  await configureEmbeddingKey(businessB, "sk-business-b-embedding");
  providerA = new ScriptedEmbeddingProvider("sk-business-a-embedding");
  providerB = new ScriptedEmbeddingProvider("sk-business-b-embedding");
  registrySpy = routeEmbeddingRegistry((apiKey) => {
    keysUsed.push(apiKey);
    if (apiKey === "sk-business-a-embedding") return providerA;
    if (apiKey === "sk-business-b-embedding") return providerB;
    return new ScriptedEmbeddingProvider(apiKey);
  });
});

afterAll(async () => {
  registrySpy.mockRestore();
  await cleanupBusiness(businessA.businessId);
  await cleanupBusiness(businessB.businessId);
});

afterEach(async () => {
  await fakeQueue.__drainForTests();
  for (const p of [providerA, providerB]) {
    p.failures.length = 0;
    p.gate = null;
  }
});

describe("create → durable indexing job → stored embedding", () => {
  it("creating an active entry enqueues a tenant-scoped index-knowledge-entry job instead of embedding inside the request", async () => {
    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    const category = await createCategory(businessA.ctx, "create-enqueue");

    const created = await knowledgeService.createEntry(businessA.ctx, {
      categoryId: category.id,
      title: "Opening hours",
      content: "We are open every weekend from 9 to 5.",
    });

    expect(enqueueSpy).toHaveBeenCalledWith(INDEX_KNOWLEDGE_ENTRY_JOB, { businessId: businessA.businessId, entryId: created.id });
    // The request never claims indexing completed: the returned entry carries no embedding.
    expect(readStoredEmbedding(created.metadata)).toBeNull();
    enqueueSpy.mockRestore();
  });

  it("the worker stores an embedding for exactly the current content, with provider/model/content-hash provenance", async () => {
    const category = await createCategory(businessA.ctx, "create-index");
    const created = await knowledgeService.createEntry(businessA.ctx, {
      categoryId: category.id,
      title: "Shipping",
      content: "Every parcel is handed to a courier within a day.",
    });
    await fakeQueue.__drainForTests();

    const row = (await readEntry(businessA.ctx, created.id))!;
    // Indexing is not a user edit: it must not bump updatedAt (the knowledge list is ordered by it).
    expect(row.updatedAt.getTime()).toBe(new Date(created.updatedAt).getTime());
    const stored = readStoredEmbedding(row.metadata);
    expect(stored).not.toBeNull();
    expect(stored!.vector).toEqual(conceptVector("Shipping\nEvery parcel is handed to a courier within a day."));
    expect(stored!.index).toMatchObject({
      provider: "fake-concept",
      model: "fake-concept-v1",
      dimensions: providerA.dimensions,
      contentHash: knowledgeContentHash({ title: "Shipping", content: "Every parcel is handed to a courier within a day." }),
    });
    expect(typeof stored!.index.indexedAt).toBe("string");
  });

  it("indexing records embedding usage against the business, like every other embedding call (§39)", async () => {
    const category = await createCategory(businessA.ctx, "usage");
    const before = await getScopedPrisma(businessA.ctx).aIInteractionLog.count({ where: { kind: "embedding" } });
    await knowledgeService.createEntry(businessA.ctx, { categoryId: category.id, title: "Pets", content: "Dogs are welcome." });
    await fakeQueue.__drainForTests();
    const after = await getScopedPrisma(businessA.ctx).aIInteractionLog.count({ where: { kind: "embedding" } });
    expect(after).toBe(before + 1);
  });

  it("deactivating an entry does not enqueue indexing", async () => {
    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    const category = await createCategory(businessA.ctx, "inactive-create");
    const db = getScopedPrisma(businessA.ctx);
    const entry = await knowledgeService.createEntry(businessA.ctx, { categoryId: category.id, title: "x", content: "y" });
    enqueueSpy.mockClear();
    await knowledgeService.updateEntry(businessA.ctx, entry.id, { isActive: false });
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect((await db.knowledgeEntry.findUnique({ where: { id: entry.id } }))!.isActive).toBe(false);
    enqueueSpy.mockRestore();
  });
});

describe("update → reindex only when searchable text changes", () => {
  it("a title/content change re-embeds the new content; the old vector is replaced", async () => {
    const category = await createCategory(businessA.ctx, "update-content");
    const entry = await knowledgeService.createEntry(businessA.ctx, { categoryId: category.id, title: "Policy", content: "Purchases can be reimbursed." });
    await fakeQueue.__drainForTests();

    await knowledgeService.updateEntry(businessA.ctx, entry.id, { content: "Dogs and cats are welcome inside." });
    await fakeQueue.__drainForTests();

    const stored = readStoredEmbedding((await readEntry(businessA.ctx, entry.id))!.metadata);
    expect(stored!.vector).toEqual(conceptVector("Policy\nDogs and cats are welcome inside."));
    expect(stored!.index.contentHash).toBe(knowledgeContentHash({ title: "Policy", content: "Dogs and cats are welcome inside." }));
  });

  it("a priority-only or category-only change does not enqueue or call the embedding provider again", async () => {
    const category = await createCategory(businessA.ctx, "update-metadata");
    const other = await createCategory(businessA.ctx, "update-metadata-other");
    const entry = await knowledgeService.createEntry(businessA.ctx, { categoryId: category.id, title: "Hours", content: "Open on the weekend." });
    await fakeQueue.__drainForTests();

    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    const callsBefore = providerA.requests.length;
    await knowledgeService.updateEntry(businessA.ctx, entry.id, { priority: 7 });
    await knowledgeService.updateEntry(businessA.ctx, entry.id, { categoryId: other.id });
    await fakeQueue.__drainForTests();

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(providerA.requests.length).toBe(callsBefore);
    expect(readStoredEmbedding((await readEntry(businessA.ctx, entry.id))!.metadata)).not.toBeNull();
    enqueueSpy.mockRestore();
  });

  it("re-saving identical text does not re-embed (the job sees the stored embedding is already current)", async () => {
    const category = await createCategory(businessA.ctx, "update-same");
    const entry = await knowledgeService.createEntry(businessA.ctx, { categoryId: category.id, title: "Same", content: "Same text." });
    await fakeQueue.__drainForTests();
    const callsBefore = providerA.requests.length;

    await knowledgeService.updateEntry(businessA.ctx, entry.id, { title: "Same", content: "Same text." });
    await fakeQueue.__drainForTests();
    expect(providerA.requests.length).toBe(callsBefore);
  });
});

describe("stale-write protection", () => {
  it("a slow job for version A that finishes after version B was indexed never overwrites B's embedding", async () => {
    const category = await createCategory(businessA.ctx, "stale");
    const db = getScopedPrisma(businessA.ctx);
    // Created directly (no job) so this test drives both jobs by hand.
    const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Policy", content: "Version A: purchases are reimbursed." } });

    let releaseA!: () => void;
    const aIsWaiting = new Promise<void>((resolveWaiting) => {
      providerA.gate = async (text) => {
        if (text.includes("Version A")) {
          resolveWaiting();
          await new Promise<void>((release) => (releaseA = release));
        }
      };
    });

    const jobA = indexKnowledgeEntry(businessA.ctx, entry.id); // 2. job A starts, embeds version A (blocked)
    await aIsWaiting;

    await db.knowledgeEntry.update({ where: { id: entry.id }, data: { content: "Version B: dogs are welcome." } }); // 3. user edits
    const outcomeB = await indexKnowledgeEntry(businessA.ctx, entry.id); // 4. job B runs to completion
    expect(outcomeB.status).toBe("indexed");

    releaseA(); // 5. job A finishes last
    const outcomeA = await jobA;
    expect(outcomeA.status).toBe("stale");

    const stored = readStoredEmbedding((await readEntry(businessA.ctx, entry.id))!.metadata);
    expect(stored!.index.contentHash).toBe(knowledgeContentHash({ title: "Policy", content: "Version B: dogs are welcome." }));
    expect(stored!.vector).toEqual(conceptVector("Policy\nVersion B: dogs are welcome."));
  });

  it("retrieval ignores a stored embedding whose content hash no longer matches the entry (e.g. edited after indexing)", async () => {
    const category = await createCategory(businessA.ctx, "stale-retrieval");
    const db = getScopedPrisma(businessA.ctx);
    const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Wire info", content: "We wire money abroad to family." } });
    await indexKnowledgeEntry(businessA.ctx, entry.id);
    // Content changes underneath without a reindex having run yet.
    await db.knowledgeEntry.update({ where: { id: entry.id }, data: { content: "Opening hours on the weekend." } });

    // The stale "remittance" vector would match this query semantically; the
    // current text does not mention it at all, so the entry must not come back
    // on the strength of the outdated vector.
    const results = await knowledgeRetriever.retrieve(businessA.ctx, "international transfer abroad", { limit: 20 });
    expect(results.map((r) => r.id)).not.toContain(entry.id);
  });
});

describe("provider failure and retry", () => {
  it("a retryable provider failure leaves the entry saved and keyword-retrievable, stores no vector, and the job throws so the queue retries", async () => {
    const category = await createCategory(businessA.ctx, "failure-retryable");
    const db = getScopedPrisma(businessA.ctx);
    const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Zebra crossing rules", content: "Zebra crossings require stopping." } });

    providerA.failures.push(retryableEmbeddingError());
    await expect(handleIndexKnowledgeEntry(businessA.ctx, { businessId: businessA.businessId, entryId: entry.id })).rejects.toThrow();

    const after = await readEntry(businessA.ctx, entry.id);
    expect(after!.content).toBe("Zebra crossings require stopping.");
    expect(readStoredEmbedding(after!.metadata)).toBeNull();
    expect((after!.metadata as Record<string, unknown>).embedding).toBeUndefined();

    const results = await knowledgeRetriever.retrieve(businessA.ctx, "zebra crossing", { limit: 5 });
    expect(results.map((r) => r.id)).toContain(entry.id);

    // A later retry populates it.
    await handleIndexKnowledgeEntry(businessA.ctx, { businessId: businessA.businessId, entryId: entry.id });
    expect(readStoredEmbedding((await readEntry(businessA.ctx, entry.id))!.metadata)).not.toBeNull();
  });

  it("a non-retryable failure (e.g. invalid key) completes the job without throwing and without storing anything", async () => {
    const category = await createCategory(businessA.ctx, "failure-auth");
    const db = getScopedPrisma(businessA.ctx);
    const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Auth fail", content: "Text." } });

    providerA.failures.push(nonRetryableEmbeddingError());
    await expect(handleIndexKnowledgeEntry(businessA.ctx, { businessId: businessA.businessId, entryId: entry.id })).resolves.toBeUndefined();
    expect(readStoredEmbedding((await readEntry(businessA.ctx, entry.id))!.metadata)).toBeNull();
  });

  it("a provider returning an empty, wrong-sized, or non-finite vector is rejected — no fake/zero embedding is ever stored", async () => {
    const category = await createCategory(businessA.ctx, "failure-bad-vector");
    const db = getScopedPrisma(businessA.ctx);
    const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Bad vector", content: "Text." } });

    const size = providerA.dimensions;
    const zero = new Array(size).fill(0);
    const nonFinite = [Number.NaN, ...new Array(size - 1).fill(0.5)];
    for (const vector of [[], zero, [1, 2], nonFinite]) {
      const spy = vi.spyOn(providerA, "embed").mockResolvedValueOnce({ vector, model: "fake-concept-v1", usage: { totalTokens: 1 } });
      const outcome = await indexKnowledgeEntry(businessA.ctx, entry.id);
      expect(outcome.status).toBe("failed");
      spy.mockRestore();
    }
    expect((await readEntry(businessA.ctx, entry.id))!.metadata).toEqual({});
  });

  it("through a REAL pg-boss queue: a transient failure is retried by the queue and the embedding is stored exactly once", async () => {
    const category = await createCategory(businessA.ctx, "failure-pgboss");
    const db = getScopedPrisma(businessA.ctx);
    const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Retry me", content: "Dogs welcome." } });

    providerA.failures.push(retryableEmbeddingError());
    const successesBefore = providerA.successes;
    const usageBefore = await db.aIInteractionLog.count({ where: { kind: "embedding" } });

    const queue = new PgBossJobQueue(process.env.DATABASE_URL!);
    queue.registerHandler(INDEX_KNOWLEDGE_ENTRY_JOB, handleIndexKnowledgeEntry);
    await queue.start();
    try {
      await queue.enqueue(INDEX_KNOWLEDGE_ENTRY_JOB, { businessId: businessA.businessId, entryId: entry.id });
      const deadline = Date.now() + 45000;
      while (!readStoredEmbedding((await readEntry(businessA.ctx, entry.id))!.metadata)) {
        if (Date.now() > deadline) throw new Error("embedding was never stored after retry");
        await new Promise((r) => setTimeout(r, 250));
      }
      await new Promise((r) => setTimeout(r, 1500)); // window for an incorrect duplicate run
    } finally {
      await queue.stop();
    }

    expect(providerA.successes - successesBefore).toBe(1);
    expect(await db.aIInteractionLog.count({ where: { kind: "embedding" } })).toBe(usageBefore + 1);
  }, 60000);
});

describe("deactivate / reactivate / delete", () => {
  it("a deactivated entry is excluded from retrieval even though its embedding is stored", async () => {
    const category = await createCategory(businessA.ctx, "deactivate");
    const entry = await knowledgeService.createEntry(businessA.ctx, { categoryId: category.id, title: "Parcel courier", content: "Courier shipping details." });
    await fakeQueue.__drainForTests();
    expect((await knowledgeRetriever.retrieve(businessA.ctx, "parcel courier", { limit: 20 })).map((r) => r.id)).toContain(entry.id);

    await knowledgeService.updateEntry(businessA.ctx, entry.id, { isActive: false });
    expect((await knowledgeRetriever.retrieve(businessA.ctx, "parcel courier", { limit: 20 })).map((r) => r.id)).not.toContain(entry.id);
  });

  it("reactivating an entry with no current embedding indexes it; reactivating one that is current does not re-embed", async () => {
    const category = await createCategory(businessA.ctx, "reactivate");
    const db = getScopedPrisma(businessA.ctx);
    const never = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Never indexed", content: "Dogs.", isActive: false } });

    await knowledgeService.updateEntry(businessA.ctx, never.id, { isActive: true });
    await fakeQueue.__drainForTests();
    expect(readStoredEmbedding((await readEntry(businessA.ctx, never.id))!.metadata)).not.toBeNull();

    await knowledgeService.updateEntry(businessA.ctx, never.id, { isActive: false });
    const callsBefore = providerA.requests.length;
    await knowledgeService.updateEntry(businessA.ctx, never.id, { isActive: true });
    await fakeQueue.__drainForTests();
    expect(providerA.requests.length).toBe(callsBefore);
  });

  it("an inactive entry's job is a no-op (nothing embedded)", async () => {
    const category = await createCategory(businessA.ctx, "inactive-job");
    const db = getScopedPrisma(businessA.ctx);
    const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Off", content: "Dogs.", isActive: false } });
    const callsBefore = providerA.requests.length;
    expect((await indexKnowledgeEntry(businessA.ctx, entry.id)).status).toBe("skipped");
    expect(providerA.requests.length).toBe(callsBefore);
  });

  it("deleting an entry while its job is still pending: the job finds nothing, writes nothing, and does not fail", async () => {
    const category = await createCategory(businessA.ctx, "delete");
    const db = getScopedPrisma(businessA.ctx);
    const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Doomed", content: "Dogs." } });
    const neighbour = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Neighbour", content: "Cats." } });

    await knowledgeService.removeEntry(businessA.ctx, entry.id);
    await expect(handleIndexKnowledgeEntry(businessA.ctx, { businessId: businessA.businessId, entryId: entry.id })).resolves.toBeUndefined();

    expect(await readEntry(businessA.ctx, entry.id)).toBeNull();
    expect((await readEntry(businessA.ctx, neighbour.id))!.metadata).toEqual({});
  });

  it("an entry deleted while its embedding call is in flight is not resurrected or written", async () => {
    const category = await createCategory(businessA.ctx, "delete-in-flight");
    const db = getScopedPrisma(businessA.ctx);
    const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "In flight", content: "Version gone." } });

    let release!: () => void;
    const waiting = new Promise<void>((resolveWaiting) => {
      providerA.gate = async () => {
        resolveWaiting();
        await new Promise<void>((r) => (release = r));
      };
    });
    const job = indexKnowledgeEntry(businessA.ctx, entry.id);
    await waiting;
    await db.knowledgeEntry.delete({ where: { id: entry.id } });
    release();
    expect((await job).status).toBe("stale");
    expect(await readEntry(businessA.ctx, entry.id)).toBeNull();
  });
});

describe("tenant/provider isolation", () => {
  it("Business A's entry is embedded with Business A's credential; Business B's with Business B's", async () => {
    const catA = await createCategory(businessA.ctx, "iso-a");
    const catB = await createCategory(businessB.ctx, "iso-b");
    const aCalls = providerA.requests.length;
    const bCalls = providerB.requests.length;

    const entryA = await knowledgeService.createEntry(businessA.ctx, { categoryId: catA.id, title: "A only", content: "Alpha dogs text." });
    const entryB = await knowledgeService.createEntry(businessB.ctx, { categoryId: catB.id, title: "B only", content: "Beta cats text." });
    await fakeQueue.__drainForTests();

    expect(providerA.requests.slice(aCalls)).toEqual(["A only\nAlpha dogs text."]);
    expect(providerB.requests.slice(bCalls)).toEqual(["B only\nBeta cats text."]);
    expect(readStoredEmbedding((await readEntry(businessA.ctx, entryA.id))!.metadata)).not.toBeNull();
    expect(readStoredEmbedding((await readEntry(businessB.ctx, entryB.id))!.metadata)).not.toBeNull();
  });

  it("a job for Business A naming Business B's entry id fails closed: B's entry is never read, embedded or written", async () => {
    const catB = await createCategory(businessB.ctx, "iso-cross");
    const entryB = await getScopedPrisma(businessB.ctx).knowledgeEntry.create({ data: { categoryId: catB.id, title: "B secret", content: "B content." } });
    const aCalls = providerA.requests.length;
    const bCalls = providerB.requests.length;

    // The worker resolves ctx from the payload's businessId; a payload pairing A with B's id
    // can only ever see A's rows.
    await expect(handleIndexKnowledgeEntry(businessA.ctx, { businessId: businessA.businessId, entryId: entryB.id })).resolves.toBeUndefined();
    expect((await indexKnowledgeEntry(businessA.ctx, entryB.id)).status).toBe("skipped");

    expect(providerA.requests.length).toBe(aCalls);
    expect(providerB.requests.length).toBe(bCalls);
    expect((await readEntry(businessB.ctx, entryB.id))!.metadata).toEqual({});
  });

  it("a handler invoked with a ctx that disagrees with its payload's businessId refuses to run", async () => {
    const catB = await createCategory(businessB.ctx, "iso-mismatch");
    const entryB = await getScopedPrisma(businessB.ctx).knowledgeEntry.create({ data: { categoryId: catB.id, title: "B", content: "B." } });
    await expect(handleIndexKnowledgeEntry(businessA.ctx, { businessId: businessB.businessId, entryId: entryB.id })).rejects.toThrow();
    expect((await readEntry(businessB.ctx, entryB.id))!.metadata).toEqual({});
  });

  it("a signed-up business with no embedding credential is never indexed with the Default Business's legacy key", async () => {
    const defaultBusiness = await findOrCreateDefaultBusiness();
    vi.mocked(getDefaultBusinessId).mockResolvedValue(defaultBusiness.businessId);
    // Only the legacy Settings singleton's read is doubled — everything else is real.
    const settingsSpy = vi
      .spyOn(prisma.settings, "findUnique")
      .mockResolvedValue({ id: "default", aiProvider: "openai", aiModel: "gpt-4o-mini", maxTokens: 500, temperature: 0.7, aiApiKey: "sk-legacy-default-business" } as never);

    const provisioned = await provisionBusiness({
      businessName: "Indexing Signup Co",
      ownerUsername: `indexing-signup-${Date.now()}`,
      ownerPassword: "not-a-real-login-password",
      ownerName: "Owner",
    });
    const signupCtx: TenantContext = { businessId: provisioned.businessId, role: "owner", actor: { kind: "user", userId: provisioned.userId }, dataConnection: "shared-default" };

    try {
      const keysBefore = keysUsed.length;
      const catS = await createCategory(signupCtx, "signup");
      const entryS = await knowledgeService.createEntry(signupCtx, { categoryId: catS.id, title: "Signup entry", content: "Dogs." });
      await fakeQueue.__drainForTests();
      expect(keysUsed.slice(keysBefore)).not.toContain("sk-legacy-default-business");
      expect(readStoredEmbedding((await readEntry(signupCtx, entryS.id))!.metadata)).toBeNull();
      expect((await indexKnowledgeEntry(signupCtx, entryS.id)).status).toBe("skipped");

      // Positive control: the legacy key IS reachable for the Default Business itself,
      // so the assertion above is not vacuous.
      const catD = await createCategory(defaultBusiness.ctx, `default-${Date.now()}`);
      const entryD = await getScopedPrisma(defaultBusiness.ctx).knowledgeEntry.create({ data: { categoryId: catD.id, title: "Default entry", content: "Cats." } });
      expect((await indexKnowledgeEntry(defaultBusiness.ctx, entryD.id)).status).toBe("indexed");
      expect(keysUsed[keysUsed.length - 1]).toBe("sk-legacy-default-business");
      await getScopedPrisma(defaultBusiness.ctx).knowledgeEntry.delete({ where: { id: entryD.id } });
      await getScopedPrisma(defaultBusiness.ctx).category.delete({ where: { id: catD.id } });
    } finally {
      settingsSpy.mockRestore();
      vi.mocked(getDefaultBusinessId).mockResolvedValue("test-default-business-id");
      await cleanupBusiness(provisioned.businessId);
    }
  });

  it("a business whose resolved embedding provider has no registered implementation (Anthropic generation key, no embedding key) is skipped, and retrieval still works by keyword instead of throwing", async () => {
    const business = await seedBusiness("knowledge-indexing-anthropic");
    try {
      const db = getScopedPrisma(business.ctx);
      const aiCredentialRef = await encryptAIProviderCredential("anthropic", "sk-ant-not-for-embeddings");
      await db.businessConfig.upsert({
        where: { businessId: business.businessId },
        update: { aiProvider: "anthropic", aiCredentialRef },
        create: { businessId: business.businessId, aiProvider: "anthropic", aiCredentialRef },
      });
      registrySpy.mockRestore(); // the real registry: it has no "anthropic" embedding provider
      const category = await db.category.create({ data: { name: "anthropic" } });
      const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Kiwi delivery", content: "Kiwi fruit delivery each Monday." } });

      expect((await indexKnowledgeEntry(business.ctx, entry.id)).status).toBe("skipped");
      const results = await knowledgeRetriever.retrieve(business.ctx, "kiwi delivery", { limit: 5 });
      expect(results.map((r) => r.id)).toContain(entry.id);
    } finally {
      registrySpy = routeEmbeddingRegistry((apiKey) => {
        keysUsed.push(apiKey);
        if (apiKey === "sk-business-a-embedding") return providerA;
        if (apiKey === "sk-business-b-embedding") return providerB;
        return new ScriptedEmbeddingProvider(apiKey);
      });
      await cleanupBusiness(business.businessId);
    }
  });
});

describe("embedding configuration changes", () => {
  it("an embedding stored under a different provider is not trusted by retrieval", async () => {
    const category = await createCategory(businessA.ctx, "provider-change");
    const db = getScopedPrisma(businessA.ctx);
    const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Wire info", content: "International transfer abroad." } });
    await indexKnowledgeEntry(businessA.ctx, entry.id);
    const metadata = (await readEntry(businessA.ctx, entry.id))!.metadata as Record<string, Record<string, unknown>>;
    await db.knowledgeEntry.update({
      where: { id: entry.id },
      data: { metadata: { ...metadata, embeddingIndex: { ...metadata.embeddingIndex, provider: "some-other-provider" } } },
    });

    // Query shares no keyword with the entry; only a (trusted) vector could surface it.
    const results = await knowledgeRetriever.retrieve(businessA.ctx, "sending money to family", { limit: 20 });
    expect(results.map((r) => r.id)).not.toContain(entry.id);
  });

  it("changing the business's AI/embedding settings enqueues a reindex of its active entries only", async () => {
    const category = await createCategory(businessB.ctx, "settings-reindex");
    const db = getScopedPrisma(businessB.ctx);
    const active = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Active", content: "Dogs." } });
    const inactive = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Inactive", content: "Cats.", isActive: false } });

    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    const { PUT } = await import("@/app/api/settings/ai/route");
    const response = await PUT(
      createRequest("/api/settings/ai", {
        method: "PUT",
        body: { embeddingProvider: "openai", embeddingApiKey: "sk-business-b-embedding" },
        cookies: { "owly-token": generateToken(businessB.ownerUserId) },
      })
    );
    expect(response.status).toBe(200);

    const enqueued = enqueueSpy.mock.calls.filter(([type]) => type === INDEX_KNOWLEDGE_ENTRY_JOB).map(([, payload]) => payload);
    expect(enqueued).toContainEqual({ businessId: businessB.businessId, entryId: active.id });
    expect(enqueued).not.toContainEqual({ businessId: businessB.businessId, entryId: inactive.id });
    expect(enqueued.every((p) => (p as { businessId: string }).businessId === businessB.businessId)).toBe(true);
    enqueueSpy.mockRestore();
    await fakeQueue.__drainForTests();
    expect(readStoredEmbedding((await readEntry(businessB.ctx, active.id))!.metadata)).not.toBeNull();
  });

  it("enqueueBusinessKnowledgeReindex never enqueues another business's entries", async () => {
    const catA = await createCategory(businessA.ctx, "reindex-a");
    const entryA = await getScopedPrisma(businessA.ctx).knowledgeEntry.create({ data: { categoryId: catA.id, title: "A", content: "Dogs." } });
    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    await enqueueBusinessKnowledgeReindex(businessB.ctx);
    const payloads = enqueueSpy.mock.calls.map(([, payload]) => payload as { businessId: string; entryId: string });
    expect(payloads.some((p) => p.entryId === entryA.id)).toBe(false);
    expect(payloads.every((p) => p.businessId === businessB.businessId)).toBe(true);
    enqueueSpy.mockRestore();
  });
});

describe("API surface", () => {
  it("knowledge entry API responses never ship the raw vector, but do expose indexing provenance", async () => {
    const category = await createCategory(businessA.ctx, "api-view");
    const entry = await knowledgeService.createEntry(businessA.ctx, { categoryId: category.id, title: "View", content: "Dogs welcome." });
    await fakeQueue.__drainForTests();

    const { GET } = await import("@/app/api/knowledge/entries/route");
    const response = await GET(
      createRequest("/api/knowledge/entries", {
        searchParams: { categoryId: category.id },
        cookies: { "owly-token": generateToken(businessA.ownerUserId) },
      })
    );
    const data = await parseJsonResponse(response);
    const view = data.data.find((e: { id: string }) => e.id === entry.id);
    expect(view.metadata.embedding).toBeUndefined();
    expect(view.metadata.embeddingIndex.contentHash).toBe(knowledgeContentHash({ title: "View", content: "Dogs welcome." }));
  });

  it("an enqueue failure never makes knowledge editing fail: the entry is still saved", async () => {
    const enqueueSpy = vi.spyOn(jobQueue, "enqueue").mockRejectedValueOnce(new Error("queue unavailable"));
    const category = await createCategory(businessA.ctx, "enqueue-failure");
    const entry = await knowledgeService.createEntry(businessA.ctx, { categoryId: category.id, title: "Saved anyway", content: "Zebra text." });
    expect((await readEntry(businessA.ctx, entry.id))!.title).toBe("Saved anyway");
    expect((await knowledgeRetriever.retrieve(businessA.ctx, "zebra text", { limit: 20 })).map((r) => r.id)).toContain(entry.id);
    enqueueSpy.mockRestore();
  });
});

describe("observability", () => {
  it("failure logs identify business, entry, provider and outcome — never the key or the entry body", async () => {
    const category = await createCategory(businessA.ctx, "observability");
    const db = getScopedPrisma(businessA.ctx);
    const body = "CONFIDENTIAL-KNOWLEDGE-BODY dogs";
    const entry = await db.knowledgeEntry.create({ data: { categoryId: category.id, title: "Secret", content: body } });
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    const consoleError = vi.spyOn(console, "error");

    providerA.failures.push(new AIProviderError("rate_limit", "Rate limited for key sk-business-a-embedding-LEAK", true));
    await expect(handleIndexKnowledgeEntry(businessA.ctx, { businessId: businessA.businessId, entryId: entry.id })).rejects.toThrow();
    providerA.failures.push(new AIProviderError("auth", "Incorrect API key provided: sk-proj-abc****wxyz", false));
    await handleIndexKnowledgeEntry(businessA.ctx, { businessId: businessA.businessId, entryId: entry.id });

    const retryLog = warn.mock.calls.find(([message]) => String(message).includes("index-knowledge-entry"));
    const failLog = error.mock.calls.find(([message]) => String(message).includes("index-knowledge-entry"));
    expect(retryLog?.[1]).toMatchObject({ businessId: businessA.businessId, knowledgeEntryId: entry.id, provider: "fake-concept", outcome: "retrying", code: "rate_limit" });
    // logger.error(message, error?, context?) — structured fields are the third argument.
    expect(failLog?.[2]).toMatchObject({ businessId: businessA.businessId, knowledgeEntryId: entry.id, provider: "fake-concept", outcome: "failed", code: "auth" });

    // What actually reaches the log line carries the fields (not "[object Object]").
    const printed = consoleError.mock.calls.map((c) => String(c[0])).find((line) => line.includes("embedding failed permanently"));
    expect(printed).toContain(`"knowledgeEntryId":"${entry.id}"`);
    expect(printed).toContain('"outcome":"failed"');

    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls, ...consoleError.mock.calls]);
    expect(logged).not.toContain("sk-business-a-embedding");
    expect(logged).not.toContain("abc****wxyz");
    expect(logged).not.toContain("CONFIDENTIAL-KNOWLEDGE-BODY");
    warn.mockRestore();
    error.mockRestore();
    consoleError.mockRestore();
  });
});
