const L = require("./lib.cjs");
const { execSync, execFileSync } = require("child_process");
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const sql = L.sql;
const ts = () => new Date().toISOString().slice(11, 19);
const out = { timeline: [] };
const mark = (m) => {
  out.timeline.push(`${ts()} ${m}`);
  console.log(`${ts()} ${m}`);
};
async function open(name) {
  const b = await L.launch(name);
  const ctx = await b.createBrowserContext();
  const p = await ctx.newPage();
  await p.goto("http://localhost:4020/", { waitUntil: "load" });
  await p.waitForSelector("#ziyrak-input");
  await L.sleep(800);
  return { b, p };
}
const widgetLog = (p) => p.$$eval("#ziyrak-log > div", (ds) => ds.map((d) => d.textContent));
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
async function lineage(page) {
  const conversationId = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("ziyrak_webchat_conversation_"));
    return key && localStorage.getItem(key);
  });
  if (!/^[0-9a-f-]{36}$/.test(conversationId || ""))
    throw Error("Widget conversation binding is missing");
  const payload = JSON.parse(
    sql("SELECT data FROM pgboss.job WHERE name='send-followup' ORDER BY created_on DESC LIMIT 1")
  );
  L.assert(
    payload.conversationId === conversationId,
    "Follow-up queue parent matches the actual visitor conversation"
  );
  const parent = sql(
    'SELECT coalesce("conversationId",\'unbound\') FROM "ActionExecution" WHERE "businessId"=' +
      quote(payload.businessId) +
      ' AND "idempotencyKey"=' +
      quote(payload.idempotencyKey)
  );
  L.assert(
    parent === conversationId,
    "Durable follow-up action binds the same actual visitor parent before pickup/restart"
  );
  return {
    visitorConversationId: conversationId,
    queueConversationId: payload.conversationId,
    actionConversationId: parent,
  };
}

(async () => {
  // ---------- J9: durable follow-up, worker UP ----------
  const v9 = await open("visitor-j9");
  const r9 = await L.widgetSend(v9.p, "Please follow up with me in 1 minute, thanks.");
  mark(`J9 reply: ${r9.reply}`);
  out.j9 = { ack: r9.ack, reply: r9.reply, lineage: await lineage(v9.p) };
  out.j9.action_after_schedule = sql(
    `select tool||' | '||status||' | '||coalesce("errorMessage",'-') from "ActionExecution" where tool='schedule_followup' order by "createdAt" desc limit 1`
  );
  out.j9.followupMessage = sql(
    `select input->>'message' from "ActionExecution" where tool='schedule_followup' order by "createdAt" desc limit 1`
  );
  out.j9.pgboss_after_schedule = sql(
    `select name||' | '||state||' | start_after='||start_after||' | created='||created_on from pgboss.job where name='send-followup' order by created_on desc limit 1`
  );
  mark(`J9 ActionExecution: ${out.j9.action_after_schedule}`);
  mark(`J9 pg-boss: ${out.j9.pgboss_after_schedule}`);
  // ---------- J10: second visitor; stop worker while its follow-up is pending ----------
  const v10 = await open("visitor-j10");
  const r10 = await L.widgetSend(v10.p, "Please follow up with me in 1 minute, thanks.");
  mark(`J10 scheduled: ${r10.reply}`);
  out.j10 = { scheduledReply: r10.reply, lineage: await lineage(v10.p) };
  out.j10.pgboss_pending = sql(
    `select state||' | start_after='||start_after from pgboss.job where name='send-followup' and state<>'completed' order by created_on desc limit 1`
  );
  out.j10.followupMessage = sql(
    `select input->>'message' from "ActionExecution" where tool='schedule_followup' order by "createdAt" desc limit 1`
  );
  mark(`J10 pending job before stop: ${out.j10.pgboss_pending}`);
  const stopT = Date.now();
  // Stop only the acceptance worker, by the PID start-all.sh recorded — never by name, which would also stop a live worker.
  const runtime = require("./runtime.cjs");
  const workerPid = runtime.manifest().m.processes.worker?.pid;
  if (!workerPid) throw new Error("No acceptance-owned worker recorded.");
  runtime.stop("worker");
  await L.sleep(3000);
  const wlog = execFileSync("tail", ["-4", L.SP + "/worker.log"], { encoding: "utf8" }).trim();
  out.j10.workerLogOnStop = wlog.split("\n").slice(-2);
  mark(
    `J10 worker stopped; acceptance worker still running: ${sh(`kill -0 ${workerPid} 2>/dev/null && echo yes || echo no`)}`
  );
  // web must stay up
  out.j10.webWhileWorkerDown = {
    health: sh(`curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/api/health`),
    loginPage: sh(`curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/login`),
    widgetJs: sh(`curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/widget.js`),
  };
  mark(`J10 web while worker down: ${JSON.stringify(out.j10.webWhileWorkerDown)}`);
  // chat while worker is down: J7 proof (ACK yes, reply no)
  const beforeMsgs = sql(`select count(*) from "Message" where role='assistant'`);
  const r7 = await L.widgetSend(v10.p, "What is your verification code?", { timeoutMs: 12000 });
  out.j7 = { ackWhileWorkerDown: r7.ack, replyWhileWorkerDown: r7.reply };
  out.j7.receiptRow = sql(
    `select source||' | '||"processingStatus" from "InboundEventReceipt" order by "receivedAt" desc limit 1`
  );
  out.j7.jobWhileDown = sql(
    `select state||' | '||name from pgboss.job where name='process-inbound-message' order by created_on desc limit 1`
  );
  out.j7.assistantMsgCountChange = `${beforeMsgs} -> ${sql(`select count(*) from "Message" where role='assistant'`)}`;
  mark(
    `J7 while worker down: ack=${r7.ack && r7.ack.status}(${r7.ack && r7.ack.ms}ms) reply=${r7.reply} job=${out.j7.jobWhileDown} receipt=${out.j7.receiptRow}`
  );
  // wait until the follow-up is overdue, then restart the worker
  const dueIn = 75000 - (Date.now() - stopT);
  if (dueIn > 0) await L.sleep(dueIn);
  out.j10.overdueWhileDown = sql(
    `select state||' | start_after='||start_after||' | now='||now() from pgboss.job where name='send-followup' and state<>'completed' order by created_on desc limit 1`
  );
  mark(
    `J10 overdue while worker down: ${out.j10.overdueWhileDown}; follow-up visible to customer yet? ${(await widgetLog(v10.p)).some((t) => /Following up/.test(t))}`
  );
  execFileSync(__dirname + "/start-all.sh", ["worker"], { encoding: "utf8", env: process.env });
  mark("J10 worker restarted");
  const deadline = Date.now() + 40000;
  let seenFollow = false,
    receiptProcessed = false;
  while (Date.now() < deadline && !(seenFollow && receiptProcessed)) {
    const lg = await widgetLog(v10.p);
    seenFollow = lg.some((t) => t === out.j10.followupMessage);
    receiptProcessed =
      sql(
        `select "processingStatus" from "InboundEventReceipt" order by "receivedAt" desc limit 1`
      ) === "processed";
    await L.sleep(1000);
  }
  out.j10.after_restart = {
    followupVisible: seenFollow,
    queuedReceiptProcessed: receiptProcessed,
    widgetLog: await widgetLog(v10.p),
  };
  mark(`J10 after restart: followup=${seenFollow} queuedReceiptProcessed=${receiptProcessed}`);
  // v9's follow-up (due ~52s after being scheduled) falls inside the SAME worker-down
  // window as v10's (the worker is stopped only a few seconds after both are scheduled)
  // — it is delivered only after the restart too, not sooner, so it needs its own poll,
  // not a single point-in-time check right after v10's loop happens to finish.
  const v9Deadline = Date.now() + 40000;
  let v9SeenFollow = false;
  while (Date.now() < v9Deadline && !v9SeenFollow) {
    const lg = await widgetLog(v9.p);
    v9SeenFollow = lg.some((t) => t === out.j9.followupMessage);
    if (!v9SeenFollow) await L.sleep(1000);
  }
  const l9 = await widgetLog(v9.p);
  out.j9.widgetLogAfter = l9;
  out.j9.followupVisible = v9SeenFollow;
  // exactly-once accounting
  out.exactlyOnce = {
    followUpMessages: sql(
      `select a."conversationId"::text||' | '||count(m.id) from "ActionExecution" a left join "Message" m on m."conversationId"=a."conversationId" and m.role='assistant' and m.content=(a.input->>'message') where a.tool='schedule_followup' group by a."conversationId"`
    ).split("\n"),
    actionExecutions: sql(
      `select status||' x'||count(*) from "ActionExecution" where tool='schedule_followup' group by status`
    ).split("\n"),
    sendFollowupJobs: sql(
      `select state||' x'||count(*) from pgboss.job where name='send-followup' group by state`
    ).split("\n"),
    processInboundJobs: sql(
      `select state||' x'||count(*) from pgboss.job where name='process-inbound-message' group by state`
    ).split("\n"),
    queuedReceiptStatus: sql(
      `select "processingStatus" from "InboundEventReceipt" order by "receivedAt" desc limit 1`
    ),
  };
  L.assert(
    out.j9.ack && out.j9.ack.status === 200,
    `J9: ack is 200, got ${out.j9.ack && out.j9.ack.status}`
  );
  L.assert(
    out.j9.action_after_schedule.includes("schedule_followup") &&
      out.j9.action_after_schedule.includes("scheduled"),
    `J9: ActionExecution is scheduled, got ${out.j9.action_after_schedule}`
  );
  L.assert(
    out.j9.pgboss_after_schedule.includes("send-followup") &&
      out.j9.pgboss_after_schedule.includes("created"),
    `J9: pg-boss job created for the future start_after, got ${out.j9.pgboss_after_schedule}`
  );

  L.assert(
    !!out.j10.pgboss_pending,
    `J10: a pending send-followup job exists before the worker stops`
  );
  L.assert(
    /drained|received/.test(out.j10.workerLogOnStop.join(" ")),
    `J10: worker log shows a graceful stop, got ${JSON.stringify(out.j10.workerLogOnStop)}`
  );
  L.assert(
    out.j10.webWhileWorkerDown.health === "200",
    `J10: /api/health stays 200 while the worker is down, got ${out.j10.webWhileWorkerDown.health}`
  );
  L.assert(
    out.j10.webWhileWorkerDown.loginPage === "200",
    `J10: /login stays 200 while the worker is down, got ${out.j10.webWhileWorkerDown.loginPage}`
  );
  L.assert(
    out.j10.webWhileWorkerDown.widgetJs === "200",
    `J10: /widget.js stays 200 while the worker is down, got ${out.j10.webWhileWorkerDown.widgetJs}`
  );

  L.assert(
    out.j7.ackWhileWorkerDown && out.j7.ackWhileWorkerDown.status === 200,
    `J7: ack is still 200 while the worker is down, got ${out.j7.ackWhileWorkerDown && out.j7.ackWhileWorkerDown.status}`
  );
  L.assert(
    out.j7.replyWhileWorkerDown === null,
    `J7: no reply is produced while the worker is down, got ${JSON.stringify(out.j7.replyWhileWorkerDown)}`
  );
  L.assert(
    /^(\d+) -> \1$/.test(out.j7.assistantMsgCountChange),
    `J7: assistant message count is unchanged while the worker is down, got ${out.j7.assistantMsgCountChange}`
  );
  L.assert(
    out.j10.overdueWhileDown && !out.j10.overdueWhileDown.startsWith("completed"),
    `J10: the overdue follow-up job is not completed while the worker is down, got ${out.j10.overdueWhileDown}`
  );
  L.assert(
    out.j10.after_restart.followupVisible === true,
    `J10: the follow-up is delivered after the worker restarts`
  );
  L.assert(
    out.j10.after_restart.queuedReceiptProcessed === true,
    `J7: the queued receipt is processed after the worker restarts`
  );
  L.assert(
    out.j9.followupVisible === true,
    `J9: the follow-up is delivered (worker was up when it came due)`
  );

  const eo = out.exactlyOnce;
  L.assert(
    eo.followUpMessages.length === 2,
    `exactly two conversations received a follow-up message, got ${JSON.stringify(eo.followUpMessages)}`
  );
  for (const row of eo.followUpMessages)
    L.assert(
      row.endsWith(" | 1"),
      `each conversation got its follow-up message exactly once, got ${row}`
    );
  L.assert(
    eo.actionExecutions.every((r) => r.startsWith("succeeded") || r.startsWith("scheduled")),
    `no schedule_followup action ended in a non-success status, got ${JSON.stringify(eo.actionExecutions)}`
  );
  L.assert(
    eo.sendFollowupJobs.every((r) => !r.startsWith("failed")),
    `no send-followup job failed, got ${JSON.stringify(eo.sendFollowupJobs)}`
  );
  L.assert(
    eo.processInboundJobs.every((r) => !r.startsWith("failed")),
    `no process-inbound-message job failed, got ${JSON.stringify(eo.processInboundJobs)}`
  );
  L.assert(
    eo.queuedReceiptStatus === "processed",
    `the queued chat receipt is processed after restart, got ${eo.queuedReceiptStatus}`
  );

  L.finish("J09-J10-J7", out);
  await v9.b.close();
  await v10.b.close();
})().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
