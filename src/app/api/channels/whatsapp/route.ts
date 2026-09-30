import { NextRequest, NextResponse } from "next/server";
import { getWhatsAppStatus, getWhatsAppWebStatus, whatsAppWebAdapter } from "@/lib/channels/whatsapp";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { toErrorResponse } from "@/lib/observability/errors";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:read");
  if (!isAuthenticated(ctx)) return ctx;

  // PLAN.md §20.2 — the shared session's status/QR belongs to the designated
  // dev/demo business only, and only while the feature is enabled.
  try {
    const status = await getWhatsAppWebStatus(ctx);
    return NextResponse.json(status);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:update");
  if (!isAuthenticated(ctx)) return ctx;

  const body = await request.json();
  const { action } = body;

  try {
    // PLAN.md §7.7/§20.2 — resolve (or create) this business's own
    // "whatsapp" ChannelConnection row rather than the old, connectionless
    // `initWhatsApp()` call. `WhatsAppWebAdapter.connect()` itself is what
    // now enforces the Default-Business-only allowlist (§20.2) — this
    // route no longer needs its own separate guard.
    const db = getScopedPrisma(ctx);
    let connection = await db.channelConnection.findFirst({ where: { type: "whatsapp" } });
    if (!connection) {
      connection = await db.channelConnection.create({
        data: { businessId: ctx.businessId, type: "whatsapp", name: "WhatsApp Web", isActive: false, config: {} },
      });
    }

    if (action === "connect") {
      await whatsAppWebAdapter.connect(ctx, connection.id);
      // Wait a moment for QR to generate
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const status = getWhatsAppStatus();
      return NextResponse.json(status);
    }

    if (action === "disconnect") {
      await whatsAppWebAdapter.disconnect?.(ctx);
      return NextResponse.json({ status: "disconnected" });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
