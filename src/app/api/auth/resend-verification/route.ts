import { NextRequest, NextResponse } from "next/server";
import { requireAccountAuth, isAccountAuthenticated } from "@/lib/identity/account-auth";
import { sendVerification } from "@/lib/identity/account-service";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";

/** PLAN.md P3 — a signed-in account re-sends the verification link for its own address (3 per hour). */
export async function POST(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return account;
  const limit = await checkRateLimit(`verify-resend:${account.user.id}`, { maxRequests: 3, windowMs: 60 * 60 * 1000 });
  if (!limit.allowed) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  try {
    await sendVerification(account.user.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Could not send verification mail", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "The email could not be sent. Try again later." }, { status: 503 });
  }
}
