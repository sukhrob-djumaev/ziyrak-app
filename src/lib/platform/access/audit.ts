import type { Prisma } from "@/generated/prisma/client";

export interface PlatformAuditInput {
  actorUserId: string;
  action: string;
  reason: string;
  businessId?: string;
  grantId?: string;
  details: Prisma.InputJsonValue;
}

/** Mandatory control-plane audit: callers must await it in their mutation transaction. */
export async function writePlatformAudit(tx: Prisma.TransactionClient, input: PlatformAuditInput) {
  return tx.platformAccessAudit.create({
    data: { ...input, workspaceId: input.businessId ?? null },
  });
}
