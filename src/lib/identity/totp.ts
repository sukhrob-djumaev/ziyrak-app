import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * L1.3: RFC 6238 time-based one-time passwords (HMAC-SHA1, 30 s steps, 6 digits - what authenticator apps
 * implement). Dependency-free and pure; storage, enrollment and rate limiting live in the callers.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;

export function generateTotpSecret(): Buffer {
  return randomBytes(20); // 160 bits, the RFC 4226 recommendation
}

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of text.replace(/=+$/, "").toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 input");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpAt(secret: Buffer, atMs: number, options: { digits?: number } = {}): string {
  return hotp(secret, Math.floor(atMs / 1000 / STEP_SECONDS), options.digits ?? 6);
}

export type TotpResult = { ok: true; step: number } | { ok: false };

/**
 * Accepts the current step and one either side (clock drift). `afterStep` is the last step already consumed for
 * this account: a code at or before it is refused, so an observed code cannot be replayed within its window.
 */
export function verifyTotp(secret: Buffer, code: string, atMs: number, options: { afterStep?: number } = {}): TotpResult {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return { ok: false };
  const current = Math.floor(atMs / 1000 / STEP_SECONDS);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(hotp(secret, step, 6));
    if (timingSafeEqual(expected, Buffer.from(code)) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false };
  if (options.afterStep !== undefined && matched <= options.afterStep) return { ok: false };
  return { ok: true, step: matched };
}

export function otpauthUri(input: { secret: Buffer; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(input.secret)}&issuer=${encodeURIComponent(input.issuer)}&algorithm=SHA1&digits=6&period=30`;
}
