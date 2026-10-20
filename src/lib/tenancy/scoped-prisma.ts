import {
  createResourceGuard,
  effectiveResourceScope,
  CONTROL_PLANE_ONLY_MODELS,
} from "./resource-query";
import { AppError } from "@/lib/observability/errors";
import type { TenantContext } from "./context";
import { getBackstopTenantContext } from "./context";
import { getDataPlaneClient } from "@/lib/platform/tenant-placement";
import { prisma as sharedClient } from "@/lib/prisma/raw-client";
import { lockTenantWrites } from "./work-lifecycle";
import type { Prisma } from "@/generated/prisma/client";

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

/**
 * PLAN.md §8.3/§12 — every tenant-owned model that currently exists in the
 * schema. Deliberately excludes: control-plane models (`Business`, `User`,
 * `Membership`, `TenantPlacement`, `DatabaseProfile`, `StorageProfile` —
 * §16.4, accessed only via the small `platform/` allowlist); retired legacy
 * models superseded in Phase 1 (`Settings`, `Admin`, `Channel`).
 *
 * Model keys are the Prisma *client* property names (lower-camel), matching
 * how `uncapitalizeModel()` below normalizes the extension callback's
 * `model` argument (which Prisma passes as the schema's PascalCase name).
 *
 * PLAN.md §46.5 — `inboundEventReceipt` added now that the model exists
 * (Phase 3's comment above named it as a later addition). PLAN.md §46.6 —
 * `toolPolicy`/`actionExecution` added now that those models exist too.
 */
export const TENANT_SCOPED_MODELS = [
  "membership",
  "inboundEventReceipt",
  "deliveryOperation",
  "toolPolicy",
  "actionExecution",
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
  "campaignRun",
  "flow",
  "apiKey",
  "businessConfig",
  "businessHours",
  "aIInteractionLog",
] as const;

export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

/**
 * PLAN.md §7.4 — tenant-scoped models that nevertheless live on the control
 * plane, because a process reads them *before* it knows which business (and
 * so which data-plane database) a request belongs to: authentication reads
 * `Membership` and `ApiKey`, and webhook/widget ingress resolves a business
 * from `ChannelConnection`, all through the shared connection. Administering
 * them through a dedicated database's copy would silently diverge from what
 * ingress reads (a removed member or revoked key would still authenticate; a
 * new connection would never receive traffic), so for a business on a
 * dedicated database these models always go to the shared connection — still
 * tenant-scoped, only the connection is pinned. They never migrate (§46.9).
 */
export const CONTROL_PLANE_RESIDENT_MODELS = ["membership", "apiKey", "channelConnection"] as const;

const SCOPED_SET: ReadonlySet<string> = new Set(TENANT_SCOPED_MODELS);
const CONTROL_PLANE_RESIDENT_SET: ReadonlySet<string> = new Set(CONTROL_PLANE_RESIDENT_MODELS);

function uncapitalizeModel(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

export function isTenantScopedModel(model: string): model is TenantScopedModel {
  return SCOPED_SET.has(uncapitalizeModel(model));
}

export { CrossTenantWriteError } from "./write-error";

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
  const client = getDataPlaneClient(resolved.dataConnection);
  const scoped = buildScopedClient(client, resolved);
  if (client === sharedClient) return scoped;

  // Dedicated database: control-plane-resident models are served by the shared connection.
  const controlPlane = buildScopedClient(sharedClient, resolved);
  return new Proxy(scoped, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && CONTROL_PLANE_RESIDENT_SET.has(prop))
        return Reflect.get(controlPlane, prop);
      return Reflect.get(target, prop, receiver);
    },
  }) as typeof scoped;
}

const REPOSITORY_METHODS = new Set([
  ...MUTATIONS,
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);
const DENIED_RAW_METHODS = new Set([
  "$queryRaw",
  "$queryRawUnsafe",
  "$executeRaw",
  "$executeRawUnsafe",
]);
/** Never proxy a Prisma object as the public target: its parent/private aliases
 * and property descriptors can expose the pre-extension client. Methods return
 * native promises, not Prisma's fluent delegate/request objects.
 */
function repositorySurface(
  invoke: (model: string, operation: string, args: Record<string, unknown>) => Promise<unknown>,
  transaction?: (input: unknown, options?: Record<string, unknown>) => Promise<unknown>
) {
  const denied = (): never => {
    throw new AppError(403, "FORBIDDEN", "Unscoped repository operations are unavailable");
  };
  const models = new Map<string, object>();
  return new Proxy(Object.freeze(Object.create(null)), {
    get(_target, key) {
      if (key === "then") return undefined;
      if (typeof key === "symbol")
        return key === Symbol.toStringTag ? "TenantRepository" : undefined;
      if (key === "$transaction") return transaction ?? denied();
      if (DENIED_RAW_METHODS.has(key)) return async () => denied();
      if (!SCOPED_SET.has(key) && !(CONTROL_PLANE_ONLY_MODELS as readonly string[]).includes(key))
        return denied();
      if (!models.has(key)) {
        const methods = new Map<string, (args?: Record<string, unknown>) => Promise<unknown>>();
        models.set(
          key,
          new Proxy(Object.freeze(Object.create(null)), {
            get(_modelTarget, operation) {
              if (operation === "then") return undefined;
              if (typeof operation === "symbol")
                return operation === Symbol.toStringTag ? "TenantModel" : undefined;
              if (!REPOSITORY_METHODS.has(operation)) return denied();
              if (!methods.has(operation))
                methods.set(operation, async (args = {}) => invoke(key, operation, args));
              return methods.get(operation);
            },
          })
        );
      }
      return models.get(key);
    },
  });
}

function buildScopedClient(client: ReturnType<typeof getDataPlaneClient>, ctx: TenantContext) {
  effectiveResourceScope(ctx); // Synchronous fail-closed boundary for missing human scope.
  const guard = createResourceGuard(ctx, client, sharedClient);
  const extended = client.$extends({
    name: "tenant-and-resource-scoping",
    query: {
      $allOperations: async ({ model, operation, args, query }) => {
        if (!model)
          throw new AppError(
            403,
            "FORBIDDEN",
            "Raw queries are unavailable through tenant repositories"
          );
        const key = uncapitalizeModel(model);
        if (
          !isTenantScopedModel(key) &&
          !(CONTROL_PLANE_ONLY_MODELS as readonly string[]).includes(key)
        )
          throw new AppError(403, "INVALID_SCOPE", "Unknown repository scope");
        if (MUTATIONS.has(operation)) {
          return client.$transaction(
            async (transaction) => {
              await lockTenantWrites(transaction, ctx.businessId);
              const transactionGuard = createResourceGuard(
                ctx,
                transaction,
                client === sharedClient ? transaction : sharedClient
              );
              const prepared = await transactionGuard.prepare(
                key,
                operation,
                (args ?? {}) as Record<string, unknown>
              );
              const delegate = Reflect.get(transaction, key);
              return Reflect.apply(Reflect.get(delegate, operation), delegate, [prepared]);
            },
            { isolationLevel: "ReadCommitted" }
          );
        }
        const prepared = await guard.prepare(
          key,
          operation,
          (args ?? {}) as Record<string, unknown>
        );
        return query(prepared as typeof args);
      },
    },
  });
  return repositorySurface(
    async (model, operation, args) => {
      const delegate = Reflect.get(extended, model);
      return Reflect.apply(Reflect.get(delegate, operation), delegate, [args]);
    },
    (input: unknown, options?: Record<string, unknown>) => {
      if (typeof input !== "function")
        throw new AppError(403, "FORBIDDEN", "Tenant transactions require a guarded callback");
      if (options?.isolationLevel && options.isolationLevel !== "ReadCommitted")
        throw new AppError(
          403,
          "FORBIDDEN",
          "Tenant writes require fresh committed lifecycle checks"
        );
      return client.$transaction(
        async (transaction) => {
          await lockTenantWrites(transaction, ctx.businessId);
          const transactionGuard = createResourceGuard(
            ctx,
            transaction,
            client === sharedClient ? transaction : sharedClient
          );
          const wrapped = repositorySurface(async (key, operation, args) => {
            const isControl = CONTROL_PLANE_RESIDENT_SET.has(key);
            if (
              isControl &&
              client !== sharedClient &&
              !operation.startsWith("find") &&
              !["count", "aggregate", "groupBy"].includes(operation)
            )
              throw new AppError(
                403,
                "FORBIDDEN",
                "Operation requires a separate authorized context"
              );
            const delegate =
              isControl && client !== sharedClient
                ? Reflect.get(sharedClient, key)
                : Reflect.get(transaction, key);
            const prepared = await transactionGuard.prepare(key, operation, args);
            return Reflect.apply(Reflect.get(delegate, operation), delegate, [prepared]);
          });
          return (input as (tx: typeof transaction) => Promise<unknown>)(wrapped);
        },
        { ...options, isolationLevel: "ReadCommitted" } as never
      );
    }
  ) as typeof extended;
}

export type ScopedPrisma = ReturnType<typeof getScopedPrisma>;

/** Narrow control-plane readers bound to the admission's control transaction: `findFirst`
 * only, with the session's workspace injected so a reader cannot cross workspaces.
 */
export type AdmissionControlReader = {
  business: Pick<Prisma.TransactionClient["business"], "findFirst">;
  membership: Pick<Prisma.TransactionClient["membership"], "findFirst">;
  apiKey: Pick<Prisma.TransactionClient["apiKey"], "findFirst">;
  channelConnection: Pick<Prisma.TransactionClient["channelConnection"], "findFirst">;
};
function controlReader(tx: Prisma.TransactionClient, businessId: string): AdmissionControlReader {
  const only = (delegate: object, field: "id" | "businessId") =>
    Object.freeze({
      findFirst: (args: { where?: object } = {}) =>
        (delegate as { findFirst: (a: unknown) => unknown }).findFirst({
          ...args,
          where: { AND: [args.where ?? {}, { [field]: businessId }] },
        }),
    });
  return Object.freeze({
    business: only(tx.business, "id"),
    membership: only(tx.membership, "businessId"),
    apiKey: only(tx.apiKey, "businessId"),
    channelConnection: only(tx.channelConnection, "businessId"),
  }) as unknown as AdmissionControlReader;
}
/** Short local sending-admission session (PLAN P1 follow-up admission contract). Both
 * workspace write fences are held for its whole life, so authority-reducing writers wait
 * behind it. No provider call, raw SQL, client escape or nested transaction belongs here.
 */
export interface AdmissionSession {
  /** Guarded repositories for `ctx`, bound to this session's transactions. */
  repository(ctx: TenantContext): ScopedPrisma;
  /** Control-plane readers bound to the control transaction (the same one when shared). */
  control: AdmissionControlReader;
}
// The outer (control) transaction outlives the inner (data) one, so an inner timeout is
// reported before the outer one can expire mid-commit.
const ADMISSION_INNER_TX = {
  isolationLevel: "ReadCommitted",
  maxWait: 15_000,
  timeout: 30_000,
} as never;
const ADMISSION_OUTER_TX = {
  isolationLevel: "ReadCommitted",
  maxWait: 15_000,
  timeout: 45_000,
} as never;
/** Acquire the control-plane fence first and the data-plane fence second. For shared
 * placement one transaction serves both (a second advisory lock would self-deadlock);
 * for dedicated placement the control fence is retained through the data-plane commit.
 */
export async function withAdmissionSession<T>(
  ctx: TenantContext,
  run: (session: AdmissionSession) => Promise<T>
): Promise<T> {
  const client = getDataPlaneClient(ctx.dataConnection);
  const dedicated = client !== sharedClient;
  const open = (control: Prisma.TransactionClient, data: Prisma.TransactionClient) =>
    run({
      control: controlReader(control, ctx.businessId),
      repository(scoped) {
        effectiveResourceScope(scoped);
        if (scoped.businessId !== ctx.businessId || scoped.dataConnection !== ctx.dataConnection)
          throw new AppError(403, "FORBIDDEN", "Admission session is bound to one workspace");
        const guard = createResourceGuard(scoped, data, dedicated ? control : data);
        return repositorySurface(async (key, operation, args) => {
          const isControl = CONTROL_PLANE_RESIDENT_SET.has(key);
          if (
            isControl &&
            dedicated &&
            !operation.startsWith("find") &&
            !["count", "aggregate", "groupBy"].includes(operation)
          )
            throw new AppError(
              403,
              "FORBIDDEN",
              "Operation requires a separate authorized context"
            );
          const delegate = Reflect.get(isControl && dedicated ? control : data, key);
          const prepared = await guard.prepare(key, operation, args);
          return Reflect.apply(Reflect.get(delegate, operation), delegate, [prepared]);
        }) as unknown as ScopedPrisma;
      },
    });
  if (!dedicated)
    return sharedClient.$transaction(async (tx) => {
      await lockTenantWrites(tx, ctx.businessId);
      return open(tx, tx);
    }, ADMISSION_INNER_TX);
  return sharedClient.$transaction(async (control) => {
    await lockTenantWrites(control, ctx.businessId);
    return client.$transaction(async (data) => {
      await lockTenantWrites(data, ctx.businessId);
      return open(control, data);
    }, ADMISSION_INNER_TX);
  }, ADMISSION_OUTER_TX);
}
