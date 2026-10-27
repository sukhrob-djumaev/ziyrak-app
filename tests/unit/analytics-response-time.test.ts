import { describe, it, expect } from "vitest";
import { averageFirstResponse } from "@/lib/analytics/response-time";

const t = (min: number) => new Date(Date.UTC(2026, 9, 27, 10, min));
const m = (conversationId: string, role: string, min: number) => ({ conversationId, role, createdAt: t(min) });

describe("averageFirstResponse", () => {
  it("measures from a stored `customer` message to the first AI reply", () => {
    expect(averageFirstResponse([m("a", "customer", 0), m("a", "assistant", 2), m("a", "assistant", 9)])).toEqual({ minutes: 2, sampleSize: 1 });
  });
  it("counts a human `agent` reply and the legacy `user` spelling", () => {
    expect(averageFirstResponse([m("a", "user", 0), m("a", "agent", 4)])).toEqual({ minutes: 4, sampleSize: 1 });
  });
  it("averages across conversations and ignores unanswered ones and replies before any customer message", () => {
    const r = averageFirstResponse([m("a", "assistant", 0), m("a", "customer", 1), m("b", "customer", 1), m("a", "assistant", 3), m("b", "assistant", 7), m("c", "customer", 8)]);
    expect(r).toEqual({ minutes: 4, sampleSize: 2 });
  });
  it("ignores system and tool messages and reports no samples when nothing was answered", () => {
    expect(averageFirstResponse([m("a", "customer", 0), m("a", "system", 1), m("a", "tool", 2)])).toEqual({ minutes: 0, sampleSize: 0 });
    expect(averageFirstResponse([])).toEqual({ minutes: 0, sampleSize: 0 });
  });
});
