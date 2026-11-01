import { describe, it, expect, vi, beforeEach } from "vitest";

const isPaymentHold = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});
vi.mock("@/lib/billing/payment-hold", () => ({ isPaymentHold: (id: string) => isPaymentHold(id) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));

import { redirectIfHeld } from "@/lib/billing/hold-redirect";

describe("redirectIfHeld", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a held workspace to billing before the page loads data", async () => {
    isPaymentHold.mockResolvedValue(true);
    await expect(redirectIfHeld("b1")).rejects.toThrow("REDIRECT:/billing");
  });

  it("lets a workspace in good standing through", async () => {
    isPaymentHold.mockResolvedValue(false);
    await expect(redirectIfHeld("b1")).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });
});
