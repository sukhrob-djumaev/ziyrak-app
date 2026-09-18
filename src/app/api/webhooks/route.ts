import { NextRequest, NextResponse } from "next/server";
import { parsePagination, paginatedResponse } from "@/lib/pagination";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { toErrorResponse } from "@/lib/observability/errors";
import * as webhooksService from "@/lib/integrations/webhooks/service";

export async function GET(request: NextRequest) {
  const ctx = await requireAuth(request, "webhooks:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const { searchParams } = new URL(request.url);
    const { page, limit, skip, take } = parsePagination(searchParams);

    const { webhooks, total } = await webhooksService.list(ctx, { skip, take });

    return NextResponse.json(paginatedResponse(webhooks, total, page, limit));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "webhooks:create");
  if (!isAuthenticated(ctx)) return ctx;

  const body = await request.json();
  const { name, description, url, method, headers, triggerOn } = body;

  if (!name || !url || !triggerOn) {
    return NextResponse.json(
      { error: "Name, URL, and triggerOn are required" },
      { status: 400 }
    );
  }

  try {
    const webhook = await webhooksService.create(ctx, { name, description, url, method, headers, triggerOn });
    return NextResponse.json(webhook, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
