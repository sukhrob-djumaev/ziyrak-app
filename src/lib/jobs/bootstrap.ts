/**
 * PLAN.md §25.3/§46.5 — side-effect-only import: loading this module
 * registers every known job handler (currently just
 * "process-inbound-message", registered by `conversations/inbound.ts`)
 * against the shared `jobQueue` (`jobs/queue.ts`).
 *
 * Why this exists at all: `jobQueue.registerHandler()` runs at
 * `conversations/inbound.ts`'s module-load time, but nothing about
 * importing `events/dispatch.ts`'s `enqueueInboundProcessing()` — what
 * every channel webhook route actually calls — otherwise guarantees that
 * module has been loaded first. Without this, whichever webhook happens to
 * receive the *first* request against a freshly started process would hit
 * `FakeJobQueue`'s (and, later, `PgBossJobQueue`'s) "no handler registered"
 * error. `events/dispatch.ts` imports this file for its side effect, so
 * every caller of `enqueueInboundProcessing()` transitively guarantees
 * registration without each of the six channel adapters needing its own
 * explicit import (and without `events/` gaining a real, structural
 * dependency on `conversations/` — only `jobs/bootstrap.ts` does).
 */
import "@/lib/conversations/inbound";
