// LOCAL STAND-IN for an OpenAI-compatible endpoint. NOT a real model.
// Used only because no live LLM credential exists in this environment
// (OPENAI_API_KEY in .env is a 22-char placeholder -> 401; no Anthropic key).
// It behaves like a model that ONLY knows what is in the request it receives:
//   - answers knowledge questions solely from `ZIYRAK-*-CODE-*` strings present in the prompt
//   - calls tools when the user's intent matches, using only info a model could have
//     (it is NOT told the conversation id, exactly like the real product's prompt)
//   - says "I'm not sure ... team member" when the prompt has no answer
// Every request is appended to llm-requests.jsonl so prompt contents can be inspected.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

fs.mkdirSync(path.dirname(path.join(process.env.ACC_WORK_DIR || path.join(__dirname, ".work"), "x")), { recursive: true });
const LOG = path.join(process.env.ACC_WORK_DIR || path.join(__dirname, ".work"), "llm-requests.jsonl");
const PORT = Number(process.env.LLM_PORT || 4010);

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}
function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(s);
}
function textCompletion(model, text) {
  return {
    id: "chatcmpl-" + crypto.randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}
function toolCompletion(model, name, args) {
  return {
    id: "chatcmpl-" + crypto.randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_" + crypto.randomUUID().slice(0, 12), type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

http
  .createServer(async (req, res) => {
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {}

    if (req.url.endsWith("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), kind: "embeddings", n: inputs.length, sample: String(inputs[0]).slice(0, 80) }) + "\n");
      return send(res, 200, {
        object: "list",
        model: body.model || "text-embedding-3-small",
        data: inputs.map((s, i) => ({
          object: "embedding",
          index: i,
          embedding: Array.from({ length: 32 }, (_, k) => (crypto.createHash("md5").update(String(s) + k).digest()[0] - 128) / 128),
        })),
        usage: { prompt_tokens: 5, total_tokens: 5 },
      });
    }

    if (req.url.endsWith("/chat/completions")) {
      const messages = body.messages || [];
      const model = body.model || "gpt-4o-mini";
      const system = (messages.find((m) => m.role === "system") || {}).content || "";
      const toolNames = (body.tools || []).map((t) => t.function && t.function.name);
      const last = messages[messages.length - 1] || {};
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const u = (lastUser && lastUser.content) || "";
      const codes = [...new Set(system.match(/ZIYRAK-[A-Z]-CODE-\d+/g) || [])];

      let decision;
      let out;
      if (last.role === "tool") {
        let r = {};
        try { r = JSON.parse(last.content); } catch {}
        decision = "tool-result-summary";
        out = textCompletion(model, r.success ? `All set. ${r.message || ""}`.trim() : `That did not work: ${r.message || "unknown error"}`);
      } else if (/(ticket|something is broken|not working|report a problem)/i.test(u) && toolNames.includes("create_ticket")) {
        decision = "tool:create_ticket";
        out = toolCompletion(model, "create_ticket", { title: "Customer issue: " + u.slice(0, 60), description: u, priority: "high" });
      } else if (/(follow.?up|remind me|check back)/i.test(u) && toolNames.includes("schedule_followup")) {
        const m = u.match(/in\s+(\d+)\s*(minute|min|hour|hr)/i);
        const n = m ? Number(m[1]) : 1;
        const hours = m && /^h/i.test(m[2]) ? n : n / 60;
        decision = "tool:schedule_followup";
        // A model has no way to know the conversation id (the prompt never contains it),
        // so it can only guess. This mirrors what a real model would do.
        // Fill only what the tool's schema REQUIRES (a model cannot know optional/unknowable ids).
        const def = (body.tools || []).find((t) => t.function && t.function.name === "schedule_followup").function;
        const required = (def.parameters && def.parameters.required) || [];
        const args = { message: "Following up as promised - is there anything else you need?", delayHours: hours };
        if (required.includes("conversationId")) args.conversationId = crypto.randomUUID();
        out = toolCompletion(model, "schedule_followup", args);
      } else if (/refund/i.test(u) && toolNames.includes("issue_refund")) {
        decision = "tool:issue_refund";
        out = toolCompletion(model, "issue_refund", { reason: u });
      } else if (/code|verification|reference/i.test(u)) {
        if (codes.length) {
          decision = "answer-from-prompt";
          out = textCompletion(model, `Our reference code is ${codes.join(" and ")}. Let me know if you need anything else about our service today.`);
        } else {
          decision = "no-knowledge";
          out = textCompletion(model, "I'm not sure about that. Let me connect you with a team member who can help.");
        }
      } else if (/(human|agent|person|manager|complain)/i.test(u)) {
        decision = "handoff-offer";
        out = textCompletion(model, "I'm not sure I can resolve that myself. Let me connect you with a team member.");
      } else {
        decision = "generic";
        out = textCompletion(model, "Hello! Thanks for reaching out. How can I help you today? I can answer questions about our service.");
      }

      fs.appendFileSync(
        LOG,
        JSON.stringify({ t: new Date().toISOString(), kind: "chat", model, decision, lastUser: u, toolNames, codesInPrompt: codes, systemPrompt: system, msgCount: messages.length }) + "\n"
      );
      return send(res, 200, out);
    }
    send(res, 404, { error: { message: "stand-in: unknown path " + req.url } });
  })
  .listen(PORT, "127.0.0.1", () => console.log("llm stand-in on " + PORT));
