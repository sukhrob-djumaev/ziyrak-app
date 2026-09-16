import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { transferConversation } from "@/lib/conversation-engine";
import { logger } from "@/lib/logger";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "conversations:transfer");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await params;
    const body = await request.json();
    const { toMemberId, note } = body;

    if (!toMemberId) {
      return NextResponse.json(
        { error: "toMemberId is required" },
        { status: 400 }
      );
    }

    const success = await transferConversation(
      id,
      toMemberId,
      auth.name,
      note
    );

    if (!success) {
      return NextResponse.json(
        { error: "Transfer failed" },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to transfer conversation:", error);
    return NextResponse.json(
      { error: "Failed to transfer" },
      { status: 500 }
    );
  }
}
