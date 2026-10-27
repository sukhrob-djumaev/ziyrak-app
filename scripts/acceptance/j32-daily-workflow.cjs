// L3.2 daily workflow on the real UI: navigation grouped by work, keyboard entry (skip link, current page),
// phone-width menu, no offer of the inactive Keyword Alert, analytics response time from real customer messages,
// and honest failures: a list that cannot load says so (never "empty"), a refused save keeps the form and says why.
const L = require("./lib.cjs");
const creds = require("./creds.json");

(async () => {
  const browser = await L.launch(creds.A.profile);
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": "198.51.100.242" });

    // 1. Grouped navigation, labelled landmark, current page marked.
    await page.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
    L.assert(!page.url().includes("/login"), "Owner session is available");
    const titles = await page.$$eval('nav[aria-label="Main"] p', (p) => p.map((x) => x.textContent.trim().toLowerCase()));
    L.assert(
      JSON.stringify(titles) === JSON.stringify(["support", "teach the assistant", "set up", "insights", "workspace"]),
      `navigation groups follow the work (${titles.join(" | ")})`
    );
    const current = await page.$$eval('nav[aria-label="Main"] a[aria-current="page"]', (a) => a.map((x) => new URL(x.href).pathname));
    L.assert(current.length === 1 && current[0] === "/tickets", `exactly the open page is marked current (${current.join(",")})`);

    // 2. Keyboard: the first Tab stop is the skip link, and it moves focus to the main content.
    await page.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
    L.assert(first === "Skip to main content", `first Tab stop is the skip link (${first})`);
    await page.keyboard.press("Enter");
    L.assert((await page.evaluate(() => document.activeElement?.id)) === "main-content", "the skip link moves focus to the main content");
    for (const path of ["/tickets", "/customers", "/knowledge", "/analytics", "/automation"]) {
      await page.goto(L.BASE + path, { waitUntil: "networkidle0" });
      L.assert((await page.$$eval("h1", (h) => h.length)) === 1, `${path} has exactly one h1`);
    }

    // 3. Keyword Alert is not offered; the supported types are.
    await page.goto(L.BASE + "/automation", { waitUntil: "networkidle0" });
    await L.clickFirst(page, "button", "Add Rule");
    await page.waitForFunction(() => document.body.innerText.includes("Rule Type"));
    const offered = await page.$$eval(".fixed button", (b) => b.map((x) => x.innerText.trim()));
    L.assert(offered.includes("Auto Route") && offered.includes("Auto Tag") && offered.includes("Auto Reply"), "supported rule types are offered");
    L.assert(!offered.some((t) => /keyword alert/i.test(t)), "Keyword Alert cannot be chosen for a new rule");

    // 4. Analytics counts real customer messages (stored as role "customer") answered by the assistant.
    const api = await page.evaluate(async () => {
      const r = await fetch("/api/analytics?period=30d");
      return { status: r.status, body: await r.json() };
    });
    L.assert(api.status === 200 && api.body.responseTimeSamples >= 1, `response time is measured from stored customer messages (samples=${api.body.responseTimeSamples})`);
    await page.goto(L.BASE + "/analytics", { waitUntil: "networkidle0" });
    const card = await page.evaluate(() => document.body.innerText);
    L.assert(!/No replies yet/.test(card), "Analytics shows a response time, not 'No replies yet'");

    // 5. Honest failures. A list that cannot load says so; a refused write keeps the form and says why.
    await page.setRequestInterception(true);
    let failList = true;
    let failWrite = true;
    const fault = (r) => {
      const u = new URL(r.url());
      const fail = (status) => r.respond({ status, contentType: "application/json", body: JSON.stringify({}) });
      if (failList && r.method() === "GET" && (u.pathname === "/api/tickets" || u.pathname === "/api/business-hours")) fail(500);
      else if (failWrite && r.method() === "POST" && u.pathname === "/api/customers") fail(500);
      else r.continue();
    };
    page.on("request", fault);
    await page.goto(L.BASE + "/tickets", { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="load-failed"]');
    L.assert(!/No tickets/i.test(await page.evaluate(() => document.body.innerText)), "a ticket list that failed to load is not shown as empty");
    failList = false;
    await L.clickFirst(page, "button", "Try again");
    await page.waitForFunction(() => !document.querySelector('[data-testid="load-failed"]'));

    failList = true;
    await page.goto(L.BASE + "/business-hours", { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="load-failed"]');
    const saveButtons = await page.$$eval("button", (b) => b.filter((x) => /save/i.test(x.innerText)).length);
    L.assert(saveButtons === 0, "business hours that failed to load offer no Save (the default schedule would overwrite the real one)");
    failList = false;

    await page.goto(L.BASE + "/customers", { waitUntil: "networkidle0" });
    await L.clickFirst(page, "button", "Add Customer");
    await page.waitForSelector('input[placeholder="Customer name"]');
    await page.type('input[placeholder="Customer name"]', "Refused Person");
    await L.clickLast(page, "button", "Add Customer");
    await page.waitForFunction(() => /Adding the customer failed/i.test(document.body.innerText), { timeout: 10000 });
    L.assert((await page.$eval('input[placeholder="Customer name"]', (e) => e.value)) === "Refused Person", "refused customer save keeps the form open with the typed values");
    failWrite = false;
    page.off("request", fault);
    await page.setRequestInterception(false);

    // 6. Phone width: the sidebar is replaced by a menu button; the drawer opens, closes on Escape, and navigates.
    await page.setViewport({ width: 390, height: 800 });
    await page.goto(L.BASE + "/", { waitUntil: "networkidle0" });
    L.assert(await page.$eval("aside", (e) => getComputedStyle(e).display === "none"), "the desktop sidebar is hidden at phone width");
    for (const path of ["/", "/tickets", "/customers", "/analytics", "/knowledge"]) {
      await page.goto(L.BASE + path, { waitUntil: "networkidle0" });
      const wide = await page.evaluate(() => [...document.querySelectorAll("main *")].some((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== "fixed" && !e.closest("table, .overflow-auto, .overflow-x-auto, .overflow-y-auto")));
      L.assert(!wide, `${path}: nothing is clipped past the right edge at phone width`);
      L.assert(!!(await page.$('button[aria-label="Open menu"]')), `${path}: the menu button is available at phone width`);
    }
    await page.goto(L.BASE + "/", { waitUntil: "networkidle0" });
    await page.focus('button[aria-label="Open menu"]');
    await page.keyboard.press("Enter"); // keyboard opens it
    await page.waitForSelector('[data-testid="mobile-nav"] a');
    L.assert(await page.$eval('[data-testid="mobile-nav"] [role="dialog"]', (e) => e.getAttribute("aria-modal") === "true"), "the open menu is a modal dialog");
    // Tab stays inside the open menu.
    for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
    L.assert(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="mobile-nav"]')), "Tab stays inside the open menu");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[data-testid="mobile-nav"]'));
    L.assert(await page.evaluate(() => document.activeElement?.id === "open-menu"), "focus returns to the menu button after closing");
    await page.click('button[aria-label="Open menu"]');
    await page.waitForSelector('[data-testid="mobile-nav"] a[href="/tickets"]');
    await page.click('[data-testid="mobile-nav"] a[href="/tickets"]');
    await page.waitForFunction(() => location.pathname === "/tickets");
    await page.waitForFunction(() => !document.querySelector('[data-testid="mobile-nav"]'));
    L.assert(true, "choosing a page in the menu navigates and closes it");

    L.finish("J32-daily-workflow", { groups: titles.length });
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error("ERR", error.message);
  process.exitCode = 1;
});
