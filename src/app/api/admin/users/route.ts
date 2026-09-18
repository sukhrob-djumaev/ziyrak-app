import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as adminUsersService from "@/lib/platform/admin-users/service";

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

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "admin:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { username, password, name, role } = body;

    if (!username || typeof username !== "string" || username.trim().length === 0) {
      return NextResponse.json(
        { error: "Username is required" },
        { status: 400 }
      );
    }

    if (!password || typeof password !== "string" || password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters" },
        { status: 400 }
      );
    }

    const user = await adminUsersService.create(ctx, { username, password, name, role });

    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    logger.error("Failed to create admin user:", error);
    return toErrorResponse(error);
  }
}
