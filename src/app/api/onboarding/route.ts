import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { getOnboardingState } from "@/lib/onboarding/service";

/** PLAN.md P3 — the signed-in person's own view of their workspace's onboarding. */
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request);
  if (!isAuthenticated(ctx)) return ctx;
  if (ctx.actor.kind !== "user") return NextResponse.json({ error: { code: "FORBIDDEN", message: "A signed-in person is required" } }, { status: 403 });
  const view = await getOnboardingState({ businessId: ctx.businessId, userId: ctx.actor.userId });
  return NextResponse.json(view, { headers: { "Cache-Control": "private, no-store" } });
}
