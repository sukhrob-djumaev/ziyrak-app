import { NextResponse } from "next/server";
import { readiness } from "@/lib/ops/health";

export const dynamic = "force-dynamic";

/** Readiness: 503 while the database is unreachable, so the replica is taken out of rotation (L2.1 / F04). */
export async function GET() {
  const result = await readiness();
  return NextResponse.json(
    { status: result.ready ? "ready" : "not_ready", checks: result.checks },
    { status: result.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  );
}
