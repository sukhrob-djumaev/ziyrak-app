/**
 * Server-side red-flag hint (R6 known gap). The prompt alone cannot make gpt-4o-mini lead a severe-injury reply
 * with "get medical help now" without also calling the ticket urgent, so a turn whose latest customer message
 * reports a serious injury gets one extra system line. The phrase lists are mirrored in
 * tests/helpers/r2-rules.config.json; tests/unit/red-flag.test.ts keeps both copies identical.
 */

export const INJURY_PATTERNS: readonly string[] = [
  "hurt",
  "injur\\w*",
  "\\bfell\\b",
  "tripp\\w*",
  "scrap\\w*",
  "bruis\\w*",
  "\\bsting\\w*",
  "\\bstung\\b",
  "prick\\w*",
  "bleed\\w*",
  "swoll\\w*",
  "swell\\w*",
  "sprain\\w*",
  "\\bsore\\b",
  "\\bcut (?:my|myself)\\b",
  "\\bburn(?:s|ed|t)\\b",
  "\\bhit (?:his|her|their|my|the) head\\b",
  "\\bhives\\b",
  "\\bslipped\\b",
  "\\bcut (?:his|her|their)\\b",
  "\\bpain(?:s|ful)?\\b",
];

export const INJURY_REPORT_PATTERNS: readonly string[] = [
  "\\b(?:i|we|he|she|they|my \\w+|our \\w+)\\s+(?:just |both |also |have |'ve |had )*(?:hurt|fell|tripped|slipped|cut|burn\\w*|scraped|sprained|twisted|banged|bumped|bled|got)\\b",
  "\\b(?:hurt|scraped|cut|burned|sprained|twisted) my\\b",
  "\\bmy [\\w ]{1,25}? (?:is|are|was) [\\w ]{0,15}?(?:hurt|sore|swollen|bleeding|painful|bruised)",
];

export const INJURY_POLICY_PATTERNS: readonly string[] = [
  "\\bwhat if\\b",
  "\\bshould i (?:tell|mention|say)\\b",
  "\\bdo i (?:have|need) to (?:tell|say|mention)\\b",
  "\\bneed to tell\\b",
  "\\bskip telling\\b",
  "\\bif (?:i|someone|a child) (?:get|gets|got) (?:hurt|injured)\\b",
  "\\bin case of\\b",
  "\\b(?:old|previous|past|healed|former)\\s+(?:\\w+\\s+){0,2}injur",
];

export const RED_FLAG_PATTERNS: readonly string[] = [
  "\\b(?:lips?|tongue|throat|face)\\b[^.]{0,30}\\bswell\\w*",
  "\\bswell\\w*[^.]{0,30}\\b(?:lips?|tongue|throat)\\b",
  "\\b(?:can['\u2019]?t|cannot|difficulty|trouble|hard to) breath\\w*",
  "\\bhit (?:his|her|their|my|the) head\\b",
  "\\bhead injur\\w*",
  "\\beyes?\\b",
  "\\bheavy bleeding\\b",
  "\\bbleeding (?:a lot|heavily|badly)\\b",
  "\\bwon['\u2019]?t stop bleeding\\b",
  "\\bchemical burn\\w*",
  "\\b(?:chemical|bleach|acid)\\b[^.]{0,30}\\bburn\\w*",
  "\\bburn\\w*[^.]{0,30}\\b(?:chemical|bleach|acid)\\b",
];

const re = (xs: readonly string[]) => new RegExp(`(?:${xs.join("|")})`, "i");
const injury = re(INJURY_PATTERNS);
const injuryReport = re(INJURY_REPORT_PATTERNS);
const injuryPolicy = re(INJURY_POLICY_PATTERNS);
const redFlag = re(RED_FLAG_PATTERNS);

/** The customer reports their own serious injury or symptom now; a policy question or hypothetical is not one. */
export function isRedFlagInjuryReport(message: string): boolean {
  const text = message.replace(/[‘’]/g, "'");
  return injury.test(text) && (injuryReport.test(text) || !injuryPolicy.test(text)) && redFlag.test(text);
}

/** The line the model reads last: lead with medical help now, and keep urgency wording off the ticket. */
export function redFlagReminder(message: string): string | null {
  if (!isRedFlagInjuryReport(message)) return null;
  return 'The customer\'s latest message reports a possibly serious injury or symptom. After any tool call the customer asked for, begin your reply with one sentence telling them to get medical help now and giving the emergency number from the knowledge base in digits when it has one, for example "Please get medical help now. If it is an emergency, call 112." Say nothing more about urgency: do not call the ticket or the hand-off urgent, immediate or a priority; say only that you have passed it to the team if a tool call this turn did so.';
}
