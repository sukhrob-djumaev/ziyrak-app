import { createHash } from "node:crypto";
import { z } from "zod";
import { hashPassword } from "@/lib/identity/auth";
import { issueAccountToken, normalizeEmail, peekAccountToken } from "@/lib/identity/account-tokens";
import { getMailTransport } from "@/lib/mail/transport";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import { prisma } from "@/lib/prisma/raw-client";
import { checkRateLimit } from "@/lib/rate-limit";
import { reserveNewUsername } from "../username-reservation";
import { controlTransaction, withPlatformControl } from "./authority";
import { writePlatformAudit } from "./audit";

/**
 * Operator invitations: a super admin invites a NEW platform identity by email. The link is
 * bound to one recipient and carries only a hashed single-use token (3 days). The invited person
 * chooses their own username and password; acceptance creates the operator inside the platform
 * control lock after re-checking that the inviter is still the current super admin and the control
 * generation is unchanged, so a recovery or a demotion voids every open invitation. An existing
 * account is never promoted, and acceptance signs nobody in: the operator signs in the normal way.
 */
export const OPERATOR_INVITATION_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const reason = z.string().trim().min(1).max(1000);
const inviteInput = z
  .object({ email: z.string().trim().toLowerCase().email().max(254), reason })
  .strict();
const revokeInput = z.object({ invitationId: z.string().min(1).max(128), reason }).strict();
const credentials = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(100)
      .regex(/^[a-zA-Z0-9_.-]+$/),
    password: z
      .string()
      .min(12)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

interface OperatorInvitationPayload {
  inviterUserId: string;
  generation: number;
}
const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const pending = () => ({ purpose: "operator_invitation", usedAt: null, expiresAt: { gt: new Date() } });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid operator invitation request");
  return result.data;
}

export interface OperatorInvitationView {
  id: string;
  email: string;
  expiresAt: Date;
}

export async function inviteOperator(token: string, input: unknown): Promise<OperatorInvitationView> {
  const request = parse(inviteInput, input);
  const issued = await withPlatformControl(token, "super_admin", async (tx, actor) => {
    if (
      await tx.user.findFirst({
        where: { email: request.email },
        select: { id: true },
      })
    )
      throw new AppError(409, "CONFLICT", "That address already belongs to an account. Operators are created from new identities only.");
    if (await tx.accountToken.count({ where: { email: request.email, ...pending() } }))
      throw new AppError(409, "CONFLICT", "An operator invitation for this address is already pending. Revoke it to send a new one.");
    const perActor = await checkRateLimit(`platform-operator-invite:actor:${actor.userId}`, {
      maxRequests: 10,
      windowMs: 60 * 60 * 1000,
    });
    const perAddress = await checkRateLimit(
      `platform-operator-invite:addr:${createHash("sha256").update(request.email).digest("hex")}`,
      { maxRequests: 3, windowMs: 24 * 60 * 60 * 1000 }
    );
    if (!perActor.allowed || !perAddress.allowed)
      throw new AppError(429, "RATE_LIMIT_EXCEEDED", "Too many invitations. Try again later.");
    const payload: OperatorInvitationPayload = { inviterUserId: actor.userId, generation: actor.generation };
    const { token: linkToken, id } = await issueAccountToken({
      purpose: "operator_invitation",
      email: request.email,
      ttlMs: OPERATOR_INVITATION_TTL_MS,
      payload: payload as never,
      tx,
    });
    await writePlatformAudit(tx, {
      actorUserId: actor.userId,
      action: "operator.invite",
      reason: request.reason,
      details: { invitationId: id, email: request.email },
    });
    const row = await tx.accountToken.findUniqueOrThrow({ where: { id }, select: { expiresAt: true } });
    return { linkToken, id, expiresAt: row.expiresAt, actorUserId: actor.userId };
  });
  try {
    await getMailTransport().send({
      to: request.email,
      subject: "You are invited to join the platform team",
      text:
        "You were invited to join the platform operations team.\n\n" +
        `${appUrl()}/accept-operator-invitation?token=${issued.linkToken}\n\n` +
        "The link works once and expires in 3 days. You choose your own username and password. If you were not expecting this, ignore this message.",
    });
  } catch {
    await prisma.accountToken.updateMany({ where: { id: issued.id, usedAt: null }, data: { usedAt: new Date() } });
    await prisma.platformAccessAudit.create({
      data: {
        actorUserId: issued.actorUserId,
        action: "operator.invite.mail_failed",
        reason: request.reason,
        details: { invitationId: issued.id },
      },
    });
    throw new AppError(503, "MAIL_UNAVAILABLE", "The invitation email could not be sent. Try again later.");
  }
  return { id: issued.id, email: request.email, expiresAt: issued.expiresAt };
}

export async function listOperatorInvitations(token: string): Promise<OperatorInvitationView[]> {
  return withPlatformControl(token, "super_admin", async (tx) => {
    const rows = await tx.accountToken.findMany({
      where: pending(),
      select: { id: true, email: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows;
  });
}

export async function revokeOperatorInvitation(token: string, input: unknown): Promise<void> {
  const request = parse(revokeInput, input);
  await withPlatformControl(token, "super_admin", async (tx, actor) => {
    const result = await tx.accountToken.updateMany({
      where: { id: request.invitationId, ...pending() },
      data: { usedAt: new Date() },
    });
    if (result.count !== 1) throw new NotFoundError("Invitation");
    await writePlatformAudit(tx, {
      actorUserId: actor.userId,
      action: "operator.invitation.revoke",
      reason: request.reason,
      details: { invitationId: request.invitationId },
    });
  });
}

/** Public. Reveals only the address the link was sent to. */
export async function previewOperatorInvitation(token: string): Promise<{ email: string } | null> {
  const row = await peekAccountToken(token, "operator_invitation");
  return row ? { email: row.email } : null;
}

export type AcceptOperatorResult =
  | { ok: true; userId: string }
  | { ok: false; code: "INVALID_LINK" | "INVALID_PASSWORD" | "USERNAME_TAKEN" };

class Rollback extends Error {
  constructor(public result: AcceptOperatorResult) {
    super("rollback");
  }
}

export async function acceptOperatorInvitation(args: { token: string; signup: unknown }): Promise<AcceptOperatorResult> {
  const row = await peekAccountToken(args.token, "operator_invitation");
  if (!row) return { ok: false, code: "INVALID_LINK" };
  const parsed = credentials.safeParse(args.signup);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { ok: false, code: field === "username" ? "USERNAME_TAKEN" : "INVALID_PASSWORD" };
  }
  const { username, password, name } = parsed.data;
  const email = normalizeEmail(row.email);
  const payload = row.payload as OperatorInvitationPayload;
  // Expensive hashing stays outside the control lock.
  const passwordHash = await hashPassword(password);
  try {
    return await controlTransaction(async (tx) => {
      const control = await tx.platformControl.findUnique({
        where: { id: "authority" },
        include: { superAdmin: { select: { id: true, platformRole: true } } },
      });
      if (
        !control?.superAdminUserId ||
        control.generation !== payload.generation ||
        control.superAdminUserId !== payload.inviterUserId ||
        control.superAdmin?.platformRole !== "super_admin"
      )
        throw new Rollback({ ok: false, code: "INVALID_LINK" });
      if (await tx.user.findFirst({ where: { email, emailVerifiedAt: { not: null } }, select: { id: true } }))
        throw new Rollback({ ok: false, code: "INVALID_LINK" });
      try {
        await reserveNewUsername(tx, username);
      } catch (error) {
        if (error instanceof AppError) throw new Rollback({ ok: false, code: "USERNAME_TAKEN" });
        throw error;
      }
      const claimed = await tx.accountToken.updateMany({
        where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new Rollback({ ok: false, code: "INVALID_LINK" });
      let userId: string;
      try {
        const user = await tx.user.create({
          data: {
            username,
            password: passwordHash,
            name: name ?? username,
            email,
            emailVerifiedAt: new Date(),
            platformRole: "operator",
          },
          select: { id: true },
        });
        userId = user.id;
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") throw new Rollback({ ok: false, code: "INVALID_LINK" });
        throw error;
      }
      await writePlatformAudit(tx, {
        actorUserId: userId,
        action: "operator.invitation.accept",
        reason: "Operator accepted an emailed invitation",
        details: { invitationId: row.id, inviterUserId: payload.inviterUserId, targetUserId: userId },
      });
      return { ok: true, userId } as AcceptOperatorResult;
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result;
    throw error;
  }
}
