import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * PLAN.md P2 completion criterion — existing encrypted tenant settings migrate
 * through an explicit, tested transition: no silent loss, no surprise switch.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { encryptAIProviderCredential } from "@/lib/ai/config";
import { planLegacyAiMigration, applyLegacyAiMigration, rollbackLegacyAiMigration } from "@/lib/ai/legacy-migration";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let withKey: SeededBusiness;
let without: SeededBusiness;
let alreadyManaged: SeededBusiness;
let scope: string[];

beforeAll(async () => {
  withKey = await seedBusiness("ai-mig-key");
  without = await seedBusiness("ai-mig-nokey");
  alreadyManaged = await seedBusiness("ai-mig-managed");
  scope = [withKey, without, alreadyManaged].map((b) => b.businessId);
});
afterAll(async () => {
  for (const b of [withKey, without, alreadyManaged]) await cleanupBusiness(b.businessId);
});
beforeEach(async () => {
  const ids = [withKey, without, alreadyManaged].map((b) => b.businessId);
  await prisma.workspaceAiAllowance.deleteMany({ where: { businessId: { in: ids } } });
  await prisma.businessConfig.upsert({
    where: { businessId: withKey.businessId },
    create: { businessId: withKey.businessId, aiCredentialRef: await encryptAIProviderCredential("openai", "tenant-key") },
    update: { aiCredentialRef: await encryptAIProviderCredential("openai", "tenant-key") },
  });
  await prisma.workspaceAiAllowance.create({ data: { businessId: alreadyManaged.businessId, mode: "managed" } });
});

describe("legacy AI migration", () => {
  it("dry run lists workspaces with their own key and writes nothing", async () => {
    const plan = await planLegacyAiMigration({ only: scope });
    const ids = plan.map((p) => p.businessId);
    expect(ids).toContain(withKey.businessId);
    expect(ids).not.toContain(alreadyManaged.businessId);
    expect(JSON.stringify(plan)).not.toContain("tenant-key");
    expect(await prisma.workspaceAiAllowance.count({ where: { businessId: withKey.businessId } })).toBe(0);
  });

  it("apply records legacy_byok for the planned workspaces only, keeps their key and behavior, and is repeatable", async () => {
    const before = await prisma.businessConfig.findUniqueOrThrow({ where: { businessId: withKey.businessId } });
    const first = await applyLegacyAiMigration({ only: scope });
    const second = await applyLegacyAiMigration({ only: scope });
    expect(first.created).toContain(withKey.businessId);
    expect(second.created).not.toContain(withKey.businessId);
    expect((await prisma.workspaceAiAllowance.findUniqueOrThrow({ where: { businessId: withKey.businessId } })).mode).toBe("legacy_byok");
    expect((await prisma.workspaceAiAllowance.findUniqueOrThrow({ where: { businessId: alreadyManaged.businessId } })).mode).toBe("managed");
    const after = await prisma.businessConfig.findUniqueOrThrow({ where: { businessId: withKey.businessId } });
    expect(after.aiCredentialRef).toBe(before.aiCredentialRef);
    expect(await prisma.workspaceAiAllowance.count({ where: { businessId: without.businessId } })).toBe(0);
  });

  it("rollback removes only the rows the migration created", async () => {
    const run = await applyLegacyAiMigration({ only: scope });
    await rollbackLegacyAiMigration(run.created);
    expect(await prisma.workspaceAiAllowance.count({ where: { businessId: withKey.businessId } })).toBe(0);
    expect((await prisma.workspaceAiAllowance.findUniqueOrThrow({ where: { businessId: alreadyManaged.businessId } })).mode).toBe("managed");
  });
});
