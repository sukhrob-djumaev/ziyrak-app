/**
 * F06: public handlers must never buffer an unbounded request body. A declared
 * Content-Length is only a hint (chunked requests omit it, and it can lie), so
 * the stream itself is counted and cancelled as soon as the limit is crossed.
 */
export class PayloadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Request body exceeds ${limitBytes} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

export class BodyDeadlineError extends Error {
  constructor(readonly limitMs: number) {
    super(`Request body not received within ${limitMs}ms`);
    this.name = "BodyDeadlineError";
  }
}

/** Default for public JSON/form ingress: far above any legitimate chat or webhook event, far below memory-pressure size. */
export const DEFAULT_PUBLIC_BODY_BYTES = 256 * 1024;
/** Unauthenticated account endpoints carry a few short fields (login, reset, invitation). */
export const AUTH_BODY_BYTES = 32 * 1024;
export const DEFAULT_BODY_DEADLINE_MS = 15_000;

export async function readBoundedBody(
  request: Request,
  maxBytes: number = DEFAULT_PUBLIC_BODY_BYTES,
  deadlineMs: number = DEFAULT_BODY_DEADLINE_MS
): Promise<Buffer> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new PayloadTooLargeError(maxBytes);
  }
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyDeadlineError(deadlineMs)), deadlineMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new PayloadTooLargeError(maxBytes);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks, total);
}

/** Bounded JSON parse; malformed JSON yields undefined (callers already treat that as "not a valid event"). */
// Typed `any` like Request.json(), so call sites keep validating the shape themselves.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readBoundedJson(request: Request, maxBytes?: number, deadlineMs?: number): Promise<any> {
  const raw = await readBoundedBody(request, maxBytes, deadlineMs);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}
