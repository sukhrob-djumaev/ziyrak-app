import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { generateToken, revokeToken } from "@/lib/identity/auth";
import * as audit from "@/lib/platform/access/audit";
import {
  provisionOperator,
  removeOperator,
  assignOperator,
  revokeAssignment,
  readOperatorConsole,
} from "@/lib/platform/access/operators";
import {
  bootstrapPlatform,
  recoverPlatform,
  readPlatformAuthority,
  withPlatformControl,
} from "@/lib/platform/access/authority";

const ids = new Set<string>();
const workspaceIds = new Set<string>();
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
  await prisma.business.deleteMany({ where: { id: { in: [...workspaceIds] } } });
  workspaceIds.clear();
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

async function superAccount() {
  const a = await account();
  await bootstrapPlatform(a.token, enrollment(a.user.id));
  return a;
}
const newOperator = () => ({
  username: "operator-" + randomUUID(),
  password: "Synthetic-operator-" + randomUUID(),
  name: "Synthetic operator",
  reason: "Synthetic operator provision",
});
async function operator(token: string) {
  const input = newOperator();
  const result = await provisionOperator(token, input);
  ids.add(result.id);
  return { user: result, token: generateToken(result.id), input };
}
async function assignmentWorkspace() {
  const workspace = await prisma.business.create({
    data: { slug: "assignment-" + randomUUID(), name: "Synthetic assignment target" },
  });
  workspaceIds.add(workspace.id);
  await prisma.tenantPlacement.create({
    data: {
      businessId: workspace.id,
      databaseProfileId: "shared-default",
      storageProfileId: "local-default",
    },
  });
  const channel = await prisma.channelConnection.create({
    data: {
      businessId: workspace.id,
      type: "webchat",
      name: "Synthetic connection",
      isActive: true,
      credentialRef: "synthetic-private-ref",
      config: { privateFixture: "not-for-console" },
    },
  });
  return { workspace, channel };
}
const assignmentInput = (operatorUserId: string, businessId: string, connectionId: string) => ({
  operatorUserId,
  businessId,
  allowedOperations: ["conversations:read", "messages:read"],
  scope: { kind: "connections", connectionIds: [connectionId], customerProfileAccess: "none" },
  reason: "Synthetic named support assignment",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});
describe("secured operator provisioning and assignments, real Postgres", () => {
  it("creates only a new operator identity, hashes its credential, audits and grants no membership", async () => {
    const a = await superAccount(),
      input = newOperator();
    const result = await provisionOperator(a.token, input);
    ids.add(result.id);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: result.id } });
    const { verifyPassword } = await import("@/lib/identity/auth");
    expect(stored.platformRole).toBe("operator");
    expect(await verifyPassword(input.password, stored.password)).toBe(true);
    expect(await prisma.membership.count({ where: { userId: result.id } })).toBe(0);
    expect(JSON.stringify(result)).not.toContain(input.password);
    expect(result).not.toHaveProperty("password");
    const rows = await prisma.platformAccessAudit.findMany({
      where: { actorUserId: a.user.id, action: "operator.provision" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ targetUserId: result.id });
    expect(JSON.stringify(rows)).not.toContain(input.password);
  });
  it("rejects ordinary/legacy accounts, operators and revoked super sessions", async () => {
    const a = await superAccount(),
      b = await account(true),
      op = await operator(a.token);
    await expect(provisionOperator(b.token, newOperator())).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(provisionOperator(op.token, newOperator())).rejects.toMatchObject({
      statusCode: 403,
    });
    await revokeToken(a.token);
    await expect(provisionOperator(a.token, newOperator())).rejects.toMatchObject({
      statusCode: 401,
    });
  });
  it("never overwrites or promotes an existing identity, including a differently cased username", async () => {
    const a = await superAccount(),
      b = await account();
    await expect(
      provisionOperator(a.token, { ...newOperator(), username: b.user.username.toUpperCase() })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.user.findUnique({ where: { id: b.user.id } })).toMatchObject({
      password: b.user.password,
      platformRole: null,
    });
    for (const extra of [
      { platformRole: "super_admin" },
      { targetUserId: b.user.id },
      { password: "short" },
      { password: "界".repeat(30) },
      { reason: " " },
    ])
      await expect(
        provisionOperator(a.token, { ...newOperator(), ...extra })
      ).rejects.toMatchObject({ statusCode: 400 });
  });
  it("rolls back the new account if audit cannot persist", async () => {
    const a = await superAccount(),
      input = newOperator();
    vi.spyOn(audit, "writePlatformAudit").mockRejectedValueOnce(
      new Error("Synthetic operator audit failure")
    );
    await expect(provisionOperator(a.token, input)).rejects.toThrow(
      "Synthetic operator audit failure"
    );
    expect(await prisma.user.findUnique({ where: { username: input.username } })).toBeNull();
  });
  it("creates an explicit assignment with normalized operations and same-workspace connections", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      { workspace, channel } = await assignmentWorkspace();
    const input = assignmentInput(op.user.id, workspace.id, channel.id);
    const row = await assignOperator(a.token, {
      ...input,
      allowedOperations: [...input.allowedOperations, "messages:read"],
    });
    expect(row).toMatchObject({
      operatorUserId: op.user.id,
      businessId: workspace.id,
      scopeMode: "connections",
      customerProfileAccess: "none",
      reason: input.reason,
    });
    expect(row.allowedOperations).toEqual(input.allowedOperations);
    expect(row.connectionScopes.map((c: { connectionId: string }) => c.connectionId)).toEqual([
      channel.id,
    ]);
    expect(await prisma.membership.count({ where: { userId: op.user.id } })).toBe(0);
    expect(await prisma.supportGrant.count({ where: { actorUserId: op.user.id } })).toBe(0);
    const rows = await prisma.platformAccessAudit.findMany({
      where: { actorUserId: a.user.id, action: "assignment.create" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ businessId: workspace.id, workspaceId: workspace.id });
  });
  it("denies self assignment, inactive workspace, non-operator target and foreign connections", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      x = await assignmentWorkspace(),
      y = await assignmentWorkspace();
    const input = assignmentInput(op.user.id, x.workspace.id, x.channel.id);
    await expect(assignOperator(op.token, input)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      assignOperator(a.token, { ...input, operatorUserId: a.user.id })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      assignOperator(a.token, {
        ...input,
        scope: { ...input.scope, connectionIds: [y.channel.id] },
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    await prisma.business.update({ where: { id: x.workspace.id }, data: { status: "suspended" } });
    await expect(assignOperator(a.token, input)).rejects.toMatchObject({ statusCode: 404 });
    expect(await prisma.platformAssignment.count({ where: { operatorUserId: op.user.id } })).toBe(
      0
    );
  });
  it("fails closed for empty/unknown scope, unapproved operations, malformed or expired assignments", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      x = await assignmentWorkspace();
    const input = assignmentInput(op.user.id, x.workspace.id, x.channel.id);
    for (const extra of [
      { scope: { kind: "connections", connectionIds: [], customerProfileAccess: "none" } },
      { scope: { kind: "unclassified", customerProfileAccess: "none" } },
      { scope: { ...input.scope, unexpected: true } },
      { allowedOperations: ["settings:read"] },
      { allowedOperations: ["admin:create"] },
      { allowedOperations: ["actions:approve"] },
      { allowedOperations: ["messages:create"] },
      { allowedOperations: [] },
      { expiresAt: "invalid" },
      { expiresAt: new Date(0).toISOString() },
      { revokedAt: null },
    ])
      await expect(assignOperator(a.token, { ...input, ...extra })).rejects.toMatchObject({
        statusCode: 400,
      });
  });
  it("requires assignment audit atomically and revokes grants without reviving the assignment", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      x = await assignmentWorkspace();
    const input = assignmentInput(op.user.id, x.workspace.id, x.channel.id);
    vi.spyOn(audit, "writePlatformAudit").mockRejectedValueOnce(
      new Error("Synthetic assignment audit failure")
    );
    await expect(assignOperator(a.token, input)).rejects.toThrow(
      "Synthetic assignment audit failure"
    );
    expect(await prisma.platformAssignment.count({ where: { operatorUserId: op.user.id } })).toBe(
      0
    );
    const row = await assignOperator(a.token, input);
    const grant = await prisma.supportGrant.create({
      data: {
        businessId: x.workspace.id,
        actorUserId: op.user.id,
        assignmentId: row.id,
        requestId: randomUUID(),
        allowedOperations: ["conversations:read"],
        scopeMode: "workspace",
        reason: "Synthetic inactive grant fixture",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      revokeAssignment(op.token, { assignmentId: row.id, reason: "Synthetic self revoke" })
    ).rejects.toMatchObject({ statusCode: 403 });
    vi.spyOn(audit, "writePlatformAudit").mockRejectedValueOnce(
      new Error("Synthetic revocation audit failure")
    );
    await expect(
      revokeAssignment(a.token, { assignmentId: row.id, reason: "Synthetic revoke" })
    ).rejects.toThrow("Synthetic revocation audit failure");
    expect(
      (await prisma.platformAssignment.findUniqueOrThrow({ where: { id: row.id } })).revokedAt
    ).toBeNull();
    expect(
      (await prisma.supportGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt
    ).toBeNull();
    await revokeAssignment(a.token, { assignmentId: row.id, reason: "Synthetic revoke" });
    const revoked = await prisma.platformAssignment.findUniqueOrThrow({ where: { id: row.id } });
    expect(revoked.revokedAt).not.toBeNull();
    expect(
      (await prisma.supportGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt
    ).not.toBeNull();
    await revokeAssignment(a.token, { assignmentId: row.id, reason: "Synthetic repeat revoke" });
    expect(
      (await prisma.platformAssignment.findUniqueOrThrow({ where: { id: row.id } })).revokedAt
    ).toEqual(revoked.revokedAt);
  });
  it("removes operator authority and atomically revokes assignments and grants without changing account credentials", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      x = await assignmentWorkspace();
    const row = await assignOperator(
      a.token,
      assignmentInput(op.user.id, x.workspace.id, x.channel.id)
    );
    const original = await prisma.user.findUniqueOrThrow({ where: { id: op.user.id } });
    vi.spyOn(audit, "writePlatformAudit").mockRejectedValueOnce(
      new Error("Synthetic removal audit failure")
    );
    await expect(
      removeOperator(a.token, { operatorUserId: op.user.id, reason: "Synthetic remove" })
    ).rejects.toThrow("Synthetic removal audit failure");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: op.user.id } })).platformRole).toBe(
      "operator"
    );
    await removeOperator(a.token, { operatorUserId: op.user.id, reason: "Synthetic remove" });
    expect(await prisma.user.findUnique({ where: { id: op.user.id } })).toMatchObject({
      platformRole: null,
      password: original.password,
    });
    expect(
      (await prisma.platformAssignment.findUniqueOrThrow({ where: { id: row.id } })).revokedAt
    ).not.toBeNull();
    await expect(readPlatformAuthority(op.token)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      removeOperator(a.token, { operatorUserId: a.user.id, reason: "Synthetic remove super" })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it("returns only management metadata to super admin, never connection configuration or account credentials", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      x = await assignmentWorkspace();
    await assignOperator(a.token, assignmentInput(op.user.id, x.workspace.id, x.channel.id));
    const result = await readOperatorConsole(a.token);
    expect(result.operators).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: op.user.id })])
    );
    expect(result.workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: x.workspace.id })])
    );
    expect(JSON.stringify(result)).not.toContain("synthetic-private-ref");
    expect(JSON.stringify(result)).not.toContain("not-for-console");
    expect(JSON.stringify(result)).not.toContain(op.input.password);
    expect(result.operators.every((u: object) => !("password" in u))).toBe(true);
    await expect(readOperatorConsole(op.token)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("operator HTTP and concurrent authority", () => {
  function request(
    token?: string,
    body?: object,
    headers: Record<string, string> = {},
    method = "POST"
  ) {
    const r = new NextRequest("http://localhost:3000/api/platform/operators", {
      method,
      headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    if (token) r.cookies.set("owly-token", token);
    return r;
  }
  it("denies anonymous/key/cross-origin requests and returns only no-store management metadata", async () => {
    const { GET, POST } = await import("@/app/api/platform/operators/route");
    const a = await superAccount(),
      b = await account();
    expect((await GET(request(undefined, undefined, {}, "GET"))).status).toBe(401);
    expect((await GET(request(b.token, undefined, {}, "GET"))).status).toBe(403);
    expect(
      (await GET(request(a.token, undefined, { "x-api-key": "synthetic-invalid" }, "GET"))).status
    ).toBe(403);
    const input = { action: "provision", ...newOperator() };
    expect(
      (await POST(request(a.token, input, { origin: "https://foreign.example.invalid" }))).status
    ).toBe(403);
    expect((await POST(request(a.token, input, { "content-type": "text/plain" }))).status).toBe(
      415
    );
    expect((await POST(request(a.token, { ...input, platformRole: "super_admin" }))).status).toBe(
      400
    );
    const result = await POST(request(a.token, input));
    const body = await result.json();
    if (body.result?.id) ids.add(body.result.id);
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toContain("no-store");
    expect(body.result).toMatchObject({ username: input.username, platformRole: "operator" });
    expect(JSON.stringify(body)).not.toContain(input.password);
    const metadata = await GET(request(a.token, undefined, {}, "GET"));
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("Cache-Control")).toContain("no-store");
  });
  it("serializes concurrent case-variant operator creation with one winner", async () => {
    const a = await superAccount(),
      input = newOperator();
    const outcomes = await Promise.allSettled([
      provisionOperator(a.token, input),
      provisionOperator(a.token, { ...input, username: input.username.toUpperCase() }),
    ]);
    for (const r of outcomes) if (r.status === "fulfilled") ids.add(r.value.id);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (outcomes.find((r) => r.status === "rejected") as PromiseRejectedResult).reason
    ).toMatchObject({ statusCode: 409 });
  });
  it("rechecks the super-admin after password hashing and denies a recovered-away actor", async () => {
    const a = await superAccount(),
      b = await account(),
      input = newOperator();
    const auth = await import("@/lib/identity/auth");
    const original = auth.hashPassword;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      hold = new Promise<void>((r) => {
        release = r;
      });
    const spy = vi.spyOn(auth, "hashPassword").mockImplementationOnce(async (password) => {
      entered();
      await hold;
      return original(password);
    });
    try {
      const pending = provisionOperator(a.token, input);
      const denied = expect(pending).rejects.toMatchObject({ statusCode: 403 });
      await ready;
      await recoverPlatform(b.token, {
        targetUserId: b.user.id,
        expectedGeneration: 1,
        proof: recoveryProof,
        reason: "Synthetic recovery during provisioning",
      });
      release();
      await denied;
      expect(await prisma.user.findUnique({ where: { username: input.username } })).toBeNull();
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it("rechecks session revocation after password hashing", async () => {
    const a = await superAccount(),
      input = newOperator();
    const auth = await import("@/lib/identity/auth"),
      original = auth.hashPassword;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      hold = new Promise<void>((r) => {
        release = r;
      });
    const spy = vi.spyOn(auth, "hashPassword").mockImplementationOnce(async (password) => {
      entered();
      await hold;
      return original(password);
    });
    try {
      const pending = provisionOperator(a.token, input);
      const denied = expect(pending).rejects.toMatchObject({ statusCode: 401 });
      await ready;
      await revokeToken(a.token);
      release();
      await denied;
      expect(await prisma.user.findUnique({ where: { username: input.username } })).toBeNull();
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it("validates connection assignment on control plane even when tenant placement is dedicated", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      x = await assignmentWorkspace();
    await prisma.tenantPlacement.update({
      where: { businessId: x.workspace.id },
      data: { databaseProfileId: "synthetic-unavailable-dedicated-profile" },
    });
    const row = await assignOperator(
      a.token,
      assignmentInput(op.user.id, x.workspace.id, x.channel.id)
    );
    expect(row.connectionScopes).toEqual([{ connectionId: x.channel.id }]);
    await prisma.channelConnection.delete({ where: { id: x.channel.id } });
    await expect(
      assignOperator(a.token, assignmentInput(op.user.id, x.workspace.id, x.channel.id))
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      (
        await prisma.platformAssignment.findUniqueOrThrow({
          where: { id: row.id },
          include: { connectionScopes: true },
        })
      ).connectionScopes
    ).toEqual([]);
  });
});

describe("operator names share the public/workspace identity namespace", () => {
  for (const creationPath of ["signup", "workspace"] as const)
    it(`prevents a concurrent case-variant ${creationPath} identity after operator name validation`, async () => {
      const a = await superAccount(),
        x = await assignmentWorkspace(),
        input = newOperator();
      const authority = await import("@/lib/platform/access/authority"),
        original = authority.withPlatformControl;
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => {
          entered = r;
        }),
        hold = new Promise<void>((r) => {
          release = r;
        });
      const spy = vi
        .spyOn(authority, "withPlatformControl")
        .mockImplementationOnce((token, role, callback) =>
          original(token, role, async (tx, actor) => {
            const lookup = tx.user.findFirst.bind(tx.user);
            const nameSpy = vi.spyOn(tx.user, "findFirst").mockImplementationOnce(async (args) => {
              const found = await lookup(args);
              entered();
              await hold;
              return found;
            });
            try {
              return await callback(tx, actor);
            } finally {
              nameSpy.mockRestore();
            }
          })
        );
      let other: Promise<unknown> | undefined, pending: Promise<unknown> | undefined;
      try {
        pending = provisionOperator(a.token, input).then((user) => {
          ids.add(user.id);
          return user;
        });
        await ready;
        let settled = false;
        other = (async () => {
          if (creationPath === "signup") {
            const { provisionBusiness } = await import("@/lib/platform/provisioning");
            const result = await provisionBusiness({
              businessName: "Synthetic namespace race",
              ownerUsername: input.username.toUpperCase(),
              ownerPassword: input.password,
            });
            ids.add(result.userId);
            workspaceIds.add(result.businessId);
            return result;
          }
          const users = await import("@/lib/platform/admin-users/service");
          const result = await users.create(
            {
              businessId: x.workspace.id,
              role: "owner",
              actor: { kind: "user", userId: a.user.id },
              dataConnection: "shared-default",
              resourceScope: { kind: "workspace", customerProfileAccess: "write" },
            },
            { username: input.username.toUpperCase(), password: input.password, role: "viewer" }
          );
          const row = await prisma.user.findUniqueOrThrow({
            where: { username: input.username.toUpperCase() },
          });
          ids.add(row.id);
          return result;
        })();
        const observed = other
          .then(
            (value) => ({ value }),
            (error) => ({ error })
          )
          .finally(() => {
            settled = true;
          });
        // Wait for a real competing commit (old behavior), or the shared name
        // reservation lock (fixed behavior), before releasing the paused operator.
        const deadline = Date.now() + 5000;
        while (!settled && Date.now() < deadline) {
          const rows = await prisma.$queryRaw<
            { waiting: boolean }[]
          >`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=92843 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`;
          if (rows[0]?.waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        release();
        const first = await pending;
        const second = await observed;
        expect(first).toBeTruthy();
        expect(second).toMatchObject({ error: { statusCode: 409 } });
        expect(
          await prisma.user.count({
            where: { username: { equals: input.username, mode: "insensitive" } },
          })
        ).toBe(1);
      } finally {
        release();
        await Promise.allSettled([pending, other].filter(Boolean));
        spy.mockRestore();
      }
    });
});
