# Commercial policy (L4.2)

Status: **owner decisions recorded 2026-10-31 for the test-stage launch; sandbox only, no live charge.** Source: owner's [Company and Money Plan](Ziyrak%20—%20Company%20and%20Money%20Plan.md) (Oct 29, 2026) and chat direction of 2026-10-31. Governs L4.2/L5 inputs; `billing-and-entitlements-spec.md` remains the contract.

## Decisions

| Topic | Decision | Notes |
| --- | --- | --- |
| Seller | Wyoming LLC (US), sole owner Sukhrob Djumaev | Entity, EIN, Mercury and Stripe account do not exist yet; EIN takes weeks. |
| Provider | Stripe (US account), seller is the merchant, **not** a merchant of record | Tax, invoice and refund duties stay with the seller; revisit a merchant of record when selling at scale. |
| Currency / market | MYR, Malaysia first | One currency per subscription. FPX for yearly plans is a later, separate payment link; not a launch primitive. |
| Starting prices | RM199/month; RM169/month-equivalent yearly | **Illustrative catalog data, not code.** Owner changes them in the console. |
| Free trial | **None** | Trial days stay a policy value fixed at 0; no trial lifecycle is built for launch. |
| Grace after failed payment | 7 days (default) | Policy value, editable. |
| Refunds | Manual, case by case, by the owner | Refund policy text/link is a policy value shown to customers. |
| Invoices / tax | Stripe receipt/invoice only until selling starts | Tax registration and Malaysian SST are an owner/accountant task before the first paid customer. |
| Support contact | Owner | Shown on billing pages via policy value. |

## Flexibility rule (owner requirement)

Pricing, packaging and commercial policy must be changeable by the platform super-admin in the console **without a code change or deploy**. Two layers:

1. **Catalog (L4.1, built):** bundles, add-ons, grants, prices, intervals, versions, archive, grandfathering.
2. **Billing policy settings (to build, additive to L4.1c platform limits):** one audited, optimistic-concurrency record holding grace days, trial days (0 = none; a non-zero value stays rejected until a trial lifecycle exists and is accepted), allowed currencies and intervals for new offers, refund policy text/URL, support contact, and tax-display mode. Changes apply to future decisions; they never rewrite a past invoice or purchase.

Code is needed only for a new capability, a new billing primitive (usage billing, one-time credits, mixed currency) or a new provider. Provider price/product IDs are generated from published catalog versions by a durable sync, never hand-entered in code or config.

Open (owner, not blocking sandbox): whether yearly is one annual charge (assumed, standard Stripe) or monthly with a 12-month commitment; the catalog's interval field expresses the first and does not rule out the second later.

## Legal and tax checks that gate live money (B12, not code)

Immigration advice on taking paid customers; Malaysian tax residency and SST treatment of the LLC; Form 5472 filing; backup bank in addition to Mercury; verify current Meta WhatsApp pricing before a customer-facing free-allowance promise; measure real AI cost per reply (L1.4 real-model run still blocked on `OPENAI_API_KEY`) before fixing allowances.

## Next

L5 sandbox payment lifecycle design (Stripe test mode): schema/interfaces stated first, then tests-first implementation; policy-settings record first because L5 grace and checkout read it.
