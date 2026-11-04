import "@/lib/tools/builtin";
import { toolRegistry } from "@/lib/tools/registry";
import { toProviderToolDefinition } from "@/lib/tools/schema-json";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import {
  analyzeSentiment,
  detectIntent,
  estimateConfidence,
  requiresHumanApproval,
  checkBlockedTopics,
  enforceResponseLength,
} from "./guardrails";
import { decideEscalation, type ToolOutcome } from "@/lib/ai/escalation";
import { knowledgeRetriever } from "@/lib/knowledge/retriever";
import { redactProviderMessage } from "@/lib/knowledge/indexing";
import { resolveAIConfig, type ResolvedAIConfig } from "./config";
import { aiProviderRegistry } from "./providers/registry";
import { assertAiProviderPermitted } from "@/lib/platform/infrastructure-policy";
import { AIProviderError, type AIProvider, type CompletionRequest, type CompletionResult } from "./providers/types";
import { recordAIInteraction } from "./usage";
import { meteredCall, AllowanceError, estimateTokensFromText } from "./metered";
import {
  appendCustomerMessage,
  appendAssistantMessage,
  escalateConversation,
  recordEscalationSignal,
  notifyNewAssistantMessage,
} from "@/lib/conversations/messaging";
export { createNewConversation } from "@/lib/conversations/conversation-service";
import type { AIMessage } from "./providers/types";
import type { KnowledgeItem } from "@/lib/knowledge/types";
import { logger } from "@/lib/observability/logger";

interface ConversationProfile {
  businessName: string;
  businessDesc: string;
  tone: string;
  language: string;
}

function buildSystemPrompt(
  profile: ConversationProfile,
  knowledgeBase: KnowledgeItem[],
  customerName: string,
  customerHistory: string[],
  channel: string
): string {
  const toneGuide: Record<string, string> = {
    friendly:
      "Be warm, approachable, and conversational. Use a casual but professional tone.",
    professional:
      "Be polished and business-like. Maintain a confident, competent tone while remaining personable.",
    formal:
      "Be professional, polished, and courteous. Use formal language and proper grammar.",
    technical:
      "Be precise and detailed. Use technical terminology when appropriate and provide thorough explanations.",
  };

  const knowledgeSection =
    knowledgeBase.length > 0
      ? knowledgeBase
          .slice()
          .sort((a, b) => b.priority - a.priority)
          .map((k) => `[${k.category}] ${k.title}:\n${k.content}`)
          .join("\n\n---\n\n")
      : "No specific knowledge base entries available. Answer based on general knowledge about the business.";

  return `You are Ziyrak, the AI customer support assistant for ${profile.businessName}.

${profile.businessDesc ? `About the business: ${profile.businessDesc}` : ""}

## Communication Style
${toneGuide[profile.tone] || toneGuide.friendly}
${profile.language !== "auto" ? `Always respond in: ${profile.language}` : "Respond in the same language the customer uses."}

## Your Knowledge Base
Use the following information to answer customer questions accurately:

${knowledgeSection}

## Important Guidelines
- Always be helpful and try to resolve the customer's issue
- If you cannot answer a question from the knowledge base, honestly say so and tell them you have passed the question to the team
- Use the create_ticket tool when a customer reports a problem that needs human intervention
- Use send_internal_email to notify relevant team members about urgent issues
- When the customer asks for something a tool does (such as emailing the team), use that tool for it, as well as any ticket
- Use get_customer_history to check if the customer has contacted before
- Never make up information that isn't in your knowledge base
- You are the assistant for this business only. Answer from the knowledge base, not from general knowledge: give no tips, how-tos or explanations of the topic, and never recommend other businesses, classes, tutorials, software or outside services. When the customer asks what something the business sells is, or whether it offers something, say what the knowledge base states about it (its price, for example) and stop there: if it lists a price for the item, that price is the whole answer to "what is X": reply "X is N dollars" and end the reply there; only when it states nothing at all about the item, say you don't have that information and that you have passed the question to the team
- Do not work out facts the knowledge base does not state (for example, opening hours do not show that a particular lesson, session or service runs at a given time: give the hours, say you don't have the schedule for that, and say you have passed the question to the team), and do not add conditions to a rule or policy beyond its wording
- If the knowledge base has a safety or health line (allergens, medical, legal, hazards) that touches what the customer asked, state it in your reply even when you cannot answer the exact question
- Never say the business cannot, does not or will not do something (offer, provide, allow, handle, treat, administer), including anything that sounds specialist or medical, unless the knowledge base says so. If the knowledge base is silent, say you don't have that information and that you have passed the question to the team. Do not answer a question about what the business offers by saying you cannot help or by sending the customer elsewhere instead. The same goes the other way: never say the business can, does or will do something (host, collect, deliver, stock, arrange) that the knowledge base does not say, not even with a promise to check; if it is not in the knowledge base, say you don't have that information and pass the question to the team
- When a customer needs a person, or you cannot answer, say plainly that you have passed it on and what happens next (for example "I've passed this to our team and they will contact you"). Do not just offer to do it, and do not ask permission first
- If a tool fails (for example an email could not be sent), start your reply by saying that what they asked for did not go through, even if you then did something else that worked, and say what you did instead . Only say something failed if a tool result reported the failure; never describe a failure for something you did not try. Describe the failure in plain customer terms, not internal setup details. Never present the substitute as if it were what they asked for, and never claim an action succeeded when it did not
- Never show the customer a ticket id, ticket title or priority label, and do not call a ticket high priority or urgent unless the tool result shows that priority; say only that you have passed it to the team. When the customer gives contact details and asks you to act, act immediately in that turn: never ask them to confirm details they already gave or ask permission first. After acting, state the phone number or email you passed on, as a statement, so they can check it. Never tell a customer to contact "your internal team"; you are the business's assistant, so say "our team"
- Speak to the customer directly ("you", "your"), never about them in the third person. Do not promise a time ("shortly", "soon"). If you do not already have the customer's phone number or email from this chat, ask for the best way to reach them
- If the customer cannot wait (locked out, stranded, a safety problem, something urgent), say you have passed it to the team as urgent and give any emergency or call-out contact in the knowledge base. Never offer to dispatch or book anything you have no tool for
- State a safety rule from the knowledge base as a rule, at the strength it is written (must, needs, never, not allowed). When the customer asks whether they can skip or bypass it, answer no plainly; do not soften it to a recommendation
- If the customer says someone is hurt or unwell, start with a sentence telling them to get medical help if it is needed (every reply to a reported injury, however small, must have it), and give the emergency number from the knowledge base when there is one, first, and then, in the same turn, still call the tool the customer asked for (such as emailing the team) and create any ticket as usual; advice never replaces the tool call, and you may only say you have passed it to the team after a tool call in that turn did so (a minor injury still needs the tool call)
- Never end a reply by offering to pass something to the team ("I can pass that along"): either you have passed it on with a tool in this turn, or you offer nothing
- If the customer asks for more than a limit in the knowledge base allows (a group size, a quantity, a time), state the limit and say you have passed the request to the team in case an exception is possible; do not decide for the business
- If the customer asks to be transferred to a manager or any person, say you have passed their request to the team and what happens next. Do not say you cannot transfer them
- When several listed prices apply to one request (a combo, bundle or package), quote the combined price from the knowledge base, not a sum of the separate prices
- Keep responses concise but thorough
- The customer is contacting via: ${channel}
${customerName !== "Unknown" ? `- Customer name: ${customerName}` : ""}

## Customer History
${customerHistory.length > 0 ? customerHistory.join("\n") : "This is the customer's first interaction."}`;
}

/**
 * PLAN.md §46.4/§10.2 — `BusinessConfig`'s non-AI, business-profile fields
 * (the direct successor to the legacy `Settings` fields of the same name).
 * Kept separate from `resolveAIConfig()` (`ai/config.ts`), which owns only
 * provider/model/credential resolution — this is prompt-building input
 * `chat()` already owned before this phase, not new AI-provider scope.
 */
async function resolveConversationProfile(ctx: TenantContext): Promise<ConversationProfile> {
  const db = getScopedPrisma(ctx);
  const config = await db.businessConfig.upsert({
    where: { businessId: ctx.businessId },
    update: {},
    create: { businessId: ctx.businessId },
  });

  return {
    businessName: config.businessName,
    businessDesc: config.businessDesc,
    tone: config.tone,
    language: config.language,
  };
}

const NOT_CONFIGURED_NOTICE = "AI is not configured. Please add your API key in Settings > AI Configuration.";

const BLOCKED_TOPIC_REDIRECT =
  "I'm not able to help with that directly, but I can connect you with a team member who can assist you. Would you like me to do that?";

export async function chat(
  ctx: TenantContext,
  conversationId: string,
  userMessage: string,
  options?: { overrideResponse?: string }
): Promise<string> {
  const db = getScopedPrisma(ctx);

  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: { orderBy: { createdAt: "asc" }, take: 50 },
    },
  });

  if (!conversation) {
    return "Conversation not found.";
  }

  // Pre-response guardrail (§18.1/§46.4 task 5): a blocked topic never
  // reaches the model at all.
  const blockedTopic = checkBlockedTopics(userMessage);
  await appendCustomerMessage(ctx, conversationId, userMessage);

  if (blockedTopic.blocked) {
    const savedMessage = await appendAssistantMessage(ctx, conversationId, BLOCKED_TOPIC_REDIRECT);
    notifyNewAssistantMessage(ctx, conversationId, { id: savedMessage.id, content: BLOCKED_TOPIC_REDIRECT });
    return BLOCKED_TOPIC_REDIRECT;
  }

  // PLAN.md §46.6 task 6 — an automation rule's `auto_reply` action, once
  // matched by `processInboundMessage`, takes precedence over calling the
  // model at all for this turn (and deliberately doesn't require AI to be
  // configured, unlike everything below — that's the point of a
  // deterministic, automation-driven reply).
  if (options?.overrideResponse) {
    const savedMessage = await appendAssistantMessage(ctx, conversationId, options.overrideResponse);
    notifyNewAssistantMessage(ctx, conversationId, { id: savedMessage.id, content: options.overrideResponse });
    return options.overrideResponse;
  }

  const [aiConfig, profile] = await Promise.all([resolveAIConfig(ctx), resolveConversationProfile(ctx)]);

  if (!aiConfig.apiKey) {
    // Persisted like every other early-return reply above (blocked topic,
    // automation override): a channel whose delivery is "read the persisted
    // message" (Web Chat, PLAN.md §17.3/§46.7) would otherwise show a visitor
    // nothing at all while a new business is still mid-setup, and the owner
    // reading the transcript couldn't see what the customer was told.
    const notice = NOT_CONFIGURED_NOTICE;
    const savedNotice = await appendAssistantMessage(ctx, conversationId, notice);
    notifyNewAssistantMessage(ctx, conversationId, { id: savedNotice.id, content: notice });
    return notice;
  }

  const knowledgeBase = await knowledgeRetriever.retrieve(ctx, userMessage, { limit: 8 });
  // §46.4 acceptance criteria: "manually inspectable via logged prompt
  // sizes" — a cheap, direct way to confirm in production that a large
  // knowledge base is never dumped unbounded into the prompt.
  logger.info("Knowledge retrieval for chat prompt", {
    businessId: ctx.businessId,
    conversationId,
    retrievedCount: knowledgeBase.length,
  });

  // Guardrails: check if human approval needed
  const approval = requiresHumanApproval(userMessage);
  if (approval.required) {
    const sentiment = analyzeSentiment(userMessage);
    const intent = detectIntent(userMessage);

    // Store metadata for dashboard visibility
    await recordEscalationSignal(ctx, conversationId, {
      escalationReason: approval.reason,
      sentiment: sentiment.sentiment,
      intent: intent.intent,
    });
  }

  // Build message history
  const messages: AIMessage[] = [
    { role: "system", content: buildSystemPrompt(profile, knowledgeBase, conversation.customerName, [], conversation.channel) },
  ];

  for (const msg of conversation.messages) {
    if (msg.role === "customer") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      messages.push({ role: "assistant", content: msg.content });
    }
  }

  messages.push({ role: "user", content: userMessage });

  // Call AI
  const { text: rawResponse, hasToolCalls, handoff, toolOutcomes } = await callAI(ctx, aiConfig, messages, conversationId);
  const response = enforceResponseLength(rawResponse);

  // Save assistant message
  const savedMessage = await appendAssistantMessage(ctx, conversationId, response);

  // R2 — escalation follows explicit rules (human request, no supporting knowledge or tool result, failed
  // or pending tool, a reply that says it cannot help, explicit handoff). The old length/knowledge-count
  // score is kept only as a logged heuristic diagnostic; it is not a probability and decides nothing.
  const heuristic = estimateConfidence(response, knowledgeBase.length, hasToolCalls);
  const decision = decideEscalation({
    userMessage,
    response,
    retrievedCount: knowledgeBase.length,
    toolOutcomes,
    handoff,
  });
  logger.info("Escalation decision", {
    businessId: ctx.businessId,
    conversationId,
    escalate: decision.escalate,
    reasons: decision.reasons,
    heuristicScore: heuristic.score,
  });
  if (decision.escalate) {
    await escalateConversation(ctx, conversationId);
  }

  notifyNewAssistantMessage(ctx, conversationId, { id: savedMessage.id, content: response });

  return response;
}

const FALLBACK_DEPTH_EXCEEDED =
  "I apologize, but I'm having trouble processing your request. Let me connect you with a team member.";
const FALLBACK_ALLOWANCE_UNAVAILABLE =
  "I'm unable to continue with automated replies right now, so I'm connecting you with a team member who can help.";
const FALLBACK_PROVIDER_ERROR =
  "I'm temporarily unable to process your request. Please try again in a moment, or I can connect you with a team member.";

/** Replies that mean "the assistant did not actually answer" (onboarding's test reply must not accept them). */
export const NON_ANSWER_REPLIES: readonly string[] = [
  NOT_CONFIGURED_NOTICE,
  FALLBACK_DEPTH_EXCEEDED,
  FALLBACK_PROVIDER_ERROR,
  FALLBACK_ALLOWANCE_UNAVAILABLE,
];

/** What the model reads back for a tool call. A failed action says so in the result itself, where the model attends most. */
/** Last thing the model reads before replying: which requested actions did not happen. */
export function failureReminder(failed: string[]): string | null {
  if (failed.length === 0) return null;
  return `Reminder before you reply: these actions FAILED this turn and did not go through: ${[...new Set(failed)].join(", ")}. Begin your reply by telling the customer plainly that what they asked for through them did not go through, then say what you did instead.`;
}

export function toolMessageContent(toolResult: { success?: boolean; status?: string }, earlierFailures: string[] = []): string {
  if (toolResult.success || toolResult.status === "pending_approval") {
    if (!earlierFailures.length) return JSON.stringify(toolResult);
    return JSON.stringify({
      ...toolResult,
      failedActions: earlierFailures,
      note: `An earlier action in this turn FAILED and was NOT carried out (${earlierFailures.join(", ")}). Despite this success, start your reply by telling the customer that what they asked for through that action did not go through, then say what this action did instead.`,
    });
  }
  return JSON.stringify({
    ...toolResult,
    note: "This action FAILED and was NOT carried out. Tell the customer plainly that it did not work, and say what you did instead.",
  });
}

async function callAI(
  ctx: TenantContext,
  config: ResolvedAIConfig,
  messages: AIMessage[],
  conversationId: string,
  depth = 0,
  usedToolInThisTurn = false,
  toolOutcomes: ToolOutcome[] = []
): Promise<{ text: string; hasToolCalls: boolean; handoff?: boolean; toolOutcomes: ToolOutcome[] }> {
  if (depth > (config.maxToolDepth ?? 5)) {
    return { text: FALLBACK_DEPTH_EXCEEDED, hasToolCalls: usedToolInThisTurn, toolOutcomes };
  }

  await assertAiProviderPermitted(ctx.businessId, config.provider);
  const provider = aiProviderRegistry.get(config.provider, { apiKey: config.apiKey! });

  // PLAN.md §9.5 — the AI's own `ExecutionPrincipal`, distinct from
  // whatever actor (`system_job` for a channel job, `user`/`api_key` for
  // the internal chat API) originated this `chat()` call. ToolPolicy
  // governs what the AI may call regardless of who/what triggered this
  // conversation turn — never the caller's own RBAC role.
  const aiActorCtx: TenantContext = {
    ...ctx,
    role: null,
    actor: { kind: "ai_agent", conversationId, model: config.model },
  };
  const availableTools = await toolRegistry.getAvailableTools(aiActorCtx);

  let result: CompletionResult;
  try {
    const request: CompletionRequest = {
      messages,
      tools: availableTools.map(toProviderToolDefinition),
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      model: config.model,
    };
    // P2 — every provider attempt (each tool-loop iteration and the retry) is
    // metered separately for a managed workspace; unmanaged ones pass through.
    const promptTokens = estimateTokensFromText(JSON.stringify(messages) + JSON.stringify(request.tools ?? []));
    result = await completeWithOneRetry(provider, request, (attempt) =>
      meteredCall(
        ctx,
        {
          kind: "generation",
          managed: config.managed,
          estimateTokens: promptTokens + config.maxTokens,
          promptTokens,
          maxPromptTokens: config.maxPromptTokens,
          usageOf: (r: CompletionResult) => r.usage.totalTokens,
        },
        attempt
      )
    );
  } catch (error) {
    if (error instanceof AllowanceError) {
      logger.warn("AI allowance unavailable; handing the conversation to a human", {
        businessId: ctx.businessId,
        conversationId,
        reason: error.reason,
      });
      return { text: FALLBACK_ALLOWANCE_UNAVAILABLE, hasToolCalls: usedToolInThisTurn, handoff: true, toolOutcomes };
    }
    // The customer gets the honest fallback copy, never fabricated content;
    // the operator gets the reason. Never log the credential or prompt.
    logger.warn("AI provider call failed; replying with fallback copy", {
      businessId: ctx.businessId,
      conversationId,
      provider: config.provider,
      model: config.model,
      code: error instanceof AIProviderError ? error.code : "unknown",
      reason: redactProviderMessage(error instanceof Error ? error.message : String(error)),
    });
    return { text: FALLBACK_PROVIDER_ERROR, hasToolCalls: usedToolInThisTurn, toolOutcomes };
  }

  await recordAIInteraction(ctx, {
    conversationId,
    kind: "generation",
    provider: config.provider,
    model: config.model,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    totalTokens: result.usage.totalTokens,
  });

  if (result.type === "tool_calls" && result.toolCalls?.length) {
    messages.push({
      role: "assistant",
      content: result.text ?? "",
      tool_calls: result.toolCalls,
      providerContent: result.providerContent,
    });

    for (const toolCall of result.toolCalls) {
      const args = JSON.parse(toolCall.arguments);
      const toolResult = await toolRegistry.execute(aiActorCtx, toolCall.name, args, {
        conversationId,
        toolCallId: toolCall.id,
      });

      const earlierFailures = toolOutcomes.filter((o) => !o.success && o.status !== "pending_approval").map((o) => o.name ?? "an earlier action");
      toolOutcomes.push({ success: Boolean(toolResult.success), status: toolResult.status, name: toolCall.name });
      messages.push({
        role: "tool",
        content: toolMessageContent(toolResult, earlierFailures),
        tool_call_id: toolCall.id,
      });
    }

    const reminder = failureReminder(toolOutcomes.filter((o) => !o.success && o.status !== "pending_approval").map((o) => o.name ?? "an action"));
    if (reminder) messages.push({ role: "system", content: reminder });

    // Continue the conversation with tool results
    return callAI(ctx, config, messages, conversationId, depth + 1, true, toolOutcomes);
  }

  return { text: result.text || "I apologize, I could not generate a response.", hasToolCalls: usedToolInThisTurn, toolOutcomes };
}

/**
 * PLAN.md §21.3 — one bounded retry for a `retryable` `AIProviderError`
 * (rate limits, timeouts) before falling back to `callAI`'s own
 * user-facing fallback message. A non-retryable error (auth, invalid
 * request) or a second failed attempt propagates to the caller unchanged.
 */
async function completeWithOneRetry(
  provider: AIProvider,
  request: CompletionRequest,
  meter: (attempt: () => Promise<CompletionResult>) => Promise<CompletionResult>
): Promise<CompletionResult> {
  try {
    return await meter(() => provider.complete(request));
  } catch (error) {
    if (error instanceof AIProviderError && error.retryable) {
      return meter(() => provider.complete(request));
    }
    throw error;
  }
}
