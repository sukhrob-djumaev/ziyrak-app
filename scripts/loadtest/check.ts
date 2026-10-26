/**
 * PLAN.md §46.8 task 5 — drives the running multi-replica topology
 * (scripts/loadtest/run.sh) and checks the four scaling claims against it:
 *
 *   1. rate limit: requests split across the app replicas share ONE limit
 *   2. job processing: every inbound message is processed exactly once
 *   3. per-conversation ordering holds with competing worker replicas
 *   4. realtime: an event produced on one process reaches a client held by another
 *   5. scale-down: stopping a worker replica mid-load (what an HPA scale-down does)
 *      loses nothing and duplicates nothing
 *
 * Usage (env): REPLICAS=http://localhost:3201,http://localhost:3202
 *   DB_URL=... SEED_JSON='{...}' LOG_CMD="docker compose ... logs --no-color" WORKER_SERVICES=worker,worker-2
 *   STOP_WORKER_CMD="docker compose ... stop worker-2"
 *   EXPECT_REDIS=1|0  (0 = the control run: the checks that need Redis must FAIL)
 * Exit code 0 when every expectation for the chosen mode holds.
 */
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { Client } from "pg";

const replicas = (process.env.REPLICAS ?? "http://localhost:3201,http://localhost:3202").split(",");
const dbUrl = process.env.DB_URL!;
const seed = JSON.parse(process.env.SEED_JSON!) as { businessId: string; connectionId: string; token: string; origin: string };
const logCmd = process.env.LOG_CMD!;
const stopWorkerCmd = process.env.STOP_WORKER_CMD!;
const workerServices = (process.env.WORKER_SERVICES ?? "worker,worker-2").split(",");
const expectRedis = process.env.EXPECT_REDIS !== "0";

const CONVERSATIONS = 12;
const MESSAGES_PER_CONVERSATION = 4;
const AUTH_LIMIT = 5; // RATE_LIMITS.auth.maxRequests

const results: { name: string; pass: boolean; detail: string }[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const replica = (i: number) => replicas[i % replicas.length];

async function post(baseUrl: string, url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** 1. The shared limit is enforced across replicas, not multiplied by them. */
async function checkRateLimit() {
  const ip = `10.77.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
  const statuses = await Promise.all(
    Array.from({ length: 30 }, (_, i) => post(replica(i), "/api/auth", { action: "login", username: "nobody", password: "wrong" }, { "x-forwarded-for": ip }).then((r) => r.status))
  );
  const allowed = statuses.filter((s) => s !== 429).length;
  const limited = statuses.filter((s) => s === 429).length;
  if (expectRedis) {
    record("rate limit aggregated across replicas", allowed === AUTH_LIMIT, `30 requests split over ${replicas.length} replicas → ${allowed} allowed, ${limited} limited (limit ${AUTH_LIMIT}; limit × replicas would be ${AUTH_LIMIT * replicas.length})`);
  } else {
    record("control: without Redis the limit is multiplied by the replica count", allowed === AUTH_LIMIT * replicas.length, `${allowed} allowed (limit ${AUTH_LIMIT} × ${replicas.length} replicas = ${AUTH_LIMIT * replicas.length})`);
  }
}

async function sendMessage(baseUrl: string, conversationId: string, n: number, ip: string) {
  const response = await post(
    baseUrl,
    `/api/channels/webchat/${seed.connectionId}/message`,
    {
      token: seed.token,
      conversationId,
      clientMessageId: randomUUID(),
      text: `message ${n}`,
      customerName: "Load Visitor",
      customerContact: `visitor-${conversationId}`,
    },
    { origin: seed.origin, "x-forwarded-for": ip }
  );
  if (response.status !== 200) throw new Error(`message POST → ${response.status} ${await response.text()}`);
}

/** 2 + 3. Exactly-once processing and per-conversation order under competing workers. */
async function checkJobs(db: Client) {
  const conversationIds = Array.from({ length: CONVERSATIONS }, () => randomUUID());
  // Each message round goes out back-to-back (no waiting for replies), alternating
  // replica per message, so consecutive messages of one conversation arrive via
  // different app replicas while earlier ones are still queued or running.
  for (let m = 0; m < MESSAGES_PER_CONVERSATION; m++) {
    await Promise.all(conversationIds.map((id, c) => sendMessage(replica(c + m), id, m, `10.88.${c}.${m + 1}`)));
  }

  const total = CONVERSATIONS * MESSAGES_PER_CONVERSATION;
  const deadline = Date.now() + 180_000;
  let assistantCount = 0;
  while (Date.now() < deadline) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM "Message" WHERE role = 'assistant' AND "businessId" = $1`,
      [seed.businessId]
    );
    assistantCount = rows[0].n;
    if (assistantCount >= total) break;
    await sleep(500);
  }
  await sleep(3000); // a duplicate execution would show up here

  const perConversation = await db.query(
    `SELECT c.id,
            count(*) FILTER (WHERE m.role = 'customer')::int AS users,
            count(*) FILTER (WHERE m.role = 'assistant')::int AS assistants
       FROM "Conversation" c JOIN "Message" m ON m."conversationId" = c.id
      WHERE c."businessId" = $1 GROUP BY c.id`,
    [seed.businessId]
  );
  const exact = perConversation.rows.length === CONVERSATIONS && perConversation.rows.every((r) => r.users === MESSAGES_PER_CONVERSATION && r.assistants === MESSAGES_PER_CONVERSATION);
  record("every message got exactly one reply (none lost, none duplicated)", exact, `${perConversation.rows.length} conversations; ${perConversation.rows.map((r) => `${r.users}/${r.assistants}`).join(" ")} user/assistant`);

  const jobs = await db.query(
    `SELECT singleton_key, state, retry_count, created_on, started_on, completed_on
       FROM pgboss.job WHERE name = 'process-inbound-message' AND data->>'businessId' = $1
      ORDER BY singleton_key, created_on, started_on`,
    [seed.businessId]
  );
  const allCompleted = jobs.rows.length === total && jobs.rows.every((j) => j.state === "completed" && j.retry_count === 0);
  record("job table: one completed job per message, no retries", allCompleted, `${jobs.rows.length} jobs (expected ${total}); states ${[...new Set(jobs.rows.map((j) => j.state))].join(",")}; max retry ${Math.max(0, ...jobs.rows.map((j) => j.retry_count))}`);

  const byKey = new Map<string, typeof jobs.rows>();
  for (const job of jobs.rows) byKey.set(job.singleton_key, [...(byKey.get(job.singleton_key) ?? []), job]);
  let violations = 0;
  for (const list of byKey.values()) {
    list.sort((a, b) => +a.created_on - +b.created_on);
    for (let i = 1; i < list.length; i++) if (+list[i].started_on < +list[i - 1].completed_on) violations++;
  }
  record("per-conversation ordering: no job starts before the previous one for its conversation finished", violations === 0 && byKey.size === CONVERSATIONS, `${byKey.size} conversation keys, ${violations} ordering violations`);

  // Cross-conversation concurrency: at least two different conversations' jobs overlapped.
  let overlaps = 0;
  const flat = jobs.rows;
  for (let i = 0; i < flat.length; i++)
    for (let j = i + 1; j < flat.length; j++)
      if (flat[i].singleton_key !== flat[j].singleton_key && +flat[i].started_on < +flat[j].completed_on && +flat[j].started_on < +flat[i].completed_on) overlaps++;
  record("different conversations ran in parallel", overlaps > 0, `${overlaps} overlapping job pairs`);

  // Attribution from the workers' own logs (JOB_TRACE=1).
  const perWorker: Record<string, number> = {};
  for (const service of workerServices) {
    const text = execSync(`${logCmd} ${service}`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    perWorker[service] = (text.match(/\[PgBossJobQueue\] job \{"jobType":"process-inbound-message"/g) ?? []).length;
  }
  const sum = Object.values(perWorker).reduce((a, b) => a + b, 0);
  record("jobs were shared between the worker replicas, each executed once", Object.values(perWorker).every((n) => n > 0) && sum === total, `per worker: ${JSON.stringify(perWorker)}; total ${sum} (expected ${total})`);
}

/** 4. Realtime reaches a client on a different process than the one that produced the event. */
async function checkRealtime(db: Client) {
  const conversationId = randomUUID();
  const ip = "10.99.0.1";
  await sendMessage(replica(0), conversationId, 0, ip); // creates the conversation via replica A
  for (let i = 0; i < 40; i++) {
    const { rows } = await db.query(`SELECT 1 FROM "Conversation" WHERE id = $1`, [conversationId]);
    if (rows.length) break;
    await sleep(250);
  }
  await sleep(4000); // let the first reply finish so only the next event is awaited

  // Hold the widget's SSE stream on replica B; the assistant reply is produced by a worker process.
  const controller = new AbortController();
  const stream = await fetch(`${replica(1)}/api/channels/webchat/${seed.connectionId}/stream?token=${encodeURIComponent(seed.token)}&conversationId=${conversationId}&visitorId=${encodeURIComponent(`visitor-${conversationId}`)}`, {
    headers: { origin: seed.origin },
    signal: controller.signal,
  });
  let received = false;
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  const readLoop = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        if (/"type":"message:new"/.test(buffer) && /"role":"assistant"/.test(buffer)) {
          received = true;
          return;
        }
      }
    } catch {
      /* aborted */
    }
  })();

  await sleep(500);
  await sendMessage(replica(0), conversationId, 1, ip);
  await Promise.race([readLoop, sleep(15_000)]);
  controller.abort();

  if (expectRedis) {
    record("realtime: worker-produced event reached a client held by another app replica", received, received ? "assistant message:new arrived on replica B's SSE stream" : "no event within 15s");
  } else {
    record("control: without Redis the event never leaves the worker process", !received, received ? "unexpectedly delivered" : "no event reached replica B's stream (the silent miss Redis fixes)");
  }
}

/** 5. A worker replica removed mid-load (HPA scale-down / rolling restart) loses and duplicates nothing. */
async function checkScaleDown(db: Client) {
  const conversations = 8;
  const perConversation = 3;
  const ids = Array.from({ length: conversations }, () => randomUUID());
  for (let m = 0; m < perConversation; m++) {
    await Promise.all(ids.map((id, c) => sendMessage(replica(c + m), id, m, `10.66.${c}.${m + 1}`)));
  }
  await sleep(1000); // jobs are in flight on both workers
  execSync(stopWorkerCmd, { stdio: "pipe" }); // SIGTERM → graceful drain, like a pod being scaled down

  const total = conversations * perConversation;
  const keys = ids.map((id) => `${seed.businessId}:${id}`);
  const deadline = Date.now() + 120_000;
  let done = 0;
  while (Date.now() < deadline) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'process-inbound-message' AND singleton_key = ANY($1) AND state = 'completed'`, [keys]);
    done = rows[0].n;
    if (done >= total) break;
    await sleep(500);
  }
  await sleep(3000);
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE m.role = 'customer')::int AS users, count(*) FILTER (WHERE m.role = 'assistant')::int AS assistants
       FROM "Message" m WHERE m."conversationId" = ANY($1)`,
    [ids]
  );
  const retried = await db.query(`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'process-inbound-message' AND singleton_key = ANY($1) AND retry_count > 0`, [keys]);
  record(
    "scale-down: stopping a worker mid-load loses and duplicates nothing",
    done === total && rows[0].users === total && rows[0].assistants === total,
    `${done}/${total} jobs completed on the remaining worker; ${rows[0].users} customer / ${rows[0].assistants} assistant messages (expected ${total}/${total}); ${retried.rows[0].n} job(s) needed a retry`
  );
}

async function main() {
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  try {
    await checkRateLimit();
    await checkJobs(db);
    await checkRealtime(db);
    await checkScaleDown(db);
  } finally {
    await db.end();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} expectations met (mode: ${expectRedis ? "Redis on" : "Redis off — control"})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
