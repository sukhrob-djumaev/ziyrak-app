import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { routeConversation } from "@/lib/conversations/conversation-engine";
import { logger } from "@/lib/observability/logger";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "conversations:assign");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    // Not read below: routeConversation() only suggests an agent/department
    // (the client separately calls transfer/assign to act on it) — the
    // conversation id itself was already unused by this handler pre-Phase 2.
    await params;
    const body = await request.json();
    const { strategy, expertise, departmentId } = body;

    const result = await routeConversation(
      ctx,
      strategy || "skill_based",
      expertise,
      departmentId
    );

    if (!result) {
      return NextResponse.json(
        { error: "No available agents" },
        { status: 404 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    logger.error("Failed to route conversation:", error);
    return NextResponse.json(
      { error: "Failed to route conversation" },
      { status: 500 }
    );
  }
}
