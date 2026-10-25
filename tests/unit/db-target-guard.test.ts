import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { assertDisposableTarget } = require("../../scripts/safety/db-target.cjs");

const url = (db: string, host = "localhost:5432", user = "postgres") =>
  `postgresql://${user}:sekret@${host}/${db}?schema=public`;
const ok = (db = "owly_test") => ({
  DATABASE_URL: url(db),
  DIRECT_DATABASE_URL: url(db),
  ZIYRAK_DISPOSABLE_DB: db,
});
const fails = (env: Record<string, string | undefined>, kind: "test" | "load" = "test") =>
  expect(() => assertDisposableTarget(env, kind));

describe("disposable DB target guard (F08)", () => {
  it("accepts an explicitly opted-in ordinary test target", () => {
    expect(assertDisposableTarget(ok(), "test").database).toBe("owly_test");
    expect(assertDisposableTarget(ok("owly_test_w1"), "test").database).toBe("owly_test_w1");
  });
  it("accepts a load target only for kind=load", () => {
    expect(assertDisposableTarget(ok("owly_load"), "load").database).toBe("owly_load");
    fails(ok("owly_load"), "test").toThrow();
    fails(ok("owly_test"), "load").toThrow();
  });
  it("rejects query parameters that override host, port or user", () => {
    for (const q of ["host=db.prod.example", "port=6543", "user=admin"]) {
      const e = ok();
      e.DATABASE_URL += "&" + q;
      fails(e).toThrow(/query parameter/);
    }
  });
  it("rejects missing or single URLs", () => {
    fails({ ZIYRAK_DISPOSABLE_DB: "owly_test" }).toThrow(/DATABASE_URL/);
    fails({ ...ok(), DIRECT_DATABASE_URL: undefined }).toThrow(/DIRECT_DATABASE_URL/);
    fails({ ...ok(), DATABASE_URL: undefined }).toThrow(/DATABASE_URL/);
  });
  it("rejects contradictory, inherited-elsewhere and invalid URLs", () => {
    fails({ ...ok(), DIRECT_DATABASE_URL: url("owly") }).toThrow();
    fails({ ...ok(), DIRECT_DATABASE_URL: url("owly_test", "localhost:5433") }).toThrow();
    fails({ ...ok(), DIRECT_DATABASE_URL: url("owly_test", "localhost:5432", "admin") }).toThrow();
    fails({ ...ok(), DATABASE_URL: "mysql://localhost/owly_test" }).toThrow(/protocol/);
    fails({ ...ok(), DATABASE_URL: "not a url" }).toThrow();
  });
  it("rejects protected acceptance/live names and non-local hosts", () => {
    for (const db of ["owly", "postgres", "ziyrak_acceptance_run1", "production"])
      fails({ DATABASE_URL: url(db), DIRECT_DATABASE_URL: url(db), ZIYRAK_DISPOSABLE_DB: db }).toThrow();
    const remote = url("owly_test", "db.prod.example.com:5432");
    fails({ ...ok(), DATABASE_URL: remote, DIRECT_DATABASE_URL: remote }).toThrow(/local/);
  });
  it("requires ownership opt-in matching the database name; _test suffix alone is not enough", () => {
    const { ZIYRAK_DISPOSABLE_DB: _drop, ...noOptIn } = ok();
    void _drop;
    fails(noOptIn).toThrow(/ZIYRAK_DISPOSABLE_DB/);
    fails({ ...ok(), ZIYRAK_DISPOSABLE_DB: "other_test" }).toThrow(/ZIYRAK_DISPOSABLE_DB/);
    fails(ok("customer_test")).toThrow();
  });
  it("allows a load pooled/direct pair only with the same db and user on different hosts", () => {
    const env = {
      DATABASE_URL: url("owly_load", "pgbouncer:5432"),
      DIRECT_DATABASE_URL: url("owly_load", "db:5432"),
      ZIYRAK_DISPOSABLE_DB: "owly_load",
      ZIYRAK_LOAD_HOSTS: "pgbouncer,db",
    };
    expect(assertDisposableTarget(env, "load").database).toBe("owly_load");
    fails({ ...env, ZIYRAK_LOAD_HOSTS: "db" }, "load").toThrow();
  });
  it("never leaks the password or full URL in diagnostics", () => {
    try {
      assertDisposableTarget({ ...ok(), DIRECT_DATABASE_URL: url("owly") }, "test");
      throw new Error("should have thrown");
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/sekret|postgresql:\/\//);
    }
  });
});
