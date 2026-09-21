import crypto from "crypto";

/**
 * Validates Meta's `X-Hub-Signature-256` webhook header (PLAN.md §20.2/
 * §46.7): `sha256=<hex HMAC-SHA256 of the raw request body, keyed by the
 * Meta App's own App Secret>`. Verified against the *raw* body bytes, never
 * a re-serialized `JSON.stringify` of the parsed payload — Meta computes the
 * signature over exactly what it sent on the wire, and re-serializing JSON
 * is not guaranteed to reproduce byte-identical output (key order, spacing).
 */
export function validateMetaSignature(appSecret: string, signatureHeader: string, rawBody: string): boolean {
  if (!appSecret || !signatureHeader) return false;

  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const presented = signatureHeader.slice(prefix.length);

  const computed = crypto.createHmac("sha256", appSecret).update(rawBody, "utf-8").digest("hex");

  const computedBuf = Buffer.from(computed, "hex");
  const presentedBuf = Buffer.from(presented, "hex");
  if (computedBuf.length !== presentedBuf.length) return false;

  return crypto.timingSafeEqual(computedBuf, presentedBuf);
}

/**
 * The Meta App's own platform-level secrets (§20.2 — one Ziyrak-owned Meta
 * App/webhook subscription shared by every tenant's phone numbers, distinct
 * from each business's own per-`ChannelConnection` `phoneNumberId`/
 * `accessToken`). Read lazily (not at module load) so importing this module
 * in a test/dev environment without either var set doesn't throw until the
 * webhook route actually needs one.
 */
export function getMetaAppSecret(): string | undefined {
  return process.env.META_APP_SECRET || undefined;
}

export function getMetaWebhookVerifyToken(): string | undefined {
  return process.env.META_WEBHOOK_VERIFY_TOKEN || undefined;
}
