import { z } from "zod";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { NotFoundError } from "@/lib/observability/errors";
import { logActivity } from "@/lib/observability/activity";
import { ROLES } from "@/lib/rbac/rbac";
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

/** Internal tools that are not a business-level setting. */
const HIDDEN_TOOLS: ReadonlySet<string> = new Set(["noop_test_action"]);

export interface ToolPolicyView {
  tool: string;
  description: string;
  /** True when this business has its own row (otherwise the platform default applies). */
  customized: boolean;
  policy: EffectiveToolPolicy;
  defaultPolicy: EffectiveToolPolicy;
}

export const toolPolicyPatchSchema = z
  .object({
    enabledForTenant: z.boolean().optional(),
    allowedForAI: z.boolean().optional(),
    allowedForHumanRoles: z.array(z.enum(ROLES)).max(ROLES.length).optional(),
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
  const row = await getScopedPrisma(ctx).toolPolicy.findUnique({ where: { businessId_tool: { businessId: ctx.businessId, tool: name } } });
  return {
    tool: name,
    description,
    customized: row !== null,
    policy: await resolveEffectiveToolPolicy(ctx, name),
    defaultPolicy: DEFAULT_TOOL_POLICIES[name],
  };
}

export async function listToolPolicies(ctx: TenantContext): Promise<ToolPolicyView[]> {
  const tools = toolRegistry.getAllRegistered().filter((t) => !HIDDEN_TOOLS.has(t.name));
  const rows = await getScopedPrisma(ctx).toolPolicy.findMany({ select: { tool: true } });
  const customized = new Set(rows.map((r) => r.tool));
  const views: ToolPolicyView[] = [];
  for (const tool of tools) {
    views.push({
      tool: tool.name,
      description: tool.description,
      customized: customized.has(tool.name),
      policy: await resolveEffectiveToolPolicy(ctx, tool.name),
      defaultPolicy: DEFAULT_TOOL_POLICIES[tool.name],
    });
  }
  return views.sort((a, b) => a.tool.localeCompare(b.tool));
}

export async function updateToolPolicy(ctx: TenantContext, name: string, patch: ToolPolicyPatch, actorName?: string): Promise<ToolPolicyView> {
  const tool = visibleTool(name);
  const current = await resolveEffectiveToolPolicy(ctx, name);
  const next: EffectiveToolPolicy = {
    ...current,
    ...patch,
    allowedForHumanRoles: patch.allowedForHumanRoles ? Array.from(new Set(patch.allowedForHumanRoles)) : current.allowedForHumanRoles,
  };

  await getScopedPrisma(ctx).toolPolicy.upsert({
    where: { businessId_tool: { businessId: ctx.businessId, tool: name } },
    update: next,
    create: { businessId: ctx.businessId, tool: name, ...next },
  });

  const changed = (Object.keys(patch) as (keyof EffectiveToolPolicy)[]).map((key) => `${key}=${JSON.stringify(next[key])}`).join(", ");
  await logActivity(ctx, "tool_policy.updated", "tool_policy", name, `Policy for tool "${name}" changed: ${changed}`, actorName, { tool: name, changes: patch });
  return view(ctx, name, tool.description);
}

export async function resetToolPolicy(ctx: TenantContext, name: string, actorName?: string): Promise<ToolPolicyView> {
  const tool = visibleTool(name);
  const { count } = await getScopedPrisma(ctx).toolPolicy.deleteMany({ where: { tool: name } });
  if (count > 0) await logActivity(ctx, "tool_policy.reset", "tool_policy", name, `Policy for tool "${name}" was reset to the default`, actorName, { tool: name });
  return view(ctx, name, tool.description);
}
