import { beforeAll, afterAll, it, expect, vi } from "vitest";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
let a: SeededBusiness, b: SeededBusiness;
beforeAll(async () => {
  a = await seedBusiness("p1-action-ref-a");
  b = await seedBusiness("p1-action-ref-b");
});
afterAll(async () => {
  for (const row of [a, b]) if (row) await cleanupBusiness(row.businessId);
});
it("database rejects an action attached to another workspace conversation", async () => {
  const conv = await prisma.conversation.create({
    data: { businessId: b.businessId, channel: "api" },
  });
  await expect(
    prisma.actionExecution.create({
      data: {
        businessId: a.businessId,
        tool: "schedule_followup",
        input: {},
        conversationId: conv.id,
        requestedBy: "system",
        idempotencyKey: crypto.randomUUID(),
      },
    })
  ).rejects.toThrow();
});
