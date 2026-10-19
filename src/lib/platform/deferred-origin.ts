import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma/raw-client";
import { ROLES } from "@/lib/rbac/rbac";
import { scopeFromRecord, scopeIsWithin } from "@/lib/tenancy/resource-scope";
import type { ResourceScope } from "@/lib/tenancy/resource-scope";

/** Control-plane identity references only. These do not authorize an operation. */
export type DeferredIdentityOrigin =
  | { kind: "membership"; userId: string; membershipId: string }
  | {
      kind: "api_key";
      apiKeyId: string;
      scopeOrigin: "issuer";
      issuerUserId: string;
      issuerMembershipId: string;
    }
  | { kind: "api_key"; apiKeyId: string; scopeOrigin: "legacy_workspace" };
export interface CurrentDeferredIdentity {
  origin: DeferredIdentityOrigin;
  role: string;
  scope: ResourceScope;
  /** Present for an API key with an expiry; the admission re-judges it at its final timestamp. */
  expiresAt?: Date;
}
/** Narrow read-only control-plane surface; an admission session binds it to its transaction. */
export type IdentityReader = {
  business: Pick<Prisma.TransactionClient["business"], "findFirst">;
  membership: Pick<Prisma.TransactionClient["membership"], "findFirst">;
  apiKey: Pick<Prisma.TransactionClient["apiKey"], "findFirst">;
};
/** Fresh control-plane facts. Callers still own operation policy, binding and dispatch checks.
 * No original session is replayed: recorded intent survives logout/expiry by owner decision.
 */
export async function readDeferredIdentity(
  businessId: string,
  reference:
    | { kind: "membership"; userId: string; membershipId: string }
    | { kind: "api_key"; apiKeyId: string },
  expected?: DeferredIdentityOrigin,
  bound?: IdentityReader
): Promise<CurrentDeferredIdentity | null> {
  const read = async (tx: IdentityReader): Promise<CurrentDeferredIdentity | null> => {
    const business = await tx.business.findFirst({
      where: { id: businessId, status: "active" },
      select: { id: true },
    });
    if (!business) return null;
    if (reference.kind === "membership") {
      const member = await tx.membership.findFirst({
        where: { id: reference.membershipId, businessId, userId: reference.userId },
        include: { connectionScopes: true },
      });
      if (!member || !(ROLES as readonly string[]).includes(member.role)) return null;
      return {
        origin: { kind: "membership", userId: member.userId, membershipId: member.id },
        role: member.role,
        scope: scopeFromRecord(member),
      };
    }
    const key = await tx.apiKey.findFirst({
      where: { id: reference.apiKeyId, businessId },
      include: { connectionScopes: true },
    });
    if (!key || !key.isActive || key.revokedAt || !["viewer", "agent"].includes(key.role))
      return null;
    const scope = scopeFromRecord(key);
    let origin: DeferredIdentityOrigin;
    if (key.scopeOrigin === "issuer") {
      if (!key.issuedByUserId) return null;
      const issuer = await tx.membership.findFirst({
        where: { businessId, userId: key.issuedByUserId },
        include: { connectionScopes: true },
      });
      if (
        !issuer ||
        !["owner", "admin"].includes(issuer.role) ||
        !scopeIsWithin(scope, scopeFromRecord(issuer))
      )
        return null;
      origin = {
        kind: "api_key",
        apiKeyId: key.id,
        scopeOrigin: "issuer",
        issuerUserId: issuer.userId,
        issuerMembershipId: issuer.id,
      };
    } else if (key.scopeOrigin === "legacy_workspace" && !key.issuedByUserId) {
      origin = { kind: "api_key", apiKeyId: key.id, scopeOrigin: "legacy_workspace" };
    } else return null;
    if (
      expected &&
      (expected.kind !== "api_key" ||
        origin.kind !== "api_key" ||
        expected.apiKeyId !== origin.apiKeyId ||
        expected.scopeOrigin !== origin.scopeOrigin ||
        (expected.scopeOrigin === "issuer" &&
          (origin.scopeOrigin !== "issuer" ||
            expected.issuerUserId !== origin.issuerUserId ||
            expected.issuerMembershipId !== origin.issuerMembershipId)))
    )
      return null;
    // A lookup can wait across the boundary; return no facts for an expired key.
    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;
    return { origin, role: key.role, scope, expiresAt: key.expiresAt ?? undefined };
  };
  return bound ? read(bound) : prisma.$transaction(read);
}

/** Active shared control-plane destination metadata; never credentials or tenant data. */
export async function readDeferredProviderConnection(
  businessId: string,
  connectionId: string,
  bound?: { channelConnection: Pick<Prisma.TransactionClient["channelConnection"], "findFirst"> }
) {
  return (bound ?? prisma).channelConnection.findFirst({
    where: { id: connectionId, businessId, isActive: true, business: { status: "active" } },
    select: { id: true, type: true },
  });
}
