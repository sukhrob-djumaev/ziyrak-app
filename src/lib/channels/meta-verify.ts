import crypto from "crypto";

/**
 * Validates Meta's `X-Hub-Signature-256` webhook header (PLAN.md §20.2/
 * §46.7): `sha256=<hex HMAC-SHA256 of the raw request body, keyed by the
 * Meta App's own App Secret>`. Verified against the *raw* body bytes, never
 * a re-serialized `JSON.stringify` of the parsed payload — Meta computes the
 * signature over exactly what it sent on the wire, and re-serializing JSON
 * is not guaranteed to reproduce byte-identical output (key order, spacing).
 */
export function validateMetaSignature(appSecret: string, signatureHeader: string, rawBody: crypto.BinaryLike): boolean {
  if (!appSecret || !signatureHeader) return false;

  if (!/^sha256=[0-9a-f]{64}$/i.test(signatureHeader)) return false;
  const presented = signatureHeader.slice("sha256=".length);

  const computed = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  const computedBuf = Buffer.from(computed, "hex");
  const presentedBuf = Buffer.from(presented, "hex");
  if (computedBuf.length !== presentedBuf.length) return false;

  return crypto.timingSafeEqual(computedBuf, presentedBuf);
}

/**
 * The platform-level webhook verify token. App Secrets are not platform-level:
 * each connection verifies with its own encrypted one. Read lazily so importing
 * this module without the variable set doesn't throw until the route needs it.
 */
export function getMetaWebhookVerifyToken(): string | undefined {
  return process.env.META_WEBHOOK_VERIFY_TOKEN || undefined;
}
