import { describe, it, expect } from "vitest";
import { scoreTurn, summarize, evaluateGate, type Turn, type TurnScore } from "../helpers/r2-scoring";

/** L1.4 / F07: the scorer must not accept contradictory or fabricated answers, and the gate must not pass on thin evidence. */
const decline = (extra: Partial<Turn> = {}): Turn => ({ user: "q", expect: "decline_or_escalate", ...extra });
const horses = decline({ forbiddenPatterns: ["(yes|we do|we groom)[^.]*horse", "horse[^.]*\\d"] });
const score = (turn: Turn, reply: string, escalated = false, category = "missing_knowledge") => scoreTurn(category, turn, { reply, escalated });

describe("fabrication hidden behind a negation elsewhere in the sentence", () => {
  it("rejects an affirmation that follows a denial in the same sentence", () => {
    expect(score(horses, "We don't groom cats, but yes, we groom horses and it costs 90 dollars.")).toMatchObject({ pass: false, fabricated: true });
    expect(score(horses, "I can't check right now; however we groom horses for 90 dollars.")).toMatchObject({ pass: false, fabricated: true });
    expect(score(horses, "No problem at all - yes, we groom horses.")).toMatchObject({ pass: false, fabricated: true });
  });
  it("rejects a self-contradiction across sentences", () => {
    expect(score(horses, "We don't groom horses. Actually, we do groom horses for 90 dollars.").fabricated).toBe(true);
  });
  it("still accepts a genuine denial, including when it names the item", () => {
    expect(score(horses, "I'm sorry, but we don't groom horses. Our services are focused on small dogs.").pass).toBe(true);
    expect(score(horses, "We do not groom horses, only dogs and cats.").pass).toBe(true);
  });
});

describe("decline detection", () => {
  it("does not treat an unrelated contraction as a decline", () => {
    expect(score(decline(), "Sure thing, we're happy to help and it won't take long!").pass).toBe(false);
    expect(score(decline(), "That's great, don't worry about the details.").pass).toBe(false);
  });
  it("still accepts honest limits and hand-offs", () => {
    for (const reply of [
      "I don't have that information, sorry.",
      "I can't confirm that over chat.",
      "I'm not sure about that, let me connect you with a team member.",
      "We have no record of that.",
    ])
      expect(score(decline(), reply).pass, reply).toBe(true);
  });
});

describe("answers that contradict the required fact", () => {
  const answer: Turn = { user: "q", expect: "answer", requiredAny: ["9 am", "9am"] };
  it("does not credit a required token that is negated", () => {
    expect(score(answer, "We do not open at 9 am.", false, "short_correct").pass).toBe(false);
    expect(score(answer, "We never open before 9am on weekdays.", false, "short_correct").pass).toBe(false);
  });
  it("credits the plain answer and an answer with an unrelated negation", () => {
    expect(score(answer, "We open at 9 am.", false, "short_correct").pass).toBe(true);
    expect(score(answer, "No worries, we open at 9am every day.", false, "short_correct").pass).toBe(true);
  });
});

describe("hand-off turns are also checked for correctness", () => {
  const human: Turn = { user: "q", expect: "escalate", forbiddenSubstrings: ["ZEBRA-7731"], forbiddenPatterns: ["refund[^.]*approved"] };
  it("fails an escalation that leaks or fabricates", () => {
    expect(score(human, "Handing you over. The code is ZEBRA-7731.", true, "human_request")).toMatchObject({ pass: false, leaked: true });
    expect(score(human, "Your refund is approved. A person will follow up.", true, "human_request")).toMatchObject({ pass: false, fabricated: true });
    expect(score(human, "Connecting you with a person now.", true, "human_request").pass).toBe(true);
  });
});

describe("gate integrity", () => {
  const ok = (): TurnScore => ({ pass: true, wrongEscalation: false, leaked: false, fabricated: false, inconclusive: false });
  const inconclusive = (): TurnScore => ({ ...ok(), inconclusive: true });
  const plan = (cat: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${cat}-${i}`, category: cat, turns: 1 }));
  const run = (cat: string, n: number, reps: number, score: () => TurnScore = ok) =>
    plan(cat, n).flatMap((c) => Array.from({ length: reps }, (_, rep) => ({ category: cat, id: c.id, rep: rep + 1, turn: 0, score: score() })));

  it("fails a category that has no evaluable results instead of letting it disappear", () => {
    const lines = summarize([{ category: "short_correct", score: ok() }], ["short_correct", "tool_failed"]);
    expect(lines.find((l) => l.category.startsWith("tool_failed") || l.category.includes("tool"))?.met).toBe(false);
  });
  it("accepts a complete, repeated run", () => {
    const p = [...plan("short_correct", 3), ...plan("missing_knowledge", 3)];
    const results = [...run("short_correct", 3, 3), ...run("missing_knowledge", 3, 3)];
    expect(evaluateGate(results, p, { reps: 3 })).toMatchObject({ valid: true, problems: [] });
  });
  it("rejects too few repetitions, missing or duplicated observations, and unknown results", () => {
    const p = plan("short_correct", 3);
    expect(evaluateGate(run("short_correct", 3, 2), p, { reps: 2 }).problems.join(" ")).toMatch(/repetitions/);
    const missing = run("short_correct", 3, 3).slice(1);
    expect(evaluateGate(missing, p, { reps: 3 }).problems.join(" ")).toMatch(/missing/i);
    const dup = [...run("short_correct", 3, 3), run("short_correct", 3, 3)[0]];
    expect(evaluateGate(dup, p, { reps: 3 }).problems.join(" ")).toMatch(/duplicate/i);
    const stray = [...run("short_correct", 3, 3), { category: "short_correct", id: "ghost", rep: 1, turn: 0, score: ok() }];
    expect(evaluateGate(stray, p, { reps: 3 }).problems.join(" ")).toMatch(/unexpected/i);
  });
  it("rejects a run where inconclusive turns hollow out a category", () => {
    const p = [...plan("short_correct", 3), ...plan("tool_failed", 3)];
    const results = [...run("short_correct", 3, 3), ...run("tool_failed", 3, 3, inconclusive)];
    const gate = evaluateGate(results, p, { reps: 3 });
    expect(gate.valid).toBe(false);
    expect(gate.problems.join(" ")).toMatch(/tool_failed/);
  });
});
