# L5 — Sandbox payment lifecycle: design (Revision 1, for independent review)

Status: **proposal, no code.** Contract: `billing-and-entitlements-spec.md` (B01–B12). Decisions: `commercial-policy-l4.2.md` (Stripe, merchant of record = seller, MYR, no trial, 7-day grace, manual refunds, policy console-managed). Builds on L4.1a–c (catalog, purchases, resolver, enforcement, platform limits). **Stripe test mode only; no live charge; no real card data ever reaches Ziyrak.**

## 1. Slices

| Slice | Scope | Closes |
| --- | --- | --- |
| L5.0 | `BillingPolicy` record + console section | policy flexibility; grace/trial inputs |
| L5.1 | Provider port + Stripe adapter + in-repo Stripe **stand-in server**; catalog→provider price sync; hosted Checkout; webhook inbox; subscription state machine; `provider` purchases; owner billing page actions (subscribe, portal link, status) | B03, B04 |
| L5.2 | Upgrade/add/remove/quantity quotes, scheduled downgrade, failure/grace/recovery, cancel, reconciliation job, operator repair + alerts | B05, B06, B09 |
| L5.3 | Concurrency/entitlement-freshness tests, migration/rollback, browser journeys, independent security review | B02, B07, B08, B10, B11 |

Each slice is its own PR; B12 (live) stays out of scope.

## 2. L5.0 — BillingPolicy

One row, `BillingPolicy(id="default", graceDays Int, trialDays Int, currencies String[], intervals String[], refundPolicyText String, refundPolicyUrl String?, supportContact String, taxDisplay "none"|"inclusive"|"exclusive", rev Int, updatedBy, updatedAt)`. Defaults in code: graceDays 7, trialDays 0, currencies [MYR], intervals [month, year]. Validation: graceDays 0..30; **trialDays must be 0** until a trial lifecycle is accepted (stored for forward compatibility, rejected otherwise); currencies/intervals subsets of what the adapter declares supported; text length bounded, URL https only. Edit = super-admin, optimistic `rev` compare-and-set, one `PlatformAccessAudit` row with before/after diff. Catalog publish validates currency/interval against the *current* policy; policy changes never alter published versions or existing subscriptions. Control-plane only (`SCOPE_SCHEMA`, `CONTROL_PLANE_ONLY_MODELS`, test mock).

## 3. Provider port

```ts
interface PaymentProvider {
  readonly name: "stripe";
  syncPrice(v: PublishedVersionPriceInput, idemKey: string): Promise<{ productRef; priceRef }>;
  createCheckout(i: { workspaceRef; customerRef?; lines: {priceRef; quantity}[]; successUrl; cancelUrl; idemKey }): Promise<{ url; sessionRef }>;
  createPortal(i: { customerRef; returnUrl }): Promise<{ url }>;
  getSubscription(ref): Promise<ProviderSubscription>;      // authoritative read for reconcile
  changeSubscription(i: { ref; lines; effective: "now"|"period_end"; idemKey }): Promise<ProviderSubscription>;
  cancelSubscription(i: { ref; at: "period_end"; idemKey }): Promise<ProviderSubscription>;
  verifyWebhook(rawBody: Buffer, signatureHeader: string, now: Date): NormalizedEvent;  // throws on bad signature/stale timestamp
}
```
Stripe SDK types stay inside `src/lib/billing/providers/stripe/`. Selected via `BILLING_PROVIDER` (`stripe` | `off`; default off = the current manual/baseline behaviour, billing mutations return 404/disabled). Keys: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` read at startup only when provider is `stripe`, covered by the L2.1 startup contract and L1.3 secret redaction; test-mode keys (`sk_test_`) are the only accepted prefix while `BILLING_LIVE_ENABLED` is not set (B12 gate: a live key is rejected at startup).

**Stand-in:** a small local HTTP server in `scripts/acceptance/` implementing the subset used (products/prices, checkout sessions, subscriptions, portal, signed event emission with controllable delay/duplication/reorder/drop) so CI and browser journeys run without Stripe, as the existing stand-in AI does. A separate credential-gated `test:smoke:stripe` runs against real Stripe test mode when keys exist; a skip is not a pass.

## 4. Data model (additive; all control-plane, tenant tables unchanged)

```
ProviderPriceRef   versionId (unique with provider) → CatalogVersion, provider, productRef, priceRef, state "pending"|"synced"|"failed", lastError?, syncedAt
                   -- a version is purchasable only when state=synced; created by a durable sync job on publish; unique(provider, versionId)
BillingCustomer    businessId (unique) → Business, provider, customerRef (unique with provider), createdAt
BillingSubscription id, businessId, provider, subscriptionRef (unique with provider), status
                   "incomplete"|"active"|"past_due"|"canceling"|"ended", currentPeriodEnd, graceEndsAt?, currency, lastEventAt, rev
BillingSubscriptionItem subscriptionId, versionId, quantity, state "active"|"scheduled_remove"|"removed", effectiveAt
BillingOperation   id, businessId, kind "checkout"|"change"|"cancel", state "pending"|"succeeded"|"failed"|"unknown", idemKey (unique), quoteHash, requestedBy, createdAt  -- local operation identity; "unknown" = reconcile, never re-charge
ProviderEvent      id, provider, eventRef (unique with provider), type, receivedAt, payloadHash, state "received"|"processed"|"ignored"|"failed", attempts, error?, createdAt  -- inbox
BillingIncident    id, businessId?, kind "paid_not_provisioned"|"unbound_ref"|"reconcile_mismatch", state "open"|"resolved", detail, createdAt, resolvedBy?
```
Provider refs are bound to a workspace **only** by (a) Checkout/Customer metadata written by the server from the authenticated owner session, AND (b) the local `BillingOperation`/`BillingCustomer` row. A valid signature with an unknown or mismatched ref becomes `BillingIncident(unbound_ref)`; it never creates or changes a purchase.

## 5. Flows

**Publish → sync.** Publishing a version enqueues `billing-sync-price` (pg-boss, singleton per version): create Stripe Product (per catalog item) + Price (amount, currency, interval) with idempotency key `ver:{versionId}`; store refs; mark `synced`. Failure retries with backoff; `failed` after N attempts, alert, version stays unpurchasable. Price/currency never come from the client.

**Checkout (owner only, `business:billing`, workspace verified and not operator-suspended).** `POST /api/billing/checkout {versionIds+quantities, quoteId}` → server recomputes lines from published+synced versions, bounds from the catalog, one currency/interval per subscription, **one active bundle** rule, requires/excludes; creates `BillingOperation(pending, idemKey)`; creates Stripe Checkout Session in `subscription` mode with `client_reference_id`=operation id, metadata `{businessId, operationId}`, server-chosen `success_url`/`cancel_url` on the configured app origin (no client URLs), `payment_method_collection` default, **no trial** (`trial_period_days` never sent), `automatic_tax` off. Returns hosted URL. The success page only shows "confirming" and polls status; it grants nothing.

**Webhook (`POST /api/billing/webhook`).** Raw body, 256 KB cap, verify HMAC with ±5 min tolerance and secret rotation (two secrets accepted), insert `ProviderEvent` (unique `eventRef`) **before** replying 200; duplicate → 200 no-op. A `process-provider-event` job handles `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.dispute.created`, `charge.refunded`. Handlers never trust event payload as final state: they `getSubscription(ref)` (authoritative), compare `lastEventAt/rev`, then apply the state machine in one DB transaction under `lockTenantWrites`. Out-of-order or missing events converge through the authoritative read; unknown types are `ignored`.

**State machine (per subscription, derived from provider status + invoice events):**
`incomplete` → (paid) `active` → (payment failed) `past_due` with `graceEndsAt = now + policy.graceDays` → (paid) `active` | (grace elapsed, still unpaid) `ended`. `active` → (cancel at period end) `canceling` → (period end) `ended`. Purchases: `active` and `past_due-within-grace` keep their `provider` WorkspacePurchase active; `ended` (or grace elapsed) ends it and the workspace falls back to the baseline bundle's grants — **not** deletion: data, members, channels and inbound messages are preserved, over-limit resources follow the spec's conflict rules, `requiresHumanApproval` never relaxes. Payment state never clears operator suspension or an unverified workspace. Owner can always reach `/billing`, the portal link and recover payment. Grace expiry is a scheduled job (singleton), idempotent, UTC.

**Purchase mapping.** Confirmed paid state creates/updates `WorkspacePurchase(source="provider")` rows (one per item/quantity) with `createdBy` null and reason `provider:{operationId}`; bumps nothing outside the existing resolver (L4.1 reads live). Upgrades apply after confirmed payment; downgrades/removals at `currentPeriodEnd` (`BillingSubscriptionItem.scheduled_remove`, applied by the renewal event or the reconcile job). Quote = server-computed lines, currency, recurring total, due-now estimate (labelled estimate; provider-final amount shown after), effective date, `quoteHash` bound to workspace+versions+quantities+policy rev with 15-minute expiry; stale hash → re-quote.

**Unknown outcome.** Provider timeout/5xx on create or change → `BillingOperation.unknown`; the UI shows "pending"; the reconcile job reads authoritative state by idempotency key / client_reference_id and settles it. A retry reuses the same `idemKey`; it can never create a second charge.

**Reconcile job (every 10 min + on demand).** For every non-ended subscription and any `unknown`/`pending` operation older than 2 minutes: authoritative read, apply, record `BillingIncident(reconcile_mismatch)` if local state would have differed. `paid_not_provisioned` (paid event, no purchase after N tries) raises an alert and an audited operator repair action (`repair_provision`, super-admin only, reason required, idempotent). No money movement by operator in L5 (refunds stay in the Stripe dashboard, recorded as manual).

## 6. Authorization and invariants

Checkout, portal, change and cancel require a current session, owner `business:billing` re-checked per request, tenant-scoped workspace, no support-access impersonation of the payer. Webhook/job paths use no user session but resolve the workspace only through the bound local rows above. Entitlements stay "AND" with roles/scopes; nothing here grants a role, channel scope or tool approval change. Mutations write a tenant `AuditLog` row (actor, operation, versions, quote hash) and platform actions a `PlatformAccessAudit` row. Card data, full webhook payloads and secrets are never logged (payload kept only as hash + minimal fields).

## 7. Test plan (tests first per slice)

- Unit: state machine table (every transition/event order permutation incl. duplicate, reordered, delayed), quote hashing/expiry, policy validation (trial≠0 rejected, bad currency rejected), signature verify (good/bad/stale/rotated/oversize).
- Real-DB integration: webhook inbox dedupe under concurrent delivery; two concurrent changes → one wins, other re-quotes; unbound/mismatched ref → incident, no purchase; paid-not-provisioned repair; grace expiry idempotent; downgrade at period end keeps other overlapping grant; B10 migration (no existing workspace gains/loses access; no `provider` rows created for baseline workspaces); restart/rollback preserves mappings.
- Entitlement freshness: queued job and open request observe purchase end (B07); approval for a tool whose capability ended stays fail-closed.
- Browser (stand-in Stripe): J36 fresh owner subscribes (redirect-only grants nothing; resume after closing the tab), duplicate/reordered events, failed payment → grace banner → recovery, cancel at period end, non-owner and cross-tenant denied via UI/URL/API, phone-width checkout return.
- `test:smoke:stripe`: credential-gated, real test mode create product/price/checkout session/portal/webhook signature; skipped without keys and reported as not run.
- Independent security review before merge of L5.1 and again after L5.2 (payments, webhooks, tenant binding).

## 8. Open points for the reviewer

1. Using Stripe Checkout `subscription` mode with several line items vs. one subscription per bundle/add-on (proposal: one subscription, multiple items, same currency/interval).
2. Whether `past_due` grace should be derived from Stripe's own retry schedule (Smart Retries) or our `graceDays` (proposal: ours is authoritative for access; Stripe retries continue until its own rule ends the subscription; mismatch recorded).
3. Is a Stripe-hosted portal enough for payment-method/invoice management in L5 (proposal: yes; in-app invoice list deferred)?
4. Race: webhook processing vs. reconcile job on the same subscription (proposal: both take the tenant write lock and compare `rev`).
5. Whether the webhook endpoint needs an IP allow-list or only signature + size + rate limit (proposal: the latter; Stripe IPs change).
6. Pending L1.3/L2.1 contracts that touch this: proxy trust for webhook rate limiting, startup contract entries for the two secrets.

---
# Revision 2 (after independent design review, 2026-10-31) — overrides Revision 1 where they differ
Each finding was verified by the reviewer against the code; adopted as follows.

1. **No access before confirmed payment.** Immediate changes send `payment_behavior=pending_if_incomplete`; purchases are mapped only from items settled by a paid invoice or a settled `BillingOperation`. The stand-in simulates a failed proration invoice.
2. **Grace is bounded and cuts billing too.** `graceEndsAt` is set only on the transition into `past_due` (when null) and cleared on paid; repeated `invoice.payment_failed` never extend it. At expiry the job reads the subscription, cancels it in Stripe immediately (outside the lock), re-verifies, then ends the purchase under the lock. `invoice.paid` on an `ended` subscription never reactivates access; it raises `BillingIncident` for owner/operator review (refund is manual).
3. **One live subscription per workspace.** Partial unique index `BillingSubscription(businessId) WHERE status <> 'ended'`; checkout refused when one exists (use change); `lockTenantWrites` while creating the pending operation.
4. **Tenant binding.** Create the Stripe Customer server-side first (`metadata.businessId`, `BillingCustomer` row) and pass `customer=`; set `subscription_data.metadata={businessId, operationId}`. A subscription binds only if its customer matches the `BillingCustomer` row and, on first bind, its operation matches; otherwise `unbound_ref`. `unique(subscriptionRef)`.
5. **Unknown outcome.** Persist `sessionRef` immediately after creation; on an unknown create, retry with the same idempotency key within 24 h, afterwards list the customer's sessions/subscriptions and match `metadata.operationId`. Change/cancel reconcile by comparing authoritative items with the operation target.
6. **Apply ordering.** Each snapshot is stamped with a monotonic `fetchedAt` taken before the provider call; apply only if newer than the stored value; state is derived purely from the snapshot (idempotent). Webhook and reconcile paths both take `lockTenantWrites`. Reconcile heals any loser.
7. **Bundle/baseline.** The provider writer replaces the active bundle (ends the baseline bundle at subscribe) and, on `ended`, calls `ensureBaselinePurchase` in the same transaction. Operator `assignVersion(manual_test)` is refused while a non-ended `BillingSubscription` exists. **OWNER DECISION NEEDED:** the baseline currently grants all legacy capabilities plus 1000 seats, so a lapsed subscriber falls back to substantial free access. Options: keep (test stage), or add a published "lapsed/free" bundle as the fallback target (data-managed) — until chosen, the fallback target is a catalog setting, defaulting to the existing baseline.
8. **Purchase↔item link.** `WorkspacePurchase.subscriptionItemId` (nullable); quantity change ends and recreates in one transaction; scheduled downgrades set `endsAt = currentPeriodEnd` (resolver already filters on `endsAt > now`), so access ending does not depend on a job.
9. **Audit atomicity.** The control-plane transaction writes `PlatformAccessAudit`/a billing event row; the tenant `AuditLog` row is best-effort via the existing outbox path (separate transaction under dedicated placement).
10. **`ProviderPriceRef` key is `(provider, mode, versionId)`** (mode `test`|`live`); baseline and unpriced versions are never synced.
11. **Over-limit on downgrade (B05)** gets its own design note and tests in L5.2 before code (conflict list, owner selection, expiry policy per spec); not left to "follow the spec".
12. **Jobs/scope.** `process-provider-event` runs as a control-plane job (no `businessId` before binding); verify queue-config and worker tenant-context assumptions. All new models get `SCOPE_SCHEMA`, `CONTROL_PLANE_ONLY_MODELS` and `tests/setup.ts` entries.
13. **Webhook hygiene.** Reuse the bounded body reader and its error handling; verify the signature (timing-safe) before any DB or rate-limit work; success/cancel URLs come from an env origin allow-list.
14. **Portal** is configured to allow only payment-method, invoice and cancel-at-period-end actions; plan/quantity changes go through our quotes.
15. **Open points resolved:** (1) one subscription, many items, single currency/interval; (2) our `graceDays` authoritative, Stripe cancelled at expiry; (3) hosted portal sufficient; (4) lock + `fetchedAt`; (5) signature + size + rate limit only; (6) rate limiting needs the L1.3 trusted-proxy source; both secrets and live-key rejection join the startup contract, failing startup only when `BILLING_PROVIDER=stripe`.
