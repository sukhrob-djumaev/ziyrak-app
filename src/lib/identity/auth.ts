import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "@/lib/prisma/raw-client";
import { cookies } from "next/headers";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV !== "test") {
    throw new Error(
      "JWT_SECRET environment variable is required. Set it before starting the application."
    );
  }
  return secret || "test-only-fallback-secret";
}

const JWT_SECRET = getJwtSecret();
const TOKEN_NAME = "owly-token";
const TOKEN_EXPIRY = "7d";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * PLAN.md §14.4 — signs only `{ userId }`, deliberately no role at all.
 * Role is tenant-relative (§9) and resolved fresh per request against
 * current `Membership` data (`route-auth.ts`), never cached in a
 * 7-day-lived token — a revoked/changed membership must take effect
 * immediately, not after the token expires.
 */
export function generateToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token: string): { userId: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { userId: string };
  } catch {
    return null;
  }
}

/**
 * PLAN.md §46.1/§46.2 — identity now lives on `User`, not `Admin`. This
 * returns bare identity only (no role — see `generateToken` above); a
 * request's actual tenant role comes from `requireAuth()`'s `Membership`
 * resolution, not from here.
 */
export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(TOKEN_NAME)?.value;
  if (!token) return null;

  const payload = verifyToken(token);
  if (!payload) return null;

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, username: true, name: true, isPlatformAdmin: true },
  });

  return user;
}

/**
 * PLAN.md §46.1 task 13 / §46.7 task 3 — "does this deployment have any
 * business at all yet" (any `Membership(role: "owner")` exists). Since Phase
 * 7 this is only a first-visit UX hint (`GET /api/auth`'s `setupRequired`);
 * it no longer gates anything — business creation is the repeatable
 * `signup` action (`platform/provisioning.ts`), open to every new business.
 */
export async function isSetupComplete(): Promise<boolean> {
  const ownerCount = await prisma.membership.count({ where: { role: "owner" } });
  return ownerCount > 0;
}

export function setAuthCookie(token: string) {
  return {
    name: TOKEN_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: "/",
  };
}

export function clearAuthCookie() {
  return {
    name: TOKEN_NAME,
    value: "",
    httpOnly: true,
    maxAge: 0,
    path: "/",
  };
}
