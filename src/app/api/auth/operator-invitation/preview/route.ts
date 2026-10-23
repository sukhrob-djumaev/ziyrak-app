import { NextRequest, NextResponse } from "next/server";
import { previewOperatorInvitation } from "@/lib/platform/access/operator-invitations";

/** Public, POST only (the proxy's per-client auth budget applies). One generic answer for any bad link. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const view = await previewOperatorInvitation(typeof body?.token === "string" ? body.token : "");
  if (!view) return NextResponse.json({ error: "This invitation is invalid or has expired." }, { status: 400 });
  return NextResponse.json(view, { headers: { "Cache-Control": "private, no-store" } });
}
