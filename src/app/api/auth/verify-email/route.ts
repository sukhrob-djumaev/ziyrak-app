import { NextRequest, NextResponse } from "next/server";
import { readBoundedJson, AUTH_BODY_BYTES } from "@/lib/http/bounded-body";
import { confirmEmail } from "@/lib/identity/account-service";

/**
 * PLAN.md P3 — public, POST only: the link opens a page that asks for an explicit
 * confirmation, so a mail scanner that prefetches the URL cannot consume the token.
 */
export async function POST(request: NextRequest) {
  const body = (await readBoundedJson(request, AUTH_BODY_BYTES).catch(() => null)) ?? null;
  const token = typeof body?.token === "string" ? body.token : "";
  const result = await confirmEmail(token);
  if (!result) return NextResponse.json({ error: "This link is invalid or has expired." }, { status: 400 });
  return NextResponse.json({ success: true });
}
