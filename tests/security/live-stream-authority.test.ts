import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import crypto from "node:crypto";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
vi.mock("@/lib/identity/route-auth", async (original) => original());
const listeners = vi.hoisted(() => new Map<string, Set<(event: unknown) => void>>());
vi.mock("@/lib/realtime/realtime", async (original) => {
  const actual = await original<typeof import("@/lib/realtime/realtime")>();
  return {
    ...actual,
    subscribe: vi.fn((channel: string, callback: (event: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(callback);
      listeners.set(channel, set);
      const stop = actual.subscribe(channel, callback);
      return () => {
        set.delete(callback);
        stop();
      };
    }),
    tenantGlobalChannel: (id: string) => `tenant:${id}:global`,
    tenantConversationChannel: (id: string, conv: string) => `tenant:${id}:conversation:${conv}`,
  };
});
import { z } from "zod";
import { ToolRegistry } from "@/lib/tools/registry";
import { emitNotification } from "@/lib/realtime/realtime";
import * as projection from "@/lib/identity/stream-event-projection";
import * as conversations from "@/lib/conversations/service";
import * as scoped from "@/lib/tenancy/scoped-prisma";
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import { generateToken, revokeToken } from "@/lib/identity/auth";
import { encryptChannelCredential } from "@/lib/identity/channel-credential-auth";
import { GET as dashboardStream } from "@/app/api/realtime/route";
import { GET as widgetMessages } from "@/app/api/channels/webchat/[connectionId]/messages/route";
import { GET as widgetStream } from "@/app/api/channels/webchat/[connectionId]/stream/route";
let business: SeededBusiness, foreign: SeededBusiness;
const aborts: AbortController[] = [];
beforeAll(async () => {
  business = await seedBusiness("stream-authority");
  foreign = await seedBusiness("stream-foreign");
});
afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  listeners.clear();
  vi.useRealTimers();
  await prisma.business.update({ where: { id: business.businessId }, data: { status: "active" } });
});
afterAll(async () => {
  await cleanupBusiness(business.businessId);
  await cleanupBusiness(foreign.businessId);
});
function request(path: string, token?: string, key?: string) {
  const abort = new AbortController();
  aborts.push(abort);
  const req = new NextRequest(new URL(path, "http://localhost:3000"), {
    signal: abort.signal,
    headers: key ? { "x-api-key": key } : {},
  });
  if (token) {
    req.cookies.set("owly-token", token);
    req.cookies.set("ziyrak-workspace", business.businessId);
  }
  return req;
}
function publish(
  channel: string,
  type: string,
  conversationId?: string,
  data: Record<string, unknown> = {}
) {
  for (const callback of [...(listeners.get(channel) ?? [])])
    callback({ type, conversationId, data, timestamp: new Date().toISOString() });
}
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const value = await reader.read();
  return { done: value.done, text: new TextDecoder().decode(value.value) };
}
async function connection(tenant = business.businessId) {
  return prisma.channelConnection.create({
    data: { businessId: tenant, type: "webchat", name: "Stream fixture", isActive: true },
  });
}
async function conversation(
  conn: Awaited<ReturnType<typeof connection>>,
  visitor = crypto.randomUUID()
) {
  return prisma.conversation.create({
    data: {
      businessId: conn.businessId,
      channel: "webchat",
      customerContact: visitor,
      metadata: { channelConnectionId: conn.id },
    },
  });
}
async function member(ids?: string[]) {
  const user = await prisma.user.create({
    data: {
      username: "stream-" + crypto.randomUUID(),
      password: "synthetic-not-used",
      name: "Stream user",
    },
  });
  const membership = await prisma.membership.create({
    data: {
      businessId: business.businessId,
      userId: user.id,
      role: "supervisor",
      scopeMode: ids ? "connections" : "workspace",
      customerProfileAccess: "none",
    },
  });
  if (ids)
    await prisma.membershipConnectionScope.createMany({
      data: ids.map((connectionId) => ({
        businessId: business.businessId,
        membershipId: membership.id,
        connectionId,
      })),
    });
  return { user, membership, token: generateToken(user.id) };
}
async function open(token?: string, key?: string) {
  const response = await dashboardStream(request("/api/realtime", token, key));
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  expect((await frame(reader)).text).toContain("connected");
  return reader;
}
const global = () => `tenant:${business.businessId}:global`;
describe("fresh dashboard stream authority, real Postgres", () => {
  it("discards excluded connection frames while continuing visible hints", async () => {
    const a = await connection(),
      b = await connection();
    const ca = await conversation(a),
      cb = await conversation(b);
    const m = await member([a.id]);
    const reader = await open(m.token);
    publish(global(), "conversation:updated", cb.id, { privateBody: "hidden private text" });
    publish(global(), "conversation:updated", ca.id, { privateBody: "arbitrary bus payload" });
    const next = (await frame(reader)).text;
    expect(next).toContain(ca.id);
    expect(next).not.toContain(cb.id);
    expect(next).not.toContain("privateBody");
  });
  it("does not let later scope widening enlarge an existing stream", async () => {
    const a = await connection(),
      b = await connection();
    const ca = await conversation(a),
      cb = await conversation(b);
    const m = await member([a.id]);
    const reader = await open(m.token);
    await prisma.membership.update({
      where: { id: m.membership.id },
      data: { scopeMode: "workspace" },
    });
    publish(global(), "conversation:updated", cb.id);
    publish(global(), "conversation:updated", ca.id);
    expect((await frame(reader)).text).toContain(ca.id);
  });
  it("applies a narrowed current scope before the next event", async () => {
    const a = await connection(),
      b = await connection();
    const ca = await conversation(a),
      cb = await conversation(b);
    const m = await member([a.id, b.id]);
    const reader = await open(m.token);
    await prisma.membershipConnectionScope.deleteMany({
      where: { membershipId: m.membership.id, connectionId: b.id },
    });
    publish(global(), "conversation:updated", cb.id);
    publish(global(), "conversation:updated", ca.id);
    expect((await frame(reader)).text).toContain(ca.id);
  });
  it.each(["membership", "session"])("ends on %s revocation before emitting data", async (kind) => {
    const c = await conversation(await connection());
    const m = await member();
    const reader = await open(m.token);
    if (kind === "membership") await prisma.membership.delete({ where: { id: m.membership.id } });
    else await revokeToken(m.token);
    publish(global(), "conversation:updated", c.id, {
      privateBody: "must not reach signed-out person",
    });
    const next = await frame(reader);
    expect(next.text).not.toContain(c.id);
    expect(next.text).not.toContain("privateBody");
    expect(next.done || next.text.includes("session_ended")).toBe(true);
  });
  it("removes approval notifications after role downgrade and suppresses unbound kinds", async () => {
    const c = await conversation(await connection()),
      m = await member();
    const action = await prisma.actionExecution.create({
      data: {
        businessId: business.businessId,
        conversationId: c.id,
        tool: "create_ticket",
        input: {},
        requestedBy: "ai",
        status: "pending_approval",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    const reader = await open(m.token);
    await prisma.membership.update({ where: { id: m.membership.id }, data: { role: "agent" } });
    publish(global(), "notification", undefined, {
      kind: "action.pending_approval",
      actionExecutionId: action.id,
      tool: "private-tool",
    });
    publish(global(), "notification", undefined, { kind: "unknown-private", secret: "hidden" });
    publish(global(), "conversation:updated", c.id);
    expect((await frame(reader)).text).toContain(c.id);
  });
  it("rejects a foreign message ID attached to an authorized conversation", async () => {
    const c = await conversation(await connection());
    const other = await conversation(await connection(foreign.businessId));
    const msg = await prisma.message.create({
      data: {
        businessId: foreign.businessId,
        conversationId: other.id,
        role: "assistant",
        content: "Foreign private body",
      },
    });
    const m = await member(),
      reader = await open(m.token);
    publish(global(), "message:new", c.id, { id: msg.id, role: "assistant", content: msg.content });
    publish(global(), "conversation:updated", c.id);
    const next = (await frame(reader)).text;
    expect(next).toContain("conversation:updated");
    expect(next).not.toContain(msg.content);
  });
  it.each(["key", "issuer"])(
    "ends an open key stream on %s revocation at heartbeat",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const issuer = await member();
      await prisma.membership.update({
        where: { id: issuer.membership.id },
        data: { role: "admin" },
      });
      const value = "owly_key_" + crypto.randomUUID();
      const key = await prisma.apiKey.create({
        data: {
          businessId: business.businessId,
          name: "Synthetic stream key",
          keyPrefix: value.slice(0, 16),
          keyHash: crypto.createHash("sha256").update(value).digest("hex"),
          role: "viewer",
          scopeMode: "workspace",
          scopeOrigin: "issuer",
          issuedByUserId: issuer.user.id,
          customerProfileAccess: "none",
        },
      });
      const reader = await open(undefined, value);
      if (kind === "key")
        await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
      else await prisma.membership.delete({ where: { id: issuer.membership.id } });
      await vi.advanceTimersByTimeAsync(30_000);
      const next = await frame(reader);
      expect(next.done || next.text.includes("session_ended")).toBe(true);
    }
  );
  it("emits the actual registry pending-approval envelope with a saved resource", async () => {
    const c = await conversation(await connection()),
      m = await member(),
      reader = await open(m.token);
    await prisma.toolPolicy.upsert({
      where: { businessId_tool: { businessId: business.businessId, tool: "create_ticket" } },
      create: {
        businessId: business.businessId,
        tool: "create_ticket",
        enabledForTenant: true,
        allowedForAI: true,
        requiresHumanApproval: true,
        allowedForHumanRoles: ["owner"],
      },
      update: { requiresHumanApproval: true },
    });
    const registry = new ToolRegistry(),
      execute = vi.fn();
    registry.register({
      name: "create_ticket",
      description: "Controlled approval",
      schema: z.object({}),
      execute,
    });
    expect(
      (
        await registry.execute(
          {
            ...business.ctx,
            actor: { kind: "ai_agent", conversationId: c.id, model: "controlled" },
          },
          "create_ticket",
          {},
          { conversationId: c.id, toolCallId: crypto.randomUUID() }
        )
      ).status
    ).toBe("pending_approval");
    publish(global(), "conversation:updated", c.id);
    const next = (await frame(reader)).text;
    expect(next).toContain("action.pending_approval");
    expect(next).toContain("actionExecutionId");
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not emit a global cached approval hint after its conversation retires during projection", async () => {
    const c = await conversation(await connection()),
      sentinel = await conversation(await connection()),
      m = await member(),
      reader = await open(m.token);
    const action = await prisma.actionExecution.create({
      data: {
        businessId: business.businessId,
        conversationId: c.id,
        tool: "create_ticket",
        status: "pending_approval",
        input: {},
        requestedBy: "ai",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    const original = projection.projectDashboardEvent;
    const spy = vi
      .spyOn(projection, "projectDashboardEvent")
      .mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        entered();
        await hold;
        return result;
      });
    try {
      emitNotification(business.businessId, "action.pending_approval", {
        actionExecutionId: action.id,
      });
      await ready;
      await conversations.remove(business.ctx, c.id);
      release();
      publish(global(), "conversation:updated", sentinel.id);
      const next = (await frame(reader)).text;
      expect(next).toContain(sentinel.id);
      expect(next).not.toContain(action.id);
      expect(next).not.toContain("action.pending_approval");
    } finally {
      release();
      spy.mockRestore();
    }
  });
});
async function widgetFixture() {
  const token = "synthetic-widget-" + crypto.randomUUID(),
    origin = "https://widget-stream.example.invalid";
  const credentialRef = await encryptChannelCredential({ type: "webchat", widgetSecret: token });
  const conn = await prisma.channelConnection.create({
    data: {
      businessId: business.businessId,
      type: "webchat",
      name: "Widget stream",
      isActive: true,
      config: { allowedOrigins: [origin] },
      credentialRef,
    },
  });
  const c = await conversation(conn);
  return { conn, c, token, origin };
}
async function widget(
  f: Awaited<ReturnType<typeof widgetFixture>>,
  visitor = f.c.customerContact!
) {
  const req = request(
    `/api/channels/webchat/${f.conn.id}/stream?token=${encodeURIComponent(f.token)}&conversationId=${f.c.id}&visitorId=${encodeURIComponent(visitor)}`
  );
  req.headers.set("origin", f.origin);
  return widgetStream(req, { params: Promise.resolve({ connectionId: f.conn.id }) });
}
describe("widget stream visitor and lifecycle authority, real Postgres", () => {
  function poll(f: Awaited<ReturnType<typeof widgetFixture>>, after = "") {
    const req = request(
      `/api/channels/webchat/${f.conn.id}/messages?token=${encodeURIComponent(f.token)}&conversationId=${f.c.id}&visitorId=${encodeURIComponent(f.c.customerContact!)}&after=${after}`
    );
    req.headers.set("origin", f.origin);
    return widgetMessages(req, { params: Promise.resolve({ connectionId: f.conn.id }) });
  }
  it("polling does not expose a legacy body retired after the parent read", async () => {
    const f = await widgetFixture();
    await prisma.message.create({
      data: {
        businessId: business.businessId,
        conversationId: f.c.id,
        role: "assistant",
        content: "Unredacted retired legacy body",
      },
    });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const original = scoped.getScopedPrisma;
    const spy = vi.spyOn(scoped, "getScopedPrisma").mockImplementationOnce((ctx) => {
      const db = original(ctx);
      return new Proxy(db, {
        get(target, prop) {
          if (prop !== "conversation") return Reflect.get(target, prop);
          return new Proxy(target.conversation, {
            get(delegate, method) {
              if (method !== "findUnique") return Reflect.get(delegate, method);
              return async (...args: Parameters<typeof delegate.findUnique>) => {
                const row = await delegate.findUnique(...args);
                entered();
                await hold;
                return row;
              };
            },
          });
        },
      });
    });
    try {
      const pending = poll(f);
      await ready;
      await prisma.conversation.update({ where: { id: f.c.id }, data: { retiredAt: new Date() } });
      release();
      const response = await pending;
      expect(await response.text()).not.toContain("Unredacted retired legacy body");
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it("internal message IDs cannot act as public polling cursors", async () => {
    const f = await widgetFixture();
    const start = Date.now() - 10_000;
    const before = await prisma.message.create({
      data: {
        businessId: business.businessId,
        conversationId: f.c.id,
        role: "customer",
        content: "Public before",
        createdAt: new Date(start),
      },
    });
    const internal = await prisma.message.create({
      data: {
        businessId: business.businessId,
        conversationId: f.c.id,
        role: "system",
        content: "Private marker",
        createdAt: new Date(start + 1000),
      },
    });
    const after = await prisma.message.create({
      data: {
        businessId: business.businessId,
        conversationId: f.c.id,
        role: "assistant",
        content: "Public after",
        createdAt: new Date(start + 2000),
      },
    });
    const ignored = await (await poll(f, internal.id)).json();
    expect(ignored.messages.map((m: { id: string }) => m.id)).toEqual([before.id, after.id]);
    const valid = await (await poll(f, before.id)).json();
    expect(valid.messages.map((m: { id: string }) => m.id)).toEqual([after.id]);
  });
  it.each([
    ["stream", "wrong-channel"],
    ["poll", "wrong-channel"],
    ["stream", "retired"],
    ["poll", "retired"],
  ])("initial %s admission denies a %s conversation", async (route, condition) => {
    const f = await widgetFixture();
    await prisma.message.create({
      data: {
        businessId: business.businessId,
        conversationId: f.c.id,
        role: "assistant",
        content: "Synthetic private legacy body",
      },
    });
    await prisma.conversation.update({
      where: { id: f.c.id },
      data: condition === "retired" ? { retiredAt: new Date() } : { channel: "email" },
    });
    if (route === "stream") expect((await widget(f)).status).toBe(404);
    else {
      const req = request(
        `/api/channels/webchat/${f.conn.id}/messages?token=${encodeURIComponent(f.token)}&conversationId=${f.c.id}&visitorId=${encodeURIComponent(f.c.customerContact!)}`
      );
      req.headers.set("origin", f.origin);
      const response = await widgetMessages(req, {
        params: Promise.resolve({ connectionId: f.conn.id }),
      });
      expect(response.status).toBe(404);
    }
  });

  it("revocation during the second private projection prevents output", async () => {
    const f = await widgetFixture(),
      response = await widget(f),
      reader = response.body!.getReader();
    await frame(reader);
    const message = await prisma.message.create({
      data: {
        businessId: business.businessId,
        conversationId: f.c.id,
        role: "assistant",
        content: "Private second-projection body",
      },
    });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      hold = new Promise<void>((r) => {
        release = r;
      });
    const original = projection.projectWidgetEvent;
    let calls = 0;
    const spy = vi.spyOn(projection, "projectWidgetEvent").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++calls === 2) {
        entered();
        await hold;
      }
      return result;
    });
    try {
      publish(`tenant:${business.businessId}:conversation:${f.c.id}`, "message:new", f.c.id, {
        id: message.id,
      });
      await ready;
      await prisma.channelConnection.update({
        where: { id: f.conn.id },
        data: { isActive: false },
      });
      release();
      const result = await frame(reader);
      expect(result.text).not.toContain(message.content);
      expect(result.done || result.text.includes("session_ended")).toBe(true);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("refuses a different visitor with the same public widget token", async () => {
    const f = await widgetFixture();
    expect((await widget(f, "wrong-visitor")).status).toBe(404);
  });
  it.each(["inactive", "rotation", "origin", "retired", "workspace"])(
    "closes at heartbeat after %s",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const f = await widgetFixture();
      const response = await widget(f);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await frame(reader);
      if (kind === "workspace")
        await prisma.business.update({
          where: { id: business.businessId },
          data: { status: "suspended" },
        });
      if (kind === "inactive")
        await prisma.channelConnection.update({
          where: { id: f.conn.id },
          data: { isActive: false },
        });
      if (kind === "rotation")
        await prisma.channelConnection.update({
          where: { id: f.conn.id },
          data: {
            credentialRef: await encryptChannelCredential({
              type: "webchat",
              widgetSecret: "rotated-synthetic-token",
            }),
          },
        });
      if (kind === "origin")
        await prisma.channelConnection.update({
          where: { id: f.conn.id },
          data: { config: { allowedOrigins: [] } },
        });
      if (kind === "retired")
        await prisma.conversation.update({
          where: { id: f.c.id },
          data: { retiredAt: new Date() },
        });
      await vi.advanceTimersByTimeAsync(30_000);
      const next = await frame(reader);
      expect(next.done || next.text.includes("session_ended")).toBe(true);
    }
  );
  it("exposes only persisted public message projection, discarding forged/private frames", async () => {
    const f = await widgetFixture();
    const response = await widget(f);
    const reader = response.body!.getReader();
    await frame(reader);
    const message = await prisma.message.create({
      data: {
        businessId: business.businessId,
        conversationId: f.c.id,
        role: "assistant",
        content: "Persisted public reply",
        toolCalls: { private: "never publish" },
      },
    });
    const channel = `tenant:${business.businessId}:conversation:${f.c.id}`;
    publish(channel, "notification", f.c.id, { secret: "private notification" });
    publish(channel, "message:new", f.c.id, {
      id: message.id,
      role: "assistant",
      content: "Forged bus body",
      toolCalls: { secret: "private" },
    });
    const next = (await frame(reader)).text;
    expect(next).toContain(message.content);
    expect(next).not.toContain("notification");
    expect(next).not.toContain("Forged");
    expect(next).not.toContain("toolCalls");
  });
});
