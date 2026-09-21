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
import { knowledgeRetriever } from "@/lib/knowledge/retriever";
import { resolveAIConfig, type ResolvedAIConfig } from "./config";
import { aiProviderRegistry } from "./providers/registry";
import { AIProviderError, type AIProvider, type CompletionRequest, type CompletionResult } from "./providers/types";
import { recordAIInteraction } from "./usage";
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

  return `You are Owly, the AI customer support assistant for ${profile.businessName}.

${profile.businessDesc ? `About the business: ${profile.businessDesc}` : ""}

## Communication Style
${toneGuide[profile.tone] || toneGuide.friendly}
${profile.language !== "auto" ? `Always respond in: ${profile.language}` : "Respond in the same language the customer uses."}

## Your Knowledge Base
Use the following information to answer customer questions accurately:

${knowledgeSection}

## Important Guidelines
- Always be helpful and try to resolve the customer's issue
- If you cannot answer a question from the knowledge base, honestly say so and offer to connect them with a team member
- Use the create_ticket tool when a customer reports a problem that needs human intervention
- Use send_internal_email to notify relevant team members about urgent issues
- Use get_customer_history to check if the customer has contacted before
- Never make up information that isn't in your knowledge base
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
    const notice = "AI is not configured. Please add your API key in Settings > AI Configuration.";
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
  const { text: rawResponse, hasToolCalls } = await callAI(ctx, aiConfig, messages, conversationId);
  const response = enforceResponseLength(rawResponse);

  // Save assistant message
  const savedMessage = await appendAssistantMessage(ctx, conversationId, response);

  // Confidence scoring — §2.3's hasToolCalls bug: this now reflects whether
  // a tool was actually used anywhere in this turn's (possibly recursive)
  // tool-call loop, not a hardcoded false.
  const confidence = estimateConfidence(response, knowledgeBase.length, hasToolCalls);
  if (confidence.shouldEscalate) {
    await escalateConversation(ctx, conversationId);
  }

  notifyNewAssistantMessage(ctx, conversationId, { id: savedMessage.id, content: response });

  return response;
}

const FALLBACK_DEPTH_EXCEEDED =
  "I apologize, but I'm having trouble processing your request. Let me connect you with a team member.";
const FALLBACK_PROVIDER_ERROR =
  "I'm temporarily unable to process your request. Please try again in a moment, or I can connect you with a team member.";

async function callAI(
  ctx: TenantContext,
  config: ResolvedAIConfig,
  messages: AIMessage[],
  conversationId: string,
  depth = 0,
  usedToolInThisTurn = false
): Promise<{ text: string; hasToolCalls: boolean }> {
  if (depth > 5) {
    return { text: FALLBACK_DEPTH_EXCEEDED, hasToolCalls: usedToolInThisTurn };
  }

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
    result = await completeWithOneRetry(provider, {
      messages,
      tools: availableTools.map(toProviderToolDefinition),
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      model: config.model,
    });
  } catch {
    return { text: FALLBACK_PROVIDER_ERROR, hasToolCalls: usedToolInThisTurn };
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
    });

    for (const toolCall of result.toolCalls) {
      const args = JSON.parse(toolCall.arguments);
      const toolResult = await toolRegistry.execute(aiActorCtx, toolCall.name, args, {
        conversationId,
        toolCallId: toolCall.id,
      });

      messages.push({
        role: "tool",
        content: JSON.stringify(toolResult),
        tool_call_id: toolCall.id,
      });
    }

    // Continue the conversation with tool results
    return callAI(ctx, config, messages, conversationId, depth + 1, true);
  }

  return { text: result.text || "I apologize, I could not generate a response.", hasToolCalls: usedToolInThisTurn };
}

/**
 * PLAN.md §21.3 — one bounded retry for a `retryable` `AIProviderError`
 * (rate limits, timeouts) before falling back to `callAI`'s own
 * user-facing fallback message. A non-retryable error (auth, invalid
 * request) or a second failed attempt propagates to the caller unchanged.
 */
async function completeWithOneRetry(provider: AIProvider, request: CompletionRequest): Promise<CompletionResult> {
  try {
    return await provider.complete(request);
  } catch (error) {
    if (error instanceof AIProviderError && error.retryable) {
      return provider.complete(request);
    }
    throw error;
  }
}
