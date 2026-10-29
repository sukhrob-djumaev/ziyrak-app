import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §46.9 task 6 / §8.8 — Postgres RLS as an additional layer for a
 * business on a dedicated database. The runtime connection is a dedicated,
 * non-superuser role (`tenant_<businessId>`) whose RLS policy compares each
 * row's businessId to the role's own name — an identity a session cannot
 * change, unlike a `SET app.tenant_id` setting. The tests simulate the
 * failure RLS exists for: an application-layer bug that bypasses the scoping
 * extension (and so sends raw, unscoped SQL) while rows of another business
 * are present in the same database.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { prisma } from "@/lib/prisma/raw-client";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { resolveTenantPlacement, getDataPlaneClient, closeDedicatedClients } from "@/lib/platform/tenant-placement";
import { provisionDedicatedDatabase, migrateBusinessToDedicated, enableRowLevelSecurity } from "@/lib/platform/dedicated-database";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

const SHARED_URL = process.env.DATABASE_URL!;
const DEDICATED_DB = `ziyrak_rls_${Date.now()}_${process.pid}`;
const adminUrl = SHARED_URL.replace(/\/[^/?]+(\?|$)/, `/${DEDICATED_DB}$1`);
const PROFILE_ID = `rls-test-${Date.now()}`;

let owner: SeededBusiness;
let neighbour: SeededBusiness;
let outsider: SeededBusiness;
let admin: PrismaClient;
let runtime: PrismaClient;

async function seed(business: SeededBusiness, customers: number) {
  const db = getScopedPrisma(business.ctx);
  for (let i = 0; i < customers; i++) await db.customer.create({ data: { name: `c${i}`, businessId: business.businessId } });
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${DEDICATED_DB}"`);
  owner = await seedBusiness("rls-owner");
  neighbour = await seedBusiness("rls-neighbour");
  await seed(owner, 3);
  await seed(neighbour, 2);
  outsider = await seedBusiness("rls-outsider");

  await provisionDedicatedDatabase({ profileId: PROFILE_ID, connectionString: adminUrl });
  await migrateBusinessToDedicated({ businessId: owner.businessId, profileId: PROFILE_ID });

  admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: adminUrl, max: 2 }) });
  await enableRowLevelSecurity({ profileId: PROFILE_ID, businessId: owner.businessId, adminConnectionString: adminUrl });

  // The failure RLS exists for: another business's rows end up in this database
  // (a misrouted write, a bad restore). Planted with the admin connection after
  // RLS is on, since the application role itself could never write them.
  const [anchor] = await prisma.$queryRawUnsafe<{ j: string }[]>(`select to_jsonb(b)::text as j from "Business" b where id = $1`, neighbour.businessId);
  await admin.$executeRawUnsafe(`insert into "Business" select * from jsonb_populate_record(null::"Business", $1::jsonb)`, anchor.j);
  const strays = await prisma.$queryRawUnsafe<{ j: string }[]>(`select to_jsonb(c)::text as j from "Customer" c where "businessId" = $1`, neighbour.businessId);
  await admin.$executeRawUnsafe(`insert into "Customer" select * from jsonb_populate_recordset(null::"Customer", $1::jsonb)`, `[${strays.map((r) => r.j).join(",")}]`);

  const placement = await resolveTenantPlacement(owner.businessId);
  runtime = getDataPlaneClient(placement.dataConnection);
}, 180000);

afterAll(async () => {
  await closeDedicatedClients();
  await admin?.$disconnect();
  await cleanupBusiness(owner.businessId);
  await cleanupBusiness(neighbour.businessId);
  await cleanupBusiness(outsider.businessId);
  await prisma.databaseProfile.deleteMany({ where: { id: PROFILE_ID } });
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DEDICATED_DB}" WITH (FORCE)`);
  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "tenant_${owner.businessId}"`).catch(() => {});
}, 60000);

describe("RLS on a dedicated database (§46.9 task 6)", () => {
  it("runs the application as a non-superuser, non-bypass role named for the tenant", async () => {
    const [row] = await runtime.$queryRawUnsafe<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]>(
      `select current_user, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user`
    );
    expect(row.current_user).toBe(`tenant_${owner.businessId}`);
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
  });

  it("leaves the normal scoped-client API working", async () => {
    const db = getScopedPrisma({ ...owner.ctx, dataConnection: `dedicated:${PROFILE_ID}` });
    expect(await db.customer.count()).toBe(3);
    await db.customer.create({ data: { name: "via-scoped", businessId: owner.businessId } });
    expect(await db.customer.count()).toBe(4);
  });

  it("blocks an unscoped raw read: only this tenant's rows are visible even though another business's rows are in the database", async () => {
    const [{ n: total }] = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*) as n from "Customer"`);
    expect(Number(total)).toBeGreaterThan(4); // the neighbour's rows really are in this database

    const [{ n }] = await runtime.$queryRawUnsafe<{ n: bigint }[]>(`select count(*) as n from "Customer"`);
    expect(Number(n)).toBe(4);
    const businesses = await runtime.$queryRawUnsafe<{ businessId: string }[]>(`select distinct "businessId" from "Customer"`);
    expect(businesses).toEqual([{ businessId: owner.businessId }]);
  });

  it("blocks raw cross-tenant writes: insert is rejected, update and delete touch nothing", async () => {
    await expect(
      runtime.$executeRawUnsafe(`insert into "Customer" (id, "businessId", name, "updatedAt") values ('rls-evil', $1, 'evil', now())`, neighbour.businessId)
    ).rejects.toThrow(/row-level security/i);
    expect(await runtime.$executeRawUnsafe(`update "Customer" set name = 'pwned' where "businessId" = $1`, neighbour.businessId)).toBe(0);
    expect(await runtime.$executeRawUnsafe(`delete from "Customer" where "businessId" = $1`, neighbour.businessId)).toBe(0);
    const [{ n }] = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*) as n from "Customer" where "businessId" = $1 and name = 'pwned'`, neighbour.businessId);
    expect(Number(n)).toBe(0);
  });

  it("cannot be talked out of it from inside the session", async () => {
    await expect(runtime.$executeRawUnsafe(`set role postgres`)).rejects.toThrow();
    // A setting-based scheme would fall to this; an identity-based policy does not.
    const [{ n }] = await runtime.$queryRawUnsafe<{ n: bigint }[]>(
      `select count(*) as n from "Customer" where set_config('app.tenant_id', $1, false) = $1 and "businessId" = $1`,
      neighbour.businessId
    );
    expect(Number(n)).toBe(0);
  });

  it("gives the application role no access to control-plane tables", async () => {
    await expect(runtime.$queryRawUnsafe(`select * from "User"`)).rejects.toThrow(/permission denied/i);
    await expect(runtime.$queryRawUnsafe(`select * from "DatabaseProfile"`)).rejects.toThrow(/permission denied/i);
  });
});

describe("enableRowLevelSecurity refuses a mismatched target (security review)", () => {
  it("refuses a business that is not placed on the profile", async () => {
    await expect(
      enableRowLevelSecurity({ profileId: PROFILE_ID, businessId: outsider.businessId, adminConnectionString: adminUrl })
    ).rejects.toThrow(/not placed on/i);
  });

  it("refuses an administrative connection to a different database than the profile's", async () => {
    await expect(
      enableRowLevelSecurity({ profileId: PROFILE_ID, businessId: owner.businessId, adminConnectionString: SHARED_URL })
    ).rejects.toThrow(/does not match/i);
  });

  it("refuses a database that holds more than this one business (it would lock the others out)", async () => {
    // The neighbour's stray Business row is in this database (planted in beforeAll).
    await expect(
      enableRowLevelSecurity({ profileId: PROFILE_ID, businessId: owner.businessId, adminConnectionString: adminUrl })
    ).rejects.toThrow(/exactly one/i);
  });

  it("gives the application role no way to create objects", async () => {
    await expect(runtime.$executeRawUnsafe(`create table rls_probe (i int)`)).rejects.toThrow(/permission denied/i);
  });
});
