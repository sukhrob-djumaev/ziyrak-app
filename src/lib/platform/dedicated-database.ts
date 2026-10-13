import crypto from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { prisma as rawClient } from "@/lib/prisma/raw-client";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getSecretResolver } from "@/lib/secrets";
import { closeDedicatedClient, ensureDedicatedClient, getDataPlaneClient, invalidateTenantPlacement } from "./tenant-placement";

const execFileAsync = promisify(execFile);

/**
 * PLAN.md §46.9 tasks 2 and 4 — provisioning a dedicated `DatabaseProfile` and
 * migrating one business's data-plane rows onto it. Internal/operator tooling:
 * nothing here is reachable from a tenant-facing route.
 *
 * Control-plane tables never move (§7.4): `Business`, `User`, `Membership`,
 * `TenantPlacement`, `InfrastructurePolicy`, and the profile tables stay on the
 * shared connection. Every other table carrying a `businessId` column is
 * data-plane and is discovered from the catalog, not hardcoded, so a new
 * tenant table is migrated automatically (and a test pins the discovered set
 * against `TENANT_SCOPED_MODELS`).
 *
 * Known limit: there is no write freeze. The caller must quiesce the business
 * (no inbound traffic or active jobs) before migrating; writes that race the
 * copy are detected by the verification pass and abort the cutover, but are
 * not prevented.
 */
const CONTROL_PLANE_TABLES: ReadonlySet<string> = new Set([
  "Business",
  "User",
  "Membership",
  "TenantPlacement",
  "InfrastructurePolicy",
  "DatabaseProfile",
  "StorageProfile",
]);

const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const COPY_BATCH_ROWS = 500;

export interface ProvisionDedicatedDatabaseInput {
  profileId: string;
  /** DSN of an already-created, empty Postgres database (creating the instance itself is infrastructure, not application, work). */
  connectionString: string;
  region?: string;
}

/**
 * Applies the full migration set to the target database, then registers its
 * DSN only as an encrypted secret on a new `DatabaseProfile`. Placement is not
 * touched — a business is only repointed after its data has been migrated and
 * verified.
 */
export async function provisionDedicatedDatabase(input: ProvisionDedicatedDatabaseInput): Promise<void> {
  if (!PROFILE_ID_PATTERN.test(input.profileId) || input.profileId === "shared-default") {
    throw new Error(`Invalid dedicated profile id "${input.profileId}".`);
  }
  new URL(input.connectionString); // throws on a malformed DSN

  if (await rawClient.databaseProfile.findUnique({ where: { id: input.profileId } })) {
    throw new Error(`DatabaseProfile "${input.profileId}" already exists.`);
  }

  // Run through the repo's own Prisma CLI so the target gets exactly the
  // migration history the shared database has; prisma.config.ts reads the URL
  // from these variables (and dotenv never overrides variables already set).
  const prismaCli = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  await execFileAsync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: input.connectionString, DIRECT_DATABASE_URL: input.connectionString },
    timeout: 5 * 60_000,
  });

  const encrypted = await getSecretResolver().encrypt(input.connectionString);
  await rawClient.databaseProfile.create({
    data: { id: input.profileId, connectionSecretRef: JSON.stringify(encrypted), region: input.region ?? "us" },
  });
}

export interface MigrationTableReport {
  table: string;
  copied: number;
  sharedRemaining: number;
}

export interface MigrationReport {
  businessId: string;
  profileId: string;
  verified: boolean;
  tables: MigrationTableReport[];
}

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

export async function discoverDataPlaneTables(client: PrismaClient): Promise<string[]> {
  const rows = await client.$queryRawUnsafe<{ table_name: string }[]>(
    `select c.table_name from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'businessId'
      order by c.table_name`
  );
  return rows.map((r) => r.table_name).filter((name) => !CONTROL_PLANE_TABLES.has(name));
}

/** Parents before children, from the target database's own foreign keys. */
async function orderByForeignKeys(client: PrismaClient, tables: string[]): Promise<string[]> {
  const edges = await client.$queryRawUnsafe<{ child: string; parent: string }[]>(
    `select cl.relname as child, pl.relname as parent
       from pg_constraint con
       join pg_class cl on cl.oid = con.conrelid
       join pg_class pl on pl.oid = con.confrelid
       join pg_namespace ns on ns.oid = cl.relnamespace
      where con.contype = 'f' and ns.nspname = 'public'`
  );
  const set = new Set(tables);
  const parentsOf = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of edges) {
    if (child !== parent && set.has(child) && set.has(parent)) parentsOf.get(child)!.add(parent);
  }
  const ordered: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size > 0) {
    const ready = Array.from(remaining).filter((t) => Array.from(parentsOf.get(t)!).every((p) => !remaining.has(p)));
    if (ready.length === 0) throw new Error(`Foreign-key cycle among data-plane tables: ${Array.from(remaining).join(", ")}`);
    for (const t of ready.sort()) {
      ordered.push(t);
      remaining.delete(t);
    }
  }
  return ordered;
}

interface TableDigest {
  count: number;
  hash: string;
}

async function digest(client: PrismaClient, table: string, businessId: string): Promise<TableDigest> {
  const rows = await client.$queryRawUnsafe<{ n: bigint; h: string | null }[]>(
    `select count(*) as n, md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '')) as h
       from ${q(table)} t where "businessId" = $1`,
    businessId
  );
  return { count: Number(rows[0].n), hash: rows[0].h ?? "" };
}

/**
 * Copies a business's data-plane rows to a provisioned dedicated database,
 * verifies them row for row (count plus a content hash per table), then — and
 * only then — repoints `TenantPlacement` and removes the business's rows from
 * the shared database, in one shared-database transaction that re-verifies
 * first. Any failure before cutover leaves the shared database authoritative
 * and removes the partial copy.
 */
export async function migrateBusinessToDedicated(
  input: { businessId: string; profileId: string },
  hooks?: { /** Test seam: runs after the copy, before verification — lets a test race a write against the migration. */ afterCopy?: () => Promise<void> }
): Promise<MigrationReport> {
  const { businessId, profileId } = input;

  const placement = await rawClient.tenantPlacement.findUnique({ where: { businessId } });
  if (!placement) throw new Error(`No TenantPlacement for business ${businessId}.`);
  if (placement.databaseProfileId !== "shared-default") {
    throw new Error(`Business ${businessId} is already placed on "${placement.databaseProfileId}".`);
  }
  const business = await rawClient.business.findUnique({ where: { id: businessId } });
  if (!business) throw new Error(`Business ${businessId} does not exist.`);

  const dedicatedKey = await ensureDedicatedClient(profileId);
  const dedicated = getDataPlaneClient(dedicatedKey);

  const tables = await orderByForeignKeys(dedicated, await discoverDataPlaneTables(rawClient));
  if (await dedicated.$queryRawUnsafe(`select 1 from "Business" where id = $1`, businessId).then((r) => (r as unknown[]).length > 0)) {
    throw new Error(`Dedicated profile "${profileId}" already holds a Business row for ${businessId}; refusing to overwrite.`);
  }

  const copied = new Map<string, number>();
  try {
    // 1. Copy: the Business anchor row (the data tables' foreign-key target), then every data-plane table.
    const [anchor] = await rawClient.$queryRawUnsafe<{ j: string }[]>(`select to_jsonb(b)::text as j from "Business" b where id = $1`, businessId);
    await dedicated.$executeRawUnsafe(`insert into "Business" select * from jsonb_populate_record(null::"Business", $1::jsonb)`, anchor.j);

    for (const table of tables) {
      let offset = 0;
      let total = 0;
      for (;;) {
        const batch = await rawClient.$queryRawUnsafe<{ j: string }[]>(
          `select to_jsonb(t)::text as j from ${q(table)} t where "businessId" = $1 order by to_jsonb(t)::text limit ${COPY_BATCH_ROWS} offset ${offset}`,
          businessId
        );
        if (batch.length === 0) break;
        const payload = `[${batch.map((r) => r.j).join(",")}]`;
        await dedicated.$executeRawUnsafe(`insert into ${q(table)} select * from jsonb_populate_recordset(null::${q(table)}, $1::jsonb)`, payload);
        total += batch.length;
        offset += batch.length;
      }
      copied.set(table, total);
    }

    await hooks?.afterCopy?.();

    // 2. Verify row for row, before any cutover.
    for (const table of tables) {
      const [a, b] = await Promise.all([digest(rawClient, table, businessId), digest(dedicated, table, businessId)]);
      if (a.count !== b.count || a.hash !== b.hash) {
        throw new Error(`Verification failed for ${table}: shared ${a.count} rows (${a.hash}) vs dedicated ${b.count} rows (${b.hash}). Cutover aborted.`);
      }
    }

    // 3. Cutover + decommission, atomically on the shared database, re-verifying inside the transaction.
    await rawClient.$transaction(
      async (tx) => {
        for (const table of tables) {
          const [a, b] = await Promise.all([
            tx.$queryRawUnsafe<{ n: bigint; h: string | null }[]>(
              `select count(*) as n, md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '')) as h from ${q(table)} t where "businessId" = $1`,
              businessId
            ),
            digest(dedicated, table, businessId),
          ]);
          if (Number(a[0].n) !== b.count || (a[0].h ?? "") !== b.hash) {
            throw new Error(`Shared data for ${table} changed during migration (rows written while copying). Cutover aborted; quiesce the business and retry.`);
          }
        }
        await tx.tenantPlacement.update({ where: { businessId }, data: { databaseProfileId: profileId } });
        for (const table of [...tables].reverse()) {
          await tx.$executeRawUnsafe(`delete from ${q(table)} where "businessId" = $1`, businessId);
        }
      },
      { timeout: 120_000, maxWait: 30_000 }
    );
  } catch (error) {
    await removeDedicatedCopy(dedicated, tables, businessId);
    throw error;
  }

  await invalidateTenantPlacement(businessId);

  const report: MigrationTableReport[] = [];
  for (const table of tables) {
    report.push({ table, copied: copied.get(table) ?? 0, sharedRemaining: (await digest(rawClient, table, businessId)).count });
  }
  return { businessId, profileId, verified: true, tables: report };
}

/** Best-effort removal of a partial or rejected copy; the shared database is authoritative until cutover commits. */
async function removeDedicatedCopy(dedicated: PrismaClient, tables: string[], businessId: string): Promise<void> {
  try {
    for (const table of [...tables].reverse()) {
      await dedicated.$executeRawUnsafe(`delete from ${q(table)} where "businessId" = $1`, businessId);
    }
    await dedicated.$executeRawUnsafe(`delete from "Business" where id = $1`, businessId);
  } catch {
    // Leaving a partial copy is safe (placement still points at shared) but blocks a retry until an operator clears it.
  }
}

const TENANT_ROLE_PREFIX = "tenant_";
const BUSINESS_ID_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

/**
 * PLAN.md §46.9 task 6 / §8.8 — Postgres RLS as an extra layer for a
 * dedicated database. Run by an operator with the database's *admin*
 * connection string, which is used for this call only and never stored.
 *
 * Creates the login role `tenant_<businessId>` (no superuser, no BYPASSRLS)
 * and policies that compare every data-plane row's `businessId` to the role's
 * own name via `current_user` — an identity a session cannot change, unlike a
 * `SET app.tenant_id` setting (which any session could simply override). The
 * role gets DML on the data-plane tables and nothing else: no control-plane
 * tables, no DDL. The profile's stored secret is then replaced with the
 * restricted role's DSN, so the application never holds admin credentials.
 *
 * Deviation from the plan's wording ("SET LOCAL app.tenant_id inside the
 * dedicated connection's transactions"): that would need a transaction around
 * every query and protects only against forgotten scoping, not against a
 * session that sets its own setting. Binding to the role costs nothing per
 * query, works under transaction pooling, and cannot be forgotten. The cost:
 * an RLS-enabled profile serves exactly one business.
 *
 * Superusers bypass RLS in Postgres, so the dedicated runtime connection must
 * never be a superuser — hence the role swap. Re-running rotates the password.
 */
export async function enableRowLevelSecurity(input: { profileId: string; businessId: string; adminConnectionString: string }): Promise<void> {
  const { profileId, businessId, adminConnectionString } = input;
  if (!BUSINESS_ID_PATTERN.test(businessId)) throw new Error(`Business id "${businessId}" cannot be used in a database role name.`);
  if (!(await rawClient.databaseProfile.findUnique({ where: { id: profileId } }))) throw new Error(`DatabaseProfile "${profileId}" does not exist.`);

  const role = `${TENANT_ROLE_PREFIX}${businessId}`;
  const password = crypto.randomBytes(24).toString("hex");
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: adminConnectionString, max: 2 }) });
  try {
    const [{ rolsuper }] = await admin.$queryRawUnsafe<{ rolsuper: boolean }[]>(`select rolsuper from pg_roles where rolname = current_user`);
    if (!rolsuper) throw new Error("enableRowLevelSecurity needs an administrative connection (superuser) to create roles and force policies.");

    const tables = await discoverDataPlaneTables(admin);
    const exists = (await admin.$queryRawUnsafe<unknown[]>(`select 1 from pg_roles where rolname = $1`, role)).length > 0;
    await admin.$executeRawUnsafe(
      `${exists ? "ALTER" : "CREATE"} ROLE ${q(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
    );
    const [{ db }] = await admin.$queryRawUnsafe<{ db: string }[]>(`select current_database() as db`);
    await admin.$executeRawUnsafe(`GRANT CONNECT ON DATABASE ${q(db)} TO ${q(role)}`);
    await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${q(role)}`);
    await admin.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${q(role)}`);

    const policy = (column: string) => `${q(column)} = substr(current_user, ${TENANT_ROLE_PREFIX.length + 1})`;
    for (const table of tables) {
      await admin.$executeRawUnsafe(`ALTER TABLE ${q(table)} ENABLE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`ALTER TABLE ${q(table)} FORCE ROW LEVEL SECURITY`);
      await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS tenant_isolation ON ${q(table)}`);
      await admin.$executeRawUnsafe(`CREATE POLICY tenant_isolation ON ${q(table)} FOR ALL USING (${policy("businessId")}) WITH CHECK (${policy("businessId")})`);
      await admin.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${q(table)} TO ${q(role)}`);
    }
    // The tenant's own Business row is the foreign-key anchor and is readable, never writable.
    await admin.$executeRawUnsafe(`ALTER TABLE "Business" ENABLE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`ALTER TABLE "Business" FORCE ROW LEVEL SECURITY`);
    await admin.$executeRawUnsafe(`DROP POLICY IF EXISTS tenant_isolation ON "Business"`);
    await admin.$executeRawUnsafe(`CREATE POLICY tenant_isolation ON "Business" FOR SELECT USING (${policy("id")})`);
    await admin.$executeRawUnsafe(`GRANT SELECT ON "Business" TO ${q(role)}`);
  } finally {
    await admin.$disconnect();
  }

  const runtimeUrl = new URL(adminConnectionString);
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  const encrypted = await getSecretResolver().encrypt(runtimeUrl.toString());
  await rawClient.databaseProfile.update({ where: { id: profileId }, data: { connectionSecretRef: JSON.stringify(encrypted) } });
  await closeDedicatedClient(profileId);
}
