import { NextRequest, NextResponse } from "next/server";
import { requireAccountAuth, isAccountAuthenticated } from "@/lib/identity/account-auth";
import { readAiServiceConsole, savePolicy, setWorkspaceAllowance } from "@/lib/platform/ai-service";
import { checkRateLimit } from "@/lib/rate-limit";
import { toErrorResponse } from "@/lib/observability/errors";

/** PLAN.md P2 — super-admin-only managed AI policy and allowance management. */
function privateResponse(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
const fail = (message: string, status: number) =>
  privateResponse(NextResponse.json({ error: { message } }, { status }));

export async function GET(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return privateResponse(account);
  try {
    return privateResponse(NextResponse.json(await readAiServiceConsole(request.cookies.get("owly-token")!.value)));
  } catch (error) {
    return privateResponse(toErrorResponse(error));
  }
}

export async function POST(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return privateResponse(account);
  if (request.headers.get("origin") !== request.nextUrl.origin || request.headers.get("sec-fetch-site") === "cross-site")
    return fail("A same-origin request is required", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return fail("JSON is required", 415);
  const rate = await checkRateLimit(`platform-ai-service:actor:${account.user.id}`, { maxRequests: 20, windowMs: 60_000 });
  if (!rate.allowed) return fail("Too many management attempts. Try again later.", 429);
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid management request", 400);
    const { action, ...input } = body as Record<string, unknown>;
    const token = request.cookies.get("owly-token")!.value;
    let result;
    switch (action) {
      case "save_policy":
        result = await savePolicy(token, input);
        break;
      case "set_allowance":
        result = await setWorkspaceAllowance(token, input);
        break;
      default:
        return fail("Invalid management action", 400);
    }
    return privateResponse(NextResponse.json({ success: true, result }));
  } catch (error) {
    if (error instanceof SyntaxError) return fail("Invalid JSON", 400);
    return privateResponse(toErrorResponse(error));
  }
}
