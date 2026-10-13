import { describe, it, expect } from "vitest";
import { toolLabel, requesterLabel, summarizeInput, statusPresentation, timeAgo } from "@/lib/approvals/present";

describe("toolLabel", () => {
  it("humanizes snake_case and kebab-case tool names", () => {
    expect(toolLabel("create_ticket")).toBe("Create ticket");
    expect(toolLabel("send-internal-email")).toBe("Send internal email");
    expect(toolLabel("trigger_webhook")).toBe("Trigger webhook");
  });
  it("passes an unfamiliar name through readably and never throws on empty", () => {
    expect(toolLabel("X")).toBe("X");
    expect(toolLabel("")).toBe("Unknown action");
  });
});

describe("requesterLabel", () => {
  it("names the AI and the system, and does not expose a raw user id", () => {
    expect(requesterLabel("ai")).toBe("AI assistant");
    expect(requesterLabel("system")).toBe("System");
    expect(requesterLabel("0b1f6c2e-1111-4222-8333-444455556666")).toBe("A teammate");
  });
});

describe("summarizeInput", () => {
  it("lists top-level fields as readable strings", () => {
    expect(summarizeInput({ subject: "Refund", priority: "high", count: 3, urgent: true })).toEqual([
      { key: "subject", value: "Refund" },
      { key: "priority", value: "high" },
      { key: "count", value: "3" },
      { key: "urgent", value: "true" },
    ]);
  });
  it("truncates long values and stringifies nested ones", () => {
    const [long, nested] = summarizeInput({ body: "x".repeat(500), meta: { a: 1 } }, 40);
    expect(long.value.length).toBeLessThanOrEqual(41);
    expect(long.value.endsWith("…")).toBe(true);
    expect(nested.value).toBe('{"a":1}');
  });
  it("redacts values of credential-looking fields so an approval screen never shows a secret", () => {
    const out = summarizeInput({ url: "https://x.test", apiKey: "sk-live-abc", password: "hunter2", authToken: "t", secret_note: "s" });
    expect(out.find((e) => e.key === "url")?.value).toBe("https://x.test");
    for (const key of ["apiKey", "password", "authToken", "secret_note"]) expect(out.find((e) => e.key === key)?.value).toBe("••••••");
  });
  it("handles non-object input", () => {
    expect(summarizeInput(null)).toEqual([]);
    expect(summarizeInput("just text")).toEqual([{ key: "input", value: "just text" }]);
    expect(summarizeInput([1, 2])).toEqual([{ key: "input", value: "[1,2]" }]);
  });
});

describe("statusPresentation", () => {
  it("maps every execution status to a label and badge variant", () => {
    expect(statusPresentation("pending_approval")).toEqual({ label: "Waiting for approval", variant: "warning" });
    expect(statusPresentation("succeeded")).toEqual({ label: "Done", variant: "success" });
    expect(statusPresentation("failed")).toEqual({ label: "Failed", variant: "danger" });
    expect(statusPresentation("cancelled")).toEqual({ label: "Rejected", variant: "default" });
    expect(statusPresentation("running").variant).toBe("info");
    expect(statusPresentation("weird").label).toBe("weird");
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  it("renders compact relative times", () => {
    expect(timeAgo("2026-10-14T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-10-14T11:55:00Z", now)).toBe("5 min ago");
    expect(timeAgo("2026-10-14T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-10-12T12:00:00Z", now)).toBe("2 d ago");
  });
  it("tolerates a future or invalid timestamp", () => {
    expect(timeAgo("2026-10-14T12:05:00Z", now)).toBe("just now");
    expect(timeAgo("not a date", now)).toBe("");
  });
});
