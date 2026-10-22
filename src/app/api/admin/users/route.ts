import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as adminUsersService from "@/lib/platform/admin-users/service";
import { createInvitation } from "@/lib/platform/admin-users/invitations";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "admin:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const { users, total } = await adminUsersService.list(ctx, { skip, take });

    return NextResponse.json(paginatedResponse(users, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch admin users:", error);
    return toErrorResponse(error);
  }
}

/**
 * PLAN.md P3 — adding a team member is an invitation to a recipient address, not creating an
 * account with a password chosen by someone else.
 */
export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "admin:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { email, role, scope } = body ?? {};
    if (typeof email !== "string" || !email.trim()) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }
    const invitation = await createInvitation(ctx, { email, role: typeof role === "string" ? role : "viewer", scope });
    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    logger.error("Failed to invite team member:", error);
    return toErrorResponse(error);
  }
}
