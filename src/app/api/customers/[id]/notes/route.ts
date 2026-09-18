import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as customersService from "@/lib/customers/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "customers:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const notes = await customersService.listNotes(ctx, id);
    return NextResponse.json(notes);
  } catch (error) {
    logger.error("Failed to fetch customer notes:", error);
    return toErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "customers:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { content, authorName } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json(
        { error: "Content is required" },
        { status: 400 }
      );
    }

    const note = await customersService.addNote(ctx, id, content, authorName);
    return NextResponse.json(note, { status: 201 });
  } catch (error) {
    logger.error("Failed to create customer note:", error);
    return toErrorResponse(error);
  }
}
