import { NextRequest, NextResponse } from "next/server";
import { requireAccountAuth, isAccountAuthenticated } from "@/lib/identity/account-auth";
import { resolveHumanContext } from "@/lib/identity/route-auth";
import { workspaceCookie } from "@/lib/identity/workspace-cookie";
import { listAccountWorkspaces } from "@/lib/platform/workspaces";
import { toErrorResponse } from "@/lib/observability/errors";

export async function GET(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return account;
  try {
    const workspaces = await listAccountWorkspaces(account.user.id);
    return NextResponse.json({ workspaces }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
export async function POST(request: NextRequest) {
  const account = await requireAccountAuth(request);
  if (!isAccountAuthenticated(account)) return account;
  try {
    const body = await request.json();
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((field) => field !== "workspaceId") ||
      typeof body.workspaceId !== "string" ||
      !body.workspaceId.trim() ||
      body.workspaceId.length > 128
    )
      return NextResponse.json({ error: { message: "Choose a valid workspace" } }, { status: 400 });
    const resolved = await resolveHumanContext(account.user.id, body.workspaceId, account.session);
    if (!resolved.ok)
      return NextResponse.json(
        { error: { message: "The selected workspace is unavailable" } },
        { status: 403 }
      );
    const response = NextResponse.json({ success: true, workspaceId: resolved.ctx.businessId });
    response.cookies.set(workspaceCookie(resolved.ctx.businessId));
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
