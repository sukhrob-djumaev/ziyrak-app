import { NextResponse } from "next/server";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * PLAN.md §8.5/§33.3 — thrown by `assertSameTenant()` and by service
 * functions that look up a resource by client-supplied id and find nothing
 * in the caller's own tenant scope. Always resolves to a 404, deliberately
 * indistinguishable from "this id does not exist" — a cross-tenant
 * reference must never be revealed as "exists, but forbidden" (§33.3).
 */
export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, "NOT_FOUND", `${resource} not found`);
    this.name = "NotFoundError";
  }
}

export function errorResponse(
  statusCode: number,
  code: string,
  message: string,
  requestId?: string,
  details?: unknown
): NextResponse {
  const error: Record<string, unknown> = { code, message };
  if (details) error.details = details;
  if (requestId) error.requestId = requestId;

  return NextResponse.json({ error }, { status: statusCode });
}

// Common error factories
export const Errors = {
  notFound: (resource: string, requestId?: string) =>
    errorResponse(404, "NOT_FOUND", `${resource} not found`, requestId),

  badRequest: (message: string, requestId?: string, details?: unknown) =>
    errorResponse(400, "VALIDATION_ERROR", message, requestId, details),

  unauthorized: (requestId?: string) =>
    errorResponse(401, "UNAUTHORIZED", "Authentication required", requestId),

  forbidden: (requestId?: string) =>
    errorResponse(403, "FORBIDDEN", "Insufficient permissions", requestId),

  tooManyRequests: (retryAfter: number, requestId?: string) => {
    const response = errorResponse(
      429,
      "RATE_LIMIT_EXCEEDED",
      "Too many requests. Please try again later.",
      requestId
    );
    response.headers.set("Retry-After", String(retryAfter));
    return response;
  },

  internal: (requestId?: string) =>
    errorResponse(
      500,
      "INTERNAL_ERROR",
      "An unexpected error occurred",
      requestId
    ),
} as const;

/**
 * Shared catch-block helper for service-layer errors (§16.2's service
 * functions throw `AppError`/`NotFoundError` rather than building a
 * `NextResponse` themselves, since a service function is also called from
 * non-HTTP contexts like workers, §16.3). Route handlers convert at the
 * boundary with this.
 */
export function toErrorResponse(error: unknown, requestId?: string): NextResponse {
  if (error instanceof AppError) {
    return errorResponse(error.statusCode, error.code, error.message, requestId, error.details);
  }
  return Errors.internal(requestId);
}
