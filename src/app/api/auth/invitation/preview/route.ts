import { NextRequest, NextResponse } from "next/server";
import { previewInvitation } from "@/lib/platform/admin-users/invitations";

/** PLAN.md P3 — public, POST only (the per-address limit applies). One generic answer for any bad link. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const view = await previewInvitation(typeof body?.token === "string" ? body.token : "");
  if (!view) return NextResponse.json({ error: "This invitation is invalid or has expired." }, { status: 400 });
  return NextResponse.json(view, { headers: { "Cache-Control": "private, no-store" } });
}
