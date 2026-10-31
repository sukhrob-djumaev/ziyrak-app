import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeSignature, signStripePayload } from "@/lib/billing/providers/stripe/signature";

const secret = "whsec_test_primary";
const old = "whsec_test_previous";
const now = new Date("2026-11-01T12:00:00Z");
const ts = Math.floor(now.getTime() / 1000);
const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "invoice.paid" }));
const header = (s: string, t = ts, b: Buffer = body) => `t=${t},v1=${createHmac("sha256", s).update(`${t}.${b.toString("utf8")}`).digest("hex")}`;

describe("stripe webhook signature", () => {
  it("accepts a correct signature", () => {
    expect(verifyStripeSignature(body, header(secret), [secret], now)).toEqual({ ok: true });
  });
  it("accepts either secret during rotation", () => {
    expect(verifyStripeSignature(body, header(old), [secret, old], now).ok).toBe(true);
  });
  it("rejects a wrong secret, tampered body, malformed or missing header", () => {
    expect(verifyStripeSignature(body, header("whsec_other"), [secret], now).ok).toBe(false);
    expect(verifyStripeSignature(Buffer.from(body.toString() + " "), header(secret), [secret], now).ok).toBe(false);
    expect(verifyStripeSignature(body, "garbage", [secret], now).ok).toBe(false);
    expect(verifyStripeSignature(body, "", [secret], now).ok).toBe(false);
    expect(verifyStripeSignature(body, `t=${ts}`, [secret], now).ok).toBe(false);
  });
  it("rejects a stale or far-future timestamp (replay window of 5 minutes)", () => {
    expect(verifyStripeSignature(body, header(secret, ts - 301), [secret], now).ok).toBe(false);
    expect(verifyStripeSignature(body, header(secret, ts + 301), [secret], now).ok).toBe(false);
    expect(verifyStripeSignature(body, header(secret, ts - 299), [secret], now).ok).toBe(true);
  });
  it("accepts one valid v1 among several and ignores unknown schemes", () => {
    const good = header(secret).split(",v1=")[1];
    expect(verifyStripeSignature(body, `t=${ts},v0=abc,v1=deadbeef,v1=${good}`, [secret], now).ok).toBe(true);
  });
  it("rejects when no secret is configured", () => {
    expect(verifyStripeSignature(body, header(secret), [], now).ok).toBe(false);
  });
  it("signStripePayload round-trips (used by the stand-in)", () => {
    expect(verifyStripeSignature(body, signStripePayload(body, secret, now), [secret], now).ok).toBe(true);
  });
});
