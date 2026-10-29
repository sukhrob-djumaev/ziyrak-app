import { NextRequest, NextResponse } from "next/server";
import { readBoundedJson, AUTH_BODY_BYTES } from "@/lib/http/bounded-body";
import { acceptInvitation } from "@/lib/platform/admin-users/invitations";
import { verifyActiveToken, generateToken, setAuthCookie } from "@/lib/identity/auth";
import { workspaceCookie } from "@/lib/identity/workspace-cookie";

/**
 * PLAN.md P3 — public. A person with an account signs in as themselves first (the session
 * must be the account that owns the invited address); a new person chooses their own
 * username and password. Nobody else ever sets another person's credentials.
 */
const MESSAGES: Record<string, { status: number; message: string }> = {
  INVALID_LINK: { status: 400, message: "This invitation is invalid or has expired." },
  SIGN_IN_REQUIRED: { status: 401, message: "Sign in to your account to accept this invitation." },
  WRONG_ACCOUNT: { status: 403, message: "This invitation was sent to a different account." },
  INVALID_PASSWORD: { status: 400, message: "Choose a password of 8 to 72 characters." },
  USERNAME_TAKEN: { status: 409, message: "Choose a different username." },
  SEAT_LIMIT: { status: 409, message: "This workspace has no free team seat right now. Ask the person who invited you." },
};

export async function POST(request: NextRequest) {
  const body = (await readBoundedJson(request, AUTH_BODY_BYTES).catch(() => null)) ?? null;
  const cookie = request.cookies.get("ziyrak-token")?.value;
  const session = cookie ? await verifyActiveToken(cookie) : null;
  const signup =
    typeof body?.username === "string" && typeof body?.password === "string"
      ? { username: body.username, password: body.password, name: typeof body?.name === "string" ? body.name : undefined }
      : undefined;
  const result = await acceptInvitation({
    token: typeof body?.token === "string" ? body.token : "",
    sessionUserId: session?.userId,
    signup,
  });
  if (!result.ok) {
    const m = MESSAGES[result.code];
    return NextResponse.json({ error: m.message, code: result.code }, { status: m.status });
  }
  const response = NextResponse.json({ success: true });
  if (!session) response.cookies.set(setAuthCookie(generateToken(result.userId)));
  response.cookies.set(workspaceCookie(result.businessId));
  return response;
}
