import { NextRequest, NextResponse } from "next/server";
import { requireAccountAuth, isAccountAuthenticated } from "@/lib/identity/account-auth";
import { beginEnrollment, confirmEnrollment, mfaEnabled } from "@/lib/identity/mfa";
import { readBoundedJson, AUTH_BODY_BYTES } from "@/lib/http/bounded-body";

/**
 * L1.3: a signed-in platform account manages its own second factor. Works on a limited (no-MFA) session on
 * purpose: that is how a required-mode operator enrolls. The recovery codes are returned once, here.
 */
const noStore = (r: NextResponse) => (r.headers.set("Cache-Control", "private, no-store"), r);

export async function GET(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return noStore(account);
  if (!account.user.platformRole) return noStore(NextResponse.json({ error: "Not available for this account" }, { status: 404 }));
  return noStore(NextResponse.json({ enabled: await mfaEnabled(account.user.id) }));
}

export async function POST(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return noStore(account);
  if (!account.user.platformRole) return noStore(NextResponse.json({ error: "Not available for this account" }, { status: 404 }));
  const body = (await readBoundedJson(request, AUTH_BODY_BYTES).catch(() => null)) as { action?: unknown; code?: unknown; setupCode?: unknown; ownerProof?: unknown } | null;
  if (body?.action === "enroll") {
    const begun = await beginEnrollment(account.user.id, { setupCode: body.setupCode, ownerProof: body.ownerProof });
    if (!begun) return noStore(NextResponse.json({ error: "Enrollment was not authorised. Ask a super admin for a setup code." }, { status: 403 }));
    return noStore(NextResponse.json(begun));
  }
  if (body?.action === "confirm" && typeof body.code === "string") {
    const done = await confirmEnrollment(account.user.id, body.code.trim());
    if (!done) return noStore(NextResponse.json({ error: "That code was not accepted" }, { status: 400 }));
    return noStore(NextResponse.json({ enabled: true, recoveryCodes: done.recoveryCodes }));
  }
  return noStore(NextResponse.json({ error: "Invalid request" }, { status: 400 }));
}
