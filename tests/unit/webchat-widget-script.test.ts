import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { WIDGET_SCRIPT_VERSION, buildWebChatEmbedSnippet } from "@/lib/channels/webchat-embed";

/**
 * PLAN.md §20.4/§46.7 — behavioral smoke test of the embeddable widget
 * script (`public/widget.js`) itself, run in a sandbox with a minimal fake
 * DOM (no browser is available in CI). It executes the exact file a business
 * embeds and drives its fetch/EventSource/timer boundaries.
 */

const SOURCE = fs.readFileSync(path.join(process.cwd(), "public", "widget.js"), "utf8");

interface FakeEl {
  style: { cssText: string };
  textContent: string;
  children: FakeEl[];
  value?: string;
  handlers: Record<string, (evt: { preventDefault(): void }) => void>;
  appendChild(child: FakeEl): void;
  addEventListener(name: string, fn: (evt: { preventDefault(): void }) => void): void;
  querySelector?: (selector: string) => FakeEl;
  scrollTop?: number;
  scrollHeight?: number;
  innerHTML?: string;
}

function el(): FakeEl {
  const element: FakeEl = {
    style: { cssText: "" },
    textContent: "",
    children: [],
    handlers: {},
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener(name, fn) {
      this.handlers[name] = fn;
    },
  };
  return element;
}

type FetchResult = { status: number; ok: boolean; json: () => Promise<unknown> };

function run(attrs: Record<string, string | undefined>, fetchQueue: FetchResult[] = [], times = 1) {
  const log = el();
  const form = el();
  const input = el();
  input.value = "";
  const container = el();
  container.querySelector = (selector: string) => ({ "#ziyrak-log": log, "#ziyrak-form": form, "#ziyrak-input": input })[selector]!;

  const fetchCalls: { url: string; init?: { method?: string; body?: string } }[] = [];
  const streams: { url: string; onmessage?: (e: { data: string }) => void; readyState: number }[] = [];
  const timers: (() => void)[] = [];
  const errors: unknown[] = [];
  const storage = new Map<string, string>();
  let uuidCounter = 0;
  let createdContainer = 0;

  const sandbox = {
    document: {
      currentScript: { getAttribute: (name: string) => attrs[name] ?? null },
      // First element the script creates is the widget container; every later one is a message line.
      createElement: () => (createdContainer++ === 0 ? container : el()),
      body: { appendChild() {} },
    },
    window: {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
      },
    } as Record<string, unknown>,
    crypto: { randomUUID: () => `uuid-${++uuidCounter}` },
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      fetchCalls.push({ url, init });
      const next = fetchQueue.shift() ?? { status: 200, ok: true, json: async () => ({ messages: [] }) };
      return Promise.resolve(next);
    },
    EventSource: function (this: unknown, url: string) {
      const stream = { url, readyState: 1 } as (typeof streams)[number];
      streams.push(stream);
      return stream;
    },
    setInterval: (fn: () => void) => void timers.push(fn),
    console: { error: (...args: unknown[]) => errors.push(args) },
    encodeURIComponent,
    JSON,
  };
  const context = vm.createContext(sandbox);
  for (let i = 0; i < times; i++) vm.runInContext(SOURCE, context);

  const tick = async () => {
    timers.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 0));
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const lines = () => log.children.map((c) => c.textContent);
  const send = async (text: string) => {
    input.value = text;
    form.handlers.submit({ preventDefault() {} });
    await flush();
  };

  return { lines, tick, flush, send, fetchCalls, streams, errors, timers, storage };
}

const ATTRS = { "data-connection-id": "conn-1", "data-token": "zy_pub_abc", "data-api-base": "https://ziyrak.example" };
const json = (body: unknown, status = 200): FetchResult => ({ status, ok: status < 400, json: async () => body });

describe("public/widget.js embed script (§20.4/§46.7)", () => {
  it("carries the same version the dashboard's embed snippet references", () => {
    expect(SOURCE).toContain(`Widget script version: ${WIDGET_SCRIPT_VERSION}`);
    const snippet = buildWebChatEmbedSnippet({ appBaseUrl: "https://ziyrak.example", connectionId: "conn-1", token: "zy_pub_abc" });
    expect(snippet).toContain(`https://ziyrak.example/widget.js?v=${WIDGET_SCRIPT_VERSION}`);
    expect(snippet).toContain('data-connection-id="conn-1"');
    expect(snippet).toContain('data-api-base="https://ziyrak.example"');
  });

  it("refuses to start without a connection id and token, and says so", () => {
    const w = run({});
    expect(w.errors.length).toBe(1);
    expect(w.fetchCalls).toHaveLength(0);
    expect(w.streams).toHaveLength(0);
  });

  it("generates and persists a conversation id and a separate visitor id, and never sends an admin credential", async () => {
    const w = run(ATTRS);
    await w.flush();
    const conversationId = w.storage.get("ziyrak_webchat_conversation_conn-1");
    const visitorId = w.storage.get("ziyrak_webchat_visitor_conn-1");
    expect(conversationId).toBeTruthy();
    expect(visitorId).toBeTruthy();
    expect(conversationId).not.toBe(visitorId);

    await w.send("hello");
    const post = w.fetchCalls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe("https://ziyrak.example/api/channels/webchat/conn-1/message");
    const body = JSON.parse(post.init!.body!);
    expect(body).toMatchObject({ token: "zy_pub_abc", conversationId, customerContact: visitorId, text: "hello" });
    expect(Object.keys(body).sort()).toEqual(["clientMessageId", "conversationId", "customerContact", "text", "token"]);
    expect(JSON.stringify(post)).not.toMatch(/zy_live_|authorization|cookie/i);
  });

  it("restores the conversation after a reload, then shows only new assistant messages", async () => {
    const w = run(ATTRS, [
      json({ messages: [{ id: "m1", role: "customer", content: "Where is my order?" }, { id: "m2", role: "assistant", content: "Shipping tomorrow." }] }),
      json({ messages: [{ id: "m2", role: "assistant", content: "Shipping tomorrow." }, { id: "m3", role: "assistant", content: "Anything else?" }] }),
    ]);
    await w.flush();
    expect(w.lines()).toEqual(["Where is my order?", "Shipping tomorrow."]);

    await w.tick();
    expect(w.lines()).toEqual(["Where is my order?", "Shipping tomorrow.", "Anything else?"]);
    expect(w.fetchCalls[1].url).toContain("after=m2");
    expect(w.fetchCalls[1].url).toContain("visitorId=");
  });

  it("does not echo the visitor's own message back after a first-time 404 poll", async () => {
    // Fetch order: initial poll (404, no conversation yet) → the POST of the visitor's send → a later poll
    // once the job has run and the conversation holds both sides.
    const w = run(ATTRS, [
      json({}, 404),
      json({ status: "new" }),
      json({ messages: [{ id: "c1", role: "customer", content: "Hi there" }, { id: "a1", role: "assistant", content: "Hello!" }] }),
    ]);
    await w.flush();
    await w.send("Hi there");
    expect(w.lines()).toEqual(["Hi there"]);

    await w.tick();
    expect(w.lines()).toEqual(["Hi there", "Hello!"]);
  });

  it("shows a reply once even when both the stream and polling deliver it", async () => {
    const w = run(ATTRS, [json({ messages: [] }), json({ messages: [{ id: "a1", role: "assistant", content: "Hello!" }] })]);
    await w.flush();
    w.streams[0].onmessage!({ data: JSON.stringify({ type: "message:new", data: { id: "a1", role: "assistant", content: "Hello!" } }) });
    await w.tick();
    expect(w.lines()).toEqual(["Hello!"]);
  });

  it("ignores non-assistant stream frames and malformed frames", async () => {
    const w = run(ATTRS);
    await w.flush();
    w.streams[0].onmessage!({ data: JSON.stringify({ type: "message:new", data: { id: "x", role: "customer", content: "not shown" } }) });
    w.streams[0].onmessage!({ data: "not json" });
    expect(w.lines()).toEqual([]);
  });

  it("fails visibly, once, when the server rejects the widget (bad token / origin / deactivated)", async () => {
    const w = run(ATTRS, [json({}, 403), json({}, 403)]);
    await w.flush();
    expect(w.lines()).toEqual(["Chat is currently unavailable. Please try again later."]);
    await w.tick();
    expect(w.lines()).toHaveLength(1);
  });

  it("does not attach twice for the same connection on one page", () => {
    const w = run(ATTRS, [], 2);
    expect(w.streams).toHaveLength(1);
    expect(w.timers).toHaveLength(1);
  });
});
