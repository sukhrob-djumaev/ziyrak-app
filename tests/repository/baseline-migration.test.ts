import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * B10 (docs/billing-and-entitlements-spec.md) — existing workspaces migrate to the legacy baseline
 * without accidental billing, deletion or narrowed access. Replays the real migration chain in a
 * scratch database: build the schema up to just before 20261028000000_l4_1b_purchases, seed
 * workspaces the old way, apply that migration, then the rest.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const MIGRATIONS = path.resolve(__dirname, "../../prisma/migrations");
const BASELINE_MIGRATION = "20261028000000_l4_1b_purchases";
const all = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const cut = all.indexOf(BASELINE_MIGRATION);

function adminUrl(db: string) {
  const u = new URL(process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL!);
  u.pathname = `/${db}`;
  u.search = "";
  return u.toString();
}
async function apply(client: Client, dir: string) {
  await client.query(readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8"));
}
async function counts(client: Client): Promise<Record<string, number>> {
  const { rows } = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );
  const out: Record<string, number> = {};
  for (const { table_name } of rows) {
    const r = await client.query(`SELECT count(*)::int AS n FROM "${table_name}"`);
    out[table_name] = r.rows[0].n;
  }
  return out;
}

const scratch = `ziyrak_test_b10_${randomUUID().slice(0, 8)}`;
let admin: Client;
let db: Client;
const businessIds = [randomUUID(), randomUUID(), randomUUID()];
let before: Record<string, number>;

beforeAll(async () => {
  expect(cut).toBeGreaterThan(0);
  admin = new Client({ connectionString: adminUrl("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${scratch}"`);
  db = new Client({ connectionString: adminUrl(scratch) });
  await db.connect();
  for (const dir of all.slice(0, cut)) await apply(db, dir);
  for (const [i, id] of businessIds.entries()) {
    await db.query(
      `INSERT INTO "Business" ("id","slug","name","status","updatedAt") VALUES ($1,$2,$3,$4,now())`,
      [id, `b10-${i}-${id.slice(0, 6)}`, `Legacy ${i}`, i === 2 ? "suspended" : "active"],
    );
  }
  before = await counts(db);
}, 120_000);

afterAll(async () => {
  await db?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.end();
  }
});

describe("B10 baseline migration", () => {
  it("gives every existing workspace exactly one active baseline purchase and deletes nothing", async () => {
    await apply(db, BASELINE_MIGRATION);
    const { rows } = await db.query(
      `SELECT p."businessId", p."source", p."state", p."quantity", i."key", v."priceMinor", v."state" AS vstate
         FROM "WorkspacePurchase" p JOIN "CatalogVersion" v ON v."id" = p."versionId" JOIN "CatalogItem" i ON i."id" = v."itemId"`,
    );
    expect(rows).toHaveLength(businessIds.length);
    expect(new Set(rows.map((r) => r.businessId))).toEqual(new Set(businessIds));
    for (const r of rows) {
      expect(r).toMatchObject({ source: "baseline", state: "active", quantity: 1, key: "legacy-baseline", vstate: "published" });
      expect(r.priceMinor).toBe(0); // not sold: nothing is billed
    }
    const after = await counts(db);
    const SEEDED = new Set(["CatalogItem", "CatalogVersion", "WorkspacePurchase"]); // rows this migration is meant to add
    for (const [table, n] of Object.entries(before)) {
      if (SEEDED.has(table)) expect(after[table], table).toBeGreaterThanOrEqual(n);
      else expect(after[table], table).toBe(n);
    }
    const biz = await db.query(`SELECT "id","status" FROM "Business" WHERE "id" = ANY($1) ORDER BY "slug"`, [businessIds]);
    expect(biz.rows.map((r) => r.status)).toEqual(["active", "active", "suspended"]); // state untouched
  });

  it("grants exactly the pre-packaging capabilities and nothing wider", async () => {
    const { rows } = await db.query(`SELECT "grants" FROM "CatalogVersion" v JOIN "CatalogItem" i ON i."id" = v."itemId" WHERE i."key" = 'legacy-baseline'`);
    const grants = rows[0].grants as { capability: string; amount?: number }[];
    expect(grants.map((g) => g.capability).sort()).toEqual(
      ["automation.rules", "channel.webchat", "channel.whatsapp_cloud", "data.export", "seats.members", "webhooks.outbound"],
    );
    expect(grants.find((g) => g.capability === "seats.members")?.amount).toBe(1000);
  });

  it("a workspace created afterwards, even by an older app version, also receives the baseline", async () => {
    const id = randomUUID();
    await db.query(`INSERT INTO "Business" ("id","slug","name","updatedAt") VALUES ($1,$2,'Late',now())`, [id, `late-${id.slice(0, 6)}`]);
    const { rows } = await db.query(`SELECT "source","state" FROM "WorkspacePurchase" WHERE "businessId" = $1`, [id]);
    expect(rows).toEqual([{ source: "baseline", state: "active" }]);
  });

  it("later migrations keep every baseline purchase and mapping (restart/rollforward)", async () => {
    const pre = (await db.query(`SELECT count(*)::int AS n FROM "WorkspacePurchase" WHERE "source" = 'baseline' AND "state" = 'active'`)).rows[0].n;
    for (const dir of all.slice(cut + 1)) await apply(db, dir);
    const post = (await db.query(`SELECT count(*)::int AS n FROM "WorkspacePurchase" WHERE "source" = 'baseline' AND "state" = 'active'`)).rows[0].n;
    expect(post).toBe(pre);
    const biz = (await db.query(`SELECT count(*)::int AS n FROM "Business"`)).rows[0].n;
    expect(biz).toBe(businessIds.length + 1);
  }, 60_000);
});
