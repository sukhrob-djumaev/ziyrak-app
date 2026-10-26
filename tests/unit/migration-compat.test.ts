import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L2.2: rollback is "redeploy the previous image digest against the newer schema", so every migration must stay
 * compatible with the previous app version (expand, then contract in a LATER release). A migration that drops,
 * renames, retypes or adds a required column without a default breaks that. Such a "contract" migration is allowed
 * only with an explicit `-- contract-migration: <reason>` line, which makes it a reviewed, deliberate decision.
 * See docs/guides/operations-runbook.md.
 */
const root = join(__dirname, "../../prisma/migrations");
const GRANDFATHERED = new Set([
  // Phase 1 contract steps, shipped before this rule existed and long since rolled out everywhere.
  "20260916134500_phase1_contract_business_id_required",
  "20260916140000_phase1_add_composite_tenant_fks",
]);
const BREAKING: Array<[RegExp, string]> = [
  [/\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA)\b/i, "drops something the previous version may still use"],
  [/\bRENAME\b/i, "renames something the previous version may still use"],
  [/\bALTER\s+COLUMN\b[^;]*\b(TYPE|SET\s+NOT\s+NULL)\b/i, "retypes or tightens a column the previous version writes"],
  [/\bDROP\s+(CONSTRAINT|INDEX)\b/i, "removes a constraint or index the previous version may rely on"],
  [/\b(TRUNCATE|DELETE\s+FROM)\b/i, "removes data"],
];
const addRequiredWithoutDefault = /\bADD\s+COLUMN\s+"?\w+"?\s+[^,;]*\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i;

const migrations = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const sqlOf = (name: string) => readFileSync(join(root, name, "migration.sql"), "utf8").replace(/--(?!\s*contract-migration:).*$/gm, "");

describe("migrations are rollback-compatible (expand/contract)", () => {
  it("finds the migrations", () => expect(migrations.length).toBeGreaterThan(20));

  it.each(migrations.filter((m) => !GRANDFATHERED.has(m)))("%s has no unapproved breaking change", (name) => {
    const raw = readFileSync(join(root, name, "migration.sql"), "utf8");
    const approved = /^--\s*contract-migration:\s*\S.{8,}/m.test(raw);
    const sql = sqlOf(name);
    const problems = [
      ...BREAKING.filter(([re]) => re.test(sql)).map(([, why]) => why),
      ...(addRequiredWithoutDefault.test(sql) ? ["adds a required column without a default (the previous version cannot insert)"] : []),
    ];
    if (approved) return;
    expect(problems, `${name}: add '-- contract-migration: <reason>' only if the previous release no longer depends on this`).toEqual([]);
  });

  it("the guard actually detects the patterns (so it cannot silently go blind)", () => {
    for (const bad of ['ALTER TABLE "T" DROP COLUMN "x";', 'ALTER TABLE "T" RENAME COLUMN "a" TO "b";', 'ALTER TABLE "T" ALTER COLUMN "a" SET NOT NULL;', 'DROP INDEX "i";', 'DELETE FROM "T";'])
      expect(BREAKING.some(([re]) => re.test(bad)), bad).toBe(true);
    expect(addRequiredWithoutDefault.test('ALTER TABLE "T" ADD COLUMN "a" TEXT NOT NULL;')).toBe(true);
    expect(addRequiredWithoutDefault.test("ALTER TABLE \"T\" ADD COLUMN \"a\" TEXT NOT NULL DEFAULT 'x';")).toBe(false);
    expect(addRequiredWithoutDefault.test('ALTER TABLE "T" ADD COLUMN "a" TEXT;')).toBe(false);
  });
});
