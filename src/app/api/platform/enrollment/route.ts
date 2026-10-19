import { NextRequest, NextResponse } from "next/server";
import { requireAccountAuth, isAccountAuthenticated } from "@/lib/identity/account-auth";
import {
  bootstrapPlatform,
  recoverPlatform,
  readPlatformEntry,
} from "@/lib/platform/access/authority";
import { checkRateLimit } from "@/lib/rate-limit";
import { toErrorResponse } from "@/lib/observability/errors";

const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return account;
  try {
    return NextResponse.json(await readPlatformEntry(request.cookies.get("owly-token")!.value), {
      headers,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
export async function POST(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return account;
  // Cookie-authenticated privileged writes require same-origin JSON, including
  // requests that pass an optional global CORS policy at the proxy boundary.
  if (
    request.headers.get("origin") !== request.nextUrl.origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return NextResponse.json(
      { error: { message: "A same-origin request is required" } },
      { status: 403, headers }
    );
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    return NextResponse.json({ error: { message: "JSON is required" } }, { status: 415, headers });
  const rate = await checkRateLimit(`platform-enrollment:actor:${account.user.id}`, {
    maxRequests: 5,
    windowMs: 60_000,
  });
  if (!rate.allowed)
    return NextResponse.json(
      { error: { message: "Too many enrollment attempts. Try again later." } },
      { status: 429, headers }
    );
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON" } }, { status: 400, headers });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return NextResponse.json(
      { error: { message: "Invalid enrollment request" } },
      { status: 400, headers }
    );
  const { action, ...input } = body as Record<string, unknown>;
  if (action !== "bootstrap" && action !== "recovery")
    return NextResponse.json(
      { error: { message: "Invalid enrollment action" } },
      { status: 400, headers }
    );
  try {
    const token = request.cookies.get("owly-token")!.value;
    const result =
      action === "bootstrap"
        ? await bootstrapPlatform(token, input)
        : await recoverPlatform(token, input);
    return NextResponse.json({ success: true, generation: result.generation }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}
