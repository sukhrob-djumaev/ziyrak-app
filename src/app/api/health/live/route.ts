import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness: the process answers. Deliberately consults no dependency (L2.1 / F04). */
export function GET() {
  return NextResponse.json({ status: "alive" }, { headers: { "Cache-Control": "no-store" } });
}
