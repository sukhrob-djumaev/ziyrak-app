import { z } from "zod";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { NotFoundError } from "@/lib/observability/errors";
import { logActivity } from "@/lib/observability/activity";
import { toolRegistry } from "./registry";
import { DEFAULT_TOOL_POLICIES, resolveEffectiveToolPolicy, type EffectiveToolPolicy } from "./policy";

/**
 * PLAN.md §23.4 — tenant-facing management of `ToolPolicy`: before this, only a
 * database row could switch an AI tool on or off, restrict it to some roles, or
 * require a human to approve it first, so the approvals queue could never fill.
 * Every function here is business-scoped through `ctx`; the effective policy
 * (the business's own row, else the code default) is what `ToolRegistry` already
 * enforces, so a saved change takes effect on the AI's next tool call.
 */

/**
 * "Customised" means the effective policy differs from the default — not merely
 * that a row exists: signup seeds a row per tool equal to the default, which
 * must not look like a change the business made.
 */
function differsFromDefault(policy: EffectiveToolPolicy, fallback: EffectiveToolPolicy): boolean {
  const roles = (list: string[]) => [...new Set(list)].sort().join(",");
  return (
    policy.enabledForTenant !== fallback.enabledForTenant ||
    policy.allowedForAI !== fallback.allowedForAI ||
    policy.requiresHumanApproval !== fallback.requiresHumanApproval ||
    roles(policy.allowedForHumanRoles) !== roles(fallback.allowedForHumanRoles)
  );
}

/** Internal tools that are not a business-level setting. */
const HIDDEN_TOOLS: ReadonlySet<string> = new Set(["noop_test_action"]);

export interface ToolPolicyView {
  tool: string;
  description: string;
  /** True when this business's effective policy differs from the platform default. */
  customized: boolean;
  policy: EffectiveToolPolicy;
  defaultPolicy: EffectiveToolPolicy;
}

/**
 * Roles a policy may let run a tool by hand. `viewer` is deliberately absent:
 * viewers are read-only, and a tool without its own baseline permission would
 * otherwise become runnable by them on the strength of the policy alone.
 */
const HUMAN_ROLES = ["agent", "supervisor", "admin", "owner"] as const;

export const toolPolicyPatchSchema = z
  .object({
    enabledForTenant: z.boolean().optional(),
    allowedForAI: z.boolean().optional(),
    allowedForHumanRoles: z.array(z.enum(HUMAN_ROLES)).max(HUMAN_ROLES.length).optional(),
    requiresHumanApproval: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "Nothing to change" });

export type ToolPolicyPatch = z.infer<typeof toolPolicyPatchSchema>;

function visibleTool(name: string) {
  const tool = toolRegistry.get(name);
  if (!tool || HIDDEN_TOOLS.has(name)) throw new NotFoundError("Tool");
  return tool;
}

async function view(ctx: TenantContext, name: string, description: string): Promise<ToolPolicyView> {
  const policy = await resolveEffectiveToolPolicy(ctx, name);
  return { tool: name, description, customized: differsFromDefault(policy, DEFAULT_TOOL_POLICIES[name]), policy, defaultPolicy: DEFAULT_TOOL_POLICIES[name] };
}

export async function listToolPolicies(ctx: TenantContext): Promise<ToolPolicyView[]> {
  const tools = toolRegistry.getAllRegistered().filter((t) => !HIDDEN_TOOLS.has(t.name));
  const views = await Promise.all(tools.map((tool) => view(ctx, tool.name, tool.description)));
  return views.sort((x, y) => x.tool.localeCompare(y.tool));
}

/** True when the patch gives the AI or more people more power than `current` allows (for the audit trail). */
function widens(current: EffectiveToolPolicy, patch: ToolPolicyPatch): boolean {
  return (
    (patch.enabledForTenant === true && !current.enabledForTenant) ||
    (patch.allowedForAI === true && !current.allowedForAI) ||
    (patch.requiresHumanApproval === false && current.requiresHumanApproval) ||
    (patch.allowedForHumanRoles?.some((role) => !current.allowedForHumanRoles.includes(role)) ?? false)
  );
}

export async function updateToolPolicy(ctx: TenantContext, name: string, patch: ToolPolicyPatch, actorName?: string): Promise<ToolPolicyView> {
  const tool = visibleTool(name);
  const current = await resolveEffectiveToolPolicy(ctx, name);
  const change: ToolPolicyPatch = {
    ...patch,
    ...(patch.allowedForHumanRoles && { allowedForHumanRoles: Array.from(new Set(patch.allowedForHumanRoles)) }),
  };
  const full: EffectiveToolPolicy = { ...current, ...change };

  // Write only the fields being changed, so two simultaneous edits of different
  // fields cannot overwrite each other with a stale copy of the rest. When both
  // are first-time edits their creates collide (unique business+tool); the loser
  // retries as an update of just its own fields.
  const db = getScopedPrisma(ctx);
  const where = { businessId_tool: { businessId: ctx.businessId, tool: name } };
  for (let attempt = 0; ; attempt++) {
    try {
      await db.toolPolicy.upsert({ where, update: change, create: { businessId: ctx.businessId, tool: name, ...full } });
      break;
    } catch (error) {
      if (attempt >= 2 || (error as { code?: string }).code !== "P2002") throw error;
    }
  }

  const changed = (Object.keys(change) as (keyof EffectiveToolPolicy)[]).map((key) => `${key}=${JSON.stringify(change[key])}`).join(", ");
  const before = Object.fromEntries((Object.keys(change) as (keyof EffectiveToolPolicy)[]).map((key) => [key, current[key]]));
  await logActivity(ctx, "tool_policy.updated", "tool_policy", name, `Policy for tool "${name}" changed: ${changed}`, actorName, {
    tool: name,
    changes: change,
    before,
    widensAccess: widens(current, change),
  });
  return view(ctx, name, tool.description);
}

export async function resetToolPolicy(ctx: TenantContext, name: string, actorName?: string): Promise<ToolPolicyView> {
  const tool = visibleTool(name);
  const { count } = await getScopedPrisma(ctx).toolPolicy.deleteMany({ where: { tool: name } });
  if (count > 0) await logActivity(ctx, "tool_policy.reset", "tool_policy", name, `Policy for tool "${name}" was reset to the default`, actorName, { tool: name });
  return view(ctx, name, tool.description);
}
