import type { TenantContext } from "./context";
import { getBackstopTenantContext } from "./context";
import { getDataPlaneClient } from "./placement";

/**
 * PLAN.md §8.3/§12 — every tenant-owned model that currently exists in the
 * schema. Deliberately excludes: control-plane models (`Business`, `User`,
 * `Membership`, `TenantPlacement`, `DatabaseProfile`, `StorageProfile` —
 * §16.4, accessed only via the small `platform/` allowlist); retired legacy
 * models superseded in Phase 1 (`Settings`, `Admin`, `Channel`); and models
 * §12 assigns to later phases that do not exist yet (`ActionExecution`,
 * `InboundEventReceipt`, `ToolPolicy`).
 *
 * Model keys are the Prisma *client* property names (lower-camel), matching
 * how `uncapitalizeModel()` below normalizes the extension callback's
 * `model` argument (which Prisma passes as the schema's PascalCase name).
 */
export const TENANT_SCOPED_MODELS = [
  "membership",
  "customer",
  "customerNote",
  "conversation",
  "message",
  "ticket",
  "tag",
  "conversationTag",
  "internalNote",
  "callLog",
  "teamMember",
  "department",
  "category",
  "knowledgeEntry",
  "channelConnection",
  "schedule",
  "webhook",
  "webhookDelivery",
  "activityLog",
  "sLARule",
  "cannedResponse",
  "automationRule",
  "campaign",
  "flow",
  "apiKey",
  "businessConfig",
  "businessHours",
] as const;

export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

const SCOPED_SET: ReadonlySet<string> = new Set(TENANT_SCOPED_MODELS);

function uncapitalizeModel(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

export function isTenantScopedModel(model: string): model is TenantScopedModel {
  return SCOPED_SET.has(uncapitalizeModel(model));
}

export class CrossTenantWriteError extends Error {
  constructor(model: string) {
    super(
      `Refusing to write a ${model} row tagged for a different business than the current tenant context (PLAN.md §8.3) — the scoped client never silently overrides a caller-supplied businessId on create, it rejects the write.`
    );
    this.name = "CrossTenantWriteError";
  }
}

type WhereArgs = { where?: Record<string, unknown> } & Record<string, unknown>;

function withTenantWhere<A extends WhereArgs>(args: A, businessId: string): A {
  return { ...args, where: { ...(args.where ?? {}), businessId } };
}

function withTenantCreateData(
  model: string,
  data: Record<string, unknown> | undefined,
  businessId: string
): Record<string, unknown> {
  const record = { ...(data ?? {}) };
  if (record.businessId !== undefined && record.businessId !== businessId) {
    throw new CrossTenantWriteError(model);
  }
  record.businessId = businessId;
  return record;
}

function withTenantData<A extends { data?: unknown }>(
  model: string,
  args: A,
  businessId: string
): A {
  const data = args.data;
  if (Array.isArray(data)) {
    return {
      ...args,
      data: data.map((d) => withTenantCreateData(model, d as Record<string, unknown>, businessId)),
    };
  }
  return { ...args, data: withTenantCreateData(model, data as Record<string, unknown> | undefined, businessId) };
}

/** A tenant's own businessId can never be changed by an update payload. */
function stripBusinessId(update: Record<string, unknown> | undefined): Record<string, unknown> {
  const rest = { ...(update ?? {}) };
  delete rest.businessId;
  return rest;
}

/**
 * PLAN.md §8.3 — the tenant-scoping Prisma Client Extension. Takes `ctx`
 * explicit (§8.2), never reading it implicitly; falls back to the
 * `AsyncLocalStorage` backstop and, if that is also empty, throws
 * immediately rather than running any query unscoped (fail closed, not fail
 * open).
 *
 * Every where-bearing operation has `businessId: ctx.businessId` merged into
 * its `where` clause, **overriding** any caller-supplied value — this is
 * deliberately not "inject if absent," so a caller cannot smuggle a
 * different business's id through `where.businessId` either. `create`/
 * `createMany` instead **reject** a data payload that already names a
 * different businessId (§8.3), since silently overriding a write's own
 * declared tenant would hide a real bug rather than surface it.
 *
 * Validated against this project's installed `@prisma/client` (v7) query
 * extension types (`node_modules/@prisma/client/runtime/client.d.ts`) per
 * AGENTS.md and PLAN.md §8.3's own note that its pseudocode must be checked
 * against the real API — `ModelQueryOptionsCbArgs` confirms `{ model,
 * operation, args, query }`, and every generated `*WhereUniqueInput` type
 * (e.g. `CustomerWhereUniqueInput`) confirms Prisma's "extended where unique
 * input" accepts additional non-unique filter fields (like `businessId`)
 * alongside the required unique key — so `findUnique`/`update`/`delete`
 * simply merge into `where` exactly like the plural operations, without
 * needing a findFirst redirect.
 */
export function getScopedPrisma(ctx: TenantContext | undefined) {
  const resolved = ctx ?? getBackstopTenantContext();
  if (!resolved) {
    throw new Error(
      "getScopedPrisma() was called with no TenantContext, and none is available from the AsyncLocalStorage backstop either. Refusing to run any query unscoped (PLAN.md §8.2/§8.3 fail-closed rule)."
    );
  }
  const { businessId } = resolved;
  const client = getDataPlaneClient(resolved.dataConnection);

  const whereScoped = async ({ model, args, query }: { model: string; args: WhereArgs; query: (args: WhereArgs) => Promise<unknown> }) => {
    if (!isTenantScopedModel(model)) return query(args);
    return query(withTenantWhere(args, businessId));
  };

  return client.$extends({
    name: "tenant-scoping",
    query: {
      $allModels: {
        findUnique: whereScoped,
        findUniqueOrThrow: whereScoped,
        findFirst: whereScoped,
        findFirstOrThrow: whereScoped,
        findMany: whereScoped,
        count: whereScoped,
        aggregate: whereScoped,
        groupBy: whereScoped,
        update: whereScoped,
        updateMany: whereScoped,
        delete: whereScoped,
        deleteMany: whereScoped,

        async upsert({ model, args, query }) {
          if (!isTenantScopedModel(model)) return query(args);
          const typedArgs = args as WhereArgs & {
            create?: Record<string, unknown>;
            update?: Record<string, unknown>;
          };
          const scoped = withTenantWhere(typedArgs, businessId);
          return query({
            ...scoped,
            create: withTenantCreateData(model, typedArgs.create, businessId),
            update: stripBusinessId(typedArgs.update),
          } as Parameters<typeof query>[0]);
        },

        async create({ model, args, query }) {
          if (!isTenantScopedModel(model)) return query(args);
          return query(withTenantData(model, args, businessId));
        },

        async createMany({ model, args, query }) {
          if (!isTenantScopedModel(model)) return query(args);
          return query(withTenantData(model, args, businessId));
        },
      },
    },
  });
}

export type ScopedPrisma = ReturnType<typeof getScopedPrisma>;
