import { z } from "zod";
import { prisma } from "@/lib/prisma/raw-client";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import { hasPermission, ROLES } from "@/lib/rbac/rbac";
import type { TenantContext } from "@/lib/tenancy/context";
import { effectiveResourceScope } from "@/lib/tenancy/resource-query";
import { hashPassword } from "@/lib/identity/auth";
import { getMailTransport } from "@/lib/mail/transport";
import { issueAccountToken, peekAccountToken, normalizeEmail } from "@/lib/identity/account-tokens";
import { passwordProblem } from "@/lib/identity/account-service";
import { reserveNewUsername } from "../username-reservation";
import { assertWorkspaceDelegation, parseRequestedScope, INVITABLE_ROLES, type RequestedScope } from "./service";

/**
 * PLAN.md P3 — workspace invitations. An invitation binds one recipient
 * address, one workspace, one role and one access scope, and carries only a
 * hashed single-use token (7 days). Workspace admins manage Membership: they
 * never choose another person's password or touch their global identity. The
 * inviter's authority is re-checked at acceptance (a demoted or removed inviter
 * voids their open invitations), and ownership and platform roles can never be
 * granted. An existing verified account joins by signing in as itself; a new
 * person creates their own credentials and the invited address is verified by
 * possession of the link.
 */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const rank = { none: 0, read: 1, write: 2 } as const;

const input = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.string(), scope: z.unknown().optional() }).strict();

interface InvitationPayload {
  businessId: string;
  role: string;
  scope: RequestedScope;
  inviterUserId: string;
}
const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

export interface InvitationView {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
  scope: RequestedScope;
}

export async function createInvitation(ctx: TenantContext, raw: { email: string; role: string; scope?: unknown }): Promise<InvitationView> {
  assertWorkspaceDelegation(ctx, "admin:create");
  const parsed = input.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Enter a valid email address and role");
  const { email, role } = parsed.data;
  if (role === "owner") throw new AppError(403, "FORBIDDEN", "Ownership is transferred through its own flow, not by invitation");
  if (!ROLES.includes(role as (typeof ROLES)[number]) || !INVITABLE_ROLES.includes(role as (typeof INVITABLE_ROLES)[number]))
    throw new AppError(400, "VALIDATION_ERROR", "Unknown workspace role");
  const actor = effectiveResourceScope(ctx);
  const scope: RequestedScope =
    parsed.data.scope === undefined
      ? { kind: "workspace", customerProfileAccess: actor.customerProfileAccess }
      : parseRequestedScope(parsed.data.scope);
  if (rank[scope.customerProfileAccess] > rank[actor.customerProfileAccess])
    throw new AppError(403, "FORBIDDEN", "Cannot grant more customer-profile access than you hold");
  if (scope.kind === "connections") {
    const known = await prisma.channelConnection.count({ where: { businessId: ctx.businessId, id: { in: scope.connectionIds } } });
    if (known !== scope.connectionIds.length) throw new AppError(400, "VALIDATION_ERROR", "Unknown connection for this workspace");
  }
  const inviterUserId = ctx.actor.kind === "user" ? ctx.actor.userId : "";
  const [business, inviter] = await Promise.all([
    prisma.business.findUniqueOrThrow({ where: { id: ctx.businessId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: inviterUserId }, select: { name: true, username: true } }),
  ]);
  const payload: InvitationPayload = { businessId: ctx.businessId, role, scope, inviterUserId };
  const { token, id } = await issueAccountToken({ purpose: "invitation", email, ttlMs: INVITATION_TTL_MS, payload: payload as never });
  try {
    await getMailTransport().send({
      to: email,
      subject: `You are invited to join ${business.name}`,
      text:
        `${inviter?.name || inviter?.username || "A colleague"} invited you to join "${business.name}" as ${role}.\n\n` +
        `${appUrl()}/accept-invitation?token=${token}\n\n` +
        "The link works once and expires in 7 days. If you were not expecting this, ignore this message.",
    });
  } catch {
    await prisma.accountToken.update({ where: { id }, data: { usedAt: new Date() } });
    throw new AppError(503, "MAIL_UNAVAILABLE", "The invitation email could not be sent. Try again later.");
  }
  const row = await prisma.accountToken.findUniqueOrThrow({ where: { id }, select: { expiresAt: true } });
  return { id, email, role, scope, expiresAt: row.expiresAt };
}

const pendingFor = (businessId: string) => ({
  purpose: "invitation",
  usedAt: null,
  expiresAt: { gt: new Date() },
  payload: { path: ["businessId"], equals: businessId },
});

export async function listInvitations(ctx: TenantContext): Promise<InvitationView[]> {
  assertWorkspaceDelegation(ctx, "admin:create");
  const rows = await prisma.accountToken.findMany({ where: pendingFor(ctx.businessId), orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map((r) => {
    const p = r.payload as unknown as InvitationPayload;
    return { id: r.id, email: r.email, role: p.role, scope: p.scope, expiresAt: r.expiresAt };
  });
}

export async function revokeInvitation(ctx: TenantContext, id: string): Promise<void> {
  assertWorkspaceDelegation(ctx, "admin:delete");
  const result = await prisma.accountToken.updateMany({ where: { id, ...pendingFor(ctx.businessId) }, data: { usedAt: new Date() } });
  if (result.count === 0) throw new NotFoundError("Invitation");
}

export async function previewInvitation(token: string) {
  const row = await peekAccountToken(token, "invitation");
  if (!row) return null;
  const payload = row.payload as InvitationPayload;
  const [business, holder] = await Promise.all([
    prisma.business.findUnique({ where: { id: payload.businessId }, select: { name: true } }),
    prisma.user.findFirst({ where: { email: row.email, emailVerifiedAt: { not: null } }, select: { id: true } }),
  ]);
  if (!business) return null;
  return { email: row.email, role: payload.role, workspaceName: business.name, existingAccount: Boolean(holder) };
}

export type AcceptResult =
  | { ok: true; userId: string; businessId: string }
  | { ok: false; code: "INVALID_LINK" | "SIGN_IN_REQUIRED" | "WRONG_ACCOUNT" | "INVALID_PASSWORD" | "USERNAME_TAKEN" };

class Rollback extends Error {
  constructor(public result: AcceptResult) {
    super("rollback");
  }
}

export async function acceptInvitation(args: {
  token: string;
  /** The signed-in account, if any. */
  sessionUserId?: string;
  /** Credentials for a person with no account yet. */
  signup?: { username: string; password: string; name?: string };
}): Promise<AcceptResult> {
  const row = await peekAccountToken(args.token, "invitation");
  if (!row) return { ok: false, code: "INVALID_LINK" };
  const payload = row.payload as InvitationPayload;
  const email = normalizeEmail(row.email);

  // The inviter must still be able to grant this today.
  const inviter = await prisma.membership.findFirst({ where: { businessId: payload.businessId, userId: payload.inviterUserId } });
  if (
    !inviter ||
    !hasPermission(inviter.role, "admin:create") ||
    inviter.scopeMode !== "workspace" ||
    rank[payload.scope.customerProfileAccess] > rank[inviter.customerProfileAccess as keyof typeof rank]
  )
    return { ok: false, code: "INVALID_LINK" };

  const holder = await prisma.user.findFirst({ where: { email, emailVerifiedAt: { not: null } }, select: { id: true, platformRole: true } });
  if (holder) {
    if (!args.sessionUserId) return { ok: false, code: "SIGN_IN_REQUIRED" };
    if (args.sessionUserId !== holder.id || holder.platformRole) return { ok: false, code: "WRONG_ACCOUNT" };
  } else {
    if (args.sessionUserId) return { ok: false, code: "WRONG_ACCOUNT" };
    if (!args.signup) return { ok: false, code: "INVALID_PASSWORD" };
    if (passwordProblem(args.signup.password)) return { ok: false, code: "INVALID_PASSWORD" };
  }
  const passwordHash = !holder && args.signup ? await hashPassword(args.signup.password) : null;

  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.accountToken.updateMany({
        where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new Rollback({ ok: false, code: "INVALID_LINK" });

      let userId = holder?.id;
      if (!userId) {
        const username = args.signup!.username.trim();
        if (username.length < 3 || username.length > 100 || !/^[A-Za-z0-9._@+-]+$/.test(username))
          throw new Rollback({ ok: false, code: "USERNAME_TAKEN" });
        try {
          await reserveNewUsername(tx, username);
          const user = await tx.user.create({
            data: { username, password: passwordHash!, name: args.signup!.name?.trim() || username, email, emailVerifiedAt: new Date() },
          });
          userId = user.id;
        } catch (error) {
          if (error instanceof AppError || (error as { code?: string }).code === "P2002") throw new Rollback({ ok: false, code: "USERNAME_TAKEN" });
          throw error;
        }
      }
      const existing = await tx.membership.findFirst({ where: { businessId: payload.businessId, userId } });
      if (!existing) {
        const membership = await tx.membership.create({
          data: {
            businessId: payload.businessId,
            userId,
            role: payload.role,
            scopeMode: payload.scope.kind,
            customerProfileAccess: payload.scope.customerProfileAccess,
          },
        });
        if (payload.scope.kind === "connections") {
          const known = await tx.channelConnection.count({ where: { businessId: payload.businessId, id: { in: payload.scope.connectionIds } } });
          if (known !== payload.scope.connectionIds.length) throw new Rollback({ ok: false, code: "INVALID_LINK" });
          await tx.membershipConnectionScope.createMany({
            data: payload.scope.connectionIds.map((connectionId) => ({ businessId: payload.businessId, membershipId: membership.id, connectionId })),
          });
        }
      }
      return { ok: true, userId, businessId: payload.businessId } as AcceptResult;
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result;
    throw error;
  }
}
