import { prisma } from "@/lib/prisma/raw-client";
import { scopeFromRecord } from "@/lib/tenancy/resource-scope";
/** Account-level discovery: own active memberships only, no tenant content. */
export async function listAccountWorkspaces(userId: string) {
  const rows = await prisma.membership.findMany({
    where: { userId, business: { status: "active" } },
    include: { connectionScopes: true, business: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.flatMap((row) => {
    try {
      scopeFromRecord(row);
      return [{ id: row.business.id, name: row.business.name, role: row.role }];
    } catch {
      return [];
    }
  });
}
