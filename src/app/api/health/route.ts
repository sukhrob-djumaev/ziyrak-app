import { NextResponse } from "next/server";
import { detail } from "@/lib/ops/health";

export const dynamic = "force-dynamic";

/**
 * Operator summary (L2.1 / F04/F11). The status code follows readiness: 503 when the database is down.
 * Redis loss shows as "degraded" but still answers 200 because the replica keeps serving. No external provider is
 * called from here (the old OpenAI reachability probe read the legacy Settings table, not managed AI).
 */
export async function GET() {
  const d = await detail();
  return NextResponse.json(d, { status: d.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
