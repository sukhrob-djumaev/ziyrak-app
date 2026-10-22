import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma/raw-client";
import type { Prisma } from "@/generated/prisma/client";

/**
 * PLAN.md P3 — expiring, single-use account tokens (email verification,
 * password reset, invitation). A token is 256 random bits; only its SHA-256 is
 * stored, so a database read never yields a usable link. Consumption is one
 * conditional update (unused, unexpired, right purpose, right recipient when
 * given), so concurrent or replayed use succeeds at most once. A wrong-purpose
 * or wrong-recipient attempt does not consume the token. Issuing a new token of
 * the same purpose and recipient invalidates the older ones.
 */
export type AccountTokenPurpose = "verify_email" | "reset_password" | "invitation";

export interface IssueInput {
  purpose: AccountTokenPurpose;
  email: string;
  ttlMs: number;
  userId?: string;
  payload?: Prisma.InputJsonValue;
}

export interface ConsumedToken {
  id: string;
  purpose: AccountTokenPurpose;
  email: string;
  userId: string | null;
  payload: unknown;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function issueAccountToken(input: IssueInput): Promise<{ token: string; id: string }> {
  const token = randomBytes(32).toString("base64url");
  const email = normalizeEmail(input.email);
  const row = await prisma.$transaction(async (tx) => {
    // Older unused tokens for the same purpose and recipient stop working (invitations are per
    // invite, so they keep their own lifetime).
    if (input.purpose !== "invitation") {
      await tx.accountToken.updateMany({
        where: { purpose: input.purpose, email, usedAt: null },
        data: { usedAt: new Date() },
      });
    }
    return tx.accountToken.create({
      data: {
        purpose: input.purpose,
        tokenHash: hashToken(token),
        userId: input.userId ?? null,
        email,
        payload: input.payload,
        expiresAt: new Date(Date.now() + input.ttlMs),
      },
      select: { id: true },
    });
  });
  return { token, id: row.id };
}

export async function consumeAccountToken(input: {
  token: string;
  purpose: AccountTokenPurpose;
  /** When given, the token must have been issued to this address. */
  email?: string;
}): Promise<ConsumedToken | null> {
  if (typeof input.token !== "string" || input.token.length < 20 || input.token.length > 200) return null;
  const tokenHash = hashToken(input.token);
  const now = new Date();
  const claimed = await prisma.accountToken.updateMany({
    where: {
      tokenHash,
      purpose: input.purpose,
      usedAt: null,
      expiresAt: { gt: now },
      ...(input.email ? { email: normalizeEmail(input.email) } : {}),
    },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) return null;
  const row = await prisma.accountToken.findUnique({ where: { tokenHash } });
  if (!row) return null;
  return { id: row.id, purpose: row.purpose as AccountTokenPurpose, email: row.email, userId: row.userId, payload: row.payload };
}

export async function purgeExpiredAccountTokens(now: Date = new Date()): Promise<number> {
  const result = await prisma.accountToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
  });
  return result.count;
}
