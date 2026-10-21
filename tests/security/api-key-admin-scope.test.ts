import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import {
  seedBusiness,
  addMember,
  cleanupBusiness,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";
import * as keys from "@/lib/identity/admin-api-keys/service";

/**
 * P1: a connection-restricted admin may manage only the API keys they issued themselves; a
 * workspace-wide key (or another person's key) is invisible to them and cannot be changed.
 */
let a: SeededBusiness;
let restricted: TenantContext;
let wide: Awaited<ReturnType<typeof keys.create>>["apiKey"];

beforeEach(async () => {
  a = await seedBusiness("api-key-admin-scope");
  wide = (await keys.create(a.ctx, "Workspace-wide key")).apiKey;
  const connection = await prisma.channelConnection.create({
    data: { businessId: a.businessId, type: "scope-test", name: "Line", isActive: true },
  });
  const admin = await addMember(a.businessId, "admin", "restricted-admin");
  restricted = {
    ...admin.ctx,
    resourceScope: {
      kind: "connections",
      connectionIds: [connection.id],
      customerProfileAccess: "read",
    },
  };
});
afterEach(async () => {
  await cleanupBusiness(a.businessId);
});

describe("P1 API key administration under a connection-restricted admin", () => {
  it("does not list keys the restricted admin did not issue", async () => {
    const mine = (await keys.create(restricted, "Restricted key")).apiKey;
    const { keys: listed, total } = await keys.list(restricted, { skip: 0, take: 50 });
    expect(listed.map((k) => k.id)).toEqual([mine.id]);
    expect(total).toBe(1);
  });

  it("cannot reactivate, rename or delete a workspace-wide key", async () => {
    await keys.update(a.ctx, wide.id, { isActive: false });
    await expect(keys.update(restricted, wide.id, { isActive: true })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(keys.update(restricted, wide.id, { name: "taken over" })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(keys.remove(restricted, wide.id)).rejects.toMatchObject({ statusCode: 404 });
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: wide.id } });
    expect(row.isActive).toBe(false);
    expect(row.name).toBe("Workspace-wide key");
  });

  it("can still manage a key it issued itself", async () => {
    const mine = (await keys.create(restricted, "Restricted key")).apiKey;
    await expect(keys.update(restricted, mine.id, { name: "renamed" })).resolves.toMatchObject({
      name: "renamed",
    });
    await keys.remove(restricted, mine.id);
    expect(await prisma.apiKey.count({ where: { id: mine.id } })).toBe(0);
  });

  it("leaves workspace-wide administration unchanged", async () => {
    const { keys: listed } = await keys.list(a.ctx, { skip: 0, take: 50 });
    expect(listed.map((k) => k.id)).toContain(wide.id);
    await expect(keys.update(a.ctx, wide.id, { isActive: false })).resolves.toBeDefined();
  });
});
