import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { validateFlow, type Flow } from "@/lib/flows/flow-builder";
import { logger } from "@/lib/observability/logger";
import { toErrorResponse } from "@/lib/observability/errors";
import * as flowsService from "@/lib/flows/service";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "automation:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const flow = await flowsService.getById(ctx, id);

    const result = validateFlow(flow as unknown as Flow);

    return NextResponse.json(result);
  } catch (error) {
    logger.error("Failed to validate flow:", error);
    return toErrorResponse(error);
  }
}
