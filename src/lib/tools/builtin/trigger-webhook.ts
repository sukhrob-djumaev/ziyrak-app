import { z } from "zod";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { dispatchHttpRequest, SSRFBlockedError } from "@/lib/integrations/http-dispatcher";
import type { ToolDefinition } from "../types";

const schema = z.object({
  webhookName: z.string().describe("Name of the webhook to trigger"),
  data: z.record(z.string(), z.unknown()).optional().describe("Data payload to send with the webhook"),
});

/**
 * PLAN.md §23.2/§32.1 — mechanical extraction of `tools.ts`'s
 * `triggerWebhook()` branch, with its previously-nonexistent SSRF
 * protection (§2.4/§32, "no allowlist/deny-private-IP-range check of any
 * kind" — verified) now routed through the shared, DNS-resolution-aware
 * dispatcher instead of a raw `fetch()`.
 */
export const triggerWebhookTool: ToolDefinition = {
  name: "trigger_webhook",
  description: "Trigger a configured webhook to notify an external system about an event.",
  schema,
  requiredPermission: "webhooks:update",
  async execute(ctx, args) {
    const { webhookName, data } = schema.parse(args);
    const db = getScopedPrisma(ctx);

    const webhook = await db.webhook.findFirst({
      where: { name: { contains: webhookName, mode: "insensitive" }, isActive: true },
    });

    if (!webhook) {
      return {
        success: false,
        status: "failed",
        message: `No active webhook found with name: ${webhookName}`,
      };
    }

    try {
      const response = await dispatchHttpRequest(webhook.url, {
        method: webhook.method,
        headers: { "Content-Type": "application/json", ...(webhook.headers as Record<string, string>) },
        body: JSON.stringify(data || {}),
        timeoutMs: 10000,
      });

      return {
        success: response.ok,
        status: response.ok ? "succeeded" : "failed",
        message: response.ok
          ? `Webhook "${webhook.name}" triggered successfully`
          : `Webhook failed with status ${response.status}`,
        data: { status: response.status },
      };
    } catch (error) {
      const message =
        error instanceof SSRFBlockedError
          ? error.message
          : error instanceof Error && error.name === "AbortError"
            ? "Webhook request timed out"
            : `Webhook request failed: ${error instanceof Error ? error.message : "Unknown error"}`;
      return { success: false, status: "failed", message };
    }
  },
};
