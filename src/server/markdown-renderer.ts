/**
 * Lazy-loaded safe Markdown, Sandboxed Offline Mermaid & Static HTML Preview module (/_meru/markdown.js).
 *
 * Security invariants (zero innerHTML anywhere):
 * 1. Markdown is tokenized via pinned `marked.Lexer.lex()` (/_meru/vendor/marked.esm.js) and built
 *    exclusively with `document.createElement` + `textContent` / `createTextNode`.
 * 2. Raw `html` tokens are ALWAYS rendered as literal text (never parsed into live DOM).
 * 3. Image `src` allows ONLY safe raster `data:image/(png|jpeg|jpg|gif|webp);base64,...` or `blob:`;
 *    external or same-origin URLs (e.g. `/_meru/auth?code=...`) are blocked and rendered as alt text.
 * 4. Links allow ONLY `http:`, `https:`, and `mailto:` with `target="_blank" rel="noopener noreferrer"`.
 * 5. Documents > 256KB default to escaped plain text with an explicit "Render Markdown anyway" button.
 * 6. Mermaid diagrams (main reader only, when `enableMermaid: true`) render exclusively inside
 *    `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="/_meru/mermaid-frame.html?id=...">`
 *    served with HTTP `Content-Security-Policy: sandbox allow-scripts; ...` (opaque `null` origin).
 *    SVG never crosses back to the host document; host enforces 50,000-char & 20-diagram caps,
 *    lazy `IntersectionObserver` + serial render queue, 8s timeout, and source-first fallback.
 * 7. Static HTML preview uses `<iframe sandbox="" referrerpolicy="no-referrer">` with a mandatory
 *    inner `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`,
 *    defaults to escaped text (click-to-render), enforces a 1MB cap, and exposes teardown for redaction.
 */

export const MARKDOWN_JS_SOURCE = `// Meru Mind Safe Markdown, Sandboxed Offline Mermaid & Static HTML Preview Module (/_meru/markdown.js)
// Zero innerHTML. Token-driven DOM construction + sandboxed opaque-origin Mermaid & static HTML preview.
import { Lexer } from "/_meru/vendor/marked.esm.js";

export const MAX_AUTO_MARKDOWN_BYTES = 262_144; // 256 KB
export const MAX_HTML_PREVIEW_BYTES = 1_048_576; // 1 MB
export const MAX_MERMAID_CHARS = 50_000;
export const MAX_MERMAID_DIAGRAMS = 20;
const MERMAID_RENDER_TIMEOUT_MS = 8_000;
const MERMAID_MIN_HEIGHT = 80;
const MERMAID_MAX_HEIGHT = 1400;
const MERMAID_CHANNEL = "meru-mermaid";
const SVG_NS = "http://www.w3.org/2000/svg";

let globalMermaidSeq = 0;

const SAFE_HTML_META_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

const SAFE_DATA_IMAGE_RE = /^data:image\\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\\s]+$/i;

export function isSafeLinkHref(rawHref) {
  if (typeof rawHref !== "string") return false;
  const trimmed = rawHref.trim();
  if (!trimmed) return false;
  // Reject protocol-relative and same-origin relative URLs to prevent credential/auth-code triggers
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
}

export function isSafeImageSrc(rawSrc) {
  if (typeof rawSrc !== "string") return false;
  const trimmed = rawSrc.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("blob:")) return true;
  return SAFE_DATA_IMAGE_RE.test(trimmed);
}

function makeLinearIcon(elements, size = 14) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const item of elements) {
    if (typeof item === "string") {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", item);
      svg.appendChild(p);
    } else if (item && item.tag) {
      const el = document.createElementNS(SVG_NS, item.tag);
      for (const [k, v] of Object.entries(item.attrs || {})) {
        el.setAttribute(k, String(v));
      }
      svg.appendChild(el);
    }
  }
  return svg;
}

const MM_ICONS = {
  diagram: () => makeLinearIcon([
    { tag: "rect", attrs: { x: 3, y: 4, width: 7, height: 5, rx: 1.2 } },
    { tag: "rect", attrs: { x: 14, y: 15, width: 7, height: 5, rx: 1.2 } },
    { tag: "rect", attrs: { x: 3, y: 15, width: 7, height: 5, rx: 1.2 } },
    "M6.5 9v6",
    "M6.5 12h11v3",
  ]),
  source: () => makeLinearIcon(["M16 18l6-6-6-6", "M8 6l-6 6 6 6"]),
  expand: () => makeLinearIcon(["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"]),
  fit: () => makeLinearIcon(["M4 14h6v6", "M20 10h-6V4", "M14 10l7-7", "M3 21l7-7"]),
  copy: () => makeLinearIcon([
    "M8 8h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z",
    "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3",
  ]),
  check: () => makeLinearIcon(["M5 12.5l4.2 4.2L19 7"]),
};

function clampMermaidHeight(raw) {
  const n = Math.ceil(Number(raw) || 240);
  return Math.max(MERMAID_MIN_HEIGHT, Math.min(MERMAID_MAX_HEIGHT, n));
}

function createMermaidController(opts) {
  const labels = opts && typeof opts === "object" ? opts : {};
  const entries = new Map();
  const queue = [];
  let count = 0;
  let expandedCount = 0;
  let inFlight = null;
  let tornDown = false;
  let currentTheme = labels.theme === "dark" ? "dark" : "light";

  function dispatchExpandChange(targetEl) {
    if (!targetEl) return;
    try {
      targetEl.dispatchEvent(new CustomEvent("meru-mermaid-expand-change", {
        bubbles: true,
        composed: true,
        detail: { expandedCount },
      }));
    } catch {}
  }

  function finishInFlight(entry) {
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
      entry.timeoutId = null;
    }
    if (inFlight === entry) {
      inFlight = null;
      pumpQueue();
    }
  }

  function destroyEntryFrame(entry) {
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
      entry.timeoutId = null;
    }
    if (entry.frame) {
      try { entry.frame.src = "about:blank"; } catch {}
      entry.frame.remove();
      entry.frame = null;
    }
    entry.ready = false;
    entry.rendered = false;
    if (entry.stage) {
      entry.stage.classList.remove("is-visible");
      entry.stage.classList.add("is-pending");
      entry.stage.style.height = "";
    }
  }

  function failEntry(entry, message) {
    if (tornDown) return;
    entry.failed = true;
    destroyEntryFrame(entry);
    entry.setView("source", false);
    entry.diagramBtn.disabled = true;
    entry.expandBtn.disabled = true;
    if (entry.expanded) {
      entry.expanded = false;
      entry.block.classList.remove("expanded");
      expandedCount = Math.max(0, expandedCount - 1);
      dispatchExpandChange(entry.block);
    }
    entry.setHint(message);
    finishInFlight(entry);
  }

  function pumpQueue() {
    if (tornDown || inFlight) return;
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || next.failed || next.started || !next.frame) continue;
      next.started = true;
      inFlight = next;
      next.timeoutId = setTimeout(() => {
        if (!tornDown && !next.rendered && !next.failed) {
          failEntry(
            next,
            labels.mermaidTimeout || "Mermaid render timed out — showing source.",
          );
        }
      }, MERMAID_RENDER_TIMEOUT_MS);
      next.frame.src = "/_meru/mermaid-frame.html?id=" + encodeURIComponent(next.frameId);
      return;
    }
  }

  function enqueue(entry) {
    if (tornDown || entry.queued || entry.failed) return;
    entry.queued = true;
    queue.push(entry);
    pumpQueue();
  }

  function onMessage(ev) {
    if (tornDown) return;
    if (ev.origin !== "null") return;
    const data = ev.data;
    if (!data || typeof data !== "object" || data.channel !== MERMAID_CHANNEL) return;
    if (typeof data.frameId !== "string") return;
    const entry = entries.get(data.frameId);
    if (!entry || !entry.frame || ev.source !== entry.frame.contentWindow) return;

    if (data.type === "ready") {
      entry.ready = true;
      try {
        entry.frame.contentWindow.postMessage(
          {
            channel: MERMAID_CHANNEL,
            type: "render",
            frameId: entry.frameId,
            source: entry.source,
            theme: currentTheme,
          },
          "*",
        );
      } catch {
        failEntry(entry, (labels.mermaidRenderFailed || "Mermaid render failed — showing source."));
      }
      return;
    }

    if (data.type === "rendered") {
      const h = clampMermaidHeight(data.height);
      entry.rendered = true;
      entry.stage.style.height = h + "px";
      entry.frame.style.height = h + "px";
      entry.block.classList.add("is-ready");
      entry.diagramBtn.disabled = false;
      entry.expandBtn.disabled = false;
      entry.setHint("");
      if (!entry.userForcedSource) {
        entry.setView("diagram", false);
      }
      finishInFlight(entry);
      return;
    }

    if (data.type === "resize" && entry.rendered && entry.frame) {
      const h = clampMermaidHeight(data.height);
      entry.stage.style.height = h + "px";
      entry.frame.style.height = h + "px";
      return;
    }

    if (data.type === "error") {
      const detail = typeof data.message === "string" ? data.message.trim().slice(0, 240) : "";
      const prefix = labels.mermaidRenderFailed || "Mermaid syntax error — showing source: ";
      failEntry(entry, detail ? (prefix + detail) : prefix.replace(/[:：]\\s*$/, ""));
    }
  }

  window.addEventListener("message", onMessage);

  const observer = typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (ioEntries) => {
          if (tornDown) return;
          for (const ioEntry of ioEntries) {
            if (!ioEntry.isIntersecting) continue;
            const fid = ioEntry.target?.dataset?.mermaidFrameId;
            if (!fid) continue;
            const entry = entries.get(fid);
            if (entry) {
              observer.unobserve(ioEntry.target);
              enqueue(entry);
            }
          }
        },
        { rootMargin: "240px" },
      )
    : null;

  function buildMermaidBlock(source) {
    const src = String(source ?? "");
    const block = document.createElement("div");
    block.className = "md-code-block md-mermaid-block";
    block.dataset.ui = "mermaid-block";

    const header = document.createElement("div");
    header.className = "md-mermaid-header";

    const headerLeft = document.createElement("div");
    headerLeft.className = "md-mermaid-header-left";
    const langTag = document.createElement("span");
    langTag.className = "md-mermaid-lang";
    langTag.textContent = "mermaid";
    const hintEl = document.createElement("span");
    hintEl.className = "md-mermaid-hint";
    hintEl.dataset.ui = "mermaid-hint";
    headerLeft.appendChild(langTag);
    headerLeft.appendChild(hintEl);

    const actions = document.createElement("div");
    actions.className = "md-mermaid-actions";

    const seg = document.createElement("div");
    seg.className = "md-mermaid-seg";
    seg.setAttribute("role", "group");

    const diagramBtn = document.createElement("button");
    diagramBtn.type = "button";
    diagramBtn.className = "md-mm-btn";
    diagramBtn.dataset.ui = "mermaid-view-diagram";
    diagramBtn.title = labels.mermaidDiagramView || "Diagram";
    diagramBtn.setAttribute("aria-label", diagramBtn.title);
    diagramBtn.setAttribute("aria-pressed", "false");
    diagramBtn.disabled = true;
    diagramBtn.appendChild(MM_ICONS.diagram());

    const sourceBtn = document.createElement("button");
    sourceBtn.type = "button";
    sourceBtn.className = "md-mm-btn active";
    sourceBtn.dataset.ui = "mermaid-view-source";
    sourceBtn.title = labels.mermaidSourceView || "Source";
    sourceBtn.setAttribute("aria-label", sourceBtn.title);
    sourceBtn.setAttribute("aria-pressed", "true");
    sourceBtn.appendChild(MM_ICONS.source());

    seg.appendChild(diagramBtn);
    seg.appendChild(sourceBtn);
    actions.appendChild(seg);

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "md-mm-btn";
    expandBtn.dataset.ui = "mermaid-toggle-expand";
    expandBtn.title = labels.mermaidExpand || "Expand diagram";
    expandBtn.setAttribute("aria-label", expandBtn.title);
    expandBtn.setAttribute("aria-pressed", "false");
    expandBtn.disabled = true;
    expandBtn.appendChild(MM_ICONS.expand());
    actions.appendChild(expandBtn);

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "md-mm-btn";
    copyBtn.dataset.ui = "mermaid-copy-source";
    copyBtn.title = labels.mermaidCopy || "Copy source";
    copyBtn.setAttribute("aria-label", copyBtn.title);
    copyBtn.appendChild(MM_ICONS.copy());
    let copyResetTimer = null;
    copyBtn.addEventListener("click", async () => {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(src);
        }
        copyBtn.dataset.copied = "true";
        while (copyBtn.firstChild) copyBtn.removeChild(copyBtn.firstChild);
        copyBtn.appendChild(MM_ICONS.check());
        copyBtn.title = labels.mermaidCopied || "Copied";
        if (copyResetTimer) clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => {
          copyBtn.dataset.copied = "";
          while (copyBtn.firstChild) copyBtn.removeChild(copyBtn.firstChild);
          copyBtn.appendChild(MM_ICONS.copy());
          copyBtn.title = labels.mermaidCopy || "Copy source";
        }, 1500);
      } catch {}
    });
    actions.appendChild(copyBtn);

    header.appendChild(headerLeft);
    header.appendChild(actions);
    block.appendChild(header);

    const body = document.createElement("div");
    body.className = "md-mermaid-body";

    const pre = document.createElement("pre");
    pre.className = "md-mermaid-source";
    const code = document.createElement("code");
    code.textContent = src;
    pre.appendChild(code);
    body.appendChild(pre);
    block.appendChild(body);

    const setHint = (msg) => {
      hintEl.textContent = msg ? String(msg) : "";
      hintEl.classList.toggle("visible", Boolean(msg));
    };

    if (src.length > MAX_MERMAID_CHARS) {
      setHint(labels.mermaidTooLarge || "Diagram exceeds 50,000-character limit; showing source.");
      return block;
    }

    if (count >= MAX_MERMAID_DIAGRAMS) {
      setHint(labels.mermaidTooMany || "Exceeded 20-diagram limit per document; showing source.");
      return block;
    }

    count += 1;
    const frameId = "mm_" + (++globalMermaidSeq) + "_" + Math.random().toString(36).slice(2, 8);
    block.dataset.mermaidFrameId = frameId;

    const stage = document.createElement("div");
    stage.className = "md-mermaid-stage is-pending";
    stage.dataset.ui = "mermaid-stage";

    const frame = document.createElement("iframe");
    frame.className = "md-mermaid-frame";
    frame.dataset.ui = "mermaid-frame";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = "Mermaid diagram";
    stage.appendChild(frame);
    body.appendChild(stage);

    const entry = {
      frameId,
      source: src,
      block,
      stage,
      frame,
      pre,
      diagramBtn,
      sourceBtn,
      expandBtn,
      setHint,
      queued: false,
      started: false,
      ready: false,
      rendered: false,
      failed: false,
      expanded: false,
      userForcedSource: false,
      timeoutId: null,
      setView(mode, byUser) {
        const showDiagram = mode === "diagram" && entry.rendered && !entry.failed;
        if (byUser) {
          entry.userForcedSource = !showDiagram;
        }
        pre.hidden = showDiagram;
        stage.classList.toggle("is-visible", showDiagram);
        stage.classList.toggle("is-pending", !showDiagram);
        diagramBtn.classList.toggle("active", showDiagram);
        diagramBtn.setAttribute("aria-pressed", String(showDiagram));
        sourceBtn.classList.toggle("active", !showDiagram);
        sourceBtn.setAttribute("aria-pressed", String(!showDiagram));
      },
    };

    diagramBtn.addEventListener("click", () => {
      if (!entry.rendered || entry.failed) return;
      entry.setView("diagram", true);
    });
    sourceBtn.addEventListener("click", () => {
      entry.setView("source", true);
    });
    expandBtn.addEventListener("click", () => {
      if (!entry.rendered || entry.failed) return;
      entry.expanded = !entry.expanded;
      block.classList.toggle("expanded", entry.expanded);
      expandBtn.classList.toggle("active", entry.expanded);
      expandBtn.setAttribute("aria-pressed", String(entry.expanded));
      while (expandBtn.firstChild) expandBtn.removeChild(expandBtn.firstChild);
      expandBtn.appendChild(entry.expanded ? MM_ICONS.fit() : MM_ICONS.expand());
      expandBtn.title = entry.expanded
        ? (labels.mermaidFit || "Fit to column")
        : (labels.mermaidExpand || "Expand diagram");
      expandBtn.setAttribute("aria-label", expandBtn.title);
      expandedCount = Math.max(0, expandedCount + (entry.expanded ? 1 : -1));
      dispatchExpandChange(block);
    });

    entries.set(frameId, entry);
    if (observer) {
      observer.observe(block);
    } else {
      enqueue(entry);
    }

    return block;
  }

  function setTheme(nextTheme) {
    if (tornDown) return;
    const normalized = nextTheme === "dark" ? "dark" : "light";
    if (normalized === currentTheme) return;
    currentTheme = normalized;
    for (const entry of entries.values()) {
      if (entry.ready && entry.frame && entry.frame.contentWindow && !entry.failed) {
        try {
          entry.frame.contentWindow.postMessage(
            {
              channel: MERMAID_CHANNEL,
              type: "render",
              frameId: entry.frameId,
              source: entry.source,
              theme: currentTheme,
            },
            "*",
          );
        } catch {}
      }
    }
  }

  function teardown() {
    if (tornDown) return;
    tornDown = true;
    window.removeEventListener("message", onMessage);
    if (observer) {
      try { observer.disconnect(); } catch {}
    }
    queue.length = 0;
    inFlight = null;
    for (const entry of entries.values()) {
      destroyEntryFrame(entry);
    }
    entries.clear();
  }

  return { buildMermaidBlock, setTheme, teardown };
}

function appendInlineTokens(parent, tokens, fallbackText) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    if (fallbackText) parent.appendChild(document.createTextNode(String(fallbackText)));
    return;
  }
  for (const tok of tokens) {
    if (!tok) continue;
    switch (tok.type) {
      case "text": {
        if (Array.isArray(tok.tokens) && tok.tokens.length > 0) {
          appendInlineTokens(parent, tok.tokens, tok.text);
        } else {
          parent.appendChild(document.createTextNode(String(tok.text ?? "")));
        }
        break;
      }
      case "escape": {
        parent.appendChild(document.createTextNode(String(tok.text ?? "")));
        break;
      }
      case "html": {
        // Security invariant: raw HTML inside Markdown is ALWAYS literal text
        parent.appendChild(document.createTextNode(String(tok.raw ?? tok.text ?? "")));
        break;
      }
      case "strong": {
        const el = document.createElement("strong");
        appendInlineTokens(el, tok.tokens, tok.text);
        parent.appendChild(el);
        break;
      }
      case "em": {
        const el = document.createElement("em");
        appendInlineTokens(el, tok.tokens, tok.text);
        parent.appendChild(el);
        break;
      }
      case "del": {
        const el = document.createElement("del");
        appendInlineTokens(el, tok.tokens, tok.text);
        parent.appendChild(el);
        break;
      }
      case "codespan": {
        const el = document.createElement("code");
        el.className = "md-inline-code";
        el.textContent = String(tok.text ?? "");
        parent.appendChild(el);
        break;
      }
      case "br": {
        parent.appendChild(document.createElement("br"));
        break;
      }
      case "link": {
        let href = String(tok.href ?? "");
        let trailingAutolink = "";
        if (tok.raw === href && tok.text === href) {
          const cjkIdx = href.search(/[\\u3000-\\u303f\\uff00-\\uffef\\p{Script=Han}]/u);
          if (cjkIdx > 0) {
            trailingAutolink = href.slice(cjkIdx);
            href = href.slice(0, cjkIdx);
          }
        }
        if (isSafeLinkHref(href)) {
          const a = document.createElement("a");
          a.href = href.trim();
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          if (tok.title) a.title = String(tok.title);
          if (trailingAutolink) {
            a.textContent = href;
          } else {
            appendInlineTokens(a, tok.tokens, tok.text || href);
          }
          parent.appendChild(a);
        } else {
          const span = document.createElement("span");
          span.className = "md-blocked-link";
          appendInlineTokens(span, tok.tokens, tok.text || href || "");
          parent.appendChild(span);
        }
        if (trailingAutolink) {
          parent.appendChild(document.createTextNode(trailingAutolink));
        }
        break;
      }
      case "image": {
        if (isSafeImageSrc(tok.href)) {
          const img = document.createElement("img");
          img.src = String(tok.href).trim();
          img.alt = String(tok.text ?? "");
          img.loading = "lazy";
          img.referrerPolicy = "no-referrer";
          parent.appendChild(img);
        } else {
          const span = document.createElement("span");
          span.className = "md-blocked-img";
          span.textContent = "[image: " + String(tok.text || tok.href || "blocked") + "]";
          parent.appendChild(span);
        }
        break;
      }
      default: {
        parent.appendChild(document.createTextNode(String(tok.raw ?? tok.text ?? "")));
      }
    }
  }
}

function appendBlockTokens(parent, tokens, mermaidCtrl = null) {
  if (!Array.isArray(tokens)) return;
  for (const tok of tokens) {
    if (!tok || tok.type === "space") continue;
    switch (tok.type) {
      case "heading": {
        const depth = Math.min(6, Math.max(1, Number(tok.depth) || 1));
        const h = document.createElement("h" + depth);
        appendInlineTokens(h, tok.tokens, tok.text);
        parent.appendChild(h);
        break;
      }
      case "paragraph": {
        const p = document.createElement("p");
        appendInlineTokens(p, tok.tokens, tok.text);
        parent.appendChild(p);
        break;
      }
      case "text": {
        const p = document.createElement("p");
        if (Array.isArray(tok.tokens) && tok.tokens.length > 0) {
          appendInlineTokens(p, tok.tokens, tok.text);
        } else {
          p.textContent = String(tok.text ?? "");
        }
        parent.appendChild(p);
        break;
      }
      case "blockquote": {
        const bq = document.createElement("blockquote");
        appendBlockTokens(bq, tok.tokens, mermaidCtrl);
        parent.appendChild(bq);
        break;
      }
      case "list": {
        const list = document.createElement(tok.ordered ? "ol" : "ul");
        if (tok.ordered && tok.start && tok.start !== 1) {
          list.start = Number(tok.start);
        }
        for (const item of tok.items || []) {
          const li = document.createElement("li");
          if (item.task) {
            li.className = "md-task-item";
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.disabled = true;
            cb.checked = Boolean(item.checked);
            li.appendChild(cb);
          }
          if (Array.isArray(item.tokens) && item.tokens.length > 0) {
            const simpleTextOnly = item.tokens.every(
              (t) => t.type === "text" || t.type === "space",
            );
            if (simpleTextOnly) {
              for (const t of item.tokens) {
                if (t.type === "text") appendInlineTokens(li, t.tokens, t.text);
              }
            } else {
              appendBlockTokens(li, item.tokens, mermaidCtrl);
            }
          } else {
            li.appendChild(document.createTextNode(String(item.text ?? "")));
          }
          list.appendChild(li);
        }
        parent.appendChild(list);
        break;
      }
      case "code": {
        const langStr = String(tok.lang ?? "").trim();
        if (mermaidCtrl && /^mermaid$/i.test(langStr)) {
          parent.appendChild(mermaidCtrl.buildMermaidBlock(String(tok.text ?? "")));
          break;
        }
        const wrap = document.createElement("div");
        wrap.className = "md-code-block";
        if (langStr) {
          const lang = document.createElement("div");
          lang.className = "md-code-lang";
          lang.textContent = langStr;
          wrap.appendChild(lang);
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = String(tok.text ?? "");
        pre.appendChild(code);
        wrap.appendChild(pre);
        parent.appendChild(wrap);
        break;
      }
      case "table": {
        const wrap = document.createElement("div");
        wrap.className = "md-table-wrap";
        const table = document.createElement("table");
        const thead = document.createElement("thead");
        const headTr = document.createElement("tr");
        const aligns = Array.isArray(tok.align) ? tok.align : [];
        (tok.header || []).forEach((cell, idx) => {
          const th = document.createElement("th");
          if (aligns[idx]) th.style.textAlign = aligns[idx];
          appendInlineTokens(th, cell.tokens, cell.text);
          headTr.appendChild(th);
        });
        thead.appendChild(headTr);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        for (const row of tok.rows || []) {
          const tr = document.createElement("tr");
          (row || []).forEach((cell, idx) => {
            const td = document.createElement("td");
            if (aligns[idx]) td.style.textAlign = aligns[idx];
            appendInlineTokens(td, cell.tokens, cell.text);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        parent.appendChild(wrap);
        break;
      }
      case "hr": {
        parent.appendChild(document.createElement("hr"));
        break;
      }
      case "html": {
        const p = document.createElement("p");
        p.className = "md-raw-html-literal";
        p.textContent = String(tok.raw ?? tok.text ?? "");
        parent.appendChild(p);
        break;
      }
      default: {
        if (tok.raw) {
          const p = document.createElement("p");
          p.textContent = String(tok.raw);
          parent.appendChild(p);
        }
      }
    }
  }
}

export function renderMarkdownToFragment(source) {
  const frag = document.createDocumentFragment();
  const str = String(source ?? "");
  if (!str) return frag;
  const tokens = Lexer.lex(str, { gfm: true, breaks: false });
  appendBlockTokens(frag, tokens, null);
  return frag;
}

export const MARKDOWN_SHADOW_STYLES = \`
  :host {
    display: block;
    font-family: var(--meru-font, -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif);
    font-size: var(--meru-md-font-size, 13.5px);
    line-height: var(--meru-md-line-height, 1.68);
    color: var(--meru-fg-secondary, #3f4756);
    word-break: break-word;
  }
  .md-root > :first-child { margin-top: 0; }
  .md-root > :last-child { margin-bottom: 0; }
  h1, h2, h3, h4, h5, h6 {
    color: var(--meru-fg, #14171f);
    font-weight: 600;
    line-height: 1.32;
    margin: 1.25em 0 0.5em;
    letter-spacing: -0.015em;
  }
  h1 { font-size: var(--meru-md-h1-size, 18px); border-bottom: 1px solid var(--meru-border, rgba(20, 23, 31, 0.1)); padding-bottom: 6px; }
  h2 { font-size: var(--meru-md-h2-size, 15.5px); }
  h3 { font-size: var(--meru-md-h3-size, 14px); }
  h4, h5, h6 { font-size: var(--meru-md-font-size, 13.5px); }
  p { margin: 0.55em 0; }
  ul, ol { margin: 0.5em 0; padding-left: 1.4em; }
  li { margin: 0.25em 0; }
  li.md-task-item { list-style: none; margin-left: -1.1em; display: flex; align-items: baseline; gap: 6px; }
  blockquote {
    margin: 0.7em 0;
    padding: 4px 12px;
    border-left: 2px solid var(--meru-border-strong, rgba(20, 23, 31, 0.24));
    color: var(--meru-fg-muted, #636b78);
  }
  code.md-inline-code {
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--meru-chip-bg, rgba(20, 23, 31, 0.06));
    color: var(--meru-fg, #14171f);
  }
  .md-code-block {
    margin: 0.75em 0;
    border: 1px solid var(--meru-border, rgba(20, 23, 31, 0.1));
    border-radius: 8px;
    background: var(--meru-surface, #ffffff);
    overflow: hidden;
  }
  .md-code-lang {
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11px;
    color: var(--meru-fg-muted, #636b78);
    padding: 4px 10px;
    border-bottom: 1px solid var(--meru-border, rgba(20, 23, 31, 0.08));
  }
  .md-code-block pre {
    margin: 0;
    padding: 10px 12px;
    overflow-x: auto;
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--meru-fg, #14171f);
  }
  .md-mermaid-block {
    position: relative;
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }
  .md-mermaid-block.expanded {
    border-color: var(--meru-border-strong, rgba(20, 23, 31, 0.22));
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
  }
  .md-mermaid-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 8px 4px 10px;
    border-bottom: 1px solid var(--meru-border, rgba(20, 23, 31, 0.08));
    background: var(--meru-surface-subtle, #f5f7fa);
    min-height: 32px;
  }
  .md-mermaid-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .md-mermaid-lang {
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11px;
    color: var(--meru-fg-muted, #636b78);
    flex-shrink: 0;
  }
  .md-mermaid-hint {
    display: none;
    font-size: 11px;
    color: var(--meru-fg-muted, #636b78);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .md-mermaid-hint.visible {
    display: inline;
  }
  .md-mermaid-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  .md-mermaid-seg {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    padding: 1px;
    border-radius: 6px;
    background: var(--meru-surface-control, rgba(20, 23, 31, 0.045));
    border: 1px solid var(--meru-border, rgba(20, 23, 31, 0.09));
  }
  .md-mm-btn {
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--meru-fg-muted, #636b78);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 110ms ease, color 110ms ease;
  }
  .md-mm-btn:hover:not(:disabled) {
    background: var(--meru-surface-hover, rgba(20, 23, 31, 0.075));
    color: var(--meru-fg, #14171f);
  }
  .md-mm-btn.active {
    background: var(--meru-surface, #ffffff);
    color: var(--meru-fg, #14171f);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);
  }
  .md-mm-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .md-mm-btn:focus-visible {
    outline: 2px solid var(--meru-data-hue, #2e66b8);
    outline-offset: 1px;
  }
  .md-mermaid-body {
    position: relative;
  }
  .md-mermaid-stage {
    width: 100%;
    overflow: hidden;
  }
  .md-mermaid-stage.is-pending {
    visibility: hidden;
    height: 0;
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
  }
  .md-mermaid-stage.is-visible {
    visibility: visible;
    position: relative;
    pointer-events: auto;
  }
  .md-mermaid-frame {
    display: block;
    width: 100%;
    border: none;
    background: transparent;
  }
  .md-table-wrap { overflow-x: auto; margin: 0.75em 0; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
  th, td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--meru-border, rgba(20, 23, 31, 0.1));
    text-align: left;
    vertical-align: top;
  }
  th { font-weight: 600; color: var(--meru-fg, #14171f); }
  hr { border: none; border-top: 1px solid var(--meru-border, rgba(20, 23, 31, 0.12)); margin: 1em 0; }
  a { color: var(--meru-data-hue, #1d5fbf); text-decoration: none; }
  a:hover { text-decoration: underline; }
  img { max-width: 100%; height: auto; border-radius: 6px; }
  .md-blocked-img, .md-blocked-link {
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11.5px;
    color: var(--meru-fg-muted, #636b78);
  }
  .md-raw-html-literal {
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    white-space: pre-wrap;
    color: var(--meru-fg-secondary, #3f4756);
  }
  .md-large-guard {
    border: 1px dashed var(--meru-border-strong, rgba(20, 23, 31, 0.2));
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
    color: var(--meru-fg-muted, #636b78);
  }
  .md-guard-btn {
    border: 1px solid var(--meru-border-strong, rgba(20, 23, 31, 0.22));
    background: var(--meru-surface, #ffffff);
    color: var(--meru-fg, #14171f);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    flex-shrink: 0;
  }
  pre.md-plain-fallback {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    line-height: 1.55;
  }
\`;

export function mountMarkdownIntoShadow(shadowRoot, source, opts = {}) {
  let activeCtrl = null;
  let currentTheme = opts.theme === "dark" ? "dark" : "light";

  function renderIntoShadow(forceRender) {
    if (activeCtrl) {
      activeCtrl.teardown();
      activeCtrl = null;
    }
    while (shadowRoot.firstChild) shadowRoot.removeChild(shadowRoot.firstChild);

    const style = document.createElement("style");
    style.textContent = MARKDOWN_SHADOW_STYLES;
    shadowRoot.appendChild(style);

    const root = document.createElement("div");
    root.className = "md-root";
    const str = String(source ?? "");

    if (!forceRender && str.length > MAX_AUTO_MARKDOWN_BYTES) {
      const guard = document.createElement("div");
      guard.className = "md-large-guard";
      const info = document.createElement("span");
      info.textContent =
        (opts.largeWarningText || "Large document (>256KB) shown as plain text.");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "md-guard-btn";
      btn.textContent = opts.renderAnywayLabel || "Render anyway";
      btn.addEventListener("click", () => {
        renderIntoShadow(true);
      });
      guard.appendChild(info);
      guard.appendChild(btn);
      root.appendChild(guard);

      const pre = document.createElement("pre");
      pre.className = "md-plain-fallback";
      pre.textContent = str;
      root.appendChild(pre);
      shadowRoot.appendChild(root);
      return;
    }

    const mermaidCtrl = opts.enableMermaid
      ? createMermaidController({ ...opts, theme: currentTheme })
      : null;
    activeCtrl = mermaidCtrl;
    if (str) {
      const tokens = Lexer.lex(str, { gfm: true, breaks: false });
      appendBlockTokens(root, tokens, mermaidCtrl);
    }
    shadowRoot.appendChild(root);
  }

  renderIntoShadow(Boolean(opts.force));

  return {
    setTheme(nextTheme) {
      currentTheme = nextTheme === "dark" ? "dark" : "light";
      if (activeCtrl) activeCtrl.setTheme(currentTheme);
    },
    teardown() {
      if (activeCtrl) {
        activeCtrl.teardown();
        activeCtrl = null;
      }
    },
  };
}

export function mountSafeMarkdown(container, source, opts = {}) {
  if (!container) {
    return { setTheme() {}, teardown() {} };
  }
  const targetShadow =
    typeof ShadowRoot !== "undefined" && container instanceof ShadowRoot
      ? container
      : (container.shadowRoot || container.attachShadow({ mode: "open" }));
  return mountMarkdownIntoShadow(targetShadow, source, opts);
}

/**
 * Wraps an HTML document with the mandatory zero-network, zero-script inner meta CSP
 * before assigning to \`<iframe sandbox="" srcdoc="...">\`.
 */
export function buildSandboxedHtmlSrcdoc(rawHtml) {
  const html = String(rawHtml ?? "");
  const metaTag = '<meta http-equiv="Content-Security-Policy" content="' + SAFE_HTML_META_CSP + '">';
  if (/<head\\b[^>]*>/i.test(html)) {
    return html.replace(/<head\\b[^>]*>/i, (m) => m + metaTag);
  }
  return "<!doctype html><html><head><meta charset=\\"utf-8\\">" + metaTag + "</head><body>" + html + "</body></html>";
}

/**
 * Click-to-render static HTML preview inside \`<iframe sandbox="" referrerpolicy="no-referrer">\`.
 * Never enables \`allow-scripts\` or \`allow-same-origin\`. Enforces 1MB cap and returns \`teardown()\`.
 */
export function mountStaticHtmlPreview(container, rawHtml, labels = {}) {
  while (container.firstChild) container.removeChild(container.firstChild);
  const str = String(rawHtml ?? "");
  let activeIframe = null;

  const teardown = () => {
    if (activeIframe) {
      try { activeIframe.srcdoc = ""; } catch {}
      activeIframe.remove();
      activeIframe = null;
    }
    while (container.firstChild) container.removeChild(container.firstChild);
  };

  const banner = document.createElement("div");
  banner.className = "html-preview-banner";
  const note = document.createElement("span");
  const overCap = str.length > MAX_HTML_PREVIEW_BYTES;
  note.textContent = overCap
    ? (labels.tooLarge || "HTML exceeds 1 MB static preview limit; showing escaped source.")
    : (labels.notice || "Static HTML preview (scripts & network disabled).");
  banner.appendChild(note);

  const pre = document.createElement("pre");
  pre.className = "html-source-pre";
  pre.textContent = str;

  if (!overCap) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "small-btn";
    btn.dataset.ui = "render-static-html-btn";
    btn.textContent = labels.renderBtn || "Render static preview";
    btn.addEventListener("click", () => {
      if (activeIframe) {
        activeIframe.srcdoc = "";
        activeIframe.remove();
        activeIframe = null;
        btn.textContent = labels.renderBtn || "Render static preview";
        pre.style.display = "";
        return;
      }
      const frame = document.createElement("iframe");
      frame.className = "meru-html-sandbox-frame";
      frame.setAttribute("sandbox", "");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.title = labels.frameTitle || "Static HTML preview";
      frame.srcdoc = buildSandboxedHtmlSrcdoc(str);
      activeIframe = frame;
      pre.style.display = "none";
      btn.textContent = labels.hideBtn || "Show raw source";
      container.appendChild(frame);
    });
    banner.appendChild(btn);
  }

  container.appendChild(banner);
  container.appendChild(pre);
  return { teardown };
}
`;
