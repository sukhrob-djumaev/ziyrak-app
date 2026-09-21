import { prisma } from "@/lib/prisma/raw-client";
import { AppError } from "@/lib/observability/errors";
import type { TenantContext } from "@/lib/tenancy/context";

let cachedDefaultBusinessId: string | null = null;

/**
 * PLAN.md §46.1/§46.2/§46.5 audit findings — this is no longer a silent,
 * general-purpose fallback. Its ONLY remaining legitimate uses, after the
 * Phase 2 runtime-isolation audit and Phase 5's channel-adapter migration,
 * are:
 *
 *   1. `assertDefaultBusinessOnly()`/`getDefaultBusinessContext()` below —
 *      explicit, fail-closed guards for the small set of features that
 *      structurally cannot be made tenant-aware without building Phase
 *      4/6 architecture (the legacy Settings singleton; `tools/builtin/
 *      send-internal-email.ts`'s one remaining global-config read) or that
 *      are permanently,
 *      architecturally single-tenant by design regardless of any future
 *      phase (`WhatsAppWebAdapter`'s dev/demo-only session, §20.1/§20.2 —
 *      every *other* channel adapter resolves a real per-`ChannelConnection`
 *      `TenantContext` as of Phase 5 and no longer calls either function).
 *   2. Migration/seed scripts, which are not externally reachable at all.
 *
 * It must NEVER be called as an implicit substitute for a real
 * TenantContext inside a function that also accepts one, or as a way to
 * "make a NOT NULL constraint happy" without the caller having explicitly
 * decided (and documented) that this specific feature is single-tenant
 * for now. If you are adding a new call site, stop and ask whether the
 * function you're in should take `ctx: TenantContext` instead — it almost
 * certainly should.
 */
export async function getDefaultBusinessId(): Promise<string> {
  if (cachedDefaultBusinessId) return cachedDefaultBusinessId;
  const business = await prisma.business.findUniqueOrThrow({ where: { slug: "default" } });
  cachedDefaultBusinessId = business.id;
  return business.id;
}

/**
 * Fail-closed guard for a route/service that has a real, resolved
 * `TenantContext` (from `requireAuth()`) but whose underlying feature is
 * not yet tenant-aware (still reads/writes the legacy global `Settings`
 * singleton, or the AI chat pipeline's Settings-derived provider config).
 * Throws instead of silently operating against the Default Business's
 * data/config on a non-default caller's behalf — per the Phase 2 runtime-
 * isolation audit's invariant: "never silently fall back to the Default
 * Business."
 */
export async function assertDefaultBusinessOnly(
  ctx: Pick<TenantContext, "businessId">,
  featureLabel: string
): Promise<void> {
  const defaultBusinessId = await getDefaultBusinessId();
  if (ctx.businessId !== defaultBusinessId) {
    throw new AppError(
      501,
      "NOT_YET_SUPPORTED",
      `${featureLabel} is not yet available for businesses other than the first one — this depends on architecture explicitly deferred to a later phase (see PLAN.md).`
    );
  }
}

/**
 * PLAN.md §14.3/§20.1-20.2/§46.5 — as of Phase 5, every real channel
 * (SMS/Phone/Telegram/Email/WebChat) resolves a genuine per-`ChannelConnection`
 * `TenantContext` via `identity/channel-credential-auth.ts` and no longer
 * calls this function at all. Its one remaining legitimate caller is
 * `WhatsAppWebAdapter.connect()` (`channels/whatsapp.ts`) — not because
 * whatsapp-web.js's inbound path still lacks per-connection resolution
 * (it now has one, via `sessionOwner`), but because §20.1/§20.2 make this
 * adapter permanently, architecturally single-tenant (one shared Puppeteer
 * session, platform-wide): `assertDefaultBusinessOnly()` (via this
 * function's sibling above) is what gates *which* business is allowed to
 * be that one tenant, and this function is what constructs its
 * `TenantContext` once the gate passes. `getScopedPrisma(ctx)` still
 * enforces every query against this businessId structurally either way —
 * this was never a bypass, only the one tenant a given call site is
 * explicitly, deliberately scoped to.
 */
export async function getDefaultBusinessContext(): Promise<TenantContext> {
  const businessId = await getDefaultBusinessId();
  return {
    businessId,
    role: null,
    actor: { kind: "channel_credential", channelConnectionId: "unresolved-pre-phase-5-single-tenant-adapter" },
    dataConnection: "shared-default",
  };
}
