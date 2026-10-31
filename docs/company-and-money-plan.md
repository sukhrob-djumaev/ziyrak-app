# Ziyrak — Company and Money Plan

Oct 29, 2026 · @Sukhrob Djumaev

The cheapest workable setup for testing Ziyrak in Malaysia: a Wyoming LLC, Mercury and Stripe, about RM450–650 a month to run, break-even at 3–4 customers before marketing.

**Check first:** taking payments from Malaysian businesses while on a dependant pass is still the legal risk. Confirm what is allowed with an immigration lawyer before the first paid customer.

## Company structure

- **Company:** a Wyoming LLC with Sukhrob as the only owner, formed through a service such as BusinessAnywhere or doola.
- **Bank:** Mercury, which is free and gives debit cards.
- **Payments:** a Stripe US account. Customers pay by card, priced in ringgit, auto-charged monthly. Yearly plans can also be paid by FPX through a payment link (Tazapay or similar).
- **Money flow:**
  1. The customer's card is charged.
  2. Stripe pays out to Mercury in US dollars.
  3. Expenses are paid from Mercury: servers, AI model, domain, ads.
  4. Profit moves to a personal account through Wise.
- **WhatsApp:** each business connects its own number to Meta's Cloud API directly. No middleman fee, and the base plan stays within Meta's 1,000 free replies a month.

## What we pay, to whom

Ringgit figures assume roughly RM4.3 per US$1; check the current rate.

| Item | Paid to | One-time | Monthly equivalent |
| --- | --- | --- | --- |
| Wyoming filing | State of Wyoming | $100 | – |
| Registered agent | Formation service | – | $50–150/yr ≈ RM20–55 |
| EIN | IRS (free yourself, or about $97 via a service) | $0–97 | – |
| Annual report | State of Wyoming | – | $60/yr ≈ RM20 |
| Form 5472 filing | Accountant or filing service | – | \~$150–500/yr ≈ RM55–180 |
| Servers (one small server or managed hosting, not Kubernetes yet) | Hosting provider | – | \~RM300 |
| Domain, email, tools | Various | – | \~RM50 |
| **Total** |  | **\~$100–200 (RM450–850)** | **\~RM450–650 a month** |

Mercury and Stripe have no monthly fees.

## Cost per customer (RM199 plan)

| Cost | RM per month |
| --- | --- |
| Stripe: \~2.9% + $0.30, plus \~1.5% for an international card and \~1% for currency conversion | \~12 |
| AI model, up to 1,000 replies | \~6 |
| Server share | \~4 |
| **Cash cost** | **\~22** |
| **Kept per customer** | **\~RM177** (\~RM148 on the RM169 yearly plan) |

Support time, about 30 minutes per customer a month, is not counted above. It is the cost that grows quietly.

## Break-even and revenue

- **Running costs alone:** about 3–4 customers cover RM500–650 a month.
- **With RM1,500 a month for marketing:** about 12 customers.

| Customers | Monthly revenue | After costs (before marketing) |
| --- | --- | --- |
| 5 | RM995 | \~RM385 |
| 10 | RM1,990 | \~RM1,270 |
| 25 | RM4,975 | \~RM3,900 |
| 50 | RM9,950 | \~RM8,300 |
| 100 | RM19,900 | \~RM17,000 |
| 220 | RM43,780 (\~US$10k) | \~RM37,000, minus help for support |

- **Reaching US$10k a month:** about 220 customers at RM199, or about 175 at RM249. Add-ons and yearly plans bring that number down.
- **Beyond about 100 customers:** add costs for support help and bigger servers. Support alone would be 50+ hours a month.
- **Tax:** the US LLC pays no US tax, but the profit must be declared where the owner is tax resident.

## Order of actions

1. Book one hour with an immigration lawyer about taking paid customers.
2. Form the Wyoming LLC and apply for the EIN. The EIN takes 3–9 weeks, so start now.
3. Once the EIN arrives, open Mercury and then Stripe, and set up Stripe Billing with monthly ringgit prices.
4. Move the app to one small server.
5. Run owner interviews and set up pilots while the paperwork completes.

## Sources

- [Wyoming LLC taxes and fees 2026](https://www.statebusinesscompliance.com/blog/wyoming-llc-taxes-annual-fees-2026)
- [BusinessAnywhere vs Stripe Atlas](https://businessanywhere.io/businessanywhere-vs-stripe-atlas/)
- [Mercury for non-resident founders](https://wiki.private.law/en/mercury)
- [Changes to WhatsApp's pricing, October 2026 (Twilio)](https://help.twilio.com/articles/53100480177819)
- [FPX for international merchants (Tazapay)](https://tazapay.com/en-sg/payment-methods/fpx)
- [Stripe FPX product compatibility](https://support.stripe.com/questions/stripe-product-compatibility-with-fpx)
- [Foreign-owned single member LLC guide (Taxes for Expats)](https://www.taxesforexpats.com/articles/foreign-business/foreign-owned-single-member-llc.html)
