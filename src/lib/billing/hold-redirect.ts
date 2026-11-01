import { redirect } from "next/navigation";
import { isPaymentHold } from "./payment-hold";

/**
 * For server-rendered dashboard pages: a held workspace is sent to Billing before the page loads any data, so nothing reaches the
 * browser through the page payload. The layout's HoldGate only covers what the client renders.
 */
export async function redirectIfHeld(businessId: string): Promise<void> {
  if (await isPaymentHold(businessId)) redirect("/billing");
}
