/**
 * Queue embedding (re)indexing for knowledge entries whose stored embedding is
 * missing or stale — PLAN.md §46.4 "Follow-up — stored entry embeddings".
 *
 *   npm run knowledge:reindex                       # every active business
 *   npm run knowledge:reindex -- --business <id>    # one business (repeatable)
 *
 * Needs DATABASE_URL and SECRET_KEY_V1 (it decrypts each business's embedding
 * credential to see which provider is current — the same values the worker
 * uses). It only enqueues `index-knowledge-entry` jobs; the worker
 * (`npm run worker`) does the embedding. Safe to rerun: entries that are
 * already current are not queued, and an entry already waiting in the queue
 * is not queued twice. Prints per-business counts; exits 1 if any business
 * errored or any job could not be enqueued.
 */
import "dotenv/config";
import { backfillKnowledgeEmbeddings } from "@/lib/knowledge/backfill";
import { jobQueue } from "@/lib/jobs/queue";
import { prisma } from "@/lib/prisma/raw-client";

function parseBusinessIds(argv: string[]): string[] | undefined {
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--business" && argv[i + 1]) ids.push(argv[++i]);
  }
  return ids.length ? ids : undefined;
}

async function main(): Promise<number> {
  const outcomes = await backfillKnowledgeEmbeddings({ businessIds: parseBusinessIds(process.argv.slice(2)) });
  let failed = false;
  for (const o of outcomes) {
    if (o.status === "done") {
      const r = o.result;
      console.log(
        `${o.businessId}: provider=${r.provider.name} (${r.provider.status}) examined=${r.examined} current=${r.current} queued=${r.queued} enqueueFailed=${r.enqueueFailed}`
      );
      if (r.enqueueFailed > 0) failed = true;
    } else if (o.status === "error") {
      console.log(`${o.businessId}: ERROR ${o.error}`);
      failed = true;
    } else {
      console.log(`${o.businessId}: not found or not active — skipped`);
    }
  }
  const totals = outcomes.reduce(
    (t, o) => (o.status === "done" ? { examined: t.examined + o.result.examined, current: t.current + o.result.current, queued: t.queued + o.result.queued } : t),
    { examined: 0, current: 0, queued: 0 }
  );
  console.log(`total: businesses=${outcomes.length} examined=${totals.examined} current=${totals.current} queued=${totals.queued}`);
  return failed ? 1 : 0;
}

main()
  .then(async (code) => {
    await jobQueue.stop();
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("knowledge reindex failed:", error instanceof Error ? error.message : error);
    await jobQueue.stop().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
