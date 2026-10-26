import { describe, it, expect, vi, afterEach } from "vitest";
import { submitJson } from "@/lib/http/submit-json";

const reply = (status: number, body?: unknown) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
afterEach(() => vi.restoreAllMocks());

describe("submitJson (D05: no false success)", () => {
  it("reports success only for a 2xx", async () => {
    reply(200, { id: "1" });
    expect(await submitJson("/x", "POST", { a: 1 })).toEqual({ ok: true, data: { id: "1" } });
  });
  it.each([
    [400, { error: "URL must be https" }, "URL must be https"],
    [422, { error: { code: "X", message: "Name is required" } }, "Name is required"],
    [401, undefined, /signed out/],
    [403, undefined, /role does not allow/],
    [404, undefined, /no longer exists/],
    [409, undefined, /same time/],
    [429, undefined, /Too many/],
    [500, undefined, /could not save/],
  ])("turns HTTP %s into a message and never ok", async (status, body, expected) => {
    reply(status as number, body);
    const r = await submitJson("/x", "PUT", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(status);
      if (typeof expected === "string") expect(r.message).toBe(expected);
      else expect(r.message).toMatch(expected as RegExp);
    }
  });
  it("turns a network failure into a retry message", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const r = await submitJson("/x", "POST", {});
    expect(r).toMatchObject({ ok: false, status: 0 });
    if (!r.ok) expect(r.message).toMatch(/Could not reach the server/);
  });
  it("tolerates a non-JSON failure body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    const r = await submitJson("/x", "POST", {});
    expect(r.ok).toBe(false);
  });
});
