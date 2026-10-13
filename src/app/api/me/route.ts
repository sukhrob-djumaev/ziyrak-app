import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated, resolveActorProfile } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

/**
 * The signed-in person, their role and their business's display name — what the
 * dashboard header shows. Any authenticated member may read their own identity,
 * so there is no permission beyond being signed in; an API key has no person
 * behind it and gets 403.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request);
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const user = await resolveActorProfile(ctx);
    if (!user) {
      return NextResponse.json({ error: { code: "NOT_A_USER", message: "This credential is not a signed-in person." } }, { status: 403 });
    }
    const config = await getScopedPrisma(ctx).businessConfig.findUnique({ where: { businessId: ctx.businessId }, select: { businessName: true } });
    return NextResponse.json({
      user,
      role: ctx.role,
      business: { id: ctx.businessId, name: config?.businessName ?? "Your business" },
    });
  } catch (error) {
    logger.error("Failed to resolve /api/me:", error);
    return toErrorResponse(error);
  }
}
