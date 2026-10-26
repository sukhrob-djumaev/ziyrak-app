import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * L2.2: rollback is "redeploy the previous image digest against the newer schema", so every migration must stay
 * compatible with the previous app version (expand, then contract in a LATER release). A migration that drops,
 * renames, retypes or adds a required column without a default breaks that. Such a "contract" migration is allowed
 * only with an explicit `-- contract-migration: <reason>` comment immediately above THAT statement, which makes it a
 * reviewed, deliberate decision for that statement alone. The check is a pattern guard, not a SQL parser: it reads
 * statements (comments and string literals removed) and flags the common breaking forms.
 * See docs/guides/operations-runbook.md.
 */
const root = join(__dirname, "../../prisma/migrations");
// Every migration up to and including this one shipped before the guard existed and is already rolled out everywhere
// (several carry deliberate contract steps). The guard applies to every migration added after it.
const GUARD_APPLIES_AFTER = "20261026030000_l2_1_worker_heartbeat";
const BREAKING: Array<[RegExp, string]> = [
  [/\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|TRIGGER|POLICY|SEQUENCE|RULE|EXTENSION|DOMAIN)\b/i, "drops something the previous version may still use"],
  [/\bALTER\s+TABLE\b[^;]*\bDROP\s+(?!COLUMN\b|TABLE\b|CONSTRAINT\b|INDEX\b|DEFAULT\b|NOT\b|IDENTITY\b|EXPRESSION\b)\S/i, "drops a column (without the COLUMN keyword)"],
  [/\bRENAME\b/i, "renames something the previous version may still use"],
  [/\bALTER\s+(COLUMN\s+)?"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i, "retypes a column the previous version writes"],
  [/\bSET\s+NOT\s+NULL\b/i, "tightens a column the previous version writes"],
  [/\bDROP\s+DEFAULT\b/i, "removes a default the previous version may rely on"],
  [/\bDROP\s+(CONSTRAINT|INDEX)\b/i, "removes a constraint or index the previous version may rely on"],
  [/\bCREATE\s+UNIQUE\s+INDEX\b/i, "adds uniqueness the previous version may violate"],
  [/\bADD\s+(CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\b|FOREIGN\s+KEY\b|CHECK\b)/i, "adds a constraint the previous version may violate"],
  [/\b(TRUNCATE|DELETE\s+FROM)\b/i, "removes data"],
  [/\bUPDATE\s+"?\w+"?\s+SET\b/i, "rewrites existing data (check the previous version still reads it)"],
];
// ADD [COLUMN] "a" TYPE ... NOT NULL without DEFAULT. COLUMN is optional in Postgres; identifiers may be quoted.
const addRequiredWithoutDefault = /\bADD\s+(COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b)"?\w+"?\s+[^,;]*\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i;

/** Remove comments and string/identifier-quoted content that is not code, but keep the approval markers. */
function statementsOf(raw: string): Array<{ sql: string; approved: boolean }> {
  const out: Array<{ sql: string; approved: boolean }> = [];
  let cur = "";
  let approved = false;
  let i = 0;
  const flush = () => {
    if (cur.trim()) out.push({ sql: cur.trim(), approved });
    cur = "";
    approved = false;
  };
  while (i < raw.length) {
    const c = raw[i];
    if (c === "-" && raw[i + 1] === "-") {
      const end = raw.indexOf("\n", i);
      const line = raw.slice(i, end === -1 ? raw.length : end);
      if (/^--\s*contract-migration:\s*\S.{8,}/.test(line) && !cur.trim()) approved = true;
      i = end === -1 ? raw.length : end;
    } else if (c === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      i = end === -1 ? raw.length : end + 2;
    } else if (c === "'") {
      let j = i + 1;
      while (j < raw.length) {
        if (raw[j] === "'" && raw[j + 1] === "'") j += 2;
        else if (raw[j] === "'") break;
        else j++;
      }
      cur += "''";
      i = j + 1;
    } else if (c === "$" && /^\$(\w*)\$/.test(raw.slice(i))) {
      const tag = raw.slice(i).match(/^\$(\w*)\$/)![0];
      const end = raw.indexOf(tag, i + tag.length);
      cur += " $body$ ";
      i = end === -1 ? raw.length : end + tag.length;
    } else if (c === ";") {
      flush();
      i++;
    } else {
      cur += c;
      i++;
    }
  }
  flush();
  return out;
}
export const problemsIn = (sql: string): string[] => [
  ...BREAKING.filter(([re]) => re.test(sql)).map(([, why]) => why),
  ...(addRequiredWithoutDefault.test(sql) ? ["adds a required column without a default (the previous version cannot insert)"] : []),
];

const migrations = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

describe("migrations are rollback-compatible (expand/contract)", () => {
  it("finds the migrations", () => {
    expect(migrations.length).toBeGreaterThan(20);
    expect(migrations).toContain(GUARD_APPLIES_AFTER);
  });

  it.each(migrations.filter((m) => m > GUARD_APPLIES_AFTER))("%s has no unapproved breaking change", (name) => {
    const stmts = statementsOf(readFileSync(join(root, name, "migration.sql"), "utf8"));
    // A table created by this very migration has no rows and no old-version writers, so constraints on it are safe.
    const created = new Set(stmts.flatMap((s) => [...s.sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi)].map((m) => m[1].replace(/"/g, ""))));
    const onNewTable = (sql: string) => {
      const m = sql.match(/\bALTER\s+TABLE\s+(?:ONLY\s+)?("?[\w.]+"?)/i) ?? sql.match(/\bCREATE\s+UNIQUE\s+INDEX\b[^()]*?\bON\s+(?:ONLY\s+)?("?[\w.]+"?)/i);
      return !!m && created.has(m[1].replace(/"/g, ""));
    };
    const problems = stmts
      .filter((s) => !s.approved)
      .flatMap((s) => problemsIn(s.sql).filter((p) => !(onNewTable(s.sql) && /constraint|uniqueness/.test(p))).map((p) => `${p}: ${s.sql.slice(0, 90)}`));
    expect(problems, `${name}: put '-- contract-migration: <reason>' directly above a statement only if the previous release no longer depends on it`).toEqual([]);
  });

  it("the guard detects the breaking forms (so it cannot silently go blind)", () => {
    const bad = [
      'ALTER TABLE "T" DROP COLUMN "x"', 'ALTER TABLE "T" DROP "x"', 'ALTER TABLE "T" RENAME COLUMN "a" TO "b"',
      'ALTER TABLE "T" ALTER COLUMN "a" SET NOT NULL', 'ALTER TABLE "T" ALTER COLUMN "a" TYPE INTEGER', 'ALTER TABLE "T" ALTER "a" TYPE INTEGER',
      'ALTER TABLE "T" ALTER COLUMN "a" DROP DEFAULT', 'DROP INDEX "i"', 'DELETE FROM "T"', 'DROP VIEW "v"', 'DROP FUNCTION f()', 'DROP TRIGGER t ON "T"',
      'DROP POLICY p ON "T"', 'DROP SEQUENCE s', 'CREATE UNIQUE INDEX "i" ON "T"("a")', 'ALTER TABLE "T" ADD CONSTRAINT c UNIQUE ("a")',
      'ALTER TABLE "T" ADD "a" TEXT NOT NULL', 'ALTER TABLE "T" ADD COLUMN "a" TEXT NOT NULL', 'ALTER TABLE "T" ADD COLUMN IF NOT EXISTS a TEXT NOT NULL',
      'UPDATE "T" SET "a" = 1',
    ];
    for (const sql of bad) expect(problemsIn(sql).length, sql).toBeGreaterThan(0);
    for (const ok of [
      'ALTER TABLE "T" ADD COLUMN "a" TEXT', "ALTER TABLE \"T\" ADD COLUMN \"a\" TEXT NOT NULL DEFAULT 'x'", 'CREATE TABLE "N" ("id" TEXT NOT NULL)',
      'CREATE INDEX "i" ON "T"("a")', 'ALTER TABLE "T" ADD COLUMN "a" TEXT, ADD COLUMN "b" INT',
    ]) expect(problemsIn(ok), ok).toEqual([]);
  });

  it("an approval covers only the statement it sits above, and comments or strings do not hide or fake a break", () => {
    const sql = [
      "-- contract-migration: the 2026-10 release no longer reads the column", 'ALTER TABLE "T" DROP COLUMN "old";', 'ALTER TABLE "T" DROP COLUMN "other";',
      "-- DROP TABLE \"in_a_comment\";", "INSERT INTO \"T\" (\"a\") VALUES ('DROP TABLE x; DELETE FROM y');",
    ].join("\n");
    const st = statementsOf(sql);
    expect(st.map((s) => s.approved)).toEqual([true, false, false]);
    expect(st.filter((s) => !s.approved).flatMap((s) => problemsIn(s.sql))).toHaveLength(1);
  });
});
