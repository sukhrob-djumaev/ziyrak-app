import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { restoreMember } from "@/lib/billing/member-seats";
import { AppError, toErrorResponse } from "@/lib/observability/errors";

const body = z.object({ membershipId: z.string().uuid() }).strict();

/** L5.2 - gives a member suspended by a team-size decrease their seat back when the plan has room. Owner only. */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    if (ctx.actor.kind !== "user") throw new AppError(403, "FORBIDDEN", "Only the workspace owner can change the subscription");
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Choose a member");
    await restoreMember({ businessId: ctx.businessId }, parsed.data.membershipId);
    const response = NextResponse.json({ ok: true });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
