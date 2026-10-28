import { prepareSupportQuery } from "./support-query";
import { CrossTenantWriteError } from "./write-error";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import type { TenantContext } from "./context";
import { validateResourceScope, WORKSPACE_SCOPE, type ResourceScope } from "./resource-scope";
import { SCOPE_SCHEMA } from "./scope-schema";
import { isRetirementContext, WorkRetiredError } from "./work-lifecycle";
import { sameConnectionOwner } from "./connection-ownership";
import type { getDataPlaneClient } from "@/lib/platform/tenant-placement";
export const CONTROL_PLANE_ONLY_MODELS = [
  "business",
  "user",
  "tenantPlacement",
  "infrastructurePolicy",
  "accountToken",
  "onboardingState",
  "workspaceAiAllowance",
  "aiUsageReservation",
  "aiServicePolicy",
  "catalogItem",
  "catalogVersion",
  "databaseProfile",
  "storageProfile",
  "revokedToken",
  "platformControl",
  "platformAssignment",
  "assignmentConnectionScope",
  "supportGrant",
  "grantConnectionScope",
  "platformAccessAudit",
  "membershipConnectionScope",
  "apiKeyConnectionScope",
] as const;
const CP = new Set<string>(CONTROL_PLANE_ONLY_MODELS);
const CONFIG = new Set([
  "membership",
  "apiKey",
  "category",
  "knowledgeEntry",
  "department",
  "teamMember",
  "tag",
  "schedule",
  "webhook",
  "sLARule",
  "cannedResponse",
  "automationRule",
  "flow",
  "businessConfig",
  "businessHours",
  "toolPolicy",
]);
const CHILDREN = new Set([
  "message",
  "internalNote",
  "conversationTag",
  "ticket",
  "callLog",
  "aIInteractionLog",
  "actionExecution",
]);
const COUNTERS: Record<string, string[]> = {
  automationRule: ["triggerCount"],
  flow: ["triggerCount"],
  cannedResponse: ["usageCount"],
};
const MUTATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);
type Client = ReturnType<typeof getDataPlaneClient>;
type RecordArgs = Record<string, unknown>;
interface Delegate {
  findMany(args: RecordArgs): Promise<RecordArgs[]>;
  findUnique(args: RecordArgs): Promise<RecordArgs | null>;
}
function delegate(client: unknown, model: string) {
  return (client as Record<string, unknown>)[model] as Delegate;
}
function deny(model: string): RecordArgs {
  const fields = SCOPE_SCHEMA[model]?.scalars ?? [];
  const field = fields.includes("id")
    ? "id"
    : fields.includes("businessId")
      ? "businessId"
      : fields[0];
  if (!field) throw new AppError(403, "INVALID_SCOPE", "Unknown resource denial contract");
  return { [field]: { in: [] } };
}
function obj(value: unknown): RecordArgs {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordArgs) : {};
}
export function effectiveResourceScope(ctx: TenantContext): ResourceScope {
  if (ctx.resourceScope) return validateResourceScope(ctx.resourceScope);
  // Existing autonomous ingress/AI/job actors remain governed by their narrow
  // operation contracts; a human/key/platform actor never receives this default.
  if (["channel_credential", "ai_agent", "system_job"].includes(ctx.actor.kind))
    return WORKSPACE_SCOPE;
  return validateResourceScope(undefined);
}
export function createResourceGuard(
  ctx: TenantContext,
  client: Client | unknown,
  controlPlane: Client | unknown
) {
  const scope = effectiveResourceScope(ctx);
  async function connections() {
    if (scope.kind !== "connections") return [];
    return await delegate(controlPlane, "channelConnection").findMany({
      where: { businessId: ctx.businessId, id: { in: scope.connectionIds } },
      select: { id: true, type: true },
    });
  }
  async function conversationWhere(connectionId?: string) {
    const rows = await connections();
    const permitted = connectionId ? rows.filter((row) => row.id === connectionId) : rows;
    if (!permitted.length) return { businessId: ctx.businessId, id: { in: [] } };
    return {
      businessId: ctx.businessId,
      OR: permitted.map((row) => ({
        channel: row.type,
        metadata: { path: ["channelConnectionId"], equals: row.id },
      })),
    };
  }
  async function predicate(model: string): Promise<RecordArgs> {
    if (CP.has(model)) return deny(model);
    if (model === "customer" || model === "customerNote")
      return scope.customerProfileAccess === "none" ? deny(model) : { businessId: ctx.businessId };
    if (scope.kind === "workspace") return { businessId: ctx.businessId };
    if (model === "channelConnection")
      return { businessId: ctx.businessId, id: { in: (await connections()).map((r) => r.id) } };
    if (model === "conversation") return conversationWhere();
    if (CHILDREN.has(model))
      return { businessId: ctx.businessId, conversation: { is: await conversationWhere() } };
    if (
      scope.kind === "connections" &&
      !["conversation", "channelConnection"].includes(model) &&
      !CONFIG.has(model) &&
      !(await connections()).length
    )
      return deny(model);
    if (model === "inboundEventReceipt")
      return {
        businessId: ctx.businessId,
        OR: (await connections()).map((row) => ({
          eventPayload: { path: ["source", "connectionId"], equals: row.id },
        })),
      };
    if (model === "deliveryOperation")
      return {
        businessId: ctx.businessId,
        OR: (await connections()).map((row) => ({
          connectionId: row.id,
          AND: [
            {
              OR: [
                { conversationId: null },
                {
                  conversation: {
                    is: {
                      businessId: ctx.businessId,
                      channel: row.type,
                      metadata: { path: ["channelConnectionId"], equals: row.id },
                    },
                  },
                },
              ],
            },
            {
              OR: [
                { receiptId: null },
                {
                  receipt: {
                    is: {
                      businessId: ctx.businessId,
                      eventPayload: { path: ["source", "connectionId"], equals: row.id },
                    },
                  },
                },
              ],
            },
            {
              OR: [
                { actionId: null },
                {
                  action: {
                    is: {
                      businessId: ctx.businessId,
                      conversation: {
                        is: {
                          businessId: ctx.businessId,
                          channel: row.type,
                          metadata: { path: ["channelConnectionId"], equals: row.id },
                        },
                      },
                    },
                  },
                },
              ],
            },
          ],
        })),
      };
    if (model === "activityLog") {
      const convs = await delegate(client, "conversation").findMany({
        where: await conversationWhere(),
        select: { id: true },
      });
      return {
        businessId: ctx.businessId,
        entity: "conversation",
        entityId: { in: convs.map((row) => row.id) },
      };
    }
    if (model === "webhookDelivery" || model === "campaign" || model === "campaignRun")
      return deny(model);
    if (CONFIG.has(model)) return { businessId: ctx.businessId };
    throw new AppError(403, "INVALID_SCOPE", "Resource has no defined scope contract");
  }
  async function projections(
    model: string,
    args: RecordArgs,
    depth = 0,
    rowResult = true
  ): Promise<RecordArgs> {
    if (depth > 16)
      throw new AppError(403, "INVALID_SCOPE", "Unsupported related resource projection");
    const def = SCOPE_SCHEMA[model];
    if (!def) throw new AppError(403, "INVALID_SCOPE", "Unknown resource projection");
    const result = { ...args };
    if (args.cursor !== undefined) {
      const cursor = await delegate(client, model).findUnique({
        where: { ...obj(args.cursor), businessId: ctx.businessId, AND: [await predicate(model)] },
      });
      if (!cursor) throw new NotFoundError("Resource");
    }
    if (args.where !== undefined) result.where = await filters(model, args.where, depth);
    if (args.orderBy !== undefined) result.orderBy = await ordering(model, args.orderBy, depth);
    if (scope.kind === "connections" && COUNTERS[model]) {
      for (const aggregate of ["_sum", "_avg", "_min", "_max", "_count"]) {
        const fields = obj(args[aggregate]);
        if (COUNTERS[model].some((key) => key in fields))
          throw new AppError(403, "FORBIDDEN", "Unscoped usage statistics are unavailable");
      }
      if (rowResult && !result.select) {
        result.select = Object.fromEntries(
          def.scalars.filter((key) => !COUNTERS[model].includes(key)).map((key) => [key, true])
        );
        if (result.include) {
          Object.assign(result.select as RecordArgs, result.include);
          delete result.include;
        }
      }
    }
    for (const kind of ["include", "select"]) {
      if (!result[kind]) continue;
      const fields = { ...obj(result[kind]) };
      for (const [field, value] of Object.entries(fields)) {
        if (!value) continue;
        if (field === "_count") {
          const requested =
            value === true
              ? Object.fromEntries(
                  Object.entries(def.relations)
                    .filter(([, rel]) => rel.many)
                    .map(([key]) => [key, true])
                )
              : obj(obj(value).select);
          const counts: RecordArgs = {};
          for (const [name, count] of Object.entries(requested)) {
            if (!count) continue;
            const rel = def.relations[name];
            if (!rel?.many) throw new AppError(403, "INVALID_SCOPE", "Unknown related count");
            counts[name] = {
              ...obj(count),
              where: {
                AND: [
                  await filters(rel.model, obj(count).where, depth + 1),
                  await predicate(rel.model),
                ],
              },
            };
          }
          fields[field] = { select: counts };
          continue;
        }
        const rel = def.relations[field];
        if (!rel) {
          if (!rowResult && field === "_all") continue;
          if (!def.scalars.includes(field))
            throw new AppError(403, "INVALID_SCOPE", "Unknown resource field");
          if (scope.kind === "connections" && COUNTERS[model]?.includes(field))
            delete fields[field];
          continue;
        }
        if (rel.model === "user") {
          const requested =
            value === true
              ? { select: { id: true, username: true, name: true, createdAt: true } }
              : obj(value);
          const select = obj(requested.select);
          if (
            Object.keys(select).some(
              (key) => !["id", "username", "name", "createdAt", "updatedAt"].includes(key)
            )
          )
            throw new AppError(403, "FORBIDDEN", "Account authority and credentials are private");
          fields[field] = { select: select };
          continue;
        }
        if (CP.has(rel.model)) {
          delete fields[field];
          continue;
        }
        if (
          (rel.model === "customer" || rel.model === "customerNote") &&
          scope.customerProfileAccess === "none"
        ) {
          delete fields[field];
          continue;
        }
        const nested = await projections(rel.model, value === true ? {} : obj(value), depth + 1);
        if (rel.many) nested.where = { AND: [obj(nested.where), await predicate(rel.model)] };
        fields[field] = nested;
      }
      result[kind] = fields;
    }
    return result;
  }
  async function reference(model: string, id: unknown, requireActive = false) {
    if (typeof id !== "string" || !id) throw new NotFoundError("Resource");
    const row = await delegate(client, model).findUnique({
      where: { id, businessId: ctx.businessId, AND: [await predicate(model)] },
    });
    if (!row) throw new NotFoundError("Resource");
    if (
      requireActive &&
      (row.retiredAt || (model === "inboundEventReceipt" && row.processingStatus === "cancelled"))
    )
      throw new WorkRetiredError();
    return row;
  }
  async function data(
    model: string,
    value: unknown,
    operation: string,
    where: RecordArgs
  ): Promise<RecordArgs> {
    const record = { ...obj(value) };
    if ("retiredAt" in record && !isRetirementContext(ctx))
      throw new AppError(403, "FORBIDDEN", "Retirement is controlled by the lifecycle service");
    if (record.businessId !== undefined && record.businessId !== ctx.businessId)
      throw new CrossTenantWriteError(model);
    if (operation.startsWith("create")) record.businessId = ctx.businessId;
    else delete record.businessId;
    for (const [field, rel] of Object.entries(SCOPE_SCHEMA[model]?.relations ?? {})) {
      if (!(field in record)) continue;
      if (model === "apiKey" && field === "connectionScopes") {
        const writes = obj(record[field]);
        if (Object.keys(writes).some((key) => key !== "create"))
          throw new AppError(403, "FORBIDDEN", "Unsupported scope mutation");
        for (const row of Array.isArray(writes.create) ? writes.create : [writes.create]) {
          const entry = obj(row);
          if (entry.businessId !== undefined && entry.businessId !== ctx.businessId)
            throw new NotFoundError("Connection");
          const conn = await delegate(controlPlane, "channelConnection").findUnique({
            where: { id: entry.connectionId, businessId: ctx.businessId },
          });
          if (
            !conn ||
            (scope.kind === "connections" &&
              !scope.connectionIds.includes(String(entry.connectionId)))
          )
            throw new NotFoundError("Connection");
        }
        continue;
      }
      if (rel)
        throw new AppError(
          403,
          "FORBIDDEN",
          "Nested resource mutations require an explicit contract"
        );
    }
    for (const [field, target] of Object.entries({
      conversationId: "conversation",
      ticketId: "ticket",
      messageId: "message",
      receiptId: "inboundEventReceipt",
      actionId: "actionExecution",
    })) {
      if (record[field] !== undefined && record[field] !== null)
        await reference(target, record[field], !isRetirementContext(ctx));
    }
    if (
      CHILDREN.has(model) &&
      !operation.startsWith("create") &&
      "conversationId" in record &&
      !isRetirementContext(ctx)
    ) {
      const sources = await delegate(client, model).findMany({
        where,
        select: { conversationId: true },
      });
      for (const source of sources) {
        if (!source.conversationId || source.conversationId === record.conversationId) continue;
        if (!record.conversationId)
          throw new AppError(403, "FORBIDDEN", "Conversation lineage cannot be removed");
        const first = await reference("conversation", source.conversationId, true);
        const second = await reference("conversation", record.conversationId, true);
        if (!sameConnectionOwner(first, second, scope.kind === "workspace"))
          throw new AppError(403, "FORBIDDEN", "Related data cannot move between connections");
      }
    }
    if (
      (model === "customer" || model === "customerNote") &&
      scope.customerProfileAccess !== "write"
    )
      throw new AppError(403, "FORBIDDEN", "Shared customer profile write permission is required");
    if (
      scope.kind === "connections" &&
      ["webhookDelivery", "campaign", "campaignRun"].includes(model)
    )
      throw new AppError(403, "FORBIDDEN", "Resource has no connection scope");
    if (model === "channelConnection" && scope.kind === "connections")
      throw new AppError(403, "FORBIDDEN", "Channel configuration requires workspace scope");
    if (model === "conversation") {
      const incoming = obj(record.metadata);
      if (operation.startsWith("create")) {
        const owner = incoming.channelConnectionId;
        if (scope.kind === "connections" && !scope.connectionIds.includes(String(owner)))
          throw new NotFoundError("Connection");
        if (owner && record.channel !== "api") {
          const conn = await delegate(controlPlane, "channelConnection").findUnique({
            where: { id: owner, businessId: ctx.businessId, type: record.channel },
          });
          if (!conn) throw new NotFoundError("Connection");
        }
      } else if ("metadata" in record || "channel" in record) {
        const rows = await delegate(client, "conversation").findMany({
          where,
          select: { metadata: true, channel: true },
        });
        const owners = rows.map((row) => obj(row.metadata).channelConnectionId);
        if (new Set(owners).size > 1)
          throw new AppError(403, "FORBIDDEN", "Cannot replace distinct connection ownership");
        for (const row of rows) {
          const owner = obj(row.metadata).channelConnectionId;
          if (incoming.channelConnectionId !== undefined && incoming.channelConnectionId !== owner)
            throw new AppError(403, "FORBIDDEN", "Connection ownership is immutable");
          if (record.channel !== undefined && record.channel !== row.channel)
            throw new AppError(403, "FORBIDDEN", "Connection ownership is immutable");
        }
        if ("metadata" in record && owners[0] !== undefined)
          record.metadata = { ...incoming, channelConnectionId: owners[0] };
      }
    }
    if (model === "deliveryOperation" && record.connectionId !== undefined) {
      const conn = await delegate(controlPlane, "channelConnection").findUnique({
        where: { id: record.connectionId, businessId: ctx.businessId },
      });
      if (
        !conn ||
        (scope.kind === "connections" && !scope.connectionIds.includes(String(record.connectionId)))
      )
        throw new NotFoundError("Connection");
      if (record.conversationId) {
        const conv = await reference("conversation", record.conversationId);
        if (obj(conv.metadata).channelConnectionId !== record.connectionId)
          throw new NotFoundError("Conversation");
      }
    }
    if (model === "activityLog" && !isRetirementContext(ctx) && record.entityId) {
      const parent = {
        conversation: "conversation",
        action: "actionExecution",
        delivery: "deliveryOperation",
        customer: "customer",
      }[String(record.entity)];
      if (parent) await reference(parent, record.entityId, true);
    }
    return record;
  }
  const userFields = new Set(["id", "username", "name", "createdAt", "updatedAt"]);
  function assertQueryableField(model: string, field: string) {
    if (scope.kind === "connections" && COUNTERS[model]?.includes(field))
      throw new AppError(403, "FORBIDDEN", "Unscoped usage statistics are unavailable");
    if (model === "user" && !userFields.has(field))
      throw new AppError(403, "FORBIDDEN", "Account authority and credentials are private");
  }
  async function filters(model: string, input: unknown, depth = 0): Promise<RecordArgs> {
    if (depth > 16) throw new AppError(403, "INVALID_SCOPE", "Unsupported related predicate");
    const result: RecordArgs = {};
    for (const [field, value] of Object.entries(obj(input))) {
      if (["AND", "OR", "NOT"].includes(field)) {
        result[field] = Array.isArray(value)
          ? await Promise.all(value.map((v) => filters(model, v, depth + 1)))
          : await filters(model, value, depth + 1);
        continue;
      }
      if (["_count", "_sum", "_avg", "_min", "_max"].includes(field)) {
        result[field] = await filters(model, value, depth + 1);
        continue;
      }
      assertQueryableField(model, field);
      const relation = SCOPE_SCHEMA[model]?.relations[field];
      if (!relation) {
        result[field] = value;
        continue;
      }
      if (CP.has(relation.model) && relation.model !== "user")
        throw new AppError(403, "FORBIDDEN", "Platform relation predicates are unavailable");
      if (
        (relation.model === "customer" || relation.model === "customerNote") &&
        scope.customerProfileAccess === "none"
      )
        throw new AppError(403, "FORBIDDEN", "Shared customer profile permission is required");
      const relationFilter = obj(value);
      const targetScope = relation.model === "user" ? {} : await predicate(relation.model);
      const scoped = async (condition: unknown) => ({
        AND: [await filters(relation.model, condition, depth + 1), targetScope],
      });
      if (relation.many) {
        const next: RecordArgs = {};
        for (const [mode, condition] of Object.entries(relationFilter)) {
          if (mode === "some") next.some = await scoped(condition);
          else if (mode === "none" || mode === "every") {
            const excluded =
              mode === "none"
                ? await scoped(condition)
                : {
                    AND: [
                      targetScope,
                      { NOT: await filters(relation.model, condition, depth + 1) },
                    ],
                  };
            next.none = next.none ? { OR: [next.none, excluded] } : excluded;
          } else throw new AppError(403, "INVALID_SCOPE", "Unsupported related predicate");
        }
        result[field] = next;
      } else {
        if ("is" in relationFilter || "isNot" in relationFilter) {
          const next: RecordArgs = {};
          for (const [mode, condition] of Object.entries(relationFilter)) {
            if (mode !== "is" && mode !== "isNot")
              throw new AppError(403, "INVALID_SCOPE", "Unsupported related predicate");
            next[mode] = condition === null ? null : await scoped(condition);
          }
          result[field] = next;
        } else result[field] = await scoped(relationFilter);
      }
    }
    return result;
  }
  async function ordering(model: string, input: unknown, depth = 0): Promise<unknown> {
    if (depth > 16) throw new AppError(403, "INVALID_SCOPE", "Unsupported related ordering");
    if (Array.isArray(input))
      return Promise.all(input.map((item) => ordering(model, item, depth + 1)));
    const result: RecordArgs = {};
    for (const [field, value] of Object.entries(obj(input))) {
      assertQueryableField(model, field);
      const relation = SCOPE_SCHEMA[model]?.relations[field];
      if (!relation) {
        result[field] = value;
        continue;
      }
      if (relation.many && scope.kind === "connections")
        throw new AppError(403, "FORBIDDEN", "Unscoped related ordering is unavailable");
      if (CP.has(relation.model) && relation.model !== "user")
        throw new AppError(403, "FORBIDDEN", "Platform relation ordering is unavailable");
      if (
        (relation.model === "customer" || relation.model === "customerNote") &&
        scope.customerProfileAccess === "none"
      )
        throw new AppError(403, "FORBIDDEN", "Shared customer profile permission is required");
      result[field] = await ordering(relation.model, value, depth + 1);
    }
    return result;
  }
  async function prepare(model: string, operation: string, args: RecordArgs): Promise<RecordArgs> {
    args = prepareSupportQuery(ctx, model, operation, args);
    if (CP.has(model))
      throw new AppError(403, "FORBIDDEN", "Platform resources require platform authorization");
    if (!SCOPE_SCHEMA[model]) throw new AppError(403, "INVALID_SCOPE", "Unknown resource contract");
    if (MUTATIONS.has(operation) && !isRetirementContext(ctx)) {
      for (const [field, parent] of Object.entries({
        conversationId: "conversation",
        actionExecutionId: "actionExecution",
        deliveryOperationId: "deliveryOperation",
        receiptId: "inboundEventReceipt",
      })) {
        const id = ctx.workBinding?.[field as keyof NonNullable<TenantContext["workBinding"]>];
        if (id) await reference(parent, id, true);
      }
    }
    const result = await projections(
      model,
      args,
      0,
      !["count", "aggregate", "groupBy", "createMany", "updateMany", "deleteMany"].includes(
        operation
      )
    );
    const filtered = await filters(model, args.where);
    if (args.orderBy !== undefined) result.orderBy = await ordering(model, args.orderBy);
    if (args.having !== undefined) result.having = await filters(model, args.having);
    for (const argument of [args.by, args.distinct]) {
      if (argument !== undefined)
        for (const field of Array.isArray(argument) ? argument : [argument])
          assertQueryableField(model, String(field));
    }
    const where = {
      ...filtered,
      businessId: ctx.businessId,
      AND: [
        ...(Array.isArray(filtered.AND)
          ? (filtered.AND as unknown[])
          : filtered.AND
            ? [filtered.AND]
            : []),
        await predicate(model),
        ...(MUTATIONS.has(operation) && !isRetirementContext(ctx)
          ? [
              [
                "conversation",
                "actionExecution",
                "deliveryOperation",
                "inboundEventReceipt",
              ].includes(model)
                ? { retiredAt: null }
                : CHILDREN.has(model)
                  ? {
                      OR: [
                        ...(scope.kind === "workspace" &&
                        ["ticket", "callLog", "aIInteractionLog"].includes(model)
                          ? [{ conversationId: null }]
                          : []),
                        { conversation: { is: { retiredAt: null } } },
                      ],
                    }
                  : {},
            ]
          : []),
      ],
    };
    if (!operation.startsWith("create")) result.where = where;
    if (operation === "upsert") {
      result.create = await data(model, args.create, "create", where);
      result.update = await data(model, args.update, "update", where);
    } else if (args.data !== undefined) {
      result.data = Array.isArray(args.data)
        ? await Promise.all(args.data.map((row) => data(model, row, operation, where)))
        : await data(model, args.data, operation, where);
    }
    if (
      MUTATIONS.has(operation) &&
      (model === "customer" || model === "customerNote") &&
      scope.customerProfileAccess !== "write"
    )
      throw new AppError(403, "FORBIDDEN", "Shared customer profile write permission is required");
    return result;
  }
  return { prepare, scope, predicate };
}
