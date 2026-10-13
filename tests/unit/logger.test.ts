import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "@/lib/observability/logger";

/**
 * Many call sites pass a context object as `logger.error`'s second argument
 * (`logger.error("job failed", { businessId, error })`). That used to print the
 * error as "[object Object]" (String() of the object) and any nested Error as
 * "{}" (JSON.stringify), so worker failures were unreadable in the logs.
 */
afterEach(() => vi.restoreAllMocks());

function capture(method: "error" | "warn" | "info", call: () => void): string {
  const spy = vi.spyOn(console, method).mockImplementation(() => {});
  try {
    call();
    return String(spy.mock.calls[0]?.[0] ?? "");
  } finally {
    spy.mockRestore();
  }
}

describe("logger", () => {
  it("still logs an Error passed directly, with its message and stack", () => {
    const out = capture("error", () => logger.error("boom", new Error("disk full")));
    expect(out).toContain("disk full");
    expect(out).toContain("stack");
  });

  it("logs the real error when a context object carries it (no [object Object])", () => {
    const out = capture("error", () => logger.error("job failed", { businessId: "b1", receiptId: "r1", error: new Error("unique constraint failed") } as never));
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("unique constraint failed");
    expect(out).toContain('"businessId":"b1"');
    expect(out).toContain('"receiptId":"r1"');
  });

  it("serialises Errors nested anywhere in a context, including info/warn logs", () => {
    const out = capture("warn", () => logger.warn("retrying", { attempt: 2, cause: { error: new TypeError("bad input") } }));
    expect(out).toContain("bad input");
    expect(out).toContain("TypeError");
    expect(out).toContain('"attempt":2');
  });

  it("keeps the explicit third-argument context", () => {
    const out = capture("error", () => logger.error("failed", new Error("x"), { jobId: "j9" }));
    expect(out).toContain('"jobId":"j9"');
  });

  it("logs a non-object, non-Error value as text", () => {
    expect(capture("error", () => logger.error("failed", "plain reason"))).toContain("plain reason");
    expect(capture("error", () => logger.error("failed", 42))).toContain("42");
  });

  it("never throws on a circular context", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => capture("info", () => logger.info("circular", circular))).not.toThrow();
    expect(capture("info", () => logger.info("circular", circular))).toContain("circular");
  });
});
