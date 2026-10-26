import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Delayed-work admission (P1 follow-up contract) holds the per-workspace write fence. Anything
// that can reduce delayed-work authority (workspace/channel/key/policy/lifecycle) must therefore
// write through the scoped repository, which takes that fence. A new writer must be classified
// here deliberately; an unclassified one fails closed until it is inspected.
const root = join(__dirname, "../..", "src");
const WRITE =
  /\b(membership|apiKey|business|channelConnection|toolPolicy|user|session|membershipConnectionScope|apiKeyConnectionScope)\.(update|updateMany|updateManyAndReturn|delete|deleteMany|upsert|create|createMany|createManyAndReturn)\(/g;
/** Fenced: scoped repository mutations (every one takes lockTenantWrites). */
const FENCED = new Set([
  "app/api/channels/email/route.ts",
  "lib/channels/connections-service.ts",
  "lib/channels/webchat-connections-service.ts",
  "lib/channels/whatsapp.ts",
  "lib/identity/admin-api-keys/service.ts",
  "lib/tools/policy-admin.ts",
]);
/** Control-plane-resident writers that use the raw client but take the same per-workspace fence
 * explicitly, inside the transaction and before any write. Each must say so in source.
 */
const RAW_FENCED = new Set(["lib/platform/admin-users/service.ts"]);
/** Platform control plane: account/role provisioning and creation only. None of these reduces a
 * workspace-scoped saved follow-up authority; membership removal/role change, key expiry edits
 * and workspace suspension have no application writer yet and must join FENCED when added.
 */
const PLATFORM = new Set([
  "lib/platform/access/authority.ts",
  "lib/platform/access/operators.ts",
  // Operator invitations create a new platform identity only; never change an existing account.
  "lib/platform/access/operator-invitations.ts",
  // Account identity: ends a user's sessions (P3 reset). Saved follow-ups deliberately survive
  // logout and session end (owner decision 2026-10-15), so this reduces no delayed-work authority.
  "lib/identity/auth.ts",
  // L1.3 platform second factor: writes only the account's own factor state, recovery codes and session
  // cutoff (like auth.ts above); it reduces no workspace-scoped delayed-work authority.
  "lib/identity/mfa.ts",
  // P3 recovery: email verification and password change write only the account row.
  "lib/identity/account-service.ts",
  "lib/platform/admin-users/service.ts",
  // P3 invitations create accounts/memberships (never reduce authority); revocation only marks tokens used.
  "lib/platform/admin-users/invitations.ts",
  "lib/platform/provisioning.ts",
]);
const FORBIDDEN_FOR_EXISTING =
  /\b(membership|business)\.(update|updateMany|updateManyAndReturn|delete|deleteMany|upsert)\(/;
/** Every file that issues raw SQL is pinned: raw SQL bypasses the repositories and their fence,
 * so a new one must be reviewed (and either fenced or classified here) before it lands.
 */
const RAW_SQL = [
  "app/api/health/route.ts",
  "lib/ai/allowance.ts",
  "lib/platform/access/authority.ts",
  "lib/platform/dedicated-database.ts",
  "lib/platform/username-reservation.ts",
  "lib/tenancy/scoped-prisma.ts",
  "lib/tenancy/work-lifecycle.ts",
];
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (path.includes("generated")) return [];
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}
describe("authority-reducing writer inventory", () => {
  const found = new Map<string, string>();
  for (const path of files(root)) {
    const text = readFileSync(path, "utf8");
    if (WRITE.test(text)) found.set(relative(root, path), text);
    WRITE.lastIndex = 0;
  }
  it("classifies every writer deliberately", () => {
    const unclassified = [...found.keys()].filter((f) => !FENCED.has(f) && !PLATFORM.has(f));
    expect(unclassified).toEqual([]);
  });
  it("pins every file that issues raw SQL", () => {
    const raw = files(root)
      .filter((path) => /\$(executeRaw|queryRaw)(Unsafe)?\b/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path))
      .sort();
    expect(raw).toEqual([...RAW_SQL].sort());
  });
  it("fenced writers use the scoped repository, never a raw client", () => {
    for (const file of FENCED) {
      const text = found.get(file) ?? "";
      expect(text, file).toMatch(/getScopedPrisma/);
      expect(text, file).not.toMatch(
        /raw-client|from "@\/lib\/prisma"|\$transaction\(\s*async \(tx\)\s*=>\s*\{[^}]*prisma\./
      );
    }
  });
  it("raw-client fenced writers take the workspace fence before writing", () => {
    for (const file of RAW_FENCED) {
      const text = found.get(file) ?? "";
      expect(PLATFORM.has(file) || FENCED.has(file), file).toBe(true);
      expect(text, file).toMatch(
        /\$transaction\(async \(tx\) => \{\s*await lockTenantWrites\(tx, ctx\.businessId\)/
      );
      // Every raw-client write to membership state must be a `tx.` write after the fence is taken
      // in the same callback; a bare `prisma.` write (or one before the fence) fails closed.
      expect(text, file).not.toMatch(
        /\bprisma\.(membership|membershipConnectionScope|business|channelConnection)\.(update|updateMany|delete|deleteMany|upsert|create|createMany)\(/
      );
      const fence = text.indexOf("await lockTenantWrites(tx, ctx.businessId)");
      const writes = [
        ...text.matchAll(
          /\btx\.(membership|membershipConnectionScope)\.(update|updateMany|delete|deleteMany|upsert|create|createMany)\(/g
        ),
      ];
      expect(writes.length, file).toBeGreaterThan(0);
      for (const write of writes) expect(write.index, file).toBeGreaterThan(fence);
    }
  });
  it("has no application membership/workspace mutation outside the fenced set", () => {
    for (const [file, text] of found) {
      if (FENCED.has(file) || RAW_FENCED.has(file)) continue;
      expect(text, file).not.toMatch(FORBIDDEN_FOR_EXISTING);
    }
  });
});
