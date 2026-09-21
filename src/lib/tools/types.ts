import type { z } from "zod";
import type { TenantContext } from "@/lib/tenancy/context";
import type { Permission } from "@/lib/rbac/rbac";

/**
 * PLAN.md §24.2/§24.3 — mirrors `ActionExecution.status`'s string union.
 * Not a Prisma enum (the schema stores `status` as a plain `String`,
 * matching every other status-like field in this codebase, e.g.
 * `Conversation.status`/`Ticket.status`) — this is the typed view of it.
 */
export type ActionStatus =
  | "requested"
  | "pending_approval"
  | "scheduled"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** PLAN.md §23.2 — what a tool's own `execute()` returns to the registry. */
export interface ToolResult {
  success: boolean;
  message: string;
  data?: unknown;
  status: ActionStatus;
}

/**
 * The context a tool's `execute()` receives about the call it's satisfying,
 * distinct from `ctx: TenantContext` (who/what tenant is calling) — this is
 * what the call itself is *for*. `toolCallId` is the AI provider's own
 * per-call id (§24.4's idempotency key source for AI-initiated calls);
 * `idempotencyKey` lets a non-AI caller (API/manual) supply its own.
 */
export interface ToolRuntimeContext {
  conversationId?: string;
  toolCallId?: string;
  idempotencyKey?: string;
}

/**
 * PLAN.md §23.2 — one built-in tool. `schema` replaces today's hand-written
 * JSON-schema `parameters` blocks (§23.1) with a single Zod source of
 * truth: the registry validates against it directly, and the same schema
 * is converted to JSON Schema (`schema-json.ts`) for the AI provider's own
 * `tools` field, so the two can never drift apart.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  /** Checked for HUMAN actors only (§9.5) — e.g. "tickets:create". Unset means RBAC imposes no extra gate beyond `ToolPolicy.allowedForHumanRoles`. */
  requiredPermission?: Permission;
  execute(ctx: TenantContext, args: unknown, runtimeCtx: ToolRuntimeContext): Promise<ToolResult>;
}
