import { NextRequest, NextResponse } from "next/server";
import { getEmailStatus, emailAdapter } from "@/lib/channels/email";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { toErrorResponse } from "@/lib/observability/errors";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:read");
  if (!isAuthenticated(ctx)) return ctx;

  const status = getEmailStatus();
  return NextResponse.json(status);
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:update");
  if (!isAuthenticated(ctx)) return ctx;

  const body = await request.json();
  const { action } = body;

  try {
    const db = getScopedPrisma(ctx);
    let connection = await db.channelConnection.findFirst({ where: { type: "email" } });
    if (!connection) {
      connection = await db.channelConnection.create({
        data: { businessId: ctx.businessId, type: "email", name: "Email", isActive: false, config: {} },
      });
    }

    if (action === "connect") {
      await emailAdapter.connect?.(ctx, connection.id);
      const status = getEmailStatus();
      return NextResponse.json(status);
    }

    if (action === "disconnect") {
      await emailAdapter.disconnect?.(ctx, connection.id);
      return NextResponse.json({ status: "disconnected" });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
