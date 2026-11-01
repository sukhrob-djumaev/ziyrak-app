import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe webhook signature check over the exact raw bytes (`t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`).
 * Pure and timing-safe; no database or rate-limit work happens before it succeeds. More than one secret is
 * accepted so a rotation does not drop events. The tolerance is the replay window.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signStripePayload(rawBody: Buffer, secret: string, now: Date): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody.toString("utf8")}`).digest("hex")}`;
}

export function verifyStripeSignature(rawBody: Buffer, header: string, secrets: string[], now: Date): { ok: true } | { ok: false; reason: string } {
  if (!header || secrets.length === 0) return { ok: false, reason: "missing" };
  let timestamp = NaN;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = Number(value);
    else if (key === "v1") candidates.push(value);
  }
  if (!Number.isInteger(timestamp) || candidates.length === 0) return { ok: false, reason: "malformed" };
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };
  const payload = `${timestamp}.${rawBody.toString("utf8")}`;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(payload).digest();
    for (const candidate of candidates) {
      const given = /^[0-9a-f]{64}$/i.test(candidate) ? Buffer.from(candidate, "hex") : null;
      if (given && given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
    }
  }
  return { ok: false, reason: "mismatch" };
}
