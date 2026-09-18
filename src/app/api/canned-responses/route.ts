import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "canned:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);
    const category = searchParams.get("category");

    const where: Record<string, unknown> = {};

    if (category && category !== "all") {
      where.category = category;
    }

    const db = getScopedPrisma(ctx);
    const [responses, total] = await Promise.all([
      db.cannedResponse.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      db.cannedResponse.count({ where }),
    ]);

    return NextResponse.json(paginatedResponse(responses, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch canned responses:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "canned:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { title, content, category, shortcut, isActive } = body;

    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return NextResponse.json(
        { error: "Title is required" },
        { status: 400 }
      );
    }

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return NextResponse.json(
        { error: "Content is required" },
        { status: 400 }
      );
    }

    const db = getScopedPrisma(ctx);
    const response = await db.cannedResponse.create({
      data: {
        businessId: ctx.businessId,
        title: title.trim(),
        content: content.trim(),
        category: category?.trim() || "General",
        shortcut: shortcut?.trim() || "",
        isActive: isActive ?? true,
      },
    });

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    logger.error("Failed to create canned response:", error);
    return toErrorResponse(error);
  }
}
