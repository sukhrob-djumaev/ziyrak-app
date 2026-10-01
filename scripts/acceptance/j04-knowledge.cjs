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
    // The create request only enqueues indexing; the separate worker process embeds the entry.
    // Poll the entries API (the surface the dashboard itself reads) until the worker has stored it.
    let entries = [];
    for (let i = 0; i < 40; i++) {
      entries = await p.evaluate(async () => (await (await fetch("/api/knowledge/entries")).json()).data.map((e) => ({ id: e.id, title: e.title, hasCode: /ZIYRAK-[AB]-CODE-\d+/.exec(e.content)?.[0], rawVectorInApi: !!(e.metadata && e.metadata.embedding), embeddingIndex: (e.metadata && e.metadata.embeddingIndex) || null })));
      const mine = entries.find((e) => e.title === k.title);
      if (mine && mine.embeddingIndex) break;
      await L.sleep(500);
    }
    out[key] = { entries, apiWrites: ev.requests.filter((r) => r.m === "POST" && r.u.startsWith("/api/knowledge")).map((r) => `${r.m} ${r.s} ${r.u}`), consoleErrors: [...new Set(ev.consoleErrors)] };
    await b.close();
    const indexed = out[key].entries.find((e) => e.title === k.title);
    if (indexed) {
      out[key].db = L.sql(`SELECT jsonb_array_length(metadata->'embedding'), metadata->'embeddingIndex'->>'provider', metadata->'embeddingIndex'->>'dimensions' FROM "KnowledgeEntry" WHERE id = '${indexed.id}';`);
      out[key].job = L.sql(`SELECT state FROM pgboss.job WHERE name = 'index-knowledge-entry' AND data->>'entryId' = '${indexed.id}' ORDER BY created_on DESC LIMIT 1;`);
    }

    const own = out[key].entries.find((e) => e.title === k.title);
    L.assert(!!own, `${key}: the entry created through the UI is readable back via the API`);
    L.assert(own && own.hasCode === (key === "A" ? "ZIYRAK-A-CODE-731" : "ZIYRAK-B-CODE-284"), `${key}: entry carries its own business's code, got ${own && own.hasCode}`);
    L.assert(out[key].apiWrites.some((w) => w.startsWith("POST 201 /api/knowledge/entries")), `${key}: creating the entry returned 201, got ${JSON.stringify(out[key].apiWrites)}`);
    L.assert(out[key].consoleErrors.length === 0, `${key}: no console errors while managing knowledge, got ${JSON.stringify(out[key].consoleErrors)}`);
    L.assert(own && own.embeddingIndex && own.embeddingIndex.dimensions === 1536, `${key}: the worker indexed the entry (embeddingIndex present, 1536-d), got ${JSON.stringify(own && own.embeddingIndex)}`);
    L.assert(out[key].entries.every((e) => !e.rawVectorInApi), `${key}: the entries API never ships raw vectors`);
    L.assert(out[key].job === "completed", `${key}: the entry's index-knowledge-entry pg-boss job completed, got ${JSON.stringify(out[key].job)}`);
    L.assert(/^1536 \| openai \| 1536$/.test(out[key].db || ""), `${key}: Postgres holds a 1536-d embedding from the business's own provider, got ${JSON.stringify(out[key].db)}`);
  }
  L.assert(!out.A.entries.some((e) => e.hasCode === "ZIYRAK-B-CODE-284"), `A's entries never contain B's code`);
  L.assert(!out.B.entries.some((e) => e.hasCode === "ZIYRAK-A-CODE-731"), `B's entries never contain A's code`);
  L.finish("J04", out);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
