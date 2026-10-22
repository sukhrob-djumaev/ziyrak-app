import { appendFileSync } from "node:fs";
import nodemailer from "nodemailer";

/**
 * PLAN.md P3 — the platform's own transactional mail (verification, password
 * reset, invitations). Separate from per-workspace channel SMTP: a tenant
 * never configures or sees this transport. Three adapters:
 *  - capture: records messages (memory, plus a JSONL file when MAIL_CAPTURE_FILE
 *    is set so a browser journey can read what the web process "sent"); for
 *    tests and acceptance only, never selected in production by default;
 *  - smtp: real delivery from PLATFORM_SMTP_* environment variables;
 *  - unconfigured: every send fails loudly, so a missing mail setup is never
 *    mistaken for delivery.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  readonly kind: "capture" | "smtp" | "unconfigured";
  send(message: MailMessage): Promise<void>;
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super("Platform mail is not configured (set PLATFORM_SMTP_HOST, PLATFORM_SMTP_FROM, or MAIL_TRANSPORT=capture for tests).");
    this.name = "MailNotConfiguredError";
  }
}

export class CaptureMailTransport implements MailTransport {
  readonly kind = "capture" as const;
  readonly messages: (MailMessage & { at: string })[] = [];
  async send(message: MailMessage): Promise<void> {
    const entry = { ...message, at: new Date().toISOString() };
    this.messages.push(entry);
    const file = process.env.MAIL_CAPTURE_FILE;
    if (file) appendFileSync(file, JSON.stringify(entry) + "\n");
  }
}

class SmtpMailTransport implements MailTransport {
  readonly kind = "smtp" as const;
  async send(message: MailMessage): Promise<void> {
    const port = Number(process.env.PLATFORM_SMTP_PORT ?? 587);
    const transport = nodemailer.createTransport({
      host: process.env.PLATFORM_SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.PLATFORM_SMTP_USER
        ? { user: process.env.PLATFORM_SMTP_USER, pass: process.env.PLATFORM_SMTP_PASSWORD }
        : undefined,
    });
    await transport.sendMail({ from: process.env.PLATFORM_SMTP_FROM, to: message.to, subject: message.subject, text: message.text });
  }
}

class UnconfiguredMailTransport implements MailTransport {
  readonly kind = "unconfigured" as const;
  async send(): Promise<void> {
    throw new MailNotConfiguredError();
  }
}

let override: MailTransport | null = null;
let capture: CaptureMailTransport | null = null;

/** Tests may pin a transport; pass null to restore environment selection. */
export function setMailTransportForTesting(transport: MailTransport | null): void {
  override = transport;
}

export function getMailTransport(): MailTransport {
  if (override) return override;
  const selected = process.env.MAIL_TRANSPORT ?? (process.env.NODE_ENV === "test" ? "capture" : "");
  if (selected === "capture") return (capture ??= new CaptureMailTransport());
  if (selected === "smtp" || (selected === "" && process.env.PLATFORM_SMTP_HOST && process.env.PLATFORM_SMTP_FROM)) {
    if (!process.env.PLATFORM_SMTP_HOST || !process.env.PLATFORM_SMTP_FROM) return new UnconfiguredMailTransport();
    return new SmtpMailTransport();
  }
  return new UnconfiguredMailTransport();
}
