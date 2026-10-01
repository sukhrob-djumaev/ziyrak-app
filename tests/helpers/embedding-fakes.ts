import { vi } from "vitest";
import { embeddingProviderRegistry } from "@/lib/ai/providers/embedding-registry";
import { AIProviderError, type EmbeddingProvider, type EmbeddingResult } from "@/lib/ai/providers/types";

/**
 * Deterministic `EmbeddingProvider` test doubles for the knowledge-indexing
 * suites (PLAN.md §21.4/§21.5/§34.2 — a fake embedding provider with
 * deterministic vectors for the default suite; no real provider is ever
 * called in ordinary CI).
 *
 * `ConceptEmbeddingProvider` is deliberately *semantic*, not lexical: each
 * vector dimension is a concept, and a small fixed lexicon maps different
 * surface words (and two-word phrases) onto the same concept — "money back"
 * and "reimbursed" both land on the `refund` dimension even though they
 * share no word. That is the property that lets a test construct entries
 * where keyword matching picks the wrong entry (or none) while cosine
 * similarity over these vectors picks the intended one — proving the
 * stored-embedding path, not the keyword fallback, produced the ranking.
 */
const CONCEPTS = ["refund", "remittance", "delivery", "hours", "pets", "finance"] as const;

/** Phrases are matched before single words, so "money back" is a refund, not just "money". */
const PHRASE_CONCEPTS: Record<string, (typeof CONCEPTS)[number]> = {
  "money back": "refund",
  "get back": "refund",
};

const WORD_CONCEPTS: Record<string, (typeof CONCEPTS)[number]> = {
  refund: "refund",
  refunds: "refund",
  reimburse: "refund",
  reimbursed: "refund",
  reimbursement: "refund",
  returned: "refund",
  transfer: "remittance",
  transfers: "remittance",
  abroad: "remittance",
  international: "remittance",
  family: "remittance",
  wire: "remittance",
  shipping: "delivery",
  courier: "delivery",
  parcel: "delivery",
  arrive: "delivery",
  open: "hours",
  opening: "hours",
  closing: "hours",
  weekend: "hours",
  dog: "pets",
  dogs: "pets",
  cat: "pets",
  cats: "pets",
  pets: "pets",
  money: "finance",
  dollars: "finance",
  purchase: "finance",
  purchases: "finance",
};

/**
 * Words with no concept still contribute — weakly — through a few hashed
 * "lexical" dimensions, the way a real embedding still distinguishes two
 * unrelated texts that share no topic. Without this, every concept-free
 * text would embed identically and match every other concept-free text
 * perfectly.
 */
const LEXICAL_DIMENSIONS = 64;
const LEXICAL_WEIGHT = 0.05;

export class ConceptEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = CONCEPTS.length + LEXICAL_DIMENSIONS;
  readonly model: string = "fake-concept-v1";
  readonly requests: string[] = [];

  constructor(
    readonly apiKey: string,
    readonly name = "fake-concept"
  ) {}

  async embed(text: string): Promise<EmbeddingResult> {
    this.requests.push(text);
    return { vector: conceptVector(text), model: "fake-concept-v1", usage: { totalTokens: Math.ceil(text.length / 4) } };
  }
}

function lexicalDimension(word: string): number {
  let hash = 2166136261;
  for (let i = 0; i < word.length; i++) hash = Math.imul(hash ^ word.charCodeAt(i), 16777619) >>> 0;
  return CONCEPTS.length + (hash % LEXICAL_DIMENSIONS);
}

export function conceptVector(text: string): number[] {
  let lower = text.toLowerCase();
  const vector: number[] = new Array(CONCEPTS.length + LEXICAL_DIMENSIONS).fill(0);
  for (const [phrase, concept] of Object.entries(PHRASE_CONCEPTS)) {
    if (lower.includes(phrase)) {
      vector[CONCEPTS.indexOf(concept)] += 1;
      lower = lower.split(phrase).join(" ");
    }
  }
  for (const word of lower.split(/[^a-z]+/).filter(Boolean)) {
    const concept = WORD_CONCEPTS[word];
    if (!concept) vector[lexicalDimension(word)] += LEXICAL_WEIGHT;
    // "finance" is a weak, generic concept — it should never outweigh a specific one.
    else vector[CONCEPTS.indexOf(concept)] += concept === "finance" ? 0.3 : 1;
  }
  return vector;
}

/**
 * A provider bound to one credential that records every call and can be
 * scripted to fail — used to prove which business's credential an
 * indexing job actually used, and how failures/retries behave.
 */
export class ScriptedEmbeddingProvider extends ConceptEmbeddingProvider {
  /** Errors thrown by the next N calls, in order; once exhausted, calls succeed. */
  readonly failures: Error[] = [];
  /** When set, `embed()` waits for this before resolving (for stale-write races). */
  gate: ((text: string) => Promise<void>) | null = null;
  successes = 0;

  override async embed(text: string): Promise<EmbeddingResult> {
    this.requests.push(text);
    if (this.gate) await this.gate(text);
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.successes++;
    return { vector: conceptVector(text), model: "fake-concept-v1", usage: { totalTokens: Math.ceil(text.length / 4) } };
  }
}

export function retryableEmbeddingError(): AIProviderError {
  return new AIProviderError("rate_limit", "simulated provider rate limit", true);
}

export function nonRetryableEmbeddingError(): AIProviderError {
  return new AIProviderError("auth", "simulated invalid embedding API key", false);
}

/**
 * Routes `EmbeddingProviderRegistry.get()` to a test double chosen by the
 * *resolved credential* — so a test asserts on which business's own key
 * was handed to the registry, exactly the seam production code goes
 * through (`resolveEmbeddingConfig()` → registry), instead of mocking the
 * config resolution itself. Returns the spy; callers restore it.
 */
export function routeEmbeddingRegistry(byApiKey: (apiKey: string, name: string) => EmbeddingProvider) {
  return vi
    .spyOn(embeddingProviderRegistry, "get")
    .mockImplementation((name: string, credential: { apiKey: string }) => byApiKey(credential.apiKey, name));
}
