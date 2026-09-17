/**
 * PLAN.md §46.1's own "Tests first" requirement: "a version of [the
 * database-bypass test] that seeds two businesses purely at the data layer
 * ... and confirms a cross-business composite-FK write fails, proving the
 * constraint itself works correctly before Phase 2's application-layer
 * plumbing exists to exercise it end-to-end." Also exercises the phase's "a
 * second Business can be created ... structurally separable at the data
 * layer" acceptance criterion.
 *
 * Not part of `npm run test`: this repo's test suite is deliberately
 * hermetic (tests/setup.ts mocks "@/lib/prisma/raw-client" and overrides DATABASE_URL
 * for every test), and the property under test — "the database itself
 * refuses this write" — cannot be verified against a mock. This is a
 * documented, re-runnable verification script instead, the same treatment
 * given to the restore rehearsal in the Phase 1 kickoff report.
 *
 * Run: npx tsx --env-file=.env scripts/phase1-verify-composite-fk-isolation.ts
 */

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/owly?schema=public";
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const SLUG_A = "phase1-isolation-verify-a";
const SLUG_B = "phase1-isolation-verify-b";

async function cleanup() {
  for (const slug of [SLUG_A, SLUG_B]) {
    const business = await prisma.business.findUnique({ where: { slug } });
    if (!business) continue;
    await prisma.ticket.deleteMany({ where: { businessId: business.id } });
    await prisma.teamMember.deleteMany({ where: { businessId: business.id } });
    await prisma.department.deleteMany({ where: { businessId: business.id } });
    await prisma.tenantPlacement.deleteMany({ where: { businessId: business.id } });
    await prisma.business.delete({ where: { id: business.id } });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  OK: ${message}`);
}

async function main() {
  console.log("=== Phase 1 data-layer tenant isolation verification (§8.4, §46.1) ===\n");
  await cleanup();

  console.log("1. Creating a second Business, independent of the Default Business...");
  const businessA = await prisma.business.create({ data: { slug: SLUG_A, name: "Isolation Verify A" } });
  const businessB = await prisma.business.create({ data: { slug: SLUG_B, name: "Isolation Verify B" } });
  await prisma.tenantPlacement.create({ data: { businessId: businessB.id } });
  const placementB = await prisma.tenantPlacement.findUniqueOrThrow({ where: { businessId: businessB.id } });

  assert(businessB.id !== businessA.id, "second Business has its own distinct id");
  assert(placementB.databaseProfileId === "shared-default", "its TenantPlacement resolves to shared-default");
  console.log();

  console.log("2. Confirming data is structurally distinct per business...");
  const departmentA = await prisma.department.create({ data: { businessId: businessA.id, name: "Dept A" } });
  const departmentB = await prisma.department.create({ data: { businessId: businessB.id, name: "Dept B" } });
  const visibleToA = await prisma.department.findMany({ where: { businessId: businessA.id } });
  const visibleToB = await prisma.department.findMany({ where: { businessId: businessB.id } });
  assert(
    visibleToA.length === 1 && visibleToA[0].id === departmentA.id,
    "Business A's query sees only its own Department"
  );
  assert(
    visibleToB.length === 1 && visibleToB[0].id === departmentB.id,
    "Business B's query sees only its own Department"
  );
  console.log();

  console.log("3. Attempting a cross-tenant composite-FK write, bypassing any service-layer check...");
  const teamMemberA = await prisma.teamMember.create({
    data: { businessId: businessA.id, name: "Agent A", email: "agent-a@example.com", departmentId: departmentA.id },
  });

  let rejected = false;
  try {
    await prisma.ticket.create({
      data: {
        businessId: businessB.id,
        title: "Cross-tenant assignment attempt",
        description: "Should be rejected by the composite FK, not created",
        assignedToId: teamMemberA.id,
      },
    });
  } catch (error) {
    rejected = true;
    console.log(`  Postgres rejected the write as expected: ${(error as Error).message.split("\n")[0]}`);
  }
  assert(rejected, "Ticket(businessId=B, assignedToId=<Business A's TeamMember>) was rejected by the database");

  const leaked = await prisma.ticket.findFirst({ where: { businessId: businessB.id, assignedToId: teamMemberA.id } });
  assert(leaked === null, "no cross-tenant Ticket row exists after the rejected write");
  console.log();

  console.log("4. Confirming the identical write succeeds when same-tenant...");
  const ticket = await prisma.ticket.create({
    data: {
      businessId: businessA.id,
      title: "Same-tenant assignment",
      description: "Should succeed",
      assignedToId: teamMemberA.id,
    },
  });
  assert(ticket.assignedToId === teamMemberA.id, "same-tenant Ticket assignment succeeds normally");
  console.log();

  await cleanup();
  console.log("=== All isolation checks passed; scratch businesses cleaned up ===");
}

main()
  .catch((error) => {
    console.error("\nIsolation verification FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
