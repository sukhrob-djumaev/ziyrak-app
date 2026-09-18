import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma/raw-client";
import { maskSettingsSecrets } from "@/lib/security";
import { updateSettingsSchema, validateBody } from "@/lib/validations";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { assertDefaultBusinessOnly } from "@/lib/tenancy/default-business";
import { toErrorResponse } from "@/lib/observability/errors";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "settings:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    // Phase 2 runtime-isolation audit finding: this is the legacy global
    // Settings singleton (superseded by BusinessConfig/ChannelConnection,
    // §10.2/§7.7) with no businessId of its own at all — without this
    // guard, any authenticated business's admin could read another
    // business's AI/SMTP/IMAP/Twilio credentials. Removed once Phase 4
    // gives every business its own BusinessConfig-based settings.
    await assertDefaultBusinessOnly(ctx, "Settings");

    const settings = await prisma.settings.upsert({
      where: { id: "default" },
      update: {},
      create: { id: "default" },
    });

    return NextResponse.json(maskSettingsSecrets(settings));
  } catch (error) {
    logger.error("Failed to fetch settings:", error);
    return toErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  const ctx = await requireAuth(request, "settings:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    // See GET's comment — this additionally closes a write vector: without
    // this guard, a non-default business's admin could overwrite the
    // Default Business's live AI/SMTP/IMAP/Twilio credentials.
    await assertDefaultBusinessOnly(ctx, "Settings");

    const body = await request.json();

    // Remove fields that should not be updated directly
    delete body.id;
    delete body.createdAt;
    delete body.updatedAt;

    const validation = validateBody(updateSettingsSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const settings = await prisma.settings.upsert({
      where: { id: "default" },
      update: validation.data,
      create: { id: "default", ...validation.data },
    });

    return NextResponse.json(maskSettingsSecrets(settings));
  } catch (error) {
    logger.error("Failed to update settings:", error);
    return toErrorResponse(error);
  }
}
