// Disposable-database admission for tests and load tooling (L1.1 / F08).
// Dependency-free so shell scripts, CI and vitest setup share one rule.
// Diagnostics never include credentials or complete connection URLs.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const KINDS = {
  test: /^owly_test(_[a-z0-9]+)?$/,
  load: /^owly_load$/,
};

function parse(name, value) {
  if (!value) throw new Error(name + " is required for a test/load target.");
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(name + " is not a valid URL.");
  }
  if (!["postgres:", "postgresql:"].includes(u.protocol))
    throw new Error(name + " has an unsupported protocol.");
  // pg-connection-string lets ?host=/?port=/?user= override the authority checked
  // below, so only the Prisma `schema` parameter is allowed.
  for (const key of u.searchParams.keys())
    if (key !== "schema") throw new Error(name + " has an unsupported query parameter.");
  return u;
}

function assertDisposableTarget(env = process.env, kind = "test") {
  const pattern = KINDS[kind];
  if (!pattern) throw new Error("Unknown target kind.");
  const pooled = parse("DATABASE_URL", env.DATABASE_URL);
  const direct = parse("DIRECT_DATABASE_URL", env.DIRECT_DATABASE_URL);
  const database = decodeURIComponent(pooled.pathname.slice(1));
  if (decodeURIComponent(direct.pathname.slice(1)) !== database)
    throw new Error("DATABASE_URL and DIRECT_DATABASE_URL name different databases.");
  if (!pattern.test(database))
    throw new Error("Database name is not a disposable " + kind + " target.");
  if (pooled.username !== direct.username)
    throw new Error("DATABASE_URL and DIRECT_DATABASE_URL use different users.");
  if (env.ZIYRAK_DISPOSABLE_DB !== database)
    throw new Error("ZIYRAK_DISPOSABLE_DB must name the target database to confirm ownership.");
  if (kind === "test") {
    for (const u of [pooled, direct])
      if (!LOCAL_HOSTS.has(u.hostname)) throw new Error("Test database host must be local.");
    if (pooled.host !== direct.host)
      throw new Error("DATABASE_URL and DIRECT_DATABASE_URL name different endpoints.");
  } else {
    // Load topology reaches Postgres through compose service names; both must be declared.
    const allowed = new Set((env.ZIYRAK_LOAD_HOSTS || "").split(",").filter(Boolean));
    for (const u of [pooled, direct])
      if (!LOCAL_HOSTS.has(u.hostname) && !allowed.has(u.hostname))
        throw new Error("Load database host is not declared in ZIYRAK_LOAD_HOSTS.");
  }
  return { database, user: pooled.username };
}

module.exports = { assertDisposableTarget };

if (require.main === module) {
  try {
    const r = assertDisposableTarget(process.env, process.argv[2] || "test");
    console.log("disposable target ok: " + r.database);
  } catch (e) {
    console.error("DB target refused: " + e.message);
    process.exit(1);
  }
}
