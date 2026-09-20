import type { NextRequest } from "next/server";
import type { NormalizedInboundRequest } from "./types";

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
  const formData = await request.formData();
  const formParams: Record<string, string> = {};
  formData.forEach((value, key) => {
    formParams[key] = String(value);
  });

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
  const json = await request.json().catch(() => undefined);

  return {
    headers: headersToObject(request.headers),
    routeParams,
    json,
    url: request.url,
  };
}
