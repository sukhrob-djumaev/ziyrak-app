import { prisma } from "@/lib/prisma/raw-client";
import { AppError } from "@/lib/observability/errors";
import type { TenantContext } from "@/lib/tenancy/context";

let cachedDefaultBusinessId: string | null = null;

/**
 * PLAN.md §46.1/§46.2 audit finding — this is no longer a silent,
 * general-purpose fallback. Its ONLY remaining legitimate uses, after the
 * Phase 2 runtime-isolation audit, are:
 *
 *   1. `assertDefaultBusinessOnly()`/`getDefaultBusinessContext()` below —
 *      explicit, fail-closed guards for the small set of features that
 *      structurally cannot be made tenant-aware without building
 *      Phase 4/5/6 architecture (the legacy Settings singleton; the AI
 *      chat pipeline's Settings-derived provider/model/API key; the
 *      channel-adapter subsystem, which has no way to resolve "which
 *      business" an inbound webhook belongs to until Phase 5's
 *      ChannelConnection-based resolution exists).
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
 * For the channel-adapter subsystem specifically (§14.3/§46.2's own
 * finding): an inbound provider webhook (WhatsApp/SMS/email/Telegram/
 * phone) has no `TenantContext` at all — there is no JWT, no API key, and
 * no ChannelConnection-based resolution yet (that is Phase 5's job). This
 * constructs the one, explicit, documented `TenantContext` these adapters
 * are allowed to use until then, so the choice is visible at the call
 * site instead of buried inside `chat()`/`resolveCustomer()` as an
 * implicit fallback. `getScopedPrisma(ctx)` still enforces every query
 * against this businessId structurally — this is not a bypass, it is the
 * one tenant every unauthenticated inbound message is scoped to today.
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
