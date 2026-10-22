import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { activateWorkspace } from "@/lib/onboarding/service";

/** PLAN.md P3 — owner-only, verified-email-only onboarding action; failures carry a safe code and message. */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request);
  if (!isAuthenticated(ctx)) return ctx;
  if (ctx.actor.kind !== "user") return NextResponse.json({ error: { code: "FORBIDDEN", message: "A signed-in person is required" } }, { status: 403 });
  const result = await activateWorkspace(ctx, ctx.actor.userId);
  if (result.ok) return NextResponse.json({ success: true });
  const status = result.code === "OWNER_REQUIRED" ? 403 : result.code === "TEST_REPLY_FAILED" ? 502 : 409;
  return NextResponse.json({ error: { code: result.code, message: result.message, ...(result.missing ? { missing: result.missing } : {}) } }, { status });
}
