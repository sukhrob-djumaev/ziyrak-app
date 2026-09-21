import { z } from "zod";

/**
 * Typed, per-provider credential schemas (PLAN.md §10.3(a)). A decrypted
 * ChannelConnection credential is validated against one of these before any
 * channel adapter is allowed to use it — encryption is never a substitute for
 * validation, so a malformed or tampered payload fails closed with a clear
 * error instead of an `undefined` deep inside an adapter.
 *
 * Keyed by the same channel `type` string ChannelConnection.type uses.
 */

// PLAN.md §20.2/§46.7 — Meta Cloud WhatsApp is a distinct ChannelConnection
// type ("whatsapp_cloud"), never "whatsapp" (WhatsAppWebAdapter's dev/demo-
// only type string, §20.1) — the two are two different adapters behind the
// same ChannelAdapter contract (§19.1), not two credential shapes for one
// type. This schema had zero call sites before this phase (grep-confirmed),
// so retyping its literal is a non-breaking correction of a scaffolded-but-
// unwired type, not a migration. `phoneNumberId`/`accessToken`/
// `businessAccountId` are per-ChannelConnection (a business's own system-user
// token, scoped to its own WABA/phone number) — the App Secret used for
// `X-Hub-Signature-256` verification and the webhook verify token are
// platform-level (one Ziyrak-owned Meta App shared by every tenant, §20.2's
// "one shared Ziyrak-owned webhook URL"), so they are read from env vars
// (`META_APP_SECRET`/`META_WEBHOOK_VERIFY_TOKEN`) rather than stored here.
export const MetaWhatsAppCredentialSchema = z.object({
  type: z.literal("whatsapp_cloud"),
  phoneNumberId: z.string().min(1),
  accessToken: z.string().min(1),
  businessAccountId: z.string().min(1),
});

export const TwilioCredentialSchema = z.object({
  type: z.enum(["sms", "phone"]),
  accountSid: z.string().min(1),
  authToken: z.string().min(1),
  phoneNumber: z.string().min(1),
});

export const TelegramCredentialSchema = z.object({
  type: z.literal("telegram"),
  botToken: z.string().min(1),
  // PLAN.md §19.2/§32/§46.5 — Telegram has no built-in webhook signature
  // scheme; `setWebhook`'s own `secret_token` parameter is the closest
  // equivalent. Optional because a connection can exist before its webhook
  // is (re-)registered, but TelegramAdapter.validateInbound() requires it
  // to be set before honoring any inbound update.
  secretToken: z.string().min(1).optional(),
});

export const EmailCredentialSchema = z.object({
  type: z.literal("email"),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().positive(),
  smtpUser: z.string().min(1),
  smtpPass: z.string().min(1),
  smtpFrom: z.string().min(1),
  imapHost: z.string().min(1).optional(),
  imapPort: z.number().int().positive().optional(),
  imapUser: z.string().min(1).optional(),
  imapPass: z.string().min(1).optional(),
});

export const WebChatWidgetCredentialSchema = z.object({
  type: z.literal("webchat"),
  widgetSecret: z.string().min(1),
});

export const ChannelCredentialSchema = z.discriminatedUnion("type", [
  MetaWhatsAppCredentialSchema,
  TwilioCredentialSchema,
  TelegramCredentialSchema,
  EmailCredentialSchema,
  WebChatWidgetCredentialSchema,
]);

export type ChannelCredential = z.infer<typeof ChannelCredentialSchema>;
