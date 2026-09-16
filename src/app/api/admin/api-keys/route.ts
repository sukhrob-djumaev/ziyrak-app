import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { getDefaultBusinessId } from "@/lib/default-business";
import { redactApiKeyHash } from "@/lib/security";

// §9.4: keyPrefix is safe to display/search by, never the secret itself.
// The full secret is generated here and returned exactly once, at creation
// time — after this response, only its hash is ever stored.
function generateApiKey(): { fullKey: string; keyPrefix: string; keyHash: string } {
  const secret = crypto.randomBytes(24).toString("base64url");
  const fullKey = `zy_live_${secret}`;
  const keyPrefix = fullKey.slice(0, 16);
  const keyHash = crypto.createHash("sha256").update(fullKey).digest("hex");
  return { fullKey, keyPrefix, keyHash };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request, "admin:read");
  if (!isAuthenticated(auth)) return auth;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const [keys, total] = await Promise.all([
      prisma.apiKey.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.apiKey.count(),
    ]);

    const sanitized = keys.map(redactApiKeyHash);

    return NextResponse.json(paginatedResponse(sanitized, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch API keys:", error);
    return NextResponse.json(
      { error: "Failed to fetch API keys" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request, "admin:create");
  if (!isAuthenticated(auth)) return auth;

  try {
    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Key name is required" },
        { status: 400 }
      );
    }

    const { fullKey, keyPrefix, keyHash } = generateApiKey();

    const apiKey = await prisma.apiKey.create({
      data: {
        businessId: await getDefaultBusinessId(),
        name: name.trim(),
        keyPrefix,
        keyHash,
        // Capped below "owner" per §9.1/§9.4 — a leaked long-lived key must
        // never be able to reach owner-only actions (deleting the business).
        role: "agent",
      },
    });

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
    return NextResponse.json(
      { error: "Failed to create API key" },
      { status: 500 }
    );
  }
}
