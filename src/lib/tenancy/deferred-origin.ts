import { z } from "zod";
import type { TenantContext } from "./context";
import { AppError } from "@/lib/observability/errors";
import { readDeferredIdentity, type IdentityReader } from "@/lib/platform/deferred-origin";
import { intersectResourceScopes, validateResourceScope } from "./resource-scope";

const id = z.string().min(1).max(128);
const membership = z
  .object({ kind: z.literal("membership"), userId: id, membershipId: id })
  .strict();
const key = z.object({ kind: z.literal("api_key"), apiKeyId: id });
const origin = z.union([
  membership,
  key
    .extend({ scopeOrigin: z.literal("issuer"), issuerUserId: id, issuerMembershipId: id })
    .strict(),
  key.extend({ scopeOrigin: z.literal("legacy_workspace") }).strict(),
]);
const profile = z.enum(["none", "read", "write"]);
const scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), customerProfileAccess: profile }).strict(),
  z
    .object({
      kind: z.literal("connections"),
      customerProfileAccess: profile,
      connectionIds: z.array(id).max(200),
    })
    .strict(),
]);
const snapshot = z.object({ version: z.literal(1), businessId: id, origin, scope }).strict();
export type DeferredIdentityCeiling = z.infer<typeof snapshot>;
function deny(): never {
  throw new AppError(
    403,
    "DEFERRED_ORIGIN_UNAVAILABLE",
    "The recorded identity authority is unavailable"
  );
}
/** Capture fresh human/key identity and an intersected ceiling, never an authorization grant.
 * Provider origin has a separate lifecycle contract and is not inferred here.
 */
export async function captureDeferredIdentity(
  ctx: TenantContext
): Promise<DeferredIdentityCeiling> {
  const auth = ctx.authorization;
  if (!auth || !["user", "api_key", "ai_agent"].includes(ctx.actor.kind)) deny();
  let reference: z.infer<typeof membership> | z.infer<typeof key>;
  if (auth.kind === "membership") {
    if (
      ctx.actor.kind === "api_key" ||
      (ctx.actor.kind === "user" && ctx.actor.userId !== auth.userId)
    )
      deny();
    const parsed = membership.safeParse({
      kind: "membership",
      userId: auth.userId,
      membershipId: auth.membershipId,
    });
    if (!parsed.success) deny();
    reference = parsed.data;
  } else if (auth.kind === "api_key") {
    if (
      ctx.actor.kind === "user" ||
      (ctx.actor.kind === "api_key" && ctx.actor.apiKeyId !== auth.apiKeyId)
    )
      deny();
    const parsed = key.safeParse({ kind: "api_key", apiKeyId: auth.apiKeyId });
    if (!parsed.success) deny();
    reference = parsed.data;
  } else deny();
  try {
    const current = await readDeferredIdentity(ctx.businessId, reference);
    if (!current) deny();
    const value = {
      version: 1,
      businessId: ctx.businessId,
      origin: current.origin,
      scope: intersectResourceScopes(current.scope, validateResourceScope(ctx.resourceScope)),
    };
    const parsed = snapshot.safeParse(value);
    if (!parsed.success) deny();
    return parsed.data;
  } catch (error) {
    if (error instanceof AppError) deny();
    throw error;
  }
}
/** Strict saved identity refresh. Consumers must separately enforce exact job/action/resource
 * bindings and fresh operation policy; these facts cannot be used as TenantContext.
 */
export async function refreshDeferredIdentity(
  input: unknown,
  expectedBusinessId: string,
  bound?: IdentityReader
) {
  const parsed = snapshot.safeParse(input);
  if (!parsed.success || parsed.data.businessId !== expectedBusinessId) deny();
  const saved = parsed.data;
  try {
    const current = await readDeferredIdentity(saved.businessId, saved.origin, saved.origin, bound);
    if (!current) deny();
    return { ...current, scope: intersectResourceScopes(current.scope, saved.scope) };
  } catch (error) {
    if (error instanceof AppError) deny();
    throw error;
  }
}
