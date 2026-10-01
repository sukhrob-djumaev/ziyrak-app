// J04b Semantic knowledge retrieval (stored entry embeddings, through the real UI + widget + worker).
// Runs LAST in run-all.sh so its extra knowledge never influences another journey's prompts.
//
// The owner creates a policy entry through /knowledge; the worker indexes it with the business's own
// embedding provider; a visitor then asks a question sharing NO word with the entry. Keyword scoring
// gives that entry 0 (checked below on the fixture itself), so the entry can only reach the prompt via
// its stored embedding. Then the owner edits it through the UI (must be re-indexed and the new text
// retrieved, never the old) and deactivates it (must no longer be retrieved). Business B asks the same
// question and must never see A's entry. The LLM/embeddings are the local stand-in (see llm-standin.cjs)
// unless ACC_REAL_AI=1 — the stand-in's embeddings prove the product's indexing/ranking path, not
// real-model retrieval quality.
const fs = require("fs");
const path = require("path");
const L = require("./lib.cjs"); const creds = require("./creds.json");
const QUESTION = "How do I get my money back?";
const TITLE = "Reimbursement policy";
const V1 = "Purchases are reimbursed in full within thirty days of delivery. Policy reference ZIYRAK-A-CODE-552.";
const V2 = "Purchases are reimbursed in full within sixty days of delivery. Policy reference ZIYRAK-A-CODE-553.";
const LLM_LOG = path.join(process.env.ACC_WORK_DIR || path.join(__dirname, ".work"), "llm-requests.jsonl");

// Mirrors semantic-search.ts's keywordScore(): words longer than 2 chars, substring match.
function keywordScore(query, text) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/[^a-z0-9]/g, ""));
  const t = text.toLowerCase();
  return words.length ? words.filter((w) => t.includes(w)).length / words.length : 0;
}
function lastChatPromptFor(question) {
  if (!fs.existsSync(LLM_LOG)) return null;
  const lines = fs.readFileSync(LLM_LOG, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return [...lines].reverse().find((l) => l.kind === "chat" && l.lastUser === question) || null;
}
async function entryView(p, title) {
  return p.evaluate(async (title) => {
    const data = (await (await fetch("/api/knowledge/entries?limit=100")).json()).data;
    const e = data.find((x) => x.title === title);
    return e ? { id: e.id, isActive: e.isActive, content: e.content, embeddingIndex: (e.metadata && e.metadata.embeddingIndex) || null, rawVectorInApi: !!(e.metadata && e.metadata.embedding) } : null;
  }, title);
}
async function waitIndexed(p, title, predicate) {
  for (let i = 0; i < 60; i++) {
    const v = await entryView(p, title);
    if (v && v.embeddingIndex && predicate(v)) return v;
    await L.sleep(500);
  }
  return entryView(p, title);
}
// Clicks one of the per-entry icon buttons (title="Edit entry" / "Deactivate") on the card whose heading is `title`.
async function clickEntryButton(p, title, buttonTitle) {
  const ok = await p.evaluate((title, buttonTitle) => {
    const h = [...document.querySelectorAll("h4")].find((e) => e.innerText.trim() === title);
    const card = h && h.closest("div.rounded-xl");
    const btn = card && card.querySelector(`button[title='${buttonTitle}']`);
    if (!btn) return false;
    btn.click();
    return true;
  }, title, buttonTitle);
  if (!ok) throw new Error(`no '${buttonTitle}' button on the '${title}' card`);
}
async function ask(site, name) {
  const b = await L.launch("visitor-" + name); const ctx = await b.createBrowserContext(); const p = await ctx.newPage();
  await p.goto(site, { waitUntil: "load" }); await p.waitForSelector("#ziyrak-input"); await L.sleep(800);
  const r = await L.widgetSend(p, QUESTION, { timeoutMs: 45000 });
  await L.shot(p, "j4b-" + name); await b.close();
  return { ackStatus: r.ack && r.ack.status, ackMs: r.ack && r.ack.ms, replyMs: r.replyMs, reply: r.reply, prompt: lastChatPromptFor(QUESTION) };
}

(async () => {
  const out = { fixture: { keywordScoreV1: keywordScore(QUESTION, `${TITLE} ${V1}`), keywordScoreV2: keywordScore(QUESTION, `${TITLE} ${V2}`) } };
  L.assert(out.fixture.keywordScoreV1 === 0 && out.fixture.keywordScoreV2 === 0, `fixture: the question shares no keyword with the entry (keyword-only retrieval could never find it), got ${JSON.stringify(out.fixture)}`);

  // 1. Owner A creates the entry through the real dashboard UI.
  const b = await L.launch(creds.A.profile); const p = await b.newPage(); await p.setExtraHTTPHeaders({ "X-Forwarded-For": L.XFF.A }); const ev = L.watch(p, "j4b-owner");
  await p.goto(L.BASE + "/knowledge", { waitUntil: "networkidle0" });
  if (!(await L.text(p)).includes("Policies")) {
    await L.clickFirst(p, "button", "Create Category").catch(async () => { await L.clickFirst(p, "button", "Add"); }); await L.sleep(300);
    await p.type("input[placeholder^='e.g. Product FAQ']", "Policies");
    await L.clickLast(p, "button", "Create Category"); await L.sleep(1200);
  }
  await p.evaluate(() => { const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.innerText || "").trim() === "Policies"); el.click(); }); await L.sleep(500);
  await L.clickFirst(p, "button", "Add Entry"); await L.sleep(400);
  await p.type("input[placeholder^='e.g. How to reset password']", TITLE);
  await p.type("textarea[placeholder^='Write the knowledge content']", V1);
  await L.clickLast(p, "button", "Create Entry"); await L.sleep(1200);
  out.created = await waitIndexed(p, TITLE, (v) => v.content === V1);
  L.assert(out.created && out.created.embeddingIndex && out.created.embeddingIndex.dimensions === 1536, `entry indexed by the worker after UI create, got ${JSON.stringify(out.created && out.created.embeddingIndex)}`);
  L.assert(out.created && !out.created.rawVectorInApi, `entries API does not ship the raw vector`);
  const id = out.created && out.created.id;
  out.dbV1 = L.sql(`SELECT metadata->'embeddingIndex'->>'contentHash', jsonb_array_length(metadata->'embedding') FROM "KnowledgeEntry" WHERE id = '${id}';`);
  out.jobsV1 = L.sql(`SELECT state, count(*) FROM pgboss.job WHERE name = 'index-knowledge-entry' AND data->>'entryId' = '${id}' GROUP BY state;`);
  L.assert(/^[0-9a-f]{64} \| 1536$/.test(out.dbV1), `Postgres holds the 1536-d vector + content hash, got ${JSON.stringify(out.dbV1)}`);

  // 2. A visitor on A's site asks a question that only semantic retrieval can answer.
  out.askV1 = await ask("http://localhost:4020/", "a-semantic-1");
  L.assert(out.askV1.ackStatus === 200, `A visitor: ACK 200, got ${out.askV1.ackStatus}`);
  L.assert(out.askV1.prompt && out.askV1.prompt.systemPrompt.includes("ZIYRAK-A-CODE-552"), `the entry retrieved purely by its stored embedding was put into A's prompt`);
  L.assert(out.askV1.reply && out.askV1.reply.includes("ZIYRAK-A-CODE-552"), `A's reply is grounded in the semantically retrieved entry, got ${JSON.stringify(out.askV1.reply)}`);

  // 3. Business B asks the same question: A's entry must never reach B's prompt or reply.
  out.askB = await ask("http://localhost:4021/", "b-semantic");
  L.assert(out.askB.prompt && !out.askB.prompt.systemPrompt.includes("ZIYRAK-A-CODE-55"), `B's prompt never contains A's policy entry`);
  L.assert(out.askB.reply && !out.askB.reply.includes("ZIYRAK-A-CODE-55"), `B's reply never reveals A's policy, got ${JSON.stringify(out.askB.reply)}`);

  // 4. Owner edits the entry through the UI → re-indexed; the next answer uses the NEW text only.
  await p.goto(L.BASE + "/knowledge", { waitUntil: "networkidle0" });
  await p.evaluate(() => { const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.innerText || "").trim() === "Policies"); el.click(); }); await L.sleep(500);
  await clickEntryButton(p, TITLE, "Edit entry"); await L.sleep(500);
  // Controlled React textarea: clear it the way a user would (select all + delete), then type.
  await p.click("textarea[placeholder^='Write the knowledge content']");
  await p.keyboard.down("Control"); await p.keyboard.press("KeyA"); await p.keyboard.up("Control"); await p.keyboard.press("Backspace");
  await p.type("textarea[placeholder^='Write the knowledge content']", V2);
  await L.clickLast(p, "button", "Save Changes"); await L.sleep(1200);
  out.edited = await waitIndexed(p, TITLE, (v) => v.content === V2 && out.created && v.embeddingIndex.contentHash !== out.created.embeddingIndex.contentHash);
  L.assert(out.edited && out.edited.content === V2, `the UI edit persisted, got ${JSON.stringify(out.edited && out.edited.content)}`);
  L.assert(out.edited && out.created && out.edited.embeddingIndex.contentHash !== out.created.embeddingIndex.contentHash, `the edit was re-indexed (new content hash)`);
  out.askV2 = await ask("http://localhost:4020/", "a-semantic-2");
  L.assert(out.askV2.prompt && out.askV2.prompt.systemPrompt.includes("ZIYRAK-A-CODE-553") && !out.askV2.prompt.systemPrompt.includes("ZIYRAK-A-CODE-552"), `after the edit, the prompt carries only the new text`);
  L.assert(out.askV2.reply && out.askV2.reply.includes("ZIYRAK-A-CODE-553"), `reply uses the edited entry, got ${JSON.stringify(out.askV2.reply)}`);

  // 5. Owner deactivates it through the UI → no longer retrieved.
  await p.goto(L.BASE + "/knowledge", { waitUntil: "networkidle0" });
  await p.evaluate(() => { const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.innerText || "").trim() === "Policies"); el.click(); }); await L.sleep(500);
  await clickEntryButton(p, TITLE, "Deactivate"); await L.sleep(1200);
  out.deactivated = await entryView(p, TITLE);
  L.assert(out.deactivated && out.deactivated.isActive === false, `the UI deactivation persisted`);
  out.askOff = await ask("http://localhost:4020/", "a-semantic-3");
  L.assert(out.askOff.prompt && !out.askOff.prompt.systemPrompt.includes("ZIYRAK-A-CODE-55"), `a deactivated entry is not retrieved`);
  out.jobsFinal = L.sql(`SELECT state, count(*) FROM pgboss.job WHERE name = 'index-knowledge-entry' AND data->>'entryId' = '${id}' GROUP BY state;`);
  out.ownerConsole = [...new Set(ev.consoleErrors)];
  L.assert(out.ownerConsole.length === 0, `no console errors in the owner's knowledge UI, got ${JSON.stringify(out.ownerConsole)}`);
  await b.close();

  for (const k of ["askV1", "askB", "askV2", "askOff"]) if (out[k] && out[k].prompt) out[k].prompt = { decision: out[k].prompt.decision, codesInPrompt: out[k].prompt.codesInPrompt };
  L.finish("J04b", out);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
