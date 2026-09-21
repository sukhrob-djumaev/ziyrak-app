import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import { createTicketTool } from "@/lib/tools/builtin/create-ticket";
import { assignToPersonTool } from "@/lib/tools/builtin/assign-to-person";
import { sendInternalEmailTool } from "@/lib/tools/builtin/send-internal-email";
import { getCustomerHistoryTool } from "@/lib/tools/builtin/get-customer-history";
import { triggerWebhookTool } from "@/lib/tools/builtin/trigger-webhook";
import type { TenantContext } from "@/lib/tenancy/context";

// The SSRF-hardened dispatcher itself has its own dedicated suite
// (tests/security/http-dispatcher-ssrf.test.ts) — mocked here so this
// file only tests this tool's own lookup/wiring logic.
vi.mock("@/lib/integrations/http-dispatcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/http-dispatcher")>();
  return { ...actual, dispatchHttpRequest: vi.fn() };
});

/**
 * PLAN.md §23.2 — these tools were mechanically extracted from the old
 * `tools/tools.ts` switch statement into `tools/builtin/*.ts`, one module
 * per tool, each now a `ToolDefinition` with a Zod schema instead of a
 * hand-written JSON-schema block. This suite tests each tool's own
 * `execute()` directly — the same pre-existing per-tool logic, unchanged —
 * rather than going through `ToolRegistry.execute()` (that's
 * `tests/unit/tool-registry.test.ts`'s job: authorization, idempotency,
 * ActionExecution recording, and the approval workflow).
 */

const ctx: TenantContext = {
  businessId: "test-biz",
  role: "admin",
  actor: { kind: "user", userId: "test-user" },
  dataConnection: "shared-default",
};

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: vi.fn().mockResolvedValue({ messageId: "test-id" }),
    }),
  },
}));

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("Built-in tools (tools/builtin/*)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    for (const model of Object.values(mockPrisma)) {
      if (typeof model !== "object" || model === null) continue;
      for (const method of Object.values(model)) {
        if (typeof method === "function" && "mockReset" in method) {
          (method as ReturnType<typeof vi.fn>).mockReset();
        }
      }
    }
  });

  describe("create_ticket", () => {
    it("creates a ticket with correct fields", async () => {
      mockPrisma.department.findFirst.mockResolvedValue({ id: "dept-1", name: "Support" });
      mockPrisma.ticket.create.mockResolvedValue({ id: "ticket-1", title: "Login issue", priority: "high" });

      const result = await createTicketTool.execute(
        ctx,
        { title: "Login issue", description: "Cannot login", priority: "high", department: "Support" },
        { conversationId: "conv-1" }
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe("succeeded");
      expect((result.data as { ticketId: string }).ticketId).toBe("ticket-1");
      expect(mockPrisma.ticket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: "Login issue",
            description: "Cannot login",
            priority: "high",
            conversationId: "conv-1",
            departmentId: "dept-1",
          }),
        })
      );
    });

    it("creates ticket without department when not found", async () => {
      mockPrisma.department.findFirst.mockResolvedValue(null);
      mockPrisma.ticket.create.mockResolvedValue({ id: "ticket-2", title: "Issue", priority: "medium" });

      const result = await createTicketTool.execute(
        ctx,
        { title: "Issue", description: "Details", priority: "medium" },
        {}
      );

      expect(result.success).toBe(true);
    });
  });

  describe("assign_to_person", () => {
    it("assigns ticket to matching team member", async () => {
      mockPrisma.teamMember.findFirst.mockResolvedValue({ id: "member-1", name: "Jane", department: { name: "Billing" } });
      mockPrisma.ticket.update.mockResolvedValue({});

      const result = await assignToPersonTool.execute(ctx, { ticketId: "ticket-1", expertise: "billing" }, {});

      expect(result.success).toBe(true);
      expect((result.data as { assignedTo: string }).assignedTo).toBe("Jane");
      expect(mockPrisma.ticket.update).toHaveBeenCalledWith({
        where: { id: "ticket-1" },
        data: { assignedToId: "member-1", status: "in_progress" },
      });
    });

    it("returns failure when no matching member found", async () => {
      mockPrisma.teamMember.findFirst.mockResolvedValue(null);

      const result = await assignToPersonTool.execute(ctx, { ticketId: "ticket-1", expertise: "quantum-physics" }, {});

      expect(result.success).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.message).toContain("No available team member");
    });
  });

  describe("send_internal_email", () => {
    it("sends email when SMTP is configured", async () => {
      mockPrisma.settings.findFirst.mockResolvedValue({
        smtpHost: "smtp.test.com",
        smtpPort: 587,
        smtpUser: "user@test.com",
        smtpPass: "pass",
        smtpFrom: "support@test.com",
      });

      const result = await sendInternalEmailTool.execute(
        ctx,
        { to: "team@test.com", subject: "Urgent issue", body: "Please check ticket #123" },
        {}
      );

      expect(result.success).toBe(true);
    });

    it("returns failure when SMTP not configured", async () => {
      mockPrisma.settings.findFirst.mockResolvedValue({ smtpHost: null });

      const result = await sendInternalEmailTool.execute(ctx, { to: "team@test.com", subject: "Test", body: "Test body" }, {});

      expect(result.success).toBe(false);
      expect(result.message).toContain("Email not configured");
    });
  });

  describe("get_customer_history", () => {
    it("returns conversation history", async () => {
      mockPrisma.conversation.findMany.mockResolvedValue([
        {
          channel: "whatsapp",
          status: "resolved",
          createdAt: new Date("2025-01-01"),
          summary: "Billing inquiry",
          messages: [
            { role: "customer", content: "Help with bill" },
            { role: "assistant", content: "Let me check" },
          ],
        },
      ]);

      const result = await getCustomerHistoryTool.execute(ctx, { customerContact: "+1555" }, {});

      expect(result.success).toBe(true);
      const data = result.data as { history: Array<{ channel: string }> };
      expect(data.history).toHaveLength(1);
      expect(data.history[0].channel).toBe("whatsapp");
    });

    it("returns empty history for new customer", async () => {
      mockPrisma.conversation.findMany.mockResolvedValue([]);

      const result = await getCustomerHistoryTool.execute(ctx, { customerContact: "+9999" }, {});

      expect(result.success).toBe(true);
      expect((result.data as { history: unknown[] }).history).toHaveLength(0);
      expect(result.message).toContain("No previous conversations");
    });
  });

  describe("trigger_webhook", () => {
    it("dispatches the webhook when found and active, via the shared SSRF-hardened dispatcher", async () => {
      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: "wh-1",
        name: "Slack",
        url: "https://hooks.slack.example/test",
        method: "POST",
        headers: {},
      });

      const { dispatchHttpRequest } = await import("@/lib/integrations/http-dispatcher");
      vi.mocked(dispatchHttpRequest).mockResolvedValue({ ok: true, status: 200, statusText: "OK" });

      const result = await triggerWebhookTool.execute(ctx, { webhookName: "Slack", data: { event: "ticket_created" } }, {});

      expect(result.success).toBe(true);
      expect(dispatchHttpRequest).toHaveBeenCalledWith(
        "https://hooks.slack.example/test",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("returns failure when webhook not found", async () => {
      mockPrisma.webhook.findFirst.mockResolvedValue(null);

      const result = await triggerWebhookTool.execute(ctx, { webhookName: "NonExistent" }, {});

      expect(result.success).toBe(false);
      expect(result.message).toContain("No active webhook");
    });

    it("reports an SSRF rejection as a normal tool failure, not a thrown error", async () => {
      mockPrisma.webhook.findFirst.mockResolvedValue({
        id: "wh-2",
        name: "Internal",
        url: "http://169.254.169.254/latest/meta-data/",
        method: "POST",
        headers: {},
      });

      const { dispatchHttpRequest, SSRFBlockedError } = await import("@/lib/integrations/http-dispatcher");
      vi.mocked(dispatchHttpRequest).mockRejectedValue(new SSRFBlockedError("http://169.254.169.254/", "resolves to a disallowed address"));

      const result = await triggerWebhookTool.execute(ctx, { webhookName: "Internal" }, {});

      expect(result.success).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.message).toContain("Refusing to dispatch");
    });
  });
});
