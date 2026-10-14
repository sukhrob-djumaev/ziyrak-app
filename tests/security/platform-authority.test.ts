import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { generateToken, revokeToken } from "@/lib/identity/auth";
import * as audit from "@/lib/platform/access/audit";
import {
  bootstrapPlatform,
  recoverPlatform,
  readPlatformAuthority,
  withPlatformControl,
} from "@/lib/platform/access/authority";

const ids = new Set<string>();
const bootstrapProof = "synthetic-bootstrap-proof-" + randomUUID();
const recoveryProof = "synthetic-recovery-proof-" + randomUUID();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const previousBootstrap = process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256;
const previousRecovery = process.env.PLATFORM_RECOVERY_PROOF_SHA256;
beforeAll(async () => {
  // This file owns the singleton only in a fresh isolated test database.
  // Never remove or reset another environment's platform authority.
  if (await prisma.platformControl.findUnique({ where: { id: "authority" } }))
    throw new Error("Platform tests require an unconfigured isolated database");
});
beforeEach(() => {
  process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256 = hash(bootstrapProof);
  process.env.PLATFORM_RECOVERY_PROOF_SHA256 = hash(recoveryProof);
});
afterEach(async () => {
  vi.restoreAllMocks();
  const control = await prisma.platformControl.findUnique({ where: { id: "authority" } });
  if (control?.superAdminUserId && !ids.has(control.superAdminUserId))
    throw new Error("Refusing cleanup of unowned platform authority");
  if (control) await prisma.platformControl.delete({ where: { id: "authority" } });
  const owned = [...ids];
  await prisma.platformAccessAudit.deleteMany({ where: { actorUserId: { in: owned } } });
  await prisma.supportGrant.deleteMany({ where: { actorUserId: { in: owned } } });
  await prisma.platformAssignment.deleteMany({ where: { operatorUserId: { in: owned } } });
  await prisma.revokedToken.deleteMany({ where: { userId: { in: owned } } });
  await prisma.user.deleteMany({ where: { id: { in: owned } } });
  ids.clear();
  if (previousBootstrap === undefined) delete process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256;
  else process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256 = previousBootstrap;
  if (previousRecovery === undefined) delete process.env.PLATFORM_RECOVERY_PROOF_SHA256;
  else process.env.PLATFORM_RECOVERY_PROOF_SHA256 = previousRecovery;
});
async function account(flag = false) {
  const user = await prisma.user.create({
    data: {
      username: "platform-fixture-" + randomUUID(),
      password: "unused-synthetic-hash",
      name: "Synthetic platform account",
      isPlatformAdmin: flag,
    },
  });
  ids.add(user.id);
  return { user, token: generateToken(user.id) };
}
const enrollment = (userId: string) => ({
  targetUserId: userId,
  proof: bootstrapProof,
  reason: "Synthetic platform enrollment",
});
describe("platform bootstrap and recovery authority, isolated real Postgres", () => {
  it("enforces the proof-attempt budget across varied forwarded addresses", async () => {
    const { POST } = await import("@/app/api/platform/enrollment/route");
    const a = await account();
    for (let attempt = 0; attempt < 6; attempt++) {
      const req = new NextRequest("http://localhost:3000/api/platform/enrollment", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
          "x-forwarded-for": `198.51.100.${attempt + 1}`,
        },
        body: JSON.stringify({
          action: "bootstrap",
          ...enrollment(a.user.id),
          proof: "synthetic-wrong-proof",
        }),
      });
      req.cookies.set("owly-token", a.token);
      expect((await POST(req)).status).toBe(attempt < 5 ? 403 : 429);
    }
    expect(await prisma.platformControl.count()).toBe(0);
  });
  it("platform enrollment API denies anonymous, API-key, cross-origin and non-JSON requests", async () => {
    const { GET, POST } = await import("@/app/api/platform/enrollment/route");
    const a = await account();
    function req(
      token?: string,
      origin = "http://localhost:3000",
      content = "application/json",
      key = false
    ) {
      const r = new NextRequest("http://localhost:3000/api/platform/enrollment", {
        method: "POST",
        headers: {
          origin,
          "content-type": content,
          ...(key ? { "x-api-key": "not-human-authority" } : {}),
        },
        body: JSON.stringify({ action: "bootstrap", ...enrollment(a.user.id) }),
      });
      if (token) r.cookies.set("owly-token", token);
      return r;
    }
    expect((await GET(req())).status).toBe(401);
    expect((await POST(req(a.token, undefined, undefined, true))).status).toBe(403);
    expect((await POST(req(a.token, "https://foreign.example.invalid"))).status).toBe(403);
    expect((await POST(req(a.token, ""))).status).toBe(403);
    expect((await POST(req(a.token, undefined, "text/plain"))).status).toBe(415);
    expect(await prisma.platformControl.count()).toBe(0);
  });
  it("actual API exposes only self entry state and enrolls the explicitly selected account", async () => {
    const { GET, POST } = await import("@/app/api/platform/enrollment/route");
    const a = await account();
    const get = new NextRequest("http://localhost:3000/api/platform/enrollment");
    get.cookies.set("owly-token", a.token);
    const initial = await GET(get);
    expect(initial.status).toBe(200);
    expect(initial.headers.get("Cache-Control")).toContain("no-store");
    expect(await initial.json()).toMatchObject({
      account: { id: a.user.id, username: a.user.username },
      role: null,
      generation: 0,
      bootstrapAvailable: true,
    });
    const req = new NextRequest("http://localhost:3000/api/platform/enrollment", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ action: "bootstrap", ...enrollment(a.user.id) }),
    });
    req.cookies.set("owly-token", a.token);
    const enrolled = await POST(req);
    expect(enrolled.status).toBe(200);
    expect(await enrolled.json()).toEqual({ success: true, generation: 1 });
    const current = await (await GET(get)).json();
    expect(current).toMatchObject({
      role: "super_admin",
      generation: 1,
      bootstrapAvailable: false,
    });
    expect(JSON.stringify(current)).not.toContain("password");
    expect(JSON.stringify(current)).not.toContain(bootstrapProof);
    expect(JSON.stringify(current)).not.toContain("sessionJti");
  });
  it("API rejects malformed and unknown-action bodies before effects and requires live session on every entry", async () => {
    const { GET, POST } = await import("@/app/api/platform/enrollment/route");
    const a = await account();
    for (const body of [
      "{",
      JSON.stringify({ action: "assign_role", ...enrollment(a.user.id) }),
      JSON.stringify({ action: "bootstrap", ...enrollment(a.user.id), role: "super_admin" }),
    ]) {
      const req = new NextRequest("http://localhost:3000/api/platform/enrollment", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body,
      });
      req.cookies.set("owly-token", a.token);
      expect((await POST(req)).status).toBe(400);
    }
    await revokeToken(a.token);
    const get = new NextRequest("http://localhost:3000/api/platform/enrollment");
    get.cookies.set("owly-token", a.token);
    expect((await GET(get)).status).toBe(401);
    expect(await prisma.platformControl.count()).toBe(0);
  });

  it("refuses legacy non-revocable sessions and rejects extra role fields", async () => {
    const a = await account(true);
    const legacy = jwt.sign({ userId: a.user.id }, process.env.JWT_SECRET!, { expiresIn: "1h" });
    await expect(bootstrapPlatform(legacy, enrollment(a.user.id))).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(
      bootstrapPlatform(a.token, { ...enrollment(a.user.id), platformRole: "super_admin" })
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      bootstrapPlatform(a.token, { ...enrollment(a.user.id), reason: "   " })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await prisma.platformControl.count()).toBe(0);
  });
  it("secured recovery repairs pointer-role drift without reviving old authority", async () => {
    const a = await account(),
      b = await account(),
      c = await account();
    await bootstrapPlatform(a.token, enrollment(a.user.id));
    await prisma.platformControl.update({
      where: { id: "authority" },
      data: { superAdminUserId: b.user.id },
    });
    await recoverPlatform(c.token, {
      targetUserId: c.user.id,
      expectedGeneration: 1,
      proof: recoveryProof,
      reason: "Synthetic drift repair",
    });
    expect(await readPlatformAuthority(c.token)).toMatchObject({
      role: "super_admin",
      generation: 2,
    });
    await expect(readPlatformAuthority(a.token)).rejects.toMatchObject({ statusCode: 403 });
    await expect(readPlatformAuthority(b.token)).rejects.toMatchObject({ statusCode: 403 });
  });
  it("a privileged write queued during real recovery rechecks authority after the commit", async () => {
    const a = await account(),
      b = await account();
    await bootstrapPlatform(a.token, enrollment(a.user.id));
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      hold = new Promise<void>((r) => {
        release = r;
      });
    const original = audit.writePlatformAudit;
    const spy = vi.spyOn(audit, "writePlatformAudit").mockImplementationOnce(async (...args) => {
      entered();
      await hold;
      return original(...args);
    });
    try {
      const recovering = recoverPlatform(b.token, {
        targetUserId: b.user.id,
        expectedGeneration: 1,
        proof: recoveryProof,
        reason: "Synthetic serialized recovery",
      });
      await ready;
      let ran = false;
      const oldWrite = withPlatformControl(a.token, "super_admin", async () => {
        ran = true;
      });
      const denied = expect(oldWrite).rejects.toMatchObject({ statusCode: 403 });
      release();
      await recovering;
      await denied;
      expect(ran).toBe(false);
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it("requires independent configured proof and explicit signed account selection", async () => {
    const a = await account(true),
      b = await account();
    await expect(readPlatformAuthority(a.token)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      bootstrapPlatform(a.token, { ...enrollment(a.user.id), proof: "wrong" })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(bootstrapPlatform(a.token, enrollment(b.user.id))).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(bootstrapPlatform("forged-session", enrollment(a.user.id))).rejects.toMatchObject({
      statusCode: 401,
    });
    delete process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256;
    await expect(bootstrapPlatform(a.token, enrollment(a.user.id))).rejects.toMatchObject({
      statusCode: 403,
    });
    process.env.PLATFORM_BOOTSTRAP_PROOF_SHA256 = "malformed";
    await expect(bootstrapPlatform(a.token, enrollment(a.user.id))).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await prisma.user.findUnique({ where: { id: a.user.id } })).toMatchObject({
      platformRole: null,
    });
    expect(await prisma.platformControl.count()).toBe(0);
    expect(await prisma.platformAccessAudit.count({ where: { actorUserId: a.user.id } })).toBe(0);
  });
  it("enrolls exactly the selected account with an atomic mandatory audit and no tenant membership", async () => {
    const a = await account();
    const result = await bootstrapPlatform(a.token, enrollment(a.user.id));
    expect(result).toMatchObject({ superAdminUserId: a.user.id, generation: 1 });
    expect(await readPlatformAuthority(a.token)).toMatchObject({
      userId: a.user.id,
      role: "super_admin",
      generation: 1,
    });
    expect(await prisma.membership.count({ where: { userId: a.user.id } })).toBe(0);
    const rows = await prisma.platformAccessAudit.findMany({ where: { actorUserId: a.user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "platform.bootstrap",
      reason: enrollment(a.user.id).reason,
    });
    expect(JSON.stringify(rows)).not.toContain(bootstrapProof);
    expect(JSON.stringify(result)).not.toContain(a.token);
  });
  it("serializes competing enrollments with exactly one winner", async () => {
    const a = await account(),
      b = await account();
    const results = await Promise.allSettled([
      bootstrapPlatform(a.token, enrollment(a.user.id)),
      bootstrapPlatform(b.token, enrollment(b.user.id)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ statusCode: 409 });
    expect(
      await prisma.user.count({ where: { id: { in: [...ids] }, platformRole: "super_admin" } })
    ).toBe(1);
    expect(
      await prisma.platformAccessAudit.count({ where: { actorUserId: { in: [...ids] } } })
    ).toBe(1);
  });
  it("rolls back enrollment when mandatory audit persistence fails", async () => {
    const a = await account();
    vi.spyOn(audit, "writePlatformAudit").mockRejectedValueOnce(
      new Error("Synthetic audit unavailable")
    );
    await expect(bootstrapPlatform(a.token, enrollment(a.user.id))).rejects.toThrow(
      "Synthetic audit unavailable"
    );
    expect(await prisma.platformControl.count()).toBe(0);
    expect(await prisma.user.findUnique({ where: { id: a.user.id } })).toMatchObject({
      platformRole: null,
    });
  });
  it("rejects revoked sessions before enrollment and on subsequent authority reads", async () => {
    const a = await account();
    await revokeToken(a.token);
    await expect(bootstrapPlatform(a.token, enrollment(a.user.id))).rejects.toMatchObject({
      statusCode: 401,
    });
    const active = generateToken(a.user.id);
    await bootstrapPlatform(active, enrollment(a.user.id));
    await revokeToken(active);
    await expect(readPlatformAuthority(active)).rejects.toMatchObject({ statusCode: 401 });
  });
  it("requires pointer and fresh role agreement, ignoring historical display flags", async () => {
    const a = await account(),
      b = await account(true);
    await bootstrapPlatform(a.token, enrollment(a.user.id));
    await prisma.platformControl.update({
      where: { id: "authority" },
      data: { superAdminUserId: b.user.id },
    });
    await expect(readPlatformAuthority(a.token)).rejects.toMatchObject({ statusCode: 403 });
    await expect(readPlatformAuthority(b.token)).rejects.toMatchObject({ statusCode: 403 });
  });
  it("recovers with separate proof and generation CAS, atomically retiring displaced grants", async () => {
    const a = await account(),
      b = await account();
    await bootstrapPlatform(a.token, enrollment(a.user.id));
    const workspace = await prisma.business.create({
      data: { slug: "platform-grant-" + randomUUID(), name: "Synthetic recovery target" },
    });
    try {
      const grant = await prisma.supportGrant.create({
        data: {
          businessId: workspace.id,
          actorUserId: a.user.id,
          requestId: randomUUID(),
          allowedOperations: ["conversations:read"],
          scopeMode: "workspace",
          reason: "Synthetic displaced grant",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const recovery = {
        targetUserId: b.user.id,
        expectedGeneration: 1,
        proof: recoveryProof,
        reason: "Synthetic owner recovery",
      };
      await expect(
        recoverPlatform(b.token, { ...recovery, proof: bootstrapProof })
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        recoverPlatform(b.token, { ...recovery, expectedGeneration: 0 })
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await recoverPlatform(b.token, recovery)).toMatchObject({
        superAdminUserId: b.user.id,
        generation: 2,
      });
      expect(await prisma.user.findUnique({ where: { id: a.user.id } })).toMatchObject({
        platformRole: null,
      });
      expect(
        (await prisma.supportGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt
      ).not.toBeNull();
      await expect(readPlatformAuthority(a.token)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        recoverPlatform(a.token, { ...recovery, targetUserId: a.user.id })
      ).rejects.toMatchObject({ statusCode: 409 });
      await prisma.platformAccessAudit.deleteMany({
        where: { businessId: workspace.id, actorUserId: { in: [...ids] } },
      });
      await prisma.supportGrant.deleteMany({
        where: { businessId: workspace.id, actorUserId: { in: [...ids] } },
      });
    } finally {
      await prisma.business.delete({ where: { id: workspace.id } });
    }
  });
  it("rolls back every recovery mutation if audit cannot be stored", async () => {
    const a = await account(),
      b = await account();
    await bootstrapPlatform(a.token, enrollment(a.user.id));
    vi.spyOn(audit, "writePlatformAudit").mockRejectedValueOnce(
      new Error("Synthetic recovery audit failure")
    );
    await expect(
      recoverPlatform(b.token, {
        targetUserId: b.user.id,
        expectedGeneration: 1,
        proof: recoveryProof,
        reason: "Synthetic recovery rollback",
      })
    ).rejects.toThrow("Synthetic recovery audit failure");
    expect(await prisma.platformControl.findUnique({ where: { id: "authority" } })).toMatchObject({
      superAdminUserId: a.user.id,
      generation: 1,
    });
    expect(await prisma.user.findUnique({ where: { id: a.user.id } })).toMatchObject({
      platformRole: "super_admin",
    });
    expect(await prisma.user.findUnique({ where: { id: b.user.id } })).toMatchObject({
      platformRole: null,
    });
  });
  it("rechecks old super-admin authority inside the shared write boundary", async () => {
    const a = await account(),
      b = await account();
    await bootstrapPlatform(a.token, enrollment(a.user.id));
    await recoverPlatform(b.token, {
      targetUserId: b.user.id,
      expectedGeneration: 1,
      proof: recoveryProof,
      reason: "Synthetic race boundary",
    });
    let callbackRan = false;
    await expect(
      withPlatformControl(a.token, "super_admin", async () => {
        callbackRan = true;
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(callbackRan).toBe(false);
  });
  it("serializes concurrent recoveries with one generation winner", async () => {
    const a = await account(),
      b = await account(),
      c = await account();
    await bootstrapPlatform(a.token, enrollment(a.user.id));
    const input = (id: string) => ({
      targetUserId: id,
      expectedGeneration: 1,
      proof: recoveryProof,
      reason: "Synthetic competing recovery",
    });
    const results = await Promise.allSettled([
      recoverPlatform(b.token, input(b.user.id)),
      recoverPlatform(c.token, input(c.user.id)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason
    ).toMatchObject({ statusCode: 409 });
    expect(
      await prisma.user.count({ where: { id: { in: [...ids] }, platformRole: "super_admin" } })
    ).toBe(1);
    expect(await prisma.platformControl.findUnique({ where: { id: "authority" } })).toMatchObject({
      generation: 2,
    });
  });
});
