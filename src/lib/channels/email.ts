import Imap from "imap";
import { simpleParser, ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import { logger } from "@/lib/observability/logger";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { escapeHtml, sanitizeEmailSubject } from "@/lib/security";
import { resolveChannelCredential } from "@/lib/identity/channel-credential-auth";
import { EmailCredentialSchema, type ChannelCredential } from "@/lib/secrets";
import { buildMessageReceivedEvent } from "@/lib/events/types";
import { registerInboundEvent } from "@/lib/events/inbound-receipt";
import { enqueueInboundProcessing } from "@/lib/events/dispatch";
import type { ChannelAdapter, ChannelStatus, OutboundContent, SendResult, ValidateInboundResult } from "./types";
import { registerChannelAdapter } from "./registry";
import type { TenantContext } from "@/lib/tenancy/context";

type EmailCredential = Extract<ChannelCredential, { type: "email" }>;

/**
 * PLAN.md §19.2/§46.5 — like WhatsApp-Web (`whatsapp.ts`), the IMAP
 * listener is a single, shared, process-global connection with no HTTP
 * webhook to verify or ACK — `connect()`/`disconnect()` (§19.1's session-
 * based channel methods) replace `startEmailListener`/`stopEmailListener`,
 * and `sessionOwner` replaces the old implicit `getDefaultBusinessContext()`
 * call: whichever business's `ChannelConnection` actually called `connect()`
 * is what this process's one listener serves, explicitly, instead of being
 * hardcoded to the Default Business. Dedup key: the email `Message-ID`
 * header (§17.4/§19.2 — stable and provider-independent).
 */
let imapConnection: Imap | null = null;
let isListening = false;
let sessionOwner: { ctx: TenantContext; connectionId: string; credential: EmailCredential } | null = null;

function createImapConnection(credential: EmailCredential): Imap {
  return new Imap({
    user: credential.imapUser!,
    password: credential.imapPass!,
    host: credential.imapHost!,
    port: credential.imapPort!,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  });
}

function getSmtpTransporter(credential: EmailCredential) {
  return nodemailer.createTransport({
    host: credential.smtpHost,
    port: credential.smtpPort,
    secure: credential.smtpPort === 465,
    auth: { user: credential.smtpUser, pass: credential.smtpPass },
  });
}

interface EmailBranding {
  businessName: string;
}

async function getEmailBranding(ctx: TenantContext): Promise<EmailBranding> {
  const db = getScopedPrisma(ctx);
  const config = await db.businessConfig.findUnique({ where: { businessId: ctx.businessId }, select: { businessName: true } });
  return { businessName: config?.businessName || "Support" };
}

function buildEmailHtml(text: string, branding?: EmailBranding): string {
  const name = branding?.businessName || "Support";
  const color = "#0F172A";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F8FAFC;">
    <tr><td align="center" style="padding:24px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr><td style="background-color:${escapeHtml(color)};padding:20px 24px;">
          <h1 style="margin:0;font-size:18px;font-weight:600;color:#FFFFFF;">${escapeHtml(name)}</h1>
        </td></tr>
        <tr><td style="padding:24px;">
          ${text
            .split("\n")
            .map((line) => `<p style="margin:0 0 12px 0;font-size:15px;line-height:1.6;color:#334155;">${escapeHtml(line)}</p>`)
            .join("")}
        </td></tr>
        <tr><td style="border-top:1px solid #E2E8F0;padding:16px 24px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#94A3B8;">${escapeHtml(name)} &middot; Powered by Owly</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function handleParsedEmail(parsed: ParsedMail): Promise<void> {
  if (!sessionOwner) return;

  const result = await emailAdapter.validateInbound(parsed);
  if (result.kind === "rejected") {
    logger.warn("[Email] Inbound message rejected", { reason: result.reason });
    return;
  }
  if (result.kind === "duplicate") return;

  await enqueueInboundProcessing(result.ctx, result.receiptId, result.event);
}

export async function startEmailListener(ctx: TenantContext, connectionId: string): Promise<void> {
  if (isListening) return;

  const credential = await resolveChannelCredential(connectionId, EmailCredentialSchema);
  if (!credential?.imapHost || !credential.imapUser || !credential.imapPass || !credential.imapPort) {
    logger.info("[Email] Not configured (no IMAP credential), skipping listener start");
    return;
  }

  sessionOwner = { ctx, connectionId, credential };
  const imap = createImapConnection(credential);

  imap.once("ready", () => {
    logger.info("[Email] IMAP connected");
    isListening = true;
    updateConnectionStatus(ctx, connectionId, true, "connected");

    imap.openBox("INBOX", false, (err) => {
      if (err) {
        logger.error("[Email] Error opening inbox:", err);
        return;
      }

      imap.on("mail", () => {
        imap.search(["UNSEEN"], (err, results) => {
          if (err || !results.length) return;

          const fetch = imap.fetch(results, { bodies: "" });
          fetch.on("message", (msg) => {
            msg.on("body", (stream) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              simpleParser(stream as any, (err: Error | null, parsed: ParsedMail) => {
                if (err) {
                  logger.error("[Email] Parse error:", err);
                  return;
                }
                handleParsedEmail(parsed).catch((e) => logger.error("[Email] Failed to process email:", e));
              });
            });
          });
        });
      });
    });
  });

  imap.once("error", (err: Error) => {
    logger.error("[Email] IMAP error:", err);
    isListening = false;
    updateConnectionStatus(ctx, connectionId, false, "error");
  });

  imap.once("end", () => {
    logger.info("[Email] IMAP disconnected");
    isListening = false;
    updateConnectionStatus(ctx, connectionId, false, "disconnected");
  });

  imapConnection = imap;
  imap.connect();
}

function updateConnectionStatus(ctx: TenantContext, connectionId: string, isActive: boolean, status: string): void {
  const db = getScopedPrisma(ctx);
  db.channelConnection
    .update({ where: { id: connectionId }, data: { isActive, status } })
    .catch((error) => logger.error("[Email] Failed to update ChannelConnection status:", error));
}

/**
 * Only tears down the listener if the caller's own connection is the one
 * that actually owns it — since this is one shared, process-global
 * listener (§19.2), without this check any business could disconnect
 * *another* business's active email session simply by calling this with
 * their own (different) connectionId.
 */
export async function stopEmailListener(connectionId?: string): Promise<void> {
  if (connectionId && sessionOwner && sessionOwner.connectionId !== connectionId) {
    return;
  }

  if (imapConnection) {
    imapConnection.end();
    imapConnection = null;
    isListening = false;
  }
  if (sessionOwner) {
    updateConnectionStatus(sessionOwner.ctx, sessionOwner.connectionId, false, "disconnected");
  }
  sessionOwner = null;
}

export function getEmailStatus() {
  return {
    connected: isListening,
    status: isListening ? "connected" : "disconnected",
  };
}

export class EmailAdapter implements ChannelAdapter<ParsedMail> {
  readonly type = "email";
  readonly capabilities = {
    supportsMedia: false,
    supportsTemplates: false,
    supportsTypingIndicator: false,
    supportsDeliveryReceipts: false,
    supportsMultipleConnections: true,
  };

  async validateInbound(parsed: ParsedMail): Promise<ValidateInboundResult> {
    if (!sessionOwner) return { kind: "rejected", reason: "No active email listener session" };
    const { ctx, connectionId } = sessionOwner;

    const fromAddress = parsed.from?.value?.[0]?.address;
    if (!fromAddress) return { kind: "rejected", reason: "No From address" };

    const fromName = parsed.from?.value?.[0]?.name || fromAddress;
    const subject = parsed.subject || "No Subject";
    const textBody = parsed.text || "";
    // A Message-ID is standard but not RFC-mandated — fall back to a
    // deterministic hash of (from, subject, a coarse time bucket) per
    // §17.4's own documented fallback-heuristic allowance.
    const externalId =
      parsed.messageId ||
      `${fromAddress}:${subject}:${Math.floor((parsed.date?.getTime() ?? Date.now()) / 60000)}`;

    const event = buildMessageReceivedEvent({
      businessId: ctx.businessId,
      channel: "email",
      connectionId,
      externalId,
      payload: { text: `Subject: ${subject}\n\n${textBody}`, customerName: fromName, customerContact: fromAddress },
      metadata: { subject, messageId: parsed.messageId },
    });

    const registration = await registerInboundEvent(ctx, {
      source: "email",
      externalEventId: externalId,
      eventType: event.type,
      correlationId: event.correlationId,
      event,
    });

    if (registration.isDuplicate) return { kind: "duplicate" };

    return { kind: "new", ctx, connectionId, event, receiptId: registration.receiptId };
  }

  async sendMessage(ctx: TenantContext, connectionId: string, to: string, content: OutboundContent): Promise<SendResult> {
    const credential = await resolveChannelCredential(connectionId, EmailCredentialSchema);
    if (!credential) return { success: false, error: "Connection has no valid email credential" };

    const subject = (content.metadata?.subject as string | undefined) || "Message from support";
    const inReplyTo = content.metadata?.messageId as string | undefined;

    try {
      const branding = await getEmailBranding(ctx);
      const transporter = getSmtpTransporter(credential);
      await transporter.sendMail({
        from: credential.smtpFrom,
        to,
        subject: sanitizeEmailSubject(inReplyTo ? `Re: ${subject}` : subject),
        text: content.text,
        html: buildEmailHtml(content.text, branding),
        ...(inReplyTo && { inReplyTo, references: inReplyTo }),
      });
      return { success: true };
    } catch (error) {
      logger.error("[EmailAdapter] Failed to send message:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }

  async getStatus(ctx: TenantContext, connectionId: string): Promise<ChannelStatus> {
    const db = getScopedPrisma(ctx);
    const connection = await db.channelConnection.findUnique({ where: { id: connectionId } });
    if (!connection?.isActive || !connection.credentialRef) {
      return { connected: false, detail: "Not configured" };
    }
    return { connected: isListening && sessionOwner?.connectionId === connectionId };
  }

  async connect(ctx: TenantContext, connectionId: string): Promise<void> {
    await startEmailListener(ctx, connectionId);
  }

  async disconnect(_ctx: TenantContext, connectionId: string): Promise<void> {
    await stopEmailListener(connectionId);
  }
}

export const emailAdapter = new EmailAdapter();
registerChannelAdapter("email", emailAdapter);
