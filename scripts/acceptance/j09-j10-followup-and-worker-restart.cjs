const L = require("./lib.cjs"); const { execSync } = require("child_process");
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const sql = L.sql;
const ts = () => new Date().toISOString().slice(11, 19);
const out = { timeline: [] }; const mark = (m) => { out.timeline.push(`${ts()} ${m}`); console.log(`${ts()} ${m}`); };
async function open(name) { const b = await L.launch(name); const ctx = await b.createBrowserContext(); const p = await ctx.newPage(); await p.goto("http://localhost:4020/", { waitUntil: "load" }); await p.waitForSelector("#ziyrak-input"); await L.sleep(800); return { b, p }; }
const widgetLog = (p) => p.$$eval("#ziyrak-log > div", (ds) => ds.map((d) => d.textContent));
(async () => {
  // ---------- J9: durable follow-up, worker UP ----------
  const v9 = await open("visitor-j9");
  const r9 = await L.widgetSend(v9.p, "Please follow up with me in 1 minute about my order.");
  mark(`J9 reply: ${r9.reply}`);
  out.j9 = { ack: r9.ack, reply: r9.reply };
  out.j9.action_after_schedule = sql(`select tool||' | '||status||' | '||coalesce("errorMessage",'-') from "ActionExecution" where tool='schedule_followup' order by "createdAt" desc limit 1`);
  out.j9.pgboss_after_schedule = sql(`select name||' | '||state||' | start_after='||start_after||' | created='||created_on from pgboss.job where name='send-followup' order by created_on desc limit 1`);
  mark(`J9 ActionExecution: ${out.j9.action_after_schedule}`); mark(`J9 pg-boss: ${out.j9.pgboss_after_schedule}`);
  // ---------- J10: second visitor; stop worker while its follow-up is pending ----------
  const v10 = await open("visitor-j10");
  const r10 = await L.widgetSend(v10.p, "Please follow up with me in 1 minute, thanks.");
  mark(`J10 scheduled: ${r10.reply}`);
  out.j10 = { scheduledReply: r10.reply };
  out.j10.pgboss_pending = sql(`select state||' | start_after='||start_after from pgboss.job where name='send-followup' and state<>'completed' order by created_on desc limit 1`);
  mark(`J10 pending job before stop: ${out.j10.pgboss_pending}`);
  const stopT = Date.now();
  sh(`pkill -TERM -f "src/[w]orker.ts" || true`); await L.sleep(3000);
  const wlog = sh(`tail -4 ${L.SP}/worker.log`); out.j10.workerLogOnStop = wlog.split("\n").slice(-2);
  mark(`J10 worker stopped; processes left: ${sh(`pgrep -f "src/[w]orker.ts" | wc -l`)}`);
  // web must stay up
  out.j10.webWhileWorkerDown = { health: sh(`curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/api/health`), loginPage: sh(`curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/login`), widgetJs: sh(`curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/widget.js`) };
  mark(`J10 web while worker down: ${JSON.stringify(out.j10.webWhileWorkerDown)}`);
  // chat while worker is down: J7 proof (ACK yes, reply no)
  const beforeMsgs = sql(`select count(*) from "Message" where role='assistant'`);
  const r7 = await L.widgetSend(v10.p, "What is your verification code?", { timeoutMs: 12000 });
  out.j7 = { ackWhileWorkerDown: r7.ack, replyWhileWorkerDown: r7.reply };
  out.j7.receiptRow = sql(`select source||' | '||"processingStatus" from "InboundEventReceipt" order by "receivedAt" desc limit 1`);
  out.j7.customerMsgPersisted = sql(`select count(*) from "Message" where role='customer' and content='What is your verification code?' and "createdAt" > now() - interval '2 minutes'`);
  out.j7.jobWhileDown = sql(`select state||' | '||name from pgboss.job where name='process-inbound-message' order by created_on desc limit 1`);
  out.j7.assistantMsgCountChange = `${beforeMsgs} -> ${sql(`select count(*) from "Message" where role='assistant'`)}`;
  mark(`J7 while worker down: ack=${r7.ack && r7.ack.status}(${r7.ack && r7.ack.ms}ms) reply=${r7.reply} job=${out.j7.jobWhileDown} receipt=${out.j7.receiptRow}`);
  // wait until the follow-up is overdue, then restart the worker
  const dueIn = 75000 - (Date.now() - stopT); if (dueIn > 0) await L.sleep(dueIn);
  out.j10.overdueWhileDown = sql(`select state||' | start_after='||start_after||' | now='||now() from pgboss.job where name='send-followup' and state<>'completed' order by created_on desc limit 1`);
  mark(`J10 overdue while worker down: ${out.j10.overdueWhileDown}; follow-up visible to customer yet? ${(await widgetLog(v10.p)).some((t) => /Following up/.test(t))}`);
  sh(`${__dirname}/start-all.sh worker`); mark("J10 worker restarted");
  const deadline = Date.now() + 40000; let seenFollow = false, seenReply = false;
  while (Date.now() < deadline && !(seenFollow && seenReply)) { const lg = await widgetLog(v10.p); seenFollow = lg.some((t) => /Following up as promised/.test(t)); seenReply = lg.some((t) => /ZIYRAK-A-CODE-731/.test(t)); await L.sleep(1000); }
  out.j10.after_restart = { followupVisible: seenFollow, queuedChatReplyVisible: seenReply, widgetLog: await widgetLog(v10.p) };
  mark(`J10 after restart: followup=${seenFollow} queuedChatReply=${seenReply}`);
  // v9's follow-up (due ~52s after being scheduled) falls inside the SAME worker-down
  // window as v10's (the worker is stopped only a few seconds after both are scheduled)
  // — it is delivered only after the restart too, not sooner, so it needs its own poll,
  // not a single point-in-time check right after v10's loop happens to finish.
  const v9Deadline = Date.now() + 40000; let v9SeenFollow = false;
  while (Date.now() < v9Deadline && !v9SeenFollow) {
    const lg = await widgetLog(v9.p);
    v9SeenFollow = lg.some((t) => /Following up as promised/.test(t));
    if (!v9SeenFollow) await L.sleep(1000);
  }
  const l9 = await widgetLog(v9.p); out.j9.widgetLogAfter = l9; out.j9.followupVisible = v9SeenFollow;
  // exactly-once accounting
  out.exactlyOnce = {
    followUpMessages: sql(`select c.id::text||' | '||count(*) from "Message" m join "Conversation" c on c.id=m."conversationId" where m.role='assistant' and m.content like 'Following up as promised%' group by c.id`).split("\n"),
    actionExecutions: sql(`select status||' x'||count(*) from "ActionExecution" where tool='schedule_followup' group by status`).split("\n"),
    sendFollowupJobs: sql(`select state||' x'||count(*) from pgboss.job where name='send-followup' group by state`).split("\n"),
    processInboundJobs: sql(`select state||' x'||count(*) from pgboss.job where name='process-inbound-message' group by state`).split("\n"),
    queuedChatReplyCount: sql(`select count(*) from "Message" where role='assistant' and content like '%ZIYRAK-A-CODE-731%' and "conversationId" in (select id from "Conversation" where id=(select "conversationId" from "Message" where content='What is your verification code?' order by "createdAt" desc limit 1))`),
  };
  L.assert(out.j9.ack && out.j9.ack.status === 200, `J9: ack is 200, got ${out.j9.ack && out.j9.ack.status}`);
  L.assert(out.j9.action_after_schedule.includes("schedule_followup") && out.j9.action_after_schedule.includes("scheduled"), `J9: ActionExecution is scheduled, got ${out.j9.action_after_schedule}`);
  L.assert(out.j9.pgboss_after_schedule.includes("send-followup") && out.j9.pgboss_after_schedule.includes("created"), `J9: pg-boss job created for the future start_after, got ${out.j9.pgboss_after_schedule}`);

  L.assert(!!out.j10.pgboss_pending, `J10: a pending send-followup job exists before the worker stops`);
  L.assert(/drained|received/.test(out.j10.workerLogOnStop.join(" ")), `J10: worker log shows a graceful stop, got ${JSON.stringify(out.j10.workerLogOnStop)}`);
  L.assert(out.j10.webWhileWorkerDown.health === "200", `J10: /api/health stays 200 while the worker is down, got ${out.j10.webWhileWorkerDown.health}`);
  L.assert(out.j10.webWhileWorkerDown.loginPage === "200", `J10: /login stays 200 while the worker is down, got ${out.j10.webWhileWorkerDown.loginPage}`);
  L.assert(out.j10.webWhileWorkerDown.widgetJs === "200", `J10: /widget.js stays 200 while the worker is down, got ${out.j10.webWhileWorkerDown.widgetJs}`);

  L.assert(out.j7.ackWhileWorkerDown && out.j7.ackWhileWorkerDown.status === 200, `J7: ack is still 200 while the worker is down, got ${out.j7.ackWhileWorkerDown && out.j7.ackWhileWorkerDown.status}`);
  L.assert(out.j7.replyWhileWorkerDown === null, `J7: no reply is produced while the worker is down, got ${JSON.stringify(out.j7.replyWhileWorkerDown)}`);
  L.assert(Number(out.j7.customerMsgPersisted) >= 1, `J7: the customer message is persisted even though the worker is down, got ${out.j7.customerMsgPersisted}`);
  L.assert(/^(\d+) -> \1$/.test(out.j7.assistantMsgCountChange), `J7: assistant message count is unchanged while the worker is down, got ${out.j7.assistantMsgCountChange}`);
  L.assert(out.j10.overdueWhileDown && !out.j10.overdueWhileDown.startsWith("completed"), `J10: the overdue follow-up job is not completed while the worker is down, got ${out.j10.overdueWhileDown}`);
  L.assert(out.j10.after_restart.followupVisible === true, `J10: the follow-up is delivered after the worker restarts`);
  L.assert(out.j10.after_restart.queuedChatReplyVisible === true, `J10: the queued chat reply is delivered after the worker restarts`);
  L.assert(out.j9.followupVisible === true, `J9: the follow-up is delivered (worker was up when it came due)`);

  const eo = out.exactlyOnce;
  L.assert(eo.followUpMessages.length === 2, `exactly two conversations received a follow-up message, got ${JSON.stringify(eo.followUpMessages)}`);
  for (const row of eo.followUpMessages) L.assert(row.endsWith(" | 1"), `each conversation got its follow-up message exactly once, got ${row}`);
  L.assert(eo.actionExecutions.every((r) => r.startsWith("succeeded") || r.startsWith("scheduled")), `no schedule_followup action ended in a non-success status, got ${JSON.stringify(eo.actionExecutions)}`);
  L.assert(eo.sendFollowupJobs.every((r) => !r.startsWith("failed")), `no send-followup job failed, got ${JSON.stringify(eo.sendFollowupJobs)}`);
  L.assert(eo.processInboundJobs.every((r) => !r.startsWith("failed")), `no process-inbound-message job failed, got ${JSON.stringify(eo.processInboundJobs)}`);
  L.assert(Number(eo.queuedChatReplyCount) === 1, `the queued chat reply was delivered exactly once, got ${eo.queuedChatReplyCount}`);

  L.finish("J09-J10-J7", out);
  await v9.b.close(); await v10.b.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
