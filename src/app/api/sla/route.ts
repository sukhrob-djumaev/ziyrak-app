import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "sla:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);
    const db = getScopedPrisma(ctx);

    const [rules, total] = await Promise.all([
      db.sLARule.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      db.sLARule.count(),
    ]);

    return NextResponse.json(paginatedResponse(rules, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch SLA rules:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "sla:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { name, description, channel, priority, firstResponseMins, resolutionMins, isActive } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Rule name is required" },
        { status: 400 }
      );
    }

    const db = getScopedPrisma(ctx);
    const rule = await db.sLARule.create({
      data: {
        businessId: ctx.businessId,
        name: name.trim(),
        description: description?.trim() || "",
        channel: channel || "all",
        priority: priority || "all",
        firstResponseMins: firstResponseMins ?? 30,
        resolutionMins: resolutionMins ?? 480,
        isActive: isActive ?? true,
      },
    });

    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    logger.error("Failed to create SLA rule:", error);
    return toErrorResponse(error);
  }
}
