import { describe, it, expect } from "vitest";
import { generateTotpSecret, base32Encode, base32Decode, totpAt, verifyTotp, otpauthUri } from "@/lib/identity/totp";

/** L1.3 MFA: RFC 4226/6238 conformance and verification behaviour. */
const ascii = (s: string) => Buffer.from(s, "ascii");

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 appendix B, SHA1, 8 digits, secret "12345678901234567890".
  const secret = ascii("12345678901234567890");
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  it.each(vectors)("matches the RFC test vector at t=%i", (t, expected) => {
    expect(totpAt(secret, t * 1000, { digits: 8 })).toBe(expected);
  });

  it("round-trips base32", () => {
    const raw = Buffer.from("00ff10abcdef", "hex");
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
    expect(base32Encode(ascii("12345678901234567890"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("generates a 160-bit secret that differs each time", () => {
    const a = generateTotpSecret();
    expect(a.length).toBe(20);
    expect(generateTotpSecret().equals(a)).toBe(false);
  });

  it("accepts the current and adjacent step, rejects further drift and malformed codes", () => {
    const now = 1_700_000_000_000;
    const code = totpAt(secret, now);
    expect(verifyTotp(secret, code, now)).toEqual({ ok: true, step: Math.floor(now / 30000) });
    expect(verifyTotp(secret, totpAt(secret, now - 30000), now).ok).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now + 30000), now).ok).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 90000), now).ok).toBe(false);
    for (const bad of ["", "12345", "1234567", "abcdef", " 123456", "12345 6"]) expect(verifyTotp(secret, bad, now).ok).toBe(false);
  });

  it("refuses to accept a step that was already used (replay)", () => {
    const now = 1_700_000_000_000;
    const first = verifyTotp(secret, totpAt(secret, now), now);
    expect(first.ok).toBe(true);
    if (first.ok) expect(verifyTotp(secret, totpAt(secret, now), now, { afterStep: first.step }).ok).toBe(false);
  });

  it("builds an otpauth URI that names the issuer and account", () => {
    const uri = otpauthUri({ secret: ascii("12345678901234567890"), account: "op@example.test", issuer: "Ziyrak" });
    expect(uri).toBe("otpauth://totp/Ziyrak:op%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Ziyrak&algorithm=SHA1&digits=6&period=30");
  });
});
