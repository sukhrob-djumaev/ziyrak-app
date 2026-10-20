import type { TenantContext, AuthorizationProvenance } from "@/lib/tenancy/context";
import { getScopedPrisma, type AdmissionSession } from "@/lib/tenancy/scoped-prisma";
import { refreshDeferredIdentity } from "@/lib/tenancy/deferred-origin";
import { validateResourceScope } from "@/lib/tenancy/resource-scope";
import { hasPermission } from "@/lib/rbac/rbac";
import { EXECUTE_CAMPAIGN_JOB, RETRY_DELIVERY_JOB } from "@/lib/jobs/job-types";
import { AppError } from "@/lib/observability/errors";
import type {
  AdmittedFollowup,
  AuthorizeCampaignSubmission,
} from "@/lib/conversations/delivery-authority";

function deny(): never {
  throw new AppError(
    403,
    "CAMPAIGN_AUTHORITY_UNAVAILABLE",
    "The saved campaign authority is unavailable"
  );
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/**
 * Fresh identity facts for a saved campaign requester. Campaign sending needs the requester to
 * still hold `automation:create`, whole-workspace or channel scope containing the connection,
 * and readable customer profiles (the recipient contact comes from a customer profile).
 */
export async function currentCampaignFacts(
  workspaceId: string,
  saved: unknown,
  connectionId: string,
  session?: AdmissionSession
) {
  const fresh = await refreshDeferredIdentity(saved, workspaceId, session?.control);
  if (!hasPermission(fresh.role, "automation:create")) deny();
  const scope = validateResourceScope(fresh.scope);
  // Campaigns have no connection scope: a requester now limited to specific channels can no
  // longer reach campaigns at all, even if the run's connection is among them.
  if (scope.kind !== "workspace" || scope.customerProfileAccess === "none") deny();
  return {
    scope,
    origin: fresh.origin,
    actorUserId: fresh.origin.kind === "membership" ? fresh.origin.userId : undefined,
    notAfter: fresh.expiresAt,
  };
}
/** Fresh run/identity resolution for pickup and every adapter submission attempt. */
export const authorizeCampaignSubmission: AuthorizeCampaignSubmission = async (
  worker,
  binding,
  session
): Promise<AdmittedFollowup> => {
  if (
    worker.role !== null ||
    worker.actor.kind !== "system_job" ||
    ![EXECUTE_CAMPAIGN_JOB, RETRY_DELIVERY_JOB].includes(worker.actor.jobType)
  )
    deny();
  const db = session ? session.repository(worker) : getScopedPrisma(worker);
  const run = await db.campaignRun.findFirst({
    where: { id: binding.campaignRunId, retiredAt: null },
  });
  if (
    !run ||
    run.status === "cancelled" ||
    run.businessId !== worker.businessId ||
    run.channel !== binding.channel ||
    run.connectionId !== binding.connectionId ||
    run.message !== binding.response
  )
    deny();
  const conversation = await db.conversation.findFirst({
    where: { id: binding.conversationId, retiredAt: null },
    select: { id: true, channel: true, customerContact: true, metadata: true },
  });
  if (
    !conversation ||
    conversation.channel !== binding.channel ||
    conversation.customerContact !== binding.recipient ||
    object(conversation.metadata).channelConnectionId !== binding.connectionId ||
    object(conversation.metadata).campaignRunId !== run.id
  )
    deny();
  // Resource lookups precede the final identity refresh, as for follow-ups.
  const facts = await currentCampaignFacts(
    worker.businessId,
    run.authorizationSnapshot,
    binding.connectionId,
    session
  );
  const authorization: AuthorizationProvenance = {
    kind: "delegated_job",
    actorUserId: facts.actorUserId,
    allowedOperations: ["messages:create"],
    origin: facts.origin,
  };
  const context: TenantContext = {
    ...worker,
    role: null,
    resourceScope: facts.scope,
    authorization,
    workBinding: {
      conversationId: binding.conversationId,
      campaignRunId: run.id,
      deliveryOperationId: binding.deliveryId,
    },
  };
  return { context, notAfter: facts.notAfter };
};
