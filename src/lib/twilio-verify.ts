import crypto from "crypto";

/**
 * Validate Twilio webhook request signature.
 * See: https://www.twilio.com/docs/usage/security#validating-requests
 */
export function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  if (!authToken || !signature) return false;

  // Sort params alphabetically and concatenate
  const data =
    url +
    Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], "");

  const computed = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");

  const computedBuf = Buffer.from(computed);
  const signatureBuf = Buffer.from(signature);

  if (computedBuf.length !== signatureBuf.length) return false;

  return crypto.timingSafeEqual(computedBuf, signatureBuf);
}

/**
 * Extract Twilio auth token from settings.
 */
export async function getTwilioAuthToken(): Promise<string> {
  // Dynamic import to avoid circular deps
  const { prisma } = await import("@/lib/prisma");
  const settings = await prisma.settings.findFirst({
    select: { twilioToken: true },
  });
  return settings?.twilioToken || "";
}
