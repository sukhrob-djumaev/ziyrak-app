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
  it("reminds the model of an earlier failed action when a later one succeeds", () => {
    const out = JSON.parse(toolMessageContent({ success: true }, true));
    expect(out.note).toMatch(/earlier action in this turn FAILED and was NOT carried out/);
    expect(out.note).toMatch(/start your reply/);
    expect(JSON.parse(toolMessageContent({ success: true }, false)).note).toBeUndefined();
  });
});
