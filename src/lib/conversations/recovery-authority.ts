import { refreshDeferredIdentity } from "@/lib/tenancy/deferred-origin";
import { validateResourceScope } from "@/lib/tenancy/resource-scope";
import type { AdmissionSession } from "@/lib/tenancy/scoped-prisma";
import { hasPermission } from "@/lib/rbac/rbac";
import { AppError } from "@/lib/observability/errors";

/** The person who approved a recovery resend, as saved in the operation's recovery log. */
export interface RecoveryRequester {
  actorId: string;
  membershipId: string | null;
}

/**
 * The latest recovery decision is a resend only if it is the entry that made the operation
 * ready again; any other latest decision means no resend approval is outstanding.
 */
export function recoveryRequesterOf(recoveryLog: unknown): RecoveryRequester | undefined {
  const log = Array.isArray(recoveryLog) ? recoveryLog : [];
  const last = log.at(-1);
  if (!last || typeof last !== "object") return undefined;
  const entry = last as Record<string, unknown>;
  if (entry.decision !== "resend" || typeof entry.actorId !== "string") return undefined;
  return {
    actorId: entry.actorId,
    membershipId: typeof entry.actorMembershipId === "string" ? entry.actorMembershipId : null,
  };
}

/**
 * Fresh check that the person who approved a resend still may: an active membership holding
 * `actions:approve` over the whole workspace or the delivery's connection. A resend approved
 * without a recorded membership (older entries) fails closed. Returns the approver's expiry.
 */
export async function assertRecoveryRequester(
  workspaceId: string,
  requester: RecoveryRequester,
  connectionId: string,
  session?: AdmissionSession
): Promise<Date | undefined> {
  const deny = (): never => {
    throw new AppError(
      403,
      "RECOVERY_AUTHORITY_UNAVAILABLE",
      "The person who approved this resend no longer holds that authority"
    );
  };
  if (!requester.membershipId) return deny();
  const fresh = await refreshDeferredIdentity(
    {
      version: 1,
      businessId: workspaceId,
      origin: {
        kind: "membership",
        userId: requester.actorId,
        membershipId: requester.membershipId,
      },
      scope: { kind: "workspace", customerProfileAccess: "write" },
    },
    workspaceId,
    session?.control
  );
  if (!hasPermission(fresh.role, "actions:approve")) return deny();
  const scope = validateResourceScope(fresh.scope);
  if (scope.kind !== "workspace" && !scope.connectionIds.includes(connectionId)) return deny();
  return fresh.expiresAt;
}
