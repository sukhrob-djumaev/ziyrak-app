import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";

const mockPrisma = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

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
      const result = await routeConversation("conv-1", "skill_based", "billing");

      expect(result).not.toBeNull();
      expect(result!.assignedToName).toBe("Alice");
    });

    it("should route to least busy member", async () => {
      mockPrisma.teamMember.findMany.mockResolvedValue([
        { id: "m1", name: "Alice", department: { name: "Support" }, _count: { tickets: 10 } },
        { id: "m2", name: "Bob", department: { name: "Support" }, _count: { tickets: 2 } },
      ]);

      const { routeConversation } = await import("@/lib/conversation-engine");
      const result = await routeConversation("conv-1", "least_busy");

      expect(result).not.toBeNull();
      expect(result!.assignedToName).toBe("Bob");
    });

    it("should return null when no members available", async () => {
      mockPrisma.teamMember.findMany.mockResolvedValue([]);

      const { routeConversation } = await import("@/lib/conversation-engine");
      const result = await routeConversation("conv-1");

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
      const result = await mergeConversations("primary", "secondary");

      expect(result).toBe(true);
      expect(mockPrisma.message.updateMany).toHaveBeenCalledWith({
        where: { conversationId: "secondary" },
        data: { conversationId: "primary" },
      });
    });

    it("should return false if conversation not found", async () => {
      mockPrisma.conversation.findUnique.mockResolvedValue(null);

      const { mergeConversations } = await import("@/lib/conversation-engine");
      const result = await mergeConversations("nonexistent", "other");

      expect(result).toBe(false);
    });
  });

  describe("executeMacro", () => {
    it("should execute multiple actions", async () => {
      mockPrisma.conversation.update.mockResolvedValue({});
      mockPrisma.internalNote.create.mockResolvedValue({});

      const { executeMacro } = await import("@/lib/conversation-engine");
      const result = await executeMacro("conv-1", [
        { type: "set_status", value: "resolved" },
        { type: "add_note", value: "Issue resolved" },
      ], "Admin");

      expect(result.executed).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it("should handle unknown action types", async () => {
      const { executeMacro } = await import("@/lib/conversation-engine");
      const result = await executeMacro("conv-1", [
        { type: "unknown_action", value: "test" },
      ], "Admin");

      expect(result.executed).toBe(0);
      expect(result.errors).toHaveLength(1);
    });
  });
});
