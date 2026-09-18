import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as automationService from "@/lib/automations/automation-rules/service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "automation:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);
    const type = searchParams.get("type");

    const { rules, total } = await automationService.list(ctx, { type, skip, take });

    return NextResponse.json(paginatedResponse(rules, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch automation rules:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "automation:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { name, description, type, isActive, conditions, actions, priority } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    const validTypes = ["auto_route", "auto_tag", "auto_reply", "keyword_alert"];
    if (!type || !validTypes.includes(type)) {
      return NextResponse.json(
        { error: "Invalid rule type" },
        { status: 400 }
      );
    }

    if (!conditions || !Array.isArray(conditions) || conditions.length === 0) {
      return NextResponse.json(
        { error: "At least one condition is required" },
        { status: 400 }
      );
    }

    if (!actions || !Array.isArray(actions) || actions.length === 0) {
      return NextResponse.json(
        { error: "At least one action is required" },
        { status: 400 }
      );
    }

    const rule = await automationService.create(ctx, { name, description, type, isActive, conditions, actions, priority });

    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    logger.error("Failed to create automation rule:", error);
    return toErrorResponse(error);
  }
}
