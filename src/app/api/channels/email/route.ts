import { NextRequest, NextResponse } from "next/server";
import {
  startEmailListener,
  stopEmailListener,
  getEmailStatus,
} from "@/lib/channels/email";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { assertDefaultBusinessOnly } from "@/lib/default-business";
import { toErrorResponse } from "@/lib/errors";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:read");
  if (!isAuthenticated(ctx)) return ctx;

  const status = getEmailStatus();
  return NextResponse.json(status);
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "channels:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    // Phase 2 runtime-isolation audit finding: the IMAP/SMTP listener is a
    // single, shared, non-tenant-differentiated process-global connection
    // (its credentials come from the legacy global Settings singleton).
    // Without this guard, any authenticated business could start/stop the
    // same shared listener another business's inbound email depends on.
    // Removed once Phase 4/5 give every business its own ChannelConnection-
    // backed email credentials.
    await assertDefaultBusinessOnly(ctx, "Email connect/disconnect");
  } catch (error) {
    return toErrorResponse(error);
  }

  const body = await request.json();
  const { action } = body;

  if (action === "connect") {
    await startEmailListener();
    const status = getEmailStatus();
    return NextResponse.json(status);
  }

  if (action === "disconnect") {
    await stopEmailListener();
    return NextResponse.json({ status: "disconnected" });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
