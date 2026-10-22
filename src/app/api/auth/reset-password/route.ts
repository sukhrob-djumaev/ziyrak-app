import { NextRequest, NextResponse } from "next/server";
import { completePasswordReset, passwordProblem } from "@/lib/identity/account-service";

/** PLAN.md P3 — public. One generic answer for every invalid, expired, used or mismatched link. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";
  const password = body?.password;
  const problem = passwordProblem(password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  const result = await completePasswordReset(token, password);
  if (!result) return NextResponse.json({ error: "This link is invalid or has expired." }, { status: 400 });
  return NextResponse.json({ success: true });
}
