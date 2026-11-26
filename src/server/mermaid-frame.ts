/**
 * Isolated offline Mermaid sandbox frame assets (/_meru/mermaid-frame.html & /_meru/mermaid-frame.js).
 *
 * Security invariants:
 * 1. Served with HTTP `Content-Security-Policy: sandbox allow-scripts; ...` so even a top-level
 *    navigation (e.g. `window.open('/_meru/mermaid-frame.html')`) runs in an opaque `null` origin
 *    with zero access to cookies, localStorage, or same-origin APIs.
 * 2. Zero inline `<script>` tags; loads ONLY classic vendored `/_meru/vendor/mermaid.min.js`
 *    and `/_meru/mermaid-frame.js`.
 * 3. `mermaid.initialize({ securityLevel: "strict", suppressErrorRendering: true, maxTextSize: 50000 })`.
 * 4. Strictly verifies `ev.source === window.parent`, `channel === "meru-mermaid"`, and `frameId`.
 * 5. SVG stays strictly inside the sandboxed frame (never crosses back to the host document) and
 *    is mounted via `DOMParser` + `document.importNode` (zero `innerHTML` anywhere).
 */

export const MERMAID_FRAME_HTML_SOURCE = `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>Mermaid Diagram</title>
  <style>
    :root {
      color-scheme: light dark;
      --frame-fg: #14171f;
      --frame-font: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", sans-serif;
    }
    html[data-theme="dark"] {
      --frame-fg: #f1f5f9;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      color: var(--frame-fg);
      font-family: var(--frame-font);
      overflow: auto;
    }
    #mermaid-root {
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 14px 12px;
      min-width: 0;
      box-sizing: border-box;
    }
    #mermaid-root > svg {
      max-width: 100%;
      height: auto;
      display: block;
    }
    #mermaid-root a {
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="mermaid-root" role="img" aria-label="Mermaid diagram"></div>
  <script src="/_meru/vendor/mermaid.min.js"></script>
  <script src="/_meru/mermaid-frame.js"></script>
</body>
</html>
`;

export const MERMAID_FRAME_JS_SOURCE = `(function () {
  "use strict";

  var CHANNEL = "meru-mermaid";
  var FRAME_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
  var MAX_TEXT_SIZE = 50000;
  var FONT_STACK = '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", sans-serif';

  function resolveFrameId() {
    try {
      var sp = new URLSearchParams(window.location.search || "");
      var fromQuery = sp.get("id") || "";
      if (FRAME_ID_RE.test(fromQuery)) return fromQuery;
    } catch (_e) {}
    try {
      var fromName = String(window.name || "");
      if (FRAME_ID_RE.test(fromName)) return fromName;
    } catch (_e) {}
    return "";
  }

  var frameId = resolveFrameId();
  if (!frameId) return;

  var root = document.getElementById("mermaid-root");
  if (!root) return;

  var renderSeq = 0;
  var activeToken = 0;
  var lastReportedHeight = 0;

  function postToParent(payload) {
    if (!window.parent || window.parent === window) return;
    try {
      window.parent.postMessage(
        Object.assign({ channel: CHANNEL, frameId: frameId }, payload),
        "*"
      );
    } catch (_e) {}
  }

  function themeVariablesFor(theme) {
    if (theme === "dark") {
      return {
        darkMode: true,
        background: "transparent",
        fontFamily: FONT_STACK,
        fontSize: "13px",
        primaryColor: "#1e2430",
        primaryTextColor: "#f1f5f9",
        primaryBorderColor: "#64748b",
        secondaryColor: "#171b24",
        secondaryTextColor: "#e2e8f0",
        secondaryBorderColor: "#475569",
        tertiaryColor: "#11151d",
        tertiaryTextColor: "#e2e8f0",
        tertiaryBorderColor: "#334155",
        lineColor: "#94a3b8",
        textColor: "#f1f5f9",
        mainBkg: "#1e2430",
        nodeBorder: "#64748b",
        clusterBkg: "rgba(30, 36, 48, 0.58)",
        clusterBorder: "#475569",
        edgeLabelBackground: "#171b24",
        actorBkg: "#1e2430",
        actorBorder: "#64748b",
        actorTextColor: "#f1f5f9",
        signalColor: "#cbd5e1",
        signalTextColor: "#f1f5f9",
        labelBoxBkgColor: "#1e2430",
        labelTextColor: "#f1f5f9",
        noteBkgColor: "#2a2415",
        noteTextColor: "#fef3c7",
        noteBorderColor: "#d97706"
      };
    }
    return {
      darkMode: false,
      background: "transparent",
      fontFamily: FONT_STACK,
      fontSize: "13px",
      primaryColor: "#f5f7fa",
      primaryTextColor: "#14171f",
      primaryBorderColor: "#94a3b8",
      secondaryColor: "#edf2f7",
      secondaryTextColor: "#14171f",
      secondaryBorderColor: "#94a3b8",
      tertiaryColor: "#ffffff",
      tertiaryTextColor: "#14171f",
      tertiaryBorderColor: "#cbd5e1",
      lineColor: "#475569",
      textColor: "#14171f",
      mainBkg: "#ffffff",
      nodeBorder: "#94a3b8",
      clusterBkg: "rgba(234, 238, 244, 0.58)",
      clusterBorder: "#cbd5e1",
      edgeLabelBackground: "#ffffff",
      actorBkg: "#ffffff",
      actorBorder: "#64748b",
      actorTextColor: "#14171f",
      signalColor: "#334155",
      signalTextColor: "#14171f",
      labelBoxBkgColor: "#f5f7fa",
      labelTextColor: "#14171f",
      noteBkgColor: "#fefce8",
      noteTextColor: "#14171f",
      noteBorderColor: "#d4a72c"
    };
  }

  function applyTheme(theme) {
    var normalized = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = normalized;
    document.documentElement.style.colorScheme = normalized;
    return normalized;
  }

  function clearRoot() {
    while (root.firstChild) root.removeChild(root.firstChild);
  }

  function cleanupStrayMermaidNodes() {
    try {
      var children = Array.prototype.slice.call(document.body.children);
      for (var i = 0; i < children.length; i += 1) {
        var el = children[i];
        if (el !== root && el.tagName !== "SCRIPT") {
          el.remove();
        }
      }
    } catch (_e) {}
  }

  function measureHeight() {
    void root.offsetHeight;
    var svg = root.querySelector("svg");
    var rootH = root.getBoundingClientRect().height || 0;
    var svgH = svg ? (svg.getBoundingClientRect().height || 0) : 0;
    if (svgH > 0 || rootH > 0) {
      return Math.ceil(Math.max(rootH, svgH + 28));
    }
    var viewBoxH = 0;
    if (svg && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.height) {
      viewBoxH = svg.viewBox.baseVal.height + 28;
    }
    return Math.ceil(Math.max(root.scrollHeight || 0, viewBoxH));
  }

  function sanitizeImportedSvg(svgRoot) {
    var nodes = [svgRoot].concat(Array.prototype.slice.call(svgRoot.querySelectorAll("*")));
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (!el) continue;
      var tag = String(el.tagName || "").toLowerCase();
      if (el !== svgRoot && (tag === "script" || tag === "iframe" || tag === "object" || tag === "embed")) {
        el.remove();
        continue;
      }
      if (tag === "a") {
        el.style.pointerEvents = "none";
      }
      var attrs = Array.prototype.slice.call(el.attributes || []);
      for (var j = 0; j < attrs.length; j += 1) {
        var attrName = String(attrs[j].name || "").toLowerCase();
        var normalizedVal = String(attrs[j].value || "")
          .replace(/[\\u0000-\\u0020]+/g, "")
          .toLowerCase();
        if (attrName.indexOf("on") === 0) {
          el.removeAttribute(attrs[j].name);
          continue;
        }
        if (tag === "a" && (attrName === "href" || attrName === "xlink:href")) {
          el.removeAttribute(attrs[j].name);
          continue;
        }
        if (
          (attrName === "href" || attrName === "xlink:href" || attrName === "src") &&
          (normalizedVal.indexOf("javascript:") === 0 ||
            normalizedVal.indexOf("vbscript:") === 0 ||
            normalizedVal.indexOf("data:text/html") === 0)
        ) {
          el.removeAttribute(attrs[j].name);
          continue;
        }
        if (tag === "img" && attrName === "src" && normalizedVal.indexOf("data:image/") !== 0) {
          el.removeAttribute(attrs[j].name);
        }
      }
    }
  }

  function mountSvgString(svgMarkup) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(String(svgMarkup || ""), "text/html");
    var svgEl = doc.body ? doc.body.querySelector("svg") : null;
    if (!svgEl) {
      throw new Error("Mermaid produced empty SVG output");
    }
    sanitizeImportedSvg(svgEl);
    var imported = document.importNode(svgEl, true);
    clearRoot();
    root.appendChild(imported);
  }

  async function handleRender(source, theme) {
    var token = ++activeToken;
    var normalizedTheme = applyTheme(theme);
    var src = String(source || "");
    if (!src.trim()) {
      clearRoot();
      postToParent({ type: "error", message: "Empty Mermaid diagram" });
      return;
    }
    if (src.length > MAX_TEXT_SIZE) {
      clearRoot();
      postToParent({ type: "error", message: "Diagram exceeds 50,000-character limit" });
      return;
    }
    if (!window.mermaid || typeof window.mermaid.initialize !== "function" || typeof window.mermaid.render !== "function") {
      clearRoot();
      postToParent({ type: "error", message: "Offline Mermaid renderer unavailable" });
      return;
    }

    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        maxTextSize: MAX_TEXT_SIZE,
        theme: "base",
        themeVariables: themeVariablesFor(normalizedTheme)
      });
      var diagramId = "mmd-" + (++renderSeq);
      var out = await window.mermaid.render(diagramId, src);
      cleanupStrayMermaidNodes();
      if (token !== activeToken) return;
      mountSvgString(out && out.svg ? out.svg : "");
      setTimeout(function () {
        if (token !== activeToken) return;
        var h = measureHeight();
        lastReportedHeight = h;
        postToParent({ type: "rendered", height: h });
      }, 0);
    } catch (err) {
      cleanupStrayMermaidNodes();
      if (token !== activeToken) return;
      clearRoot();
      var rawMsg = (err && err.message) ? String(err.message) : "Invalid Mermaid syntax";
      var cleanMsg = rawMsg.replace(/\\s+/g, " ").trim().slice(0, 240);
      postToParent({ type: "error", message: cleanMsg || "Invalid Mermaid syntax" });
    }
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var data = ev.data;
    if (!data || typeof data !== "object") return;
    if (data.channel !== CHANNEL || data.frameId !== frameId) return;
    if (data.type === "render") {
      void handleRender(data.source, data.theme);
    }
  });

  if (typeof ResizeObserver === "function") {
    var ro = new ResizeObserver(function () {
      if (!root.querySelector("svg")) return;
      var nextH = measureHeight();
      if (nextH > 0 && Math.abs(nextH - lastReportedHeight) >= 4) {
        lastReportedHeight = nextH;
        postToParent({ type: "resize", height: nextH });
      }
    });
    ro.observe(root);
  }

  postToParent({ type: "ready" });
})();
`;
