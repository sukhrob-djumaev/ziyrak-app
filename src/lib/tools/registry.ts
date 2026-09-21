import { Prisma } from "@/generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { hasPermission } from "@/lib/rbac/rbac";
import type { ActionStatus, ToolDefinition, ToolResult, ToolRuntimeContext } from "./types";
import { resolveEffectiveToolPolicy } from "./policy";
import { computeIdempotencyKey } from "./idempotency";
import { AppError, NotFoundError } from "@/lib/observability/errors";

const TERMINAL_STATUSES: ReadonlySet<ActionStatus> = new Set(["succeeded", "failed", "cancelled"]);

interface CachedResult {
  success?: boolean;
  message?: string;
  data?: unknown;
}

/**
 * PLAN.md §23.2 — replaces `owlyTools`/`executeToolCall`'s hardcoded switch
 * (§23.1). One registry instance, shared across the app; every built-in
 * tool self-registers at module load (`builtin/index.ts`).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAllRegistered(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * PLAN.md §9.5/§23.2 — AI actors are filtered by `ToolPolicy` alone
   * (never RBAC, since there is no `Membership` row for the AI to have a
   * role on); human actors (`user`/`api_key`) are filtered by RBAC *and*
   * `ToolPolicy`, independently — either one can deny. Every other actor
   * kind (`system_job`, `channel_credential`, `platform_admin`) never
   * calls tools through the registry and is denied by construction.
   */
  async getAvailableTools(ctx: TenantContext): Promise<ToolDefinition[]> {
    const all = Array.from(this.tools.values());
    const checks = await Promise.all(all.map(async (tool) => (await this.isAvailable(ctx, tool)) ? tool : null));
    return checks.filter((tool): tool is ToolDefinition => tool !== null);
  }

  private async isAvailable(ctx: TenantContext, tool: ToolDefinition): Promise<boolean> {
    const policy = await resolveEffectiveToolPolicy(ctx, tool.name);
    if (!policy.enabledForTenant) return false;

    switch (ctx.actor.kind) {
      case "ai_agent":
        return policy.allowedForAI;
      case "user":
      case "api_key": {
        const role = ctx.role ?? "";
        if (tool.requiredPermission && !hasPermission(role, tool.requiredPermission)) return false;
        return policy.allowedForHumanRoles.includes(role);
      }
      case "channel_credential":
      case "system_job":
      case "platform_admin":
        return false;
    }
  }

  private requestedByFor(ctx: TenantContext): string {
    switch (ctx.actor.kind) {
      case "ai_agent":
        return "ai";
      case "user":
        return ctx.actor.userId;
      case "api_key":
        return ctx.actor.apiKeyId;
      case "channel_credential":
        return ctx.actor.channelConnectionId;
      case "system_job":
        return "system";
      case "platform_admin":
        return ctx.actor.userId;
    }
  }

  /**
   * PLAN.md §23.2's eight-step sequence: re-check availability (never trust
   * `getAvailableTools` was called first) → validate args (Zod) → check
   * idempotency (short-circuit on a repeated attempt) → approval gate (AI
   * only) → create the durable `ActionExecution` → run → record the real
   * outcome. An `ActionExecution` row exists for every attempt that got far
   * enough to matter — not for an unknown tool or invalid arguments, which
   * are caller/model mistakes, not attempts.
   */
  async execute(
    ctx: TenantContext,
    name: string,
    args: unknown,
    runtimeCtx: ToolRuntimeContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, message: `Unknown tool: ${name}`, status: "failed" };
    }

    const allowed = await this.isAvailable(ctx, tool);
    if (!allowed) {
      return { success: false, message: `Tool "${name}" is not available to this caller.`, status: "failed" };
    }

    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return { success: false, message: `Invalid arguments for tool "${name}": ${parsed.error.message}`, status: "failed" };
    }

    const idempotencyKey = computeIdempotencyKey(ctx, runtimeCtx);
    const db = getScopedPrisma(ctx);

    const existing = await db.actionExecution.findUnique({
      where: { businessId_idempotencyKey: { businessId: ctx.businessId, idempotencyKey } },
    });
    if (existing) {
      if (existing.status === "pending_approval") {
        return { success: true, message: "This action is already pending human approval.", status: "pending_approval" };
      }
      const cached = existing.result as CachedResult | null;
      return {
        success: cached?.success ?? false,
        message: cached?.message ?? `Action already recorded with status "${existing.status}".`,
        data: cached?.data,
        status: existing.status as ActionStatus,
      };
    }

    const policy = await resolveEffectiveToolPolicy(ctx, name);
    const requestedBy = this.requestedByFor(ctx);
    const input = parsed.data as Prisma.InputJsonValue;

    if (ctx.actor.kind === "ai_agent" && policy.requiresHumanApproval) {
      await db.actionExecution.create({
        data: {
          businessId: ctx.businessId,
          tool: name,
          status: "pending_approval",
          input,
          conversationId: runtimeCtx.conversationId ?? null,
          requestedBy,
          idempotencyKey,
        },
      });
      return {
        success: true,
        message: `This action ("${name}") requires human approval before it will run. It has been forwarded for review.`,
        status: "pending_approval",
      };
    }

    const record = await db.actionExecution.create({
      data: {
        businessId: ctx.businessId,
        tool: name,
        status: "requested",
        input,
        conversationId: runtimeCtx.conversationId ?? null,
        requestedBy,
        idempotencyKey,
      },
    });

    return this.runAndRecord(ctx, tool, record.id, parsed.data, runtimeCtx);
  }

  /**
   * PLAN.md §23.4's approval path: a human transitions a `pending_approval`
   * `ActionExecution` to actually running. No side effect occurred before
   * this call (§23.4); the tool's `execute()` runs for the first time here,
   * against the exact `input`/`idempotencyKey` recorded when the AI first
   * requested it.
   */
  async approve(ctx: TenantContext, actionExecutionId: string): Promise<ToolResult> {
    const db = getScopedPrisma(ctx);
    const record = await db.actionExecution.findUnique({ where: { id: actionExecutionId } });
    if (!record) throw new NotFoundError("ActionExecution");
    if (record.status !== "pending_approval") {
      throw new AppError(409, "NOT_PENDING_APPROVAL", `ActionExecution ${actionExecutionId} is not pending approval (status: ${record.status}).`);
    }

    const tool = this.tools.get(record.tool);
    if (!tool) throw new Error(`Unknown tool "${record.tool}" referenced by ActionExecution ${record.id}.`);

    await db.actionExecution.update({ where: { id: record.id }, data: { status: "requested" } });

    return this.runAndRecord(ctx, tool, record.id, record.input, {
      conversationId: record.conversationId ?? undefined,
      idempotencyKey: record.idempotencyKey,
    });
  }

  /** Rejects a `pending_approval` action — no side effect ever ran, so this is purely a status transition. */
  async reject(ctx: TenantContext, actionExecutionId: string): Promise<void> {
    const db = getScopedPrisma(ctx);
    const record = await db.actionExecution.findUnique({ where: { id: actionExecutionId } });
    if (!record) throw new NotFoundError("ActionExecution");
    if (record.status !== "pending_approval") {
      throw new AppError(409, "NOT_PENDING_APPROVAL", `ActionExecution ${actionExecutionId} is not pending approval (status: ${record.status}).`);
    }
    await db.actionExecution.update({ where: { id: record.id }, data: { status: "cancelled", completedAt: new Date() } });
  }

  private async runAndRecord(
    ctx: TenantContext,
    tool: ToolDefinition,
    actionExecutionId: string,
    args: unknown,
    runtimeCtx: ToolRuntimeContext
  ): Promise<ToolResult> {
    const db = getScopedPrisma(ctx);
    try {
      const result = await tool.execute(ctx, args, runtimeCtx);
      await db.actionExecution.update({
        where: { id: actionExecutionId },
        data: {
          status: result.status,
          result: { success: result.success, message: result.message, data: result.data ?? null } as Prisma.InputJsonValue,
          completedAt: TERMINAL_STATUSES.has(result.status) ? new Date() : null,
        },
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await db.actionExecution.update({
        where: { id: actionExecutionId },
        data: { status: "failed", errorMessage: message, completedAt: new Date() },
      });
      return { success: false, message: `Tool "${tool.name}" failed: ${message}`, status: "failed" };
    }
  }
}

export const toolRegistry = new ToolRegistry();
