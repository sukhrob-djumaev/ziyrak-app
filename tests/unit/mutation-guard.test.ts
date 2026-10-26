import { describe, it, expect } from "vitest";
import { checkCookieMutation } from "@/lib/http/mutation-guard";

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
const run = (method: string, headers: Record<string, string>, host = "app.example.com") =>
  checkCookieMutation({ method, headers: h(headers), host });
const json = { "content-type": "application/json", "content-length": "12" };

describe("cookie mutation guard (L1.3)", () => {
  it("allows safe methods whatever the origin", () => {
    expect(run("GET", { "sec-fetch-site": "cross-site" }).ok).toBe(true);
  });
  it("allows same-origin JSON writes, and direct (no Fetch Metadata) writes with a matching Origin", () => {
    expect(run("POST", { "sec-fetch-site": "same-origin", ...json }).ok).toBe(true);
    expect(run("POST", { origin: "https://app.example.com", ...json }).ok).toBe(true);
    expect(run("DELETE", { "sec-fetch-site": "same-origin" }).ok).toBe(true); // no body
  });
  it("allows non-browser clients that send neither Origin nor Fetch Metadata (not a CSRF vector)", () => {
    expect(run("PATCH", json).ok).toBe(true);
  });
  it("blocks cross-site and sibling-subdomain browser requests", () => {
    expect(run("POST", { "sec-fetch-site": "cross-site", ...json })).toEqual({ ok: false, reason: "cross_site" });
    expect(run("POST", { "sec-fetch-site": "same-site", ...json })).toEqual({ ok: false, reason: "cross_site" });
  });
  it("blocks a mismatched or malformed Origin when Fetch Metadata is absent", () => {
    expect(run("POST", { origin: "https://evil.example.net", ...json })).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(run("POST", { origin: "https://app.example.com.evil.net", ...json }).ok).toBe(false);
    expect(run("POST", { origin: "null", ...json }).ok).toBe(false);
  });
  it("requires a JSON content type when there is a body", () => {
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""])
      expect(run("POST", { "sec-fetch-site": "same-origin", "content-type": ct, "content-length": "5" })).toEqual({ ok: false, reason: "content_type" });
    expect(run("POST", { "sec-fetch-site": "same-origin", "content-type": "application/vnd.api+json; charset=utf-8", "content-length": "5" }).ok).toBe(true);
  });
  it("is case-insensitive about the host", () => {
    expect(run("POST", { origin: "https://APP.example.com", ...json }).ok).toBe(true);
  });
});
