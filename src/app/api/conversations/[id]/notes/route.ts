import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as conversationsService from "@/lib/conversations/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "messages:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const notes = await conversationsService.listNotes(ctx, id);
    return NextResponse.json(notes);
  } catch (error) {
    logger.error("Failed to fetch internal notes:", error);
    return toErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "messages:create");
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

    const note = await conversationsService.addNote(ctx, id, content, authorName);
    return NextResponse.json(note, { status: 201 });
  } catch (error) {
    logger.error("Failed to create internal note:", error);
    return toErrorResponse(error);
  }
}
