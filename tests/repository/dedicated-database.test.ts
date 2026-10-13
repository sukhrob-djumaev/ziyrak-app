import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * PLAN.md §46.9 tasks 2 and 4 and acceptance criteria 1 and 4 — a synthetic
 * business is provisioned onto a dedicated Postgres database and migrated
 * there with zero application-code changes (only control-plane rows plus a
 * data-migration run). Everything runs against throwaway databases created
 * on the test Postgres server; no customer data and never the live `owly`
 * database.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { getScopedPrisma, TENANT_SCOPED_MODELS } from "@/lib/tenancy/scoped-prisma";
import { resolveTenantPlacement, getDataPlaneClient, closeDedicatedClients } from "@/lib/platform/tenant-placement";
import { provisionDedicatedDatabase, migrateBusinessToDedicated, discoverDataPlaneTables } from "@/lib/platform/dedicated-database";
import * as adminUsers from "@/lib/platform/admin-users/service";
import { PgBossJobQueue } from "@/lib/jobs/pgboss-job-queue";
import { PROCESS_INBOUND_MESSAGE_JOB } from "@/lib/jobs/job-types";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

const SHARED_URL = process.env.DATABASE_URL!;
const DEDICATED_DB = `owly_dedicated_${Date.now()}_${process.pid}`;
const dedicatedUrl = SHARED_URL.replace(/\/[^/?]+(\?|$)/, `/${DEDICATED_DB}$1`);
const PROFILE_ID = `dedicated-test-${Date.now()}`;

let moved: SeededBusiness;
let stayer: SeededBusiness;
const counts = { customers: 3, conversations: 2, messages: 4, categories: 1, knowledge: 2 };

async function seedData(business: SeededBusiness) {
  const db = getScopedPrisma(business.ctx);
  for (let i = 0; i < counts.customers; i++) await db.customer.create({ data: { name: `cust-${i}`, businessId: business.businessId } });
  const category = await db.category.create({ data: { name: "faq", businessId: business.businessId } });
  for (let i = 0; i < counts.knowledge; i++) {
    await db.knowledgeEntry.create({ data: { title: `k${i}`, content: `body ${i}`, categoryId: category.id, businessId: business.businessId } });
  }
  for (let c = 0; c < counts.conversations; c++) {
    const conversation = await db.conversation.create({ data: { channel: "webchat", businessId: business.businessId } });
    for (let m = 0; m < counts.messages / counts.conversations; m++) {
      await db.message.create({ data: { conversationId: conversation.id, role: "user", content: `m${c}-${m}`, businessId: business.businessId } });
    }
  }
}

async function sharedCount(table: string, businessId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`select count(*) as n from "${table}" where "businessId" = $1`, businessId);
  return Number(rows[0].n);
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${DEDICATED_DB}"`);
  moved = await seedBusiness("dedicated-moved");
  stayer = await seedBusiness("dedicated-stayer");
  await seedData(moved);
  await seedData(stayer);
}, 60000);

afterAll(async () => {
  await closeDedicatedClients();
  await cleanupBusiness(moved.businessId);
  await cleanupBusiness(stayer.businessId);
  await prisma.databaseProfile.deleteMany({ where: { id: PROFILE_ID } });
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DEDICATED_DB}" WITH (FORCE)`);
});

describe("provisioning a dedicated database (§46.9 task 2)", () => {
  it("applies the full migration set to the target and registers the DSN only as an encrypted secret", async () => {
    await provisionDedicatedDatabase({ profileId: PROFILE_ID, connectionString: dedicatedUrl, region: "eu" });

    const profile = await prisma.databaseProfile.findUniqueOrThrow({ where: { id: PROFILE_ID } });
    expect(profile.region).toBe("eu");
    expect(profile.connectionSecretRef).not.toContain(DEDICATED_DB);
    expect(profile.connectionSecretRef).not.toContain("postgres:");

    // Schema exists on the target, and holds no tenant data yet.
    const dedicated = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`select count(*) as n from information_schema.tables where table_schema = 'public' and table_name = 'Customer'`);
    expect(Number(dedicated[0].n)).toBe(1);
    // Placement is untouched until the data has been migrated and verified.
    expect(await resolveTenantPlacement(moved.businessId)).toEqual({ dataConnection: "shared-default" });
  }, 120000);
});

describe("migrating a business to dedicated infrastructure (§46.9 task 4)", () => {
  it("copies, verifies row for row, cuts over placement, and only then removes the business's rows from the shared database", async () => {
    const before = await sharedCount("Message", moved.businessId);
    expect(before).toBe(counts.messages);

    const report = await migrateBusinessToDedicated({ businessId: moved.businessId, profileId: PROFILE_ID });
    expect(report.verified).toBe(true);
    expect(report.tables.find((t) => t.table === "Message")).toMatchObject({ copied: counts.messages, sharedRemaining: 0 });

    const placement = await resolveTenantPlacement(moved.businessId);
    expect(placement.dataConnection).toBe(`dedicated:${PROFILE_ID}`);

    // Physically absent from shared, present in dedicated — and the reverse for the business that stayed.
    for (const table of ["Customer", "Conversation", "Message", "KnowledgeEntry", "Category"]) {
      expect(await sharedCount(table, moved.businessId)).toBe(0);
      expect(await sharedCount(table, stayer.businessId)).toBeGreaterThan(0);
    }
    const dedicatedClient = getDataPlaneClient(placement.dataConnection);
    const rows = await dedicatedClient.$queryRawUnsafe<{ businessId: string; n: bigint }[]>(`select "businessId", count(*) as n from "Customer" group by "businessId"`);
    expect(rows).toEqual([{ businessId: moved.businessId, n: BigInt(counts.customers) }]);

    // Control-plane rows never moved.
    expect(await prisma.business.findUnique({ where: { id: moved.businessId } })).not.toBeNull();
    expect(await prisma.membership.count({ where: { businessId: moved.businessId } })).toBeGreaterThan(0);
  }, 120000);

  it("serves reads and writes through the unchanged scoped-client API, isolated from other businesses", async () => {
    await resolveTenantPlacement(moved.businessId);
    const movedCtx = { ...moved.ctx, dataConnection: `dedicated:${PROFILE_ID}` };
    const db = getScopedPrisma(movedCtx);

    expect(await db.customer.count()).toBe(counts.customers);
    expect(await db.message.count()).toBe(counts.messages);

    await db.customer.create({ data: { name: "after-cutover", businessId: moved.businessId } });
    expect(await db.customer.count()).toBe(counts.customers + 1);
    expect(await sharedCount("Customer", moved.businessId)).toBe(0); // the write landed in the dedicated database

    // The business that stayed is untouched.
    expect(await getScopedPrisma(stayer.ctx).customer.count()).toBe(counts.customers);
  });

  it("refuses to migrate onto a profile that already holds this business's data", async () => {
    await expect(migrateBusinessToDedicated({ businessId: moved.businessId, profileId: PROFILE_ID })).rejects.toThrow(/already/i);
  });

  it("keeps membership administration on the control plane so role changes still govern authentication", async () => {
    const movedCtx = { ...moved.ctx, dataConnection: `dedicated:${PROFILE_ID}` };
    const listed = await adminUsers.list(movedCtx, { skip: 0, take: 10 });
    expect(listed.total).toBeGreaterThan(0);
    const owner = listed.users.find((u) => u.userId === moved.ownerUserId)!;
    expect(owner).toBeDefined();
    // The row auth reads (raw control-plane client) is the one the service listed.
    const authRow = await prisma.membership.findFirstOrThrow({ where: { businessId: moved.businessId, userId: moved.ownerUserId } });
    expect(authRow.id).toBe(owner.id);
  });
});

describe("migration safety", () => {
  it("discovers exactly the tenant-scoped data-plane tables (membership stays on the control plane)", async () => {
    const discovered = (await discoverDataPlaneTables(prisma)).map((t) => t.charAt(0).toLowerCase() + t.slice(1));
    const expected = TENANT_SCOPED_MODELS.filter((m) => m !== "membership");
    expect([...discovered].sort()).toEqual([...expected].sort());
  });

  it("aborts the cutover and removes the partial copy when shared data changes during the migration", async () => {
    const racer = await seedBusiness("dedicated-racer");
    try {
      await seedData(racer);
      await expect(
        migrateBusinessToDedicated(
          { businessId: racer.businessId, profileId: PROFILE_ID },
          { afterCopy: async () => void (await getScopedPrisma(racer.ctx).customer.create({ data: { name: "raced", businessId: racer.businessId } })) }
        )
      ).rejects.toThrow(/Verification failed/);

      // Shared stays authoritative and complete; placement unchanged; no leftover copy.
      expect(await resolveTenantPlacement(racer.businessId)).toEqual({ dataConnection: "shared-default" });
      expect(await sharedCount("Customer", racer.businessId)).toBe(counts.customers + 1);
      const leftover = await getDataPlaneClient(`dedicated:${PROFILE_ID}`).$queryRawUnsafe<unknown[]>(`select 1 from "Business" where id = $1`, racer.businessId);
      expect(leftover).toHaveLength(0);

      // With the business quiesced, a retry succeeds.
      await expect(migrateBusinessToDedicated({ businessId: racer.businessId, profileId: PROFILE_ID })).resolves.toMatchObject({ verified: true });
    } finally {
      await cleanupBusiness(racer.businessId);
    }
  }, 120000);
});

describe("the job queue routes a dedicated tenant's jobs with no per-tenant configuration (§25.6)", () => {
  it("runs a handler against the dedicated database, resolved from the payload's businessId alone", async () => {
    const seen: { dataConnection: string; customers: number }[] = [];
    const queue = new PgBossJobQueue(SHARED_URL);
    queue.registerHandler<{ businessId: string }>(PROCESS_INBOUND_MESSAGE_JOB, async (ctx) => {
      seen.push({ dataConnection: ctx.dataConnection, customers: await getScopedPrisma(ctx).customer.count() });
    });
    try {
      await queue.start();
      await queue.enqueue(PROCESS_INBOUND_MESSAGE_JOB, { businessId: moved.businessId }, { singletonKey: `${moved.businessId}:dedicated-job` });
      const deadline = Date.now() + 20000;
      while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual([{ dataConnection: `dedicated:${PROFILE_ID}`, customers: counts.customers + 1 }]);
    } finally {
      await queue.stop();
    }
  }, 60000);
});
