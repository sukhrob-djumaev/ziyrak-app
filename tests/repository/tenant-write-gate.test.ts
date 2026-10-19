import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
let a: SeededBusiness, b: SeededBusiness;
beforeAll(async () => {
  a = await seedBusiness("p1-write-gate-a");
  b = await seedBusiness("p1-write-gate-b");
});
afterAll(async () => {
  for (const row of [a, b]) if (row) await cleanupBusiness(row.businessId);
});
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
describe("tenant write gate (real PG)", () => {
  it("serializes one business while allowing another to write", async () => {
    const entered = barrier(),
      finish = barrier();
    const db = getScopedPrisma(a.ctx);
    const owner = db.$transaction(async () => {
      entered.release();
      await finish.wait;
    });
    await entered.wait;
    let secondFinished = false;
    const second = db.tag
      .create({ data: { businessId: a.businessId, name: "Queued same-business write" } })
      .then((row) => {
        secondFinished = true;
        return row;
      });
    try {
      await getScopedPrisma(b.ctx).tag.create({
        data: { businessId: b.businessId, name: "Independent write" },
      });
      expect(secondFinished).toBe(false);
    } finally {
      finish.release();
    }
    await owner;
    expect(await second).toMatchObject({ businessId: a.businessId });
  });
  it("rollback releases the gate and rolls back its data", async () => {
    const db = getScopedPrisma(a.ctx),
      name = "rollback-" + crypto.randomUUID();
    await expect(
      db.$transaction(async (tx) => {
        await tx.tag.create({ data: { businessId: a.businessId, name } });
        throw new Error("Synthetic rollback");
      })
    ).rejects.toThrow("Synthetic rollback");
    expect(await db.tag.count({ where: { name } })).toBe(0);
    expect(await db.tag.create({ data: { businessId: a.businessId, name } })).toMatchObject({
      name,
    });
  });
  it("rejects snapshots that could miss retirement committed while waiting", async () => {
    await expect(async () =>
      getScopedPrisma(a.ctx).$transaction(async () => 1, { isolationLevel: "RepeatableRead" })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
  it("ordinary writes cannot manufacture or clear retirement markers", async () => {
    const db = getScopedPrisma(a.ctx);
    await expect(
      db.conversation.create({
        data: { businessId: a.businessId, channel: "api", retiredAt: null },
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
