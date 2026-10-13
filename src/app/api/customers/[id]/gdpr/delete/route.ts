import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { deleteCustomerData } from "@/lib/customers/gdpr";
import { NotFoundError, toErrorResponse } from "@/lib/observability/errors";
import { logger } from "@/lib/observability/logger";

/**
 * Erases (`hardDelete: true`) or anonymises (the default) one customer's data.
 * A customer that is not this business's — including one that does not exist —
 * is a 404 and nothing is touched; an empty body means the safe default; a body
 * that is not a JSON object is a 400.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAuth(request, "customers:delete");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { id } = await params;

    let hardDelete = false;
    const raw = await request.text();
    if (raw.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
      }
      hardDelete = (body as { hardDelete?: unknown }).hardDelete === true;
    }

    const result = await deleteCustomerData(ctx, id, hardDelete);
    if (!result.success) throw new NotFoundError("Customer");

    return NextResponse.json(result);
  } catch (error) {
    logger.error("Failed to delete customer data:", error);
    return toErrorResponse(error);
  }
}
