import { describe, it, expect } from "vitest";
import { toolMessageContent, failureReminder } from "@/lib/ai/engine";

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
    const out = JSON.parse(toolMessageContent({ success: true }, ["send_internal_email"]));
    expect(out.note).toMatch(/earlier action in this turn FAILED and was NOT carried out/);
    expect(out.note).toMatch(/start your reply/);
    expect(out.note).toMatch(/send_internal_email/);
    expect(out.failedActions).toEqual(["send_internal_email"]);
    expect(JSON.parse(toolMessageContent({ success: true }, [])).note).toBeUndefined();
  });
});

describe("failureReminder", () => {
  it("is empty when nothing failed", () => {
    expect(failureReminder([])).toBeNull();
  });
  it("names each failed action and tells the model how to open its reply", () => {
    const text = failureReminder(["send_internal_email"]) ?? "";
    expect(text).toMatch(/send_internal_email/);
    expect(text).toMatch(/did not go through/);
    expect(text).toMatch(/Begin your reply/);
  });
});
