import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";

export interface EffectiveToolPolicy {
  enabledForTenant: boolean;
  allowedForAI: boolean;
  allowedForHumanRoles: string[];
  requiresHumanApproval: boolean;
}

/**
 * PLAN.md §23.4's illustrative default table, made real. A business with no
 * `ToolPolicy` row for a tool (the common case — no signup/onboarding flow
 * seeds these yet) gets these code-level defaults rather than an unusable
 * "no policy means denied" state; a business can still override any of
 * these by creating its own `ToolPolicy` row (§23.4's "edit via settings
 * UI, tenant-scoped" — the row always wins over the default when present).
 *
 * `schedule_followup.enabledForTenant` was `false` from PR1 through PR2 —
 * the literal mechanism behind §24.3's Phase 6/7 boundary fix (review
 * concern 11): the tool was defined and registered from PR1 onward, but
 * disabled for every actor kind (AI and human alike) until this PR3 change
 * flipped it to `true`, now that PR2's real `PgBossJobQueue` exists to
 * back the "scheduled" status it returns (`tools/builtin/
 * schedule-followup.ts`) — this is the first point in this codebase's
 * history the tool has ever been reachable at all.
 */
export const DEFAULT_TOOL_POLICIES: Record<string, EffectiveToolPolicy> = {
  create_ticket: {
    enabledForTenant: true,
    allowedForAI: true,
    allowedForHumanRoles: ["agent", "supervisor", "admin", "owner"],
    requiresHumanApproval: false,
  },
  get_customer_history: {
    enabledForTenant: true,
    allowedForAI: true,
    allowedForHumanRoles: ["agent", "supervisor", "admin", "owner"],
    requiresHumanApproval: false,
  },
  schedule_followup: {
    enabledForTenant: true, // PLAN.md §24.3/§46.6 PR3 — flipped from false now that PgBossJobQueue exists.
    allowedForAI: true,
    allowedForHumanRoles: ["agent", "supervisor", "admin", "owner"],
    requiresHumanApproval: false,
  },
  send_internal_email: {
    enabledForTenant: true,
    allowedForAI: true,
    allowedForHumanRoles: ["agent", "supervisor", "admin", "owner"],
    requiresHumanApproval: false,
  },
  trigger_webhook: {
    enabledForTenant: true,
    allowedForAI: true,
    allowedForHumanRoles: ["supervisor", "admin", "owner"],
    requiresHumanApproval: false,
  },
  assign_to_person: {
    enabledForTenant: true,
    allowedForAI: true,
    allowedForHumanRoles: ["agent", "supervisor", "admin", "owner"],
    requiresHumanApproval: false,
  },
  // §24.3/§34.3 item 6 — no real high-stakes built-in tool ships in this
  // plan's scope; this synthetic tool exists solely to prove and regression
  // -test the pending_approval mechanism end to end. Disabled for AI by
  // default (a business must explicitly opt in via its own ToolPolicy row)
  // so no tenant unexpectedly gains a new AI-callable tool from this phase.
  noop_test_action: {
    enabledForTenant: true,
    allowedForAI: false,
    allowedForHumanRoles: ["agent", "supervisor", "admin", "owner"],
    requiresHumanApproval: true,
  },
};

/**
 * Resolves the effective policy for one (business, tool) pair: the
 * business's own `ToolPolicy` row if it has one, otherwise the code-level
 * default above. Throws for a tool with no registered default — a
 * programming error (every tool the registry knows about must have one),
 * never a runtime/tenant-data condition.
 */
export async function resolveEffectiveToolPolicy(ctx: TenantContext, tool: string): Promise<EffectiveToolPolicy> {
  const fallback = DEFAULT_TOOL_POLICIES[tool];
  if (!fallback) {
    throw new Error(`No default ToolPolicy registered for tool "${tool}" — every tool must have one (PLAN.md §23.4).`);
  }

  const db = getScopedPrisma(ctx);
  const row = await db.toolPolicy.findUnique({
    where: { businessId_tool: { businessId: ctx.businessId, tool } },
  });

  if (!row) return fallback;

  return {
    enabledForTenant: row.enabledForTenant,
    allowedForAI: row.allowedForAI,
    allowedForHumanRoles: row.allowedForHumanRoles as string[],
    requiresHumanApproval: row.requiresHumanApproval,
  };
}
