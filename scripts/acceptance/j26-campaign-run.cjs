// P1 campaign run acceptance. Real signed-in sessions, real Postgres/pg-boss worker. Campaign
// and member are created through the product API; customers and the webchat connection are
// controlled DB prerequisites. The webchat adapter's send is a documented no-op, so this proves
// admission, persistence and worker behavior, NOT provider delivery.
const L = require("./lib.cjs"),
  creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const suffix = randomUUID().slice(0, 8);
const call = (page, path, method, body) =>
  page.evaluate(
    async (path, method, body) => {
      const r = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    path,
    method,
    body
  );
(async () => {
  const browsers = [];
  try {
    const ownerBrowser = await L.launch(creds.A.profile);
    browsers.push(ownerBrowser);
    const owner = await ownerBrowser.newPage();
    const errors = L.watch(owner, "j26-owner");
    await owner.goto(L.BASE + "/admin", { waitUntil: "networkidle0" });
    const a = L.sql(
      'SELECT m."businessId" FROM "Membership" m JOIN "User" u ON u.id=m."userId" WHERE u.username=' +
        quote(creds.A.user) +
        " AND m.role='owner'"
    );
    L.assert(a, "Workspace exists");
    // Controlled prerequisites: an active webchat connection and two target customers.
    let connection = L.sql(
      'SELECT id FROM "ChannelConnection" WHERE "businessId"=' +
        quote(a) +
        " AND type='webchat' AND \"isActive\"=true ORDER BY id LIMIT 1"
    );
    if (!connection) {
      connection = randomUUID();
      L.sql(
        'INSERT INTO "ChannelConnection" (id,"businessId",type,name,"isActive","updatedAt") VALUES (' +
          [connection, a, "webchat", "J26 line " + suffix].map(quote).join(",") +
          ",true,now())"
      );
    }
    const customerIds = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      customerIds.push(id);
      L.sql(
        'INSERT INTO "Customer" (id,"businessId",name,phone,"updatedAt") VALUES (' +
          [id, a, `J26 customer ${suffix} ${i}`, `+1555${suffix.replace(/\D/g, "0")}${i}`]
            .map(quote)
            .join(",") +
          ",now())"
      );
    }
    const created = await call(owner, "/api/campaigns", "POST", {
      name: "J26 " + suffix,
      channel: "webchat",
      message: "J26 frozen offer " + suffix,
      segments: [{ field: "name", operator: "contains", value: `J26 customer ${suffix}` }],
    });
    L.assert(created.status === 201 || created.status === 200, "Owner creates the campaign");
    const campaignId = created.body?.id ?? created.body?.data?.id;
    L.assert(campaignId, "Campaign id returned");

    // A non-supervisor cannot start it.
    const agent = {
      username: `j26_agent_${suffix}`,
      password: "Synthetic-" + randomUUID(),
      name: `Synthetic J26 ${suffix}`,
    };
    const made = await L.createMember(owner, {
      name: agent.name,
      username: agent.username,
      password: agent.password,
      role: "agent",
    });
    L.assert(made.status === 201, "Owner provisions an agent through the product API");
    const agentBrowser = await L.launch("j26-agent-" + suffix);
    browsers.push(agentBrowser);
    const agentPage = await agentBrowser.newPage();
    const agentErrors = L.watch(agentPage, "j26-agent");
    await agentPage.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.252" });
    await agentPage.goto(L.BASE + "/login", { waitUntil: "load" });
    await agentPage.waitForSelector("#username");
    await agentPage.type("#username", agent.username);
    await agentPage.type("#password", agent.password);
    await Promise.all([
      agentPage.waitForNavigation({ waitUntil: "load" }),
      agentPage.click('button[type="submit"]'),
    ]);
    const denied = await call(agentPage, `/api/campaigns/${campaignId}/execute`, "POST");
    L.assert(denied.status === 403, "An agent cannot start a campaign");
    L.assert(
      L.sql('SELECT count(*) FROM "CampaignRun" WHERE "campaignId"=' + quote(campaignId)) === "0",
      "No run exists after the refused start"
    );

    // The owner starts it; the worker sends the frozen run once per recipient.
    const started = await call(owner, `/api/campaigns/${campaignId}/execute`, "POST");
    L.assert(
      started.status === 200 && started.body?.runId && started.body?.targetCount === 2,
      "Owner starts the run with two frozen targets"
    );
    const runId = started.body.runId;
    // Editing the campaign after the start must not change what is sent.
    await call(owner, `/api/campaigns/${campaignId}`, "PUT", { message: "EDITED after start" });
    let status = "";
    for (let i = 0; i < 60 && status !== "completed"; i++) {
      await L.sleep(1000);
      status = L.sql('SELECT status FROM "CampaignRun" WHERE id=' + quote(runId));
    }
    L.assert(status === "completed", "Worker completes the run");
    const ops = L.sql(
      'SELECT string_agg(status||\':\'||kind, \',\' ORDER BY "operationKey") FROM "DeliveryOperation" WHERE "campaignRunId"=' +
        quote(runId)
    );
    L.assert(
      ops === "accepted:campaign,accepted:campaign",
      "Both recipients have accepted campaign operations"
    );
    const keys = L.sql(
      'SELECT count(*) FROM "DeliveryOperation" WHERE "campaignRunId"=' +
        quote(runId) +
        ' AND "operationKey" LIKE ' +
        quote(`campaign:${runId}:%`)
    );
    L.assert(keys === "2", "Operation keys are campaign:<run>:<customer>");
    const sentText = L.sql(
      'SELECT string_agg(DISTINCT response, \'|\') FROM "DeliveryOperation" WHERE "campaignRunId"=' +
        quote(runId)
    );
    L.assert(
      sentText === "J26 frozen offer " + suffix,
      "The frozen message was sent, not the later edit"
    );
    L.assert(
      L.sql('SELECT "sentCount" FROM "Campaign" WHERE id=' + quote(campaignId)) === "2",
      "Campaign counts two accepted sends"
    );
    const convs = L.sql(
      'SELECT count(*) FROM "Conversation" WHERE "businessId"=' +
        quote(a) +
        " AND metadata->>'campaignRunId'=" +
        quote(runId)
    );
    L.assert(convs === "2", "One recipient conversation per target");
    const visible = await call(owner, "/api/conversations?limit=100", "GET");
    const seenNames = (visible.body?.data ?? []).map((c) => c.customerName);
    L.assert(
      customerIds.length === 2 &&
        seenNames.filter((n) => String(n).includes(`J26 customer ${suffix}`)).length === 2,
      "The owner sees both recipient conversations"
    );
    // A second start while nothing is active is a deliberate new run; a restart of the same run is not possible.
    L.assert(
      errors.pageErrors.length === 0 && agentErrors.pageErrors.length === 0,
      "No browser runtime exceptions"
    );
    L.finish("J26-campaign-run", {
      agentRefused: true,
      frozenMessageSentOncePerRecipient: true,
      limitations:
        "webchat send is a no-op; proves admission/persistence/worker, not provider delivery; no campaigns screen exists",
    });
  } finally {
    for (const browser of browsers.reverse()) await browser.close();
  }
})().catch((error) => {
  console.error("J26: " + error.message);
  process.exitCode = 1;
});
