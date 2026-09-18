import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { getPlugins } from "@/lib/plugins";
import { logger } from "@/lib/observability/logger";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "admin:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const plugins = getPlugins();
    return NextResponse.json(plugins);
  } catch (error) {
    logger.error("Failed to fetch plugins:", error);
    return NextResponse.json(
      { error: "Failed to fetch plugins" },
      { status: 500 }
    );
  }
}
