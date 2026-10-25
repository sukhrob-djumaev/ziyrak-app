# Configurable billing and entitlements

Status: **owner-approved target contract for LP-2026-10-25; not implemented**. The owner requests flexible packaging and self-service payment. Base subscription plus optional add-ons is the agreed starting model, not an approved production price list. A zero-base/a-la-carte offer should be expressible with the same catalog. Merchant country/provider/currency and final commercial policies remain decisions in L4.2.

## What can change without code

The platform super-admin can create, preview, publish and archive bundles and add-ons; change prices for new sales; choose included implemented features and limits; set supported recurring intervals, quantities, availability and effective dates; and inspect which subscribers are affected. Customers can see their current package, add/remove eligible features and preview financial/access effects before confirming.

The catalog sells **capabilities the product already implements**. Adding a new payment amount, bundle or included allowance requires no deployment. Adding a genuinely new capability, billing primitive or provider requires code, tests and migration. No arbitrary scripts, expressions, SQL or executable policy enter the catalog. Unsupported combinations cannot publish.

Example using illustrative units, not a price decision: an Inbox base bundle includes Web Chat and an AI allowance; a reporting-export add-on grants that implemented capability; a seat quantity increases the supported membership allowance. The owner can change a future offer's included features or price in the console. Existing subscribers keep their purchased version unless a separately previewed migration is scheduled. Additional channel quantities cannot be sold until the connection model/UI actually supports the quantity.

## Boundaries and ownership

| Component | Owns | Does not own |
| --- | --- | --- |
| Code-owned capability registry | Stable typed keys, boolean access or quantitative limit, units/period semantics, enforced operations and operational prerequisites | Prices, customer role assignment or arbitrary configuration execution |
| Catalog | Versioned products/bundles/add-ons, published price offers, quantity bounds, dependencies/exclusions, availability and effective dates | Provider secrets, tenant data, mutation of a subscriber's historical purchase |
| Billing domain | Workspace subscription, purchased items/version, provider references, lifecycle transitions, quotes/change requests, invoice references, audit and reconciliation | Card data or permission to bypass membership/resource scope |
| Entitlement service | Effective grants/limits and reasons derived from confirmed lifecycle, purchased version and explicit expiring administrative adjustments | Browser-provided truth, AI usage-log totals as invoices |
| Payment adapter | Hosted checkout/portal, provider API/event normalization, provider-specific idempotency and reconciliation | Application-wide provider SDK types or direct tenant repository bypass |

Use application/domain contracts with a provider adapter, consistent with §§5–6. Select one payment provider initially; keep provider-specific types inside its adapter. Do not build multiple integrations merely for hypothetical portability. Durable outbox/inbox and jobs use existing repository/queue boundaries. Exact schema/interfaces and migrations must be stated before L4/L5 code and independently reviewed.

Initial scope: recurring fixed-price capabilities and validated quantities, monthly/yearly offers where the chosen provider and tests support them, one currency and compatible interval per subscription. Discounts/trials may be catalog configuration only after their lifecycle is implemented and accepted. Mixed currency/cadence, one-time credits, usage overage charging and arbitrary discount stacking are extensions, not promised launch features. An offer with an unsupported primitive remains a draft.

## Catalog lifecycle and compatibility

Draft → validated preview → published immutable version → archived for new sales. Publishing validates implemented capability keys, meaningful quantities, dependencies, currency/interval/provider restrictions and financial totals. Catalog changes have actor/reason/diff audit records and optimistic concurrency protection. Archive stops new purchases; it does not silently revoke existing purchases.

Create a new price/version to change commercial terms; retain old references for invoices, refunds and existing subscriptions. Default to grandfathering. An existing-customer migration requires a preview of affected workspaces, effective date, applicable notice/consent policy and a resumable audited job. Rollback publishes/reinstates a permitted version rather than rewriting history. Provider synchronization is durable and reconciled; a partially synced offer is not purchasable.

Each registry key defines its combination rule (boolean union, maximum, additive quantity or explicit replacement), unit, period and adjustment precedence/expiry. No guessed universal summation. Removing one product must retain access still granted by another; overlapping bundles cannot accidentally double an allowance. Record provenance so effective access can be explained. Capability-key retirement needs a tested replacement/migration for all grandfathered purchases before deployed enforcement is removed.

Commercial adjustments require explicit scoped authorization, reason, expiry and audit. They must not turn into undocumented permanent bypasses. A catalog editor cannot grant platform support access or sell a feature the runtime cannot enforce.

## Authorization and enforcement

Every protected operation must satisfy **current identity + workspace/resource permission + entitlement/limit + operational availability**. Buying a feature never grants a role, channel scope or cross-tenant access. Entitlements must be checked in services and delayed work at execution/admission, not only in navigation. Revocation/downgrade cannot leave stale cache or queued jobs permanently authorized; define bounded refresh and version checks.

Workspace owner holds existing `business:billing` authority for purchases, cancellation, payment methods and invoices. Admins manage workspace operations but get no implicit purchasing authority. Supervisors/agents/viewers have no billing mutation. Platform super-admin manages catalog and separately audited commercial support; operators retain their explicit support scopes with no implied price/refund/global-secret powers. Any delegated billing-manager role needs its own permission design.

A downgrade or expired entitlement must never turn `requiresHumanApproval` into automatic execution. Retain safe review/reject/cancel/recovery or disable dependent tools; queued actions revalidate policy and current authority. Baseline approval safety is not removable through commercial packaging.

Account security, tenant isolation, access to billing recovery, essential account recovery and legally required data rights are not optional paid bypasses. A payment failure must not prevent its owner from correcting payment or reading a clear status. Separate intentional operator suspension/security hold from payment state; payment recovery must not reactivate an operator-suspended or unverified workspace.

## Checkout, events and change safety

Use hosted payment collection. Ziyrak must not receive/store raw card details. The server derives workspace, catalog version, price references and allowed quantities; reject manipulated client totals, cross-workspace provider IDs, unapproved redirect/return destinations, stale quotes and duplicate/concurrent changes. Revalidate current membership/ownership for sensitive actions and creation of checkout/portal sessions; support access alone cannot impersonate the payer. Quotes show currency, recurring total, amount due now, effective date, renewal and known tax treatment; distinguish estimates from provider-final amounts. Confirm the same quote/version or re-quote.

A success redirect is not payment proof. Persist verified provider events durably before acknowledging them; validate signatures against the exact raw payload with bounded body size and a documented rotation/replay policy. Deduplicate event IDs and logical business operations, tolerate out-of-order/missing events, fetch/reconcile authoritative provider state when needed and retry safely. Uniquely bind provider customer/subscription/item IDs to the correct workspace. A valid signature does not itself establish tenant ownership.

On unknown payment/provisioning outcome, display pending and reconcile; never charge again to guess the result. Use idempotent provider requests plus durable local operation identifiers. Alert and provide audited repair when payment succeeded but provisioning failed. Do not grant the paid upgrade before confirmed qualifying payment/subscription state. Subscription trial/zero-total invoice rules must be explicit rather than hardcoding every activation to a nonzero payment event.

## Lifecycle and quotas

Model incomplete/pending, trial (if offered), active, past due/grace, suspended, cancellation scheduled, ended and recovery separately from operator/security suspension. Define which events change each state. Working defaults for review: upgrades apply after confirmed payment; downgrades/removals at renewal; show preview before either. Do not lock production grace days, refund terms or proration policy until the owner decides L4.2.

For seat/channel reductions below current usage, show conflicts and let an authorized person resolve which resources remain active; never silently delete data, select arbitrary members or leave old access indefinitely. The change remains scheduled/pending according to an explicit expiry policy. Preserve incoming customer messages and human handoff where safely supported within a defined retention/abuse budget; do not promise unlimited free retention or unlimited AI after payment failure. Display the exact unavailable feature, limit, effective time and recovery action.

Existing P2 token reservations enforce conservative service allowances, including uncertain outcomes; best-effort usage logs are not invoice records. Keep allowances, operational counters and billable events distinct. Define UTC/calendar vs subscription-cycle periods, reset/renewal boundaries, concurrent reservations, upgrades, cancellations and rollover before enforcement. If metered billing is added later, it needs immutable deduplicated billable events, corrections/credits, reliable submission and invoice reconciliation. No inference of billable usage by summing current AI logs.

Financial mutations are authorized human actions. Conversation tools/AI must not autonomously purchase, refund, change payment methods or alter commercial policy.

## Required acceptance (B01–B12)

| ID | Required proof |
| --- | --- |
| B01 | Super-admin publishes a bundle and independent add-on, changes a new-sale price and archives an offer through UI without code/deploy; existing subscriptions keep versioned terms. Unknown capabilities/unsupported combinations rejected; overlapping grant composition and retirement/migration rules tested. |
| B02 | Owner sees accurate package, allowance, invoice/payment status and quote; nonowners and other tenants cannot view protected financial records or mutate subscriptions through UI, direct URLs or API. |
| B03 | Fresh verified customer completes hosted sandbox checkout and receives exactly the purchased access; redirect alone grants nothing; setup resumes after tab/browser interruption. |
| B04 | Signed, unsigned, tampered, replayed, duplicate, reordered and delayed events; mismatched tenant/provider IDs; transient DB/queue failures; one durable business effect and reconciled outcome. |
| B05 | Upgrade/add/remove/quantity change, stale quote, two concurrent changes, scheduled downgrade, failed upgrade payment and over-limit resource selection have correct totals/effective dates and no privilege leakage; removing one overlapping grant retains the other and cannot bypass mandatory approvals. |
| B06 | Payment failure, grace expiry, cancellation, refund/dispute policy, recovery and trial expiry where supported; billing recovery remains reachable; operator/security suspension is not cleared by payment. |
| B07 | Delayed worker jobs, active realtime sessions and caches observe entitlement/permission changes; buying access never widens resource scope or tool approval authority; queued approvals remain fail-closed after entitlement loss. |
| B08 | Concurrent quotas, cycle boundaries, allowance changes and uncertain AI outcomes; no double usage/charge, no reset exploitation, no invoice inference from lossy logs; adjustments/expiry cannot double-count grants and platform spend limits hold under concurrent workspaces. |
| B09 | Provider outage/timeout, webhook loss and successful-payment/provisioning failure reconcile without repeated charge; operator has auditable repair and alerts. |
| B10 | Existing users/workspaces migrate without accidental billing, service deletion or broader permissions; rollback/restart preserve subscription/provider mappings and audit. |
| B11 | Browser full journey on identified build plus independent security review; accessible/mobile checkout return and billing states; real DB/worker boundaries. Sandbox is not live-payment acceptance. |
| B12 | Before live charging: eligible merchant/provider configured, production secrets/signatures/URLs and sender verified, approved prices/policies/tax responsibility, support path, operational rehearsal, and explicit owner authorization for bounded pilot. |

## Provider research and remaining decisions

Research checked official documentation on 2026-10-25; provider-neutral requirements above are Ziyrak design decisions. Stripe is an example, not the chosen provider. Its [product/price model](https://docs.stripe.com/products-prices/manage-prices) supports configurable offers; [entitlements](https://docs.stripe.com/billing/entitlements) maps product features to access, but Ziyrak still needs its own role/resource checks and quantitative limits. Its [subscription changes](https://docs.stripe.com/billing/subscriptions/change-price) and [prorations](https://docs.stripe.com/billing/subscriptions/prorations) require explicit effective-date and invoice handling. Its [webhook guidance](https://docs.stripe.com/webhooks) reinforces duplicate/out-of-order event handling.

Choose based on merchant eligibility, target currencies/payment methods, cost, tax/invoicing responsibility, refund/dispute operations and subscription capabilities. [Stripe availability](https://stripe.com/global) and [Paddle's SaaS model](https://developer.paddle.com/get-started/how-paddle-works/saas/) are starting points for the L4.2 comparison. Selling Ziyrak subscriptions is separate from collecting payments on behalf of its customers; the latter remains out of scope. Merchant country and first currency are still unconfirmed; they do not block safety, dashboard cleanup or provider-neutral catalog work.
