import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated, resolveActorDisplayName } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import { validateBody } from "@/lib/validations";
import { resetToolPolicy, toolPolicyPatchSchema, updateToolPolicy } from "@/lib/tools/policy-admin";
import "@/lib/tools/builtin";

/** PLAN.md §23.4 — changes this business's policy for one tool (admin and owner only). */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ tool: string }> }) {
  const ctx = await requireAuth(request, "tools:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { tool } = await params;
    const body = await request.json().catch(() => null);
    const validation = validateBody(toolPolicyPatchSchema, body);
    if (!validation.success) return NextResponse.json({ error: validation.error }, { status: 400 });

    return NextResponse.json(await updateToolPolicy(ctx, tool, validation.data, await resolveActorDisplayName(ctx)));
  } catch (error) {
    logger.error("Failed to update tool policy:", error);
    return toErrorResponse(error);
  }
}

/** Resets one tool to the platform default by removing this business's own row. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ tool: string }> }) {
  const ctx = await requireAuth(request, "tools:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { tool } = await params;
    return NextResponse.json(await resetToolPolicy(ctx, tool, await resolveActorDisplayName(ctx)));
  } catch (error) {
    logger.error("Failed to reset tool policy:", error);
    return toErrorResponse(error);
  }
}
