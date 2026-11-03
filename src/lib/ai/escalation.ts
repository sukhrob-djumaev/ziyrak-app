/**
 * PLAN.md R2 — when the assistant hands a conversation to a person. Pure and deterministic; the
 * rules are E1-E5 of docs/r2-ai-decision-quality-proposal-2026-10-22.md (E5, safety blocks, stays in
 * the engine's existing guardrail path). Reply length and knowledge-base size no longer matter.
 */
export type EscalationReason = "human_requested" | "no_support" | "tool_failed" | "tool_pending" | "declined" | "handoff";

export interface ToolOutcome {
  success: boolean;
  status?: string;
}

export interface EscalationInput {
  userMessage: string;
  response: string;
  /** Knowledge entries retrieved for this turn (already above the retriever's relevance floor). */
  retrievedCount: number;
  toolOutcomes: ToolOutcome[];
  /** The handoff tool or an allowance fallback already asked for a person. */
  handoff?: boolean;
}

const HUMAN_PEOPLE = "(human|person|people|agent|representative|someone|somebody|manager|supervisor|staff|team member|operator|owner|teacher|instructor|receptionist|doctor|dentist)";
const HUMAN_REQUESTS: RegExp[] = [
  new RegExp(`\\b(talk|speak|chat|connect|transfer|put me|get me|escalate|pass me)\\b[^.?!]*\\b(to|with|through)?\\s*(a|an|the)?\\s*${HUMAN_PEOPLE}\\b`, "i"),
  new RegExp(`\\bi\\s+(need|want|would like|d like)\\b[^.?!]*\\b${HUMAN_PEOPLE}\\b`, "i"),
  new RegExp(`\\b${HUMAN_PEOPLE}\\b[^.?!]*\\b(i|we)\\s+can\\s+(talk|speak|chat)\\b`, "i"),
  /\b(real|live)\s+(person|human|agent)\b/i,
  /\b(customer service|support) (agent|representative|team)\b/i,
  /(оператор|менеджер|живой человек|живым человеком|человек[ао]м)/i,
  /\b(operator|odam|inson|menejer|xodim)\s+(bilan|kerak)/i,
  /\boperator bilan\b/i,
];
// "Can a manager call me back?" asks for a person to reach the customer, so it is a request even though it opens like a question.
const CALLBACK_REQUEST = new RegExp(`\\b${HUMAN_PEOPLE}\\b[^.?!]*\\b(call|phone|ring|contact|reach|email|message|text)\\s+(me|us)\\b`, "i");
// Questions that only mention people ("are you a human?") are not requests for one.
const HUMAN_QUESTION = /^\s*(are|is|do|does|can)\b/i;

export function isExplicitHumanRequest(message: string): boolean {
  if (CALLBACK_REQUEST.test(message)) return true;
  if (HUMAN_QUESTION.test(message) && !/\b(talk|speak|connect|transfer|get me|put me)\b/i.test(message)) return false;
  return HUMAN_REQUESTS.some((re) => re.test(message));
}

const SOCIAL = /\b(hi|hello|hey|thanks|thank you|thx|bye|goodbye|good (morning|afternoon|evening|night)|salom|привет|здравствуйте|спасибо)\b/i;
/** A short greeting, thanks or goodbye needs no knowledge to answer. */
export function isSocialTurn(message: string): boolean {
  const words = message.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 5 && SOCIAL.test(message) && !/\b(broken|not working|problem|issue|refund|cancel)\b/i.test(message);
}

// Reply-level statements that the assistant cannot answer. Deliberately excludes "unfortunately",
// "i apologize" and bare "i cannot", which appear in correct replies.
const DECLINED = [
  "i don't know",
  "i do not know",
  "i'm not sure",
  "i am not sure",
  "i'm unable to help",
  "i am unable to help",
  "i can't help with",
  "i cannot help with",
  "beyond my knowledge",
  "connect you with",
  "no information about",
  "don't have information",
  "don't have any information",
  "do not have information",
  "do not have any information",
];

// "I don't have (any / specific / further) information|details" in any of its natural spellings.
const NO_INFO = /\b(?:don['\u2019]t|do not)\s+have\s+(?:(?:any|specific|further|more|detailed)\s+)*(?:information|info|details)\b/i;

// A reply that says the question was passed on must be true, so it makes the hand-off real. Matches the assistant's own
// first-person or passive wording only ("I've passed this to our team", "has been forwarded"), not a customer's words.
const CLAIMS_HANDOFF = new RegExp(
  "\\b(i(?:'ve|'ll| have| will| can| am going to)?\\s+(?:passed|pass|forwarded|forward|notified|notify|escalated|escalate|flagged|flag|handed|hand|sent|send)\\b[^.?!]*\\b(team|staff|colleague|manager|owner|someone|them|person)\\b|" +
    "\\b(?:has|have) been (?:passed|forwarded|escalated|flagged|sent|handed)\\b[^.?!]*\\b(team|staff|colleague|manager|owner|someone|person)\\b|" +
    "\\b(team(?: member)?|staff|colleague|manager|owner|someone|they|he|she)\\s*(?:will|'ll)\\s+(?:get back to|reach out|contact|call|be in touch|follow up|respond)\\b)",
  "i",
);

export function decideEscalation(input: EscalationInput): { escalate: boolean; reasons: EscalationReason[] } {
  const reasons: EscalationReason[] = [];
  if (input.handoff) reasons.push("handoff");
  else {
    if (isExplicitHumanRequest(input.userMessage)) reasons.push("human_requested");
    const supported = input.retrievedCount > 0 || input.toolOutcomes.some((t) => t.success && t.status !== "pending_approval");
    if (!supported && !isSocialTurn(input.userMessage)) reasons.push("no_support");
    if (input.toolOutcomes.some((t) => t.status === "pending_approval")) reasons.push("tool_pending");
    if (input.toolOutcomes.some((t) => !t.success && t.status !== "pending_approval")) reasons.push("tool_failed");
    const lower = input.response.toLowerCase();
    if (DECLINED.some((phrase) => lower.includes(phrase)) || NO_INFO.test(input.response) || CLAIMS_HANDOFF.test(input.response)) reasons.push("declined");
  }
  return { escalate: reasons.length > 0, reasons };
}
