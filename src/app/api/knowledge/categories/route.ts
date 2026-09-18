import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as knowledgeService from "@/lib/knowledge/service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "knowledge:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const { categories, total } = await knowledgeService.listCategories(ctx, { skip, take });

    return NextResponse.json(paginatedResponse(categories, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch categories:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "knowledge:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { name, description, icon, color } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Category name is required" },
        { status: 400 }
      );
    }

    const category = await knowledgeService.createCategory(ctx, { name, description, icon, color });

    return NextResponse.json(category, { status: 201 });
  } catch (error) {
    logger.error("Failed to create category:", error);
    return toErrorResponse(error);
  }
}
