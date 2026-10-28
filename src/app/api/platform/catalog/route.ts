import { NextRequest, NextResponse } from "next/server";
import { requireAccountAuth, isAccountAuthenticated } from "@/lib/identity/account-auth";
import { archiveVersion, createItem, newDraft, publishVersion, readCatalogConsole, saveDraft } from "@/lib/billing/catalog";
import { assignVersion, endPurchase, setAdjustment } from "@/lib/billing/purchases";
import { checkRateLimit } from "@/lib/rate-limit";
import { toErrorResponse } from "@/lib/observability/errors";

/** L4.1a - super-admin-only catalog management. Operators and tenants have no path here. */
function privateResponse(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
const fail = (message: string, status: number) => privateResponse(NextResponse.json({ error: { message } }, { status }));

export async function GET(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return privateResponse(account);
  try {
    return privateResponse(NextResponse.json(await readCatalogConsole(request.cookies.get("owly-token")!.value)));
  } catch (error) {
    return privateResponse(toErrorResponse(error));
  }
}

export async function POST(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return privateResponse(account);
  if (request.headers.get("origin") !== request.nextUrl.origin || request.headers.get("sec-fetch-site") === "cross-site")
    return fail("A same-origin request is required", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return fail("JSON is required", 415);
  const rate = await checkRateLimit(`platform-catalog:actor:${account.user.id}`, { maxRequests: 30, windowMs: 60_000 });
  if (!rate.allowed) return fail("Too many catalog changes. Try again later.", 429);
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Invalid catalog request", 400);
    const { action, ...input } = body as Record<string, unknown>;
    const token = request.cookies.get("owly-token")!.value;
    let result;
    switch (action) {
      case "create_item":
        result = await createItem(token, input);
        break;
      case "save_draft":
        result = await saveDraft(token, input);
        break;
      case "new_draft":
        result = await newDraft(token, input);
        break;
      case "publish":
        result = await publishVersion(token, input);
        break;
      case "archive":
        result = await archiveVersion(token, input);
        break;
      case "assign_version":
        result = await assignVersion(token, input);
        break;
      case "end_purchase":
        result = await endPurchase(token, input);
        break;
      case "set_adjustment":
        result = await setAdjustment(token, input);
        break;
      default:
        return fail("Invalid catalog action", 400);
    }
    return privateResponse(NextResponse.json({ success: true, result }));
  } catch (error) {
    if (error instanceof SyntaxError) return fail("Invalid JSON", 400);
    return privateResponse(toErrorResponse(error));
  }
}
