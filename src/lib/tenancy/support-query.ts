import { z } from "zod";
import { AppError } from "@/lib/observability/errors";
import type { TenantContext } from "./context";

const listProfile = z
  .object({
    method: z.literal("GET"),
    pathname: z.literal("/api/conversations"),
    operation: z.literal("conversations:read"),
  })
  .strict();
const parentId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const messageProfile = z
  .object({
    method: z.literal("GET"),
    pathname: z.string(),
    operation: z.literal("messages:read"),
    parentId,
  })
  .strict()
  .refine((value) => value.pathname === `/api/conversations/${value.parentId}/messages`);
const messageFields = new Set(["id", "conversationId", "role", "content", "createdAt"]);
const scalarFields = new Set([
  "id",
  "businessId",
  "channel",
  "customerName",
  "customerContact",
  "status",
  "createdAt",
  "updatedAt",
]);
function deny(): never {
  throw new AppError(403, "SUPPORT_QUERY_UNAVAILABLE", "This support query is unavailable");
}
function object(input: unknown): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    deny();
  return input as Record<string, unknown>;
}
function scalar(field: string, input: unknown, depth = 0): unknown {
  if (depth > 16) deny();
  const dateField = ["createdAt", "updatedAt"].includes(field);
  const literal = (value: unknown): boolean =>
    dateField
      ? (value instanceof Date && Number.isFinite(value.getTime())) ||
        (typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}T/.test(value) &&
          Number.isFinite(Date.parse(value)))
      : typeof value === "string" && value.length <= 1000;
  if (literal(input)) return input;
  const result: Record<string, unknown> = {};
  for (const [operator, value] of Object.entries(object(input))) {
    if (operator === "not") result.not = scalar(field, value, depth + 1);
    else if (["in", "notIn"].includes(operator)) {
      if (!Array.isArray(value) || value.length > 200 || !value.every(literal)) deny();
      result[operator] = [...value];
    } else if (
      [
        "equals",
        "lt",
        "lte",
        "gt",
        "gte",
        ...(!dateField ? ["contains", "startsWith", "endsWith"] : []),
      ].includes(operator)
    ) {
      if (!literal(value)) deny();
      result[operator] = value;
    } else if (
      !dateField &&
      operator === "mode" &&
      ["default", "insensitive"].includes(String(value))
    ) {
      if (typeof value !== "string") deny();
      result.mode = value;
    } else deny();
  }
  return result;
}
function fields(
  input: unknown,
  allowed: Set<string> = scalarFields,
  depth = 0
): Record<string, unknown> {
  if (depth > 16) deny();
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object(input))) {
    if (["AND", "OR", "NOT"].includes(key)) {
      if (Array.isArray(value)) {
        if (value.length > 200) deny();
        result[key] = value.map((part) => fields(part, allowed, depth + 1));
      } else result[key] = fields(value, allowed, depth + 1);
    } else {
      if (!allowed.has(key)) deny();
      // Only literal operands: Prisma FieldRef values can otherwise turn an
      // allowed field into an oracle over forbidden summary/metadata fields.
      result[key] = scalar(key, value);
    }
  }
  return result;
}
/** Query-shape prerequisite only. Identity must separately resolve a fresh,
 * audited grant and select the exact request profile before any exposure.
 * No route, SSR, stream or delayed-work support identity is activated here.
 */
export function prepareSupportQuery(
  ctx: TenantContext,
  model: string,
  operation: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const auth = ctx.authorization;
  const messageQuery = messageProfile.safeParse(ctx.supportQuery);
  const shape = messageQuery.success ? messageQuery.data : null;
  const supportOperation = shape
    ? "messages:read"
    : listProfile.safeParse(ctx.supportQuery).success
      ? "conversations:read"
      : null;
  const copiedSupport =
    auth?.kind === "delegated_job" &&
    (!auth.origin || !["membership", "api_key", "provider_inbound"].includes(auth.origin.kind));
  if (
    ctx.actor.kind !== "platform_admin" &&
    auth?.kind !== "support" &&
    !copiedSupport &&
    ctx.supportQuery === undefined
  )
    return args;
  if (
    ctx.actor.kind !== "platform_admin" ||
    ctx.role !== null ||
    auth?.kind !== "support" ||
    auth.userId !== ctx.actor.userId ||
    typeof ctx.actor.userId !== "string" ||
    !ctx.actor.userId ||
    ctx.actor.userId.length > 128 ||
    typeof auth.grantId !== "string" ||
    !auth.grantId ||
    auth.grantId.length > 128 ||
    !Array.isArray(auth.allowedOperations) ||
    !supportOperation ||
    !auth.allowedOperations.includes(supportOperation) ||
    !ctx.resourceScope ||
    !(shape
      ? (model === "message" && ["findMany", "count"].includes(operation)) ||
        (model === "conversation" && operation === "count")
      : model === "conversation" && ["findMany", "count"].includes(operation))
  )
    deny();
  const input = object(args);
  if (shape && model === "conversation") {
    // Parent verification only: the selected id, under the generic scope gate.
    if (Object.getOwnPropertyNames(input).some((key) => key !== "where")) deny();
    return {
      where: {
        AND: [
          fields(input.where ?? {}, new Set(["id"])),
          { id: shape.parentId },
          { retiredAt: null },
        ],
      },
    };
  }
  const allowedFields = shape ? messageFields : scalarFields;
  const keys = operation === "count" ? ["where"] : ["where", "select", "take", "skip", "orderBy"];
  if (Object.getOwnPropertyNames(input).some((key) => !keys.includes(key))) deny();
  // Capture once, validate and construct a fresh output. Inherited fields or
  // getter changes must not make validation differ from what Prisma receives.
  const { where, select: selectInput, take, skip, orderBy } = input;
  const result: Record<string, unknown> = {
    where: {
      AND: [
        fields(where ?? {}, allowedFields),
        // Text-only rows of exactly the selected, unretired parent. The caller
        // cannot widen the parent or re-admit media rows.
        shape
          ? {
              conversationId: shape.parentId,
              mediaType: null,
              mediaUrl: null,
              conversation: { is: { retiredAt: null } },
            }
          : { retiredAt: null },
      ],
    },
  };
  if (operation === "count") return result;
  const selection = Object.entries(object(selectInput));
  if (!selection.some(([, value]) => value === true)) deny();
  if (selection.some(([key, value]) => !allowedFields.has(key) || typeof value !== "boolean"))
    deny();
  result.select = Object.fromEntries(selection);
  if (!Number.isInteger(take) || Number(take) < 1 || Number(take) > 100) deny();
  result.take = take;
  if (skip !== undefined) {
    if (!Number.isInteger(skip) || Number(skip) < 0 || Number(skip) > 100_000) deny();
    result.skip = skip;
  }
  if (orderBy !== undefined) {
    const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
    if (orders.length > 8) deny();
    const validated = orders.map((order) => {
      const entries = Object.entries(object(order));
      if (
        entries.some(
          ([key, value]) => !allowedFields.has(key) || (value !== "asc" && value !== "desc")
        )
      )
        deny();
      return Object.fromEntries(entries);
    });
    result.orderBy = Array.isArray(orderBy) ? validated : validated[0];
  }
  return result;
}
