import { describe, expect, it } from "vitest";
import config from "../helpers/r2-rules.config.json";
import { INJURY_PATTERNS, INJURY_POLICY_PATTERNS, INJURY_REPORT_PATTERNS, RED_FLAG_PATTERNS, isRedFlagInjuryReport, redFlagReminder } from "@/lib/ai/red-flag";

describe("red-flag injury hint", () => {
  it("mirrors the eval rule config exactly", () => {
    expect([...INJURY_PATTERNS]).toEqual(config.injury);
    expect([...INJURY_REPORT_PATTERNS]).toEqual(config.injuryReport);
    expect([...INJURY_POLICY_PATTERNS]).toEqual(config.injuryPolicyQuestion);
    expect([...RED_FLAG_PATTERNS]).toEqual(config.redFlag);
  });

  it.each([
    "My son hit his head on your climbing wall and is dizzy",
    "The bleach burned my eye during the treatment",
    "Her lips are swelling after the facial and she can't breathe properly",
    "My hand is bleeding heavily after the cut",
  ])("flags a serious injury report: %s", (m) => {
    expect(isRedFlagInjuryReport(m)).toBe(true);
    expect(redFlagReminder(m)).toMatch(/medical help now/);
  });

  it.each([
    "What are your opening hours?",
    "The haircut ruined my day, I want a refund",
    "What if someone hits their head, do I need to tell staff?",
    "I got a small scrape on my knee last week",
  ])("stays quiet for: %s", (m) => {
    expect(redFlagReminder(m)).toBeNull();
  });

  it("keeps urgency wording off the ticket", () => {
    expect(redFlagReminder("My son hit his head on your wall")).toMatch(/do not call the ticket or the hand-off urgent/);
  });
});
