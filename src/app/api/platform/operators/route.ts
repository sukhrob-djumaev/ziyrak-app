import { NextRequest, NextResponse } from "next/server";
import { requireAccountAuth, isAccountAuthenticated } from "@/lib/identity/account-auth";
import {
  assignOperator,
  provisionOperator,
  readOperatorConsole,
  removeOperator,
  resetOperatorMfa,
  revokeAssignment,
} from "@/lib/platform/access/operators";
import {
  inviteOperator,
  revokeOperatorInvitation,
} from "@/lib/platform/access/operator-invitations";
import { checkRateLimit } from "@/lib/rate-limit";
import { toErrorResponse } from "@/lib/observability/errors";

function privateResponse(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export async function GET(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return privateResponse(account);
  try {
    return privateResponse(
      NextResponse.json(await readOperatorConsole(request.cookies.get("owly-token")!.value))
    );
  } catch (error) {
    return privateResponse(toErrorResponse(error));
  }
}
export async function POST(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return privateResponse(account);
  if (
    request.headers.get("origin") !== request.nextUrl.origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return privateResponse(
      NextResponse.json(
        { error: { message: "A same-origin request is required" } },
        { status: 403 }
      )
    );
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    return privateResponse(
      NextResponse.json({ error: { message: "JSON is required" } }, { status: 415 })
    );
  const rate = await checkRateLimit(`platform-operators:actor:${account.user.id}`, {
    maxRequests: 20,
    windowMs: 60_000,
  });
  if (!rate.allowed)
    return privateResponse(
      NextResponse.json(
        { error: { message: "Too many management attempts. Try again later." } },
        { status: 429 }
      )
    );
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      return privateResponse(
        NextResponse.json({ error: { message: "Invalid management request" } }, { status: 400 })
      );
    const { action, ...input } = body as Record<string, unknown>;
    const token = request.cookies.get("owly-token")!.value;
    let result;
    switch (action) {
      case "reset-mfa":
        result = await resetOperatorMfa(token, input);
        break;
      case "provision":
        result = await provisionOperator(token, input);
        break;
      case "invite":
        result = await inviteOperator(token, input);
        break;
      case "revokeInvitation":
        result = await revokeOperatorInvitation(token, input);
        break;
      case "assign":
        result = await assignOperator(token, input);
        break;
      case "revoke":
        result = await revokeAssignment(token, input);
        break;
      case "remove":
        result = await removeOperator(token, input);
        break;
      default:
        return privateResponse(
          NextResponse.json({ error: { message: "Invalid management action" } }, { status: 400 })
        );
    }
    return privateResponse(NextResponse.json({ success: true, result }));
  } catch (error) {
    if (error instanceof SyntaxError)
      return privateResponse(
        NextResponse.json({ error: { message: "Invalid JSON" } }, { status: 400 })
      );
    return privateResponse(toErrorResponse(error));
  }
}
