import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §46.3 (Phase 3) / §19.1 — module-boundary sketch, not a frozen
 * contract. Per review concern 22, Phase 3 fixes only this contract's
 * module location (`channels/`) and dependency direction (a ChannelAdapter
 * implementation may depend on `events/`/`identity/`, per §6's table, but
 * never on `ai/` — enforced by eslint.config.mjs's `channels/` boundary
 * rule). The exact shape below — particularly `validateInbound`'s return
 * type — is explicitly expected to change once Phase 5 (§46.5) implements
 * it against a real provider (§19.1's own note).
 *
 * No implementation exists yet. Today's five channel files
 * (`email.ts`/`phone.ts`/`sms.ts`/`telegram.ts`/`whatsapp.ts`) still call
 * `ai/engine.ts`'s `chat()` directly rather than emitting a normalized
 * event — a documented, allowlisted exception (see both this file's sibling
 * comments and eslint.config.mjs) until Phase 5 gives them this contract
 * and the `events/` envelope to publish through.
 */

export interface ChannelCapabilities {
  supportsMedia: boolean;
  supportsTemplates: boolean;
  supportsTypingIndicator: boolean;
  supportsDeliveryReceipts: boolean;
  supportsMultipleConnections: boolean;
}

export interface ChannelStatus {
  connected: boolean;
  detail?: string;
}

/** Illustrative only (§19.1) — finalized in Phase 5 against a real second channel provider. */
export interface ChannelAdapter {
  readonly type: string;
  readonly capabilities: ChannelCapabilities;
  sendMessage(ctx: TenantContext, connectionId: string, to: string, content: string): Promise<void>;
  getStatus(ctx: TenantContext, connectionId: string): Promise<ChannelStatus>;
}
