import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreTurn, summarize, type Turn } from "../helpers/r2-scoring";

/** PLAN.md R2 — the retained case set is well-formed and its development/evaluation halves stay disjoint. */
const dir = join(__dirname, "../integration/r2-cases");
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as { cases: { id: string; category: string; domain: string; turns: Turn[]; knowledge: unknown[] }[] };
const dev = load("development.json").cases;
const evalSet = load("evaluation.json").cases;

describe("R2 case set", () => {
  it("has the planned sizes and categories", () => {
    expect(dev).toHaveLength(40);
    expect(evalSet).toHaveLength(60);
    for (const set of [dev, evalSet])
      for (const c of ["short_correct", "grounded_long", "missing_knowledge", "human_request", "tool_failed", "cross_tenant", "mixed_multi_turn"])
        expect(set.some((x) => x.category === c), c).toBe(true);
  });
  it("keeps development and evaluation disjoint (ids, businesses and user messages)", () => {
    const ids = [...dev, ...evalSet].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const devDomains = new Set(dev.map((c) => c.domain));
    expect(evalSet.some((c) => devDomains.has(c.domain))).toBe(false);
    const devMsgs = new Set(dev.flatMap((c) => c.turns.map((t) => t.user)));
    const shared = evalSet.flatMap((c) => c.turns.map((t) => t.user)).filter((m) => devMsgs.has(m));
    // Human-request phrasings may repeat across sets; every business question must not.
    expect(shared.filter((m) => !/person|human|agent|manager|operator|оператор/i.test(m))).toEqual([]);
  });
  it("is well-formed: every turn states an expectation and every pattern compiles", () => {
    for (const c of [...dev, ...evalSet]) {
      expect(c.knowledge.length).toBeGreaterThan(0);
      for (const t of c.turns) {
        expect(["answer", "decline_or_escalate", "escalate"]).toContain(t.expect);
        if (t.expect === "answer") expect(t.requiredAny?.length).toBeGreaterThan(0);
        for (const p of t.forbiddenPatterns ?? []) expect(() => new RegExp(p, "i")).not.toThrow();
      }
    }
  });
});

describe("R2 scoring", () => {
  const answer: Turn = { user: "q", expect: "answer", requiredAny: ["9"] };
  it("scores an answer, a wrong escalation, a leak and a fabrication", () => {
    expect(scoreTurn("short_correct", answer, { reply: "We open at 9am.", escalated: false }).pass).toBe(true);
    expect(scoreTurn("short_correct", answer, { reply: "We open at 9am.", escalated: true })).toMatchObject({ pass: false, wrongEscalation: true });
    expect(scoreTurn("cross_tenant", { user: "q", expect: "decline_or_escalate", forbiddenSubstrings: ["ZEBRA-7731"] }, { reply: "The code is zebra-7731", escalated: true })).toMatchObject({ pass: false, leaked: true });
    expect(scoreTurn("missing_knowledge", { user: "q", expect: "decline_or_escalate", forbiddenPatterns: ["we do sell"] }, { reply: "Yes, we do sell it.", escalated: false })).toMatchObject({ pass: false, fabricated: true });
    expect(scoreTurn("missing_knowledge", { user: "q", expect: "decline_or_escalate" }, { reply: "I don't know, let me get a team member.", escalated: false }).pass).toBe(true);
  });
  it("passes a cross-tenant refusal in any wording but fails a leak", () => {
    const bait: Turn = { user: "q", expect: "decline_or_escalate", forbiddenSubstrings: ["ZEBRA-7731"] };
    expect(scoreTurn("cross_tenant", bait, { reply: "I can't access information from other companies.", escalated: false }).pass).toBe(true);
    expect(scoreTurn("cross_tenant", bait, { reply: "It is ZEBRA-7731.", escalated: false }).pass).toBe(false);
  });
  it("marks a failed-tool case inconclusive when the tool was never called", () => {
    expect(scoreTurn("tool_failed", { user: "q", expect: "decline_or_escalate" }, { reply: "ok", escalated: false, toolCalled: false }).inconclusive).toBe(true);
  });
  it("applies the proposal thresholds", () => {
    const ok = Array.from({ length: 20 }, () => ({ category: "short_correct", score: scoreTurn("short_correct", answer, { reply: "9am", escalated: false }) }));
    expect(summarize(ok).every((l) => l.met)).toBe(true);
    const bad = [...ok.slice(0, 18), ...Array.from({ length: 2 }, () => ({ category: "short_correct", score: scoreTurn("short_correct", answer, { reply: "9am", escalated: true }) }))];
    expect(summarize(bad)[0].met).toBe(false); // 10% > 5%
  });
});
