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
    const departmentId = searchParams.get("departmentId");

    const { members, total } = await teamService.listMembers(ctx, { departmentId, skip, take });

    return NextResponse.json(paginatedResponse(members, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch members:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "team:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { name, email, phone, role, expertise, departmentId } = body;

    if (!name || !name.trim()) {
      return NextResponse.json(
        { error: "Member name is required" },
        { status: 400 }
      );
    }

    if (!email || !email.trim()) {
      return NextResponse.json(
        { error: "Member email is required" },
        { status: 400 }
      );
    }

    if (!departmentId) {
      return NextResponse.json(
        { error: "Department is required" },
        { status: 400 }
      );
    }

    const member = await teamService.createMember(ctx, { name, email, phone, role, expertise, departmentId });

    return NextResponse.json(member, { status: 201 });
  } catch (error) {
    logger.error("Failed to create member:", error);
    return toErrorResponse(error);
  }
}
