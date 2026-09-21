/**
 * PLAN.md §19.3/§46.7 acceptance-audit finding — side-effect-only import
 * that registers every channel adapter (`registerChannelAdapter()`, each
 * adapter module's own bottom line) against the shared, in-memory
 * `channels/registry.ts` `Map`.
 *
 * Why this exists: every webhook route already imports its own adapter
 * directly (a side effect of handling that specific route at all), so a
 * *web* process ends up with at least the adapters its own inbound traffic
 * has touched registered. The standalone worker process (`src/worker.ts`)
 * never loads any webhook route at all — before this file existed,
 * `getChannelAdapter(event.source.channel)` inside `processInboundMessage`
 * (`conversations/inbound.ts`), called from the worker's own
 * `process-inbound-message` job handler, would silently return `undefined`
 * for every channel: the AI's reply would be generated and persisted, then
 * never actually sent back to the customer, with no error at all (`adapter
 * && to` in `processInboundMessage` is simply false). This file is imported
 * once, at process startup, by both `src/instrumentation.ts` (the web
 * process) and `src/worker.ts` (the worker process) so every adapter is
 * registered unconditionally in either process, regardless of which
 * channels that specific process's own traffic has touched.
 *
 * Deliberately separate from `jobs/bootstrap.ts` (which registers job
 * handlers, not channel adapters): `channels/email.ts`/`channels/
 * whatsapp.ts` both import `events/dispatch.ts`, which itself imports
 * `jobs/bootstrap.ts` — importing them *from* `jobs/bootstrap.ts` would
 * create a real import cycle. This file has no such back-edge, since
 * nothing importable from here imports `channels/bootstrap.ts` itself.
 */
import "@/lib/channels/sms-adapter";
import "@/lib/channels/telegram-adapter";
import "@/lib/channels/phone-adapter";
import "@/lib/channels/email";
import "@/lib/channels/whatsapp";
import "@/lib/channels/webchat-adapter";
import "@/lib/channels/meta-whatsapp-adapter";
