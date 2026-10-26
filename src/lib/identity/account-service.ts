import { prisma } from "@/lib/prisma/raw-client";
import { logger } from "@/lib/observability/logger";
import { getMailTransport } from "@/lib/mail/transport";
import { hashPassword, verifyPassword, sessionCutoff } from "./auth";
import { issueAccountToken, consumeAccountToken, normalizeEmail } from "./account-tokens";

/**
 * PLAN.md P3 — email verification and password recovery. Token lifetimes are
 * the owner-approved defaults: verification 24 h, reset 1 h. Public entry
 * points (`requestPasswordReset`) never reveal whether an address exists: the
 * caller gets the same result for known, unknown, unverified and platform
 * accounts, and mail is dispatched after the response-shaping work, not awaited.
 */
export const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_PASSWORD_TTL_MS = 60 * 60 * 1000;

const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

/** bcrypt only reads the first 72 bytes; refuse anything longer instead of silently truncating. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 200 || Buffer.byteLength(password, "utf8") > 72) return "Password is too long";
  return null;
}

function dispatch(to: string, subject: string, text: string): void {
  void getMailTransport()
    .send({ to, subject, text })
    .catch((error) =>
      logger.error("Platform mail could not be sent", { kind: getMailTransport().kind, error: error instanceof Error ? error.message : String(error) })
    );
}

/** Sends (or re-sends) the verification link for the account's current unverified address. Throws if mail cannot be sent. */
export async function sendVerification(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, emailVerifiedAt: true } });
  if (!user?.email || user.emailVerifiedAt) return;
  const { token } = await issueAccountToken({ purpose: "verify_email", email: user.email, userId: user.id, ttlMs: VERIFY_EMAIL_TTL_MS });
  await getMailTransport().send({
    to: user.email,
    subject: "Confirm your email address",
    text:
      "Confirm your email address to finish setting up your account:\n\n" +
      `${appUrl()}/verify-email?token=${token}\n\n` +
      "The link works once and expires in 24 hours. If you did not create an account, ignore this message.",
  });
}

/** Consumes a verification token. Returns the verified account, or null for any invalid, used, expired or conflicting token. */
export async function confirmEmail(token: string): Promise<{ userId: string } | null> {
  const consumed = await consumeAccountToken({ token, purpose: "verify_email" });
  if (!consumed?.userId) return null;
  const isChange = Boolean((consumed.payload as { change?: boolean } | null)?.change);
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: consumed.userId! },
        select: { id: true, email: true, emailVerifiedAt: true, platformRole: true },
      });
      if (!user || user.platformRole) return null;
      if (!isChange) {
        // Signup link: the address must still be the one the token was issued to.
        if (!user.email || normalizeEmail(user.email) !== consumed.email) return null;
        if (user.emailVerifiedAt) return { userId: user.id };
      }
      // Adopting/changing: possession of the new mailbox (this link) is the proof. The partial
      // unique index on verified addresses makes this the single winner.
      await tx.user.update({ where: { id: user.id }, data: { email: consumed.email, emailVerifiedAt: new Date() } });
      // Paid AI use waits for a verified owner: release the allowances this person owns. An
      // operator suspension is a different status and is never lifted here.
      await tx.workspaceAiAllowance.updateMany({
        where: { status: "pending_verification", business: { memberships: { some: { userId: user.id, role: "owner" } } } },
        data: { status: "active" },
      });
      return { userId: user.id };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return null;
    throw error;
  }
}

/**
 * Self-service: add or change the account's email. Needs the current password (a stolen session
 * cannot bind a new mailbox). Nothing is stored until the link sent to the NEW address is used, and
 * the old verified address keeps working until then. The answer never says whether the address is
 * already taken; the holder of a verified address is warned instead.
 */
export async function startEmailChange(userId: string, rawEmail: string, currentPassword: string): Promise<{ accepted: true } | null> {
  const email = normalizeEmail(String(rawEmail ?? ""));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, password: true, platformRole: true } });
  if (!user || user.platformRole) return null;
  if (typeof currentPassword !== "string" || !(await verifyPassword(currentPassword, user.password))) return null;
  const holder = await prisma.user.findFirst({ where: { email, emailVerifiedAt: { not: null }, id: { not: userId } }, select: { id: true } });
  if (holder) {
    notifyAddressInUse(email);
    return { accepted: true };
  }
  const { token } = await issueAccountToken({ purpose: "verify_email", email, userId, ttlMs: VERIFY_EMAIL_TTL_MS, payload: { change: true } });
  await getMailTransport().send({
    to: email,
    subject: "Confirm your email address",
    text:
      "Confirm this email address for your account:\n\n" +
      `${appUrl()}/verify-email?token=${token}\n\n` +
      "The link works once and expires in 24 hours. If you did not ask for this, ignore this message.",
  });
  return { accepted: true };
}

/** Tells the holder of a verified address that someone tried to register with it. Never reveals anything to the requester. */
export function notifyAddressInUse(email: string): void {
  dispatch(
    email,
    "Someone tried to sign up with your email address",
    "A sign-up was attempted with this email address, which already belongs to an account. " +
      "If it was you, sign in or reset your password instead. If not, you can ignore this message; nothing was created."
  );
}

/** Always resolves with the same value. Mail goes only to a verified, non-platform account. */
export async function requestPasswordReset(email: string): Promise<{ accepted: true }> {
  const normalized = normalizeEmail(String(email ?? ""));
  try {
    const user = normalized
      ? await prisma.user.findFirst({
          where: { email: normalized, emailVerifiedAt: { not: null }, platformRole: null },
          select: { id: true, email: true },
        })
      : null;
    if (user?.email) {
      const { token } = await issueAccountToken({ purpose: "reset_password", email: user.email, userId: user.id, ttlMs: RESET_PASSWORD_TTL_MS });
      dispatch(
        user.email,
        "Reset your password",
        "Use this link to choose a new password:\n\n" +
          `${appUrl()}/reset-password?token=${token}\n\n` +
          "The link works once and expires in 1 hour. Signing in elsewhere will be ended after the change. If you did not ask for this, ignore this message."
      );
    }
  } catch (error) {
    logger.error("Password reset request failed", { error: error instanceof Error ? error.message : String(error) });
  }
  return { accepted: true };
}

/**
 * Sets a new password from a reset token and ends every earlier session. Null for any invalid token or password.
 * F03: claiming the link, changing the password and moving the session cutoff are ONE transaction, so a failure
 * anywhere leaves the link usable, the password unchanged and existing sessions valid, never a half-applied reset.
 * A link whose account no longer qualifies is still consumed (commit with no change), as before.
 */
export async function completePasswordReset(token: string, newPassword: string): Promise<{ userId: string } | null> {
  if (passwordProblem(newPassword)) return null; // validated first so a typo does not burn the link
  const passwordHash = await hashPassword(newPassword); // slow work stays outside the transaction
  return prisma.$transaction(async (tx) => {
    const consumed = await consumeAccountToken({ token, purpose: "reset_password" }, tx);
    if (!consumed?.userId) return null;
    const user = await tx.user.findUnique({
      where: { id: consumed.userId },
      select: { id: true, email: true, emailVerifiedAt: true, platformRole: true },
    });
    if (!user || user.platformRole || !user.emailVerifiedAt || normalizeEmail(user.email ?? "") !== consumed.email) return null;
    await tx.user.update({
      where: { id: user.id },
      data: { password: passwordHash, sessionsValidAfter: sessionCutoff() },
    });
    return { userId: user.id };
  });
}

/** The account's own email state (never another person's). */
export async function readAccountEmail(userId: string): Promise<{ email: string | null; verified: boolean }> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
  return { email: row?.email ?? null, verified: Boolean(row?.emailVerifiedAt) };
}
