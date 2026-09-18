import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as customersService from "@/lib/customers/service";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "customers:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const customer = await customersService.getById(ctx, id);
    return NextResponse.json(customer);
  } catch (error) {
    logger.error("Failed to fetch customer:", error);
    return toErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "customers:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { name, email, phone, whatsapp, tags, isBlocked, metadata } = body;

    const customer = await customersService.update(ctx, id, {
      name,
      email,
      phone,
      whatsapp,
      tags,
      isBlocked,
      metadata,
    });

    return NextResponse.json(customer);
  } catch (error) {
    logger.error("Failed to update customer:", error);
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "customers:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    await customersService.remove(ctx, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to delete customer:", error);
    return toErrorResponse(error);
  }
}
