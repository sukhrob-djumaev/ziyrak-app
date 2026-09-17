import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { redactApiKeyHash } from "@/lib/security";
import { toErrorResponse } from "@/lib/errors";
import * as apiKeysService from "@/lib/admin-api-keys/service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "admin:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const { keys, total } = await apiKeysService.list(ctx, { skip, take });
    const sanitized = keys.map(redactApiKeyHash);

    return NextResponse.json(paginatedResponse(sanitized, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch API keys:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "admin:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Key name is required" },
        { status: 400 }
      );
    }

    const { apiKey, fullKey } = await apiKeysService.create(ctx, name);

    // Return the full secret only this once — after this response, only its
    // hash is ever stored or displayed again.
    return NextResponse.json(
      {
        ...redactApiKeyHash(apiKey),
        key: fullKey,
      },
      { status: 201 }
    );
  } catch (error) {
    logger.error("Failed to create API key:", error);
    return toErrorResponse(error);
  }
}
