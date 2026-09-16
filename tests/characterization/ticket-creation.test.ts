import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { executeToolCall } from "@/lib/ai/tools";

/**
 * Characterization suite (§46.0): pins today's behavior of the AI's
 * create_ticket tool call — a Ticket row is created against the
 * single-tenant schema. Re-run after Phase 1's migration to confirm
 * the same tool call still produces an equivalent Ticket row.
 */

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("Characterization: create_ticket tool persists a Ticket row", () => {
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

  it("creates a Ticket row linked to the conversation, with the given title/priority/department", async () => {
    mockPrisma.department.findFirst.mockResolvedValue({ id: "dept-1", name: "Technical Support" });
    mockPrisma.ticket.create.mockResolvedValue({
      id: "ticket-char-1",
      title: "Order not delivered",
      priority: "high",
      status: "open",
      conversationId: "conv-1",
      departmentId: "dept-1",
    });

    const result = JSON.parse(
      await executeToolCall(
        "create_ticket",
        {
          title: "Order not delivered",
          description: "Customer reports order #123 not delivered",
          priority: "high",
          department: "Technical Support",
        },
        "conv-1"
      )
    );

    expect(result.success).toBe(true);
    expect(result.ticketId).toBe("ticket-char-1");
    expect(mockPrisma.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Order not delivered",
          description: "Customer reports order #123 not delivered",
          priority: "high",
          conversationId: "conv-1",
          departmentId: "dept-1",
        }),
      })
    );
  });
});
