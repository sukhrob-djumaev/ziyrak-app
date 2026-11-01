/**
 * L5.1 - payment provider port (docs/l5-payment-lifecycle-design.md section 3). Provider types stay behind this
 * interface; callers see only these shapes. Amounts are integer minor units, refs are opaque strings.
 */
export interface PublishedVersionPriceInput {
  versionId: string;
  itemName: string;
  amountMinor: number;
  currency: string;
  interval: "month" | "year";
}

export interface ProviderLine {
  priceRef: string;
  quantity: number;
}

export interface ProviderSubscription {
  ref: string;
  customerRef: string;
  /** Raw provider status; interpreted only by the pure state machine. */
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date;
  currency: string;
  items: { itemRef: string; priceRef: string; quantity: number }[];
  metadata: Record<string, string>;
  /** Taken before the provider call; orders snapshots. */
  fetchedAt: Date;
}

export interface NormalizedEvent {
  eventRef: string;
  type: string;
  /** Subscription the event concerns, when it names one; the handler still re-reads authoritative state. */
  subscriptionRef: string | null;
  customerRef: string | null;
  /** Hosted-checkout correlation (our operation id), never trusted without the local binding row. */
  clientReference: string | null;
}

export type ProviderErrorKind = "rejected" | "unknown";

/** `rejected`: the provider refused (4xx), nothing happened. `unknown`: timeout/5xx/network, the outcome is unsettled. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface PaymentProvider {
  readonly name: "stripe";
  syncPrice(v: PublishedVersionPriceInput, idemKey: string): Promise<{ productRef: string; priceRef: string }>;
  createCustomer(i: { businessId: string; email?: string }, idemKey: string): Promise<{ customerRef: string }>;
  createCheckout(
    i: {
      businessId: string;
      operationId: string;
      customerRef: string;
      lines: ProviderLine[];
      successUrl: string;
      cancelUrl: string;
    },
    idemKey: string,
  ): Promise<{ url: string; sessionRef: string }>;
  createPortal(i: { customerRef: string; returnUrl: string }): Promise<{ url: string }>;
  getSubscription(ref: string): Promise<ProviderSubscription>;
  /** Applies the given lines now (upgrades); scheduled removals are applied by Ziyrak at period end. */
  changeSubscription(i: { ref: string; lines: (ProviderLine & { itemRef?: string; remove?: boolean })[] }, idemKey: string): Promise<ProviderSubscription>;
  cancelSubscription(i: { ref: string; at: "period_end" | "now" }, idemKey: string): Promise<ProviderSubscription>;
  verifyWebhook(rawBody: Buffer, signatureHeader: string, now: Date): NormalizedEvent;
}
