/**
 * Ziyrak Web Chat widget embed script (PLAN.md §20.4/§46.5).
 *
 * Usage on a business's own site:
 *   <script src="https://<ziyrak-host>/widget.js"
 *           data-connection-id="<connectionId>"
 *           data-token="zy_pub_..."
 *           data-api-base="https://<ziyrak-host>"></script>
 *
 * Deliberately minimal: no build step, no framework, a handful of DOM
 * nodes. The token is a publishable credential by design (§20.4) — it is
 * expected to be visible in this script tag's own markup.
 */
(function () {
  var script = document.currentScript;
  var connectionId = script.getAttribute("data-connection-id");
  var token = script.getAttribute("data-token");
  var apiBase = script.getAttribute("data-api-base") || "";

  if (!connectionId || !token) {
    console.error("[ZiyrakWidget] data-connection-id and data-token are required");
    return;
  }

  var storageKey = "ziyrak_webchat_conversation_" + connectionId;
  var conversationId = window.localStorage.getItem(storageKey);
  if (!conversationId) {
    conversationId = crypto.randomUUID();
    window.localStorage.setItem(storageKey, conversationId);
  }

  // Separate from conversationId and deliberately longer-lived: a visitor
  // may start a new conversation over time (e.g. this one gets resolved by
  // an agent), but resolveCustomer() (PLAN.md §5.3/§20.4's acceptance-audit
  // correction) needs one stable id per visitor to correlate those as the
  // same Customer, scoped to this businessId+connectionId by construction
  // (a different widget, or the same widget on a different site, gets a
  // different visitor id).
  var visitorStorageKey = "ziyrak_webchat_visitor_" + connectionId;
  var visitorId = window.localStorage.getItem(visitorStorageKey);
  if (!visitorId) {
    visitorId = crypto.randomUUID();
    window.localStorage.setItem(visitorStorageKey, visitorId);
  }

  var container = document.createElement("div");
  container.style.cssText =
    "position:fixed;bottom:16px;right:16px;width:320px;max-width:calc(100vw - 32px);" +
    "font-family:system-ui,sans-serif;z-index:999999;";
  container.innerHTML =
    '<div style="background:#0F172A;color:#fff;padding:10px 14px;border-radius:8px 8px 0 0;font-size:14px;">Chat with us</div>' +
    '<div id="ziyrak-log" style="background:#fff;border:1px solid #E2E8F0;height:280px;overflow-y:auto;padding:10px;font-size:13px;"></div>' +
    '<form id="ziyrak-form" style="display:flex;border:1px solid #E2E8F0;border-top:0;border-radius:0 0 8px 8px;overflow:hidden;">' +
    '<input id="ziyrak-input" type="text" placeholder="Type a message..." style="flex:1;border:0;padding:10px;font-size:13px;outline:none;" />' +
    '<button type="submit" style="border:0;background:#0F172A;color:#fff;padding:0 14px;cursor:pointer;">Send</button>' +
    "</form>";
  document.body.appendChild(container);

  var log = container.querySelector("#ziyrak-log");
  var form = container.querySelector("#ziyrak-form");
  var input = container.querySelector("#ziyrak-input");

  function appendMessage(role, text) {
    var line = document.createElement("div");
    line.style.cssText = "margin-bottom:8px;" + (role === "assistant" ? "color:#0F172A;" : "color:#334155;text-align:right;");
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function connectStream() {
    var url =
      apiBase +
      "/api/channels/webchat/" +
      encodeURIComponent(connectionId) +
      "/stream?token=" +
      encodeURIComponent(token) +
      "&conversationId=" +
      encodeURIComponent(conversationId);
    var source = new EventSource(url);
    source.onmessage = function (evt) {
      try {
        var payload = JSON.parse(evt.data);
        if (payload.type === "message:new" && payload.data && payload.data.role === "assistant") {
          appendMessage("assistant", payload.data.content);
        }
      } catch {
        // ignore malformed/heartbeat frames
      }
    };
    source.onerror = function () {
      // EventSource retries on its own; nothing to do here.
    };
  }

  form.addEventListener("submit", function (evt) {
    evt.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    appendMessage("customer", text);

    fetch(apiBase + "/api/channels/webchat/" + encodeURIComponent(connectionId) + "/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: token,
        conversationId: conversationId,
        clientMessageId: crypto.randomUUID(),
        customerContact: visitorId,
        text: text,
      }),
    }).catch(function (err) {
      console.error("[ZiyrakWidget] Failed to send message", err);
    });
  });

  connectStream();
})();
