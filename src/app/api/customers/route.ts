import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { toErrorResponse } from "@/lib/errors";
import * as customersService from "@/lib/customers/service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "customers:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const { customers, total } = await customersService.list(ctx, {
      search: searchParams.get("search"),
      isBlocked: searchParams.get("isBlocked"),
      skip,
      take,
    });

    return NextResponse.json(paginatedResponse(customers, total, page, limit));
  } catch (error) {
    logger.error("Failed to fetch customers:", error);
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "customers:create");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { name, email, phone, whatsapp, tags, notes, metadata } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    const customer = await customersService.create(ctx, { name, email, phone, whatsapp, tags, notes, metadata });

    return NextResponse.json(customer, { status: 201 });
  } catch (error) {
    logger.error("Failed to create customer:", error);
    return toErrorResponse(error);
  }
}
