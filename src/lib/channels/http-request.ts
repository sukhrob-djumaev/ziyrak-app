import type { NextRequest } from "next/server";
import type { NormalizedInboundRequest } from "./types";
import { readBoundedBody, readBoundedJson } from "@/lib/http/bounded-body";

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

/** Twilio webhooks: `application/x-www-form-urlencoded`. */
export async function normalizeFormRequest(
  request: NextRequest,
  routeParams: Record<string, string> = {}
): Promise<NormalizedInboundRequest> {
  // F06: bounded read first; the parsed result never exceeds the byte limit.
  const raw = await readBoundedBody(request);
  const contentType = request.headers.get("content-type") ?? "";
  const formParams: Record<string, string> = {};
  if (/multipart\/form-data/i.test(contentType)) {
    const formData = await new Response(new Uint8Array(raw), { headers: { "content-type": contentType } }).formData();
    formData.forEach((value, key) => {
      formParams[key] = String(value);
    });
  } else {
    new URLSearchParams(raw.toString("utf8")).forEach((value, key) => {
      formParams[key] = value;
    });
  }

  return {
    headers: headersToObject(request.headers),
    routeParams,
    formParams,
    url: request.url,
  };
}

/** Telegram/WebChat webhooks: `application/json`. */
export async function normalizeJsonRequest(
  request: NextRequest,
  routeParams: Record<string, string> = {}
): Promise<NormalizedInboundRequest> {
  // Oversized or stalled bodies throw (PayloadTooLargeError / BodyDeadlineError); malformed JSON is undefined.
  const json = await readBoundedJson(request);

  return {
    headers: headersToObject(request.headers),
    routeParams,
    json,
    url: request.url,
  };
}
