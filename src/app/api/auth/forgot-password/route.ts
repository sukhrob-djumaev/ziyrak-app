import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requestPasswordReset } from "@/lib/identity/account-service";
import { normalizeEmail } from "@/lib/identity/account-tokens";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * PLAN.md P3 — public. The answer never depends on whether the address exists,
 * is verified or belongs to a platform account. A per-address budget (3 per hour)
 * silently stops mailing but keeps the same answer, so it cannot be used to probe
 * or to flood someone's inbox. The per-client-address limit is applied by the proxy.
 */
const RESPONSE = { success: true, message: "If that address belongs to an account, a reset link is on its way." };

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email : "";
  const normalized = normalizeEmail(email);
  if (normalized && normalized.length <= 254) {
    const key = createHash("sha256").update(normalized).digest("hex");
    const allowed = await checkRateLimit(`pwreset:email:${key}`, { maxRequests: 3, windowMs: 60 * 60 * 1000 });
    if (allowed.allowed) await requestPasswordReset(normalized);
  }
  return NextResponse.json(RESPONSE);
}
