// Run-owned process fence (L1.1 / F08): a recorded PID is signalled only while
// its start time, cwd and command line still match what was recorded, and only
// for the same run id. Never matches by name; never signals PID <= 1.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

function liveIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const out = (args) => execFileSync("ps", ["-p", String(pid), ...args], { encoding: "utf8" }).trim();
    const birth = out(["-o", "lstart="]);
    const command = out(["-o", "command="]);
    const cwd = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" })
      .split("\n")
      .find((l) => l.startsWith("n"))
      ?.slice(1);
    if (!birth || !cwd || !command) return null;
    return { pid, birth, cwd: fs.realpathSync(cwd), command };
  } catch {
    return null;
  }
}
const defaults = { identity: liveIdentity, kill: (pid, sig) => process.kill(pid, sig) };
const same = (a, b) =>
  !!a && !!b && a.pid === b.pid && a.birth === b.birth && a.cwd === b.cwd && a.command === b.command;

function record(file, runId, id, deps = defaults) {
  if (!runId) throw new Error("A run id is required.");
  if (!id || !Number.isSafeInteger(id.pid) || id.pid <= 1)
    throw new Error("Cannot prove the identity of the process to own.");
  const now = (deps.identity || defaults.identity)(id.pid);
  if (!same(id, now)) throw new Error("Process identity changed before it could be recorded.");
  fs.writeFileSync(file, JSON.stringify({ runId, ...id }), { flag: "wx" });
}

function stopOwned(file, runId, deps = defaults) {
  if (!fs.existsSync(file)) return;
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  if (saved.runId !== runId) throw new Error("Refusing: ownership record belongs to another run.");
  const now = (deps.identity || defaults.identity)(saved.pid);
  if (!now) {
    // No identity is only "gone" if the PID really is absent; a failed ps/lsof on a live PID is not.
    const probe =
      deps.alive ||
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (e) {
          return e.code !== "ESRCH";
        }
      });
    if (probe(saved.pid)) throw new Error("Cannot verify a live recorded process; not signalling it.");
    return;
  }
  const { runId: _r, ...id } = saved;
  void _r;
  if (!same(id, now)) throw new Error("Refusing to signal a stale or foreign PID.");
  (deps.kill || defaults.kill)(saved.pid, "SIGTERM");
}

module.exports = { record, stopOwned, liveIdentity };

if (require.main === module) {
  const [cmd, file, runId, pid] = process.argv.slice(2);
  try {
    if (cmd === "record") record(file, runId, liveIdentity(Number(pid)));
    else if (cmd === "stop") stopOwned(file, runId);
    else throw new Error("Use record <file> <run> <pid> or stop <file> <run>.");
  } catch (e) {
    console.error("Process fence: " + e.message);
    process.exit(1);
  }
}
