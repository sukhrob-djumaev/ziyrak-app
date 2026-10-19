import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Delayed-work admission (P1 follow-up contract) holds the per-workspace write fence. Anything
// that can reduce delayed-work authority (workspace/channel/key/policy/lifecycle) must therefore
// write through the scoped repository, which takes that fence. A new writer must be classified
// here deliberately; an unclassified one fails closed until it is inspected.
const root = join(__dirname, "../..", "src");
const WRITE =
  /\b(membership|apiKey|business|channelConnection|toolPolicy|user|session|membershipConnectionScope|apiKeyConnectionScope)\.(update|updateMany|delete|deleteMany|upsert|create|createMany)\(/g;
/** Fenced: scoped repository mutations (every one takes lockTenantWrites). */
const FENCED = new Set([
  "app/api/channels/email/route.ts",
  "lib/channels/connections-service.ts",
  "lib/channels/webchat-connections-service.ts",
  "lib/channels/whatsapp.ts",
  "lib/identity/admin-api-keys/service.ts",
  "lib/tools/policy-admin.ts",
]);
/** Platform control plane: account/role provisioning and creation only. None of these reduces a
 * workspace-scoped saved follow-up authority; membership removal/role change, key expiry edits
 * and workspace suspension have no application writer yet and must join FENCED when added.
 */
const PLATFORM = new Set([
  "lib/platform/access/authority.ts",
  "lib/platform/access/operators.ts",
  "lib/platform/admin-users/service.ts",
  "lib/platform/provisioning.ts",
]);
const FORBIDDEN_FOR_EXISTING =
  /\b(membership|business)\.(update|updateMany|delete|deleteMany|upsert)\(/;
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
  it("fenced writers use the scoped repository, never a raw client", () => {
    for (const file of FENCED) {
      const text = found.get(file) ?? "";
      expect(text, file).toMatch(/getScopedPrisma/);
      expect(text, file).not.toMatch(/raw-client/);
    }
  });
  it("has no application membership/workspace mutation outside the fenced set", () => {
    for (const [file, text] of found) {
      if (FENCED.has(file)) continue;
      expect(text, file).not.toMatch(FORBIDDEN_FOR_EXISTING);
    }
  });
});
