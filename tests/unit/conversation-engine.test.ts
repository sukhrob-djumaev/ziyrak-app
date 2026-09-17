import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma/raw-client";
import type { TenantContext } from "@/lib/tenancy/context";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

// getScopedPrisma(ctx) resolves to this same mocked client under the global
// tests/setup.ts mock (its `$extends` is a passthrough) — this fixture just
// needs to be a structurally valid TenantContext with dataConnection
// "shared-default", per src/lib/tenancy/placement.ts's mock-friendly path.
const ctx: TenantContext = {
  businessId: "test-biz",
  role: "admin",
  actor: { kind: "user", userId: "test-user" },
  dataConnection: "shared-default",
};

describe("Conversation Engine", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("routeConversation", () => {
    it("should route to skill-matched member", async () => {
      mockPrisma.teamMember.findMany.mockResolvedValue([
        { id: "m1", name: "Alice", expertise: "billing", department: { name: "Finance" }, _count: { tickets: 2 } },
        { id: "m2", name: "Bob", expertise: "technical", department: { name: "Support" }, _count: { tickets: 5 } },
      ]);

      const { routeConversation } = await import("@/lib/conversation-engine");
      const result = await routeConversation(ctx, "skill_based", "billing");

      expect(result).not.toBeNull();
      expect(result!.assignedToName).toBe("Alice");
    });

    it("should route to least busy member", async () => {
      mockPrisma.teamMember.findMany.mockResolvedValue([
        { id: "m1", name: "Alice", department: { name: "Support" }, _count: { tickets: 10 } },
        { id: "m2", name: "Bob", department: { name: "Support" }, _count: { tickets: 2 } },
      ]);

      const { routeConversation } = await import("@/lib/conversation-engine");
      const result = await routeConversation(ctx, "least_busy");

      expect(result).not.toBeNull();
      expect(result!.assignedToName).toBe("Bob");
    });

    it("should return null when no members available", async () => {
      mockPrisma.teamMember.findMany.mockResolvedValue([]);

      const { routeConversation } = await import("@/lib/conversation-engine");
      const result = await routeConversation(ctx);

      expect(result).toBeNull();
    });
  });

  describe("mergeConversations", () => {
    it("should merge secondary into primary", async () => {
      mockPrisma.conversation.findUnique
        .mockResolvedValueOnce({ id: "primary", customerName: "John" })
        .mockResolvedValueOnce({ id: "secondary", customerName: "John", channel: "email" });
      mockPrisma.message.updateMany.mockResolvedValue({ count: 5 });
      mockPrisma.ticket.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.internalNote.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.internalNote.create.mockResolvedValue({});
      mockPrisma.conversation.update.mockResolvedValue({});

      const { mergeConversations } = await import("@/lib/conversation-engine");
      const result = await mergeConversations(ctx, "primary", "secondary");

      expect(result).toBe(true);
      expect(mockPrisma.message.updateMany).toHaveBeenCalledWith({
        where: { conversationId: "secondary" },
        data: { conversationId: "primary" },
      });
    });

    it("should return false if conversation not found", async () => {
      mockPrisma.conversation.findUnique.mockResolvedValue(null);

      const { mergeConversations } = await import("@/lib/conversation-engine");
      const result = await mergeConversations(ctx, "nonexistent", "other");

      expect(result).toBe(false);
    });
  });

  describe("executeMacro", () => {
    it("should execute multiple actions", async () => {
      mockPrisma.conversation.update.mockResolvedValue({});
      mockPrisma.internalNote.create.mockResolvedValue({});

      const { executeMacro } = await import("@/lib/conversation-engine");
      const result = await executeMacro(ctx, "conv-1", [
        { type: "set_status", value: "resolved" },
        { type: "add_note", value: "Issue resolved" },
      ], "Admin");

      expect(result.executed).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it("should handle unknown action types", async () => {
      const { executeMacro } = await import("@/lib/conversation-engine");
      const result = await executeMacro(ctx, "conv-1", [
        { type: "unknown_action", value: "test" },
      ], "Admin");

      expect(result.executed).toBe(0);
      expect(result.errors).toHaveLength(1);
    });
  });
});
