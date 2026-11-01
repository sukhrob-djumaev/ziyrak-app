import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { chooseStayers, seatConflict } from "@/lib/billing/changes";
import { AppError, toErrorResponse } from "@/lib/observability/errors";

const choice = z.object({ versionId: z.string().uuid(), membershipIds: z.array(z.string().uuid()).min(1).max(1000) }).strict();

function ownerUser(ctx: { actor: { kind: string; userId?: string }; businessId: string }) {
  if (ctx.actor.kind !== "user" || !ctx.actor.userId) throw new AppError(403, "FORBIDDEN", "Only the workspace owner can change the subscription");
  return { businessId: ctx.businessId, userId: ctx.actor.userId };
}

/** L5.2 - the conflict for a scheduled team-size decrease: members against the new limit, and who is kept so far. */
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    const actor = ownerUser(ctx);
    const versionId = z.string().uuid().safeParse(request.nextUrl.searchParams.get("versionId"));
    if (!versionId.success) throw new AppError(400, "VALIDATION_ERROR", "Choose a package");
    const response = NextResponse.json(await seatConflict(actor.businessId, versionId.data));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** L5.2 - the owner chooses who keeps a seat when the decrease applies. Nobody is suspended until then. */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "business:billing");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    const actor = ownerUser(ctx);
    const parsed = choice.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Choose the people who stay");
    await chooseStayers(actor, parsed.data);
    const response = NextResponse.json({ ok: true });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
