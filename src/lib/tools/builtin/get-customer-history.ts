import { z } from "zod";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { ToolDefinition } from "../types";

const schema = z.object({
  customerContact: z.string().describe("Customer's contact info (phone number or email address)"),
  customerId: z
    .string()
    .optional()
    .describe("Customer's unique ID for cross-channel history lookup. Use this when available for more complete history."),
});

/** PLAN.md §23.2 — mechanical extraction of `tools.ts`'s `getCustomerHistory()` branch; logic unchanged. */
export const getCustomerHistoryTool: ToolDefinition = {
  name: "get_customer_history",
  description: "Retrieve the customer's previous conversation history across all channels to provide context-aware support.",
  schema,
  requiredPermission: "customers:read",
  async execute(ctx, args) {
    const { customerContact, customerId } = schema.parse(args);
    const db = getScopedPrisma(ctx);

    const where = customerId ? { customerId } : { customerContact };

    const conversations = await db.conversation.findMany({
      where,
      include: { messages: { take: 5, orderBy: { createdAt: "desc" } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    if (conversations.length === 0) {
      return {
        success: true,
        status: "succeeded",
        message: "No previous conversations found for this customer.",
        data: { history: [] },
      };
    }

    const history = conversations.map((conv) => ({
      channel: conv.channel,
      status: conv.status,
      date: conv.createdAt,
      summary: conv.summary,
      messageCount: conv.messages.length,
      lastMessages: conv.messages.map((m) => ({ role: m.role, content: m.content.substring(0, 200) })),
    }));

    return {
      success: true,
      status: "succeeded",
      message: `Found ${history.length} previous conversation(s) for this customer.`,
      data: { history },
    };
  },
};
