import { z } from "zod";
import { AppError, NotFoundError } from "@/lib/observability/errors";
import { encryptAIProviderCredential, encryptEmbeddingProviderCredential } from "@/lib/ai/config";
import { periodStartFor } from "@/lib/ai/allowance";
import { withPlatformControl } from "./access/authority";
import { writePlatformAudit } from "./access/audit";

/**
 * PLAN.md P2 — super-admin management of the managed AI service: versioned
 * policies (provider, model, encrypted write-only credential, bounds) and
 * per-workspace allowances. Super admin only; operators and tenants have no
 * path here. Credentials are never returned and never written to the audit.
 */
const reason = z.string().trim().min(1).max(1000);
const tokens = z.number().int().min(0).max(2_000_000_000);

const policyInput = z
  .object({
    kind: z.enum(["generation", "embedding"]),
    displayName: z.string().trim().min(1).max(100),
    provider: z.enum(["openai", "anthropic"]),
    model: z.string().trim().min(1).max(100),
    apiKey: z.string().min(8).max(500).optional(),
    maxTokens: z.number().int().min(1).max(32_000),
    temperature: z.number().min(0).max(2),
    maxPromptTokens: z.number().int().min(1000).max(200_000),
    maxToolDepth: z.number().int().min(1).max(10),
    reason,
  })
  .strict()
  .refine((p) => p.kind === "generation" || p.provider === "openai", {
    message: "The only supported embedding provider is openai",
  });

const allowanceInput = z
  .object({
    businessId: z.string().min(1).max(128),
    mode: z.enum(["managed", "legacy_byok"]),
    status: z.enum(["active", "suspended", "pending_verification"]),
    generationLimitTokens: tokens.optional(),
    embeddingLimitTokens: tokens.optional(),
    reason,
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(400, "VALIDATION_ERROR", `Invalid ${what} request`);
  return result.data;
}

/** Safe projection: a flag says a credential exists, never the credential. */
function policyView(p: {
  id: string;
  kind: string;
  version: number;
  active: boolean;
  displayName: string;
  provider: string;
  model: string;
  credentialRef: string | null;
  maxTokens: number;
  temperature: number;
  maxPromptTokens: number;
  maxToolDepth: number;
  createdAt: Date;
}) {
  const { credentialRef, ...rest } = p;
  return { ...rest, hasCredential: Boolean(credentialRef) };
}

export async function savePolicy(token: string, input: unknown) {
  const request = parse(policyInput, input, "AI policy");
  const encrypted = request.apiKey
    ? request.kind === "generation"
      ? await encryptAIProviderCredential(request.provider, request.apiKey)
      : await encryptEmbeddingProviderCredential(request.provider, request.apiKey)
    : null;
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const previous = await tx.aiServicePolicy.findFirst({ where: { kind: request.kind }, orderBy: { version: "desc" } });
    let credentialRef = encrypted;
    if (!credentialRef) {
      if (!previous || previous.provider !== request.provider || !previous.credentialRef)
        throw new AppError(400, "VALIDATION_ERROR", "An API key is required for this provider");
      credentialRef = previous.credentialRef;
    }
    await tx.aiServicePolicy.updateMany({ where: { kind: request.kind, active: true }, data: { active: false } });
    const saved = await tx.aiServicePolicy.create({
      data: {
        kind: request.kind,
        version: (previous?.version ?? 0) + 1,
        active: true,
        displayName: request.displayName,
        provider: request.provider,
        model: request.model,
        credentialRef,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        maxPromptTokens: request.maxPromptTokens,
        maxToolDepth: request.maxToolDepth,
      },
    });
    await writePlatformAudit(tx, {
      actorUserId: actor.userId,
      action: "ai.policy.save",
      reason: request.reason,
      details: {
        kind: saved.kind,
        version: saved.version,
        provider: saved.provider,
        model: saved.model,
        credentialReplaced: Boolean(encrypted),
      },
    });
    return policyView(saved);
  });
}

export async function setWorkspaceAllowance(token: string, input: unknown) {
  const request = parse(allowanceInput, input, "AI allowance");
  return withPlatformControl(token, "super_admin", async (tx, actor) => {
    const business = await tx.business.findUnique({ where: { id: request.businessId }, select: { id: true } });
    if (!business) throw new NotFoundError("Workspace");
    const limits = {
      ...(request.generationLimitTokens !== undefined && { generationLimitTokens: request.generationLimitTokens }),
      ...(request.embeddingLimitTokens !== undefined && { embeddingLimitTokens: request.embeddingLimitTokens }),
    };
    const saved = await tx.workspaceAiAllowance.upsert({
      where: { businessId: request.businessId },
      create: { businessId: request.businessId, mode: request.mode, status: request.status, ...limits },
      update: { mode: request.mode, status: request.status, ...limits },
    });
    await writePlatformAudit(tx, {
      actorUserId: actor.userId,
      action: "ai.allowance.set",
      reason: request.reason,
      businessId: request.businessId,
      details: {
        mode: saved.mode,
        status: saved.status,
        generationLimitTokens: saved.generationLimitTokens,
        embeddingLimitTokens: saved.embeddingLimitTokens,
      },
    });
    return saved;
  });
}

export async function readAiServiceConsole(token: string) {
  return withPlatformControl(token, "super_admin", async (tx) => {
    const [policies, allowances, businesses] = await Promise.all([
      tx.aiServicePolicy.findMany({ orderBy: [{ kind: "asc" }, { version: "desc" }], take: 50 }),
      tx.workspaceAiAllowance.findMany({ take: 500 }),
      tx.business.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
    ]);
    const periodStart = periodStartFor(new Date());
    const usage = await tx.aiUsageReservation.findMany({
      where: { periodStart, state: { not: "released" } },
      select: { businessId: true, kind: true, state: true, reservedTokens: true, settledTokens: true },
    });
    const byWorkspace = new Map(allowances.map((a) => [a.businessId, a]));
    return {
      policies: policies.map(policyView),
      workspaces: businesses.map((b) => {
        const a = byWorkspace.get(b.id);
        // Charged = settled actuals + reserved bounds (open or uncertain).
        const used = (kind: string) =>
          usage
            .filter((u) => u.businessId === b.id && u.kind === kind)
            .reduce((sum, u) => sum + (u.state === "settled" ? (u.settledTokens ?? u.reservedTokens) : u.reservedTokens), 0);
        return {
          businessId: b.id,
          name: b.name,
          mode: a?.mode ?? "unconfigured",
          status: a?.status ?? null,
          generationLimitTokens: a?.generationLimitTokens ?? null,
          embeddingLimitTokens: a?.embeddingLimitTokens ?? null,
          generationUsed: used("generation"),
          embeddingUsed: used("embedding"),
        };
      }),
    };
  });
}
