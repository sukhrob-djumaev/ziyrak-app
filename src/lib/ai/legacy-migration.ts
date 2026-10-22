import { prisma } from "@/lib/prisma/raw-client";
import { getDefaultBusinessId } from "@/lib/tenancy/default-business";

/**
 * PLAN.md P2 — the explicit transition for existing tenant AI settings. It
 * never moves, deletes or decrypts a credential and never switches anyone to
 * the platform-managed service: it only records `legacy_byok` for workspaces
 * that already run on their own key, so the platform console shows them and
 * an administrator flips each one deliberately. Rollback removes exactly the
 * rows a run created.
 */
export interface LegacyMigrationCandidate {
  businessId: string;
  name: string;
  source: "business_config" | "legacy_settings";
}

interface Options {
  /** Restrict to these workspaces (used by tests and by staged rollouts). */
  only?: string[];
}

export async function planLegacyAiMigration(options: Options = {}): Promise<LegacyMigrationCandidate[]> {
  const candidates: LegacyMigrationCandidate[] = [];

  const withOwnKey = await prisma.business.findMany({
    where: {
      aiAllowance: null,
      status: { not: "deleted" },
      id: { in: await keyedConfigIds(options.only) },
    },
    select: { id: true, name: true },
  });
  for (const b of withOwnKey) candidates.push({ businessId: b.id, name: b.name, source: "business_config" });

  const settings = await prisma.settings.findUnique({ where: { id: "default" }, select: { aiApiKey: true } });
  if (settings?.aiApiKey) {
    const defaultId = await getDefaultBusinessId();
    const inScope = !options.only || options.only.includes(defaultId);
    if (inScope && !candidates.some((c) => c.businessId === defaultId)) {
      const biz = await prisma.business.findFirst({ where: { id: defaultId, aiAllowance: null }, select: { id: true, name: true } });
      if (biz) candidates.push({ businessId: biz.id, name: biz.name, source: "legacy_settings" });
    }
  }
  return candidates;
}

async function keyedConfigIds(only?: string[]): Promise<string[]> {
  const rows = await prisma.businessConfig.findMany({
    where: {
      ...(only ? { businessId: { in: only } } : {}),
      OR: [{ aiCredentialRef: { not: null } }, { embeddingCredentialRef: { not: null } }],
    },
    select: { businessId: true },
  });
  return rows.map((r) => r.businessId);
}

export async function applyLegacyAiMigration(options: Options = {}): Promise<{ created: string[] }> {
  const plan = await planLegacyAiMigration(options);
  const created: string[] = [];
  for (const candidate of plan) {
    const result = await prisma.workspaceAiAllowance.createMany({
      data: [{ businessId: candidate.businessId, mode: "legacy_byok" }],
      skipDuplicates: true,
    });
    if (result.count === 1) created.push(candidate.businessId);
  }
  return { created };
}

export async function rollbackLegacyAiMigration(createdBusinessIds: string[]): Promise<number> {
  const result = await prisma.workspaceAiAllowance.deleteMany({
    where: { businessId: { in: createdBusinessIds }, mode: "legacy_byok" },
  });
  return result.count;
}
