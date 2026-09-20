import type { TenantContext } from "@/lib/tenancy/context";
import type { ZiyrakEvent, MessageReceivedPayload } from "@/lib/events/types";

/**
 * PLAN.md §46.5/§19.1 — the `ChannelAdapter` contract, finalized in this
 * phase against six real implementations (§46.3's own deferral: "the exact
 * shape below ... is explicitly expected to change once Phase 5 implements
 * it against a real provider"). Module location/dependency direction were
 * fixed in Phase 3 and are unchanged: a `ChannelAdapter` implementation may
 * depend on `events/`/`identity/` (credential lookup) but never `ai/`
 * (enforced by `eslint.config.mjs`'s `channels/` boundary rule, with the
 * temporary five-file allowlist this phase removes once every adapter is
 * migrated).
 *
 * One deliberate refinement over §19.1's illustrative sketch:
 * `validateInbound`'s request parameter is generic per adapter
 * (`TInboundRequest`) rather than one shared shape, because "an inbound
 * HTTP webhook body" (SMS/Phone/Telegram/WebChat) and "a whatsapp-web.js
 * `Message` event object" / "a `mailparser` `ParsedMail`" (WhatsApp-Web,
 * Email — neither has an HTTP request at all) are not the same kind of
 * thing, and forcing them into one shape would mean lying about one side
 * or the other. What's fixed, per §19.1's own point, is the *return*
 * type's three-way shape (dedup folded in) and that every method carries
 * an explicit `connectionId` (§7.7).
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

export interface OutboundContent {
  text: string;
  /** Carries the originating event's own `metadata` through to delivery (e.g. email's `subject`/`Message-ID` for threading) — most channels ignore it. */
  metadata?: Record<string, unknown>;
}

export interface SendResult {
  success: boolean;
  error?: string;
}

/** The provider-agnostic shape a webhook route hands an HTTP-based adapter (SMS, Phone, Telegram, WebChat). */
export interface NormalizedInboundRequest {
  /** Lower-cased header names, matching `Headers`/`NextRequest.headers` iteration. */
  headers: Record<string, string>;
  /** Dynamic route segments the webhook route itself parsed (e.g. `connectionId`). */
  routeParams: Record<string, string>;
  /** `application/x-www-form-urlencoded` body (Twilio). */
  formParams?: Record<string, string>;
  /** Parsed `application/json` body (Telegram, WebChat). */
  json?: unknown;
  /** Full request URL, needed for Twilio's signature computation. */
  url: string;
}

export type ValidateInboundResult =
  | { kind: "new"; ctx: TenantContext; connectionId: string; event: ZiyrakEvent<MessageReceivedPayload>; receiptId: string }
  | { kind: "duplicate" }
  | { kind: "rejected"; reason: string };

export interface ChannelAdapter<TInboundRequest = NormalizedInboundRequest> {
  readonly type: string;
  readonly capabilities: ChannelCapabilities;

  /**
   * Verifies the request (signature/widget token), resolves the owning
   * `ChannelConnection`/business, and performs `InboundEventReceipt` dedup
   * (§17.4) — in that order, so a forged request never reaches the dedup
   * check. Returns the normalized event on success, `"duplicate"` if this
   * exact provider event was already seen, or `"rejected"` if the request
   * doesn't verify or resolves to no known connection. The caller (the
   * webhook route) ACKs the provider in every case — only `"new"` goes on
   * to `persistAndEnqueueInboundEvent`/`processInboundMessage`.
   */
  validateInbound(request: TInboundRequest): Promise<ValidateInboundResult>;
  sendMessage(ctx: TenantContext, connectionId: string, to: string, content: OutboundContent): Promise<SendResult>;
  getStatus(ctx: TenantContext, connectionId: string): Promise<ChannelStatus>;
  /** Only for session-based channels (WhatsApp Web). Stateless HTTP channels don't implement this — they are "always connected" once credentials exist. */
  connect?(ctx: TenantContext, connectionId: string): Promise<void>;
  disconnect?(ctx: TenantContext, connectionId: string): Promise<void>;
}
