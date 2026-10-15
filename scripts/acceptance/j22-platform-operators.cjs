// After J20: actual super-admin UI provisioning and assignment lifecycle.
// Synthetic account only; support activation deliberately remains unavailable.
const L = require("./lib.cjs");
const creds = require("./creds.json");
const { randomUUID } = require("node:crypto");
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const suffix = randomUUID().slice(0, 8);
const username = "support_operator_" + suffix;
const password = "Synthetic-operator-" + randomUUID();
async function post(page, payload) {
  return page.evaluate(
    async (payload) =>
      (
        await fetch("/api/platform/operators", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      ).status,
    payload
  );
}
async function clickMutation(page, selector, label) {
  const pending = page.waitForResponse(
    (r) => r.url().endsWith("/api/platform/operators") && r.request().method() === "POST"
  );
  await page.click(selector);
  const response = await pending;
  L.assert(response.status() === 200, label + " returned 200");
  const body = await response.json();
  L.assert(body.success === true, label + " succeeded");
  return body.result;
}
(async () => {
  const browsers = [];
  try {
    const b = await L.launch(creds.B.profile);
    browsers.push(b);
    const page = await b.newPage(),
      errors = L.watch(page, "j22-super");
    await page.goto(L.BASE + "/platform/operators", { waitUntil: "networkidle0" });
    await page.waitForSelector("#operatorUsername");
    L.assert(
      (await L.text(page)).includes("Customer workspace access will be available"),
      "UI states support access is unavailable"
    );
    await page.type("#operatorUsername", username);
    await page.type("#operatorName", "Synthetic support operator");
    await page.type("#operatorPassword", password);
    await page.type("#provisionReason", "Synthetic UI operator provisioning");
    const user = await clickMutation(page, "#createOperator", "Operator creation");
    L.assert(
      user.username === username && user.platformRole === "operator" && !("password" in user),
      "Creation returns only expected operator metadata"
    );
    await page.waitForFunction(() => document.querySelector("#operatorPassword")?.value === "");
    await page.waitForSelector(`[data-operator="${user.id}"]`);
    L.assert(
      L.sql('SELECT count(*) FROM "Membership" WHERE "userId"=' + quote(user.id)) === "0",
      "Operator receives no workspace membership"
    );
    const metadata = await page.evaluate(async () =>
      (await fetch("/api/platform/operators")).json()
    );
    const workspace = metadata.workspaces.find((w) => w.name === creds.A.biz);
    L.assert(
      workspace && workspace.channelConnections.length > 0,
      "Real A workspace and connections are selectable"
    );
    const connection = workspace.channelConnections[0];
    await page.select("#assignedOperator", user.id);
    await page.select("#assignedWorkspace", workspace.id);
    await page.click('[data-operation="conversations:read"]');
    await page.click('[data-operation="messages:read"]');
    await page.click(`[data-connection="${connection.id}"]`);
    await page.type("#assignmentReason", "Synthetic scoped UI assignment");
    const assignment = await clickMutation(page, "#createAssignment", "Named assignment");
    L.assert(
      assignment.businessId === workspace.id &&
        assignment.operatorUserId === user.id &&
        assignment.scopeMode === "connections",
      "Assignment binds the exact actor and workspace"
    );
    L.assert(
      assignment.connectionScopes.length === 1 &&
        assignment.connectionScopes[0].connectionId === connection.id,
      "Assignment contains exactly the selected connection"
    );
    L.assert(
      JSON.stringify(assignment.allowedOperations) ===
        JSON.stringify(["conversations:read", "messages:read"]) &&
        assignment.customerProfileAccess === "none",
      "Assignment persists exactly the selected operations and denies shared profiles"
    );
    await page.waitForSelector(`[data-assignment="${assignment.id}"]`);
    L.assert(
      L.sql('SELECT count(*) FROM "SupportGrant" WHERE "actorUserId"=' + quote(user.id)) === "0",
      "Assignment creates no implicit support grant"
    );
    const operatorBrowser = await L.launch("j22-operator-" + suffix);
    browsers.push(operatorBrowser);
    const operator = await operatorBrowser.newPage(),
      operatorErrors = L.watch(operator, "j22-operator");
    await operator.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.222" });
    await operator.goto(L.BASE + "/login", { waitUntil: "networkidle0" });
    await operator.type("#username", username);
    await operator.type("#password", password);
    await Promise.all([
      operator.waitForNavigation({ waitUntil: "networkidle0" }),
      operator.click('button[type="submit"]'),
    ]);
    const entry = await operator.evaluate(async () =>
      (await fetch("/api/platform/enrollment")).json()
    );
    L.assert(
      entry.role === "operator" && entry.account.id === user.id,
      "New operator signs in using its actual provisioned credential"
    );
    await operator.goto(L.BASE + "/platform/operators", { waitUntil: "networkidle0" });
    await operator.waitForFunction(() => document.body.innerText.includes("Access denied."));
    L.assert(
      !(await operator.$("#createOperator")) && !(await operator.$("#createAssignment")),
      "Denied management page exposes no provisioning or assignment form"
    );
    const denied = await post(operator, {
      action: "assign",
      operatorUserId: user.id,
      businessId: workspace.id,
      allowedOperations: ["conversations:read"],
      scope: { kind: "workspace", customerProfileAccess: "none" },
      reason: "Synthetic self escalation attempt",
    });
    L.assert(denied === 403, "Operator cannot self-assign by direct API");
    L.assert(
      L.sql(
        'SELECT count(*) FROM "PlatformAssignment" WHERE "operatorUserId"=' + quote(user.id)
      ) === "1",
      "Denied self-assignment creates no extra assignment"
    );
    L.assert(
      L.sql('SELECT count(*) FROM "Membership" WHERE "userId"=' + quote(user.id)) === "0" &&
        L.sql('SELECT count(*) FROM "SupportGrant" WHERE "actorUserId"=' + quote(user.id)) === "0",
      "Denied self-assignment creates no membership or support grant"
    );
    const knownConversation = L.sql(
      'SELECT id FROM "Conversation" WHERE "businessId"=' +
        quote(workspace.id) +
        " ORDER BY id LIMIT 1"
    );
    L.assert(!!knownConversation, "Known customer conversation exists for no-bypass check");
    L.assert(
      (await operator.evaluate(
        async ({ id, workspaceId }) =>
          (await fetch("/api/conversations/" + id, { headers: { "x-workspace-id": workspaceId } }))
            .status,
        { id: knownConversation, workspaceId: workspace.id }
      )) === 403,
      "Assigned operator has no implicit customer data access"
    );
    const ordinaryBrowser = await L.launch(creds.A.profile);
    browsers.push(ordinaryBrowser);
    const ordinary = await ordinaryBrowser.newPage();
    await ordinary.goto(L.BASE + "/platform/operators", { waitUntil: "networkidle0" });
    await ordinary.waitForFunction(() => document.body.innerText.includes("Access denied."));
    L.assert(
      !(await ordinary.$("#operatorPassword")),
      "Workspace owner/displaced super cannot open management controls"
    );
    await page.type("#revocationReason", "Synthetic UI assignment revocation");
    await clickMutation(
      page,
      `[data-assignment="${assignment.id}"] button`,
      "Assignment revocation"
    );
    await page.waitForFunction(
      (id) => document.querySelector(`[data-assignment="${id}"]`)?.innerText.includes("Revoked"),
      {},
      assignment.id
    );
    L.assert(
      L.sql(
        'SELECT count(*) FROM "PlatformAssignment" WHERE id=' +
          quote(assignment.id) +
          ' AND "revokedAt" IS NOT NULL'
      ) === "1",
      "Assignment revocation persisted"
    );
    await page.type("#revocationReason", "Synthetic UI operator removal");
    await clickMutation(page, `[data-operator="${user.id}"] button`, "Operator removal");
    await page.waitForFunction(
      (id) => !document.querySelector(`[data-operator="${id}"]`),
      {},
      user.id
    );
    const removedEntry = await operator.evaluate(async () =>
      (await fetch("/api/platform/enrollment")).json()
    );
    L.assert(removedEntry.role === null, "Existing operator session observes authority removal");
    const audits = JSON.parse(
      L.sql(
        "SELECT coalesce(json_agg(action ORDER BY \"createdAt\"),'[]') FROM \"PlatformAccessAudit\" WHERE details->>'targetUserId'=" +
          quote(user.id) +
          " OR details->>'assignmentId'=" +
          quote(assignment.id)
      )
    );
    for (const action of [
      "operator.provision",
      "assignment.create",
      "assignment.revoke",
      "operator.remove",
    ])
      L.assert(audits.includes(action), "Mandatory audit persisted for " + action);
    const actualSuperId = L.sql('SELECT id FROM "User" WHERE username=' + quote(creds.B.user));
    for (const [action, expectedReason] of [
      ["operator.provision", "Synthetic UI operator provisioning"],
      ["assignment.create", "Synthetic scoped UI assignment"],
      ["assignment.revoke", "Synthetic UI assignment revocation"],
      ["operator.remove", "Synthetic UI operator removal"],
    ]) {
      const reference = action.startsWith("assignment.")
        ? "details->>'assignmentId'=" +
          quote(assignment.id) +
          ' AND "workspaceId"=' +
          quote(workspace.id) +
          ' AND "businessId"=' +
          quote(workspace.id)
        : "details->>'targetUserId'=" + quote(user.id);
      L.assert(
        L.sql(
          'SELECT count(*) FROM "PlatformAccessAudit" WHERE action=' +
            quote(action) +
            ' AND "actorUserId"=' +
            quote(actualSuperId) +
            " AND reason=" +
            quote(expectedReason) +
            " AND " +
            reference
        ) === "1",
        "Audit binds real super actor, exact target and reason for " + action
      );
    }
    await L.shot(page, "j22-operator-removed");
    await L.shot(operator, "j22-operator-denied");
    L.assert(
      errors.pageErrors.length === 0 && operatorErrors.pageErrors.length === 0,
      "No browser runtime errors"
    );
    L.finish("J22", {
      operatorId: user.id,
      assignmentId: assignment.id,
      workspaceId: workspace.id,
      connectionId: connection.id,
      checks:
        "real UI create/login/assign/revoke/remove, self-escalation denial, no implicit customer access, mandatory audits",
      limitations: "synthetic account; support-grant flow remains unavailable",
    });
  } finally {
    for (const b of browsers.reverse()) await b.close();
  }
})().catch((error) => {
  console.error("ERR", error.message);
  process.exitCode = 1;
});
