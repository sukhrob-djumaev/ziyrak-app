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
    const categoryId = searchParams.get("categoryId");

    const { entries, total } = await knowledgeService.listEntries(ctx, { categoryId, skip, take });

    return NextResponse.json(paginatedResponse(entries, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch entries:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "knowledge:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { categoryId, title, content, priority } = body;

    if (!categoryId) {
      return NextResponse.json(
        { error: "Category ID is required" },
        { status: 400 }
      );
    }

    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return NextResponse.json(
        { error: "Title is required" },
        { status: 400 }
      );
    }

    const entry = await knowledgeService.createEntry(ctx, { categoryId, title, content, priority });

    return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    logger.error("Failed to create entry:", error);
    return toErrorResponse(error);
  }
}
