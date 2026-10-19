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
    const result = await client.query({ text: fs.readFileSync(0, "utf8"), rowMode: "array" });
    const results = Array.isArray(result) ? result : [result];
    process.stdout.write(
      results
        .flatMap((r) =>
          r.rows.map((row) =>
            row
              .map((v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)))
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
