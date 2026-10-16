import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
vi.mock("@/lib/identity/route-auth", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { generateToken, revokeToken } from "@/lib/identity/auth";
import * as audit from "@/lib/platform/access/audit";
import {
  issueSupportGrant,
  revokeSupportGrant,
  authorizeSupportUse,
} from "@/lib/platform/access/grants";
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

const grantRequest = (businessId: string, connectionId: string, assignmentId?: string) => ({
  businessId,
  ...(assignmentId ? { assignmentId } : {}),
  requestId: randomUUID(),
  allowedOperations: ["conversations:read", "messages:read"],
  scope: { kind: "connections", connectionIds: [connectionId], customerProfileAccess: "none" },
  reason: "Synthetic explicit support grant",
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
});
describe("explicit support grant lifecycle, admission remains unavailable", () => {
  it("requires explicit actor/workspace/scope/reason/lifetime and creates no membership", async () => {
    const a = await superAccount(),
      x = await assignmentWorkspace();
    const request = grantRequest(x.workspace.id, x.channel.id);
    const grant = await issueSupportGrant(a.token, request);
    expect(grant).toMatchObject({
      actorUserId: a.user.id,
      businessId: x.workspace.id,
      assignmentId: null,
      allowedOperations: request.allowedOperations,
      scopeMode: "connections",
      customerProfileAccess: "none",
      reason: request.reason,
    });
    expect(grant.connectionScopes).toEqual([{ connectionId: x.channel.id }]);
    expect(await prisma.membership.count({ where: { userId: a.user.id } })).toBe(0);
    const auditRows = await prisma.platformAccessAudit.findMany({ where: { grantId: grant.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actorUserId: a.user.id,
      businessId: x.workspace.id,
      workspaceId: x.workspace.id,
      action: "support.issue",
      reason: request.reason,
    });
    expect(auditRows[0].details).toMatchObject({
      grantId: grant.id,
      allowedOperations: request.allowedOperations,
      expiresAt: request.expiresAt,
    });
    expect(JSON.stringify(grant)).not.toContain(a.token);
  });
  it("operator issuance requires a current exact assignment and cannot widen its operations/scope/profile/lifetime", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      x = await assignmentWorkspace(),
      y = await assignmentWorkspace();
    const assignment = await assignOperator(
      a.token,
      assignmentInput(op.user.id, x.workspace.id, x.channel.id)
    );
    const request = grantRequest(x.workspace.id, x.channel.id, assignment.id);
    for (const extra of [
      { assignmentId: undefined },
      { assignmentId: randomUUID() },
      { businessId: y.workspace.id },
      { allowedOperations: ["tickets:read"] },
      { scope: { kind: "workspace", customerProfileAccess: "none" } },
      { scope: { ...request.scope, customerProfileAccess: "read" } },
      { scope: { ...request.scope, connectionIds: [y.channel.id] } },
      { expiresAt: new Date(assignment.expiresAt!.getTime() + 1000).toISOString() },
    ])
      await expect(issueSupportGrant(op.token, { ...request, ...extra })).rejects.toMatchObject({
        statusCode: 403,
      });
    expect(await prisma.supportGrant.count({ where: { actorUserId: op.user.id } })).toBe(0);
    const grant = await issueSupportGrant(op.token, request);
    expect(grant.assignmentId).toBe(assignment.id);
    expect(grant.actorUserId).toBe(op.user.id);
    await expect(issueSupportGrant(a.token, request)).rejects.toMatchObject({ statusCode: 403 });
  });
  it("denies foreign channels, inactive workspace, unknown operation/scope and invalid lifetime", async () => {
    const a = await superAccount(),
      x = await assignmentWorkspace(),
      y = await assignmentWorkspace();
    const request = grantRequest(x.workspace.id, x.channel.id);
    await expect(
      issueSupportGrant(a.token, {
        ...request,
        scope: { ...request.scope, connectionIds: [y.channel.id] },
      })
    ).rejects.toMatchObject({ statusCode: 404 });
    for (const extra of [
      { actorUserId: a.user.id },
      { reason: " " },
      { expiresAt: "invalid" },
      { expiresAt: new Date(0).toISOString() },
      { expiresAt: new Date(Date.now() + 25 * 3600_000).toISOString() },
      { allowedOperations: ["admin:create"] },
      { allowedOperations: ["messages:create"] },
      { scope: { kind: "unclassified", customerProfileAccess: "none" } },
      { scope: { kind: "connections", customerProfileAccess: "none", connectionIds: [] } },
    ])
      await expect(issueSupportGrant(a.token, { ...request, ...extra })).rejects.toMatchObject({
        statusCode: 400,
      });
    await prisma.business.update({ where: { id: x.workspace.id }, data: { status: "suspended" } });
    await expect(issueSupportGrant(a.token, request)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("identical UUID replay is idempotent and changed payload conflicts without extending the grant", async () => {
    const a = await superAccount(),
      x = await assignmentWorkspace(),
      request = grantRequest(x.workspace.id, x.channel.id);
    const first = await issueSupportGrant(a.token, request);
    const replay = await issueSupportGrant(a.token, {
      ...request,
      allowedOperations: ["messages:read", "conversations:read", "messages:read"],
    });
    expect(replay.id).toBe(first.id);
    expect(replay.expiresAt).toEqual(first.expiresAt);
    expect(
      await prisma.platformAccessAudit.count({
        where: { grantId: first.id, action: "support.issue" },
      })
    ).toBe(1);
    for (const extra of [
      { reason: "Changed reason" },
      { allowedOperations: ["conversations:read"] },
      { expiresAt: new Date(Date.parse(request.expiresAt) + 1000).toISOString() },
      { scope: { kind: "workspace", customerProfileAccess: "none" } },
    ])
      await expect(issueSupportGrant(a.token, { ...request, ...extra })).rejects.toMatchObject({
        statusCode: 409,
      });
  });
  it("concurrent exact UUID issuance has one grant and one issuance audit", async () => {
    const a = await superAccount(),
      x = await assignmentWorkspace(),
      request = grantRequest(x.workspace.id, x.channel.id);
    const [first, second] = await Promise.all([
      issueSupportGrant(a.token, request),
      issueSupportGrant(a.token, request),
    ]);
    expect(first.id).toBe(second.id);
    expect(
      await prisma.supportGrant.count({
        where: { actorUserId: a.user.id, requestId: request.requestId },
      })
    ).toBe(1);
    expect(
      await prisma.platformAccessAudit.count({
        where: { grantId: first.id, action: "support.issue" },
      })
    ).toBe(1);
  });
  it("audit failure rolls back issuance and revocation; an unrelated operator cannot revoke", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      other = await operator(a.token),
      x = await assignmentWorkspace();
    const assignment = await assignOperator(
      a.token,
      assignmentInput(op.user.id, x.workspace.id, x.channel.id)
    );
    const request = grantRequest(x.workspace.id, x.channel.id, assignment.id);
    vi.spyOn(audit, "writePlatformAudit").mockRejectedValueOnce(
      new Error("Synthetic grant audit failure")
    );
    await expect(issueSupportGrant(op.token, request)).rejects.toThrow(
      "Synthetic grant audit failure"
    );
    expect(await prisma.supportGrant.count({ where: { actorUserId: op.user.id } })).toBe(0);
    const grant = await issueSupportGrant(op.token, request);
    await expect(
      revokeSupportGrant(other.token, { grantId: grant.id, reason: "Synthetic foreign revoke" })
    ).rejects.toMatchObject({ statusCode: 404 });
    vi.spyOn(audit, "writePlatformAudit").mockRejectedValueOnce(
      new Error("Synthetic revoke audit failure")
    );
    await expect(
      revokeSupportGrant(op.token, { grantId: grant.id, reason: "Synthetic revoke" })
    ).rejects.toThrow("Synthetic revoke audit failure");
    expect(
      (await prisma.supportGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt
    ).toBeNull();
    await revokeSupportGrant(op.token, { grantId: grant.id, reason: "Synthetic actor revoke" });
    const retired = await prisma.supportGrant.findUniqueOrThrow({ where: { id: grant.id } });
    expect(retired.revokedAt).not.toBeNull();
    await revokeSupportGrant(a.token, {
      grantId: grant.id,
      reason: "Synthetic super repeat revoke",
    });
    expect(
      (await prisma.supportGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokedAt
    ).toEqual(retired.revokedAt);
    await expect(issueSupportGrant(op.token, request)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("revoked or expired assignments cannot issue grants and expired grant UUIDs cannot revive", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      x = await assignmentWorkspace();
    const row = await assignOperator(
      a.token,
      assignmentInput(op.user.id, x.workspace.id, x.channel.id)
    );
    const request = grantRequest(x.workspace.id, x.channel.id, row.id);
    const grant = await issueSupportGrant(op.token, request);
    await prisma.supportGrant.update({ where: { id: grant.id }, data: { expiresAt: new Date(0) } });
    await expect(
      issueSupportGrant(op.token, { ...request, expiresAt: new Date(0).toISOString() })
    ).rejects.toMatchObject({ statusCode: 409 });
    await prisma.platformAssignment.update({
      where: { id: row.id },
      data: { expiresAt: new Date(0) },
    });
    await expect(
      issueSupportGrant(op.token, { ...request, requestId: randomUUID() })
    ).rejects.toMatchObject({ statusCode: 403 });
    await revokeAssignment(a.token, {
      assignmentId: row.id,
      reason: "Synthetic retire assignment",
    });
    await expect(
      issueSupportGrant(op.token, { ...request, requestId: randomUUID() })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("support UUID normalization", () => {
  it("treats case variants as one request and cannot bypass replay conflicts or revocation", async () => {
    const a = await superAccount(),
      x = await assignmentWorkspace();
    const request = {
      ...grantRequest(x.workspace.id, x.channel.id),
      requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    };
    const first = await issueSupportGrant(a.token, request);
    const replay = await issueSupportGrant(a.token, {
      ...request,
      requestId: request.requestId.toUpperCase(),
    });
    expect(replay.id).toBe(first.id);
    expect(
      await prisma.platformAccessAudit.count({
        where: { actorUserId: a.user.id, action: "support.issue" },
      })
    ).toBe(1);
    await expect(
      issueSupportGrant(a.token, {
        ...request,
        requestId: request.requestId.toUpperCase(),
        reason: "Changed case replay reason",
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    await revokeSupportGrant(a.token, { grantId: first.id, reason: "Synthetic replay revocation" });
    await expect(
      issueSupportGrant(a.token, { ...request, requestId: request.requestId.toUpperCase() })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("fresh support use admission, not connected to tenant routes", () => {
  it("requires exact actor/workspace/operation and audits admission rather than completed work", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      x = await assignmentWorkspace(),
      y = await assignmentWorkspace();
    const assignment = await assignOperator(
      a.token,
      assignmentInput(op.user.id, x.workspace.id, x.channel.id)
    );
    const grant = await issueSupportGrant(
      op.token,
      grantRequest(x.workspace.id, x.channel.id, assignment.id)
    );
    const use = { grantId: grant.id, businessId: x.workspace.id, operation: "conversations:read" };
    await expect(authorizeSupportUse(a.token, use)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      authorizeSupportUse(op.token, { ...use, businessId: y.workspace.id })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      authorizeSupportUse(op.token, { ...use, operation: "tickets:read" })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      authorizeSupportUse(op.token, { ...use, operation: "settings:read" })
    ).rejects.toMatchObject({ statusCode: 403 });
    const admission = await authorizeSupportUse(op.token, use);
    expect(admission).toMatchObject({
      userId: op.user.id,
      businessId: x.workspace.id,
      grantId: grant.id,
      scope: { kind: "connections", connectionIds: [x.channel.id], customerProfileAccess: "none" },
      allowedOperations: ["conversations:read", "messages:read"],
    });
    expect(admission).not.toHaveProperty("role");
    const rows = await prisma.platformAccessAudit.findMany({
      where: { grantId: grant.id, action: "support.authorize" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: op.user.id,
      businessId: x.workspace.id,
      workspaceId: x.workspace.id,
      reason: grant.reason,
    });
    expect(rows[0].details).toMatchObject({
      decision: "allowed",
      operation: "conversations:read",
      grantId: grant.id,
      assignmentId: assignment.id,
    });
    expect(JSON.stringify(rows)).not.toContain(op.token);
  });
  it("fails closed when the use audit cannot commit", async () => {
    const a = await superAccount(),
      x = await assignmentWorkspace();
    const grant = await issueSupportGrant(a.token, grantRequest(x.workspace.id, x.channel.id));
    vi.spyOn(audit, "writePlatformAudit").mockRejectedValueOnce(
      new Error("Synthetic use audit failure")
    );
    await expect(
      authorizeSupportUse(a.token, {
        grantId: grant.id,
        businessId: x.workspace.id,
        operation: "conversations:read",
      })
    ).rejects.toThrow("Synthetic use audit failure");
    expect(
      await prisma.platformAccessAudit.count({
        where: { grantId: grant.id, action: "support.authorize" },
      })
    ).toBe(0);
  });
  it("freshly intersects assignment restrictions and cannot expand the issued grant", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      x = await assignmentWorkspace();
    const second = await prisma.channelConnection.create({
      data: { businessId: x.workspace.id, type: "webchat", name: "Other assigned connection" },
    });
    const assignment = await assignOperator(a.token, {
      ...assignmentInput(op.user.id, x.workspace.id, x.channel.id),
      scope: { kind: "workspace", customerProfileAccess: "read" },
    });
    const grant = await issueSupportGrant(op.token, {
      ...grantRequest(x.workspace.id, x.channel.id, assignment.id),
      scope: {
        kind: "connections",
        connectionIds: [x.channel.id, second.id],
        customerProfileAccess: "read",
      },
    });
    const use = { grantId: grant.id, businessId: x.workspace.id, operation: "conversations:read" };
    await prisma.platformAssignment.update({
      where: { id: assignment.id },
      data: {
        scopeMode: "connections",
        customerProfileAccess: "none",
        allowedOperations: ["conversations:read"],
      },
    });
    await prisma.assignmentConnectionScope.create({
      data: {
        businessId: x.workspace.id,
        operatorUserId: op.user.id,
        assignmentId: assignment.id,
        connectionId: x.channel.id,
      },
    });
    const narrow = await authorizeSupportUse(op.token, use);
    expect(narrow.scope).toEqual({
      kind: "connections",
      connectionIds: [x.channel.id],
      customerProfileAccess: "none",
    });
    expect(narrow.allowedOperations).toEqual(["conversations:read"]);
    await expect(
      authorizeSupportUse(op.token, { ...use, operation: "messages:read" })
    ).rejects.toMatchObject({ statusCode: 403 });
    await prisma.platformAssignment.update({
      where: { id: assignment.id },
      data: {
        scopeMode: "workspace",
        customerProfileAccess: "write",
        allowedOperations: ["conversations:read", "messages:read", "tickets:read"],
      },
    });
    const wide = await authorizeSupportUse(op.token, use);
    expect(wide.scope).toEqual({
      kind: "connections",
      connectionIds: [x.channel.id, second.id].sort(),
      customerProfileAccess: "read",
    });
    expect(wide.allowedOperations).toEqual(["conversations:read", "messages:read"]);
    await expect(
      authorizeSupportUse(op.token, { ...use, operation: "tickets:read" })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("fresh use denies revoked grant/assignment/session, removed operator, inactive workspace and deleted scopes", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      x = await assignmentWorkspace();
    const assignment = await assignOperator(
      a.token,
      assignmentInput(op.user.id, x.workspace.id, x.channel.id)
    );
    const grant = await issueSupportGrant(
      op.token,
      grantRequest(x.workspace.id, x.channel.id, assignment.id)
    );
    const use = { grantId: grant.id, businessId: x.workspace.id, operation: "conversations:read" };
    expect(await authorizeSupportUse(op.token, use)).toHaveProperty("grantId", grant.id);
    await prisma.business.update({ where: { id: x.workspace.id }, data: { status: "suspended" } });
    await expect(authorizeSupportUse(op.token, use)).rejects.toMatchObject({ statusCode: 404 });
    await prisma.business.update({ where: { id: x.workspace.id }, data: { status: "active" } });
    await revokeToken(op.token);
    await expect(authorizeSupportUse(op.token, use)).rejects.toMatchObject({ statusCode: 401 });
    const active = generateToken(op.user.id);
    await prisma.channelConnection.delete({ where: { id: x.channel.id } });
    await expect(authorizeSupportUse(active, use)).rejects.toMatchObject({ statusCode: 403 });
    await revokeAssignment(a.token, {
      assignmentId: assignment.id,
      reason: "Synthetic assignment end",
    });
    await expect(authorizeSupportUse(active, use)).rejects.toMatchObject({ statusCode: 403 });
    await removeOperator(a.token, { operatorUserId: op.user.id, reason: "Synthetic operator end" });
    await expect(authorizeSupportUse(active, use)).rejects.toMatchObject({ statusCode: 403 });
  });
  it("checks expiry each time and a revoked super grant cannot be admitted", async () => {
    const a = await superAccount(),
      x = await assignmentWorkspace();
    const grant = await issueSupportGrant(a.token, grantRequest(x.workspace.id, x.channel.id));
    const use = { grantId: grant.id, businessId: x.workspace.id, operation: "conversations:read" };
    await prisma.supportGrant.update({ where: { id: grant.id }, data: { expiresAt: new Date(0) } });
    await expect(authorizeSupportUse(a.token, use)).rejects.toMatchObject({ statusCode: 403 });
    const second = await issueSupportGrant(a.token, grantRequest(x.workspace.id, x.channel.id));
    await revokeSupportGrant(a.token, {
      grantId: second.id,
      reason: "Synthetic super grant revoke",
    });
    await expect(
      authorizeSupportUse(a.token, { ...use, grantId: second.id })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("support admission time boundary", () => {
  for (const expiry of ["grant", "session"] as const)
    it(`denies when ${expiry} expiry passes while mandatory audit is awaiting completion`, async () => {
      const a = await superAccount(),
        x = await assignmentWorkspace();
      const grant = await issueSupportGrant(a.token, grantRequest(x.workspace.id, x.channel.id));
      const token =
        expiry === "session"
          ? jwt.sign({ userId: a.user.id }, process.env.JWT_SECRET!, {
              expiresIn: 30,
              jwtid: randomUUID(),
            })
          : a.token;
      const original = audit.writePlatformAudit;
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => {
          entered = r;
        }),
        hold = new Promise<void>((r) => {
          release = r;
        });
      const spy = vi.spyOn(audit, "writePlatformAudit").mockImplementationOnce(async (...args) => {
        const row = await original(...args);
        entered();
        await hold;
        return row;
      });
      try {
        const pending = authorizeSupportUse(token, {
          grantId: grant.id,
          businessId: x.workspace.id,
          operation: "conversations:read",
        });
        const outcome = pending.then(
          (admission) => ({ admission }),
          (error) => ({ error })
        );
        await ready;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + (expiry === "grant" ? 3600_000 : 60_000));
        release();
        expect(await outcome).toMatchObject({
          error: { statusCode: expiry === "session" ? 401 : 403 },
        });
        const rows = await prisma.platformAccessAudit.findMany({
          where: { grantId: grant.id, action: { in: ["support.authorize", "support.deny"] } },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: "support.deny", details: { decision: "denied" } });
      } finally {
        release();
        vi.useRealTimers();
        spy.mockRestore();
      }
    });
});

describe("support admission session revocation boundary", () => {
  it("denies logout committed while mandatory admission audit is pending", async () => {
    const a = await superAccount(),
      x = await assignmentWorkspace();
    const grant = await issueSupportGrant(a.token, grantRequest(x.workspace.id, x.channel.id));
    const original = audit.writePlatformAudit;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      hold = new Promise<void>((r) => {
        release = r;
      });
    const spy = vi.spyOn(audit, "writePlatformAudit").mockImplementationOnce(async (...args) => {
      const row = await original(...args);
      entered();
      await hold;
      return row;
    });
    try {
      const pending = authorizeSupportUse(a.token, {
        grantId: grant.id,
        businessId: x.workspace.id,
        operation: "conversations:read",
      });
      const outcome = pending.then(
        (admission) => ({ admission }),
        (error) => ({ error })
      );
      await ready;
      await revokeToken(a.token);
      release();
      expect(await outcome).toMatchObject({ error: { statusCode: 401 } });
      const rows = await prisma.platformAccessAudit.findMany({
        where: { grantId: grant.id, action: { in: ["support.authorize", "support.deny"] } },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("support.deny");
    } finally {
      release();
      spy.mockRestore();
    }
  });
});

describe("support grant management metadata and HTTP boundary", () => {
  it("lists only the actor's grants and active assigned metadata, never excluded connections or credentials", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      other = await operator(a.token);
    const x = await assignmentWorkspace(),
      y = await assignmentWorkspace();
    const excluded = await prisma.channelConnection.create({
      data: {
        businessId: x.workspace.id,
        type: "email",
        name: "Excluded connection",
        config: { privateFixture: "hidden" },
      },
    });
    const assigned = await assignOperator(
      a.token,
      assignmentInput(op.user.id, x.workspace.id, x.channel.id)
    );
    const own = await issueSupportGrant(
      op.token,
      grantRequest(x.workspace.id, x.channel.id, assigned.id)
    );
    await issueSupportGrant(a.token, grantRequest(y.workspace.id, y.channel.id));
    const { readSupportConsole } = await import("@/lib/platform/access/grants");
    const result = await readSupportConsole(op.token);
    expect(result.workspaces.map((w) => w.id)).toEqual([x.workspace.id]);
    expect(result.workspaces[0].channelConnections.map((c) => c.id)).toEqual([x.channel.id]);
    expect(result.grants.map((g) => g.id)).toEqual([own.id]);
    expect(result.assignments.map((v) => v.id)).toEqual([assigned.id]);
    expect(JSON.stringify(result)).not.toMatch(
      /credentialRef|privateFixture|keyHash|password|Excluded connection/
    );
    expect(JSON.stringify(result)).not.toContain(excluded.id);
    const empty = await readSupportConsole(other.token);
    expect(empty.workspaces).toHaveLength(0);
    expect(empty.grants).toHaveLength(0);
    await revokeAssignment(a.token, { assignmentId: assigned.id, reason: "Synthetic end" });
    expect((await readSupportConsole(op.token)).workspaces).toHaveLength(0);
    await expect(readSupportConsole((await account()).token)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it("requires a signed person and same-origin JSON, issues/revokes only actor-self and never creates membership", async () => {
    const a = await superAccount(),
      op = await operator(a.token),
      other = await operator(a.token),
      x = await assignmentWorkspace();
    const assignment = await assignOperator(
      a.token,
      assignmentInput(op.user.id, x.workspace.id, x.channel.id)
    );
    const { GET, POST } = await import("@/app/api/platform/support-grants/route");
    const request = (
      token?: string,
      body: unknown = {},
      origin = "http://localhost:3000",
      key = false,
      content = "application/json"
    ) => {
      const r = new NextRequest("http://localhost:3000/api/platform/support-grants", {
        method: "POST",
        headers: {
          origin,
          "content-type": content,
          ...(key ? { "x-api-key": "synthetic-key" } : {}),
        },
        body: JSON.stringify(body),
      });
      if (token) r.cookies.set("owly-token", token);
      return r;
    };
    for (const response of [await GET(request()), await POST(request())]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect((await POST(request(a.token, {}, undefined, true))).status).toBe(403);
    expect((await POST(request(a.token, {}, "https://foreign.example.invalid"))).status).toBe(403);
    expect((await POST(request(a.token, {}, undefined, false, "text/plain"))).status).toBe(415);
    const input = { action: "issue", ...grantRequest(x.workspace.id, x.channel.id, assignment.id) };
    const created = await POST(request(op.token, input));
    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    const grant = (await created.json()).result;
    expect(grant.actorUserId).toBe(op.user.id);
    expect(
      (
        await POST(
          request(other.token, {
            action: "revoke",
            grantId: grant.id,
            reason: "Synthetic foreign denial",
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await POST(
          request(op.token, { action: "revoke", grantId: grant.id, reason: "Synthetic own end" })
        )
      ).status
    ).toBe(200);
    expect(
      await prisma.membership.count({ where: { businessId: x.workspace.id, userId: op.user.id } })
    ).toBe(0);
    expect(
      await prisma.platformAccessAudit.count({
        where: { grantId: grant.id, action: "support.revoke", actorUserId: op.user.id },
      })
    ).toBe(1);
  });
});

// Same singleton ownership hooks as the existing platform lifecycle tests. These
// route tests use actual platform services/JWT/Postgres, not the default auth mock.
async function limitedSupportFixture(asOperator = false, member = false) {
  const superUser = await superAccount();
  const actor = asOperator ? await operator(superUser.token) : superUser;
  const x = await assignmentWorkspace(),
    y = await assignmentWorkspace();
  const second = await prisma.channelConnection.create({
    data: {
      businessId: x.workspace.id,
      type: "webchat",
      name: "Excluded same-type source",
      isActive: true,
    },
  });
  const assignment = asOperator
    ? await assignOperator(
        superUser.token,
        assignmentInput(actor.user.id, x.workspace.id, x.channel.id)
      )
    : null;
  const grant = await issueSupportGrant(
    actor.token,
    grantRequest(x.workspace.id, x.channel.id, assignment?.id)
  );
  const visible = await prisma.conversation.create({
    data: {
      businessId: x.workspace.id,
      channel: "webchat",
      customerName: "Visible support visitor",
      customerContact: "visible-synthetic-contact",
      summary: "private-summary-never-in-support-list",
      metadata: { channelConnectionId: x.channel.id, private: "private-metadata-never-in-list" },
    },
  });
  await prisma.message.create({
    data: {
      businessId: x.workspace.id,
      conversationId: visible.id,
      role: "user",
      content: "private-message-never-in-support-list",
    },
  });
  const excluded = await prisma.conversation.create({
    data: {
      businessId: x.workspace.id,
      channel: "webchat",
      customerName: "Excluded support visitor",
      metadata: { channelConnectionId: second.id },
    },
  });
  await prisma.conversation.create({
    data: {
      businessId: x.workspace.id,
      channel: "webchat",
      customerName: "Unstamped support visitor",
    },
  });
  await prisma.conversation.create({
    data: {
      businessId: y.workspace.id,
      channel: "webchat",
      customerName: "Foreign support visitor",
      metadata: { channelConnectionId: y.channel.id },
    },
  });
  if (member)
    await prisma.membership.create({
      data: { businessId: x.workspace.id, userId: actor.user.id, role: "owner" },
    });
  return { superUser, actor, x, y, second, assignment, grant, visible, excluded };
}
function limitedSupportRequest(
  fixture: Awaited<ReturnType<typeof limitedSupportFixture>>,
  options: {
    path?: string;
    method?: string;
    grantId?: string;
    workspaceId?: string;
    cookieWorkspace?: string;
    apiKey?: string;
    token?: string;
  } = {}
) {
  const req = new NextRequest("http://localhost:3000" + (options.path ?? "/api/conversations"), {
    method: options.method ?? "GET",
    headers: {
      "x-support-grant-id": options.grantId ?? fixture.grant.id,
      "x-workspace-id": options.workspaceId ?? fixture.x.workspace.id,
      ...(options.apiKey !== undefined ? { "x-api-key": options.apiKey } : {}),
    },
  });
  req.cookies.set("owly-token", options.token ?? fixture.actor.token);
  if (options.cookieWorkspace) req.cookies.set("ziyrak-workspace", options.cookieWorkspace);
  return req;
}
async function afterSupportRows(callback: () => Promise<void>, model = "conversation") {
  const scoped = await import("@/lib/tenancy/scoped-prisma");
  const original = scoped.getScopedPrisma;
  let used = false;
  vi.spyOn(scoped, "getScopedPrisma").mockImplementation((ctx) => {
    const db = original(ctx);
    return new Proxy(db, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== model) return value;
        return new Proxy(value, {
          get(model, operation, modelReceiver) {
            const method = Reflect.get(model, operation, modelReceiver);
            if (operation !== "findMany") return method;
            return async (...args: unknown[]) => {
              const rows = await Reflect.apply(method, model, args);
              if (!used) {
                used = true;
                await callback();
              }
              return rows;
            };
          },
        });
      },
    });
  });
}
describe("P1 request-local limited support list and exposure authority", () => {
  it("returns only explicit scalar rows/count for a current own operator grant without membership", async () => {
    const x = await limitedSupportFixture(true);
    const { GET } = await import("@/app/api/conversations/route");
    const response = await GET(limitedSupportRequest(x));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body.pagination.total).toBe(1);
    expect(body.data.map((row: { id: string }) => row.id)).toEqual([x.visible.id]);
    expect(Object.keys(body.data[0]).sort()).toEqual(
      [
        "id",
        "businessId",
        "channel",
        "customerName",
        "customerContact",
        "status",
        "createdAt",
        "updatedAt",
      ].sort()
    );
    expect(JSON.stringify(body)).not.toMatch(/private-|Excluded|Unstamped|Foreign/);
    const rows = await prisma.platformAccessAudit.findMany({
      where: { grantId: x.grant.id, action: "support.authorize" },
    });
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) => row.actorUserId === x.actor.user.id && row.businessId === x.x.workspace.id
      )
    ).toBe(true);
  });
  it("searches/counts only included ownership and ignores caller attempts to select fields", async () => {
    const x = await limitedSupportFixture();
    const { GET } = await import("@/app/api/conversations/route");
    const response = await GET(
      limitedSupportRequest(x, {
        path: "/api/conversations?search=Excluded&include=messages&select=summary",
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [], pagination: { total: 0 } });
  });
  it("never falls back to an actual owner membership after invalid, foreign or revoked grant selection", async () => {
    const x = await limitedSupportFixture(false, true);
    const foreign = await operator(x.superUser.token);
    const assignment = await assignOperator(
      x.superUser.token,
      assignmentInput(foreign.user.id, x.x.workspace.id, x.x.channel.id)
    );
    const foreignGrant = await issueSupportGrant(
      foreign.token,
      grantRequest(x.x.workspace.id, x.x.channel.id, assignment.id)
    );
    const { GET } = await import("@/app/api/conversations/route");
    for (const grantId of ["", randomUUID(), foreignGrant.id]) {
      const response = await GET(limitedSupportRequest(x, { grantId }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await response.json())).not.toContain(x.visible.customerName);
    }
    await revokeSupportGrant(x.actor.token, {
      grantId: x.grant.id,
      reason: "Synthetic revoked selection",
    });
    expect((await GET(limitedSupportRequest(x))).status).toBe(403);
  });
  it("requires the exact request path/method/permission and rejects empty API-key headers", async () => {
    const x = await limitedSupportFixture(false, true);
    const { requireAuth, isAuthenticated } = await import("@/lib/identity/route-auth");
    for (const [path, method, permission] of [
      ["/api/conversations", "GET", undefined],
      ["/api/conversations", "HEAD", "conversations:read"],
      ["/api/conversations", "POST", "conversations:create"],
      ["/api/conversations/" + x.visible.id, "GET", "conversations:read"],
      ["/api/knowledge/test", "POST", "knowledge:read"],
      ["/api/campaigns", "GET", "campaigns:read"],
      ["/api/realtime", "GET", "conversations:read"],
    ] as const) {
      const response = await requireAuth(
        limitedSupportRequest(x, { path, method }),
        permission as never
      );
      expect(isAuthenticated(response)).toBe(false);
      if (!isAuthenticated(response)) expect(response.status).toBe(403);
    }
    const response = await requireAuth(
      limitedSupportRequest(x, { apiKey: "" }),
      "conversations:read"
    );
    expect(isAuthenticated(response)).toBe(false);
    if (!isAuthenticated(response)) expect(response.status).toBe(403);
  });
  it("rejects a conflicting selected workspace without silently clearing it", async () => {
    const x = await limitedSupportFixture(false, true);
    const { GET } = await import("@/app/api/conversations/route");
    const response = await GET(limitedSupportRequest(x, { cookieWorkspace: x.y.workspace.id }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "WORKSPACE_SELECTION_CONFLICT" },
    });
    expect(response.cookies.get("ziyrak-workspace")).toBeUndefined();
  });
  it("discards loaded rows/count when the grant is revoked after the query", async () => {
    const x = await limitedSupportFixture(false, true);
    await afterSupportRows(() =>
      revokeSupportGrant(x.actor.token, {
        grantId: x.grant.id,
        reason: "Synthetic post-query revoke",
      }).then(() => {})
    );
    const { GET } = await import("@/app/api/conversations/route");
    const response = await GET(limitedSupportRequest(x));
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain(x.visible.customerName);
  });
  it("discards loaded rows/count when the same signed session is revoked after the query", async () => {
    const x = await limitedSupportFixture(false, true);
    await afterSupportRows(() => revokeToken(x.actor.token));
    const { GET } = await import("@/app/api/conversations/route");
    const response = await GET(limitedSupportRequest(x));
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain(x.visible.customerName);
  });
  it("denies exposure if the final mandatory admission audit fails", async () => {
    const x = await limitedSupportFixture(false, true);
    const actual = audit.writePlatformAudit;
    let uses = 0;
    vi.spyOn(audit, "writePlatformAudit").mockImplementation(async (...args) => {
      if (args[1].action === "support.authorize" && ++uses === 2)
        throw new Error("Synthetic final exposure audit fault");
      return actual(...args);
    });
    const { GET } = await import("@/app/api/conversations/route");
    const response = await GET(limitedSupportRequest(x));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(x.visible.customerName);
  });
  it.each(["grant", "session"] as const)(
    "rechecks %s after the final awaited placement lookup",
    async (loss) => {
      const x = await limitedSupportFixture(false, true);
      const placement = await import("@/lib/platform/tenant-placement");
      const actual = placement.resolveTenantPlacement;
      let calls = 0;
      vi.spyOn(placement, "resolveTenantPlacement").mockImplementation(async (...args) => {
        const result = await actual(...args);
        if (++calls === 2) {
          if (loss === "grant")
            await revokeSupportGrant(x.actor.token, {
              grantId: x.grant.id,
              reason: "Synthetic final-placement revoke",
            });
          else await revokeToken(x.actor.token);
        }
        return result;
      });
      const { GET } = await import("@/app/api/conversations/route");
      const response = await GET(limitedSupportRequest(x));
      expect(calls).toBe(2);
      expect(response.status).toBe(loss === "session" ? 401 : 403);
      expect(await response.json()).not.toHaveProperty("data");
    }
  );
  it("retains ordinary membership list behavior without a support selection", async () => {
    const x = await limitedSupportFixture(false, true);
    const { GET } = await import("@/app/api/conversations/route");
    const request = new NextRequest("http://localhost:3000/api/conversations", {
      headers: { "x-workspace-id": x.x.workspace.id },
    });
    request.cookies.set("owly-token", x.actor.token);
    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pagination.total).toBe(3);
    expect(
      body.data.find((row: { id: string }) => row.id === x.visible.id).messages[0].content
    ).toBe("private-message-never-in-support-list");
  });
  it("clears only selected workspace through an explicit signed same-origin action", async () => {
    const x = await limitedSupportFixture(false, true);
    const route = await import("@/app/api/workspaces/route");
    expect(typeof route.DELETE).toBe("function");
    const request = new NextRequest("http://localhost:3000/api/workspaces", {
      method: "DELETE",
      headers: { origin: "http://localhost:3000" },
    });
    request.cookies.set("owly-token", x.actor.token);
    request.cookies.set("ziyrak-workspace", x.x.workspace.id);
    const response = await route.DELETE(request);
    expect(response.status).toBe(200);
    expect(response.cookies.get("ziyrak-workspace")?.value).toBe("");
    expect(response.cookies.get("owly-token")).toBeUndefined();
  });
  it.each(["assignment", "platform", "workspace", "expiry", "audit"] as const)(
    "denies initial support access after %s loss without owner fallback",
    async (loss) => {
      const x = await limitedSupportFixture(true, true);
      if (loss === "assignment")
        await revokeAssignment(x.superUser.token, {
          assignmentId: x.assignment!.id,
          reason: "Synthetic ended assignment",
        });
      if (loss === "platform")
        await prisma.user.update({ where: { id: x.actor.user.id }, data: { platformRole: null } });
      if (loss === "workspace")
        await prisma.business.update({
          where: { id: x.x.workspace.id },
          data: { status: "suspended" },
        });
      if (loss === "expiry")
        await prisma.supportGrant.update({
          where: { id: x.grant.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      if (loss === "audit")
        vi.spyOn(audit, "writePlatformAudit").mockRejectedValue(
          new Error("Synthetic initial support audit failure")
        );
      const { GET } = await import("@/app/api/conversations/route");
      const response = await GET(limitedSupportRequest(x));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.json()).not.toHaveProperty("data");
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  );
  it.each(["assignment", "platform", "workspace", "scope"] as const)(
    "discards all rows and count after post-query %s change",
    async (loss) => {
      const x = await limitedSupportFixture(true, true);
      if (loss === "scope") {
        await prisma.grantConnectionScope.create({
          data: { businessId: x.x.workspace.id, grantId: x.grant.id, connectionId: x.second.id },
        });
        await prisma.assignmentConnectionScope.create({
          data: {
            businessId: x.x.workspace.id,
            operatorUserId: x.actor.user.id,
            assignmentId: x.assignment!.id,
            connectionId: x.second.id,
          },
        });
      }
      await afterSupportRows(async () => {
        if (loss === "assignment")
          await revokeAssignment(x.superUser.token, {
            assignmentId: x.assignment!.id,
            reason: "Synthetic post-query assignment loss",
          });
        if (loss === "platform")
          await prisma.user.update({
            where: { id: x.actor.user.id },
            data: { platformRole: null },
          });
        if (loss === "workspace")
          await prisma.business.update({
            where: { id: x.x.workspace.id },
            data: { status: "suspended" },
          });
        if (loss === "scope")
          await prisma.assignmentConnectionScope.deleteMany({
            where: { assignmentId: x.assignment!.id, connectionId: x.second.id },
          });
      });
      const { GET } = await import("@/app/api/conversations/route");
      const response = await GET(limitedSupportRequest(x));
      expect(response.status).toBeGreaterThanOrEqual(400);
      const body = await response.json();
      expect(body).not.toHaveProperty("data");
      expect(body).not.toHaveProperty("pagination");
      expect(JSON.stringify(body)).not.toContain(x.visible.customerName);
    }
  );
  it.each(["anonymous", "api-key", "foreign-origin", "missing-origin", "cross-site"] as const)(
    "does not clear workspace for %s requests",
    async (kind) => {
      const x = await limitedSupportFixture(false, true);
      const { DELETE } = await import("@/app/api/workspaces/route");
      const req = new NextRequest("http://localhost:3000/api/workspaces", {
        method: "DELETE",
        headers: {
          ...(kind === "missing-origin"
            ? {}
            : {
                origin:
                  kind === "foreign-origin" ? "https://elsewhere.example" : "http://localhost:3000",
              }),
          ...(kind === "api-key" ? { "x-api-key": "" } : {}),
          ...(kind === "cross-site" ? { "sec-fetch-site": "cross-site" } : {}),
        },
      });
      if (kind !== "anonymous") req.cookies.set("owly-token", x.actor.token);
      req.cookies.set("ziyrak-workspace", x.x.workspace.id);
      const response = await DELETE(req);
      expect(response.status).toBe(kind === "anonymous" ? 401 : 403);
      expect(response.cookies.get("ziyrak-workspace")).toBeUndefined();
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  );
});

async function supportMessageFixture() {
  const x = await limitedSupportFixture(true, true);
  // The shared list fixture owns one plain message; this contract's rows are explicit.
  await prisma.message.deleteMany({ where: { conversationId: x.visible.id } });
  const issueGrant = (operations: string[]) =>
    issueSupportGrant(x.actor.token, {
      ...grantRequest(x.x.workspace.id, x.x.channel.id, x.assignment!.id),
      allowedOperations: operations,
    });
  const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
  const add = (
    businessId: string,
    conversationId: string,
    content: string,
    n: number,
    extra: Record<string, unknown> = {}
  ) =>
    prisma.message.create({
      data: { businessId, conversationId, role: "customer", content, createdAt: at(n), ...extra },
    });
  const w = x.x.workspace.id;
  const text1 = await add(w, x.visible.id, "support-text-one", 1);
  const text2 = await add(w, x.visible.id, "support-text-two", 2, { role: "assistant" });
  const text3 = await add(w, x.visible.id, "support-text-three", 3, {
    role: "system",
    toolCalls: [{ name: "private-tool-call-never-exposed" }],
  });
  await add(w, x.visible.id, "private-media-caption-never-exposed", 4, {
    mediaType: "image",
    mediaUrl: "https://private-media.invalid/never-exposed.png",
  });
  await add(w, x.visible.id, "private-media-type-only-never-exposed", 5, { mediaType: "audio" });
  await add(w, x.visible.id, "private-media-url-only-never-exposed", 6, {
    mediaUrl: "https://private-media.invalid/url-only.png",
  });
  await add(w, x.excluded.id, "private-excluded-connection-message", 7);
  const foreign = await prisma.conversation.findFirstOrThrow({
    where: { businessId: x.y.workspace.id },
  });
  await add(x.y.workspace.id, foreign.id, "private-foreign-workspace-message", 8);
  return { ...x, issueGrant, foreign, text: [text1, text2, text3] };
}
type MessageFixture = Awaited<ReturnType<typeof supportMessageFixture>>;
const messagesPath = (id: string, query = "") => `/api/conversations/${id}/messages${query}`;
async function readSupportMessages(
  x: MessageFixture,
  conversationId = x.visible.id,
  options: Parameters<typeof limitedSupportRequest>[1] = {}
) {
  const { GET } = await import("@/app/api/conversations/[id]/messages/route");
  return GET(limitedSupportRequest(x, { path: messagesPath(conversationId), ...options }), {
    params: Promise.resolve({ id: conversationId }),
  });
}
const privateMessageText = /private-|never-exposed|Excluded|Foreign/;

describe("P1 request-local support text-message read", () => {
  it("returns only ordered scalar text rows and a text-only count for an own operator grant", async () => {
    const x = await supportMessageFixture();
    const response = await readSupportMessages(x);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body.data.map((row: { id: string }) => row.id)).toEqual(x.text.map((m) => m.id));
    expect(body.pagination.total).toBe(3);
    for (const row of body.data)
      expect(Object.keys(row).sort()).toEqual(
        ["content", "conversationId", "createdAt", "id", "role"].sort()
      );
    expect(JSON.stringify(body)).not.toMatch(privateMessageText);
    const rows = await prisma.platformAccessAudit.findMany({
      where: { grantId: x.grant.id, action: "support.authorize" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.actorUserId === x.actor.user.id)).toBe(true);
    expect(
      rows.every((row) => (row.details as { operation?: string }).operation === "messages:read")
    ).toBe(true);
  });
  it("pages with the same text-only predicate and ignores caller field/parent/widening parameters", async () => {
    const x = await supportMessageFixture();
    const { GET } = await import("@/app/api/conversations/[id]/messages/route");
    const query = `?limit=2&page=2&include=toolCalls&select=mediaUrl&conversationId=${x.excluded.id}&mediaType=image`;
    const response = await GET(
      limitedSupportRequest(x, { path: messagesPath(x.visible.id, query) }),
      { params: Promise.resolve({ id: x.visible.id }) }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.map((row: { id: string }) => row.id)).toEqual([x.text[2].id]);
    expect(body.pagination.total).toBe(3);
    expect(JSON.stringify(body)).not.toMatch(privateMessageText);
  });
  it("clamps oversized paging and denies unbounded offsets without exposing rows", async () => {
    const x = await supportMessageFixture();
    const { GET } = await import("@/app/api/conversations/[id]/messages/route");
    const call = (query: string) =>
      GET(limitedSupportRequest(x, { path: messagesPath(x.visible.id, query) }), {
        params: Promise.resolve({ id: x.visible.id }),
      });
    const big = await call("?limit=100000");
    expect(big.status).toBe(200);
    expect((await big.json()).data.length).toBe(3);
    const far = await call("?page=100000000&limit=100");
    expect(far.status).toBeGreaterThanOrEqual(200);
    expect(JSON.stringify(await far.json())).not.toMatch(/support-text/);
  });
  it("requires messages:read; conversations:read alone cannot read messages and the reverse", async () => {
    const x = await supportMessageFixture();
    const listOnly = await x.issueGrant(["conversations:read"]);
    expect((await readSupportMessages(x, x.visible.id, { grantId: listOnly.id })).status).toBe(403);
    const messagesOnly = await x.issueGrant(["messages:read"]);
    const { GET } = await import("@/app/api/conversations/route");
    expect((await GET(limitedSupportRequest(x, { grantId: messagesOnly.id }))).status).toBe(403);
    expect((await readSupportMessages(x, x.visible.id, { grantId: messagesOnly.id })).status).toBe(
      200
    );
  });
  it("returns an identical 404 for foreign, excluded, missing and retired parents", async () => {
    const x = await supportMessageFixture();
    const bodies: string[] = [];
    const retired = await prisma.conversation.create({
      data: {
        businessId: x.x.workspace.id,
        channel: "webchat",
        customerName: "Retired support visitor",
        metadata: { channelConnectionId: x.x.channel.id },
        retiredAt: new Date(),
      },
    });
    await prisma.message.create({
      data: {
        businessId: x.x.workspace.id,
        conversationId: retired.id,
        role: "customer",
        content: "private-retired-parent-message",
      },
    });
    for (const id of [x.foreign.id, x.excluded.id, randomUUID(), retired.id]) {
      const response = await readSupportMessages(x, id);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toContain("no-store");
      bodies.push(JSON.stringify(await response.json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/private-|Excluded|Foreign|Retired/);
  });
  it("requires the exact message path/method/permission and rejects keys and malformed ids", async () => {
    const x = await supportMessageFixture();
    const { requireAuth, isAuthenticated } = await import("@/lib/identity/route-auth");
    const id = x.visible.id;
    for (const [path, method, permission] of [
      [messagesPath(id), "GET", undefined],
      [messagesPath(id), "GET", "conversations:read"],
      [messagesPath(id), "HEAD", "messages:read"],
      [messagesPath(id), "POST", "messages:create"],
      [messagesPath(id), "POST", "messages:read"],
      [messagesPath(id) + "/", "GET", "messages:read"],
      [`/api/conversations/${id}/notes`, "GET", "messages:read"],
      [`/api/conversations/${id}`, "GET", "messages:read"],
      [`/api/conversations/${id}/messages/extra`, "GET", "messages:read"],
      ["/api/conversations//messages", "GET", "messages:read"],
      ["/api/conversations/a%2Fb/messages", "GET", "messages:read"],
      ["/api/conversations/" + "a".repeat(129) + "/messages", "GET", "messages:read"],
      ["/api/conversations", "GET", "messages:read"],
    ] as const) {
      const response = await requireAuth(
        limitedSupportRequest(x, { path, method }),
        permission as never
      );
      expect(isAuthenticated(response), `${method} ${path} ${permission}`).toBe(false);
      if (!isAuthenticated(response)) expect(response.status).toBe(403);
    }
    const keyed = await requireAuth(
      limitedSupportRequest(x, { path: messagesPath(id), apiKey: "" }),
      "messages:read"
    );
    expect(isAuthenticated(keyed)).toBe(false);
    const { POST } = await import("@/app/api/conversations/[id]/messages/route");
    const post = limitedSupportRequest(x, { path: messagesPath(id), method: "POST" });
    expect((await POST(post, { params: Promise.resolve({ id }) })).status).toBeGreaterThanOrEqual(
      400
    );
    expect(await prisma.message.count({ where: { conversationId: id } })).toBe(6);
  });
  it("rejects a conflicting selected workspace and never falls back to owner membership", async () => {
    const x = await supportMessageFixture();
    const conflict = await readSupportMessages(x, x.visible.id, {
      cookieWorkspace: x.y.workspace.id,
    });
    expect(conflict.status).toBe(403);
    expect(await conflict.json()).toMatchObject({
      error: { code: "WORKSPACE_SELECTION_CONFLICT" },
    });
    for (const grantId of ["", randomUUID()]) {
      const response = await readSupportMessages(x, x.visible.id, { grantId });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await response.json())).not.toMatch(/support-text/);
    }
  });
  it.each(["grant", "session", "parent", "scope"] as const)(
    "discards loaded rows/count when %s changes after the message query",
    async (loss) => {
      const x = await supportMessageFixture();
      await afterSupportRows(async () => {
        if (loss === "grant")
          await revokeSupportGrant(x.actor.token, {
            grantId: x.grant.id,
            reason: "Synthetic post-message revoke",
          });
        if (loss === "session") await revokeToken(x.actor.token);
        if (loss === "parent")
          await prisma.conversation.update({
            where: { id: x.visible.id },
            data: { retiredAt: new Date() },
          });
        if (loss === "scope")
          await prisma.assignmentConnectionScope.deleteMany({
            where: { assignmentId: x.assignment!.id, connectionId: x.x.channel.id },
          });
      }, "message");
      const response = await readSupportMessages(x);
      expect(response.status).toBe({ grant: 403, session: 401, parent: 404, scope: 403 }[loss]);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const body = await response.json();
      expect(body).not.toHaveProperty("data");
      expect(body).not.toHaveProperty("pagination");
      expect(JSON.stringify(body)).not.toMatch(/support-text/);
    }
  );
  it.each(["placement", "audit"] as const)(
    "re-verifies the selected parent inside the final audited check after %s",
    async (point) => {
      const x = await supportMessageFixture();
      const retire = () =>
        prisma.conversation.update({
          where: { id: x.visible.id },
          data: { retiredAt: new Date() },
        });
      if (point === "placement") {
        const placement = await import("@/lib/platform/tenant-placement");
        const actual = placement.resolveTenantPlacement;
        let calls = 0;
        vi.spyOn(placement, "resolveTenantPlacement").mockImplementation(async (...args) => {
          const result = await actual(...args);
          if (++calls === 2) await retire();
          return result;
        });
      } else {
        const actual = audit.writePlatformAudit;
        let uses = 0;
        vi.spyOn(audit, "writePlatformAudit").mockImplementation(async (...args) => {
          const result = await actual(...args);
          if (args[1].action === "support.authorize" && ++uses === 2) await retire();
          return result;
        });
      }
      const response = await readSupportMessages(x);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await response.json())).not.toMatch(/support-text/);
    }
  );
  it("denies exposure if the final mandatory admission audit fails", async () => {
    const x = await supportMessageFixture();
    const actual = audit.writePlatformAudit;
    let uses = 0;
    vi.spyOn(audit, "writePlatformAudit").mockImplementation(async (...args) => {
      if (args[1].action === "support.authorize" && ++uses === 2)
        throw new Error("Synthetic final message exposure audit fault");
      return actual(...args);
    });
    const response = await readSupportMessages(x);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toMatch(/support-text/);
  });
  it.each(["assignment", "platform", "workspace", "expiry"] as const)(
    "denies initial message access after %s loss",
    async (loss) => {
      const x = await supportMessageFixture();
      if (loss === "assignment")
        await revokeAssignment(x.superUser.token, {
          assignmentId: x.assignment!.id,
          reason: "Synthetic ended assignment",
        });
      if (loss === "platform")
        await prisma.user.update({ where: { id: x.actor.user.id }, data: { platformRole: null } });
      if (loss === "workspace")
        await prisma.business.update({
          where: { id: x.x.workspace.id },
          data: { status: "suspended" },
        });
      if (loss === "expiry")
        await prisma.supportGrant.update({
          where: { id: x.grant.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      const response = await readSupportMessages(x);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.json()).not.toHaveProperty("data");
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  );
  it("retains ordinary membership message behavior, including media rows, without a support selection", async () => {
    const x = await supportMessageFixture();
    const { GET } = await import("@/app/api/conversations/[id]/messages/route");
    const request = new NextRequest("http://localhost:3000" + messagesPath(x.visible.id), {
      headers: { "x-workspace-id": x.x.workspace.id },
    });
    request.cookies.set("owly-token", x.actor.token);
    const response = await GET(request, { params: Promise.resolve({ id: x.visible.id }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body) ? body : body.data).toHaveLength(6);
  });
});
