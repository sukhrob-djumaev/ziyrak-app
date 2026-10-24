import { Prisma } from "@/generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy/context";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import { hasPermission } from "@/lib/rbac/rbac";
import type {
  ActionStatus,
  ToolDefinition,
  ToolResult,
  ToolRuntimeContext,
  ToolAdmission,
} from "./types";
import { resolveEffectiveToolPolicy } from "./policy";
import { computeIdempotencyKey } from "./idempotency";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import { logActivity } from "@/lib/observability/activity";
import { emitNotification } from "@/lib/realtime/realtime";
import { WorkRetiredError } from "@/lib/tenancy/work-lifecycle";

const TERMINAL_STATUSES: ReadonlySet<ActionStatus> = new Set(["succeeded", "failed", "cancelled"]);

interface CachedResult {
  success?: boolean;
  message?: string;
  data?: unknown;
}

/**
 * PLAN.md §23.2 — replaces `ziyrakTools`/`executeToolCall`'s hardcoded switch
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
    const checks = await Promise.all(
      all.map(async (tool) => ((await this.isAvailable(ctx, tool)) ? tool : null))
    );
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
      return {
        success: false,
        message: `Tool "${name}" is not available to this caller.`,
        status: "failed",
      };
    }

    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return {
        success: false,
        message: `Invalid arguments for tool "${name}": ${parsed.error.message}`,
        status: "failed",
      };
    }

    if (tool.resolveConversationId) {
      try {
        runtimeCtx = {
          ...runtimeCtx,
          conversationId: await tool.resolveConversationId(ctx, parsed.data, runtimeCtx),
        };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return { success: false, status: "failed", message: error.message };
      }
    }
    const idempotencyKey = computeIdempotencyKey(ctx, runtimeCtx);
    const db = getScopedPrisma(ctx);

    const existing = await db.actionExecution.findUnique({
      where: { businessId_idempotencyKey: { businessId: ctx.businessId, idempotencyKey } },
    });
    if (existing) {
      if (
        existing.tool !== name ||
        (tool.resolveConversationId && existing.conversationId !== runtimeCtx.conversationId)
      )
        return {
          success: false,
          status: "failed",
          message: "This attempt key belongs to different tool work.",
        };
      if (existing.status === "pending_approval") {
        return {
          success: true,
          message: "This action is already pending human approval.",
          status: "pending_approval",
        };
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
      const pending = await db.actionExecution.create({
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
      await logActivity(
        ctx,
        "action.pending_approval",
        "action",
        null,
        `${requestedBy === "ai" ? "AI" : "A user"} requested "${name}", which needs human approval`,
        undefined,
        { tool: name, conversationId: runtimeCtx.conversationId ?? null }
      );
      emitNotification(ctx.businessId, "action.pending_approval", {
        tool: name,
        actionExecutionId: pending.id,
        ...(pending.conversationId && { conversationId: pending.conversationId }),
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

    return this.runAndRecord(
      ctx,
      tool,
      record.id,
      parsed.data,
      runtimeCtx,
      ctx.actor.kind === "ai_agent" ? "ai_tool" : "direct_tool"
    );
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
      throw new AppError(
        409,
        "NOT_PENDING_APPROVAL",
        `ActionExecution ${actionExecutionId} is not pending approval (status: ${record.status}).`
      );
    }

    const tool = this.tools.get(record.tool);
    if (!tool)
      throw new Error(`Unknown tool "${record.tool}" referenced by ActionExecution ${record.id}.`);

    const runtimeCtx = {
      conversationId: record.conversationId ?? undefined,
      idempotencyKey: record.idempotencyKey,
    };
    if (tool.resolveConversationId) {
      // Never infer a legacy action's missing parent from old model input.
      if (!record.conversationId)
        throw new AppError(
          409,
          "UNBOUND_ACTION",
          "This action has no authoritative conversation parent"
        );
      const input = tool.schema.safeParse(record.input);
      if (!input.success)
        throw new AppError(
          409,
          "INVALID_ACTION_INPUT",
          "This action requires a new validated request"
        );
      if ((await tool.resolveConversationId(ctx, input.data, runtimeCtx)) !== record.conversationId)
        throw new AppError(409, "CONFLICTING_PARENT", "Action conversation parents disagree");
    }
    const claimed = await db.actionExecution.updateMany({
      where: { id: record.id, status: "pending_approval" },
      data: { status: "requested" },
    });
    if (!claimed.count)
      throw new AppError(
        409,
        "NOT_PENDING_APPROVAL",
        "Another person already handled this action."
      );

    return this.runAndRecord(ctx, tool, record.id, record.input, runtimeCtx, "human_approval");
  }

  /** Rejects a `pending_approval` action — no side effect ever ran, so this is purely a status transition. */
  async reject(ctx: TenantContext, actionExecutionId: string): Promise<void> {
    const db = getScopedPrisma(ctx);
    const record = await db.actionExecution.findUnique({ where: { id: actionExecutionId } });
    if (!record) throw new NotFoundError("ActionExecution");
    if (record.status !== "pending_approval") {
      throw new AppError(
        409,
        "NOT_PENDING_APPROVAL",
        `ActionExecution ${actionExecutionId} is not pending approval (status: ${record.status}).`
      );
    }
    const rejected = await db.actionExecution.updateMany({
      where: { id: record.id, status: "pending_approval" },
      data: { status: "cancelled", completedAt: new Date() },
    });
    if (!rejected.count)
      throw new AppError(
        409,
        "NOT_PENDING_APPROVAL",
        "Another person already handled this action."
      );
    await logActivity(
      ctx,
      "action.rejected",
      "action",
      record.id,
      `"${record.tool}" was rejected and will not run`,
      undefined,
      { tool: record.tool }
    );
  }

  private async runAndRecord(
    ctx: TenantContext,
    tool: ToolDefinition,
    actionExecutionId: string,
    args: unknown,
    runtimeCtx: ToolRuntimeContext,
    admission: ToolAdmission
  ): Promise<ToolResult> {
    const executionCtx: TenantContext = {
      ...ctx,
      workBinding: {
        ...ctx.workBinding,
        ...(runtimeCtx.conversationId && { conversationId: runtimeCtx.conversationId }),
        actionExecutionId,
      },
    };
    const db = getScopedPrisma(executionCtx);
    const cancelled: ToolResult = {
      success: false,
      status: "cancelled",
      message: "This work was retired.",
    };
    try {
      const admitted = await db.actionExecution.updateMany({
        where: { id: actionExecutionId, status: "requested" },
        data: { status: "running" },
      });
      if (!admitted.count) return cancelled;
      const result = await tool.execute(executionCtx, args, runtimeCtx, admission);
      const saved = await db.actionExecution.updateMany({
        where: { id: actionExecutionId },
        data: {
          status: result.status,
          result: {
            success: result.success,
            message: result.message,
            data: result.data ?? null,
          } as Prisma.InputJsonValue,
          completedAt: TERMINAL_STATUSES.has(result.status) ? new Date() : null,
        },
      });
      if (!saved.count) return cancelled;
      await logActivity(
        executionCtx,
        `tool.${result.status}`,
        "action",
        actionExecutionId,
        `"${tool.name}" ${result.status}: ${result.message}`.slice(0, 500),
        undefined,
        {
          tool: tool.name,
          conversationId: runtimeCtx.conversationId ?? null,
        }
      );
      return result;
    } catch (error) {
      if (error instanceof WorkRetiredError) return cancelled;
      const current = await db.actionExecution.findUnique({ where: { id: actionExecutionId } });
      if (!current || current.retiredAt) return cancelled;
      const message = error instanceof Error ? error.message : "Unknown error";
      let saved;
      try {
        saved = await db.actionExecution.updateMany({
          where: { id: actionExecutionId },
          data: { status: "failed", errorMessage: message, completedAt: new Date() },
        });
      } catch (checkpointError) {
        if (checkpointError instanceof WorkRetiredError) return cancelled;
        throw checkpointError;
      }
      if (!saved.count) return cancelled;
      await logActivity(
        executionCtx,
        "tool.failed",
        "action",
        actionExecutionId,
        `"${tool.name}" failed: ${message}`.slice(0, 500),
        undefined,
        { tool: tool.name }
      );
      return {
        success: false,
        message: `Tool "${tool.name}" failed: ${message}`,
        status: "failed",
      };
    }
  }
}

export const toolRegistry = new ToolRegistry();
