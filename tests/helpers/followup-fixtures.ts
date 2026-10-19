import "@/lib/tools/builtin";
import { prisma } from "@/lib/prisma/raw-client";
import type { TenantContext } from "@/lib/tenancy/context";
import { captureFollowupAuthorization } from "@/lib/tools/followup-authority";
/** Controlled positive prerequisite for delivery/restart tests whose target is
 * transport durability, not the Registry producer. Uses real capture/policy and
 * exact current membership; no fabricated role, snapshot or provider claim.
 */
export async function authorizeSeededFollowup(
  ctx: TenantContext,
  actionId: string,
  conversationId: string,
  connectionId: string
) {
  const action = await prisma.actionExecution.findUniqueOrThrow({ where: { id: actionId } });
  await prisma.actionExecution.update({ where: { id: actionId }, data: { status: "running" } });
  try {
    await captureFollowupAuthorization(
      { ...ctx, workBinding: { ...ctx.workBinding, actionExecutionId: actionId, conversationId } },
      { actionId, conversationId, connectionId },
      "direct_tool"
    );
  } finally {
    await prisma.actionExecution.update({
      where: { id: actionId },
      data: { status: action.status },
    });
  }
}
