import { Client } from "pg";

/**
 * The managed-AI service policy table is a platform-global singleton (the
 * active policy per kind), so test files that create or delete policies must
 * not interleave. A session advisory lock held on a dedicated connection
 * serializes them across vitest's parallel files.
 */
const LOCK_KEY = 7020261022;
let client: Client | null = null;

export async function acquirePolicyLock(): Promise<void> {
  client = new Client({ connectionString: process.env.DATABASE_URL?.replace(/\?schema=.*$/, "") });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
}

export async function releasePolicyLock(): Promise<void> {
  await client?.end();
  client = null;
}

/**
 * `User.platformRole = "super_admin"` is unique and the platform control row is a singleton, so
 * test files that create a super admin or bootstrap the platform must not interleave either.
 */
const PLATFORM_LOCK_KEY = 7020261023;
let platformClient: Client | null = null;

export async function acquirePlatformLock(): Promise<void> {
  platformClient = new Client({ connectionString: process.env.DATABASE_URL?.replace(/\?schema=.*$/, "") });
  await platformClient.connect();
  await platformClient.query("SELECT pg_advisory_lock($1)", [PLATFORM_LOCK_KEY]);
}

export async function releasePlatformLock(): Promise<void> {
  await platformClient?.end();
  platformClient = null;
}
