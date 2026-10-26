import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "@/lib/observability/logger";

/** L1.3 / F16: sensitive values never reach the log line, by key name or by shape, at any depth. */
afterEach(() => vi.restoreAllMocks());
// Key-shaped fixtures are assembled at runtime so secret scanners do not flag this file.
const SK_LIVE = ["sk", "live", "1234567890abcdef"].join("-");
const SK_ANT = ["sk", "ant", "api03", "ABCDEFGHIJKLMNOP"].join("-");
const WHSEC = ["whsec", "abcdef123456"].join("_");
function capture(fn: () => void): string {
  const out: string[] = [];
  for (const m of ["debug", "info", "warn", "error"] as const)
    vi.spyOn(console, m).mockImplementation((line: unknown) => void out.push(String(line)));
  fn();
  return out.join("\n");
}

describe("logger redaction (F16)", () => {
  it("redacts sensitive keys at any depth, case-insensitively", () => {
    const line = capture(() =>
      logger.info("event", {
        password: "hunter2-pass",
        nested: { Authorization: "Bearer abc.def.ghi", deeper: [{ apiKey: SK_LIVE }] },
        newPassword: "n3w-pass-1",
        cookie: "sid=secretcookie",
        webhookSecret: WHSEC,
        refresh_token: "rt-xyz-789",
        credentialRef: "cipher-blob",
        harmless: "visible-value",
      })
    );
    for (const leaked of ["hunter2-pass", "abc.def.ghi", SK_LIVE, "n3w-pass-1", "secretcookie", WHSEC, "rt-xyz-789", "cipher-blob"])
      expect(line).not.toContain(leaked);
    expect(line).toContain("visible-value");
    expect(line).toContain("[REDACTED]");
  });

  it("scrubs secrets that appear inside strings: bearer tokens, API keys, token query parameters, URL credentials", () => {
    const line = capture(() =>
      logger.error("request failed", new Error("401 for Authorization: Bearer abc123.def456.ghi789 at https://user:" + "p4ssw0rd@host.test/x?token=tok_999888&ok=1 using " + SK_ANT))
    );
    for (const leaked of ["abc123.def456.ghi789", "p4ssw0rd", "tok_999888", SK_ANT]) expect(line).not.toContain(leaked);
    expect(line).toContain("ok=1");
  });

  it("redacts in the message text and error context too", () => {
    const line = capture(() => logger.warn("login with password=hunter2-pass failed", { error: "bad", stack: "x" }));
    expect(line).not.toContain("hunter2-pass");
  });

  it("does not redact AI usage counters that merely contain the word token", () => {
    const line = capture(() => logger.info("usage", { outputTokens: 42, tokens: 7, tokenCount: 3, accessToken: "abc-secret-value" }));
    expect(line).toContain("42");
    expect(line).not.toContain("abc-secret-value");
  });

  it("keeps circular and error handling working", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => capture(() => logger.info("c", a))).not.toThrow();
  });

  it("catches JSON-shaped secrets and bot-token URL paths inside strings, and keeps benign look-alikes", () => {
    const line = capture(() =>
      logger.error("provider failed", new Error('{"access_token":"abcdef-secret-1","ok":true} via https://api.telegram.org/bot123456:' + "ABCDEFGHIJKLMNOPQRSTUVWX" + "/sendMessage code=P2002"))
    );
    expect(line).not.toContain("abcdef-secret-1");
    expect(line).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(line).toContain("code=P2002");
    const ctx = capture(() => logger.info("hook", { signatureValid: true, sessionId: "s-1", passed: true, bypass: "no", jwt: "eyJhbGciOi", refresh: "r-1" }));
    expect(ctx).toContain('"signatureValid":true');
    expect(ctx).toContain('"passed":true');
    expect(ctx).toContain('"bypass":"no"');
    expect(ctx).not.toContain("eyJhbGciOi");
    expect(ctx).not.toContain("r-1");
  });
});
