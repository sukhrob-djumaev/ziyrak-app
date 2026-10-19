import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
let a: SeededBusiness, b: SeededBusiness;
beforeAll(async () => {
  a = await seedBusiness("facade-a");
  b = await seedBusiness("facade-b");
});
afterAll(async () => {
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
  await prisma.user.deleteMany({ where: { id: { in: [a.ownerUserId, b.ownerUserId] } } });
});
describe("scoped repository public surface, real Postgres", () => {
  it.each(["$parent", "_originalClient", "_appliedParent"])(
    "denies root client alias %s",
    async (alias) => {
      const db = getScopedPrisma(a.ctx);
      expect(() => Reflect.get(db, alias)).toThrow();
    }
  );
  it.each(["$parent", "_originalClient", "_appliedParent"])(
    "denies model client alias %s",
    async (alias) => {
      const db = getScopedPrisma(a.ctx);
      expect(() => Reflect.get(db.conversation, alias)).toThrow();
    }
  );
  it.each(["root", "model"])(
    "denies an actual foreign-workspace query through the %s parent",
    async (surface) => {
      const db = getScopedPrisma(a.ctx);
      const query = async () => {
        const parent = Reflect.get(surface === "root" ? db : db.conversation, "$parent");
        return parent.membership.findMany({
          where: { businessId: b.businessId },
          select: { businessId: true },
        });
      };
      await expect(query()).rejects.toMatchObject({ statusCode: 403 });
    }
  );
  it("does not expose client internals via own-property descriptors", () => {
    const db = getScopedPrisma(a.ctx);
    for (const target of [db, db.conversation]) {
      expect(Object.getPrototypeOf(target)).toBeNull();
      for (const key of [
        "$parent",
        "_originalClient",
        "_appliedParent",
        "_engine",
        "_runtimeDataModel",
      ])
        expect(Object.getOwnPropertyDescriptor(target, key)).toBeUndefined();
    }
  });
  it("denies transaction root and model aliases while preserving scoped reads", async () => {
    const db = getScopedPrisma(a.ctx);
    await db.$transaction(async (tx) => {
      for (const target of [tx, tx.conversation]) {
        for (const alias of ["$parent", "_originalClient", "_appliedParent"])
          expect(() => Reflect.get(target, alias)).toThrow();
        expect(Object.getPrototypeOf(target)).toBeNull();
      }
      expect(await tx.membership.count()).toBe(1);
    });
  });
});
