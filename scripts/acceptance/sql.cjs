const fs = require("node:fs");
const { Client } = require("pg");
const R = require("./runtime.cjs");
(async () => {
  const u = R.database();
  R.manifest();
  const client = new Client({
    connectionString: process.env.ACC_DB,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    const identity = await client.query("select current_database() as db");
    if (identity.rows[0].db !== u.pathname.slice(1))
      throw new Error("Evidence DB identity mismatch.");
    const result = await client.query(fs.readFileSync(0, "utf8"));
    const results = Array.isArray(result) ? result : [result];
    process.stdout.write(
      results
        .flatMap((r) =>
          r.rows.map((row) =>
            Object.values(row)
              .map((v) => (v == null ? "" : String(v)))
              .join(" | ")
          )
        )
        .join("\n")
    );
  } finally {
    await client.end();
  }
})().catch(() => {
  console.error("Acceptance SQL failed against the selected isolated database.");
  process.exitCode = 1;
});
