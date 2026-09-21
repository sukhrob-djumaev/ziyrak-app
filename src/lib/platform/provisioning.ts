import crypto from "crypto";
import { prisma } from "@/lib/prisma/raw-client";
import { Prisma } from "@/generated/prisma/client";
import { hashPassword } from "@/lib/identity/auth";
import { DEFAULT_TOOL_POLICIES } from "@/lib/tools/policy";
import { AppError } from "@/lib/observability/errors";

/**
 * PLAN.md §7/§46.7 task 3 — the one place a brand-new `Business` is created
 * for real (previously the shape existed only in the Phase 1 migration
 * script, `prisma/seed.ts`, and `/api/auth`'s one-time setup branch). Runs
 * before any `TenantContext` exists (it is what creates the tenant one is
 * later resolved from), hence the raw client — same justification as the
 * rest of `platform/`.
 *
 * Everything below happens in one transaction: a failure at any step (a
 * username collision, a constraint violation) leaves no half-created
 * business, no orphan user, and no membership-less tenant. Nothing is copied
 * from the Default Business or any other tenant, and no id/role/tenant value
 * is accepted from the caller — the owner role, the shared-default placement
 * and the business id are all decided here, server-side.
 */

/** Tools that exist only to exercise the approval mechanism (§34.3 item 6) are never seeded for a real tenant. */
const NON_TENANT_TOOLS = new Set(["noop_test_action"]);

export interface ProvisionBusinessInput {
  businessName: string;
  ownerUsername: string;
  ownerPassword: string;
  ownerName?: string;
  businessDesc?: string;
  welcomeMessage?: string;
  tone?: string;
}

export interface ProvisionedBusiness {
  businessId: string;
  slug: string;
  userId: string;
}

/**
 * A URL-safe, human-legible base plus a random suffix. The suffix is what
 * makes collisions negligible *and* guarantees no signup can ever produce the
 * reserved slug `"default"` — `getDefaultBusinessId()` resolves the Default
 * Business by that exact slug and `assertDefaultBusinessOnly()` grants it
 * privileges (the dev/demo WhatsApp Web session), so a business merely being
 * *named* "Default" must not be able to become it.
 */
export function generateBusinessSlug(businessName: string): string {
  const base =
    businessName
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "business";
  return `${base}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Whether `error` is a unique-constraint violation on `field`. Prisma's
 * `meta.target` is not shaped consistently across drivers (with the pg driver
 * adapter it is nested under `driverAdapterError`, and the message carries
 * the field name), so this checks every place the field name can appear
 * rather than assuming one — a lost race must map to a clean 409, never a 500.
 */
function isUniqueViolation(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  let haystack = error.message;
  try {
    haystack += JSON.stringify(error.meta ?? {});
  } catch {
    // meta with a circular reference — the message alone is enough
  }
  return haystack.includes(field);
}

export async function provisionBusiness(input: ProvisionBusinessInput): Promise<ProvisionedBusiness> {
  const username = input.ownerUsername.trim();

  // A case-insensitive pre-check (the DB constraint is case-sensitive) so
  // "Admin" cannot be registered next to "admin" and read as the same person.
  // The transaction below still relies on the real unique constraint for the
  // race where two signups pick the same name at once.
  const taken = await prisma.user.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
    select: { id: true },
  });
  if (taken) throw new AppError(409, "USERNAME_TAKEN", "That username is already taken.");

  const passwordHash = await hashPassword(input.ownerPassword);

  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = generateBusinessSlug(input.businessName);
    try {
      return await prisma.$transaction(async (tx) => {
        const business = await tx.business.create({
          data: { slug, name: input.businessName.trim(), status: "active" },
        });

        await tx.tenantPlacement.create({ data: { businessId: business.id } });

        const user = await tx.user.create({
          data: { username, password: passwordHash, name: input.ownerName?.trim() || username },
        });

        await tx.membership.create({ data: { businessId: business.id, userId: user.id, role: "owner" } });

        await tx.businessConfig.create({
          data: {
            businessId: business.id,
            businessName: input.businessName.trim(),
            ...(input.businessDesc !== undefined && { businessDesc: input.businessDesc }),
            ...(input.welcomeMessage?.trim() && { welcomeMessage: input.welcomeMessage.trim() }),
            ...(input.tone && { tone: input.tone }),
          },
        });

        // Explicit, complete rows (every column set), not just the tools a
        // business happens to override: a *partial* row would inherit Prisma's
        // column defaults (`allowedForAI: false`) rather than the tool's own
        // curated default (§46.6's recorded sharp edge), silently disabling
        // AI use of a tool for a brand-new business.
        await tx.toolPolicy.createMany({
          data: Object.entries(DEFAULT_TOOL_POLICIES)
            .filter(([tool]) => !NON_TENANT_TOOLS.has(tool))
            .map(([tool, policy]) => ({
              businessId: business.id,
              tool,
              enabledForTenant: policy.enabledForTenant,
              allowedForAI: policy.allowedForAI,
              allowedForHumanRoles: policy.allowedForHumanRoles,
              requiresHumanApproval: policy.requiresHumanApproval,
            })),
        });

        await tx.activityLog.create({
          data: {
            businessId: business.id,
            action: "business.created",
            entity: "business",
            entityId: business.id,
            description: `Business "${business.name}" signed up`,
            userId: user.id,
            userName: user.name || user.username,
          },
        });

        return { businessId: business.id, slug: business.slug, userId: user.id };
      });
    } catch (error) {
      if (isUniqueViolation(error, "username")) {
        throw new AppError(409, "USERNAME_TAKEN", "That username is already taken.");
      }
      // A slug collision (4 random bytes — vanishingly rare) is the only other
      // unique constraint in play; retry with a fresh suffix.
      if (isUniqueViolation(error, "slug") && attempt < 2) continue;
      throw error;
    }
  }

  throw new AppError(500, "PROVISIONING_FAILED", "Could not create the business. Please try again.");
}
