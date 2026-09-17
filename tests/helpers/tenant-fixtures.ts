import { prisma } from "@/lib/prisma/raw-client";
import { hashPassword } from "@/lib/auth";
import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §35 — "tests/helpers/fixtures.ts ... is extended with
 * seedBusiness()/seedBusinessWithResource(type) helpers that create a
 * fully-formed Business + TenantPlacement (pointed at the shared-default
 * profile) + Membership + owner User in one call, becoming the standard
 * setup call for every new test written from Phase 1 onward."
 *
 * This is a separate module from tests/helpers/fixtures.ts (plain data
 * objects, no I/O) because these helpers require a real Postgres
 * connection — only test files that unmock "@/lib/prisma/raw-client" (the
 * same pattern tests/security/auth-bypass-regression.test.ts already uses
 * for "@/lib/route-auth") should import this.
 */

let counter = 0;

function uniqueSuffix(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${process.pid}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface SeededBusiness {
  businessId: string;
  slug: string;
  ownerUserId: string;
  ownerUsername: string;
  ctx: TenantContext;
}

/**
 * Creates one fully-formed, isolated Business (Business + TenantPlacement +
 * User + Membership("owner")) and returns its resolved `TenantContext`, per
 * §8.7's shape — the standard fixture for every isolation test.
 */
export async function seedBusiness(label = "test"): Promise<SeededBusiness> {
  const suffix = uniqueSuffix(label);
  const slug = `test-${suffix}`;

  const business = await prisma.business.create({ data: { slug, name: `Isolation Test Business ${suffix}` } });
  await prisma.tenantPlacement.create({ data: { businessId: business.id } });

  const passwordHash = await hashPassword("not-a-real-login-password");
  const user = await prisma.user.create({
    data: { username: `owner-${suffix}`, password: passwordHash, name: "Test Owner" },
  });
  await prisma.membership.create({ data: { businessId: business.id, userId: user.id, role: "owner" } });

  return {
    businessId: business.id,
    slug: business.slug,
    ownerUserId: user.id,
    ownerUsername: user.username,
    ctx: {
      businessId: business.id,
      role: "owner",
      actor: { kind: "user", userId: user.id },
      dataConnection: "shared-default",
    },
  };
}

/** Adds a second Membership (any role) to an existing seeded business's User pool, for role-check tests. */
export async function addMember(
  businessId: string,
  role: string,
  label = "member"
): Promise<{ userId: string; username: string; ctx: TenantContext }> {
  const suffix = uniqueSuffix(label);
  const passwordHash = await hashPassword("not-a-real-login-password");
  const user = await prisma.user.create({
    data: { username: `${label}-${suffix}`, password: passwordHash, name: `Test ${label}` },
  });
  await prisma.membership.create({ data: { businessId, userId: user.id, role } });

  return {
    userId: user.id,
    username: user.username,
    ctx: {
      businessId,
      role,
      actor: { kind: "user", userId: user.id },
      dataConnection: "shared-default",
    },
  };
}

/**
 * Deletes a seeded business and everything it owns. Every tenant-owned
 * model cascades from `Business` (§7.1's `onDelete: Cascade` on every
 * relation), so deleting the `Business` row is sufficient for its data;
 * the `User`/`Membership` rows this helper created are cleaned up
 * explicitly since `User` is not itself tenant-owned (§16.4).
 */
export async function cleanupBusiness(businessId: string): Promise<void> {
  const memberships = await prisma.membership.findMany({ where: { businessId }, select: { userId: true } });
  await prisma.business.delete({ where: { id: businessId } }).catch(() => {});
  for (const { userId } of memberships) {
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  }
}
