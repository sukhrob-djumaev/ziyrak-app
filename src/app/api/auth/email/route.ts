import { NextRequest, NextResponse } from "next/server";
import { requireAccountAuth, isAccountAuthenticated } from "@/lib/identity/account-auth";
import { startEmailChange, readAccountEmail } from "@/lib/identity/account-service";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";

/** PLAN.md P3 — the signed-in person's own email: read it, or add/change it (current password required). */
export async function GET(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return account;
  return NextResponse.json(await readAccountEmail(account.user.id), { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return account;
  const limit = await checkRateLimit(`email-change:${account.user.id}`, { maxRequests: 3, windowMs: 60 * 60 * 1000 });
  if (!limit.allowed) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  const body = await request.json().catch(() => null);
  try {
    const result = await startEmailChange(
      account.user.id,
      typeof body?.email === "string" ? body.email : "",
      typeof body?.password === "string" ? body.password : ""
    );
    if (!result) return NextResponse.json({ error: "Check the email address and your current password." }, { status: 400 });
    return NextResponse.json({ success: true, message: "If the address can be used, a confirmation link is on its way." });
  } catch (error) {
    logger.error("Email change could not send mail", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "The email could not be sent. Try again later." }, { status: 503 });
  }
}
