import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

/** L1.3: platform-account second factor on real Postgres. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { hashPassword } from "@/lib/identity/auth";
import { resetRateLimitsForTesting } from "@/lib/rate-limit";
import { base32Decode, totpAt } from "@/lib/identity/totp";
import { beginEnrollment, confirmEnrollment, checkSecondFactor, resetMfa, loginSecondFactor, mfaEnabled, issueMfaSetupCode } from "@/lib/identity/mfa";

const ids: string[] = [];
async function account(platformRole: "operator" | "super_admin" | null = "operator") {
  const u = await prisma.user.create({
    data: { username: `mfa-${randomUUID()}`, password: await hashPassword("Old-password-123"), name: "T", email: `mfa-${randomUUID()}@example.test`, emailVerifiedAt: new Date(), platformRole },
  });
  ids.push(u.id);
  return u;
}
/** A setup code as a different super admin would issue it. */
const setupFor = async (userId: string) => ({ setupCode: (await issueMfaSetupCode(userId, "issuer-" + randomUUID()))!.setupCode });
const codeFor = (secret: string, atMs = Date.now()) => totpAt(base32Decode(secret), atMs);
async function enrolled() {
  const u = await account();
  const begun = (await beginEnrollment(u.id, await setupFor(u.id)))!;
  const done = (await confirmEnrollment(u.id, codeFor(begun.secret)))!;
  return { u, secret: begun.secret, recovery: done.recoveryCodes };
}

beforeEach(async () => {
  await resetRateLimitsForTesting();
  delete process.env.ZIYRAK_PLATFORM_MFA;
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe("platform MFA enrollment", () => {
  it("only platform accounts can enroll, and the secret is stored encrypted", async () => {
    { const plain = await account(null); expect(await beginEnrollment(plain.id, { setupCode: "AAAA-BBBB" })).toBeNull(); }
    const u = await account();
    const begun = (await beginEnrollment(u.id, await setupFor(u.id)))!;
    expect(begun.otpauthUri).toMatch(/^otpauth:\/\/totp\/Ziyrak:/);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(JSON.stringify(row.mfaPendingSecretRef)).not.toContain(begun.secret);
    expect(row.mfaEnabledAt).toBeNull();
    expect(await mfaEnabled(u.id)).toBe(false);
  });

  it("activates only with a valid code, returns ten recovery codes once, stores only hashes", async () => {
    const u = await account();
    const begun = (await beginEnrollment(u.id, await setupFor(u.id)))!;
    expect(await confirmEnrollment(u.id, "000000")).toBeNull();
    const done = (await confirmEnrollment(u.id, codeFor(begun.secret)))!;
    expect(done.recoveryCodes).toHaveLength(10);
    expect(new Set(done.recoveryCodes).size).toBe(10);
    const stored = await prisma.mfaRecoveryCode.findMany({ where: { userId: u.id } });
    expect(stored).toHaveLength(10);
    for (const c of done.recoveryCodes) expect(stored.some((s) => s.codeHash.includes(c))).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.mfaEnabledAt).not.toBeNull();
    expect(row.mfaPendingSecretRef).toBeNull();
    expect(await beginEnrollment(u.id, { setupCode: "AAAA-BBBB" })).toBeNull(); // an active factor is never silently replaced
  });

  it("needs a valid, unused, unexpired setup code issued by someone else; a password alone is not enough", async () => {
    const u = await account();
    expect(await beginEnrollment(u.id, {})).toBeNull();
    expect(await beginEnrollment(u.id, { setupCode: "AAAA-BBBB-CCCC-DDDD" })).toBeNull();
    expect(await issueMfaSetupCode(u.id, u.id)).toBeNull(); // never self-issued
    const issued = (await issueMfaSetupCode(u.id, "issuer-" + randomUUID()))!;
    const stored = await prisma.mfaSetupCode.findFirstOrThrow({ where: { userId: u.id } });
    expect(stored.codeHash).not.toContain(issued.setupCode);
    expect(await beginEnrollment(u.id, { setupCode: issued.setupCode })).not.toBeNull();
    expect(await beginEnrollment(u.id, { setupCode: issued.setupCode })).toBeNull(); // single use
    const again = (await issueMfaSetupCode(u.id, "issuer-" + randomUUID()))!;
    await prisma.mfaSetupCode.updateMany({ where: { userId: u.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await beginEnrollment(u.id, { setupCode: again.setupCode })).toBeNull(); // expired
  });

  it("a newer code retires the older one, and a code cannot be used for another account", async () => {
    const a = await account();
    const b = await account();
    const first = (await issueMfaSetupCode(a.id, "issuer-x"))!;
    const second = (await issueMfaSetupCode(a.id, "issuer-x"))!;
    expect(await beginEnrollment(a.id, { setupCode: first.setupCode })).toBeNull();
    expect(await beginEnrollment(b.id, { setupCode: second.setupCode })).toBeNull();
    expect(await beginEnrollment(a.id, { setupCode: second.setupCode })).not.toBeNull();
  });

  it("an operator cannot use the platform owner proof in place of a setup code", async () => {
    const op = await account("operator");
    process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256 = (await import("node:crypto")).createHash("sha256").update("owner-proof-xyz").digest("hex");
    try {
      expect(await beginEnrollment(op.id, { ownerProof: "owner-proof-xyz" })).toBeNull();
      expect(await beginEnrollment(op.id, { ownerProof: "wrong-proof" })).toBeNull();
    } finally {
      delete process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256;
    }
  });

  it("lets exactly one of several concurrent confirmations win", async () => {
    const u = await account();
    const begun = (await beginEnrollment(u.id, await setupFor(u.id)))!;
    const code = codeFor(begun.secret);
    const results = await Promise.all([1, 2, 3, 4].map(() => confirmEnrollment(u.id, code)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: u.id } })).toBe(10);
  });
});

describe("second factor verification", () => {
  it("accepts a fresh code once and refuses its replay", async () => {
    const { u, secret } = await enrolled();
    const next = codeFor(secret, Date.now() + 30_000); // enrollment consumed the current step
    expect(await checkSecondFactor(u.id, { code: next })).toBe(true);
    expect(await checkSecondFactor(u.id, { code: next })).toBe(false);
  });

  it("lets only one of concurrent logins with the same code through", async () => {
    const { u, secret } = await enrolled();
    const next = codeFor(secret, Date.now() + 30_000);
    const results = await Promise.all([1, 2, 3, 4].map(() => checkSecondFactor(u.id, { code: next })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("accepts each recovery code exactly once, in any format", async () => {
    const { u, recovery } = await enrolled();
    const sloppy = ` ${recovery[0].toLowerCase().replace("-", " ")} `;
    expect(await checkSecondFactor(u.id, { recoveryCode: sloppy })).toBe(true);
    expect(await checkSecondFactor(u.id, { recoveryCode: recovery[0] })).toBe(false);
    expect(await checkSecondFactor(u.id, { recoveryCode: recovery[1] })).toBe(true);
    expect(await checkSecondFactor(u.id, { recoveryCode: "AAAAA-AAAAA" })).toBe(false);
  });

  it("rate limits guessing per account", async () => {
    const { u, secret } = await enrolled();
    for (let i = 0; i < 8; i++) await checkSecondFactor(u.id, { code: "000000" });
    expect(await checkSecondFactor(u.id, { code: codeFor(secret, Date.now() + 30_000) })).toBe(false);
  });

  it("is false for accounts without a factor or without input", async () => {
    const u = await account();
    expect(await checkSecondFactor(u.id, { code: "123456" })).toBe(false);
    const { u: e } = await enrolled();
    expect(await checkSecondFactor(e.id, {})).toBe(false);
  });
});

describe("reset and login decision", () => {
  it("reset removes the factor and codes and ends sessions; non-platform accounts are untouched", async () => {
    const { u } = await enrolled();
    expect(await resetMfa(u.id)).toBe(true);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row).toMatchObject({ mfaEnabledAt: null, mfaSecretRef: null, mfaLastStep: null });
    expect(row.sessionsValidAfter).not.toBeNull();
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: u.id } })).toBe(0);
    expect(await resetMfa((await account(null)).id)).toBe(false);
  });

  it("login decision: non-platform skips; enrolled challenges, passes or fails; unenrolled depends on mode", async () => {
    const plain = await account(null);
    expect(await loginSecondFactor({ id: plain.id, platformRole: null, mfaEnabledAt: null }, {})).toBe("not_required");

    const { u, secret } = await enrolled();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await loginSecondFactor(row, {})).toBe("challenge");
    expect(await loginSecondFactor(row, { code: "000000" })).toBe("invalid");
    expect(await loginSecondFactor(row, { code: codeFor(secret, Date.now() + 30_000) })).toBe("passed");

    const fresh = await account();
    expect(await loginSecondFactor(fresh, {})).toBe("not_required"); // optional mode
    process.env.ZIYRAK_PLATFORM_MFA = "required";
    expect(await loginSecondFactor(fresh, {})).toBe("enroll");
  });
});
