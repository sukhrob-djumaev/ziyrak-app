import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as adminUsersService from "@/lib/platform/admin-users/service";

/** Real connections a workspace-wide admin may assign to a restricted member. */
export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "admin:update");
  if (!isAuthenticated(ctx)) return ctx;
  try {
    return NextResponse.json(await adminUsersService.listConnectionOptions(ctx));
  } catch (error) {
    logger.error("Failed to list connection options:", error);
    return toErrorResponse(error);
  }
}
