import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
import * as teamService from "@/lib/team/service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "team:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const { departments, total } = await teamService.listDepartments(ctx, { skip, take });

    return NextResponse.json(paginatedResponse(departments, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch departments:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "team:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { name, description, email } = body;

    if (!name || !name.trim()) {
      return NextResponse.json(
        { error: "Department name is required" },
        { status: 400 }
      );
    }

    const department = await teamService.createDepartment(ctx, { name, description, email });

    return NextResponse.json(department, { status: 201 });
  } catch (error) {
    logger.error("Failed to create department:", error);
    return toErrorResponse(error);
  }
}
