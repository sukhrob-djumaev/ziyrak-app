import config from "./r2-rules.config.json";

/**
 * Deterministic rules that run beside scoreTurn (tests/helpers/r2-scoring.ts). Each encodes a defect that
 * owner review found and the pattern scorer passed (docs/r2-human-review-rubric.md). A turn fails if the scorer
 * fails it or any applicable rule fires. Phrase lists live in r2-rules.config.json.
 */
export interface RuleInput {
  category: string;
  /** All knowledge-base text of the business, joined. */
  kb: string;
  user: string;
  reply: string;
  handedOff: boolean;
  /** Tokens the case marks as the safety rule (turn.safetyAny); present only on safety turns. */
  safetyAny?: string[];
  /** Priority wording returned by the ticket tool, when a tool log is available. */
  ticketPriority?: string;
}
export interface RuleFailure { id: string; reason: string }

const re = (xs: string[], flags = "i") => new RegExp(`(?:${xs.join("|")})`, flags);
const norm = (s: string) => s.replace(/[‘’]/g, "'");
const R = {
  completed: re(config.completedHandoff), offer: re(config.offerHandoff), failure: re(config.failureDisclosed),
  confirm: re(config.blockingConfirm), priority: re(config.unverifiedPriority), internals: re(config.ticketInternals, "i"),
  placeholder: re(config.placeholders.caseSensitive, ""), soft: re(config.softSafety), invention: re(config.invention),
  unknown: re(config.admitsUnknown), referral: re(config.outsideReferral), injury: re(config.injury), allergy: re(config.allergy),
};
const STOP = new Set(config.stopWords);
const sentencesOf = (s: string) => s.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? [];
const digits = (s: string) => s.replace(/\D/g, "");
const emergencyNumber = (kb: string) => /\b(?:call|dial)\s+(\d{3})\b/i.exec(kb)?.[1];
const phoneIn = (s: string) => /\+?\d[\d\s().-]{5,}\d/.exec(s)?.[0];
const isInjury = (user: string) => R.injury.test(user);
const singular = (w: string) => w.replace(/(?:es|s)$/, "");

/** KB bundles of the form "A X with a Y together are N dollars" plus the single prices "A X is P dollars". */
export function bundles(kb: string) {
  const prices = new Map<string, number>();
  for (const m of kb.matchAll(/\ba(?:n)?\s+([a-z' -]+?)\s+(?:is|costs?)\s+(\d+(?:\.\d+)?)\s+dollars?/gi)) prices.set(m[1].toLowerCase().trim(), Number(m[2]));
  const out: { items: string[]; price: number; sum: number | null }[] = [];
  for (const m of kb.matchAll(/\ba(?:n)?\s+([a-z' -]+?)\s+with\s+a(?:n)?\s+([a-z' -]+?)\s+together\s+(?:are|is|cost)\s+(\d+(?:\.\d+)?)\s+dollars?/gi)) {
    const items = [m[1].toLowerCase().trim(), m[2].toLowerCase().trim()];
    const ps = items.map((i) => prices.get(i));
    out.push({ items, price: Number(m[3]), sum: ps.every((p) => p !== undefined) ? ps.reduce((a, b) => a! + b!, 0)! : null });
  }
  return out;
}
const mentions = (text: string, item: string) => { const t = new Set(words(text).map(singular)); return words(item).map(singular).every((w) => t.has(w)); };
const hasNumber = (reply: string, n: number) => new RegExp(`(?<![\\d.])${n}(?![\\d]|\\.\\d)`).test(reply);

export function checkRules(i: RuleInput): RuleFailure[] {
  const reply = norm(i.reply);
  const f: RuleFailure[] = [];
  const fail = (id: string, reason: string) => f.push({ id, reason });
  const completed = R.completed.test(reply);
  const offered = R.offer.test(reply);
  const toolFailed = i.category === "tool_failed";
  const injury = isInjury(i.user);
  const sentences = sentencesOf(reply);

  // R1 flag-consistency
  if (completed && !i.handedOff) fail("R1", "reply says it was passed on but the conversation was not handed off");
  else if (!completed && offered && i.handedOff) fail("R1", "reply only offers a hand-off but the conversation was handed off");
  else if (i.handedOff && !completed) fail("R1", "handed off but the reply has no completed hand-off phrase");

  if (toolFailed) {
    if (!R.failure.test(reply)) fail("R2", "the reply never says the action failed");
    if (R.confirm.test(reply)) fail("R3", "asks the customer to confirm details already given");
    if (!i.handedOff) fail("R3", "tool failed and nothing was handed off");
    const phone = phoneIn(i.user);
    if (phone && !digits(reply).includes(digits(phone))) fail("R4", `phone ${phone} not read back`);
    if (injury && !/medical/i.test(reply)) fail("R6", "injury reported but no medical pointer");
  }

  // R5 emergency number only with the word emergency; always on an injury
  const num = emergencyNumber(i.kb);
  if (num) {
    for (const s of sentences) if (new RegExp(`\\b${num}\\b`).test(s) && !/emergenc/i.test(s)) fail("R5", `${num} appears in a sentence without "emergency"`);
    if (injury && !new RegExp(`\\b${num}\\b`).test(reply)) fail("R5", `injury reported but ${num} is missing`);
  }

  // R7 priority wording the ticket did not return
  if ((toolFailed || i.category === "human_request") && R.priority.test(reply)) {
    const ok = i.ticketPriority && R.priority.exec(reply) && i.ticketPriority.toLowerCase().includes(R.priority.exec(reply)![0].toLowerCase());
    if (!ok) fail("R7", `priority/urgency wording "${R.priority.exec(reply)![0]}" without a ticket result that returned it`);
  }

  // R8 ticket internals, R9 placeholders
  if (R.internals.test(reply)) fail("R8", `ticket internals in the reply: "${R.internals.exec(reply)![0]}"`);
  if (R.placeholder.test(reply)) fail("R9", `placeholder text "${R.placeholder.exec(reply)![0]}"`);
  for (const m of i.user.matchAll(/\b(?:i['’]m|i am|my name is|this is)\s+([A-Z][a-z]+)/g)) {
    if (new RegExp(`\\b(?:${config.placeholders.greetings.join("|")})[,!]?\\s+${m[1]}\\b`, "i").test(reply)) fail("R9", `greets the customer by name "${m[1]}"`);
  }

  // R10 firm safety: a safety rule or allergen turn must answer a plain No with no hedging
  const safetyTurn = (i.safetyAny?.length ?? 0) > 0;
  const allergenTurn = R.allergy.test(i.user) && /\bcontains?\b/i.test(i.kb);
  if (safetyTurn || allergenTurn) {
    const guarantee = /\b(?:cannot|can't|can not|does not|doesn't) guarantee\b/i.test(i.kb) && /free\b/i.test(i.user);
    if (guarantee) {
      if (!/(?:cannot|can't|can not|not able to|unable to|do not|don't) guarantee/i.test(reply)) fail("R10", "the allergen caveat from the knowledge base is missing");
    } else if (!/^\s*(?:no\b|unfortunately,? no\b)/i.test(reply)) fail("R10", "safety answer does not start with a plain No");
    const soft = R.soft.exec(reply);
    if (soft) fail("R10", `hedged safety answer ("${soft[0]}")`);
  }

  // R11 invented no / must admit it does not know
  if (i.category === "missing_knowledge") {
    const inv = R.invention.exec(reply);
    if (inv && !i.kb.toLowerCase().includes(inv[0].toLowerCase())) fail("R11", `states "${inv[0]}" but the knowledge base does not`);
    if (!R.unknown.test(reply)) fail("R11", "no admission that the information is not available");
  }

  // R12 outside referral
  if ((i.category === "missing_knowledge" || i.category === "short_correct") && R.referral.test(reply)) fail("R12", `sends the customer elsewhere ("${R.referral.exec(reply)![0]}")`);

  // R13 a "What is X?" answer needs more than the price
  const q = /^\s*what (?:is|are) (?:a |an |the )?(.+?)\s*\?\s*$/i.exec(i.user);
  if (i.category === "short_correct" && q) {
    const term = new Set(words(q[1]).map(singular));
    const rest = words(reply).filter((w) => !STOP.has(w) && !term.has(singular(w)));
    if (rest.length < 2) fail("R13", "the reply is only the price");
  }

  // R14 bundle price
  if (i.category === "grounded_long" || i.category === "short_correct") {
    for (const b of bundles(i.kb)) {
      if (!b.items.every((it) => mentions(i.user, it))) continue;
      if (!hasNumber(reply, b.price)) fail("R14", `asked for a bundle but the reply does not give the bundle price ${b.price}`);
      else if (b.sum !== null && b.sum !== b.price && hasNumber(reply, b.sum)) fail("R14", `states the sum ${b.sum} of the separate prices`);
    }
  }
  return f;
}
