// Isolated acceptance startup, build identity and process ownership (R3).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const net = require("node:net");
const root = fs.realpathSync(path.join(__dirname, "../.."));
if (process.env.ACC_WORK_DIR && !path.isAbsolute(process.env.ACC_WORK_DIR))
  throw new Error("ACC_WORK_DIR must be absolute.");
const work = path.resolve(process.env.ACC_WORK_DIR || path.join(__dirname, ".work"));
function database(env = process.env) {
  if (env.ACC_BASE_URL && env.ACC_BASE_URL !== "http://localhost:3100")
    throw new Error("ACC_BASE_URL must target the isolated localhost:3100 application.");
  if (!env.ACC_DB) throw new Error("ACC_DB is required; no historical database fallback.");
  let u;
  try {
    u = new URL(env.ACC_DB);
  } catch {
    throw new Error("ACC_DB must be a PostgreSQL URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(u.protocol) ||
    !/^ziyrak_acceptance_[a-z0-9_]+$/.test(u.pathname.slice(1))
  )
    throw new Error("Use a fresh ziyrak_acceptance_<run> database.");
  for (const key of ["DATABASE_URL", "DIRECT_DATABASE_URL"])
    if (env[key] && env[key] !== env.ACC_DB) throw new Error(key + " disagrees with ACC_DB.");
  if (env.ACC_PSQL)
    throw new Error("ACC_PSQL is unsupported: evidence must query the exact ACC_DB endpoint.");
  return u;
}
function isolated() {
  if (!fs.statSync(path.join(root, ".git")).isFile())
    throw new Error("Acceptance must run from an isolated Git worktree.");
}
function sourceDigest() {
  const names = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "src",
      "prisma",
      "public",
      "package.json",
      "package-lock.json",
      "next.config.ts",
      "tsconfig.json",
    ],
    { cwd: root, encoding: "utf8" }
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  const hash = crypto.createHash("sha256");
  for (const name of names)
    if (fs.existsSync(path.join(root, name)))
      hash.update(name).update(fs.readFileSync(path.join(root, name)));
  return hash.digest("hex");
}
function build() {
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    digest: sourceDigest(),
    buildId: fs.readFileSync(path.join(root, ".next/BUILD_ID"), "utf8").trim(),
  };
}
function buildCandidate() {
  isolated();
  database();
  const before = {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    digest: sourceDigest(),
  };
  execFileSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: process.env.ACC_DB,
      DIRECT_DATABASE_URL: process.env.ACC_DB,
      NEXT_PUBLIC_APP_URL: "http://localhost:3100",
    },
  });
  const after = build();
  if (before.head !== after.head || before.digest !== after.digest)
    throw new Error("Source changed during build; rebuild.");
  fs.writeFileSync(path.join(root, ".next/acceptance-build.json"), JSON.stringify(after));
}
function verifyBuild() {
  const stored = JSON.parse(
    fs.readFileSync(path.join(root, ".next/acceptance-build.json"), "utf8")
  );
  if (JSON.stringify(stored) !== JSON.stringify(build()))
    throw new Error("Build identity is missing/stale; run the acceptance build command.");
  return stored;
}
function manifest(checkBuild = true) {
  isolated();
  const u = database();
  const b = checkBuild ? verifyBuild() : null;
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(work, "run.json");
  const fingerprint = crypto.createHash("sha256").update(u.href).digest("hex");
  const m = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {
        runId: crypto.randomUUID(),
        root,
        databaseFingerprint: fingerprint,
        build: b,
        processes: {},
      };
  if (
    m.root !== root ||
    m.databaseFingerprint !== fingerprint ||
    (checkBuild && JSON.stringify(m.build) !== JSON.stringify(b))
  )
    throw new Error(
      "Work directory belongs to another checkout/database/build; use a fresh ACC_WORK_DIR."
    );
  return { file, m };
}
function mutate(fn) {
  fs.mkdirSync(work, { recursive: true });
  const lock = path.join(work, "ownership.lock");
  const fd = fs.openSync(lock, "wx");
  try {
    const { file, m } = manifest();
    fn(m);
    fs.writeFileSync(file + ".tmp", JSON.stringify(m, null, 2));
    fs.renameSync(file + ".tmp", file);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid owned PID.");
  try {
    const birth = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
    }).trim();
    const cwd = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
    })
      .split("\n")
      .find((l) => l.startsWith("n"))
      ?.slice(1);
    if (!birth || !cwd) return null;
    return { pid, birth, cwd: fs.realpathSync(cwd) };
  } catch {
    return null;
  }
}
function sameIdentity(a, b) {
  return !!a && !!b && a.pid === b.pid && a.birth === b.birth && a.cwd === b.cwd;
}
function verifyTopology() {
  const { m } = manifest();
  const required = { web: [3100], hosts: [4020, 4021, 4022] };
  if (process.env.ACC_REAL_AI !== "1") required.llm = [4010];
  for (const [role, ports] of Object.entries(required)) {
    const saved = m.processes[role];
    if (!saved || !sameIdentity(saved, identity(saved.pid)))
      throw new Error("Missing/stale owned " + role + " process; start the acceptance topology.");
    for (const port of ports) {
      let listeners = [];
      try {
        listeners = [
          ...new Set(
            execFileSync("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"], {
              encoding: "utf8",
            })
              .trim()
              .split("\n")
              .map(Number)
          ),
        ];
      } catch {
        /* Missing listener is a failed ownership check. */
      }
      if (listeners.length !== 1 || listeners[0] !== saved.pid)
        throw new Error("Port " + port + " is not owned by the recorded " + role + " process.");
    }
  }
  // Worker absence is intentional during J10's recovery window.
}
function record(role, pid) {
  const id = identity(pid);
  if (!id || id.cwd !== root) throw new Error("Cannot prove child process checkout ownership.");
  mutate((m) => {
    if (m.processes[role] && identity(m.processes[role].pid))
      throw new Error(role + " is already recorded and running.");
    m.processes[role] = id;
  });
}
function stop(role) {
  const { m } = manifest(false);
  const saved = m.processes[role];
  if (!saved) return;
  const current = identity(saved.pid);
  if (current && !sameIdentity(saved, current))
    throw new Error("Refusing to signal stale/foreign " + role + " PID.");
  if (current) {
    if (saved.cwd !== root) throw new Error("Foreign checkout PID refused.");
    process.kill(saved.pid, "SIGTERM");
  }
  // Keep the identity for rechecking during stop/restart; start refuses a child still draining.
}
function portFree(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", () => reject(new Error("Acceptance port " + port + " is occupied.")));
    s.listen(port, "127.0.0.1", () => s.close(resolve));
  });
}
async function start(what = "all") {
  manifest();
  const allowed = ["web", "worker", "llm", "hosts"];
  if (what !== "all" && !allowed.includes(what)) throw new Error("Unknown acceptance role.");
  const roles = what === "all" ? allowed : [what];
  const started = [];
  const env = {
    ...process.env,
    ACC_WORK_DIR: work,
    DATABASE_URL: process.env.ACC_DB,
    DIRECT_DATABASE_URL: process.env.ACC_DB,
    NODE_ENV: "production",
  };
  if (env.ACC_REAL_AI !== "1") env.OPENAI_BASE_URL = "http://127.0.0.1:4010/v1";
  else delete env.OPENAI_BASE_URL;
  const specs = {
    web: {
      args: ["node_modules/next/dist/bin/next", "start", "-p", "3100", "-H", "127.0.0.1"],
      ports: [3100],
    },
    worker: { args: ["--import", "tsx", "src/worker.ts"], ports: [] },
    llm: { args: ["scripts/acceptance/llm-standin.cjs"], ports: [4010] },
    hosts: { args: ["scripts/acceptance/host-sites.cjs"], ports: [4020, 4021, 4022] },
  };
  try {
    for (const role of roles) {
      if (role === "llm" && env.ACC_REAL_AI === "1") continue;
      const saved = manifest().m.processes[role];
      if (saved && identity(saved.pid))
        throw new Error(role + " is still running; stop and wait for its recorded PID.");
      for (const p of specs[role].ports) await portFree(p);
      const fd = fs.openSync(path.join(work, role + ".log"), "a");
      let child;
      try {
        child = spawn(process.execPath, specs[role].args, {
          cwd: root,
          env,
          detached: true,
          stdio: ["ignore", fd, fd],
        });
      } finally {
        fs.closeSync(fd);
      }
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        setTimeout(resolve, 200);
      });
      try {
        record(role, child.pid);
      } catch (error) {
        if (child.exitCode === null) child.kill("SIGTERM");
        throw error;
      }
      started.push(role);
      child.unref();
    }
  } catch (e) {
    for (const role of started.reverse()) stop(role);
    throw e;
  }
}
async function cli() {
  const [command, arg] = process.argv.slice(2);
  if (command === "build") buildCandidate();
  else if (command === "start") await start(arg);
  else if (command === "stop") {
    if (arg === "all") {
      for (const role of Object.keys(manifest(false).m.processes).reverse()) stop(role);
    } else stop(arg);
  } else if (command === "verify") verifyTopology();
  else throw new Error("Use build, start <role|all>, stop <role|all> or verify.");
}
module.exports = {
  database,
  identity,
  sameIdentity,
  record,
  stop,
  manifest,
  verifyTopology,
  root,
  work,
};
if (require.main === module)
  cli().catch((e) => {
    console.error("Acceptance safety: " + e.message);
    process.exitCode = 1;
  });
