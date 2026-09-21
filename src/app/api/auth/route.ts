import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma/raw-client";
import {
  verifyPassword,
  generateToken,
  setAuthCookie,
  clearAuthCookie,
  getCurrentUser,
  isSetupComplete,
} from "@/lib/identity/auth";
import { provisionBusiness } from "@/lib/platform/provisioning";
import { validateBody, signupSchema } from "@/lib/validations";
import { AppError } from "@/lib/observability/errors";
import { logger } from "@/lib/observability/logger";

// POST /api/auth - Login, signup (create a new business), or logout
export async function POST(request: NextRequest) {
  const body = await request.json();
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

    try {
      const { businessId, userId } = await provisionBusiness({
        businessName: validation.data.businessName,
        ownerUsername: validation.data.username,
        ownerPassword: validation.data.password,
        ownerName: validation.data.name,
        businessDesc: validation.data.businessDesc,
        welcomeMessage: validation.data.welcomeMessage,
        tone: validation.data.tone,
      });

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const response = NextResponse.json(
        {
          success: true,
          user: { id: user.id, username: user.username, name: user.name },
          business: { id: businessId, name: validation.data.businessName },
        },
        { status: 201 }
      );
      response.cookies.set(setAuthCookie(generateToken(user.id)));
      return response;
    } catch (error) {
      if (error instanceof AppError) {
        // Username collisions are reported as-is: this endpoint is
        // unauthenticated, but the same fact is already observable through
        // login timing/behavior, and a signup form that cannot say "taken"
        // is unusable.
        return NextResponse.json({ error: error.message }, { status: error.statusCode });
      }
      logger.error("Signup failed:", error);
      return NextResponse.json({ error: "Could not create the business. Please try again." }, { status: 500 });
    }
  }

  if (action === "login") {
    if (!username || !password) {
      return NextResponse.json(
        { error: "Username and password are required" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401 }
      );
    }

    const token = generateToken(user.id);
    const cookie = setAuthCookie(token);

    const response = NextResponse.json({
      success: true,
      user: { id: user.id, username: user.username, name: user.name },
    });
    response.cookies.set(cookie);
    return response;
  }

  if (action === "logout") {
    const cookie = clearAuthCookie();
    const response = NextResponse.json({ success: true });
    response.cookies.set(cookie);
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
  });
}
