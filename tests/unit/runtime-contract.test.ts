import { describe, it, expect } from "vitest";
import { validateRuntimeConfig, isStrictProfile, assertRuntimeConfig, ConfigContractError } from "@/lib/config/runtime-contract";

/** L2.1 / F05: one complete production configuration contract, validated at startup. */
const good: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app:pw@pgbouncer:6432/ziyrak?schema=public",
  DIRECT_DATABASE_URL: "postgresql://app:pw@db:5432/ziyrak?schema=public",
  JWT_SECRET: "j".repeat(40),
  SECRET_KEY_V1: "k".repeat(40),
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  TRUSTED_PROXY_HOPS: "1",
  PLATFORM_SMTP_HOST: "smtp.example.com",
  PLATFORM_SMTP_FROM: "Ziyrak <no-reply@example.com>",
  REDIS_URL: "redis://redis:6379",
  PLATFORM_BOOTSTRAP_PROOF_SHA256: "a".repeat(64),
  PLATFORM_RECOVERY_PROOF_SHA256: "b".repeat(64),
  ZIYRAK_PLATFORM_MFA: "required",
};
const errors = (env: Record<string, string | undefined>, role: "web" | "worker" = "web") =>
  validateRuntimeConfig(env as NodeJS.ProcessEnv, role).filter((f) => f.level === "error").map((f) => f.key);
const without = (...keys: string[]) => Object.fromEntries(Object.entries(good).filter(([k]) => !keys.includes(k)));

describe("runtime configuration contract (F05)", () => {
  it("accepts a complete production configuration for web and worker", () => {
    expect(errors(good)).toEqual([]);
    expect(errors(good, "worker")).toEqual([]);
    expect(validateRuntimeConfig(good as NodeJS.ProcessEnv, "web")).toEqual([]);
  });

  it("reports every missing or weak required value at once", () => {
    const bad = errors({ NODE_ENV: "production" });
    for (const key of ["DATABASE_URL", "DIRECT_DATABASE_URL", "JWT_SECRET", "SECRET_KEY_V<n>", "NEXT_PUBLIC_APP_URL", "TRUSTED_PROXY_HOPS", "PLATFORM_SMTP_HOST"]) expect(bad).toContain(key);
  });

  it("rejects short secrets, a capture mail transport, plain-http or localhost app URLs, and a missing proxy-hop count", () => {
    expect(errors({ ...good, JWT_SECRET: "short" })).toContain("JWT_SECRET");
    expect(errors({ ...good, SECRET_KEY_V1: "short" })).toContain("SECRET_KEY_V1");
    expect(errors({ ...good, MAIL_TRANSPORT: "capture" })).toContain("MAIL_TRANSPORT");
    expect(errors({ ...good, NEXT_PUBLIC_APP_URL: "http://app.example.com" })).toContain("NEXT_PUBLIC_APP_URL");
    expect(errors({ ...good, NEXT_PUBLIC_APP_URL: "https://localhost:3000" })).toContain("NEXT_PUBLIC_APP_URL");
    for (const bad of ["", "0", "-1", "two", "1.5"]) expect(errors({ ...good, TRUSTED_PROXY_HOPS: bad }), bad).toContain("TRUSTED_PROXY_HOPS");
  });

  it("checks the database pair: valid postgres URLs naming the same database", () => {
    expect(errors({ ...good, DATABASE_URL: "mysql://x/y" })).toContain("DATABASE_URL");
    expect(errors({ ...good, DIRECT_DATABASE_URL: "postgresql://app:pw@db:5432/other" })).toContain("DIRECT_DATABASE_URL");
    expect(errors({ ...good, DATABASE_URL: "postgresql://app:pw@pgbouncer:6432/ziyrak" })).toEqual([]);
  });

  it("validates key versions and the active-version selector", () => {
    expect(errors({ ...without("SECRET_KEY_V1"), SECRET_KEY_V3: "z".repeat(40) })).toEqual([]);
    expect(errors({ ...good, SECRET_KEY_ACTIVE_VERSION: "2" })).toContain("SECRET_KEY_ACTIVE_VERSION");
  });

  it("validates the platform proof hashes when present, and never prints values", () => {
    expect(errors({ ...good, PLATFORM_BOOTSTRAP_PROOF_SHA256: "nothex" })).toContain("PLATFORM_BOOTSTRAP_PROOF_SHA256");
    const text = JSON.stringify(validateRuntimeConfig({ ...good, JWT_SECRET: "tooshort-SECRETVALUE" } as NodeJS.ProcessEnv, "web"));
    expect(text).not.toContain("SECRETVALUE");
  });

  it("warns (does not fail) about shared-state and launch gates: no Redis, MFA not required, no proofs", () => {
    const findings = validateRuntimeConfig({ ...without("REDIS_URL", "ZIYRAK_PLATFORM_MFA", "PLATFORM_BOOTSTRAP_PROOF_SHA256") } as NodeJS.ProcessEnv, "web");
    expect(findings.filter((f) => f.level === "error")).toEqual([]);
    expect(findings.map((f) => f.key)).toEqual(expect.arrayContaining(["REDIS_URL", "ZIYRAK_PLATFORM_MFA", "PLATFORM_BOOTSTRAP_PROOF_SHA256"]));
  });

  it("the worker does not need the browser-facing app URL or proxy hops", () => {
    expect(errors(without("NEXT_PUBLIC_APP_URL", "TRUSTED_PROXY_HOPS"), "worker")).toEqual([]);
  });

  it("is strict only in production, and the relaxed profile is an explicit exception", () => {
    expect(isStrictProfile({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isStrictProfile({ NODE_ENV: "production", ZIYRAK_CONFIG_PROFILE: "relaxed" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isStrictProfile({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isStrictProfile({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("assert throws a summary of all errors in the strict profile and only logs elsewhere", () => {
    expect(() => assertRuntimeConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv, "web")).toThrow(ConfigContractError);
    try {
      assertRuntimeConfig({ NODE_ENV: "production", JWT_SECRET: "x" } as NodeJS.ProcessEnv, "web");
    } catch (e) {
      expect((e as Error).message).toMatch(/JWT_SECRET/);
      expect((e as Error).message).toMatch(/DATABASE_URL/);
    }
    expect(() => assertRuntimeConfig({ NODE_ENV: "development" } as NodeJS.ProcessEnv, "web")).not.toThrow();
    expect(() => assertRuntimeConfig({ NODE_ENV: "production", ZIYRAK_CONFIG_PROFILE: "relaxed" } as NodeJS.ProcessEnv, "web")).not.toThrow();
  });
});
