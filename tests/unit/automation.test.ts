import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { evaluateRules } from "@/lib/automation";

const mockPrisma = prisma as unknown as {
  automationRule: {
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

describe("Automation Rule Engine", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPrisma.automationRule.update.mockResolvedValue({});
  });

  const makeRule = (overrides = {}) => ({
    id: "rule-1",
    name: "Test Rule",
    type: "auto_route",
    isActive: true,
    conditions: [
      { field: "message_content", operator: "contains", value: "billing" },
    ],
    actions: [{ type: "route", value: "billing-dept" }],
    priority: 10,
    triggerCount: 0,
    ...overrides,
  });

  it("should match rule with 'contains' operator", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([makeRule()]);

    const result = await evaluateRules(
      { content: "I have a billing question" },
      { id: "conv-1" }
    );

    expect(result).toHaveLength(1);
    expect(result[0].ruleId).toBe("rule-1");
    expect(result[0].actions[0].type).toBe("route");
  });

  it("should match rule with 'equals' operator", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([
      makeRule({
        conditions: [
          { field: "channel", operator: "equals", value: "whatsapp" },
        ],
      }),
    ]);

    const result = await evaluateRules(
      { content: "hello", channel: "whatsapp" },
      { id: "conv-1" }
    );

    expect(result).toHaveLength(1);
  });

  it("should match rule with 'starts_with' operator", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([
      makeRule({
        conditions: [
          {
            field: "message_content",
            operator: "starts_with",
            value: "urgent",
          },
        ],
      }),
    ]);

    const result = await evaluateRules(
      { content: "URGENT: Server is down" },
      { id: "conv-1" }
    );

    expect(result).toHaveLength(1);
  });

  it("should require ALL conditions to match (AND logic)", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([
      makeRule({
        conditions: [
          { field: "message_content", operator: "contains", value: "billing" },
          { field: "channel", operator: "equals", value: "email" },
        ],
      }),
    ]);

    // Only one condition matches
    const result = await evaluateRules(
      { content: "billing issue", channel: "whatsapp" },
      { id: "conv-1" }
    );

    expect(result).toHaveLength(0);
  });

  it("should skip inactive rules", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([]);

    // findMany is called with { where: { isActive: true } }
    const result = await evaluateRules(
      { content: "billing" },
      { id: "conv-1" }
    );

    expect(result).toHaveLength(0);
    expect(mockPrisma.automationRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true },
      })
    );
  });

  it("should return rules ordered by priority", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([
      makeRule({
        id: "rule-high",
        priority: 100,
        conditions: [
          { field: "message_content", operator: "contains", value: "help" },
        ],
      }),
      makeRule({
        id: "rule-low",
        priority: 1,
        conditions: [
          { field: "message_content", operator: "contains", value: "help" },
        ],
      }),
    ]);

    const result = await evaluateRules(
      { content: "I need help" },
      { id: "conv-1" }
    );

    expect(result).toHaveLength(2);
    expect(result[0].ruleId).toBe("rule-high");
    expect(result[1].ruleId).toBe("rule-low");
  });

  it("should return empty array when no rules match", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([makeRule()]);

    const result = await evaluateRules(
      { content: "How is the weather?" },
      { id: "conv-1" }
    );

    expect(result).toHaveLength(0);
  });

  it("should be case-insensitive", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([makeRule()]);

    const result = await evaluateRules(
      { content: "BILLING DEPARTMENT PLEASE" },
      { id: "conv-1" }
    );

    expect(result).toHaveLength(1);
  });

  it("should match multiple rules for same message", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([
      makeRule({ id: "rule-a", priority: 10 }),
      makeRule({
        id: "rule-b",
        priority: 5,
        conditions: [
          { field: "message_content", operator: "contains", value: "billing" },
        ],
      }),
    ]);

    const result = await evaluateRules(
      { content: "billing question" },
      { id: "conv-1" }
    );

    expect(result).toHaveLength(2);
  });

  it("should not match when conditions array is empty", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([
      makeRule({ conditions: [] }),
    ]);

    const result = await evaluateRules(
      { content: "anything" },
      { id: "conv-1" }
    );

    expect(result).toHaveLength(0);
  });

  it("should use conversation channel when message channel is missing", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([
      makeRule({
        conditions: [
          { field: "channel", operator: "equals", value: "phone" },
        ],
      }),
    ]);

    const result = await evaluateRules(
      { content: "hello" },
      { id: "conv-1", channel: "phone" }
    );

    expect(result).toHaveLength(1);
  });

  it("should increment trigger count in background", async () => {
    mockPrisma.automationRule.findMany.mockResolvedValue([makeRule()]);
    mockPrisma.automationRule.update.mockResolvedValue({});

    await evaluateRules({ content: "billing" }, { id: "conv-1" });

    // Allow background promise to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(mockPrisma.automationRule.update).toHaveBeenCalledWith({
      where: { id: "rule-1" },
      data: { triggerCount: { increment: 1 } },
    });
  });
});
