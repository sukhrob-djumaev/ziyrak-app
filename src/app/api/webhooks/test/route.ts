import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import * as webhooksService from "@/lib/integrations/webhooks/service";
import { NotFoundError } from "@/lib/observability/errors";
import { dispatchHttpRequest, SSRFBlockedError } from "@/lib/integrations/http-dispatcher";

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "webhooks:update");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { webhookId } = body;

    if (!webhookId) {
      return NextResponse.json(
        { error: "webhookId is required" },
        { status: 400 }
      );
    }

    const webhook = await webhooksService.getById(ctx, webhookId).catch((error) => {
      if (error instanceof NotFoundError) return null;
      throw error;
    });

    if (!webhook) {
      return NextResponse.json(
        { error: "Webhook not found" },
        { status: 404 }
      );
    }

    const testPayload = {
      event: webhook.triggerOn,
      test: true,
      timestamp: new Date().toISOString(),
      data: {
        id: "test_123",
        message: "This is a test payload from Owly",
        webhookName: webhook.name,
        triggerEvent: webhook.triggerOn,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Owly-Webhook/1.0",
      ...(typeof webhook.headers === "object" && webhook.headers !== null
        ? (webhook.headers as Record<string, string>)
        : {}),
    };

    // PLAN.md §32.1/§46.6 — routed through the shared SSRF-hardened
    // dispatcher, closing the third of the three call sites §32's own
    // security table named (`trigger_webhook`, `webhook-delivery.ts`, and
    // this "test webhook" route all previously called a raw, unprotected
    // `fetch()` against an admin-configured URL).
    const response = await dispatchHttpRequest(webhook.url, {
      method: webhook.method,
      headers,
      body: webhook.method !== "GET" ? JSON.stringify(testPayload) : undefined,
      timeoutMs: 10000,
      includeResponseBody: true,
    });

    const responseBody = response.body ?? "(unable to read response body)";

    // Limit preview length
    const bodyPreview =
      responseBody.length > 1000
        ? responseBody.slice(0, 1000) + "..."
        : responseBody;

    return NextResponse.json({
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      bodyPreview,
      sentPayload: testPayload,
    });
  } catch (error) {
    const message =
      error instanceof SSRFBlockedError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Failed to send test webhook";

    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      { status: 500 }
    );
  }
}
