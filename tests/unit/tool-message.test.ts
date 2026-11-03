import { describe, it, expect } from "vitest";
import { toolMessageContent } from "@/lib/ai/engine";

describe("toolMessageContent", () => {
  it("tells the model a failed action did not happen", () => {
    const out = JSON.parse(toolMessageContent({ success: false, status: "failed" }));
    expect(out.note).toMatch(/FAILED and was NOT carried out/);
  });
  it("leaves successful and pending-approval results untouched", () => {
    expect(JSON.parse(toolMessageContent({ success: true }))).toEqual({ success: true });
    expect(JSON.parse(toolMessageContent({ success: false, status: "pending_approval" })).note).toBeUndefined();
  });
});
