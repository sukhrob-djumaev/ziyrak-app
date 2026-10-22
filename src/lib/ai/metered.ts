import type { TenantContext } from "@/lib/tenancy/context";
import { logger } from "@/lib/observability/logger";
import { AIProviderError } from "./providers/types";
import {
  reserveAllowance,
  settleReservation,
  releaseReservation,
  markReservationUncertain,
  type AllowanceKind,
} from "./allowance";

/**
 * PLAN.md P2 — wraps one potentially billable provider attempt: reserve a
 * conservative bound first, call, then settle to actual usage. A failure that
 * cannot have billed (auth, invalid request) releases the reservation; an
 * unknown outcome keeps the reserved bound charged. If the ledger itself
 * fails, no paid work starts (fail closed). Unmanaged workspaces pass through.
 */
export class AllowanceError extends Error {
  constructor(
    public reason: "not_configured" | "suspended" | "exhausted" | "accounting_unavailable" | "prompt_too_large",
    message?: string
  ) {
    super(message ?? `AI allowance unavailable: ${reason}`);
    this.name = "AllowanceError";
  }
}

export interface MeteredOptions<T> {
  kind: AllowanceKind;
  managed: boolean;
  /** Conservative upper bound of tokens this attempt can consume. */
  estimateTokens: number;
  /** Estimated prompt size, checked against the policy's prompt bound. */
  promptTokens?: number;
  maxPromptTokens?: number;
  /** Provider-reported total tokens of a finished call. */
  usageOf: (result: T) => number;
  idempotencyKey?: string;
}

/** Rough prompt-size estimate (about 3 characters per token), deliberately conservative. */
export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 3);
}

const NEVER_BILLED: ReadonlySet<string> = new Set(["auth", "invalid_request"]);

export async function meteredCall<T>(ctx: TenantContext, options: MeteredOptions<T>, call: () => Promise<T>): Promise<T> {
  if (!options.managed) return call();

  if (options.promptTokens != null && options.maxPromptTokens != null && options.promptTokens > options.maxPromptTokens) {
    throw new AllowanceError("prompt_too_large");
  }

  let reserved;
  try {
    reserved = await reserveAllowance({
      businessId: ctx.businessId,
      kind: options.kind,
      tokens: options.estimateTokens,
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
    });
  } catch (error) {
    logger.error("AI allowance accounting failed; refusing paid work", {
      businessId: ctx.businessId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new AllowanceError("accounting_unavailable");
  }
  if (!reserved.ok) throw new AllowanceError(reserved.reason);

  let result: T;
  try {
    result = await call();
  } catch (error) {
    const billed = !(error instanceof AIProviderError && NEVER_BILLED.has(error.code));
    await (billed ? markReservationUncertain : releaseReservation)(ctx.businessId, reserved.reservationId).catch((e) =>
      logger.error("Failed to finalize AI reservation after provider error", { businessId: ctx.businessId, e: String(e) })
    );
    throw error;
  }
  await settleReservation(ctx.businessId, reserved.reservationId, options.usageOf(result)).catch((e) =>
    logger.error("Failed to settle AI reservation; the reserved bound stays charged", { businessId: ctx.businessId, e: String(e) })
  );
  return result;
}
