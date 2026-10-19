import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma/raw-client";
import { verifyToken, type TokenPayload } from "@/lib/identity/auth";
import { AppError } from "@/lib/observability/errors";
import { writePlatformAudit } from "./audit";

/** PLAN P1: explicit platform authority; no membership or tenant data bypass. */
export interface PlatformAuthority {
  userId: string;
  role: "super_admin" | "operator";
  generation: number;
  sessionJti: string;
  sessionExpiresAt: number;
}
type RevocableSession = TokenPayload & { jti: string; exp: number };
const selectedAccount = z
  .object({
    targetUserId: z.string().min(1).max(128),
    proof: z.string().min(1).max(4096),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
const recovery = selectedAccount.extend({ expectedGeneration: z.number().int().nonnegative() });

function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", "Invalid platform request");
  return result.data;
}
function signedSession(token: string): RevocableSession {
  const payload = typeof token === "string" ? verifyToken(token) : null;
  if (
    !payload ||
    typeof payload.userId !== "string" ||
    !payload.userId ||
    typeof payload.jti !== "string" ||
    !payload.jti ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.exp * 1000 <= Date.now()
  )
    throw new AppError(401, "UNAUTHORIZED", "A current revocable person session is required");
  return payload as RevocableSession;
}
function ownerProof(kind: "BOOTSTRAP" | "RECOVERY", proof: string) {
  const expected = process.env[`PLATFORM_${kind}_PROOF_SHA256`];
  if (!expected || !/^[a-fA-F0-9]{64}$/.test(expected))
    throw new AppError(403, "FORBIDDEN", "Platform enrollment proof is unavailable or invalid");
  const actual = createHash("sha256").update(proof).digest();
  if (!timingSafeEqual(actual, Buffer.from(expected, "hex")))
    throw new AppError(403, "FORBIDDEN", "Platform enrollment proof is unavailable or invalid");
}
async function currentAccount(tx: Prisma.TransactionClient, session: RevocableSession) {
  if (
    session.exp * 1000 <= Date.now() ||
    (await tx.revokedToken.findUnique({ where: { jti: session.jti }, select: { jti: true } }))
  )
    throw new AppError(401, "UNAUTHORIZED", "The person session has ended");
  const user = await tx.user.findUnique({
    where: { id: session.userId },
    select: { id: true, platformRole: true },
  });
  if (!user) throw new AppError(401, "UNAUTHORIZED", "The person account is unavailable");
  return user;
}
/** Shared serialization boundary for bootstrap/recovery and privileged control writes. */
async function controlTransaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(92842, 0)`;
      return callback(tx);
    },
    { isolationLevel: "ReadCommitted", timeout: 10_000 }
  );
}
async function currentAuthority(
  tx: Prisma.TransactionClient,
  session: RevocableSession
): Promise<PlatformAuthority> {
  const user = await currentAccount(tx, session);
  const control = await tx.platformControl.findUnique({
    where: { id: "authority" },
    include: { superAdmin: { select: { platformRole: true } } },
  });
  if (
    !control?.superAdminUserId ||
    control.generation < 1 ||
    control.superAdmin?.platformRole !== "super_admin" ||
    !user.platformRole ||
    (user.platformRole === "super_admin" && control.superAdminUserId !== user.id)
  )
    throw new AppError(403, "FORBIDDEN", "Current platform authority is required");
  return {
    userId: user.id,
    role: user.platformRole,
    generation: control.generation,
    sessionJti: session.jti,
    sessionExpiresAt: session.exp,
  };
}
export async function withPlatformControl<T>(
  token: string,
  requiredRole: "super_admin" | "any",
  callback: (tx: Prisma.TransactionClient, actor: PlatformAuthority) => Promise<T>
): Promise<T> {
  const session = signedSession(token);
  return controlTransaction(async (tx) => {
    const actor = await currentAuthority(tx, session);
    if (requiredRole === "super_admin" && actor.role !== "super_admin")
      throw new AppError(403, "FORBIDDEN", "Super admin authority is required");
    return callback(tx, actor);
  });
}
export async function readPlatformAuthority(token: string): Promise<PlatformAuthority> {
  return withPlatformControl(token, "any", async (_tx, actor) => actor);
}
/** Self-only entry metadata; this grants neither management nor tenant access. */
export async function readPlatformEntry(token: string) {
  const session = signedSession(token);
  return controlTransaction(async (tx) => {
    const user = await currentAccount(tx, session);
    const account = await tx.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { id: true, username: true, name: true },
    });
    const control = await tx.platformControl.findUnique({
      where: { id: "authority" },
      include: { superAdmin: { select: { platformRole: true } } },
    });
    const valid =
      !!control?.superAdminUserId &&
      control.generation > 0 &&
      control.superAdmin?.platformRole === "super_admin";
    const role =
      valid &&
      (user.platformRole === "operator" ||
        (user.platformRole === "super_admin" && control.superAdminUserId === user.id))
        ? user.platformRole
        : null;
    const configured = (kind: "BOOTSTRAP" | "RECOVERY") =>
      /^[a-fA-F0-9]{64}$/.test(process.env[`PLATFORM_${kind}_PROOF_SHA256`] ?? "");
    const generation = control?.generation ?? 0;
    const existingSuper = await tx.user.findFirst({
      where: { platformRole: "super_admin" },
      select: { id: true },
    });
    return {
      account,
      role,
      generation,
      bootstrapAvailable:
        !control?.superAdminUserId && generation === 0 && !existingSuper && configured("BOOTSTRAP"),
      recoveryAvailable: generation > 0 && configured("RECOVERY"),
    };
  });
}
export async function bootstrapPlatform(token: string, input: unknown) {
  const session = signedSession(token),
    request = validated(selectedAccount, input);
  if (request.targetUserId !== session.userId)
    throw new AppError(403, "FORBIDDEN", "Select your signed-in account");
  ownerProof("BOOTSTRAP", request.proof);
  return controlTransaction(async (tx) => {
    const user = await currentAccount(tx, session);
    const control = await tx.platformControl.upsert({
      where: { id: "authority" },
      create: { id: "authority" },
      update: {},
    });
    if (
      control.superAdminUserId ||
      control.generation !== 0 ||
      (await tx.user.findFirst({ where: { platformRole: "super_admin" }, select: { id: true } }))
    )
      throw new AppError(
        409,
        "ALREADY_ENROLLED",
        "Platform enrollment already exists; use secured recovery"
      );
    await tx.user.update({ where: { id: user.id }, data: { platformRole: "super_admin" } });
    const result = await tx.platformControl.update({
      where: { id: "authority" },
      data: { superAdminUserId: user.id, generation: 1 },
      select: { superAdminUserId: true, generation: true },
    });
    await writePlatformAudit(tx, {
      actorUserId: user.id,
      action: "platform.bootstrap",
      reason: request.reason,
      details: { targetUserId: user.id, generation: 1, previousRole: user.platformRole },
    });
    return result;
  });
}
export async function recoverPlatform(token: string, input: unknown) {
  const session = signedSession(token),
    request = validated(recovery, input);
  if (request.targetUserId !== session.userId)
    throw new AppError(403, "FORBIDDEN", "Select your signed-in account");
  ownerProof("RECOVERY", request.proof);
  return controlTransaction(async (tx) => {
    const user = await currentAccount(tx, session);
    const control = await tx.platformControl.findUnique({ where: { id: "authority" } });
    if (!control || control.generation < 1 || control.generation !== request.expectedGeneration)
      throw new AppError(
        409,
        "STALE_GENERATION",
        "Platform authority changed; refresh before recovery"
      );
    // The separately authorized recovery also repairs pointer/role drift. The
    // database's partial unique constraint allows at most one actual super role.
    const actual = await tx.user.findMany({
      where: { platformRole: "super_admin" },
      select: { id: true },
    });
    const displaced = [
      ...new Set([
        ...actual.map((row) => row.id),
        ...(control.superAdminUserId ? [control.superAdminUserId] : []),
      ]),
    ];
    await tx.user.updateMany({
      where: { id: { in: displaced }, platformRole: "super_admin" },
      data: { platformRole: null },
    });
    await tx.supportGrant.updateMany({
      where: { actorUserId: { in: displaced }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.user.update({ where: { id: user.id }, data: { platformRole: "super_admin" } });
    const generation = control.generation + 1;
    const result = await tx.platformControl.update({
      where: { id: "authority", generation: request.expectedGeneration },
      data: { superAdminUserId: user.id, generation },
      select: { superAdminUserId: true, generation: true },
    });
    await writePlatformAudit(tx, {
      actorUserId: user.id,
      action: "platform.recovery",
      reason: request.reason,
      details: {
        targetUserId: user.id,
        displacedUserIds: displaced,
        previousGeneration: control.generation,
        generation,
        previousRole: user.platformRole,
      },
    });
    return result;
  });
}
