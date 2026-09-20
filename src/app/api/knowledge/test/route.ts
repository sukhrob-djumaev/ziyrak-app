import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/observability/logger";
import { requireAuth, isAuthenticated } from "@/lib/identity/route-auth";
import { AppError, toErrorResponse } from "@/lib/observability/errors";
import * as knowledgeService from "@/lib/knowledge/service";
import { resolveAIConfig } from "@/lib/ai/config";
import { aiProviderRegistry } from "@/lib/ai/providers/registry";
import { recordAIInteraction } from "@/lib/ai/usage";

export async function POST(request: NextRequest) {
  const ctx = await requireAuth(request, "knowledge:read");
  if (!isAuthenticated(ctx)) return ctx;

  try {
    const body = await request.json();
    const { question } = body;

    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return NextResponse.json(
        { error: "Question is required" },
        { status: 400 }
      );
    }

    // §46.4 — resolves this business's own AI provider/model/credential
    // (BusinessConfig, falling back to legacy Settings for the Default
    // Business only, per ai/config.ts's precedence) instead of the legacy
    // global Settings singleton every business used to be fail-closed
    // against (Phase 2's assertDefaultBusinessOnly guard, removed now that
    // every business resolves its own config).
    const aiConfig = await resolveAIConfig(ctx);

    if (!aiConfig.apiKey) {
      return NextResponse.json(
        { error: "AI API key is not configured. Please configure it in Settings." },
        { status: 400 }
      );
    }

    const entries = await knowledgeService.listActiveEntriesForTest(ctx);

    if (entries.length === 0) {
      return NextResponse.json(
        { error: "No active knowledge base entries found. Add entries first." },
        { status: 400 }
      );
    }

    // Build knowledge context
    const knowledgeContext = entries
      .map(
        (entry, index) =>
          `[Entry ${index + 1}] Category: ${entry.category.name} | Title: ${entry.title}\n${entry.content}`
      )
      .join("\n\n---\n\n");

    const systemPrompt = `You are a knowledge base testing assistant. You have access to the following knowledge base entries. Answer the user's question using ONLY the information provided below. If the answer is not in the knowledge base, say so clearly.

After your answer, list which knowledge base entries were most relevant to your answer by referencing their entry numbers and titles.

## Knowledge Base

${knowledgeContext}

## Response Format
Provide your answer first, then on a new line write "---SOURCES---" followed by a JSON array of the entry numbers (1-based) that were most relevant. Example:
Your answer here...
---SOURCES---
[1, 3, 5]`;

    const provider = aiProviderRegistry.get(aiConfig.provider, { apiKey: aiConfig.apiKey });
    const completion = await provider.complete({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question.trim() },
      ],
      maxTokens: aiConfig.maxTokens,
      temperature: aiConfig.temperature,
      model: aiConfig.model,
    });

    await recordAIInteraction(ctx, {
      kind: "generation",
      provider: aiConfig.provider,
      model: aiConfig.model,
      promptTokens: completion.usage.promptTokens,
      completionTokens: completion.usage.completionTokens,
      totalTokens: completion.usage.totalTokens,
    });

    const responseText = completion.text ?? "";

    // Parse sources from response
    let answer = responseText;
    let sourceIndices: number[] = [];

    const sourcesSplit = responseText.split("---SOURCES---");
    if (sourcesSplit.length > 1) {
      answer = sourcesSplit[0].trim();
      try {
        const parsed = JSON.parse(sourcesSplit[1].trim());
        if (Array.isArray(parsed)) {
          sourceIndices = parsed.filter(
            (n: unknown) => typeof n === "number" && n >= 1 && n <= entries.length
          );
        }
      } catch {
        // If parsing fails, no sources to show
      }
    }

    // Map source indices to actual entries
    const sources = sourceIndices.map((idx) => {
      const entry = entries[idx - 1];
      return {
        id: entry.id,
        title: entry.title,
        category: entry.category.name,
        categoryColor: entry.category.color,
        contentPreview: entry.content.slice(0, 200),
      };
    });

    return NextResponse.json({
      answer,
      sources,
      model: aiConfig.model,
      totalEntries: entries.length,
    });
  } catch (error) {
    logger.error("Failed to test knowledge base:", error);
    if (error instanceof AppError) return toErrorResponse(error);
    const message =
      error instanceof Error ? error.message : "Failed to test knowledge base";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
