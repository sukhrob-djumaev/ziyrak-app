// After J20: actual super-admin UI provisioning and assignment lifecycle.
// Synthetic accounts/data only; explicit grant permits only the scalar list profile.
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
async function clickMutation(page, selector, label, endpoint = "/api/platform/operators") {
  const pending = page.waitForResponse(
    (r) => r.url().endsWith(endpoint) && r.request().method() === "POST"
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
      (await L.text(page)).includes("requires an explicit support grant"),
      "UI explains explicit support grant requirement"
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
    await operator.goto(L.BASE + "/platform/operators", { waitUntil: "load" });
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
    await operator.goto(L.BASE + "/platform/support", { waitUntil: "load" });
    await operator.waitForSelector("#supportTarget");
    await operator.select("#supportTarget", assignment.id);
    await operator.click('[data-operation="conversations:read"]');
    await operator.click('[data-operation="messages:read"]');
    await operator.click(`[data-connection="${connection.id}"]`);
    await operator.type("#supportReason", "Synthetic UI scoped support request");
    const submittedExpiry = await operator.$eval("#supportExpiry", (input) => {
      const date = new Date(Date.now() + 30 * 60_000);
      date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, date.toISOString().slice(0, 16));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return new Date(input.value).toISOString();
    });
    const grant = await clickMutation(
      operator,
      "#issueSupportGrant",
      "Support grant issuance",
      "/api/platform/support-grants"
    );
    L.assert(
      grant.actorUserId === user.id &&
        grant.businessId === workspace.id &&
        grant.assignmentId === assignment.id,
      "Explicit grant binds actual operator, exact workspace and assignment"
    );
    L.assert(
      grant.scopeMode === "connections" &&
        grant.connectionScopes.length === 1 &&
        grant.connectionScopes[0].connectionId === connection.id &&
        grant.customerProfileAccess === "none",
      "Explicit grant preserves selected connection and profile ceiling"
    );
    L.assert(
      JSON.stringify(grant.allowedOperations) ===
        JSON.stringify(["conversations:read", "messages:read"]),
      "Grant persists exactly selected operations"
    );
    L.assert(
      grant.expiresAt === submittedExpiry && Date.parse(grant.expiresAt) > Date.now(),
      "Grant persists the explicit future expiry"
    );
    await operator.waitForSelector(`[data-grant="${grant.id}"]`);
    L.assert(
      (await L.text(operator)).includes("limited conversation list"),
      "Grant management describes the bounded conversation view"
    );
    await L.shot(operator, "j22-support-grant-recorded");
    L.assert(
      (await operator.evaluate(
        async ({ id, businessId, grantId }) =>
          (
            await fetch("/api/conversations/" + id, {
              headers: { "x-workspace-id": businessId, "x-support-grant-id": grantId },
            })
          ).status,
        { id: knownConversation, businessId: workspace.id, grantId: grant.id }
      )) === 403,
      "Explicit scalar list grant does not permit conversation details"
    );
    // Controlled synthetic rows establish included/excluded resources and paging;
    // grants and all access actions use the actual product UI and handler.
    const prefix = "J22-list-" + suffix;
    const hiddenConnection = randomUUID();
    L.sql(
      'INSERT INTO "ChannelConnection" (id,"businessId",type,name,"updatedAt") VALUES (' +
        [hiddenConnection, workspace.id, connection.type, "Synthetic excluded support source"]
          .map(quote)
          .join(",") +
        ",now())"
    );
    const seedConversation = (businessId, source, name) => {
      const id = randomUUID();
      L.sql(
        'INSERT INTO "Conversation" (id,"businessId",channel,"customerName",summary,metadata,"updatedAt") VALUES (' +
          [
            id,
            businessId,
            connection.type,
            name,
            "Synthetic secret summary",
            JSON.stringify({ channelConnectionId: source, private: "Synthetic secret metadata" }),
          ]
            .map(quote)
            .join(",") +
          ",now())"
      );
      return id;
    };
    const included = Array.from({ length: 12 }, (_, i) =>
      seedConversation(workspace.id, connection.id, prefix + " included " + i)
    );
    const excludedId = seedConversation(workspace.id, hiddenConnection, prefix + " excluded");
    const foreignWorkspaceId = L.sql('SELECT id FROM "Business" WHERE name=' + quote(creds.B.biz));
    // Intentionally malformed cross-workspace metadata names the ALLOWED source:
    // absence must depend on business isolation rather than connection exclusion.
    const foreignId = seedConversation(foreignWorkspaceId, connection.id, prefix + " foreign");
    // Message rows: two text rows per included conversation plus private media/tool rows that
    // the text-only support view must never return; excluded/foreign parents hold private text.
    const seedMessage = (businessId, conversationId, role, content, seconds, extra = {}) =>
      L.sql(
        'INSERT INTO "Message" (id,"businessId","conversationId",role,content,"mediaType","mediaUrl","toolCalls","createdAt") VALUES (' +
          [randomUUID(), businessId, conversationId, role, content].map(quote).join(",") +
          "," +
          (extra.mediaType ? quote(extra.mediaType) : "NULL") +
          "," +
          (extra.mediaUrl ? quote(extra.mediaUrl) : "NULL") +
          "," +
          (extra.toolCalls ? quote(JSON.stringify(extra.toolCalls)) : "NULL") +
          ",now() - interval '" +
          seconds +
          " seconds')"
      );
    included.forEach((id, i) => {
      seedMessage(workspace.id, id, "customer", prefix + " text-a " + i, 30);
      seedMessage(workspace.id, id, "assistant", prefix + " text-b " + i, 20, {
        toolCalls: [{ name: "J22-private-tool-never-shown" }],
      });
      seedMessage(workspace.id, id, "customer", "J22-private-media-caption " + i, 10, {
        mediaType: "image",
        mediaUrl: "https://private-media.invalid/j22-" + i + ".png",
      });
    });
    seedMessage(workspace.id, excludedId, "customer", "J22-private-excluded-message", 5);
    seedMessage(foreignWorkspaceId, foreignId, "customer", "J22-private-foreign-message", 5);
    const messagesResponse = () =>
      operator.waitForResponse(
        (r) =>
          /^\/api\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) &&
          r.request().headers()["x-support-grant-id"] === grant.id
      );
    const listResponse = () =>
      operator.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/conversations" &&
          r.request().headers()["x-support-grant-id"] === grant.id
      );
    const waitForRows = (ids) =>
      operator.waitForFunction(
        (ids) =>
          JSON.stringify(
            [...document.querySelectorAll("[data-support-conversation]")]
              .map((el) => el.dataset.supportConversation)
              .sort()
          ) === JSON.stringify([...ids].sort()),
        {},
        ids
      );
    // Controlled stale cookie exercises an explicit user-visible resolution;
    // it is a selection locator, never a membership or authority substitute.
    await operator.browserContext().setCookie({
      name: "ziyrak-workspace",
      value: foreignWorkspaceId,
      url: L.BASE,
      httpOnly: true,
      sameSite: "Lax",
    });
    let responsePending = listResponse();
    await operator.click(`[data-grant="${grant.id}"] [data-action="view-support-list"]`);
    L.assert(
      (await responsePending).status() === 403,
      "Conflicting workspace selection denies support list"
    );
    await operator.waitForFunction(() =>
      document
        .querySelector("#limitedSupportList")
        ?.innerText.includes("Clear workspace selection and retry")
    );
    L.assert(
      (await operator.$$eval("[data-support-conversation]", (rows) => rows.length)) === 0,
      "Conflict exposes no cached rows"
    );
    responsePending = listResponse();
    await operator.evaluate(() =>
      [...document.querySelectorAll("#limitedSupportList button")]
        .find((b) => b.textContent === "Clear workspace selection and retry")
        .click()
    );
    const initialList = await responsePending;
    L.assert(initialList.status() === 200, "Explicit clear selection and retry succeeds");
    const initialBody = await initialList.json();
    L.assert(
      initialBody.data.every(
        (row) =>
          Object.keys(row).sort().join(",") ===
          [
            "id",
            "businessId",
            "channel",
            "customerName",
            "customerContact",
            "status",
            "createdAt",
            "updatedAt",
          ]
            .sort()
            .join(",")
      ),
      "Actual support route returns only scalar profile"
    );
    L.assert(
      !JSON.stringify(initialBody).includes("Synthetic secret"),
      "No summary or metadata in actual list response"
    );
    await waitForRows(initialBody.data.map((row) => row.id));
    L.assert(
      (await operator.$$eval("#limitedSupportList a", (rows) => rows.length)) === 0,
      "Limited list has no detail links"
    );
    await operator.type("#supportListSearch", prefix);
    responsePending = listResponse();
    await operator.evaluate(() =>
      document.querySelector("#limitedSupportList form").requestSubmit()
    );
    const searched = await (await responsePending).json();
    await waitForRows(searched.data.map((row) => row.id));
    L.assert(
      searched.pagination.total === 12 && searched.data.length === 10,
      "UI search/count/paging include exactly the twelve scoped conversations"
    );
    L.assert(
      searched.data.every((row) => included.includes(row.id)) &&
        !JSON.stringify(searched).includes(excludedId) &&
        !JSON.stringify(searched).includes(foreignId),
      "Same-type excluded and foreign conversation hidden"
    );
    await operator.waitForFunction(() =>
      document.querySelector("#limitedSupportList")?.innerText.includes("12 conversations")
    );
    responsePending = listResponse();
    await operator.evaluate(() =>
      [...document.querySelectorAll("#limitedSupportList button")]
        .find((b) => b.textContent === "Next page")
        .click()
    );
    const nextPage = await (await responsePending).json();
    await waitForRows(nextPage.data.map((row) => row.id));
    L.assert(
      nextPage.pagination.page === 2 && nextPage.data.length === 2,
      "UI next page returns remaining scoped rows"
    );
    const allPageIds = [...searched.data, ...nextPage.data].map((row) => row.id);
    L.assert(
      new Set(allPageIds).size === 12 &&
        JSON.stringify(allPageIds.sort()) === JSON.stringify([...included].sort()),
      "Both rendered pages contain each included conversation exactly once"
    );
    await operator.waitForFunction(() =>
      document.querySelector("#limitedSupportList")?.innerText.includes("Page 2 of 2")
    );
    await operator.$eval("#limitedSupportList", (el) => el.scrollIntoView({ block: "start" }));
    await L.shot(operator, "j22-support-limited-list");
    // Text-only message view through the actual console for one listed conversation.
    const openMessages = async () => {
      const pending = messagesResponse();
      await operator.evaluate(() =>
        document.querySelector("[data-support-conversation] button").click()
      );
      return pending;
    };
    const firstMessages = await openMessages();
    L.assert(firstMessages.status() === 200, "Actual console opens the text-message view");
    const firstBody = await firstMessages.json();
    L.assert(
      firstMessages.headers()["cache-control"]?.includes("no-store") &&
        firstBody.pagination.total === 2 &&
        firstBody.data.length === 2 &&
        firstBody.data.every(
          (row) => Object.keys(row).sort().join(",") === "content,conversationId,createdAt,id,role"
        ),
      "Message route returns only the two scalar text rows with no-store"
    );
    L.assert(
      !/J22-private|private-media|toolCalls|mediaUrl/.test(JSON.stringify(firstBody)),
      "No media, tool-call or foreign/excluded text in the actual message response"
    );
    await operator.waitForFunction(
      () => document.querySelectorAll("#limitedSupportMessages [data-support-message]").length === 2
    );
    L.assert(
      !/J22-private/.test(await operator.$eval("#limitedSupportMessages", (el) => el.innerText)) &&
        (await operator.$$eval("#limitedSupportMessages a", (rows) => rows.length)) === 0,
      "Rendered message view shows text only with no links"
    );
    await operator.$eval("#limitedSupportMessages", (el) => el.scrollIntoView({ block: "start" }));
    await L.shot(operator, "j22-support-text-messages");
    // Direct probes with the same real grant: excluded/foreign/missing parents are one 404;
    // notes, detail and send stay unavailable.
    const probes = await operator.evaluate(
      async ({ grantId, businessId, ids }) => {
        const headers = { "x-workspace-id": businessId, "x-support-grant-id": grantId };
        const get = async (path) => {
          const r = await fetch(path, { headers, cache: "no-store" });
          return { status: r.status, body: await r.text() };
        };
        const out = { parents: [] };
        for (const id of ids) out.parents.push(await get("/api/conversations/" + id + "/messages"));
        out.notes = (await get("/api/conversations/" + ids[0] + "/notes")).status;
        out.detail = (await get("/api/conversations/" + ids[0])).status;
        out.send = (
          await fetch("/api/conversations/" + ids[0] + "/messages", {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ content: "Synthetic support send attempt", role: "assistant" }),
          })
        ).status;
        return out;
      },
      {
        grantId: grant.id,
        businessId: workspace.id,
        ids: [excludedId, foreignId, "00000000-0000-4000-8000-000000000000"],
      }
    );
    L.assert(
      probes.parents.every((p) => p.status === 404) &&
        new Set(probes.parents.map((p) => p.body)).size === 1 &&
        !/J22-private/.test(probes.parents[0].body),
      "Excluded, foreign and missing parents return one identical 404"
    );
    L.assert(
      probes.notes === 403 && probes.detail === 403 && probes.send === 403,
      "Notes, detail and message send remain denied to support"
    );
    L.assert(
      L.sql(
        'SELECT count(*) FROM "Message" WHERE content=' + quote("Synthetic support send attempt")
      ) === "0",
      "Denied support send persisted nothing"
    );
    await operator.evaluate(() =>
      [...document.querySelectorAll("#limitedSupportMessages button")]
        .find((b) => b.textContent === "Close messages")
        .click()
    );
    await operator.waitForFunction(() => !document.querySelector("#limitedSupportMessages"));
    await operator.evaluate(() =>
      [...document.querySelectorAll("#limitedSupportList button")]
        .find((b) => b.textContent === "Close list")
        .click()
    );
    await operator.waitForFunction(() => !document.querySelector("#limitedSupportList"));
    responsePending = listResponse();
    await operator.click(`[data-grant="${grant.id}"] [data-action="view-support-list"]`);
    L.assert((await responsePending).status() === 200, "Explicit reopen rechecks support grant");
    await operator.waitForSelector("[data-support-conversation]");
    await openMessages();
    await operator.waitForSelector("#limitedSupportMessages [data-support-message]");
    // A second real signed-in tab revokes while the first tab retains the view.
    // The actual Refresh action must discard previously displayed rows/count.
    const revokeTab = await operatorBrowser.newPage();
    await revokeTab.goto(L.BASE + "/platform/support", { waitUntil: "load" });
    await revokeTab.waitForSelector(`[data-grant="${grant.id}"]`);
    await revokeTab.type("#supportRevokeReason", "Synthetic UI support grant end");
    await clickMutation(
      revokeTab,
      `[data-grant="${grant.id}"] [data-action="revoke-support-grant"]`,
      "Second-tab support grant revocation",
      "/api/platform/support-grants"
    );
    // The second tab hides this one; a hidden tab pauses requestAnimationFrame, which the
    // alert waits below poll on. Bring the observing tab back before it acts.
    await operator.bringToFront();
    const revokedMessages = messagesResponse();
    await operator.evaluate(() =>
      [...document.querySelectorAll("#limitedSupportMessages button")]
        .find((b) => b.textContent === "Refresh messages")
        .click()
    );
    L.assert((await revokedMessages).status() === 403, "Message refresh observes revoked grant");
    await operator.waitForFunction(() =>
      document.querySelector('#limitedSupportMessages [role="alert"]')
    );
    L.assert(
      (await operator.$$eval("[data-support-message]", (rows) => rows.length)) === 0 &&
        !(await operator.$eval("#limitedSupportMessages", (el) => el.innerText)).includes(
          "text messages ·"
        ),
      "Revoked message refresh clears previously displayed messages and count"
    );
    await operator.$eval("#limitedSupportMessages", (el) => el.scrollIntoView({ block: "start" }));
    await L.shot(operator, "j22-support-messages-revoked");
    responsePending = listResponse();
    await operator.evaluate(() =>
      [...document.querySelectorAll("#limitedSupportList button")]
        .find((b) => b.textContent === "Refresh list")
        .click()
    );
    L.assert((await responsePending).status() === 403, "Refresh observes revoked grant");
    await operator.waitForFunction(() =>
      document.querySelector('#limitedSupportList [role="alert"]')
    );
    L.assert(
      (await operator.$$eval("[data-support-conversation]", (rows) => rows.length)) === 0,
      "Revoked refresh clears old rows"
    );
    L.assert(
      !(await operator.$eval("#limitedSupportList", (el) => el.innerText)).includes(
        "conversations · Page"
      ),
      "Revoked refresh clears old count"
    );
    await operator.$eval("#limitedSupportList", (el) => el.scrollIntoView({ block: "start" }));
    await L.shot(operator, "j22-support-list-revoked");
    await revokeTab.close();
    await operator.reload({ waitUntil: "load" });
    await operator.waitForSelector(`[data-grant="${grant.id}"]`);
    await operator.waitForFunction(
      (id) => document.querySelector(`[data-grant="${id}"]`)?.innerText.includes("Revoked"),
      {},
      grant.id
    );
    for (const [action, decision, minimum] of [
      ["support.authorize", "allowed", 8],
      ["support.deny", "denied", 1],
    ]) {
      const grantReference = '"grantId"=' + quote(grant.id) + " AND action=" + quote(action);
      const actualReference =
        '"actorUserId"=' +
        quote(user.id) +
        ' AND "workspaceId"=' +
        quote(workspace.id) +
        ' AND "businessId"=' +
        quote(workspace.id) +
        " AND reason=" +
        quote("Synthetic UI scoped support request") +
        " AND details->>'operation' IN ('conversations:read','messages:read') AND details->>'decision'=" +
        quote(decision);
      L.assert(
        Number(
          L.sql(
            'SELECT count(*) FROM "PlatformAccessAudit" WHERE ' +
              grantReference +
              " AND " +
              actualReference
          )
        ) >= minimum,
        "Read audit persists actual actor/workspace/grant/operation/reason for " + decision
      );
      L.assert(
        L.sql(
          'SELECT count(*) FROM "PlatformAccessAudit" WHERE ' +
            grantReference +
            " AND (" +
            actualReference +
            ") IS NOT TRUE"
        ) === "0",
        "No mismatched read audit for " + decision
      );
    }
    for (const [decision, minimum] of [
      ["allowed", 4],
      ["denied", 1],
    ])
      L.assert(
        Number(
          L.sql(
            'SELECT count(*) FROM "PlatformAccessAudit" WHERE "grantId"=' +
              quote(grant.id) +
              " AND action=" +
              quote(decision === "allowed" ? "support.authorize" : "support.deny") +
              ' AND "actorUserId"=' +
              quote(user.id) +
              " AND details->>'operation'='messages:read' AND details->>'decision'=" +
              quote(decision)
          )
        ) >= minimum,
        "Message read audit persists actual actor/grant/operation for " + decision
      );
    L.assert(
      L.sql(
        'SELECT count(*) FROM "SupportGrant" WHERE id=' +
          quote(grant.id) +
          ' AND "revokedAt" IS NOT NULL'
      ) === "1",
      "Grant revocation is persisted"
    );
    await L.shot(operator, "j22-support-grant-revoked");
    for (const [action, reason] of [
      ["support.issue", "Synthetic UI scoped support request"],
      ["support.revoke", "Synthetic UI support grant end"],
    ]) {
      L.assert(
        L.sql(
          'SELECT count(*) FROM "PlatformAccessAudit" WHERE action=' +
            quote(action) +
            ' AND "actorUserId"=' +
            quote(user.id) +
            ' AND "grantId"=' +
            quote(grant.id) +
            ' AND "workspaceId"=' +
            quote(workspace.id) +
            " AND reason=" +
            quote(reason)
        ) === "1",
        "Support audit binds real actor/workspace/grant/reason for " + action
      );
    }
    await operator.goto(L.BASE + "/platform/operators", { waitUntil: "load" });
    await operator.waitForFunction(() => document.body.innerText.includes("Access denied."));
    const ordinaryBrowser = await L.launch(creds.A.profile);
    browsers.push(ordinaryBrowser);
    const ordinary = await ordinaryBrowser.newPage();
    await ordinary.goto(L.BASE + "/platform/operators", { waitUntil: "load" });
    await ordinary.waitForFunction(() => document.body.innerText.includes("Access denied."));
    L.assert(
      !(await ordinary.$("#operatorPassword")),
      "Workspace owner/displaced super cannot open management controls"
    );
    await ordinary.goto(L.BASE + "/platform/support", { waitUntil: "load" });
    await ordinary.waitForFunction(() => document.body.innerText.includes("Access denied."));
    L.assert(
      !(await ordinary.$("#issueSupportGrant")),
      "Ordinary owner cannot open support grant controls"
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
        "real UI create/login/assign/revoke/remove; limited list conflict clear/search/rendered paging/close/reopen/revoked refresh; text-only message view, identical parent denial, notes/detail/send denial, revoked message refresh; scope isolation, no implicit/detail access, actual actor read and management audits",
      limitations:
        "synthetic accounts/data; audited limited scalar list and text-only message view only; no support detail/stream/job or real-provider claim",
    });
  } finally {
    for (const b of browsers.reverse()) await b.close();
  }
})().catch((error) => {
  console.error("ERR", error.message);
  process.exitCode = 1;
});
