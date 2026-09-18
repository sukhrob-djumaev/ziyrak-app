import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as ticketsService from "@/lib/tickets/service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "tickets:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const { tickets, total } = await ticketsService.list(ctx, {
      status: searchParams.get("status"),
      priority: searchParams.get("priority"),
      departmentId: searchParams.get("departmentId"),
      search: searchParams.get("search"),
      skip,
      take,
    });

    return NextResponse.json(paginatedResponse(tickets, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch tickets:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "tickets:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { title, description, priority, status, conversationId, departmentId, assignedToId } = body;

    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return NextResponse.json(
        { error: "Ticket title is required" },
        { status: 400 }
      );
    }

    const ticket = await ticketsService.create(ctx, {
      title,
      description,
      priority,
      status,
      conversationId,
      departmentId,
      assignedToId,
    });

    return NextResponse.json(ticket, { status: 201 });
  } catch (error) {
    logger.error("Failed to create ticket:", error);
    return toErrorResponse(error);
  }
}
