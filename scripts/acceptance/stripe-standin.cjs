// LOCAL STAND-IN for the subset of the Stripe API Ziyrak uses (products, prices, customers, checkout sessions,
// subscriptions, billing portal) plus signed webhook delivery. NOT Stripe: it proves Ziyrak's handling of
// delayed / duplicated / reordered / dropped events and of the hosted-payment redirect, nothing about real card
// processing, real invoice timing or real signature-secret provisioning (that is `test:smoke:stripe`).
// Control API (all under /__control, test use only):
//   POST /__control/config   {mode: "normal"|"hold"|"drop"|"duplicate"}
//   POST /__control/flush    {reverse?: boolean}              deliver held events
//   POST /__control/sessions/:id/complete                     customer paid: subscription active + events
//   POST /__control/subscriptions/:id/invoice {paid: boolean} invoice.paid / invoice.payment_failed (past_due)
//   POST /__control/subscriptions/:id/status {status}         set provider status + customer.subscription.updated
//   GET  /__control/state
const http = require("http");
const crypto = require("crypto");

function sign(body, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}
const form = (s) => Object.fromEntries(new URLSearchParams(s));
const readBody = (req) =>
  new Promise((r) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => r(d));
  });

function createStripeStandin({ webhookUrl, webhookSecret, publicUrl }) {
  let seq = 0;
  const id = (p) => `${p}_${++seq}${crypto.randomBytes(3).toString("hex")}`;
  const st = { products: {}, prices: {}, customers: {}, sessions: {}, subs: {}, idem: new Map(), held: [], sent: [], mode: "normal", periodDays: 30 };
  let self = publicUrl || "";

  async function post(event) {
    const body = JSON.stringify(event);
    st.sent.push(event.id);
    try {
      await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": sign(body, webhookSecret) }, body });
    } catch {
      /* the app being down is a valid scenario; Stripe would retry, the stand-in does not */
    }
  }
  async function emit(type, object) {
    const event = { id: id("evt"), type, data: { object } };
    if (st.mode === "drop") return;
    if (st.mode === "hold") return void st.held.push(event);
    await post(event);
    if (st.mode === "duplicate") await post(event);
  }
  const subView = (s) => ({
    id: s.id, customer: s.customer, status: s.status, currency: s.currency, cancel_at_period_end: s.cancel_at_period_end, metadata: s.metadata,
    items: { data: s.items.map((i) => ({ id: i.id, price: { id: i.price }, quantity: i.quantity, current_period_end: s.periodEnd })) },
  });

  function itemsFrom(f) {
    const out = [];
    for (let i = 0; f[`line_items[${i}][price]`] || f[`items[${i}][price]`] || f[`items[${i}][id]`]; i++) {
      const p = "line_items[" + i + "]";
      out.push(f[`${p}[price]`] ? { price: f[`${p}[price]`], quantity: Number(f[`${p}[quantity]`] || 1) } : { id: f[`items[${i}][id]`], price: f[`items[${i}][price]`], quantity: f[`items[${i}][quantity]`] === undefined ? undefined : Number(f[`items[${i}][quantity]`]), deleted: f[`items[${i}][deleted]`] === "true" });
    }
    return out;
  }

  async function api(method, path, f, key) {
    const reply = (code, body) => ({ code, body });
    if (path === "/v1/products" && method === "POST") { const p = { id: id("prod"), name: f.name, metadata: {} }; st.products[p.id] = p; return reply(200, p); }
    if (path === "/v1/prices" && method === "POST") {
      if (!st.products[f.product]) return reply(400, { error: { message: "No such product" } });
      const p = { id: id("price"), product: f.product, unit_amount: Number(f.unit_amount), currency: f.currency, recurring: { interval: f["recurring[interval]"] } };
      st.prices[p.id] = p; return reply(200, p);
    }
    if (path === "/v1/customers" && method === "POST") { const c = { id: id("cus"), email: f.email || null }; st.customers[c.id] = c; return reply(200, c); }
    if (path === "/v1/checkout/sessions" && method === "POST") {
      const items = itemsFrom(f);
      if (!st.customers[f.customer] || !items.length || items.some((i) => !st.prices[i.price])) return reply(400, { error: { message: "Invalid checkout request" } });
      if (f["subscription_data[trial_period_days]"] || f.trial_period_days) return reply(400, { error: { message: "stand-in: trials are not offered" } });
      const s = { id: id("cs"), customer: f.customer, items, client_reference_id: f.client_reference_id, success_url: f.success_url, cancel_url: f.cancel_url, metadata: { businessId: f["subscription_data[metadata][businessId]"], operationId: f["subscription_data[metadata][operationId]"] } };
      s.url = `${self}/pay/${s.id}`; st.sessions[s.id] = s; return reply(200, { id: s.id, url: s.url });
    }
    if (path === "/v1/billing_portal/sessions" && method === "POST") return reply(200, { url: `${self}/portal/${f.customer}` });
    const m = path.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (m) {
      const s = st.subs[m[1]];
      if (!s) return reply(404, { error: { message: "No such subscription" } });
      if (method === "GET") return reply(200, subView(s));
      if (method === "DELETE") { s.status = "canceled"; await emit("customer.subscription.deleted", subView(s)); return reply(200, subView(s)); }
      if (f.cancel_at_period_end) s.cancel_at_period_end = f.cancel_at_period_end === "true";
      for (const it of itemsFrom(f)) {
        const cur = s.items.find((x) => x.id === it.id);
        if (it.deleted) s.items = s.items.filter((x) => x.id !== it.id);
        else if (cur) { if (it.price) cur.price = it.price; if (it.quantity) cur.quantity = it.quantity; }
        else s.items.push({ id: id("si"), price: it.price, quantity: it.quantity || 1 });
      }
      await emit("customer.subscription.updated", subView(s));
      return reply(200, subView(s));
    }
    return reply(404, { error: { message: "Unknown stand-in route" } });
  }

  async function complete(sessionId) {
    const sess = st.sessions[sessionId];
    if (!sess) return null;
    if (sess.subscription) return st.subs[sess.subscription];
    const first = st.prices[sess.items[0].price];
    const sub = { id: id("sub"), customer: sess.customer, status: "active", currency: first.currency, cancel_at_period_end: false, metadata: sess.metadata, periodEnd: Math.floor(Date.now() / 1000) + st.periodDays * 86400, items: sess.items.map((i) => ({ id: id("si"), price: i.price, quantity: i.quantity })) };
    st.subs[sub.id] = sub; sess.subscription = sub.id;
    await emit("checkout.session.completed", { id: sess.id, customer: sess.customer, subscription: sub.id, client_reference_id: sess.client_reference_id });
    await emit("customer.subscription.created", subView(sub));
    await emit("invoice.paid", { id: id("in"), customer: sess.customer, subscription: sub.id });
    return sub;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const raw = await readBody(req);
    const send = (code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
    try {
      if (url.pathname.startsWith("/v1/")) {
        if (!(req.headers.authorization || "").startsWith("Bearer sk_test_")) return send(401, { error: { message: "Invalid API key" } });
        const key = req.headers["idempotency-key"];
        const cacheKey = key && `${req.method} ${url.pathname} ${key}`;
        if (cacheKey && st.idem.has(cacheKey)) { const c = st.idem.get(cacheKey); return send(c.code, c.body); }
        const out = await api(req.method, url.pathname, form(raw), key);
        if (cacheKey && out.code < 500) st.idem.set(cacheKey, out);
        return send(out.code, out.body);
      }
      if (url.pathname.startsWith("/pay/")) {
        const sess = st.sessions[url.pathname.slice(5)];
        if (!sess) return send(404, "unknown session", "text/plain");
        if (req.method === "POST") { await complete(sess.id); res.writeHead(303, { Location: sess.success_url }); return res.end(); }
        return send(200, `<!doctype html><title>Stand-in checkout</title><body><h1>Stand-in checkout</h1><form method="post"><button id="pay">Pay</button></form><a id="cancel" href="${sess.cancel_url}">Cancel</a></body>`, "text/html");
      }
      if (url.pathname.startsWith("/portal/")) return send(200, "<!doctype html><title>Stand-in portal</title><h1>Stand-in portal</h1>", "text/html");
      if (url.pathname.startsWith("/__control/")) {
        const body = raw ? JSON.parse(raw) : {};
        const p = url.pathname.slice(11);
        if (p === "config") { st.mode = body.mode; return send(200, { mode: st.mode }); }
        if (p === "flush") { const q = st.held.splice(0); if (body.reverse) q.reverse(); for (const e of q) await post(e); return send(200, { delivered: q.length }); }
        if (p === "state") return send(200, { mode: st.mode, held: st.held.length, sent: st.sent.length, subs: Object.values(st.subs).map(subView), sessions: Object.keys(st.sessions) });
        let m = p.match(/^sessions\/([^/]+)\/complete$/);
        if (m) { const s = await complete(m[1]); return s ? send(200, subView(s)) : send(404, { error: "no session" }); }
        m = p.match(/^subscriptions\/([^/]+)\/(invoice|status)$/);
        const s = m && st.subs[m[1]];
        if (s && m[2] === "invoice") {
          s.status = body.paid ? "active" : "past_due";
          await emit(body.paid ? "invoice.paid" : "invoice.payment_failed", { id: id("in"), customer: s.customer, subscription: s.id });
          return send(200, subView(s));
        }
        if (s && m[2] === "status") { s.status = body.status; await emit("customer.subscription.updated", subView(s)); return send(200, subView(s)); }
        return send(404, { error: "unknown control route" });
      }
      send(404, "not found", "text/plain");
    } catch (e) {
      send(500, { error: { message: String(e && e.message) } });
    }
  });
  return { server, state: st, setPublicUrl: (u) => { self = u; } };
}

module.exports = { createStripeStandin, sign };

if (require.main === module) {
  const port = Number(process.env.STRIPE_STANDIN_PORT || 4020);
  const { server } = createStripeStandin({
    webhookUrl: process.env.STRIPE_STANDIN_WEBHOOK_URL || "http://127.0.0.1:3000/api/billing/webhook",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "whsec_standin",
    publicUrl: process.env.STRIPE_STANDIN_PUBLIC_URL || `http://127.0.0.1:${port}`,
  });
  server.listen(port, "127.0.0.1", () => console.log(`stripe stand-in on ${port}`));
}
