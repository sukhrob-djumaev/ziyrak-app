/**
 * PLAN.md §46.9 task 7 — minimal platform-admin tooling for dedicated
 * infrastructure. Internal/operator use only; there is deliberately no
 * tenant-facing or self-service surface (§46.9 "Explicitly deferred").
 *
 *   npm run infra -- status <businessId>
 *   npm run infra -- set-policy <businessId> [--region <r>] [--ai a,b|-] [--embedding a,b|-]
 *   DEDICATED_DATABASE_URL=… npm run infra -- provision <profileId> [--region <r>]
 *   npm run infra -- migrate <businessId> <profileId> --confirm-quiesced
 *   DEDICATED_ADMIN_DATABASE_URL=… npm run infra -- enable-rls <businessId> <profileId>
 *
 * Connection strings come from the environment, never arguments (shell
 * history/process listings), and are never printed. `-` clears an allowlist.
 * `migrate` has no write freeze: stop traffic and jobs for the business first.
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma/raw-client";
import { getInfrastructurePolicy } from "@/lib/platform/infrastructure-policy";
import { aiProviderRegistry } from "@/lib/ai/providers/registry";
import { embeddingProviderRegistry } from "@/lib/ai/providers/embedding-registry";
import { provisionDedicatedDatabase, migrateBusinessToDedicated, enableRowLevelSecurity } from "@/lib/platform/dedicated-database";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value === "-" ? [] : value.split(",").map((s) => s.trim()).filter(Boolean);
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}. See the usage in scripts/infra.ts.`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "status": {
      const businessId = need(args[0], "<businessId>");
      const placement = await prisma.tenantPlacement.findUnique({ where: { businessId } });
      const profile = placement && placement.databaseProfileId !== "shared-default"
        ? await prisma.databaseProfile.findUnique({ where: { id: placement.databaseProfileId }, select: { id: true, region: true, createdAt: true } })
        : null;
      console.log(JSON.stringify({ businessId, placement, profile, policy: await getInfrastructurePolicy(businessId) }, null, 2));
      return;
    }
    case "set-policy": {
      const businessId = need(args[0], "<businessId>");
      if (!(await prisma.business.findUnique({ where: { id: businessId }, select: { id: true } }))) throw new Error(`Business ${businessId} does not exist.`);
      const data = {
        dataRegion: flag(args, "region"),
        permittedAiProviders: list(flag(args, "ai")),
        permittedEmbeddingProviders: list(flag(args, "embedding")),
      };
      // A typo would silently block every provider (or, via "-", lift the restriction); reject unknown names.
      for (const name of data.permittedAiProviders ?? []) if (!aiProviderRegistry.has(name)) throw new Error(`Unknown AI provider "${name}".`);
      for (const name of data.permittedEmbeddingProviders ?? []) if (!embeddingProviderRegistry.has(name)) throw new Error(`Unknown embedding provider "${name}".`);
      if (data.permittedAiProviders?.length === 0 || data.permittedEmbeddingProviders?.length === 0) {
        console.warn("Note: an empty allowlist means NO restriction for that capability.");
      }
      const policy = await prisma.infrastructurePolicy.upsert({ where: { businessId }, update: data, create: { businessId, ...data } });
      console.log(JSON.stringify(policy, null, 2));
      return;
    }
    case "provision": {
      const profileId = need(args[0], "<profileId>");
      await provisionDedicatedDatabase({
        profileId,
        connectionString: need(process.env.DEDICATED_DATABASE_URL, "DEDICATED_DATABASE_URL"),
        region: flag(args, "region"),
      });
      console.log(`Provisioned DatabaseProfile "${profileId}". No business has been moved; run migrate next.`);
      return;
    }
    case "migrate": {
      if (!args.includes("--confirm-quiesced")) throw new Error("Refusing to migrate without --confirm-quiesced (no traffic or active jobs for this business).");
      const report = await migrateBusinessToDedicated({ businessId: need(args[0], "<businessId>"), profileId: need(args[1], "<profileId>") });
      console.log(JSON.stringify(report, null, 2));
      console.warn(
        "Cutover committed. Requests already holding a context built before it (and, with Redis, a cached placement for up to 30 s) can still write to the shared database: keep the business quiesced for at least a minute."
      );
      return;
    }
    case "enable-rls": {
      await enableRowLevelSecurity({
        businessId: need(args[0], "<businessId>"),
        profileId: need(args[1], "<profileId>"),
        adminConnectionString: need(process.env.DEDICATED_ADMIN_DATABASE_URL, "DEDICATED_ADMIN_DATABASE_URL"),
      });
      console.log("Row-level security enabled; the profile now holds only the restricted role's credentials.");
      return;
    }
    default:
      throw new Error("Usage: status | set-policy | provision | migrate | enable-rls — see scripts/infra.ts");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
