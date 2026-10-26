import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { normalizeFormRequest, normalizeJsonRequest } from "@/lib/channels/http-request";
import { PayloadTooLargeError } from "@/lib/http/bounded-body";
import { POST as metaPost } from "@/app/api/channels/whatsapp-cloud/webhook/route";

/** L1.2 / F06: public ingress must bound chunked bodies that carry no Content-Length. */

function chunked(totalBytes: number, chunk = 64 * 1024, headers: Record<string, string> = {}, url = "https://app.test/x") {
  let sent = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      if (sent >= totalBytes) return c.close();
      const n = Math.min(chunk, totalBytes - sent);
      sent += n;
      c.enqueue(new Uint8Array(n).fill(120));
    },
  });
  const request = new NextRequest(url, { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { request, stats: () => ({ sent, pulls }) };
}

describe("public ingress body bounds (F06)", () => {
  it("Meta webhook rejects a chunked body over the limit with 413, without reading all of it", async () => {
    const { request, stats } = chunked(50 * 1024 * 1024, 256 * 1024, { "x-forwarded-for": "198.51.100.7" });
    const res = await metaPost(request);
    expect(res.status).toBe(413);
    expect(stats().sent).toBeLessThan(8 * 1024 * 1024);
  });

  it("JSON normalizer stops a chunked body at its limit", async () => {
    const { request, stats } = chunked(50 * 1024 * 1024, 64 * 1024, { "content-type": "application/json" });
    await expect(normalizeJsonRequest(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(stats().sent).toBeLessThan(2 * 1024 * 1024);
  });

  it("form normalizer stops a chunked body at its limit", async () => {
    const { request } = chunked(50 * 1024 * 1024, 64 * 1024, { "content-type": "application/x-www-form-urlencoded" });
    await expect(normalizeFormRequest(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("still parses normal Twilio-style forms and Telegram-style JSON", async () => {
    const form = new NextRequest("https://app.test/x", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "From=%2B15550001&Body=hi+there",
    });
    expect((await normalizeFormRequest(form)).formParams).toEqual({ From: "+15550001", Body: "hi there" });
    const json = new NextRequest("https://app.test/x", { method: "POST", body: '{"update_id":1}' });
    expect((await normalizeJsonRequest(json)).json).toEqual({ update_id: 1 });
  });
});
