import { NextRequest, NextResponse } from "next/server";
import { acceptOperatorInvitation } from "@/lib/platform/access/operator-invitations";

/**
 * Public. The invited person chooses their own username and password; nobody else ever sets
 * platform credentials. Acceptance creates the operator and signs nobody in: the operator then
 * signs in through the normal login.
 */
const MESSAGES: Record<string, { status: number; message: string }> = {
  INVALID_LINK: { status: 400, message: "This invitation is invalid or has expired." },
  INVALID_PASSWORD: { status: 400, message: "Choose a password of 12 to 72 bytes." },
  USERNAME_TAKEN: { status: 409, message: "Choose a different username (letters, numbers, . _ -)." },
};

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const result = await acceptOperatorInvitation({
    token: typeof body?.token === "string" ? body.token : "",
    signup: { username: body?.username, password: body?.password, ...(body?.name ? { name: body.name } : {}) },
  });
  const headers = { "Cache-Control": "private, no-store" };
  if (!result.ok) {
    const m = MESSAGES[result.code];
    return NextResponse.json({ error: m.message, code: result.code }, { status: m.status, headers });
  }
  return NextResponse.json({ success: true }, { headers });
}
