const L = require("./lib.cjs"); const creds = require("./creds.json");
const K = {
  A: { cat: "Store Info", title: "Reference and verification code", content: "Northwind Bakery customer reference. Our verification code is ZIYRAK-A-CODE-731. We are open 7am to 7pm every day and bake sourdough fresh each morning." },
  B: { cat: "Rental Info", title: "Reference and verification code", content: "Volt Electric Scooters customer reference. Our verification code is ZIYRAK-B-CODE-284. Rentals start at 5 dollars per hour and a 50 dollar deposit is required." },
};
(async () => {
  const out = {};
  for (const key of ["A", "B"]) {
    const c = creds[key]; const k = K[key];
    const b = await L.launch(c.profile); const p = await b.newPage(); await p.setExtraHTTPHeaders({ "X-Forwarded-For": L.XFF[key] }); const ev = L.watch(p, "j4-" + key);
    await p.goto(L.BASE + "/knowledge", { waitUntil: "networkidle0" });
    if (!(await L.text(p)).includes(k.cat)) {
      await L.clickFirst(p, "button", "Create Category").catch(async () => { await L.clickFirst(p, "button", "Add"); }); await L.sleep(300);
      await p.type("input[placeholder^='e.g. Product FAQ']", k.cat);
      await L.clickLast(p, "button", "Create Category"); await L.sleep(1200);
    }
    await p.evaluate((name) => { const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.innerText || "").trim() === name); el.click(); }, k.cat); await L.sleep(500);
    await L.clickFirst(p, "button", "Add Entry"); await L.sleep(400);
    await p.type("input[placeholder^='e.g. How to reset password']", k.title);
    await p.type("textarea[placeholder^='Write the knowledge content']", k.content);
    await L.shot(p, `j4-${key}-entry-form`);
    await L.clickLast(p, "button", "Create Entry"); await L.sleep(1500);
    await L.shot(p, `j4-${key}-after`);
    const entries = await p.evaluate(async () => (await (await fetch("/api/knowledge/entries")).json()).data.map((e) => ({ title: e.title, hasCode: /ZIYRAK-[AB]-CODE-\d+/.exec(e.content)?.[0], embeddingStored: !!(e.metadata && e.metadata.embedding) })));
    out[key] = { entries, apiWrites: ev.requests.filter((r) => r.m === "POST" && r.u.startsWith("/api/knowledge")).map((r) => `${r.m} ${r.s} ${r.u}`), consoleErrors: [...new Set(ev.consoleErrors)] };
    await b.close();
  }
  console.log(JSON.stringify(out, null, 1)); L.log({ journey: 4, phase: "knowledge-created-via-UI", ...out });
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
