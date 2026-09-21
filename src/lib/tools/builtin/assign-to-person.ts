import { z } from "zod";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { ToolDefinition } from "../types";

const schema = z.object({
  ticketId: z.string().describe("The ticket ID to assign"),
  expertise: z
    .string()
    .describe("The expertise area needed to resolve this issue. The system will find the best matching team member."),
});

/** PLAN.md §23.2 — mechanical extraction of `tools.ts`'s `assignToPerson()` branch; logic unchanged. */
export const assignToPersonTool: ToolDefinition = {
  name: "assign_to_person",
  description: "Assign a ticket or issue to a specific team member based on their expertise.",
  schema,
  requiredPermission: "tickets:update",
  async execute(ctx, args) {
    const { ticketId, expertise } = schema.parse(args);
    const db = getScopedPrisma(ctx);

    const member = await db.teamMember.findFirst({
      where: { expertise: { contains: expertise, mode: "insensitive" }, isAvailable: true },
      include: { department: true },
    });

    if (!member) {
      return {
        success: false,
        status: "failed",
        message: `No available team member found with expertise in: ${expertise}`,
      };
    }

    await db.ticket.update({
      where: { id: ticketId },
      data: { assignedToId: member.id, status: "in_progress" },
    });

    return {
      success: true,
      status: "succeeded",
      message: `Ticket assigned to ${member.name} (${member.department.name})`,
      data: { assignedTo: member.name, department: member.department.name },
    };
  },
};
