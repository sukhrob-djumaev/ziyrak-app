import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { deleteCustomerData } from "@/lib/customers/gdpr";
import { logger } from "@/lib/observability/logger";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "customers:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;
    const body = await request.json();
    const { hardDelete } = body;

    const result = await deleteCustomerData(ctx, id, hardDelete === true);

    return NextResponse.json(result);
  } catch (error) {
    logger.error("Failed to delete customer data:", error);
    return NextResponse.json(
      { error: "Failed to delete data" },
      { status: 500 }
    );
  }
}
