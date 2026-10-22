import { prisma } from "@/lib/prisma/raw-client";
import { getScopedPrisma } from "@/lib/tenancy/scoped-prisma";
import type { TenantContext } from "@/lib/tenancy/context";
import { chat, NON_ANSWER_REPLIES } from "@/lib/ai/engine";
import { logger } from "@/lib/observability/logger";

/**
 * PLAN.md P3 — resumable onboarding. Knowledge and channel readiness are read
 * live; the one step that cannot be derived (a real test reply) is recorded in
 * `OnboardingState`; activation is `OnboardingState.activatedAt`. A workspace has
 * onboarding only if it has an `OnboardingState` row (created by signup with an
 * email); seeded and legacy workspaces are never gated. State survives reloads
 * and failures because nothing lives in the browser.
 */
export type StepStatus = "pending" | "done" | "failed";
export interface OnboardingStep {
  id: "knowledge" | "channel" | "test_reply" | "activation";
  title: string;
  status: StepStatus;
  /** Customer-readable detail; never provider text. */
  detail?: string;
}
export interface OnboardingView {
  applicable: boolean;
  emailVerified: boolean;
  activated: boolean;
  steps: OnboardingStep[];
}

export async function isOnboardingInactive(businessId: string): Promise<boolean> {
  const state = await prisma.onboardingState.findUnique({
    where: { businessId },
    select: { activatedAt: true },
  });
  return Boolean(state && !state.activatedAt);
}

export async function getOnboardingState(input: { businessId: string; userId: string }): Promise<OnboardingView> {
  const [state, user, knowledge, channels] = await Promise.all([
    prisma.onboardingState.findUnique({ where: { businessId: input.businessId } }),
    prisma.user.findUnique({ where: { id: input.userId }, select: { emailVerifiedAt: true } }),
    prisma.knowledgeEntry.count({ where: { businessId: input.businessId, isActive: true } }),
    prisma.channelConnection.count({ where: { businessId: input.businessId, isActive: true } }),
  ]);
  const activated = Boolean(state?.activatedAt);
  const status = (done: boolean): StepStatus => (done ? "done" : "pending");
  return {
    applicable: Boolean(state),
    emailVerified: Boolean(user?.emailVerifiedAt),
    activated,
    steps: [
      { id: "knowledge", title: "Add what your assistant should know", status: status(knowledge > 0) },
      { id: "channel", title: "Connect a channel", status: status(channels > 0) },
      {
        id: "test_reply",
        title: "Get a useful test reply",
        status: state?.testReplyStatus === "passed" ? "done" : state?.testReplyStatus === "failed" ? "failed" : "pending",
        ...(state?.testReplyStatus === "failed" && state.testReplyReason ? { detail: state.testReplyReason } : {}),
      },
      { id: "activation", title: "Activate your workspace", status: status(activated) },
    ],
  };
}

export type OnboardingResult =
  | { ok: true }
  | { ok: false; code: "OWNER_REQUIRED" | "EMAIL_NOT_VERIFIED" | "KNOWLEDGE_MISSING" | "TEST_REPLY_FAILED" | "STEPS_INCOMPLETE" | "NOT_APPLICABLE"; message: string; missing?: string[] };

const FAILURE_DETAIL = "The assistant could not give a reply right now. Check that the AI service is available for your workspace and try again.";

async function ownerVerified(ctx: TenantContext, userId: string): Promise<OnboardingResult | null> {
  if (ctx.role !== "owner") return { ok: false, code: "OWNER_REQUIRED", message: "Only the workspace owner can do this." };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
  if (!user?.emailVerifiedAt)
    return { ok: false, code: "EMAIL_NOT_VERIFIED", message: "Confirm your email address first." };
  return null;
}

/** Asks the real assistant a question from the workspace's own knowledge and records whether it answered. */
export async function runOnboardingTestReply(ctx: TenantContext, userId: string): Promise<OnboardingResult> {
  const refused = await ownerVerified(ctx, userId);
  if (refused) return refused;
  const state = await prisma.onboardingState.findUnique({ where: { businessId: ctx.businessId } });
  if (!state) return { ok: false, code: "NOT_APPLICABLE", message: "This workspace has no onboarding." };
  const db = getScopedPrisma(ctx);
  const entry = await db.knowledgeEntry.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" }, select: { title: true } });
  if (!entry) return { ok: false, code: "KNOWLEDGE_MISSING", message: "Add something to your knowledge base first." };

  let answered = false;
  try {
    const conversation = await db.conversation.create({
      data: { businessId: ctx.businessId, channel: "api", customerName: "Onboarding test", customerContact: "onboarding-test", metadata: { onboardingTest: true } },
    });
    const reply = await chat(ctx, conversation.id, `Tell me about: ${entry.title}`);
    answered = reply.trim().length > 0 && !NON_ANSWER_REPLIES.includes(reply);
  } catch (error) {
    logger.error("Onboarding test reply failed", { businessId: ctx.businessId, error: error instanceof Error ? error.message : String(error) });
  }
  await prisma.onboardingState.update({
    where: { businessId: ctx.businessId },
    data: answered
      ? { testReplyStatus: "passed", testReplyAt: new Date(), testReplyReason: null }
      : { testReplyStatus: "failed", testReplyAt: new Date(), testReplyReason: FAILURE_DETAIL },
  });
  return answered ? { ok: true } : { ok: false, code: "TEST_REPLY_FAILED", message: FAILURE_DETAIL };
}

/** Explicit activation. Needs the owner, a verified email and every required step done. Idempotent. */
export async function activateWorkspace(ctx: TenantContext, userId: string): Promise<OnboardingResult> {
  const refused = await ownerVerified(ctx, userId);
  if (refused) return refused;
  const view = await getOnboardingState({ businessId: ctx.businessId, userId });
  if (!view.applicable || view.activated) return { ok: true };
  const missing = view.steps.filter((s) => s.id !== "activation" && s.status !== "done").map((s) => s.id);
  if (missing.length)
    return { ok: false, code: "STEPS_INCOMPLETE", message: "Finish the remaining steps first.", missing };
  await prisma.onboardingState.updateMany({ where: { businessId: ctx.businessId, activatedAt: null }, data: { activatedAt: new Date() } });
  return { ok: true };
}
