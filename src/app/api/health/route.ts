import { NextRequest, NextResponse } from "next/server";
import { detail, detailAllowed } from "@/lib/ops/health";

export const dynamic = "force-dynamic";

/**
 * Operator summary (L2.1 / F04/F11). The status code follows readiness: 503 when the database is down. Redis loss
 * or an absent worker shows as "degraded" but still answers 200 because the replica keeps serving. No external
 * provider is called from here. Build identity, worker/queue facts and memory are returned only to a caller that
 * presents HEALTH_DETAIL_TOKEN in `x-health-token`; everyone else gets status and dependency states only.
 */
export async function GET(request: NextRequest) {
  const d = await detail(detailAllowed(request.headers.get("x-health-token")));
  return NextResponse.json(d, { status: d.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
