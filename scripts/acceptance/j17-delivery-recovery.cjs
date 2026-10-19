// R1: actual recovery UI/worker/widget, with explicit synthetic uncertain-state fixtures.
const L = require("./lib.cjs");
const { randomUUID } = require("node:crypto");
const creds = require("./creds.json");
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
async function review(page, reply) {
  await page.goto(L.BASE + "/approvals", { waitUntil: "networkidle0" });
  await L.clickFirst(page, "button", "Delivery recovery");
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('[data-testid="delivery-recovery-row"]')].some((row) =>
        row.textContent.includes(text)
      ),
    {},
    reply
  );
  await page.evaluate((text) => {
    const row = [...document.querySelectorAll('[data-testid="delivery-recovery-row"]')].find(
      (row) => row.textContent.includes(text)
    );
    row.querySelector("button").click();
  }, reply);
  await page.waitForSelector('form[aria-label="Recovery decision"]');
}
(async () => {
  const browsers = [];
  const out = {
    topology: "isolated Next build + real Postgres/pg-boss + LLM stand-in + actual Chromium/widget",
    faultFixture:
      "Synthetic unknown and interrupted-preparation operations; no real Meta outcome claim",
  };
  try {
    const visitorBrowser = await L.launch("visitor-r1-recovery");
    browsers.push(visitorBrowser);
    const visitor = await visitorBrowser.newPage();
    await visitor.goto("http://localhost:4020/", { waitUntil: "load" });
    await visitor.waitForSelector("#ziyrak-input");
    const first = await L.widgetSend(visitor, "What is your verification code?");
    L.assert(
      first.ack?.status === 200 && !!first.reply,
      "Recovery visitor has a real persisted conversation before injecting faults"
    );
    const conversationId = await visitor.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.startsWith("ziyrak_webchat_conversation_")
      );
      return key && localStorage.getItem(key);
    });
    if (!/^[0-9a-f-]{36}$/.test(conversationId || ""))
      throw new Error("Missing real widget conversation fixture");
    const conversation = JSON.parse(
      L.sql(
        `SELECT row_to_json(c) FROM (SELECT id, "businessId", "customerContact", metadata->>'channelConnectionId' AS "connectionId" FROM "Conversation" WHERE id=${quote(conversationId)}) c`
      )
    );
    const unknownId = randomUUID(),
      interruptedId = randomUUID();
    const savedReply = "R1 saved reply: reviewed and sent without repeating AI or tools.";
    const values = (id, kind, response, status) =>
      `(${quote(id)},${quote(conversation.businessId)},${quote("synthetic-browser:" + id)},${quote(kind)},${quote(conversation.id)},'webchat',${quote(conversation.connectionId)},${quote(conversation.customerContact)},${response === null ? "NULL" : quote(response)},${quote(status)},now())`;
    L.sql(
      `INSERT INTO "DeliveryOperation" (id,"businessId","operationKey",kind,"conversationId",channel,"connectionId",recipient,response,status,"updatedAt") VALUES ${values(unknownId, "followup", savedReply, "unknown")},${values(interruptedId, "inbound", null, "preparation_interrupted")}`
    );
    const aBrowser = await L.launch(creds.A.profile);
    browsers.push(aBrowser);
    const owner = await aBrowser.newPage();
    const ev = L.watch(owner, "r1-recovery-owner");
    await review(owner, savedReply);
    await owner.select('select[aria-label="Recovery decision"]', "resend");
    await owner.type(
      'textarea[aria-label="Recovery reason"]',
      "Synthetic provider evidence reviewed; explicit resend approved"
    );
    out.ackRequired = await owner.$eval(
      'form[aria-label="Recovery decision"] button[type="submit"]',
      (button) => button.disabled
    );
    L.assert(
      out.ackRequired,
      "Unknown resend cannot be submitted before duplicate-risk acknowledgement"
    );
    await L.shot(owner, "j17-unknown-review-before-ack");
    await owner.click('form[aria-label="Recovery decision"] input[type="checkbox"]');
    const recoveryResponse = owner.waitForResponse(
      (r) => r.url().endsWith("/" + unknownId + "/recover") && r.request().method() === "POST"
    );
    await L.clickFirst(owner, "button", "Save recovery decision");
    out.resendResponse = (await recoveryResponse).status();
    L.assert(
      out.resendResponse === 200,
      "Actual recovery form accepted the explicit resend decision"
    );
    await visitor.waitForFunction(
      (text) => document.querySelector("#ziyrak-log")?.textContent.includes(text),
      { timeout: 30000 },
      savedReply
    );
    out.visitorSawReply = true;
    await L.shot(visitor, "j17-visitor-saved-reply");
    await visitor.reload({ waitUntil: "load" });
    await visitor.waitForFunction(
      (text) => document.querySelector("#ziyrak-log")?.textContent.includes(text),
      { timeout: 15000 },
      savedReply
    );
    out.replySurvivedReload = true;
    out.savedReplyCount = Number(
      L.sql(
        `SELECT count(*) FROM "Message" WHERE "conversationId"=${quote(conversation.id)} AND content=${quote(savedReply)}`
      )
    );
    L.assert(
      out.savedReplyCount === 1,
      "Saved reply is persisted once and visible after widget reload"
    );
    out.accepted = L.sql(`SELECT status FROM "DeliveryOperation" WHERE id=${quote(unknownId)}`);
    L.assert(
      out.accepted === "accepted",
      "Worker checkpointed channel acceptance for saved-reply retry"
    );
    // Preparation has no saved reply and therefore offers no automatic resend.
    await review(owner, "Reply needs review");
    out.interruptedOptions = await owner.$$eval(
      'select[aria-label="Recovery decision"] option',
      (options) => options.map((option) => option.value)
    );
    L.assert(
      !out.interruptedOptions.includes("resend"),
      "Interrupted preparation cannot replay AI/tools from the recovery form"
    );
    await owner.type(
      'textarea[aria-label="Recovery reason"]',
      "Completed actions reviewed; stop the interrupted reply"
    );
    await L.clickFirst(owner, "button", "Save recovery decision");
    await owner.waitForFunction(() => document.body.innerText.includes("Decision saved."));
    out.interruptedStatus = L.sql(
      `SELECT status FROM "DeliveryOperation" WHERE id=${quote(interruptedId)}`
    );
    L.assert(
      out.interruptedStatus === "cancelled",
      "UI cancellation persisted for interrupted preparation"
    );
    await L.shot(owner, "j17-interrupted-stopped");
    // Foreign workspace probes run with B's actual authenticated browser cookie.
    const bBrowser = await L.launch(creds.B.profile);
    browsers.push(bBrowser);
    const other = await bBrowser.newPage();
    await other.goto(L.BASE + "/approvals", { waitUntil: "networkidle0" });
    await L.clickFirst(other, "button", "Delivery recovery");
    out.foreignProbe = await other.evaluate(async (id) => {
      const list = await fetch("/api/deliveries");
      const body = await list.json();
      const recover = await fetch("/api/deliveries/" + id + "/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "cancel",
          reason: "Foreign workspace probe",
          requestId: crypto.randomUUID(),
        }),
      });
      return { listed: JSON.stringify(body).includes(id), status: recover.status };
    }, unknownId);
    L.assert(
      !out.foreignProbe.listed && out.foreignProbe.status === 404,
      "B cannot list or recover A's operation"
    );
    out.auditCount = Number(
      L.sql(
        `SELECT count(*) FROM "ActivityLog" a JOIN "Membership" m ON m."userId"=a."userId" AND m."businessId"=a."businessId" WHERE a.action='delivery.recovered' AND a."entityId" IN (${quote(unknownId)},${quote(interruptedId)}) AND m.role='owner'`
      )
    );
    L.assert(out.auditCount === 2, "Both decisions audit the actual authenticated owner");
    out.pageErrors = ev.pageErrors;
    L.assert(out.pageErrors.length === 0, "Recovery UI has no page errors");
    L.finish("J17-R1-delivery-recovery", out);
  } finally {
    for (const browser of browsers.reverse()) await browser.close();
  }
})().catch((error) => {
  console.error("ERR", error.message);
  process.exitCode = 1;
});
