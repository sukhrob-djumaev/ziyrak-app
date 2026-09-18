import { NextRequest, NextResponse } from "next/server";
import {
  getWhatsAppStatus,
  initWhatsApp,
  disconnectWhatsApp,
} from "@/lib/channels/whatsapp";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { assertDefaultBusinessOnly } from "@/lib/tenancy/default-business";
import { toErrorResponse } from "@/lib/observability/errors";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:read");
  if (!isAuthenticated(ctx)) return ctx;

  const status = getWhatsAppStatus();
  return NextResponse.json(status);
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    // Phase 2 runtime-isolation audit finding: whatsapp-web.js is a single,
    // shared, non-tenant-differentiated process-global session (PLAN.md
    // §20.1 — explicitly not the production multi-tenant WhatsApp path).
    // Without this guard, any authenticated business could connect/
    // disconnect the same shared session another business's inbound
    // messages depend on. Removed once Phase 5's Meta Cloud API adapter
    // gives every business its own real connection.
    await assertDefaultBusinessOnly(ctx, "WhatsApp connect/disconnect");
  } catch (error) {
    return toErrorResponse(error);
  }

  const body = await request.json();
  const { action } = body;

  if (action === "connect") {
    await initWhatsApp();
    // Wait a moment for QR to generate
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = getWhatsAppStatus();
    return NextResponse.json(status);
  }

  if (action === "disconnect") {
    await disconnectWhatsApp();
    return NextResponse.json({ status: "disconnected" });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
