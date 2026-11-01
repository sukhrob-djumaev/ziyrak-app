import { ProviderError, type NormalizedEvent, type PaymentProvider, type ProviderSubscription } from "../types";
import { verifyStripeSignature } from "./signature";

/**
 * L5.1 - Stripe adapter over plain `fetch` (no SDK). The base URL is configurable so acceptance runs against the
 * in-repo stand-in. Every mutating call carries an Idempotency-Key; 4xx is `rejected`, timeouts/5xx/network are
 * `unknown` so the caller settles them through the authoritative read instead of retrying blindly.
 */
export interface StripeConfig {
  secretKey: string;
  webhookSecrets: string[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Form = Record<string, string | number | boolean | undefined>;
type Json = Record<string, unknown>;

const API_VERSION = "2025-09-30.clover";

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "") throw new ProviderError("unknown", `Provider response missing ${what}`);
  return v;
}
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

export function createStripeProvider(cfg: StripeConfig): PaymentProvider {
  const base = (cfg.baseUrl ?? "https://api.stripe.com").replace(/\/$/, "");
  const doFetch = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 10_000;

  async function call(method: "GET" | "POST" | "DELETE", path: string, form?: Form, idemKey?: string): Promise<Json> {
    const headers: Record<string, string> = { Authorization: `Bearer ${cfg.secretKey}`, "Stripe-Version": API_VERSION };
    let body: string | undefined;
    if (form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) if (v !== undefined) p.set(k, String(v));
      body = p.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    if (idemKey) headers["Idempotency-Key"] = idemKey;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ProviderError("unknown", "Provider unreachable or timed out");
    }
    const text = await res.text().catch(() => "");
    let data: Json = {};
    try {
      data = text ? (JSON.parse(text) as Json) : {};
    } catch {
      if (res.ok) throw new ProviderError("unknown", "Provider returned an unreadable response", res.status);
    }
    if (res.ok) return data;
    const message = typeof obj(data.error).message === "string" ? (obj(data.error).message as string) : `HTTP ${res.status}`;
    // 409 (idempotency in flight) and 429 are retryable with the same key, so the outcome is not settled.
    const kind = res.status >= 500 || res.status === 409 || res.status === 429 ? "unknown" : "rejected";
    throw new ProviderError(kind, message.slice(0, 200), res.status);
  }

  function toSubscription(raw: Json, fetchedAt: Date): ProviderSubscription {
    const itemsRaw = obj(raw.items).data;
    const items = (Array.isArray(itemsRaw) ? itemsRaw : []).map((i) => {
      const it = obj(i);
      return {
        itemRef: str(it.id, "item id"),
        priceRef: str(obj(it.price).id, "item price"),
        quantity: typeof it.quantity === "number" ? it.quantity : 1,
      };
    });
    // Current API versions carry the period on items; older ones on the subscription.
    const first = obj(Array.isArray(itemsRaw) ? itemsRaw[0] : undefined);
    const end = (typeof first.current_period_end === "number" ? first.current_period_end : raw.current_period_end) as unknown;
    if (typeof end !== "number") throw new ProviderError("unknown", "Provider response missing period end");
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj(raw.metadata))) if (typeof v === "string") metadata[k] = v;
    return {
      ref: str(raw.id, "subscription id"),
      customerRef: str(raw.customer, "customer"),
      status: str(raw.status, "status"),
      cancelAtPeriodEnd: raw.cancel_at_period_end === true,
      currentPeriodEnd: new Date(end * 1000),
      currency: str(raw.currency, "currency").toUpperCase(),
      items,
      metadata,
      fetchedAt,
    };
  }

  /** Stripe's nested form encoding: `prefix[index][key]=value`. */
  const lineForm = (prefix: string, rows: Form[]): Form => {
    const out: Form = {};
    rows.forEach((row, i) => {
      for (const [k, v] of Object.entries(row)) if (v !== undefined) out[`${prefix}[${i}][${k}]`] = v;
    });
    return out;
  };

  return {
    name: "stripe",

    async syncPrice(v, idemKey) {
      const product = await call("POST", "/v1/products", { name: v.itemName, "metadata[versionId]": v.versionId }, `${idemKey}:product`);
      const productRef = str(product.id, "product id");
      const price = await call(
        "POST",
        "/v1/prices",
        { product: productRef, unit_amount: v.amountMinor, currency: v.currency.toLowerCase(), "recurring[interval]": v.interval, "metadata[versionId]": v.versionId },
        `${idemKey}:price`,
      );
      return { productRef, priceRef: str(price.id, "price id") };
    },

    async createCustomer(i, idemKey) {
      const c = await call("POST", "/v1/customers", { email: i.email, "metadata[businessId]": i.businessId }, idemKey);
      return { customerRef: str(c.id, "customer id") };
    },

    async createCheckout(i, idemKey) {
      const s = await call(
        "POST",
        "/v1/checkout/sessions",
        {
          ...lineForm("line_items", i.lines.map((l) => ({ price: l.priceRef, quantity: l.quantity }))),
          mode: "subscription",
          customer: i.customerRef,
          client_reference_id: i.operationId,
          success_url: i.successUrl,
          cancel_url: i.cancelUrl,
          "metadata[businessId]": i.businessId,
          "metadata[operationId]": i.operationId,
          "subscription_data[metadata][businessId]": i.businessId,
          "subscription_data[metadata][operationId]": i.operationId,
          "payment_method_collection": "always",
        },
        idemKey,
      );
      return { url: str(s.url, "checkout url"), sessionRef: str(s.id, "session id") };
    },

    async createPortal(i) {
      const s = await call("POST", "/v1/billing_portal/sessions", { customer: i.customerRef, return_url: i.returnUrl });
      return { url: str(s.url, "portal url") };
    },

    async getSubscription(ref) {
      const fetchedAt = new Date();
      return toSubscription(await call("GET", `/v1/subscriptions/${encodeURIComponent(ref)}`), fetchedAt);
    },

    async changeSubscription(i, idemKey) {
      const fetchedAt = new Date();
      const items = lineForm(
        "items",
        i.lines.map((l) => ({ id: l.itemRef, price: l.remove ? undefined : l.priceRef, quantity: l.remove ? undefined : l.quantity, deleted: l.remove ? true : undefined })),
      );
      const raw = await call(
        "POST",
        `/v1/subscriptions/${encodeURIComponent(i.ref)}`,
        { ...items, proration_behavior: "create_prorations", payment_behavior: "pending_if_incomplete" },
        idemKey,
      );
      return toSubscription(raw, fetchedAt);
    },

    async cancelSubscription(i, idemKey) {
      const fetchedAt = new Date();
      const path = `/v1/subscriptions/${encodeURIComponent(i.ref)}`;
      if (i.at === "now") {
        return toSubscription(await call("DELETE", path, undefined, idemKey), fetchedAt);
      }
      return toSubscription(await call("POST", path, { cancel_at_period_end: true }, idemKey), fetchedAt);
    },

    verifyWebhook(rawBody, signatureHeader, now): NormalizedEvent {
      const sig = verifyStripeSignature(rawBody, signatureHeader, cfg.webhookSecrets, now);
      if (!sig.ok) {
        throw new ProviderError("rejected", `Invalid webhook signature (${sig.reason})`, 400);
      }
      let ev: Json;
      try {
        ev = JSON.parse(rawBody.toString("utf8")) as Json;
      } catch {
        throw new ProviderError("rejected", "Unreadable webhook body", 400);
      }
      const data = obj(obj(ev.data).object);
      const type = str(ev.type, "event type");
      const isSub = type.startsWith("customer.subscription.");
      // Invoices carry the subscription at `subscription` before API 2025-03-31 and at `parent.subscription_details.subscription` after;
      // the webhook endpoint's own version decides the shape, so accept both.
      const parentSub = obj(obj(data.parent).subscription_details).subscription;
      const subscriptionRef = isSub
        ? typeof data.id === "string" ? data.id : null
        : typeof data.subscription === "string" ? data.subscription : typeof parentSub === "string" ? parentSub : null;
      return {
        eventRef: str(ev.id, "event id"),
        type,
        subscriptionRef,
        customerRef: typeof data.customer === "string" ? data.customer : null,
        clientReference: typeof data.client_reference_id === "string" ? data.client_reference_id : null,
      };
    },
  };
}
