import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

/**
 * Tenant-scoped embedding reindex/backfill (`enqueueKnowledgeReindex(ctx)`,
 * `backfillKnowledgeEmbeddings()`, `npm run knowledge:reindex`), against real
 * Postgres: it queues exactly the active entries whose stored embedding is
 * missing or stale by the same `isEmbeddingCurrent` rule the worker uses,
 * never touches another business, is safe to rerun, and what it queues is
 * indexed by the existing worker path.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { encryptEmbeddingProviderCredential } from "@/lib/ai/config";
import { generateToken } from "@/lib/identity/auth";
import {
  enqueueKnowledgeReindex,
  indexKnowledgeEntry,
  readStoredEmbedding,
  knowledgeContentHash,
  knowledgeIndexJobKey,
} from "@/lib/knowledge/indexing";
import { backfillKnowledgeEmbeddings } from "@/lib/knowledge/backfill";
// Loads the knowledge service, which registers the index-knowledge-entry handler with the in-process queue.
import "@/lib/knowledge/service";
import { jobQueue } from "@/lib/jobs/queue";
import { INDEX_KNOWLEDGE_ENTRY_JOB } from "@/lib/jobs/job-types";
import type { FakeJobQueue } from "@/lib/jobs/fake-job-queue";
import { PgBossJobQueue } from "@/lib/jobs/pgboss-job-queue";
import type { TenantContext } from "@/lib/tenancy/context";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { createRequest } from "../helpers/request";
import { ScriptedEmbeddingProvider, routeEmbeddingRegistry } from "../helpers/embedding-fakes";

const fakeQueue = jobQueue as FakeJobQueue;

let businessA: SeededBusiness;
let businessB: SeededBusiness;
let noProvider: SeededBusiness;
let providerA: ScriptedEmbeddingProvider;
let providerB: ScriptedEmbeddingProvider;
let registrySpy: ReturnType<typeof routeEmbeddingRegistry>;

async function configureEmbeddingKey(business: SeededBusiness, apiKey: string) {
  const embeddingCredentialRef = await encryptEmbeddingProviderCredential("openai", apiKey);
  await getScopedPrisma(business.ctx).businessConfig.upsert({
    where: { businessId: business.businessId },
    update: { embeddingProvider: "openai", embeddingCredentialRef },
    create: { businessId: business.businessId, embeddingProvider: "openai", embeddingCredentialRef },
  });
}

/** An entry exactly as it existed before stored embeddings: saved, active, no vector, no job. */
async function preFeatureEntry(ctx: TenantContext, title: string, content: string, extra: { isActive?: boolean } = {}) {
  const db = getScopedPrisma(ctx);
  const category = (await db.category.findFirst({ where: { name: "reindex" } })) ?? (await db.category.create({ data: { name: "reindex" } }));
  return db.knowledgeEntry.create({ data: { categoryId: category.id, title, content, ...extra } });
}

async function readMetadata(ctx: TenantContext, id: string) {
  return (await getScopedPrisma(ctx).knowledgeEntry.findUnique({ where: { id } }))!.metadata as Record<string, unknown>;
}

/** Overwrites part of a stored embedding's provenance, simulating an older provider/model/shape. */
async function patchProvenance(ctx: TenantContext, id: string, patch: Record<string, unknown>, vector?: number[]) {
  const metadata = await readMetadata(ctx, id);
  await getScopedPrisma(ctx).knowledgeEntry.update({
    where: { id },
    data: {
      metadata: {
        ...metadata,
        ...(vector ? { embedding: vector } : {}),
        embeddingIndex: { ...(metadata.embeddingIndex as Record<string, unknown>), ...patch },
      } as object,
    },
  });
}

function queuedEntryIds(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.filter(([type]) => type === INDEX_KNOWLEDGE_ENTRY_JOB).map(([, payload]) => (payload as { entryId: string }).entryId);
}

beforeAll(async () => {
  businessA = await seedBusiness("knowledge-reindex-a");
  businessB = await seedBusiness("knowledge-reindex-b");
  noProvider = await seedBusiness("knowledge-reindex-none");
  await configureEmbeddingKey(businessA, "sk-reindex-a");
  await configureEmbeddingKey(businessB, "sk-reindex-b");
  providerA = new ScriptedEmbeddingProvider("sk-reindex-a");
  providerB = new ScriptedEmbeddingProvider("sk-reindex-b");
  registrySpy = routeEmbeddingRegistry((apiKey) => (apiKey === "sk-reindex-a" ? providerA : apiKey === "sk-reindex-b" ? providerB : new ScriptedEmbeddingProvider(apiKey)));
});

afterAll(async () => {
  registrySpy.mockRestore();
  for (const b of [businessA, businessB, noProvider]) await cleanupBusiness(b.businessId);
});

afterEach(async () => {
  await fakeQueue.__drainForTests();
  vi.restoreAllMocks();
  registrySpy = routeEmbeddingRegistry((apiKey) => (apiKey === "sk-reindex-a" ? providerA : apiKey === "sk-reindex-b" ? providerB : new ScriptedEmbeddingProvider(apiKey)));
});

describe("which entries a reindex scan queues", () => {
  it("queues a pre-existing active entry with no embedding, and does not queue one whose embedding is current", async () => {
    const missing = await preFeatureEntry(businessA.ctx, "Missing", "Dogs welcome.");
    const current = await preFeatureEntry(businessA.ctx, "Current", "Cats welcome.");
    expect((await indexKnowledgeEntry(businessA.ctx, current.id)).status).toBe("indexed");

    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    const result = await enqueueKnowledgeReindex(businessA.ctx);
    const queued = queuedEntryIds(enqueueSpy);

    expect(queued).toContain(missing.id);
    expect(queued).not.toContain(current.id);
    expect(enqueueSpy).toHaveBeenCalledWith(
      INDEX_KNOWLEDGE_ENTRY_JOB,
      { businessId: businessA.businessId, entryId: missing.id },
      { singletonKey: knowledgeIndexJobKey(businessA.businessId, missing.id) }
    );
    expect(result.provider).toMatchObject({ status: "available", name: "fake-concept", model: "fake-concept-v1" });
    expect(result.examined).toBe(result.current + result.queued + result.enqueueFailed);
    expect(result.current).toBeGreaterThanOrEqual(1);
  });

  it("queues an entry whose content changed after it was indexed (stale content hash)", async () => {
    const entry = await preFeatureEntry(businessA.ctx, "Edited", "Version one.");
    await indexKnowledgeEntry(businessA.ctx, entry.id);
    await getScopedPrisma(businessA.ctx).knowledgeEntry.update({ where: { id: entry.id }, data: { content: "Version two." } });

    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    await enqueueKnowledgeReindex(businessA.ctx);
    expect(queuedEntryIds(enqueueSpy)).toContain(entry.id);
  });

  it.each([
    ["provider", { provider: "some-retired-provider" }],
    ["model", { model: "fake-concept-v0" }],
    ["dimensions", { dimensions: 3 }, [0.1, 0.2, 0.3]],
  ] as const)("queues an entry whose embedding was produced under a different %s", async (_label, patch, vector) => {
    const entry = await preFeatureEntry(businessA.ctx, `Stale ${_label}`, "Dogs and cats.");
    await indexKnowledgeEntry(businessA.ctx, entry.id);
    await patchProvenance(businessA.ctx, entry.id, patch, vector ? [...vector] : undefined);

    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    await enqueueKnowledgeReindex(businessA.ctx);
    expect(queuedEntryIds(enqueueSpy)).toContain(entry.id);

    // …and the existing worker path really re-embeds it (it does not count it as current).
    await fakeQueue.__drainForTests();
    const stored = readStoredEmbedding(await readMetadata(businessA.ctx, entry.id));
    expect(stored!.index).toMatchObject({ provider: "fake-concept", model: "fake-concept-v1", dimensions: providerA.dimensions });
  });

  it("does not examine or queue inactive entries", async () => {
    const inactive = await preFeatureEntry(businessA.ctx, "Inactive", "Dogs.", { isActive: false });
    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    await enqueueKnowledgeReindex(businessA.ctx);
    expect(queuedEntryIds(enqueueSpy)).not.toContain(inactive.id);
  });

  it("with no usable embedding provider, examines but queues nothing and says why", async () => {
    await preFeatureEntry(noProvider.ctx, "No provider", "Dogs.");
    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    const result = await enqueueKnowledgeReindex(noProvider.ctx);
    expect(result).toMatchObject({ provider: { status: "not_configured" }, examined: 1, current: 0, queued: 0 });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});

describe("tenant isolation", () => {
  it("Business A's scan never examines or queues Business B's entries, and B's embeddings are untouched", async () => {
    const bEntry = await preFeatureEntry(businessB.ctx, "B only", "Beta dogs.");
    const bActive = await getScopedPrisma(businessB.ctx).knowledgeEntry.count({ where: { isActive: true } });
    const aActive = await getScopedPrisma(businessA.ctx).knowledgeEntry.count({ where: { isActive: true } });
    const bCalls = providerB.requests.length;

    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    const result = await enqueueKnowledgeReindex(businessA.ctx);
    await fakeQueue.__drainForTests();

    expect(result.examined).toBe(aActive);
    expect(result.examined).not.toBe(aActive + bActive);
    const payloads = enqueueSpy.mock.calls.map(([, p]) => p as { businessId: string; entryId: string });
    expect(payloads.every((p) => p.businessId === businessA.businessId)).toBe(true);
    expect(payloads.map((p) => p.entryId)).not.toContain(bEntry.id);
    expect(providerB.requests.length).toBe(bCalls);
    expect(readStoredEmbedding(await readMetadata(businessB.ctx, bEntry.id))).toBeNull();
  });

  it("the operator backfill restricted to one business only visits that business", async () => {
    const bEntry = await preFeatureEntry(businessB.ctx, "B restricted", "Beta cats.");
    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    const outcomes = await backfillKnowledgeEmbeddings({ businessIds: [businessA.businessId, "00000000-0000-0000-0000-000000000000"] });

    expect(outcomes.map((o) => o.businessId).sort()).toEqual([businessA.businessId, "00000000-0000-0000-0000-000000000000"].sort());
    expect(outcomes.find((o) => o.businessId === "00000000-0000-0000-0000-000000000000")?.status).toBe("not_found_or_inactive");
    expect(queuedEntryIds(enqueueSpy)).not.toContain(bEntry.id);
  });
});

describe("idempotency and the worker path (deployment backfill)", () => {
  it("pre-feature entries are indexed by backfill + worker; a second backfill queues nothing and embeds nothing", async () => {
    const business = await seedBusiness("knowledge-reindex-deploy");
    try {
      await configureEmbeddingKey(business, "sk-reindex-deploy");
      const provider = new ScriptedEmbeddingProvider("sk-reindex-deploy");
      registrySpy.mockImplementation((_name, credential) => (credential.apiKey === "sk-reindex-deploy" ? provider : providerA));

      const entries = await Promise.all([
        preFeatureEntry(business.ctx, "Shipping", "Every parcel goes by courier."),
        preFeatureEntry(business.ctx, "Pets", "Dogs are welcome."),
        preFeatureEntry(business.ctx, "Hours", "Open on the weekend."),
      ]);
      // One deliberately stale entry: indexed under an older model.
      await indexKnowledgeEntry(business.ctx, entries[2].id);
      await patchProvenance(business.ctx, entries[2].id, { model: "fake-concept-v0" });

      const first = await backfillKnowledgeEmbeddings({ businessIds: [business.businessId] });
      expect(first[0]).toMatchObject({ status: "done", result: { examined: 3, current: 0, queued: 3, enqueueFailed: 0 } });

      await fakeQueue.__drainForTests(); // the existing index-knowledge-entry handler
      for (const entry of entries) {
        const stored = readStoredEmbedding(await readMetadata(business.ctx, entry.id));
        expect(stored!.index).toMatchObject({
          provider: "fake-concept",
          model: "fake-concept-v1",
          contentHash: knowledgeContentHash({ title: entry.title, content: entry.content }),
        });
      }

      const embedCalls = provider.requests.length;
      const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
      const second = await backfillKnowledgeEmbeddings({ businessIds: [business.businessId] });
      await fakeQueue.__drainForTests();
      expect(second[0]).toMatchObject({ status: "done", result: { examined: 3, current: 3, queued: 0 } });
      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(provider.requests.length).toBe(embedCalls);
    } finally {
      await cleanupBusiness(business.businessId);
    }
  });

  it("running the scan twice before the worker runs is harmless: the entry is embedded once", async () => {
    const entry = await preFeatureEntry(businessA.ctx, "Twice", "Dogs twice.");
    const before = providerA.successes;
    await enqueueKnowledgeReindex(businessA.ctx);
    await enqueueKnowledgeReindex(businessA.ctx);
    await fakeQueue.__drainForTests();
    expect(readStoredEmbedding(await readMetadata(businessA.ctx, entry.id))).not.toBeNull();
    // Other stale entries in A may be embedded too; this entry's text was embedded exactly once.
    expect(providerA.requests.filter((t) => t === "Twice\nDogs twice.")).toHaveLength(1);
    expect(providerA.successes).toBeGreaterThan(before);
  });

  it("on the real pg-boss queue, a repeated enqueue for an entry still waiting joins the queued job instead of adding another", async () => {
    const queue = new PgBossJobQueue(process.env.DATABASE_URL!); // enqueue-only: no worker started
    try {
      const entryId = crypto.randomUUID();
      const key = knowledgeIndexJobKey(businessA.businessId, entryId);
      const first = await queue.enqueue(INDEX_KNOWLEDGE_ENTRY_JOB, { businessId: businessA.businessId, entryId }, { singletonKey: key });
      const second = await queue.enqueue(INDEX_KNOWLEDGE_ENTRY_JOB, { businessId: businessA.businessId, entryId }, { singletonKey: key });
      expect(second).toBe(first);
      const { prisma } = await import("@/lib/prisma/raw-client");
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM pgboss.job WHERE name = $1 AND singleton_key = $2`,
        INDEX_KNOWLEDGE_ENTRY_JOB,
        key
      );
      expect(Number(rows[0].n)).toBe(1);
      await prisma.$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2`, INDEX_KNOWLEDGE_ENTRY_JOB, key);
    } finally {
      await queue.stop();
    }
  });
});

describe("settings changes use the shared scan", () => {
  it("saving embedding settings queues only stale entries, never ones already current", async () => {
    const stale = await preFeatureEntry(businessB.ctx, "B stale", "Beta parcel courier.");
    const fresh = await preFeatureEntry(businessB.ctx, "B fresh", "Beta weekend hours.");
    await indexKnowledgeEntry(businessB.ctx, fresh.id);

    const enqueueSpy = vi.spyOn(jobQueue, "enqueue");
    const { PUT } = await import("@/app/api/settings/ai/route");
    const response = await PUT(
      createRequest("/api/settings/ai", {
        method: "PUT",
        body: { embeddingProvider: "openai", embeddingApiKey: "sk-reindex-b" },
        cookies: { "owly-token": generateToken(businessB.ownerUserId) },
      })
    );
    expect(response.status).toBe(200);
    const queued = queuedEntryIds(enqueueSpy);
    expect(queued).toContain(stale.id);
    expect(queued).not.toContain(fresh.id);
  });
});
