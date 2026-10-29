import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * P1 follow-up admission session on a dedicated placement: control fence first, data fence
 * second, writers wait behind both, no lock-order deadlock, and the two commit-failure
 * directions. Throwaway databases only; never the live or an acceptance database.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma/raw-client";
import { getScopedPrisma, withAdmissionSession } from "@/lib/tenancy/scoped-prisma";
import { resolveTenantPlacement, closeDedicatedClients } from "@/lib/platform/tenant-placement";
import {
  provisionDedicatedDatabase,
  migrateBusinessToDedicated,
} from "@/lib/platform/dedicated-database";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";

const SHARED_URL = process.env.DATABASE_URL!;
const DEDICATED_DB = `ziyrak_adm_dedicated_${Date.now()}_${process.pid}`;
const dedicatedUrl = SHARED_URL.replace(/\/[^/?]+(\?|$)/, `/${DEDICATED_DB}$1`);
const PROFILE_ID = `adm-dedicated-${Date.now()}`;
let moved: SeededBusiness, shared: SeededBusiness, dedicatedCtx: TenantContext;

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${DEDICATED_DB}"`);
  moved = await seedBusiness("adm-dedicated-moved");
  shared = await seedBusiness("adm-shared");
  await provisionDedicatedDatabase({
    profileId: PROFILE_ID,
    connectionString: dedicatedUrl,
    region: "eu",
  });
  await migrateBusinessToDedicated({ businessId: moved.businessId, profileId: PROFILE_ID });
  await resolveTenantPlacement(moved.businessId);
  dedicatedCtx = { ...moved.ctx, dataConnection: `dedicated:${PROFILE_ID}` };
}, 90_000);
afterAll(async () => {
  await closeDedicatedClients();
  await cleanupBusiness(moved.businessId);
  await cleanupBusiness(shared.businessId);
  await prisma.databaseProfile.deleteMany({ where: { id: PROFILE_ID } });
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DEDICATED_DB}" WITH (FORCE)`);
});

const blocked = async (write: Promise<unknown>) =>
  (await Promise.race([
    write.then(
      () => "done",
      () => "done"
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 750)),
  ])) === "blocked";

describe("dedicated admission session", () => {
  it("holds the data-plane and the control-plane writers behind the session", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const session = withAdmissionSession(dedicatedCtx, async () => {
      entered();
      await hold;
    });
    await inside;
    try {
      const db = getScopedPrisma(dedicatedCtx);
      const dataWriter = db.conversation.create({
        data: { channel: "webchat", businessId: moved.businessId },
      });
      // membership is control-plane resident: this writer only waits on the control fence.
      const member = await prisma.membership.findFirstOrThrow({
        where: { businessId: moved.businessId },
      });
      const controlWriter = getScopedPrisma(dedicatedCtx).membership.update({
        where: { id: member.id },
        data: { role: member.role },
      });
      expect(await blocked(dataWriter)).toBe(true);
      expect(await blocked(controlWriter)).toBe(true);
      release();
      await session;
      await Promise.all([dataWriter, controlWriter]);
    } finally {
      release();
      await session.catch(() => {});
    }
  });
  it("does not deadlock with interleaved sessions and writers (control then data order)", async () => {
    const db = getScopedPrisma(dedicatedCtx);
    const work = Array.from({ length: 12 }, (_, i) =>
      i % 2
        ? withAdmissionSession(dedicatedCtx, async (s) => {
            await s.repository(dedicatedCtx).conversation.count();
          })
        : i % 4
          ? db.conversation.create({ data: { channel: "webchat", businessId: moved.businessId } })
          : db.membership.updateMany({ where: {}, data: { role: "owner" } })
    );
    const outcome = await Promise.race([
      Promise.allSettled(work),
      new Promise<string>((resolve) => setTimeout(() => resolve("deadlock"), 20_000)),
    ]);
    expect(outcome).not.toBe("deadlock");
    expect(
      (outcome as PromiseSettledResult<unknown>[]).every((r) => r.status === "fulfilled")
    ).toBe(true);
  });
  it("a failing callback rolls back the data write: no claim without a complete admission", async () => {
    const marker = randomUUID();
    await expect(
      withAdmissionSession(dedicatedCtx, async (s) => {
        await s
          .repository(dedicatedCtx)
          .customer.create({ data: { name: marker, businessId: moved.businessId } });
        throw new Error("admission aborted before commit");
      })
    ).rejects.toThrow(/aborted/);
    expect(await getScopedPrisma(dedicatedCtx).customer.count({ where: { name: marker } })).toBe(0);
  });
  it("a control completion failure after the data commit leaves the data write committed (unresolved, never permission to send)", async () => {
    const marker = randomUUID();
    const original = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(((
      callback: (tx: unknown) => Promise<unknown>,
      options: unknown
    ) =>
      (original as (cb: unknown, o: unknown) => Promise<unknown>)(async (tx: unknown) => {
        await callback(tx);
        throw new Error("control completion failed");
      }, options)) as never);
    try {
      await expect(
        withAdmissionSession(dedicatedCtx, async (s) => {
          await s
            .repository(dedicatedCtx)
            .customer.create({ data: { name: marker, businessId: moved.businessId } });
        })
      ).rejects.toThrow(/control completion failed/);
    } finally {
      spy.mockRestore();
    }
    // The caller saw a failure, yet the data-plane write is durable: the claim state must be
    // treated as admitted-but-unresolved by recovery, never as unsent.
    expect(await getScopedPrisma(dedicatedCtx).customer.count({ where: { name: marker } })).toBe(1);
  });
  it("shared placement completes under a single fence without self-deadlock", async () => {
    const seen: unknown[] = [];
    await withAdmissionSession(shared.ctx, async (s) => {
      seen.push(s.control);
      await s.repository(shared.ctx).customer.count();
    });
    expect(seen).toHaveLength(1);
  });
});
