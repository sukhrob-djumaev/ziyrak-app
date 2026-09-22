const L = require("./lib.cjs"); const creds = require("./creds.json"); const fs = require("fs");
const SITE = { A: "http://localhost:4020", B: "http://localhost:4021" };
(async () => {
  const out = {};
  for (const key of ["A", "B"]) {
    const c = creds[key];
    const b = await L.launch(c.profile); const p = await b.newPage(); await p.setExtraHTTPHeaders({ "X-Forwarded-For": L.XFF[key] }); const ev = L.watch(p, "j5-" + key);
    await p.goto(L.BASE + "/channels", { waitUntil: "networkidle0" });
    await L.shot(p, `j5-${key}-channels-before`);
    const btns = await p.$$eval("button", (bs) => bs.map((b) => b.innerText.trim()).filter(Boolean));
    out[key] = { buttonsSeen: btns };
    // origin textarea must be filled BEFORE create? Type it if visible, then Create.
    const ta = await p.$("textarea[placeholder='https://www.example.com']");
    if (ta) await ta.type(SITE[key]);
    const created = btns.find((t) => /create|enable|set up|generate/i.test(t) && !/rotate/i.test(t) && /web|widget|chat|create|generate/i.test(t));
    out[key].createButton = created;
    await L.clickFirst(p, "button", created); await L.sleep(2000);
    const snippet = await p.$eval("pre", (e) => e.innerText).catch(() => null);
    out[key].snippet = snippet && snippet.replace(/data-token="[^"]+"/, 'data-token="<redacted-zy_pub_...>"');
    out[key].tokenPrefix = snippet && (snippet.match(/data-token="(zy_pub_)/) || [])[1];
    await L.shot(p, `j5-${key}-created`);
    if (snippet) {
      fs.writeFileSync(L.SP + `/snippet-${key}.html`, snippet);
      // the business's own website (its own origin) embedding exactly the snippet the product issued
      fs.mkdirSync(L.SP + "/pages", { recursive: true });
      const port = key === "A" ? 4020 : 4021;
      fs.writeFileSync(L.SP + `/pages/${port}.html`, `<!doctype html><html><head><title>${c.biz} (customer website)</title></head><body><h1>${c.biz}</h1>\n${snippet}\n</body></html>`);
    }
    // Persist origins (button "Save origins") in case the create form did not take them
    const list = await p.evaluate(async () => (await (await fetch("/api/channels/webchat-connections")).json()));
    out[key].apiList = JSON.parse(JSON.stringify(list).replace(/zy_pub_[A-Za-z0-9_-]+/g, "zy_pub_<redacted>"));
    out[key].console = [...new Set(ev.consoleErrors)];
    await b.close();

    L.assert(!!out[key].snippet, `${key}: a widget snippet was issued`);
    L.assert(out[key].tokenPrefix === "zy_pub_", `${key}: the issued token is a zy_pub_ public token, got ${out[key].tokenPrefix}`);
    L.assert(Array.isArray(out[key].apiList.data) && out[key].apiList.data.length >= 1, `${key}: the connection is listed via the API`);
    L.assert(out[key].apiList.data[0] && out[key].apiList.data[0].isActive !== false, `${key}: the connection is active`);
    L.assert(out[key].console.length === 0, `${key}: no console errors while setting up Web Chat, got ${JSON.stringify(out[key].console)}`);
  }
  L.finish("J05", out);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
