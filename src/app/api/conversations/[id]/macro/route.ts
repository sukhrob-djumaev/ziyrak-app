import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated, resolveActorDisplayName } from "@/lib/identity/route-auth";
import { executeMacro } from "@/lib/conversations/conversation-engine";
import { logger } from "@/lib/observability/logger";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(request, "conversations:update");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { id } = await params;
    const body = await request.json();
    const { actions } = body;

    if (!actions || !Array.isArray(actions)) {
      return NextResponse.json(
        { error: "actions array is required" },
        { status: 400 }
      );
    }

    const actorName = await resolveActorDisplayName(auth);
    const result = await executeMacro(auth, id, actions, actorName);

    return NextResponse.json(result);
  } catch (error) {
    logger.error("Failed to execute macro:", error);
    return NextResponse.json(
      { error: "Failed to execute macro" },
      { status: 500 }
    );
  }
}
