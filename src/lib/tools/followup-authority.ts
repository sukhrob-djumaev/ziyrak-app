import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { TenantContext, AuthorizationProvenance } from "@/lib/tenancy/context";
import { getScopedPrisma, type AdmissionSession } from "@/lib/tenancy/scoped-prisma";
import { captureDeferredIdentity, refreshDeferredIdentity } from "@/lib/tenancy/deferred-origin";
import {
  captureDeferredProvider,
  refreshDeferredProvider,
} from "@/lib/tenancy/deferred-provider-origin";
import { validateResourceScope, type ResourceScope } from "@/lib/tenancy/resource-scope";
import { hasPermission } from "@/lib/rbac/rbac";
import { SEND_FOLLOWUP_JOB, RETRY_DELIVERY_JOB } from "@/lib/jobs/job-types";
import { AppError } from "@/lib/observability/errors";
import { assertRecoveryRequester } from "@/lib/conversations/recovery-authority";
import { resolveEffectiveToolPolicy } from "./policy";
import { toolRegistry } from "./registry";
import type { ToolAdmission } from "./types";
import type {
  AdmittedFollowup,
  AuthorizeFollowupSubmission,
  FollowupSubmissionBinding,
} from "@/lib/conversations/delivery-authority";

const id = z.string().min(1).max(128);
const base = z.object({
  version: z.literal(1),
  operation: z.literal("schedule_followup"),
  jobType: z.literal(SEND_FOLLOWUP_JOB),
  businessId: id,
  actionId: id,
  conversationId: id,
  connectionId: id,
});
const snapshotSchema = z.discriminatedUnion("mode", [
  base.extend({ mode: z.literal("direct_tool"), identity: z.unknown() }).strict(),
  base.extend({ mode: z.literal("internal_chat_ai"), identity: z.unknown() }).strict(),
  base.extend({ mode: z.literal("human_approval"), identity: z.unknown() }).strict(),
  base.extend({ mode: z.literal("provider_ai"), provider: z.unknown() }).strict(),
]);
type Snapshot = z.infer<typeof snapshotSchema>;
type Parent = { actionId: string; conversationId: string; connectionId: string };
function deny(): never {
  throw new AppError(
    403,
    "FOLLOWUP_AUTHORITY_UNAVAILABLE",
    "The saved follow-up authority is unavailable"
  );
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function permitsConnection(scope: ResourceScope, connectionId: string) {
  return scope.kind === "workspace" || scope.connectionIds.includes(connectionId);
}
async function currentFacts(ctx: TenantContext, saved: Snapshot, session?: AdmissionSession) {
  const policy = await resolveEffectiveToolPolicy(
    ctx,
    "schedule_followup",
    session?.repository(ctx)
  );
  if (!policy.enabledForTenant) deny();
  if (saved.mode === "provider_ai") {
    if (!policy.allowedForAI) deny();
    const provider = await refreshDeferredProvider(
      ctx,
      saved.provider,
      { conversationId: saved.conversationId, connectionId: saved.connectionId },
      session
    );
    return {
      scope: {
        kind: "connections",
        connectionIds: [saved.connectionId],
        customerProfileAccess: "none",
      } as ResourceScope,
      origin: provider.origin,
      actorUserId: undefined,
      notAfter: undefined,
    };
  }
  const fresh = await refreshDeferredIdentity(saved.identity, saved.businessId, session?.control),
    tool = toolRegistry.get("schedule_followup");
  if (!tool) deny();
  if (saved.mode === "human_approval") {
    if (fresh.origin.kind !== "membership" || !hasPermission(fresh.role, "actions:approve")) deny();
  } else if (saved.mode === "internal_chat_ai") {
    if (!policy.allowedForAI || !hasPermission(fresh.role, "conversations:create")) deny();
  } else if (
    !policy.allowedForHumanRoles.includes(fresh.role) ||
    (tool.requiredPermission && !hasPermission(fresh.role, tool.requiredPermission))
  )
    deny();
  const scope = validateResourceScope(fresh.scope);
  if (!permitsConnection(scope, saved.connectionId)) deny();
  return {
    scope,
    origin: fresh.origin,
    actorUserId: fresh.origin.kind === "membership" ? fresh.origin.userId : undefined,
    notAfter: fresh.expiresAt,
  };
}
/** Called only by the Registry-owned callback after destination resolution. */
export async function captureFollowupAuthorization(
  ctx: TenantContext,
  parent: Parent,
  admission: ToolAdmission | undefined
) {
  if (
    !admission ||
    ctx.workBinding?.actionExecutionId !== parent.actionId ||
    ctx.workBinding.conversationId !== parent.conversationId
  )
    deny();
  const common = {
    version: 1 as const,
    operation: "schedule_followup" as const,
    jobType: SEND_FOLLOWUP_JOB as typeof SEND_FOLLOWUP_JOB,
    businessId: ctx.businessId,
    ...parent,
  };
  let saved: Snapshot;
  if (admission === "ai_tool" && ctx.authorization === undefined) {
    saved = {
      ...common,
      mode: "provider_ai",
      provider: await captureDeferredProvider(ctx, {
        conversationId: parent.conversationId,
        connectionId: parent.connectionId,
      }),
    };
  } else {
    const identity = await captureDeferredIdentity(ctx);
    saved = {
      ...common,
      mode:
        admission === "human_approval"
          ? "human_approval"
          : admission === "ai_tool"
            ? "internal_chat_ai"
            : "direct_tool",
      identity,
    };
  }
  const worker: TenantContext = {
    ...ctx,
    role: null,
    actor: { kind: "system_job", jobId: "followup-admission", jobType: SEND_FOLLOWUP_JOB },
    authorization: undefined,
  };
  const facts = await currentFacts(worker, saved);
  const scoped = getScopedPrisma({ ...worker, resourceScope: facts.scope });
  if (
    !(await scoped.conversation.findFirst({
      where: { id: parent.conversationId, retiredAt: null },
      select: { id: true },
    }))
  )
    deny();
  const db = getScopedPrisma(ctx),
    savedRow = await db.actionExecution.updateMany({
      where: {
        id: parent.actionId,
        tool: "schedule_followup",
        status: "running",
        conversationId: parent.conversationId,
        authorizationSnapshot: { equals: Prisma.DbNull },
      },
      data: { authorizationSnapshot: saved as Prisma.InputJsonValue },
    });
  if (savedRow.count !== 1)
    throw new AppError(
      409,
      "FOLLOWUP_AUTHORITY_CONFLICT",
      "Saved follow-up authority cannot be replaced"
    );
}
/** Fresh action/policy/origin resolution for pickup and every adapter submission attempt. */
export async function authorizeFollowupAction(
  worker: TenantContext,
  binding: Omit<FollowupSubmissionBinding, "deliveryId">,
  session?: AdmissionSession
): Promise<AdmittedFollowup> {
  if (
    worker.role !== null ||
    worker.actor.kind !== "system_job" ||
    ![SEND_FOLLOWUP_JOB, RETRY_DELIVERY_JOB].includes(worker.actor.jobType)
  )
    deny();
  const db = session ? session.repository(worker) : getScopedPrisma(worker),
    action = await db.actionExecution.findFirst({
      where: {
        id: binding.actionId,
        tool: "schedule_followup",
        conversationId: binding.conversationId,
        retiredAt: null,
      },
    });
  if (
    !action ||
    ["running", "requested", "pending_approval", "cancelled"].includes(action.status) ||
    object(action.input).message !== binding.response
  )
    deny();
  const parsed = snapshotSchema.safeParse(action.authorizationSnapshot);
  if (!parsed.success) deny();
  const saved = parsed.data;
  if (
    saved.businessId !== worker.businessId ||
    saved.actionId !== action.id ||
    saved.conversationId !== binding.conversationId ||
    saved.connectionId !== binding.connectionId
  )
    deny();
  const conversation = await db.conversation.findFirst({
    where: { id: binding.conversationId, retiredAt: null },
    select: { id: true, channel: true, customerContact: true, metadata: true },
  });
  if (
    !conversation ||
    conversation.channel !== binding.channel ||
    conversation.customerContact !== binding.recipient
  )
    deny();
  const owner = object(conversation.metadata).channelConnectionId;
  if (owner !== undefined && owner !== binding.connectionId) deny();
  // Resource lookup precedes the final identity/policy refresh. Do not await a
  // destination read after turning fresh facts into submission authority.
  const facts = await currentFacts({ ...worker, authorization: undefined }, saved, session);
  if (facts.scope.kind === "connections" && owner !== binding.connectionId) deny();
  const approverExpiry = binding.recoveredBy
    ? await assertRecoveryRequester(
        worker.businessId,
        binding.recoveredBy,
        binding.connectionId,
        session
      )
    : undefined;
  const authorization: AuthorizationProvenance = {
    kind: "delegated_job",
    actorUserId: facts.actorUserId,
    allowedOperations: ["messages:create"],
    origin: facts.origin,
  };
  const result: TenantContext = {
    ...worker,
    role: null,
    resourceScope: facts.scope,
    authorization,
    workBinding: { conversationId: binding.conversationId, actionExecutionId: binding.actionId },
  };
  const notAfter =
    facts.notAfter && approverExpiry
      ? facts.notAfter < approverExpiry
        ? facts.notAfter
        : approverExpiry
      : (facts.notAfter ?? approverExpiry);
  return { context: result, notAfter };
}
export const authorizeFollowupSubmission: AuthorizeFollowupSubmission = async (
  worker,
  binding,
  session
) => {
  const { context, notAfter } = await authorizeFollowupAction(worker, binding, session);
  return {
    context: {
      ...context,
      workBinding: { ...context.workBinding, deliveryOperationId: binding.deliveryId },
    },
    notAfter,
  };
};
