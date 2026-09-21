import { z } from "zod";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { ToolDefinition } from "../types";

const schema = z.object({
  title: z.string().describe("Brief title describing the issue"),
  description: z.string().describe("Detailed description of the issue"),
  priority: z.enum(["low", "medium", "high", "urgent"]).describe("Priority level of the ticket"),
  department: z.string().optional().describe("Department name to assign the ticket to"),
});

/** PLAN.md §23.2 — mechanical extraction of `tools.ts`'s `createTicket()` branch; logic unchanged. */
export const createTicketTool: ToolDefinition = {
  name: "create_ticket",
  description:
    "Create a support ticket for an issue that needs human attention. Use this when the customer reports a problem that cannot be resolved through the knowledge base.",
  schema,
  requiredPermission: "tickets:create",
  async execute(ctx, args, runtimeCtx) {
    const { title, description, priority, department } = schema.parse(args);
    const db = getScopedPrisma(ctx);

    const departmentRow = department
      ? await db.department.findFirst({ where: { name: { contains: department, mode: "insensitive" } } })
      : null;

    const ticket = await db.ticket.create({
      data: {
        businessId: ctx.businessId,
        title,
        description,
        priority,
        conversationId: runtimeCtx.conversationId || null,
        departmentId: departmentRow?.id || null,
      },
    });

    return {
      success: true,
      status: "succeeded",
      message: `Ticket created: ${ticket.title} (Priority: ${ticket.priority})`,
      data: { ticketId: ticket.id },
    };
  },
};
