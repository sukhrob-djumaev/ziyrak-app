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
  return new Proxy(extended, {
    get(target, property, receiver) {
      if (property === "$extends")
        throw new AppError(
          403,
          "FORBIDDEN",
          "Tenant repositories cannot expose unguarded extension clients"
        );
      if (property === "$transaction") {
        return (input: unknown, options?: Record<string, unknown>) => {
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
              const wrapped = new Proxy(transaction, {
                get(tx, key, txReceiver) {
                  if (typeof key === "string" && key.startsWith("$"))
                    throw new AppError(
                      403,
                      "FORBIDDEN",
                      "Unscoped transaction operations are unavailable"
                    );
                  if (typeof key !== "string") return Reflect.get(tx, key, txReceiver);
                  const isControl = CONTROL_PLANE_RESIDENT_SET.has(key);
                  const delegate =
                    isControl && client !== sharedClient
                      ? Reflect.get(sharedClient, key)
                      : Reflect.get(tx, key, txReceiver);
                  if (!delegate || typeof delegate !== "object") return delegate;
                  return new Proxy(delegate, {
                    get(modelDelegate, operation, modelReceiver) {
                      const method = Reflect.get(modelDelegate, operation, modelReceiver);
                      if (typeof method !== "function") return method;
                      return async (args: Record<string, unknown> = {}) => {
                        if (typeof operation !== "string")
                          throw new AppError(403, "INVALID_SCOPE", "Unknown repository operation");
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
                        const prepared = await transactionGuard.prepare(key, operation, args);
                        return Reflect.apply(method, modelDelegate, [prepared]);
                      };
                    },
                  });
                },
              });
              return (input as (tx: typeof transaction) => Promise<unknown>)(wrapped);
            },
            { ...options, isolationLevel: "ReadCommitted" } as never
          );
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export type ScopedPrisma = ReturnType<typeof getScopedPrisma>;
