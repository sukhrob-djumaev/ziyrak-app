import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

/**
 * L2.1 / F04/F05/F11: the Helm chart must express the same runtime contract as the app. Renders the real chart with
 * `helm template`. Skipped when no helm binary is available (set HELM_BIN to use another one); CI runners have helm.
 */
const HELM = process.env.HELM_BIN || "helm";
const available = spawnSync(HELM, ["version", "--short"], { encoding: "utf8", env: { ...process.env } }).status === 0;
const FIXTURE = "helm/owly/ci/production-values.yaml";

function render(extra: string[] = [], useFixture = true) {
  const args = ["template", "t", "helm/owly", ...(useFixture ? ["-f", FIXTURE] : []), ...extra];
  const r = spawnSync(HELM, args, { encoding: "utf8", env: { ...process.env, HELM_CHART_ROOT: process.cwd() } });
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
}

describe.skipIf(!available)("helm chart runtime contract", () => {
  it("rejects the unconfigured defaults instead of rendering a deployable-looking system", () => {
    const r = render([], false);
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/jwtSecret|smtp|encryptionKeys|appUrl/);
  });

  it("renders a complete configuration: encryption keys, platform proofs, mail, MFA mode and proxy hops", () => {
    const r = render();
    expect(r.ok, r.err).toBe(true);
    for (const needle of ["SECRET_KEY_V1:", "PLATFORM_BOOTSTRAP_PROOF_SHA256:", "PLATFORM_RECOVERY_PROOF_SHA256:", "PLATFORM_SMTP_HOST:", "PLATFORM_SMTP_FROM:", "ZIYRAK_PLATFORM_MFA:", "TRUSTED_PROXY_HOPS:", "JWT_SECRET:"])
      expect(r.out, needle).toContain(needle);
  });

  it("splits liveness from readiness for the web pods and probes the worker by heartbeat", () => {
    const out = render().out;
    expect(out).toContain("path: /api/health/live");
    expect(out).toContain("path: /api/health/ready");
    expect(out).not.toMatch(/path: \/api\/health\s*\n/);
    const worker = out.slice(out.indexOf("-worker"));
    expect(worker).toContain("ziyrak-worker-heartbeat");
    expect(worker).toMatch(/livenessProbe:\s*\n\s*exec:/);
  });

  it("allows the in-chart PgBouncer together with an existing secret and reads the password from it", () => {
    const r = render(["--set", "secrets.existingSecret=my-secret", "--set", "pgbouncer.enabled=true", "--set", "secrets.existingSecretKeys.dbPassword=PGPASS"]);
    expect(r.ok, r.err).toBe(true);
    expect(r.out).toMatch(/name: DB_PASSWORD\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:[\s\S]*?name: my-secret\s*\n\s*key: PGPASS/);
    expect(r.out).not.toContain("-pgbouncer\ntype: Opaque");
  });

  it("rejects an http app URL, no trusted proxy hops, and missing mail", () => {
    expect(render(["--set", "config.appUrl=http://x.example.com"]).err).toMatch(/https/);
    expect(render(["--set", "config.trustedProxyHops=0"]).err).toMatch(/trustedProxyHops/);
    expect(render(["--set", "smtp.host="]).err).toMatch(/smtp/);
  });

  it("rejects short secrets and a missing encryption key", () => {
    expect(render(["--set", "secrets.jwtSecret=short"]).err).toMatch(/jwtSecret/);
    expect(render(["--set", "secrets.encryptionKeys=null"]).err).toMatch(/encryptionKeys/);
  });
});
