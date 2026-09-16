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

export const MetaWhatsAppCredentialSchema = z.object({
  type: z.literal("whatsapp"),
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
