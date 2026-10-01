/**
 * PLAN.md §25.3/§46.5/§46.6 — side-effect-only import: loading this module
 * registers every known job handler against the shared `jobQueue`
 * (`jobs/queue.ts`): "process-inbound-message" (`conversations/inbound.ts`),
 * "deliver-webhook" (`jobs/handlers/deliver-webhook.ts`),
 * "sweep-sla-breaches" and "sweep-retention" (`jobs/handlers/sweep-*.ts`)
 * as of this phase. `src/worker.ts` imports this same file for the same
 * reason, and is additionally what actually calls `scheduleRecurring()`
 * for the two sweeps (registering a handler and scheduling its recurrence
 * are separate steps — only the worker does the latter).
 *
 * Why this exists at all: `jobQueue.registerHandler()` runs at each
 * handler module's own load time, but nothing about importing
 * `events/dispatch.ts`'s `enqueueInboundProcessing()` — what every channel
 * webhook route actually calls — otherwise guarantees that module has been
 * loaded first. Without this, whichever webhook happens to receive the
 * *first* request against a freshly started process would hit
 * `FakeJobQueue`'s (and `PgBossJobQueue`'s) "no handler registered" error.
 * `events/dispatch.ts` imports this file for its side effect, so every
 * caller of `enqueueInboundProcessing()` transitively guarantees
 * registration without each of the six channel adapters needing its own
 * explicit import (and without `events/` gaining a real, structural
 * dependency on `conversations/` — only `jobs/bootstrap.ts` does).
 *
 * Deliberately does NOT also import the channel adapter modules
 * (`channels/bootstrap.ts` handles that, separately) — `channels/email.ts`/
 * `channels/whatsapp.ts` both import `events/dispatch.ts`, which imports
 * *this* file, so adding them here would create a real import cycle
 * (`jobs/bootstrap` → `channels/email` → `events/dispatch` →
 * `jobs/bootstrap`). `channels/bootstrap.ts` has no such back-edge.
 */
import "@/lib/conversations/inbound";
import "@/lib/jobs/handlers/deliver-webhook";
import "@/lib/jobs/handlers/sweep-sla-breaches";
import "@/lib/jobs/handlers/sweep-retention";
import "@/lib/jobs/handlers/send-followup";
import "@/lib/jobs/handlers/execute-campaign";
import "@/lib/jobs/handlers/index-knowledge-entry";
