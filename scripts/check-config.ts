/**
 * L2.1: validates the current environment against the production configuration contract, whatever NODE_ENV is.
 *   npm run config:check            # web + worker
 *   npm run config:check -- worker  # one role
 * Exit code 1 when any error is found; warnings are listed but do not fail. Values are never printed.
 */
import "dotenv/config";
import { validateRuntimeConfig, type Role } from "@/lib/config/runtime-contract";

const arg = process.argv[2];
const roles: Role[] = arg === "web" || arg === "worker" ? [arg] : ["web", "worker"];
let failed = false;
for (const role of roles) {
  const findings = validateRuntimeConfig(process.env, role);
  console.log(`\n[${role}] ${findings.filter((f) => f.level === "error").length} error(s), ${findings.filter((f) => f.level === "warn").length} warning(s)`);
  for (const f of findings) console.log(`  ${f.level === "error" ? "ERROR" : "warn "} ${f.key}: ${f.message}`);
  if (findings.some((f) => f.level === "error")) failed = true;
}
process.exit(failed ? 1 : 0);
