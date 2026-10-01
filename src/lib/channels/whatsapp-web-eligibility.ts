import { assertDefaultBusinessOnly } from "@/lib/tenancy/default-business";
import { AppError } from "@/lib/observability/errors";
import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §20.1/§20.2 — the one eligibility rule for the dev/demo-only
 * `WhatsAppWebAdapter`, shared by every caller that could create, configure,
 * select or drive it (the adapter itself, the WhatsApp Web route, and the
 * generic channel-configuration service), so they cannot drift apart.
 *
 * Kept free of whatsapp-web.js/Puppeteer imports so the generic channel
 * service can enforce it without loading the session module.
 */

/** The `ChannelConnection.type` (and registry key) owned by `WhatsAppWebAdapter`. Meta Cloud is `"whatsapp_cloud"`. */
export const WHATSAPP_WEB_CHANNEL_TYPE = "whatsapp";

const WHATSAPP_WEB_FEATURE = "WhatsApp Web (internal dev/demo channel)";

/**
 * PLAN.md §20.2/§46.7 — the deployment-level switch for this dev/demo-only
 * adapter (the runbook's "leave `NEXT_PUBLIC_ENABLE_WHATSAPP_WEB` unset in
 * production"). The same flag that shows the dashboard card, read here too so
 * the server — not only the browser — refuses the feature when it is off.
 */
export function isWhatsAppWebEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_WHATSAPP_WEB === "true";
}

/**
 * PLAN.md §20.2 — WhatsApp Web requires both: the feature enabled on this
 * deployment (404 otherwise, for everyone), and the caller being the
 * designated dev/demo business (`assertDefaultBusinessOnly`, 501 otherwise).
 * Call it before touching the shared session (its status/QR is not harmless
 * read-only data: scanning the QR links the scanner's WhatsApp account into
 * the session the designated business owns) *or* persisting any
 * `"whatsapp"` ChannelConnection state, so a refused caller leaves nothing
 * behind.
 */
export async function assertWhatsAppWebEligible(ctx: Pick<TenantContext, "businessId">): Promise<void> {
  if (!isWhatsAppWebEnabled()) {
    throw new AppError(404, "NOT_FOUND", "WhatsApp Web is not enabled on this deployment.");
  }
  await assertDefaultBusinessOnly(ctx, WHATSAPP_WEB_FEATURE);
}
