import { describe, it, expect } from "vitest";
import { ChannelCredentialSchema } from "@/lib/secrets/credential-schemas";

describe("ChannelCredentialSchema", () => {
  it("accepts a valid WhatsApp (Meta Cloud API) credential", () => {
    const result = ChannelCredentialSchema.safeParse({
      type: "whatsapp",
      phoneNumberId: "123",
      accessToken: "token",
      businessAccountId: "456",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid Twilio credential for both sms and phone", () => {
    for (const type of ["sms", "phone"] as const) {
      const result = ChannelCredentialSchema.safeParse({
        type,
        accountSid: "AC123",
        authToken: "token",
        phoneNumber: "+15550001111",
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts a valid Telegram credential", () => {
    const result = ChannelCredentialSchema.safeParse({
      type: "telegram",
      botToken: "bot-token",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid Email credential with SMTP-only fields", () => {
    const result = ChannelCredentialSchema.safeParse({
      type: "email",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpUser: "user",
      smtpPass: "pass",
      smtpFrom: "support@example.com",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid WebChat widget credential", () => {
    const result = ChannelCredentialSchema.safeParse({
      type: "webchat",
      widgetSecret: "secret",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing a required field for its type", () => {
    const result = ChannelCredentialSchema.safeParse({
      type: "telegram",
      // missing botToken
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown channel type", () => {
    const result = ChannelCredentialSchema.safeParse({
      type: "carrier-pigeon",
      whatever: "value",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tampered/malformed payload rather than passing through undefined fields", () => {
    const result = ChannelCredentialSchema.safeParse({
      type: "email",
      smtpHost: "smtp.example.com",
      smtpPort: "not-a-number",
      smtpUser: "user",
      smtpPass: "pass",
      smtpFrom: "support@example.com",
    });
    expect(result.success).toBe(false);
  });
});
