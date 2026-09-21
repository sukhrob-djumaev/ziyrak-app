import type { TenantContext } from "@/lib/tenancy/context";
import { MetaWhatsAppCredentialSchema } from "@/lib/secrets";
import { isConfigFieldClaimedByOtherBusiness } from "@/lib/identity/channel-credential-auth";
import { AppError } from "@/lib/observability/errors";

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v21.0";

/**
 * PLAN.md §20.2/§46.7 — proof that whoever is saving this Meta credential
 * actually controls the phone number: the access token must be able to read
 * that exact `phone_number_id` from the Graph API. A `phone_number_id` is what
 * routes inbound WhatsApp traffic to a business (§7.7), and it is not secret,
 * so without this a business could type in *another* business's id and start
 * receiving its customers' messages.
 */
async function verifyPhoneNumberAccess(phoneNumberId: string, accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(phoneNumberId)}?fields=id`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!response.ok) return false;
    const body = (await response.json()) as { id?: string };
    return body.id === phoneNumberId;
  } catch {
    return false;
  }
}

/**
 * The only path by which a `whatsapp_cloud` connection's routing key
 * (`config.phoneNumberId`) is ever set: derived from a *verified* credential,
 * never taken from a client-supplied `config` (which would let a caller point
 * their own connection at someone else's number without any credential).
 */
export async function prepareMetaCloudConnection(
  ctx: TenantContext,
  input: { config?: Record<string, unknown>; credential?: unknown },
  existingConfig: Record<string, unknown> | undefined
): Promise<{ config: Record<string, unknown> | undefined; verifiedPhoneNumberId?: string }> {
  const { phoneNumberId: _ignoredClientValue, ...safeConfig } = input.config ?? {};
  void _ignoredClientValue;

  if (!input.credential) {
    if (input.config === undefined) return { config: undefined };
    // A config-only update keeps whatever verified routing key is already
    // stored (the update below replaces `config` wholesale).
    const existingId = existingConfig?.phoneNumberId;
    return { config: typeof existingId === "string" ? { ...safeConfig, phoneNumberId: existingId } : safeConfig };
  }

  const credential = MetaWhatsAppCredentialSchema.safeParse(input.credential);
  if (!credential.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid WhatsApp credential.");
  }
  const { phoneNumberId, accessToken } = credential.data;

  if (await isConfigFieldClaimedByOtherBusiness("whatsapp_cloud", "phoneNumberId", phoneNumberId, ctx.businessId)) {
    throw new AppError(409, "CONFLICT", "This WhatsApp phone number is already connected to another account.");
  }

  if (!(await verifyPhoneNumberAccess(phoneNumberId, accessToken))) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Could not verify this phone number ID with the provided access token. Check both values in your Meta App."
    );
  }

  return { config: { ...safeConfig, phoneNumberId }, verifiedPhoneNumberId: phoneNumberId };
}
