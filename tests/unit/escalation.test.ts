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

  it("E1 escalates 'can I speak with / is there someone I can talk to' requests", () => {
    for (const userMessage of [
      "Can I speak with a teacher about my son?",
      "Is there someone I can talk to about this?",
      "Is there a manager I can talk to?",
      "Can I speak to the owner?",
    ])
      expect(decideEscalation({ ...base, userMessage }).reasons, userMessage).toContain("human_requested");
    expect(isExplicitHumanRequest("Are you a human?")).toBe(false);
    expect(isExplicitHumanRequest("Do you have a manager on duty on Sundays?")).toBe(false);
  });

  it("makes a claimed hand-off real: a reply that says it passed the question on escalates", () => {
    for (const response of [
      "I don't have that information. I've passed your question to our team and they will contact you.",
      "I'll pass this to our team, who will get back to you.",
      "Your request has been forwarded to a team member.",
      "I have notified our staff about this.",
      "I don't have information about massage therapy. However, I can pass your question to our team, and they'll get back to you with the details.",
      "I can forward this to the owner and they will get back to you.",
      "Our support team will reach out to you at 555-0444.",
      "A team member will contact you about the lock.",
      "I don't have any information about antique frames.",
      "I don't have specific information about washing trucks or vans.",
      "I do not have further details on catering.",
    ])
      expect(decideEscalation({ ...base, response }).escalate, response).toBe(true);
    expect(decideEscalation({ ...base, response: "We pass the ball well, and our team is friendly." }).escalate).toBe(false);
    expect(decideEscalation({ ...base, response: "Our team will be at the shop from 9am, and you can contact us there." }).escalate).toBe(false);
  });

  it("E1 escalates a request that a person call or contact the customer back", () => {
    for (const userMessage of ["Can a manager call me back?", "Could someone phone me tomorrow?", "Please have a team member ring me", "Can a person contact me about this?"])
      expect(decideEscalation({ ...base, userMessage }).reasons, userMessage).toContain("human_requested");
  });

  it("E1 does not fire on questions that merely mention people", () => {
    for (const userMessage of ["Are you a human or a bot?", "Do you have a person who handles invoices on Monday?", "Is the manager's special still on?", "Do you call customers back after a missed delivery?"])
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
