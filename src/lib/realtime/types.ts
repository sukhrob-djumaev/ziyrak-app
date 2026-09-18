/**
 * PLAN.md §46.3 (Phase 3) / §26.1 — module-boundary sketch, not a frozen
 * contract. Per review concern 22, Phase 3 fixes only this contract's
 * module location (`realtime/`, absorbing today's `realtime.ts` pub/sub
 * role — §6) and that it depends on nothing else in this codebase. The
 * event payload here is left generic (`T`) rather than typed against
 * `ZiyrakEvent` (§17.1), since that envelope is Phase 5 scope (§46.5) and
 * this phase must not pre-specify it (§46.3's own principle). `publish` is
 * explicitly best-effort (§17.3) — never on the critical path for a
 * business action actually happening.
 *
 * `realtime.ts` (moved to this module unchanged in this phase) already
 * implements this shape's spirit with tenant-prefixed channel names
 * (§26.2, `tenantGlobalChannel`/`tenantConversationChannel`) — wiring its
 * existing functions behind this literal interface is left to whichever
 * phase first needs more than one `RealtimeBus` implementation (Phase 8,
 * `RedisRealtimeBus`), per Principle 2 (§4).
 */
export interface RealtimeBus<T = unknown> {
  publish(channel: string, event: T): Promise<void>;
  subscribe(channel: string, callback: (event: T) => void): () => void;
}
