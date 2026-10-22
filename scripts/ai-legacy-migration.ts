/**
 * PLAN.md P2 — records `legacy_byok` for workspaces that already use their own
 * AI key. Dry run by default; never touches a credential or switches a
 * workspace to the managed service.
 *
 *   npx tsx scripts/ai-legacy-migration.ts                 # dry run
 *   npx tsx scripts/ai-legacy-migration.ts --apply         # writes + prints a rollback file path
 *   npx tsx scripts/ai-legacy-migration.ts --rollback <file>
 */
import { writeFileSync, readFileSync } from "node:fs";
import { planLegacyAiMigration, applyLegacyAiMigration, rollbackLegacyAiMigration } from "../src/lib/ai/legacy-migration";

async function main() {
  const args = process.argv.slice(2);
  const rollbackIndex = args.indexOf("--rollback");
  if (rollbackIndex >= 0) {
    const file = args[rollbackIndex + 1];
    if (!file) throw new Error("--rollback needs the file written by --apply");
    const created: string[] = JSON.parse(readFileSync(file, "utf8")).created;
    console.log(`Removed ${await rollbackLegacyAiMigration(created)} legacy_byok rows.`);
    return;
  }
  if (!args.includes("--apply")) {
    const plan = await planLegacyAiMigration();
    console.log(`Dry run: ${plan.length} workspace(s) would be recorded as legacy_byok.`);
    for (const c of plan) console.log(`  ${c.businessId}  ${c.name}  (${c.source})`);
    return;
  }
  const { created } = await applyLegacyAiMigration();
  const file = `ai-legacy-migration-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify({ created }, null, 2));
  console.log(`Recorded ${created.length} workspace(s) as legacy_byok. Rollback file: ${file}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
