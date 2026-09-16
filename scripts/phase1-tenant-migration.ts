/**
 * Phase 1 tenant migration CLI (PLAN.md §46.1).
 *
 * One-time data migration for an existing single-tenant installation:
 * creates the "Default Business" from this installation's current data, and
 * backfills businessId across every existing table so the whole dataset
 * becomes exactly one tenant's data, with nothing deleted. Idempotent — safe
 * to re-run after a partial failure.
 *
 * The actual steps live in ./phase1-migration-steps.ts as plain functions so
 * tests/migration/phase1-tenant-migration.test.ts can exercise them directly
 * against a scratch business; this file is just the CLI entrypoint.
 *
 * Requires SECRET_KEY_V1 to be set (see .env.example).
 * Run: npx tsx --env-file=.env scripts/phase1-tenant-migration.ts
 */

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getSecretResolver } from "../src/lib/secrets/env-key-resolver";
import { runPhase1TenantMigration } from "./phase1-migration-steps";

const connectionString =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/owly?schema=public";
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

runPhase1TenantMigration(prisma, getSecretResolver())
  .catch((error) => {
    console.error("\nPhase 1 tenant migration FAILED:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
