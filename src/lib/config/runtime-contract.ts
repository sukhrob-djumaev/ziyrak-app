import { EnvKeySecretResolver } from "@/lib/secrets/env-key-resolver";
import { logger } from "@/lib/observability/logger";

/**
 * L2.1 / F05: the one production configuration contract. Every deployable (Compose, Helm, bare metal) must supply
 * what this validates, and the web process and the worker refuse to start in the strict profile when it is not met.
 * Findings never include secret values, only the variable name and the reason.
 *
 * `error`: the product would be insecure or unable to do its job. `warn`: a launch gate or shared-state guarantee
 * the operator should consciously accept.
 */
export type Role = "web" | "worker";
export interface Finding {
  level: "error" | "warn";
  key: string;
  message: string;
}

export class ConfigContractError extends Error {
  constructor(readonly findings: Finding[]) {
    super("Invalid runtime configuration:\n" + findings.map((f) => `- ${f.key}: ${f.message}`).join("\n"));
    this.name = "ConfigContractError";
  }
}

/**
 * Strict = production. The only exemption is the explicit, greppable `ZIYRAK_CONFIG_PROFILE=relaxed`, which the local
 * Compose stack and the isolated acceptance/load harnesses set. It must never appear in a real deployment's config.
 */
export function isStrictProfile(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" && env.ZIYRAK_CONFIG_PROFILE !== "relaxed";
}

const MIN_SECRET_LENGTH = 32;

function databaseName(url: string): string | null {
  try {
    const u = new URL(url);
    if (!["postgres:", "postgresql:"].includes(u.protocol)) return null;
    return decodeURIComponent(u.pathname.slice(1)) || null;
  } catch {
    return null;
  }
}

export function validateRuntimeConfig(env: NodeJS.ProcessEnv, role: Role): Finding[] {
  const out: Finding[] = [];
  const error = (key: string, message: string) => out.push({ level: "error", key, message });
  const warn = (key: string, message: string) => out.push({ level: "warn", key, message });

  // Database: pooled runtime URL and direct URL (migrations, pg-boss) must be valid and name the same database.
  const pooled = env.DATABASE_URL;
  const direct = env.DIRECT_DATABASE_URL;
  const pooledName = pooled ? databaseName(pooled) : null;
  const directName = direct ? databaseName(direct) : null;
  if (!pooled) error("DATABASE_URL", "is required");
  else if (!pooledName) error("DATABASE_URL", "must be a postgres URL that names a database");
  if (!direct) error("DIRECT_DATABASE_URL", "is required (migrations and the job queue use the direct connection, not a transaction pooler)");
  else if (!directName) error("DIRECT_DATABASE_URL", "must be a postgres URL that names a database");
  else if (pooledName && directName !== pooledName) error("DIRECT_DATABASE_URL", "must name the same database as DATABASE_URL");

  // Secrets.
  if (!env.JWT_SECRET) error("JWT_SECRET", "is required");
  else if (env.JWT_SECRET.length < MIN_SECRET_LENGTH) error("JWT_SECRET", `must be at least ${MIN_SECRET_LENGTH} characters of high-entropy randomness`);

  const keyNames = Object.keys(env).filter((k) => /^SECRET_KEY_V[1-9]\d*$/.test(k) && env[k]);
  if (keyNames.length === 0) error("SECRET_KEY_V<n>", "at least one encryption key (for example SECRET_KEY_V1) is required");
  for (const k of keyNames) if ((env[k] ?? "").length < MIN_SECRET_LENGTH) error(k, `must be at least ${MIN_SECRET_LENGTH} characters`);
  if (keyNames.length) {
    try {
      new EnvKeySecretResolver(env);
    } catch {
      error("SECRET_KEY_ACTIVE_VERSION", "must be a positive integer naming a configured SECRET_KEY_V<n>");
    }
  }

  // Platform mail: account verification, reset and invitations cannot work without it.
  if (env.MAIL_TRANSPORT === "capture") error("MAIL_TRANSPORT", "capture is for isolated tests only; configure SMTP");
  else if (!env.PLATFORM_SMTP_HOST || !env.PLATFORM_SMTP_FROM) {
    error("PLATFORM_SMTP_HOST", "PLATFORM_SMTP_HOST and PLATFORM_SMTP_FROM are required for account mail");
  }

  if (role === "web") {
    const url = env.NEXT_PUBLIC_APP_URL;
    if (!url) error("NEXT_PUBLIC_APP_URL", "is required");
    else {
      try {
        const u = new URL(url);
        if (u.protocol !== "https:") error("NEXT_PUBLIC_APP_URL", "must be an https:// URL in production");
        else if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) error("NEXT_PUBLIC_APP_URL", "must be the public address, not localhost");
      } catch {
        error("NEXT_PUBLIC_APP_URL", "is not a valid URL");
      }
    }
    // Client-address limits (login, signup, API) trust forwarded headers only this many proxies deep.
    if (!/^[1-9]\d*$/.test(env.TRUSTED_PROXY_HOPS ?? "")) {
      error("TRUSTED_PROXY_HOPS", "must be the number of trusted proxies in front of the app (an integer >= 1); also block direct access to the backend");
    }
  }

  // Platform owner proofs: optional until first enrollment, but a malformed one is a mistake.
  for (const k of ["PLATFORM_BOOTSTRAP_PROOF_SHA256", "PLATFORM_RECOVERY_PROOF_SHA256"]) {
    if (env[k] === undefined || env[k] === "") warn(k, "is not set; platform enrollment/recovery is unavailable");
    else if (!/^[a-fA-F0-9]{64}$/.test(env[k]!)) error(k, "must be a 64-character hex SHA-256 digest of the owner-held proof");
  }

  // Shared-state and launch gates: consciously accepted, not fatal.
  if (!env.REDIS_URL) warn("REDIS_URL", "not set: rate limits, realtime and caches are per process, not shared across replicas");
  if (env.ZIYRAK_PLATFORM_MFA !== "required") warn("ZIYRAK_PLATFORM_MFA", "platform second factor is not required (launch gate: enable after enrollment is in place)");

  return out;
}

/** Fail fast in the strict profile; elsewhere log the findings so a misconfiguration is visible, not silent. */
export function assertRuntimeConfig(env: NodeJS.ProcessEnv, role: Role): Finding[] {
  const findings = validateRuntimeConfig(env, role);
  const errors = findings.filter((f) => f.level === "error");
  if (isStrictProfile(env)) {
    if (errors.length) throw new ConfigContractError(errors);
    for (const f of findings) logger.warn(`[config] ${f.key}: ${f.message}`);
  } else if (env.NODE_ENV === "production") {
    for (const f of findings) logger.warn(`[config] (non-strict profile) ${f.key}: ${f.message}`);
  }
  return findings;
}
