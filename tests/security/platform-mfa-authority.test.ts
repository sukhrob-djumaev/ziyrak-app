import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { NextRequest } from "next/server";

/** L1.3: platform authority requires a session that passed the second factor; login issues the right session. */
vi.mock("@/lib/prisma/raw-client", async (original) => original());
vi.mock("@/lib/identity/route-auth", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { acquirePlatformLock, releasePlatformLock } from "../helpers/policy-lock";
import { generateToken, hashPassword, verifyToken } from "@/lib/identity/auth";
import { bootstrapPlatform, readPlatformAuthority } from "@/lib/platform/access/authority";
import { beginEnrollment, confirmEnrollment, resetMfa } from "@/lib/identity/mfa";
import { base32Decode, totpAt } from "@/lib/identity/totp";
import { resetRateLimitsForTesting } from "@/lib/rate-limit";

const ids = new Set<string>();
const proof = "synthetic-bootstrap-proof-" + randomUUID();
const previousProof = process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256;
const PASSWORD = "Correct-horse-9";

beforeAll(async () => {
  await acquirePlatformLock();
  if (await prisma.platformControl.findUnique({ where: { id: "authority" } }))
    throw new Error("Platform tests require an unconfigured isolated database");
}, 120_000);
afterAll(async () => {
  await releasePlatformLock();
});
beforeEach(async () => {
  process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256 = createHash("sha256").update(proof).digest("hex");
  delete process.env.ZIYRAK_PLATFORM_MFA;
  await resetRateLimitsForTesting();
});
afterEach(async () => {
  const control = await prisma.platformControl.findUnique({ where: { id: "authority" } });
  if (control?.superAdminUserId && !ids.has(control.superAdminUserId)) throw new Error("Refusing cleanup of unowned platform authority");
  if (control) await prisma.platformControl.delete({ where: { id: "authority" } });
  const owned = [...ids];
  await prisma.platformAccessAudit.deleteMany({ where: { actorUserId: { in: owned } } });
  await prisma.revokedToken.deleteMany({ where: { userId: { in: owned } } });
  await prisma.user.deleteMany({ where: { id: { in: owned } } });
  ids.clear();
  if (previousProof === undefined) delete process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256;
  else process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256 = previousProof;
  delete process.env.ZIYRAK_PLATFORM_MFA;
});

async function superAdmin() {
  const user = await prisma.user.create({
    data: { username: "mfa-sa-" + randomUUID(), password: await hashPassword(PASSWORD), name: "Synthetic", isPlatformAdmin: false },
  });
  ids.add(user.id);
  await bootstrapPlatform(generateToken(user.id), { targetUserId: user.id, proof, reason: "Synthetic platform enrollment" });
  return user;
}
async function enroll(userId: string) {
  const begun = (await beginEnrollment(userId))!;
  await confirmEnrollment(userId, totpAt(base32Decode(begun.secret), Date.now()));
  return begun.secret;
}
const login = async (body: Record<string, unknown>) => {
  const { POST } = await import("@/app/api/auth/route");
  const req = new NextRequest("http://localhost:3000/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ action: "login", ...body }),
  });
  return POST(req);
};
const tokenFrom = (res: Response) => /owly-token=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? null;

describe("platform authority and the second factor", () => {
  it("optional mode: an account that has not enrolled keeps working", async () => {
    const u = await superAdmin();
    expect((await readPlatformAuthority(generateToken(u.id))).userId).toBe(u.id);
  });

  it("an enrolled account's password-only session is refused; a second-factor session works", async () => {
    const u = await superAdmin();
    await enroll(u.id);
    await expect(readPlatformAuthority(generateToken(u.id))).rejects.toMatchObject({ statusCode: 403, code: "MFA_REQUIRED" });
    expect((await readPlatformAuthority(generateToken(u.id, { mfa: true }))).userId).toBe(u.id);
  });

  it("required mode: an unenrolled account is refused even with an mfa claim, until it enrolls", async () => {
    const u = await superAdmin();
    process.env.ZIYRAK_PLATFORM_MFA = "required";
    await expect(readPlatformAuthority(generateToken(u.id))).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await expect(readPlatformAuthority(generateToken(u.id, { mfa: true }))).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await enroll(u.id);
    expect((await readPlatformAuthority(generateToken(u.id, { mfa: true }))).userId).toBe(u.id);
  });

  it("a reset ends the account's sessions and returns it to the enrollment state", async () => {
    const u = await superAdmin();
    await enroll(u.id);
    const session = generateToken(u.id, { mfa: true });
    await new Promise((r) => setTimeout(r, 1100));
    await resetMfa(u.id);
    process.env.ZIYRAK_PLATFORM_MFA = "required";
    await expect(readPlatformAuthority(session)).rejects.toMatchObject({ code: "MFA_REQUIRED" });
  });
});

describe("login with a second factor", () => {
  it("enrolled platform account: no session without a code, none for a wrong code, an mfa session for the right one", async () => {
    const u = await superAdmin();
    const secret = await enroll(u.id);

    const challenge = await login({ username: u.username, password: PASSWORD });
    expect(challenge.status).toBe(401);
    expect((await challenge.json()).mfaRequired).toBe(true);
    expect(tokenFrom(challenge)).toBeNull();

    const wrong = await login({ username: u.username, password: PASSWORD, mfaCode: "000000" });
    expect(wrong.status).toBe(401);
    expect(tokenFrom(wrong)).toBeNull();

    const ok = await login({ username: u.username, password: PASSWORD, mfaCode: totpAt(base32Decode(secret), Date.now() + 30_000) });
    expect(ok.status).toBe(200);
    expect(verifyToken(tokenFrom(ok)!)?.mfa).toBe(true);
  });

  it("a wrong password never reveals the second-factor requirement", async () => {
    const u = await superAdmin();
    await enroll(u.id);
    const res = await login({ username: u.username, password: "Wrong-password-1" });
    expect(res.status).toBe(401);
    expect((await res.json()).mfaRequired).toBeUndefined();
  });

  it("ordinary workspace accounts are unaffected", async () => {
    const user = await prisma.user.create({ data: { username: "mfa-plain-" + randomUUID(), password: await hashPassword(PASSWORD), name: "T" } });
    ids.add(user.id);
    const res = await login({ username: user.username, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(verifyToken(tokenFrom(res)!)?.mfa).toBeUndefined();
  });

  it("required mode: an unenrolled platform account gets a limited session flagged for enrollment", async () => {
    const u = await superAdmin();
    process.env.ZIYRAK_PLATFORM_MFA = "required";
    const res = await login({ username: u.username, password: PASSWORD });
    expect(res.status).toBe(200);
    expect((await res.json()).mfaEnrollmentRequired).toBe(true);
    await expect(readPlatformAuthority(tokenFrom(res)!)).rejects.toMatchObject({ code: "MFA_REQUIRED" });
  });
});
