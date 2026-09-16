import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateSignature } from "@/lib/webhook-delivery";
import crypto from "crypto";

describe("Webhook Delivery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("generateSignature", () => {
    it("should generate valid HMAC-SHA256 signature", () => {
      const payload = JSON.stringify({ event: "test", data: { id: 1 } });
      const secret = "test-webhook-secret";

      const signature = generateSignature(payload, secret);

      // Verify manually
      const expected = crypto
        .createHmac("sha256", secret)
        .update(payload)
        .digest("hex");

      expect(signature).toBe(expected);
    });

    it("should produce different signatures for different payloads", () => {
      const secret = "same-secret";
      const sig1 = generateSignature('{"event":"a"}', secret);
      const sig2 = generateSignature('{"event":"b"}', secret);

      expect(sig1).not.toBe(sig2);
    });

    it("should produce different signatures for different secrets", () => {
      const payload = '{"event":"test"}';
      const sig1 = generateSignature(payload, "secret-1");
      const sig2 = generateSignature(payload, "secret-2");

      expect(sig1).not.toBe(sig2);
    });

    it("should produce consistent signatures for same input", () => {
      const payload = '{"event":"test"}';
      const secret = "consistent-secret";

      const sig1 = generateSignature(payload, secret);
      const sig2 = generateSignature(payload, secret);

      expect(sig1).toBe(sig2);
    });

    it("should return hex string of 64 characters", () => {
      const signature = generateSignature("test", "secret");

      expect(signature).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
