import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { isDefaultBusiness } from "@/lib/tenancy/default-business";
import { toErrorResponse } from "@/lib/observability/errors";
import { validateBody, updateBusinessProfileSchema } from "@/lib/validations";
import { logger } from "@/lib/observability/logger";

/**
 * The tenant-scoped business-profile boundary (name, description, welcome
 * message, tone, language) — the `BusinessConfig` half of what the legacy
 * `Settings` singleton used to hold (§10.2/§13.2.7), beside `/api/settings/ai`
 * for the provider half. It reads and writes only the caller's own row,
 * through the scoped client; there is no Default Business fallback and no way
 * to name another tenant (the body schema is strict, a `businessId` in the
 * query string or body is never consulted).
 *
 * `legacyChannelSettingsAvailable` only *describes* whether the legacy
 * `/api/settings` panels (voice/phone/email/WhatsApp credentials in the
 * global singleton) exist for this caller, so the UI does not offer — and
 * probe with a 501 — something that is permanently unavailable outside the
 * Default Business. `/api/settings` still enforces that itself.
 */

interface BusinessProfileView {
  businessName: string;
  businessDesc: string;
  welcomeMessage: string;
  tone: string;
  language: string;
  legacyChannelSettingsAvailable: boolean;
}

function toView(
  config: { businessName: string; businessDesc: string; welcomeMessage: string; tone: string; language: string },
  legacyChannelSettingsAvailable: boolean
): BusinessProfileView {
  return {
    businessName: config.businessName,
    businessDesc: config.businessDesc,
    welcomeMessage: config.welcomeMessage,
    tone: config.tone,
    language: config.language,
    legacyChannelSettingsAvailable,
  };
}

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "settings:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const db = getScopedPrisma(ctx);
    const config = await db.businessConfig.upsert({
      where: { businessId: ctx.businessId },
      update: {},
      create: { businessId: ctx.businessId },
    });

    return NextResponse.json(toView(config, await isDefaultBusiness(ctx)));
  } catch (error) {
    logger.error("Failed to fetch business profile:", error);
    return toErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  const ctx = await requireAuth(request, "settings:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const validation = validateBody(updateBusinessProfileSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const db = getScopedPrisma(ctx);
    const updated = await db.businessConfig.upsert({
      where: { businessId: ctx.businessId },
      update: validation.data,
      create: { businessId: ctx.businessId, ...validation.data },
    });

    return NextResponse.json(toView(updated, await isDefaultBusiness(ctx)));
  } catch (error) {
    logger.error("Failed to update business profile:", error);
    return toErrorResponse(error);
  }
}
