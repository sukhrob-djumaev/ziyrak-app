import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma/raw-client";
import { Prisma } from "@/generated/prisma/client";
import { getSecretResolver } from "@/lib/secrets/env-key-resolver";
import type { EncryptedSecret } from "@/lib/secrets/types";
import { checkRateLimit } from "@/lib/rate-limit";
import { sessionCutoff } from "./auth";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from "./totp";

/**
 * L1.3: second factor (TOTP + single-use recovery codes) for platform accounts.
 * - Secrets exist only as SecretResolver ciphertext; recovery codes only as SHA-256 hashes.
 * - An accepted TOTP step is recorded and cannot be reused (replay), and attempts are rate limited per account.
 * - `ZIYRAK_PLATFORM_MFA=required` makes platform authority demand a session that passed the second factor;
 *   `optional` (default until the enrollment UI ships) only enforces it for accounts that have enrolled.
 */
export const MFA_ISSUER = "Ziyrak";
const RECOVERY_CODE_COUNT = 10;
const ATTEMPTS = { maxRequests: 8, windowMs: 15 * 60 * 1000 };

export const platformMfaMode = (): "required" | "optional" => (process.env.ZIYRAK_PLATFORM_MFA === "required" ? "required" : "optional");

export function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(7)).slice(0, 10); // 50 bits
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}
const normalizeRecovery = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();
const hashRecovery = (code: string) => createHash("sha256").update(normalizeRecovery(code)).digest("hex");

async function platformUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, email: true, platformRole: true, mfaSecretRef: true, mfaPendingSecretRef: true, mfaEnabledAt: true, mfaLastStep: true },
  });
  return user && user.platformRole ? user : null;
}

async function secretOf(ref: unknown): Promise<Buffer> {
  return base32Decode(await getSecretResolver().decrypt(ref as EncryptedSecret));
}

export async function mfaEnabled(userId: string): Promise<boolean> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabledAt: true } });
  return Boolean(row?.mfaEnabledAt);
}

/** Starts (or restarts) enrollment. The secret is shown once to the account holder; nothing is active until confirmed. */
export async function beginEnrollment(userId: string): Promise<{ secret: string; otpauthUri: string } | null> {
  const user = await platformUser(userId);
  if (!user || user.mfaEnabledAt) return null; // only platform accounts, and never silently replace an active factor
  const secret = generateTotpSecret();
  const text = base32Encode(secret);
  await prisma.user.update({ where: { id: userId }, data: { mfaPendingSecretRef: (await getSecretResolver().encrypt(text)) as object } });
  return { secret: text, otpauthUri: otpauthUri({ secret, account: user.email ?? user.username, issuer: MFA_ISSUER }) };
}

/** Proves possession with a first code, activates the factor and returns the recovery codes (shown once). */
export async function confirmEnrollment(userId: string, code: string): Promise<{ recoveryCodes: string[] } | null> {
  if (!(await checkRateLimit(`mfa-attempt:${userId}`, ATTEMPTS)).allowed) return null;
  const user = await platformUser(userId);
  if (!user || user.mfaEnabledAt || !user.mfaPendingSecretRef) return null;
  const verdict = verifyTotp(await secretOf(user.mfaPendingSecretRef), code, Date.now());
  if (!verdict.ok) return null;
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const activated = await prisma.$transaction(async (tx) => {
    // Conditional on "not yet enabled", so two concurrent confirmations cannot both activate and mint codes.
    const claimed = await tx.user.updateMany({
      where: { id: userId, mfaEnabledAt: null },
      data: {
        mfaSecretRef: user.mfaPendingSecretRef as object,
        mfaPendingSecretRef: Prisma.DbNull,
        mfaEnabledAt: new Date(),
        mfaLastStep: verdict.step,
      },
    });
    if (claimed.count !== 1) return false;
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hashRecovery(c) })) });
    return true;
  });
  return activated ? { recoveryCodes: codes } : null;
}

export type SecondFactorInput = { code?: unknown; recoveryCode?: unknown };

/** Verifies a TOTP code or a recovery code for an enrolled account. Single use, rate limited, constant failure shape. */
export async function checkSecondFactor(userId: string, input: SecondFactorInput): Promise<boolean> {
  if (!(await checkRateLimit(`mfa-attempt:${userId}`, ATTEMPTS)).allowed) return false;
  const user = await platformUser(userId);
  if (!user?.mfaEnabledAt || !user.mfaSecretRef) return false;
  if (typeof input.code === "string" && input.code) {
    const verdict = verifyTotp(await secretOf(user.mfaSecretRef), input.code.trim(), Date.now(), { afterStep: user.mfaLastStep ?? undefined });
    if (!verdict.ok) return false;
    // Atomic: two concurrent logins with the same code cannot both advance the step.
    const advanced = await prisma.user.updateMany({
      where: { id: userId, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: verdict.step } }] },
      data: { mfaLastStep: verdict.step },
    });
    return advanced.count === 1;
  }
  if (typeof input.recoveryCode === "string" && input.recoveryCode) {
    const hash = hashRecovery(input.recoveryCode);
    const candidates = await prisma.mfaRecoveryCode.findMany({ where: { userId, usedAt: null }, select: { id: true, codeHash: true } });
    const match = candidates.find((c) => {
      const a = Buffer.from(c.codeHash);
      const b = Buffer.from(hash);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!match) return false;
    const used = await prisma.mfaRecoveryCode.updateMany({ where: { id: match.id, usedAt: null }, data: { usedAt: new Date() } });
    return used.count === 1;
  }
  return false;
}

/** Removes the factor (lost device, offboarding) and ends the account's sessions. The caller authorises and audits. */
export async function resetMfa(targetUserId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: targetUserId }, select: { id: true, platformRole: true } });
    if (!target?.platformRole) return false;
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: targetUserId } });
    await tx.user.update({
      where: { id: targetUserId },
      data: { mfaSecretRef: Prisma.DbNull, mfaPendingSecretRef: Prisma.DbNull, mfaEnabledAt: null, mfaLastStep: null, sessionsValidAfter: sessionCutoff() },
    });
    return true;
  });
}

export type LoginMfaOutcome = "not_required" | "passed" | "challenge" | "invalid" | "enroll";

/**
 * Decides what login must do after the password was accepted.
 * `challenge`: enrolled but no code supplied. `invalid`: a code was supplied and failed. `enroll`: mode is
 * required and the account has no factor yet (it gets a limited session that can only enroll).
 */
export async function loginSecondFactor(
  user: { id: string; platformRole: string | null; mfaEnabledAt: Date | null },
  input: SecondFactorInput
): Promise<LoginMfaOutcome> {
  if (!user.platformRole) return "not_required";
  if (user.mfaEnabledAt) {
    const supplied = (typeof input.code === "string" && input.code) || (typeof input.recoveryCode === "string" && input.recoveryCode);
    if (!supplied) return "challenge";
    return (await checkSecondFactor(user.id, input)) ? "passed" : "invalid";
  }
  return platformMfaMode() === "required" ? "enroll" : "not_required";
}
