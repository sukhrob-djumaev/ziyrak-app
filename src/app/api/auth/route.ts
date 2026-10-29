import { createHash, randomUUID } from "node:crypto";
import { readBoundedJson, AUTH_BODY_BYTES } from "@/lib/http/bounded-body";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma/raw-client";
import {
  verifyPassword,
  hashPassword,
  generateToken,
  setAuthCookie,
  clearAuthCookie,
  getCurrentUser,
  isSetupComplete,
  revokeToken,
} from "@/lib/identity/auth";
import { loginSecondFactor } from "@/lib/identity/mfa";
import { provisionBusiness } from "@/lib/platform/provisioning";
import { sendVerification, notifyAddressInUse } from "@/lib/identity/account-service";
import { checkRateLimit, SIGNUP_LIMITS } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { validateBody, signupSchema } from "@/lib/validations";
import { AppError } from "@/lib/observability/errors";
import { logger } from "@/lib/observability/logger";
import { workspaceCookie, clearWorkspaceCookie } from "@/lib/identity/workspace-cookie";
import { scopeFromRecord } from "@/lib/tenancy/resource-scope";
import { getTenantContextFromCookies } from "@/lib/identity/route-auth";

// POST /api/auth - Login, signup (create a new business), or logout
let dummyHash: Promise<string> | undefined;
/** A throwaway hash at the same cost as real password hashes, created once per process. */
function unknownUserHash(): Promise<string> {
  return (dummyHash ??= hashPassword(randomUUID()));
}

export async function POST(request: NextRequest) {
  const body = (await readBoundedJson(request, AUTH_BODY_BYTES).catch(() => undefined)) as
    | { action?: string; username?: string; password?: string; [k: string]: unknown }
    | undefined;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 });
  }
  const { action, username, password } = body;

  // PLAN.md §46.7 task 3 — repeatable, real multi-business signup: every call
  // creates a brand-new Business (own owner, own placement, own config, own
  // ToolPolicy rows) via `platform/provisioning.ts`. Replaces the old
  // one-time `setup` action that upserted the single "default" business and
  // was blocked for everyone once any owner existed anywhere on the platform.
  if (action === "signup") {
    const validation = validateBody(signupSchema, body);
    if (!validation.success) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // L1.3: bound workspace creation per address and platform-wide before doing any work for this request.
    for (const [key, config] of [
      [`signup-ip:${getClientIp(request)}`, SIGNUP_LIMITS.perAddress],
      ["signup-platform", SIGNUP_LIMITS.platformWide],
    ] as const) {
      const verdict = await checkRateLimit(key, config);
      if (!verdict.allowed) {
        const limited = NextResponse.json(
          { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many sign-ups right now. Please try again later." } },
          { status: 429 }
        );
        limited.headers.set("Retry-After", String(Math.max(1, Math.ceil((verdict.resetAt - Date.now()) / 1000))));
        return limited;
      }
    }

    // PLAN.md P3 — signup never signs anyone in: the answer is the same whether the address is
    // new, unverified elsewhere or already verified by another account, so it cannot be used to
    // learn who has an account. The owner confirms the address by email, then signs in.
    const email = validation.data.email;
    const RESPONSE = {
      success: true,
      verificationRequired: true,
      message: "Check your email to confirm your address, then sign in.",
    };
    try {
      // A taken username is reported before anything about the address is consulted, so the answer
      // never depends on whether the address is verified elsewhere.
      const nameTaken = await prisma.user.findFirst({
        where: { username: { equals: validation.data.username.trim(), mode: "insensitive" } },
        select: { id: true },
      });
      if (nameTaken) return NextResponse.json({ error: "That username is already taken." }, { status: 409 });

      const holder = await prisma.user.findFirst({
        where: { email, emailVerifiedAt: { not: null } },
        select: { id: true },
      });
      // One mail budget per address covers both the warning to a holder and a new verification link.
      const budget = await checkRateLimit(`signup-mail:${createHash("sha256").update(email).digest("hex")}`, {
        maxRequests: 3,
        windowMs: 60 * 60 * 1000,
      });
      if (holder) {
        // Same cost as a real signup's password hashing, so timing does not separate the cases.
        await hashPassword(validation.data.password);
        if (budget.allowed) notifyAddressInUse(email);
        return NextResponse.json(RESPONSE, { status: 202 });
      }
      const { userId } = await provisionBusiness({
        businessName: validation.data.businessName,
        ownerUsername: validation.data.username,
        ownerPassword: validation.data.password,
        ownerName: validation.data.name,
        ownerEmail: email,
        businessDesc: validation.data.businessDesc,
        welcomeMessage: validation.data.welcomeMessage,
        tone: validation.data.tone,
      });
      if (budget.allowed) {
        // Not awaited: mail latency must not separate this path from the contested-address one. The
        // workspace exists either way; the owner can sign in and ask for the link again.
        void sendVerification(userId).catch((error) =>
          logger.error("Signup verification mail failed", { error: error instanceof Error ? error.message : String(error) })
        );
      }
      return NextResponse.json(RESPONSE, { status: 202 });
    } catch (error) {
      if (error instanceof AppError) {
        // Username collisions are reported as-is: this endpoint is
        // unauthenticated, but the same fact is already observable through
        // login timing/behavior, and a signup form that cannot say "taken"
        // is unusable.
        return NextResponse.json({ error: error.message }, { status: error.statusCode });
      }
      logger.error("Signup failed:", error);
      return NextResponse.json(
        { error: "Could not create the business. Please try again." },
        { status: 500 }
      );
    }
  }

  if (action === "login") {
    if (!username || !password) {
      return NextResponse.json({ error: "Username and password are required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      // Spend the same hash work as a wrong password, so response time does not reveal which
      // usernames exist (platform operators included).
      await verifyPassword(password, await unknownUserHash());
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // L1.3: platform accounts add a second factor. A challenge or failure issues no session at all.
    const second = await loginSecondFactor(user, { code: body.mfaCode, recoveryCode: body.recoveryCode });
    if (second === "challenge") {
      return NextResponse.json({ error: "Second factor required", mfaRequired: true }, { status: 401 });
    }
    if (second === "invalid") {
      return NextResponse.json({ error: "Invalid credentials", mfaRequired: true }, { status: 401 });
    }
    const token = generateToken(user.id, { mfa: second === "passed" });
    const cookie = setAuthCookie(token);
    const memberships = await prisma.membership.findMany({
      where: { userId: user.id, business: { status: "active" } },
      include: { connectionScopes: true },
    });
    const eligible = memberships.filter((row) => {
      try {
        scopeFromRecord(row);
        return true;
      } catch {
        return false;
      }
    });
    const selected = eligible.length === 1 ? eligible[0].businessId : null;

    const response = NextResponse.json({
      success: true,
      user: { id: user.id, username: user.username, name: user.name },
      workspaceSelectionRequired: selected === null,
      ...(second === "enroll" ? { mfaEnrollmentRequired: true } : {}),
    });
    response.cookies.set(cookie);
    response.cookies.set(selected ? workspaceCookie(selected) : clearWorkspaceCookie());
    return response;
  }

  if (action === "logout") {
    // End the session server-side, not just in the browser: a copied token must stop working too.
    const presented = request.cookies.get("ziyrak-token")?.value;
    let revocationFailed = false;
    if (presented) {
      try {
        await revokeToken(presented);
      } catch (error) {
        logger.error("Failed to revoke token on logout:", error);
        revocationFailed = true;
      }
    }
    // The browser is signed out either way. If the server could not record it, say so
    // (the token stays valid until it expires) instead of reporting success.
    const response = revocationFailed
      ? NextResponse.json(
          {
            error:
              "Signed out of this browser, but the session could not be ended on the server. Please sign out again.",
          },
          { status: 500 }
        )
      : NextResponse.json({ success: true });
    response.cookies.set(clearAuthCookie());
    response.cookies.set(clearWorkspaceCookie());
    return response;
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

// GET /api/auth - Check auth status
export async function GET() {
  // `setupRequired` is only a UX hint that this deployment has no business
  // at all yet (the login page then lands a first visitor on signup). It is
  // never a gate: signup stays open for every additional business.
  const setupDone = await isSetupComplete();
  if (!setupDone) {
    return NextResponse.json({ authenticated: false, setupRequired: true });
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ authenticated: false, setupRequired: false });
  }

  return NextResponse.json({
    authenticated: true,
    setupRequired: false,
    user,
    workspaceSelectionRequired: (await getTenantContextFromCookies()) === null,
  });
}
