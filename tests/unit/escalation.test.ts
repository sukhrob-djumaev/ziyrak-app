import { describe, it, expect } from "vitest";
import { decideEscalation, isExplicitHumanRequest, isSocialTurn } from "@/lib/ai/escalation";

/** PLAN.md R2 — deterministic regressions for escalation rules E1-E5 (docs/r2-ai-decision-quality-proposal-2026-10-22.md). */
const base = { userMessage: "When do you open?", response: "We open at 9am.", retrievedCount: 2, toolOutcomes: [] as { success: boolean; status?: string }[] };

describe("decideEscalation", () => {
  it("does not escalate a short correct grounded answer (the original R2 bug)", () => {
    expect(decideEscalation({ ...base, response: "Yes." })).toEqual({ escalate: false, reasons: [] });
    expect(decideEscalation(base).escalate).toBe(false);
  });

  it("does not escalate a long grounded answer", () => {
    expect(decideEscalation({ ...base, response: "Refunds are available within 30 days of purchase. ".repeat(10) }).escalate).toBe(false);
  });

  it("E1 escalates an explicit human request, including other languages", () => {
    for (const userMessage of [
      "let me talk to a person",
      "I want to speak to a human",
      "Can you connect me with an agent?",
      "get me a real person please",
      "I need a manager",
      "хочу поговорить с оператором",
      "operator bilan gaplashmoqchiman",
    ])
      expect(decideEscalation({ ...base, userMessage }).reasons, userMessage).toContain("human_requested");
  });

  it("E1 does not fire on questions that merely mention people", () => {
    for (const userMessage of ["Are you a human or a bot?", "Do you have a person who handles invoices on Monday?", "Is the manager's special still on?"])
      expect(isExplicitHumanRequest(userMessage), userMessage).toBe(false);
  });

  it("E2 escalates when nothing was retrieved and no tool supports the answer", () => {
    const r = decideEscalation({ ...base, retrievedCount: 0 });
    expect(r).toEqual({ escalate: true, reasons: ["no_support"] });
  });

  it("E2 is satisfied by a successful tool result", () => {
    expect(decideEscalation({ ...base, retrievedCount: 0, toolOutcomes: [{ success: true, status: "completed" }] }).escalate).toBe(false);
  });

  it("E2 exempts greetings, thanks and goodbyes", () => {
    for (const userMessage of ["Hello", "hi there!", "thanks a lot", "Thank you", "good morning", "bye"]) {
      expect(isSocialTurn(userMessage), userMessage).toBe(true);
      expect(decideEscalation({ ...base, userMessage, response: "Hello! How can I help?", retrievedCount: 0 }).escalate, userMessage).toBe(false);
    }
    expect(isSocialTurn("hello, what is your refund policy for opened products and when do I get it")).toBe(false);
    expect(isSocialTurn("this is broken")).toBe(false);
  });

  it("E3 escalates a failed or pending tool even when knowledge was retrieved", () => {
    expect(decideEscalation({ ...base, toolOutcomes: [{ success: false, status: "failed" }] }).reasons).toContain("tool_failed");
    expect(decideEscalation({ ...base, toolOutcomes: [{ success: true, status: "pending_approval" }] }).reasons).toContain("tool_pending");
    expect(decideEscalation({ ...base, toolOutcomes: [{ success: false, status: "pending_approval" }] }).reasons).toContain("tool_pending");
  });

  it("E4 escalates a reply that says it cannot help, but not an ordinary apology or 'unfortunately'", () => {
    for (const response of ["I don't know the answer to that.", "I'm not sure about that, let me connect you with a team member.", "That is beyond my knowledge."])
      expect(decideEscalation({ ...base, response }).reasons, response).toContain("declined");
    for (const response of ["Unfortunately we are closed on Sundays.", "I apologize for the wait; we open at 9am.", "I cannot see your card number, but your order shipped."])
      expect(decideEscalation({ ...base, response }).escalate, response).toBe(false);
  });

  it("an explicit handoff (tool or allowance fallback) always escalates", () => {
    expect(decideEscalation({ ...base, handoff: true }).reasons).toEqual(["handoff"]);
  });

  it("reports every applicable reason once", () => {
    const r = decideEscalation({ ...base, userMessage: "let me talk to a person", response: "I don't know.", retrievedCount: 0, toolOutcomes: [{ success: false }] });
    expect(r.reasons).toEqual(["human_requested", "no_support", "tool_failed", "declined"]);
  });
});
