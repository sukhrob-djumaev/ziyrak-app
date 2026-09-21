/**
 * Ziyrak Web Chat widget embed script (PLAN.md §20.4/§46.5/§46.7).
 * Widget script version: 1 (keep in sync with WIDGET_SCRIPT_VERSION in
 * src/lib/channels/webchat-embed.ts — the dashboard's copy-paste snippet
 * references this file as /widget.js?v=<that version>).
 *
 * Usage on a business's own site (the dashboard generates this exact snippet):
 *   <script src="https://<ziyrak-host>/widget.js?v=1"
 *           data-connection-id="<connectionId>"
 *           data-token="zy_pub_..."
 *           data-api-base="https://<ziyrak-host>" defer></script>
 *
 * Deliberately minimal: no build step, no framework, a handful of DOM
 * nodes. The token is a publishable credential by design (§20.4) — it is
 * expected to be visible in this script tag's own markup. It authenticates
 * only this widget's own message/stream endpoints and nothing else.
 */
(function () {
  var script = document.currentScript;
  if (!script) {
    console.error("[ZiyrakWidget] must be loaded via a plain <script> tag");
    return;
  }
  var connectionId = script.getAttribute("data-connection-id");
  var token = script.getAttribute("data-token");
  var apiBase = script.getAttribute("data-api-base") || "";

  if (!connectionId || !token) {
    console.error("[ZiyrakWidget] data-connection-id and data-token are required");
    return;
  }

  // A second embed of the same connection on one page would open two
  // streams and render two widgets on top of each other.
  var guardKey = "__ziyrakWidget_" + connectionId;
  if (window[guardKey]) return;
  window[guardKey] = true;

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
    '<input id="ziyrak-input" type="text" maxlength="4000" placeholder="Type a message..." style="flex:1;border:0;padding:10px;font-size:13px;outline:none;" />' +
    '<button type="submit" style="border:0;background:#0F172A;color:#fff;padding:0 14px;cursor:pointer;">Send</button>' +
    "</form>";
  document.body.appendChild(container);

  var log = container.querySelector("#ziyrak-log");
  var form = container.querySelector("#ziyrak-form");
  var input = container.querySelector("#ziyrak-input");

  function appendMessage(role, text) {
    var line = document.createElement("div");
    var style = "margin-bottom:8px;";
    if (role === "assistant") style += "color:#0F172A;";
    else if (role === "system") style += "color:#B91C1C;font-size:12px;";
    else style += "color:#334155;text-align:right;";
    line.style.cssText = style;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  // Misconfiguration (revoked/rotated token, origin not on the business's
  // allowlist, deactivated connection) must fail visibly to whoever is
  // testing the embed, not silently swallow every message.
  var unavailableShown = false;
  function showUnavailable() {
    if (unavailableShown) return;
    unavailableShown = true;
    appendMessage("system", "Chat is currently unavailable. Please try again later.");
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
        // Human-agent replies from the dashboard are stored/published with
        // the same "assistant" role as AI replies (conversations/service.ts's
        // addMessage), so a handed-off conversation keeps flowing here.
        if (payload.type === "message:new" && payload.data && payload.data.role === "assistant") {
          appendMessage("assistant", payload.data.content);
        }
      } catch {
        // ignore malformed/heartbeat frames
      }
    };
    source.onerror = function () {
      // EventSource retries transient drops on its own. A closed stream
      // (the server answered 403/404 — bad token, origin, or connection)
      // will not recover by itself.
      if (source.readyState === 2) showUnavailable();
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
    })
      .then(function (res) {
        if (res.status === 429) {
          appendMessage("system", "You're sending messages too quickly. Please wait a moment.");
        } else if (!res.ok) {
          showUnavailable();
        }
      })
      .catch(function (err) {
        console.error("[ZiyrakWidget] Failed to send message", err);
        showUnavailable();
      });
  });

  connectStream();
})();
