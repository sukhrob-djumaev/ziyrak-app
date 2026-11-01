import { createStripeProvider } from "./stripe/adapter";
import type { PaymentProvider } from "./types";

/**
 * L5.1 - the configured payment provider. `BILLING_PROVIDER=stripe` turns it on; anything else (or unset) means no
 * provider and the product behaves as in L4.1. Stripe is test mode only until live money is authorised: a live key is
 * refused here and by the startup contract.
 */
export type BillingMode = "test" | "live";

export function billingProviderName(env: NodeJS.ProcessEnv = process.env): "stripe" | null {
  return env.BILLING_PROVIDER === "stripe" ? "stripe" : null;
}

export function billingMode(): BillingMode {
  return "test";
}

let cached: PaymentProvider | null = null;

export function getPaymentProvider(env: NodeJS.ProcessEnv = process.env): PaymentProvider | null {
  if (billingProviderName(env) !== "stripe") return null;
  if (cached && env === process.env) return cached;
  const secretKey = env.STRIPE_SECRET_KEY ?? "";
  if (!secretKey.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_...)");
  const webhookSecrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_NEXT].filter((s): s is string => !!s);
  const p = createStripeProvider({ secretKey, webhookSecrets, baseUrl: env.STRIPE_API_BASE || undefined });
  if (env === process.env) cached = p;
  return p;
}

export function resetPaymentProviderForTests(): void {
  cached = null;
}
