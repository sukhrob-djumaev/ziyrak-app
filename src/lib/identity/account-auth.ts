import { NextRequest, NextResponse } from "next/server";
import { verifyActiveToken, type TokenPayload } from "./auth";
import { prisma } from "@/lib/prisma/raw-client";
export interface AccountContext {
  user: {
    id: string;
    username: string;
    name: string;
    platformRole: "super_admin" | "operator" | null;
  };
  session: TokenPayload;
}
export async function requireAccountAuth(
  request: NextRequest
): Promise<AccountContext | NextResponse> {
  if (request.headers.has("x-api-key"))
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "A signed-in person is required" } },
      { status: 403 }
    );
  const token = request.cookies.get("owly-token")?.value;
  const payload = token ? await verifyActiveToken(token) : null;
  if (!payload)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Sign in to continue" } },
      { status: 401 }
    );
  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, username: true, name: true, platformRole: true },
  });
  if (!user)
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Sign in to continue" } },
      { status: 401 }
    );
  return { user, session: payload };
}
export function isAccountAuthenticated(
  result: AccountContext | NextResponse
): result is AccountContext {
  return !(result instanceof NextResponse);
}
