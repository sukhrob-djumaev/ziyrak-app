import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "@/lib/prisma/raw-client";
import { cookies } from "next/headers";
import { randomUUID } from "crypto";

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
  // `jwtid` makes each session individually revocable (see `revokeToken`).
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY, jwtid: randomUUID() });
}

export interface TokenPayload {
  userId: string;
  /** Absent on tokens issued before sessions were revocable; those cannot be revoked and age out within 7 days. */
  jti?: string;
  /** Expiry, seconds since the epoch. */
  exp?: number;
  /** Issued-at, seconds since the epoch (set by the signer). */
  iat?: number;
}

/** Signature and expiry only — no database. See `verifyActiveToken` for the revocation-aware check. */
export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Signature, expiry **and** revocation: the check every place that turns a
 * cookie into an identity uses (API routes, server components, the page gate).
 * One primary-key lookup, and only for tokens that carry a `jti`.
 */
export async function verifyActiveToken(token: string): Promise<TokenPayload | null> {
  const payload = verifyToken(token);
  if (!payload) return null;
  if (payload.jti && (await prisma.revokedToken.findUnique({ where: { jti: payload.jti }, select: { jti: true } }))) return null;
  // P3: a password reset/change ends every session issued before it. A token with no `iat`
  // (never produced by this signer) is treated as issued at the epoch, so it dies at the cutoff.
  const account = await prisma.user.findUnique({ where: { id: payload.userId }, select: { sessionsValidAfter: true } });
  if (account?.sessionsValidAfter && (payload.iat ?? 0) * 1000 < account.sessionsValidAfter.getTime()) return null;
  return payload;
}

/**
 * The session cutoff for a reset/change happening at `now`. Second resolution matches the token's `iat`; the
 * cutoff is the NEXT whole second, so a session minted in the same second as the reset ends too, and signing
 * in again a moment later works. Exposed so a caller can write it in the same statement as the change.
 */
export function sessionCutoff(now: Date = new Date()): Date {
  return new Date(Math.ceil(now.getTime() / 1000) * 1000);
}

/** Ends every session issued to this user before now (password reset/change). */
export async function endAllSessions(userId: string, now: Date = new Date()): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { sessionsValidAfter: sessionCutoff(now) } });
}

/**
 * Ends one session: records the token's `jti` until the token would have
 * expired anyway. Idempotent; a forged, expired or legacy (no `jti`) token is
 * ignored — there is nothing to revoke. The user's other sessions are untouched.
 */
export async function revokeToken(token: string): Promise<boolean> {
  const payload = verifyToken(token);
  if (!payload?.jti || !payload.exp) return false;
  await prisma.revokedToken.upsert({
    where: { jti: payload.jti },
    update: {},
    create: { jti: payload.jti, userId: payload.userId, expiresAt: new Date(payload.exp * 1000) },
  });
  return true;
}

/** Drops revocations whose token has expired on its own (run by the retention sweep). */
export async function purgeExpiredRevokedTokens(): Promise<number> {
  const result = await prisma.revokedToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
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

  const payload = await verifyActiveToken(token);
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
