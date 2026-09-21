import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "crypto";

/**
 * PLAN.md §44.3 / §46.7 — the MVP acceptance scenario, run end to end for
 * TWO independently-signed-up businesses through BOTH production channels:
 *
 *   sign up → owner logs in → configure AI → add knowledge → configure the
 *   channel → real customer message → customer/conversation created →
 *   business-specific knowledge retrieved → AI reply → AI creates a ticket
 *   (ToolPolicy-governed) → reply delivered on the channel → escalation to a
 *   human → an invited agent sees and takes over → everything attributed to
 *   the right businessId in the activity log — while the other business
 *   sees none of it through any API, guessed id, or direct database write.
 *
 * Real: Postgres, the route handlers, auth, tenant-scoped Prisma, adapters,
 * `processInboundMessage`, the tool registry, the job pipeline (in-process
 * `FakeJobQueue`, drained explicitly). Faked at the external boundary only,
 * per §34.2: the OpenAI SDK and Meta's HTTP transport. The credential-gated
 * live Meta path is `tests/integration/meta-whatsapp-live.test.ts`.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
vi.mock("@/lib/identity/route-auth", async (importOriginal) => importOriginal());

interface OpenAICall {
  apiKey: string;
  systemPrompt: string;
  lastRole: string;
  tools: string[];
}
const openAICalls = vi.hoisted(() => [] as OpenAICall[]);

vi.mock("openai", () => {
  class APIError extends Error {
    status?: number;
  }
  class APIConnectionTimeoutError extends APIError {}
  class OpenAI {
    chat: { completions: { create: (params: { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] }) => Promise<unknown> } };
    embeddings: { create: (params: { input: string }) => Promise<unknown> };
    constructor(opts: { apiKey: string }) {
      this.embeddings = {
        create: async ({ input }) => ({ data: [{ embedding: [input.length % 7, 1, 2] }], usage: { total_tokens: 4 } }),
      };
      this.chat = {
        completions: {
          create: async (params) => {
            const system = params.messages[0].content;
            const last = params.messages[params.messages.length - 1];
            openAICalls.push({
              apiKey: opts.apiKey,
              systemPrompt: system,
              lastRole: last.role,
              tools: (params.tools ?? []).map((t) => t.function.name),
            });
            const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
            const markers = (system.match(/KB-[A-Z]+-\d+/g) ?? []).join(" ");

            if (last.role === "tool") {
              return { usage, choices: [{ finish_reason: "stop", message: { content: `I have opened a ticket for you, ${markers}: our team will follow up shortly.` } }] };
            }
            if (/open a ticket/i.test(last.content)) {
              return {
                usage,
                choices: [{
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [{ id: `call_${crypto.randomUUID()}`, type: "function", function: { name: "create_ticket", arguments: JSON.stringify({ title: "Item arrived broken", description: "Customer reports a broken item", priority: "high" }) } }],
                  },
                }],
              };
            }
            if (/speak to a human|cannot help/i.test(last.content)) {
              return { usage, choices: [{ finish_reason: "stop", message: { content: "I'm not sure about that, so let me connect you with a team member who can." } }] };
            }
            return { usage, choices: [{ finish_reason: "stop", message: { content: `Here is what our knowledge base says (${markers}) about the warranty question you asked.` } }] };
          },
        },
      };
    }
  }
  return { default: OpenAI, APIError, APIConnectionTimeoutError };
});

import { prisma } from "@/lib/prisma/raw-client";
import { createRequest, createAuthenticatedRequest, parseJsonResponse } from "../helpers/request";
import { cleanupBusiness } from "../helpers/tenant-fixtures";
import { jobQueue } from "@/lib/jobs/queue";
import type { FakeJobQueue } from "@/lib/jobs/fake-job-queue";
import "@/lib/channels/bootstrap";
import "@/lib/jobs/bootstrap";
import { NextRequest } from "next/server";

const APP_SECRET = "e2e-meta-app-secret";
const ORIGIN = "https://shop.example.com";
const drain = () => (jobQueue as unknown as FakeJobQueue).__drainForTests();
const uniq = () => crypto.randomBytes(4).toString("hex");

// ---- Meta Graph API fake (the only external transport besides OpenAI) ----
interface MetaSend { phoneNumberId: string; token: string; to: string; text: string }
const metaSends: MetaSend[] = [];
const validMetaCredentials = new Set<string>(); // "<phoneNumberId>|<token>"
const realFetch = global.fetch;

function installFakeGraph() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  global.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://graph.facebook.com/")) return realFetch(input, init);
    const token = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace("Bearer ", "");
    const path = new URL(url).pathname.split("/").filter(Boolean); // [version, phoneNumberId, "messages"?]
    const phoneNumberId = decodeURIComponent(path[1]);
    if (init?.method === "POST" && path[2] === "messages") {
      const body = JSON.parse(String(init.body));
      metaSends.push({ phoneNumberId, token, to: body.to, text: body.text.body });
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) } as Response;
    }
    const ok = validMetaCredentials.has(`${phoneNumberId}|${token}`);
    return { ok, status: ok ? 200 : 400, json: async () => (ok ? { id: phoneNumberId } : {}), text: async () => "" } as Response;
  }) as typeof fetch;
}

// ---- Business onboarding through the real HTTP handlers ----
interface Biz {
  name: string;
  marker: string;
  businessId: string;
  ownerToken: string;
  agentToken: string;
  aiKey: string;
  channel: { connectionId: string; token?: string; phoneNumberId?: string; accessToken?: string };
}

function tokenFrom(response: Response): string {
  return /owly-token=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? "";
}

async function call(handlerModule: string, method: "GET" | "POST" | "PUT" | "PATCH", token: string, path: string, body?: Record<string, unknown>, params?: Record<string, string>, searchParams?: Record<string, string>) {
  const mod = await import(/* @vite-ignore */ handlerModule);
  const request = createAuthenticatedRequest(path, token, { method, body, searchParams });
  return mod[method](request, params ? { params: Promise.resolve(params) } : undefined) as Promise<Response>;
}

async function signupAndConfigure(label: string, marker: string): Promise<Biz> {
  const username = `${label}-${uniq()}`;
  const password = "e2e-password-123";
  const name = `${label} Shop ${uniq()}`;

  const { POST: authPost } = await import("@/app/api/auth/route");
  const signup = await authPost(createRequest("/api/auth", { method: "POST", body: { action: "signup", businessName: name, username, password, name: "Owner" } }));
  expect(signup.status).toBe(201);
  const businessId = (await parseJsonResponse(signup)).business.id as string;

  // The owner logs in again like a returning user (existing login keeps working).
  const login = await authPost(createRequest("/api/auth", { method: "POST", body: { action: "login", username, password } }));
  expect(login.status).toBe(200);
  const ownerToken = tokenFrom(login);

  const aiKey = `sk-${label}-${uniq()}`;
  const ai = await call("@/app/api/settings/ai/route", "PUT", ownerToken, "/api/settings/ai", { aiProvider: "openai", aiModel: "gpt-4o-mini", aiApiKey: aiKey });
  expect(ai.status).toBe(200);
  expect(JSON.stringify(await parseJsonResponse(ai))).not.toContain(aiKey);

  const category = await call("@/app/api/knowledge/categories/route", "POST", ownerToken, "/api/knowledge/categories", { name: "Warranty" });
  expect(category.status).toBe(201);
  const categoryId = (await parseJsonResponse(category)).id as string;
  const entry = await call("@/app/api/knowledge/entries/route", "POST", ownerToken, "/api/knowledge/entries", {
    categoryId,
    title: "Warranty policy",
    content: `${marker}: how long the warranty lasts for our products. The warranty policy applies to every purchase.`,
  });
  expect(entry.status).toBe(201);

  // The owner invites the business's first agent (the role the dashboard now offers).
  const agentName = `agent-${label}-${uniq()}`;
  const invite = await call("@/app/api/admin/users/route", "POST", ownerToken, "/api/admin/users", { username: agentName, password: "agent-password-1", name: "First Agent", role: "agent" });
  expect(invite.status).toBe(201);
  const agentLogin = await authPost(createRequest("/api/auth", { method: "POST", body: { action: "login", username: agentName, password: "agent-password-1" } }));
  const agentToken = tokenFrom(agentLogin);

  return { name, marker, businessId, ownerToken, agentToken, aiKey, channel: { connectionId: "" } };
}

// ---- Channel drivers: how a customer's message enters and how their reply is observed ----
interface Driver {
  configure(biz: Biz): Promise<void>;
  send(biz: Biz, customer: string, text: string): Promise<void>;
  /** What the customer has actually been shown, in order. */
  seen(biz: Biz, customer: string): Promise<string[]>;
  conversationFor(biz: Biz, customer: string): Promise<{ id: string; status: string } | null>;
}

const webchatSessions = new Map<string, { conversationId: string; visitorId: string }>();
const webchatDriver: Driver = {
  async configure(biz) {
    const created = await call("@/app/api/channels/webchat-connections/route", "POST", biz.ownerToken, "/api/channels/webchat-connections", { allowedOrigins: [ORIGIN] });
    expect(created.status).toBe(201);
    const data = await parseJsonResponse(created);
    biz.channel = { connectionId: data.connectionId, token: data.token };
    expect(data.embedSnippet).toContain("/widget.js?v=");
  },
  async send(biz, customer, text) {
    const key = `${biz.businessId}:${customer}`;
    if (!webchatSessions.has(key)) webchatSessions.set(key, { conversationId: crypto.randomUUID(), visitorId: crypto.randomUUID() });
    const session = webchatSessions.get(key)!;
    const { POST } = await import("@/app/api/channels/webchat/[connectionId]/message/route");
    const response = await POST(
      createRequest(`/api/channels/webchat/${biz.channel.connectionId}/message`, {
        method: "POST",
        headers: { origin: ORIGIN, "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250)}` },
        body: { token: biz.channel.token, conversationId: session.conversationId, clientMessageId: crypto.randomUUID(), customerContact: session.visitorId, customerName: customer, text },
      }),
      { params: Promise.resolve({ connectionId: biz.channel.connectionId }) }
    );
    expect(response.status).toBe(200);
    await drain();
  },
  async seen(biz, customer) {
    const session = webchatSessions.get(`${biz.businessId}:${customer}`)!;
    const { GET } = await import("@/app/api/channels/webchat/[connectionId]/messages/route");
    const response = await GET(
      createRequest(`/api/channels/webchat/${biz.channel.connectionId}/messages`, {
        headers: { origin: ORIGIN, "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250)}` },
        searchParams: { token: biz.channel.token!, conversationId: session.conversationId, visitorId: session.visitorId },
      }),
      { params: Promise.resolve({ connectionId: biz.channel.connectionId }) }
    );
    expect(response.status).toBe(200);
    const body = await parseJsonResponse(response);
    return body.messages.filter((m: { role: string }) => m.role === "assistant").map((m: { content: string }) => m.content);
  },
  async conversationFor(biz, customer) {
    const session = webchatSessions.get(`${biz.businessId}:${customer}`);
    if (!session) return null;
    return prisma.conversation.findFirst({ where: { businessId: biz.businessId, id: session.conversationId }, select: { id: true, status: true } });
  },
};

const metaDriver: Driver = {
  async configure(biz) {
    const phoneNumberId = `pn-${uniq()}`;
    const accessToken = `meta-token-${biz.name.replace(/\W/g, "")}-${uniq()}`;
    validMetaCredentials.add(`${phoneNumberId}|${accessToken}`);
    const saved = await call("@/app/api/channels/[type]/route", "PUT", biz.ownerToken, "/api/channels/whatsapp_cloud", {
      isActive: true,
      status: "connected",
      credential: { type: "whatsapp_cloud", phoneNumberId, accessToken, businessAccountId: `waba-${uniq()}` },
    }, { type: "whatsapp_cloud" });
    expect(saved.status).toBe(200);
    const row = await parseJsonResponse(saved);
    biz.channel = { connectionId: row.id, phoneNumberId, accessToken };
    expect(JSON.stringify(row)).not.toContain(accessToken);
  },
  async send(biz, customer, text) {
    const wamid = `wamid.${crypto.randomUUID()}`;
    const rawBody = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "waba", changes: [{ field: "messages", value: {
        messaging_product: "whatsapp",
        metadata: { phone_number_id: biz.channel.phoneNumberId },
        contacts: [{ profile: { name: `Customer ${customer}` }, wa_id: customer }],
        messages: [{ from: customer, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
      } }] }],
    });
    const signature = `sha256=${crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
    const { POST } = await import("@/app/api/channels/whatsapp-cloud/webhook/route");
    const response = await POST(new Request("https://ziyrak.example/api/channels/whatsapp-cloud/webhook", { method: "POST", headers: { "x-hub-signature-256": signature, "content-type": "application/json" }, body: rawBody }) as unknown as NextRequest);
    expect(response.status).toBe(200);
    await drain();
  },
  async seen(biz, customer) {
    return metaSends.filter((s) => s.phoneNumberId === biz.channel.phoneNumberId && s.to === customer).map((s) => s.text);
  },
  async conversationFor(biz, customer) {
    return prisma.conversation.findFirst({ where: { businessId: biz.businessId, channel: "whatsapp_cloud", customerContact: customer }, select: { id: true, status: true } });
  },
};

const createdBusinessIds: string[] = [];
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = APP_SECRET;
  installFakeGraph();
});

afterAll(async () => {
  global.fetch = realFetch;
  process.env.META_APP_SECRET = previousSecret;
  for (const id of createdBusinessIds) {
    const members = await prisma.membership.findMany({ where: { businessId: id }, select: { userId: true } });
    await cleanupBusiness(id);
    for (const m of members) await prisma.user.delete({ where: { id: m.userId } }).catch(() => {});
  }
});

describe.each([
  ["Web Chat", webchatDriver, "1"],
  ["WhatsApp (Meta Cloud, fake transport)", metaDriver, "2"],
] as const)("§44.3 MVP acceptance — %s", (_channelName, driver, salt) => {
  let A: Biz;
  let B: Biz;
  const customerA = salt === "1" ? "alice" : "15551110001";
  const customerB = salt === "1" ? "bob" : "15552220002";
  const firstQuestion = "How long is the warranty?";

  beforeAll(async () => {
    A = await signupAndConfigure("acme", `KB-ACME-${salt}1`);
    B = await signupAndConfigure("bike", `KB-BIKE-${salt}2`);
    createdBusinessIds.push(A.businessId, B.businessId);
    await driver.configure(A);
    await driver.configure(B);
  });

  it("two independently-created businesses are distinct tenants with their own owner, placement, config and tool policies", async () => {
    expect(A.businessId).not.toBe(B.businessId);
    for (const biz of [A, B]) {
      const business = await prisma.business.findUniqueOrThrow({ where: { id: biz.businessId }, include: { placement: true, config: true, memberships: true, toolPolicies: true } });
      expect(business.slug).not.toBe("default");
      expect(business.placement?.databaseProfileId).toBe("shared-default");
      expect(business.config?.aiCredentialRef).toBeTruthy();
      expect(business.memberships.map((m) => m.role).sort()).toEqual(["agent", "owner"]);
      expect(business.toolPolicies).toHaveLength(6);
    }
  });

  it("a real customer message becomes a customer + conversation + persisted messages, and gets a reply grounded in THAT business's knowledge", async () => {
    await driver.send(A, customerA, firstQuestion);
    await driver.send(B, customerB, firstQuestion);

    for (const [biz, other, customer] of [[A, B, customerA], [B, A, customerB]] as const) {
      const conversation = await driver.conversationFor(biz, customer);
      expect(conversation).not.toBeNull();

      const stored = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation!.id }, include: { messages: { orderBy: { createdAt: "asc" } } } });
      expect(stored.businessId).toBe(biz.businessId);
      expect(stored.customerId).toBeTruthy();
      const customerRow = await prisma.customer.findUniqueOrThrow({ where: { id: stored.customerId! } });
      expect(customerRow.businessId).toBe(biz.businessId);
      expect(stored.messages.map((m) => m.role)).toEqual(["customer", "assistant"]);
      expect(stored.messages[0].content).toBe(firstQuestion);
      expect(stored.messages[1].content).toContain(biz.marker);
      expect(stored.messages[1].content).not.toContain(other.marker);

      // ...and the customer was actually shown that reply on the channel.
      const seen = await driver.seen(biz, customer);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain(biz.marker);
      expect(seen[0]).not.toContain(other.marker);

      const receipt = await prisma.inboundEventReceipt.findFirstOrThrow({ where: { businessId: biz.businessId, eventType: "message.received" } });
      expect(receipt.processingStatus).toBe("processed");
    }
  });

  it("each business's AI calls used only its own credential and only its own knowledge", async () => {
    for (const [biz, other] of [[A, B], [B, A]] as const) {
      const mine = openAICalls.filter((c) => c.apiKey === biz.aiKey);
      expect(mine.length).toBeGreaterThan(0);
      for (const c of mine) {
        expect(c.systemPrompt).not.toContain(other.marker);
      }
      expect(mine.some((c) => c.systemPrompt.includes(biz.marker))).toBe(true);
      const usage = await prisma.aIInteractionLog.count({ where: { businessId: biz.businessId, kind: "generation" } });
      expect(usage).toBeGreaterThan(0);
    }
    // No call ever mixed credentials and knowledge: a prompt carrying a
    // business's knowledge was only ever sent with that same business's key.
    for (const c of openAICalls) {
      if (c.systemPrompt.includes(A.marker)) expect(c.apiKey).toBe(A.aiKey);
      if (c.systemPrompt.includes(B.marker)) expect(c.apiKey).toBe(B.aiKey);
    }
  });

  it("the AI creates a real ticket via ToolPolicy-permitted create_ticket, and tells the customer", async () => {
    await driver.send(A, customerA, "Please open a ticket, my item arrived broken");

    const tickets = await prisma.ticket.findMany({ where: { businessId: A.businessId } });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ title: "Item arrived broken", priority: "high" });
    expect(await prisma.ticket.count({ where: { businessId: B.businessId } })).toBe(0);

    const action = await prisma.actionExecution.findFirstOrThrow({ where: { businessId: A.businessId, tool: "create_ticket" } });
    expect(action).toMatchObject({ status: "succeeded", requestedBy: "ai" });
    expect(action.conversationId).toBeTruthy();

    const seen = await driver.seen(A, customerA);
    expect(seen.at(-1)).toContain("opened a ticket");
    // Tools were offered to the AI only because this business's ToolPolicy allows them.
    expect(openAICalls.filter((c) => c.apiKey === A.aiKey).some((c) => c.tools.includes("create_ticket"))).toBe(true);
  });

  it("redelivery of the same inbound message is deduplicated end to end (no second AI turn, reply, or ticket)", async () => {
    const before = { calls: openAICalls.length, tickets: await prisma.ticket.count({ where: { businessId: B.businessId } }), seen: (await driver.seen(B, customerB)).length };
    if (driver === metaDriver) {
      const wamid = `wamid.${crypto.randomUUID()}`;
      const rawBody = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "w", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: B.channel.phoneNumberId },
        messages: [{ from: customerB, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Redelivered question about the warranty?" } }],
      } }] }] });
      const signature = `sha256=${crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
      const { POST } = await import("@/app/api/channels/whatsapp-cloud/webhook/route");
      for (let i = 0; i < 3; i++) {
        const response = await POST(new Request("https://ziyrak.example/x", { method: "POST", headers: { "x-hub-signature-256": signature }, body: rawBody }) as unknown as NextRequest);
        expect(response.status).toBe(200);
      }
      await drain();
    } else {
      const session = webchatSessions.get(`${B.businessId}:${customerB}`)!;
      const { POST } = await import("@/app/api/channels/webchat/[connectionId]/message/route");
      const clientMessageId = crypto.randomUUID();
      for (let i = 0; i < 3; i++) {
        const response = await POST(
          createRequest(`/api/channels/webchat/${B.channel.connectionId}/message`, {
            method: "POST",
            headers: { origin: ORIGIN, "x-forwarded-for": "203.0.113.9" },
            body: { token: B.channel.token, conversationId: session.conversationId, clientMessageId, customerContact: session.visitorId, text: "Redelivered question about the warranty?" },
          }),
          { params: Promise.resolve({ connectionId: B.channel.connectionId }) }
        );
        expect(response.status).toBe(200);
      }
      await drain();
    }
    expect((await driver.seen(B, customerB)).length).toBe(before.seen + 1); // exactly one new reply, not three
    expect(openAICalls.length).toBe(before.calls + 1);
    expect(await prisma.ticket.count({ where: { businessId: B.businessId } })).toBe(before.tickets);
  });

  it("escalates to a human, and the business's own agent sees it and takes over — the customer receives the human's reply", async () => {
    await driver.send(A, customerA, "I need to speak to a human about something you cannot help with");
    const conversation = await driver.conversationFor(A, customerA);
    expect(conversation!.status).toBe("escalated");

    // The agent (a role the owner invited — not the owner) finds it in the escalated queue.
    const list = await call("@/app/api/conversations/route", "GET", A.agentToken, "/api/conversations", undefined, undefined, { status: "escalated" });
    expect(list.status).toBe(200);
    const listed = (await parseJsonResponse(list)).data as { id: string }[];
    expect(listed.map((c) => c.id)).toContain(conversation!.id);

    // ...and takes over by replying from the dashboard.
    const reply = await call("@/app/api/conversations/[id]/messages/route", "POST", A.agentToken, `/api/conversations/${conversation!.id}/messages`, { content: "Hi, this is a human — I'll sort this out." }, { id: conversation!.id });
    expect(reply.status).toBe(201);
    const replyBody = await parseJsonResponse(reply);
    expect(replyBody.delivery.status).toBe(driver === webchatDriver ? "not_applicable" : "sent");

    // The customer actually receives the human's reply on their channel: Web
    // Chat through the persisted-message path, WhatsApp through Meta's API —
    // via *this* business's own number and access token.
    expect((await driver.seen(A, customerA)).at(-1)).toBe("Hi, this is a human — I'll sort this out.");
    if (driver === metaDriver) {
      const send = metaSends.filter((s) => s.text.startsWith("Hi, this is a human")).at(-1)!;
      expect(send).toMatchObject({ phoneNumberId: A.channel.phoneNumberId, token: A.channel.accessToken, to: customerA });
    }
    // The agent cannot reach the *other* business's escalated queue or conversations.
    const foreign = await call("@/app/api/conversations/[id]/messages/route", "POST", B.agentToken, `/api/conversations/${conversation!.id}/messages`, { content: "intruder" }, { id: conversation!.id });
    expect(foreign.status).toBe(404);
    const bList = await call("@/app/api/conversations/route", "GET", B.agentToken, "/api/conversations", undefined, undefined, { status: "escalated" });
    expect(((await parseJsonResponse(bList)).data as { id: string }[]).map((c) => c.id)).not.toContain(conversation!.id);
  });

  it("every step is attributed to the right business in the activity log", async () => {
    const owner = await call("@/app/api/activity/route", "GET", A.ownerToken, "/api/activity");
    expect(owner.status).toBe(200);
    const rows = (await parseJsonResponse(owner)).data as { action: string; businessId: string; userName: string; entityId: string | null }[];
    const actions = new Set(rows.map((r) => r.action));
    for (const expected of ["business.created", "channel.webchat.created", "channel.configured", "conversation.created", "tool.succeeded", "conversation.escalated"]) {
      if (expected === "channel.webchat.created" && driver !== webchatDriver) continue;
      if (expected === "channel.configured" && driver !== metaDriver) continue;
      if (expected === "message.sent") continue;
      expect(actions, `activity log for ${expected}`).toContain(expected);
    }
    expect(actions).toContain("message.sent");
    expect(rows.every((r) => r.businessId === A.businessId)).toBe(true);
    expect(rows.find((r) => r.action === "tool.succeeded")!.userName).toBe("AI Assistant");
    expect(rows.find((r) => r.action === "message.sent")!.userName).toBe("First Agent");

    // Business B's log holds none of A's activity (its own ticketless, escalation-free history only).
    const bRows = (await parseJsonResponse(await call("@/app/api/activity/route", "GET", B.ownerToken, "/api/activity"))).data as { businessId: string; action: string }[];
    expect(bRows.every((r) => r.businessId === B.businessId)).toBe(true);
    expect(bRows.map((r) => r.action)).not.toContain("tool.succeeded");
    expect(bRows.map((r) => r.action)).not.toContain("conversation.escalated");
  });

  it("outbound delivery never crosses businesses", async () => {
    if (driver !== metaDriver) return;
    for (const [biz, other] of [[A, B], [B, A]] as const) {
      const sends = metaSends.filter((s) => s.token === biz.channel.accessToken);
      expect(sends.length).toBeGreaterThan(0);
      for (const s of sends) {
        expect(s.phoneNumberId).toBe(biz.channel.phoneNumberId);
        expect(s.text).not.toContain(other.marker);
      }
      expect(metaSends.filter((s) => s.phoneNumberId === biz.channel.phoneNumberId).every((s) => s.token === biz.channel.accessToken)).toBe(true);
    }
  });

  it("isolation holds at every layer: API, guessed ids, database, and channel credentials", async () => {
    const conversation = await driver.conversationFor(A, customerA);
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { businessId: A.businessId } });

    // API: B's owner sees nothing of A's conversations/tickets/customers/knowledge and cannot fetch A's records by id.
    for (const [module, path] of [
      ["@/app/api/conversations/route", "/api/conversations"],
      ["@/app/api/tickets/route", "/api/tickets"],
      ["@/app/api/customers/route", "/api/customers"],
      ["@/app/api/knowledge/entries/route", "/api/knowledge/entries"],
    ] as const) {
      const response = await call(module, "GET", B.ownerToken, path);
      expect(response.status).toBe(200);
      const text = JSON.stringify(await parseJsonResponse(response));
      expect(text).not.toContain(conversation!.id);
      expect(text).not.toContain(ticket.id);
      expect(text).not.toContain(A.marker);
      expect(text).not.toContain(A.businessId);
    }
    expect((await call("@/app/api/conversations/[id]/route", "GET", B.ownerToken, `/api/conversations/${conversation!.id}`, undefined, { id: conversation!.id })).status).toBe(404);
    expect((await call("@/app/api/tickets/[id]/route", "GET", B.ownerToken, `/api/tickets/${ticket.id}`, undefined, { id: ticket.id })).status).toBe(404);
    expect((await call("@/app/api/conversations/[id]/messages/route", "GET", B.ownerToken, `/api/conversations/${conversation!.id}/messages`, undefined, { id: conversation!.id })).status).toBe(404);

    // Database: even skipping every application check, Postgres itself refuses a cross-tenant reference (§8.4 composite FK).
    await expect(
      prisma.message.create({ data: { businessId: B.businessId, conversationId: conversation!.id, role: "assistant", content: "cross-tenant write" } })
    ).rejects.toThrow();
    await expect(
      prisma.ticket.create({ data: { businessId: B.businessId, title: "x", description: "x", conversationId: conversation!.id } })
    ).rejects.toThrow();

    // Channel credentials: B's connection can't be used to reach A's data, and A's credential can't authenticate as B.
    if (driver === webchatDriver) {
      const session = webchatSessions.get(`${A.businessId}:${customerA}`)!;
      const { GET } = await import("@/app/api/channels/webchat/[connectionId]/messages/route");
      const crossPoll = await GET(
        createRequest(`/api/channels/webchat/${B.channel.connectionId}/messages`, { headers: { origin: ORIGIN }, searchParams: { token: B.channel.token!, conversationId: session.conversationId, visitorId: session.visitorId } }),
        { params: Promise.resolve({ connectionId: B.channel.connectionId }) }
      );
      expect(crossPoll.status).toBe(404);
      const swapped = await GET(
        createRequest(`/api/channels/webchat/${B.channel.connectionId}/messages`, { headers: { origin: ORIGIN }, searchParams: { token: A.channel.token!, conversationId: session.conversationId, visitorId: session.visitorId } }),
        { params: Promise.resolve({ connectionId: B.channel.connectionId }) }
      );
      expect(swapped.status).toBe(403);
    } else {
      const { metaCloudWhatsAppAdapter } = await import("@/lib/channels/meta-whatsapp-adapter");
      const rawBody = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "w", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: A.channel.phoneNumberId },
        messages: [{ from: "15559990000", id: `wamid.${crypto.randomUUID()}`, timestamp: "1700000000", type: "text", text: { body: "hi" } }],
      } }] }] });
      const signature = `sha256=${crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex")}`;
      const result = await metaCloudWhatsAppAdapter.validateInbound({ headers: { "x-hub-signature-256": signature }, rawBody });
      expect(result.kind === "new" && result.ctx.businessId).toBe(A.businessId); // A's number resolves to A, never B
    }

    // Row-level: every tenant-owned row that A's traffic produced is tagged A; none is tagged B.
    const aConversationIds = (await prisma.conversation.findMany({ where: { businessId: A.businessId }, select: { id: true } })).map((c) => c.id);
    expect(await prisma.message.count({ where: { conversationId: { in: aConversationIds }, businessId: { not: A.businessId } } })).toBe(0);
    expect(await prisma.actionExecution.count({ where: { businessId: B.businessId, tool: "create_ticket" } })).toBe(0);
    expect(await prisma.customer.count({ where: { businessId: B.businessId, id: { in: (await prisma.conversation.findMany({ where: { businessId: A.businessId }, select: { customerId: true } })).map((c) => c.customerId!).filter(Boolean) } } })).toBe(0);
  });
});
