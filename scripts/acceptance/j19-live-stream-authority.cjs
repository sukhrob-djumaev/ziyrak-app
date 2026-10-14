// P1 real Redis/web/worker SSE evidence. Public widget token rotation and
// owner sign-out use the actual UI; an extra stale subscription is an API probe.
const L = require("./lib.cjs");
async function observeStreams(page) {
  await page.evaluateOnNewDocument(() => {
    window.__streamProbe = { opened: [], events: [] };
    const Original = window.EventSource;
    window.EventSource = class extends Original {
      constructor(url, options) {
        super(url, options);
        const u = new URL(url, location.href);
        window.__streamProbe.opened.push({
          widget: u.pathname.endsWith("/stream"),
          visitor: u.searchParams.has("visitorId"),
          dashboard: u.pathname === "/api/realtime",
        });
        this.addEventListener("message", (frame) => {
          try {
            const e = JSON.parse(frame.data);
            window.__streamProbe.events.push(e);
            if (window.__streamProbe.events.length > 100) window.__streamProbe.events.shift();
          } catch {
            /* heartbeat */
          }
        });
      }
    };
  });
}
(async () => {
  if (!process.env.REDIS_URL) throw Error("J19 requires the isolated Redis/web/worker topology");
  const out = {
    topology: "isolated production web + standalone worker + task Redis + real PG + stand-in AI",
    provider: "local stand-in; no real delivery/model-quality claim",
  };
  const browsers = [];
  try {
    const visitorBrowser = await L.launch("p1-live-widget");
    browsers.push(visitorBrowser);
    const visitor = await (await visitorBrowser.createBrowserContext()).newPage();
    await observeStreams(visitor);
    await visitor.goto("http://localhost:4020/", { waitUntil: "load" });
    await visitor.waitForSelector("#ziyrak-input");
    const first = await L.widgetSend(visitor, "What is your verification code?");
    L.assert(
      first.ack?.status === 200 && !!first.reply,
      "Widget has a real persisted conversation before live SSE checks"
    );
    await visitor.reload({ waitUntil: "load" });
    await visitor.waitForSelector("#ziyrak-input");
    await visitor.waitForFunction(() =>
      window.__streamProbe.events.some((e) => e.type === "connected")
    );
    out.widgetVisitorBound = await visitor.evaluate(() =>
      window.__streamProbe.opened.some((s) => s.widget && s.visitor)
    );
    L.assert(out.widgetVisitorBound, "Actual widget stream carries visitorId");

    const ownerBrowser = await L.launch("biz-a");
    browsers.push(ownerBrowser);
    const owner = await ownerBrowser.newPage();
    await observeStreams(owner);
    await owner.goto(L.BASE + "/channels", { waitUntil: "networkidle0" });
    await owner.waitForSelector("#webchat-origins");
    await owner.waitForFunction(() =>
      window.__streamProbe.events.some((e) => e.type === "connected")
    );
    const second = await L.widgetSend(visitor, "Thanks. What is your verification code?");
    L.assert(second.ack?.status === 200 && !!second.reply, "Second reply appears in actual widget");
    await visitor.waitForFunction(() =>
      window.__streamProbe.events.some(
        (e) => e.type === "message:new" && e.data?.role === "assistant"
      )
    );
    const frame = await visitor.evaluate(() =>
      window.__streamProbe.events.find(
        (e) => e.type === "message:new" && e.data?.role === "assistant"
      )
    );
    out.persistedWidgetFrame = {
      type: frame.type,
      role: frame.data.role,
      fields: Object.keys(frame.data),
      matchesVisible: frame.data.content === second.reply,
    };
    L.assert(
      out.persistedWidgetFrame.matchesVisible,
      "Worker reply arrives as SSE and matches visible persisted reply"
    );
    L.assert(
      out.persistedWidgetFrame.fields.every((key) =>
        ["id", "role", "content", "createdAt"].includes(key)
      ),
      "Widget SSE exposes only public persisted fields"
    );
    await owner.waitForFunction(() =>
      window.__streamProbe.events.some((e) => e.type === "message:new")
    );
    out.dashboardFrame = await owner.evaluate(() => {
      const e = window.__streamProbe.events.find((e) => e.type === "message:new");
      return { type: e.type, fields: Object.keys(e.data) };
    });
    L.assert(
      out.dashboardFrame.fields.every((key) =>
        ["conversationId", "messageId", "role"].includes(key)
      ),
      "Dashboard worker event is a minimal scoped hint"
    );

    // Actual token-rotation UI; the open visitor stream retains the old token.
    owner.once("dialog", (dialog) => {
      if (
        dialog.type() === "confirm" &&
        dialog.message().startsWith("Rotating the token immediately stops every site")
      )
        return dialog.accept();
      return dialog.dismiss();
    });
    const [rotated] = await Promise.all([
      owner.waitForResponse(
        (r) => r.request().method() === "POST" && r.url().includes("/rotate-token")
      ),
      L.clickFirst(owner, "button", "Rotate token"),
    ]);
    out.rotationStatus = rotated.status();
    L.assert(out.rotationStatus === 200, "Token rotation succeeded through the actual UI");
    await visitor.waitForFunction(
      () => window.__streamProbe.events.some((e) => e.type === "session_ended"),
      { timeout: 40_000 }
    );
    out.widgetEndedAfterRotation = true;
    // API probe retained independently of the dashboard hook's normal logout cleanup.
    await owner.evaluate(() => {
      window.__heldStream = new EventSource("/api/realtime?channel=global");
    });
    await owner.waitForFunction(
      () => window.__streamProbe.events.filter((e) => e.type === "connected").length >= 2
    );
    await owner.click('header button[aria-label^="Account menu"]');
    await L.clickFirst(owner, "button", "Sign Out");
    await owner.waitForFunction(() => location.pathname === "/login");
    await owner.waitForFunction(
      () => window.__streamProbe.events.some((e) => e.type === "session_ended"),
      { timeout: 40_000 }
    );
    out.staleDashboardEndedAfterUiLogout = true;
    L.finish("J19-P1-live-stream-authority", out);
  } finally {
    for (const browser of browsers) await browser.close();
  }
})().catch((error) => {
  console.error("ERR", error);
  process.exitCode = 1;
});
