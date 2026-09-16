import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { validateTwilioSignature } from "@/lib/twilio-verify";

describe("Twilio Signature Validation", () => {
  const authToken = "test-auth-token-12345";
  const url = "https://example.com/api/channels/phone/incoming";
  const params = { CallSid: "CA123", From: "+1555000111", To: "+1555000222" };

  function generateValidSignature(token: string, reqUrl: string, reqParams: Record<string, string>): string {
    const data = reqUrl + Object.keys(reqParams).sort().reduce((acc, key) => acc + key + reqParams[key], "");
    return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  }

  it("should validate correct signature", () => {
    const signature = generateValidSignature(authToken, url, params);
    expect(validateTwilioSignature(authToken, signature, url, params)).toBe(true);
  });

  it("should reject incorrect signature", () => {
    expect(validateTwilioSignature(authToken, "invalid-signature", url, params)).toBe(false);
  });

  it("should reject empty auth token", () => {
    const signature = generateValidSignature(authToken, url, params);
    expect(validateTwilioSignature("", signature, url, params)).toBe(false);
  });

  it("should reject empty signature", () => {
    expect(validateTwilioSignature(authToken, "", url, params)).toBe(false);
  });

  it("should reject tampered params", () => {
    const signature = generateValidSignature(authToken, url, params);
    const tampered = { ...params, From: "+1999999999" };
    expect(validateTwilioSignature(authToken, signature, url, tampered)).toBe(false);
  });
});
