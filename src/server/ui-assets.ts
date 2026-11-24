/**
 * Server-hosted 1.5-Layer Composable Frontend Assets (v0.5.2).
 * `/_meru/client.js` (0-dependency core + lazy <meru-markdown>) and `/_meru/shell`
 * are always version-locked to the running server.
 *
 * Security invariant: zero raw HTML DOM injection sinks anywhere in this file.
 */

export const CLIENT_JS_SOURCE = `// Meru Mind v0.5.2 Framework-Agnostic Composable Client (/_meru/client.js)
// Zero runtime dependencies on initial load; <meru-markdown> lazy-loads /_meru/markdown.js on first mount.

const WS_FAIL_THRESHOLD = 2;
const WS_HANDSHAKE_TIMEOUT_MS = 5000;
const WS_REPROBE_INTERVAL_MS = 5 * 60 * 1000;

let markdownToolsPromise = null;

/**
 * Lazy-loads the safe token-AST Markdown & sandboxed Static HTML Preview module (/_meru/markdown.js).
 */
export function loadMarkdownTools() {
  if (!markdownToolsPromise) {
    markdownToolsPromise = import("/_meru/markdown.js");
  }
  return markdownToolsPromise;
}

function extractHighlightTerms(query) {
  if (!query || typeof query !== "string") return [];
  const raw = query.match(/[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]+|[A-Za-z0-9_]+(?:[-/:.][A-Za-z0-9_]+)*/gu) || [];
  const terms = new Set();
  for (const seg of raw) {
    const t = seg.trim();
    if (!t) continue;
    terms.add(t);
    const chars = Array.from(t);
    if (chars.length >= 3 && /[\\p{Script=Han}]/u.test(t)) {
      for (let i = 0; i < chars.length - 1; i += 1) {
        terms.add(chars[i] + chars[i + 1]);
      }
    }
  }
  return Array.from(terms).sort((a, b) => b.length - a.length);
}

/**
 * Pure highlight range calculator: returns merged [start, end) ranges (never raw HTML).
 */
export function computeHighlightRanges(text, query) {
  if (!text || !query) return [];
  const terms = extractHighlightTerms(query);
  if (terms.length === 0) return [];
  const lower = String(text).toLowerCase();
  const ranges = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    let idx = lower.indexOf(needle);
    while (idx !== -1 && ranges.length < 64) {
      ranges.push([idx, idx + needle.length]);
      idx = lower.indexOf(needle, idx + needle.length);
    }
  }
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const [s, e] of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && s <= prev[1]) prev[1] = Math.max(prev[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/**
 * Safely renders text + [start, end) highlight ranges using DocumentFragment + createTextNode only.
 */
export function applyHighlightRanges(text, ranges) {
  const frag = document.createDocumentFragment();
  const str = String(text ?? "");
  if (!Array.isArray(ranges) || ranges.length === 0) {
    frag.appendChild(document.createTextNode(str));
    return frag;
  }
  let pos = 0;
  for (const [start, end] of ranges) {
    const s = Math.max(pos, Math.min(start, str.length));
    const e = Math.max(s, Math.min(end, str.length));
    if (s > pos) frag.appendChild(document.createTextNode(str.slice(pos, s)));
    if (e > s) {
      const mark = document.createElement("mark");
      mark.className = "meru-hl";
      mark.textContent = str.slice(s, e);
      frag.appendChild(mark);
    }
    pos = e;
  }
  if (pos < str.length) frag.appendChild(document.createTextNode(str.slice(pos)));
  return frag;
}

export class MeruClientError extends Error {
  constructor(status, payload) {
    super(payload?.message || ("HTTP " + status));
    this.name = "MeruClientError";
    this.status = status;
    this.code = payload?.error || "invalid_input";
    this.cliCommand = payload?.try || null;
    this.candidates = payload?.candidates || [];
  }
}

/**
 * Primitive 1..4 Factory: Pump (WS -> Long-Poll auto-fallback), CAS Inbox Triage,
 * Visible Scope Snapshots, and Pulse focus declarations.
 */
export function createMindClient(options = {}) {
  const baseUrl = String(options.baseUrl || "").replace(/\\/+$/, "");

  async function apiRequest(method, path, opts = {}) {
    const url = new URL((baseUrl || window.location.origin) + path);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }
    const headers = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url.toString(), {
      method,
      credentials: "same-origin",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = { message: text }; }
    }
    if (!res.ok) {
      throw new MeruClientError(res.status, json || {});
    }
    return json;
  }

  // ---- Primitive 1: Realtime Pump (WS primary -> Long-Poll fallback after 2 fails or 5s timeout) ----
  const listeners = new Set();
  let state = {
    status: "disconnected", // connecting | ws | long-poll | disconnected | auth-required
    generation: undefined,
    cursorSeq: 0,
    topologyVersion: 1,
    lastFrames: [],
    error: null,
  };
  let running = false;
  let ws = null;
  let wsFailures = 0;
  let pollAbort = null;
  let reprobeTimer = null;
  let reconnectTimer = null;

  function emit(patch) {
    state = { ...state, ...patch };
    for (const fn of listeners) {
      try { fn(state); } catch {}
    }
  }

  function wsUrl() {
    const loc = baseUrl ? new URL(baseUrl) : window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + loc.host + "/v1/ws";
  }

  async function runLongPollLoop() {
    emit({ status: "long-poll", error: null });
    if (reprobeTimer) clearTimeout(reprobeTimer);
    reprobeTimer = setTimeout(() => {
      if (running && state.status === "long-poll") {
        wsFailures = 0;
        if (pollAbort) pollAbort.abort();
        connectWs();
      }
    }, WS_REPROBE_INTERVAL_MS);

    while (running && state.status === "long-poll") {
      pollAbort = new AbortController();
      try {
        const res = await apiRequest("GET", "/v1/changes", {
          query: {
            since: state.cursorSeq,
            generation: state.generation,
            wait: 25,
            limit: 100,
          },
          signal: pollAbort.signal,
        });
        if (!running) break;
        const frames = Array.isArray(res.entries) ? res.entries : [];
        const nextCursor = frames.length > 0 ? frames[frames.length - 1].seq : Math.max(state.cursorSeq, res.latestSeq || 0);
        emit({
          generation: res.generation,
          cursorSeq: nextCursor,
          topologyVersion: res.topologyVersion ?? state.topologyVersion,
          lastFrames: frames,
        });
      } catch (err) {
        if (!running) break;
        if (err && err.name === "AbortError") break;
        if (err instanceof MeruClientError && (err.status === 401 || err.status === 403)) {
          emit({ status: "auth-required", error: err.message });
          running = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  function connectWs() {
    if (!running) return;
    if (typeof WebSocket === "undefined") {
      void runLongPollLoop();
      return;
    }
    emit({ status: "connecting", error: null });
    let opened = false;
    let settled = false;
    const socket = new WebSocket(wsUrl());
    ws = socket;

    const handshakeTimer = setTimeout(() => {
      if (!opened && !settled) {
        settled = true;
        try { socket.close(); } catch {}
        wsFailures += 1;
        void runLongPollLoop();
      }
    }, WS_HANDSHAKE_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      opened = true;
      clearTimeout(handshakeTimer);
      wsFailures = 0;
      socket.send(JSON.stringify({
        type: "hello",
        generation: state.generation,
        sinceSeq: state.cursorSeq,
      }));
    });

    socket.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === "welcome") {
        emit({
          status: "ws",
          generation: msg.generation,
          topologyVersion: msg.topologyVersion ?? state.topologyVersion,
        });
      } else if (msg.type === "ping") {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "pong" }));
        }
      } else if (msg.type === "reset") {
        emit({
          generation: msg.generation,
          cursorSeq: msg.latestSeq || 0,
          topologyVersion: msg.topologyVersion ?? state.topologyVersion,
          lastFrames: [],
        });
      } else if (msg.type === "frames") {
        const frames = Array.isArray(msg.frames) ? msg.frames : [];
        const nextCursor = frames.length > 0 ? frames[frames.length - 1].seq : state.cursorSeq;
        emit({
          generation: msg.generation,
          cursorSeq: nextCursor,
          topologyVersion: msg.topologyVersion ?? state.topologyVersion,
          lastFrames: frames,
        });
      }
    });

    socket.addEventListener("close", (ev) => {
      clearTimeout(handshakeTimer);
      if (settled || !running) return;
      settled = true;
      if (ev.code === 4001) {
        emit({ status: "auth-required", error: "Session expired or token revoked" });
        running = false;
        return;
      }
      if (!opened) wsFailures += 1;
      if (wsFailures >= WS_FAIL_THRESHOLD) {
        void runLongPollLoop();
      } else {
        reconnectTimer = setTimeout(() => connectWs(), 1200);
      }
    });

    socket.addEventListener("error", () => {
      // close event handles fallback/retry deterministically
    });
  }

  const pump = {
    getSnapshot() { return state; },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start(initialSeq) {
      if (typeof initialSeq === "number" && initialSeq > state.cursorSeq) {
        state = { ...state, cursorSeq: initialSeq };
      }
      if (running) return;
      running = true;
      wsFailures = 0;
      connectWs();
    },
    stop() {
      running = false;
      if (reprobeTimer) clearTimeout(reprobeTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pollAbort) pollAbort.abort();
      if (ws) { try { ws.close(); } catch {} ws = null; }
      emit({ status: "disconnected" });
    },
  };

  // ---- Primitive 2: CAS + Idempotent Write Actions (Inbox Triage) ----
  const inbox = {
    async triage(entryId, targetRealmRef, opts = {}) {
      const idempotencyKey = opts.idempotencyKey || ("triage:" + entryId + ":" + targetRealmRef);
      return apiRequest("POST", "/v1/move", {
        body: {
          entryIds: [entryId],
          targetRealmRef,
          expectedFromRealmRef: opts.expectedFromRealmRef || "/inbox",
          idempotencyKey,
        },
      });
    },
  };

  // ---- Primitive 4: Visible Scope Snapshots ----
  return {
    pump,
    inbox,
    whoami: () => apiRequest("GET", "/v1/whoami"),
    tree: (params = {}) => apiRequest("GET", "/v1/tree", { query: params }),
    ls: (params = {}) => apiRequest("GET", "/v1/ls", { query: params }),
    show: (ref, params = {}) => apiRequest("GET", "/v1/show", { query: { ref, ...params } }),
    brief: (realmPath = "/") => apiRequest("GET", "/v1/show", { query: { ref: realmPath } }),
    chain: (entryId) => apiRequest("GET", "/v1/entry/" + encodeURIComponent(entryId) + "/chain"),
    async search(query, params = {}) {
      const res = await apiRequest("GET", "/v1/search", { query: { query, ...params } });
      const highlights = {};
      for (const item of res.items || []) {
        highlights[item.id] = {
          titleRanges: computeHighlightRanges(item.title || "", query),
          snippetRanges: computeHighlightRanges(item.snippet || "", query),
        };
      }
      return { ...res, highlights };
    },
    write: (input) => apiRequest("POST", "/v1/write", { body: input }),
    move: (input) => apiRequest("POST", "/v1/move", { body: input }),
    pulse: {
      list: () => apiRequest("GET", "/v1/pulse"),
      setFocus: (focus, note = null, realmRef = undefined, clientHint = "browser") =>
        apiRequest("POST", "/v1/pulse", { body: { focus, note, realmRef, clientHint } }),
      leave: (sessionId = undefined) =>
        apiRequest("DELETE", "/v1/pulse", { body: sessionId ? { sessionId } : {} }),
    },
    logout: () => fetch((baseUrl || "") + "/_meru/logout", { method: "POST", credentials: "same-origin" }),
  };
}

// ---- Primitive 3: <meru-entry> Sanitized Framework-Agnostic Web Component ----
const KNOWN_KINDS = new Set(["rule", "decision", "finding", "proposal", "verdict", "claim", "thing", "message", "artifact", "evidence", "signal"]);

const ENTRY_STYLES = \`
  :host {
    display: block;
    font-family: var(--meru-font, -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif);
    color: var(--meru-fg, #14171f);
  }
  .card {
    background: var(--meru-surface, rgba(255, 255, 255, 0.92));
    border: 1px solid var(--meru-border, rgba(20, 23, 31, 0.1));
    border-radius: var(--meru-radius, 10px);
    padding: 11px 13px;
    cursor: pointer;
    transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
  }
  .card:hover {
    border-color: var(--meru-border-strong, rgba(20, 23, 31, 0.24));
  }
  .card.selected {
    border-color: var(--meru-data-hue, #2e66b8);
    box-shadow: 0 0 0 1px var(--meru-data-hue, #2e66b8);
  }
  .card.redacted {
    opacity: 0.72;
    border-style: dashed;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 5px;
  }
  .meta-left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .kind {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--meru-chip-bg, rgba(20, 23, 31, 0.07));
    color: var(--meru-fg, #14171f);
  }
  .kind.rule {
    background: var(--meru-accent, #14171f);
    color: var(--meru-accent-fg, #ffffff);
  }
  .kind.unknown {
    border: 1px dashed var(--meru-border-strong, rgba(20, 23, 31, 0.28));
    background: transparent;
  }
  .status {
    font-size: 11px;
    color: var(--meru-fg-muted, #636b78);
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  .time {
    font-size: 11px;
    color: var(--meru-fg-muted, #636b78);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .title {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.4;
    margin: 0 0 4px 0;
    word-break: break-word;
  }
  .body {
    font-size: 12.5px;
    line-height: 1.52;
    color: var(--meru-fg-secondary, #3e4552);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .footer {
    margin-top: 7px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--meru-fg-muted, #636b78);
    font-family: var(--meru-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }
  .footer span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .footer span:last-child {
    white-space: nowrap;
    flex-shrink: 0;
  }
  mark.meru-hl {
    background: rgba(245, 158, 11, 0.25);
    color: inherit;
    border-radius: 3px;
    padding: 0 2px;
  }
\`;

export class MeruEntryElement extends HTMLElement {
  constructor() {
    super();
    this._entry = null;
    this._highlights = null;
    this._selected = false;
    this.attachShadow({ mode: "open" });
  }

  set entry(val) {
    this._entry = val;
    this.render();
  }

  get entry() {
    return this._entry;
  }

  set highlights(val) {
    this._highlights = val;
    this.render();
  }

  set selected(val) {
    this._selected = Boolean(val);
    const card = this.shadowRoot?.querySelector(".card");
    if (card) card.classList.toggle("selected", this._selected);
  }

  get selected() {
    return this._selected;
  }

  connectedCallback() {
    this.render();
  }

  render() {
    const root = this.shadowRoot;
    if (!root) return;
    while (root.firstChild) root.removeChild(root.firstChild);

    const style = document.createElement("style");
    style.textContent = ENTRY_STYLES;
    root.appendChild(style);

    const e = this._entry;
    if (!e) return;

    const isRedacted = Boolean(e.redactedAt) || e.status === "retracted";
    const card = document.createElement("article");
    card.className = "card" + (isRedacted ? " redacted" : "") + (this._selected ? " selected" : "");
    card.dataset.entryId = String(e.id || "");
    card.addEventListener("click", () => {
      const sel = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
      if (sel && String(sel).trim().length > 0) return;
      this.dispatchEvent(new CustomEvent("meru-select", {
        bubbles: true,
        composed: true,
        detail: { entry: e },
      }));
    });

    const top = document.createElement("div");
    top.className = "top";

    const metaLeft = document.createElement("div");
    metaLeft.className = "meta-left";

    const rawKind = String(e.extKind || e.kind || "entry");
    const kindSpan = document.createElement("span");
    kindSpan.className = "kind" + (rawKind === "rule" ? " rule" : (!KNOWN_KINDS.has(rawKind) ? " unknown" : ""));
    kindSpan.textContent = rawKind;
    metaLeft.appendChild(kindSpan);

    if (e.status && e.status !== "active" && e.status !== "evidence") {
      const st = document.createElement("span");
      st.className = "status";
      st.textContent = String(e.status);
      metaLeft.appendChild(st);
    }

    const time = document.createElement("span");
    time.className = "time";
    const ts = e.occurredAt || e.createdAt || "";
    time.textContent = ts ? String(ts).slice(0, 16).replace("T", " ") : "";

    top.appendChild(metaLeft);
    top.appendChild(time);
    card.appendChild(top);

    const title = document.createElement("h4");
    title.className = "title";
    if (isRedacted) {
      title.textContent = "[REDACTED]";
    } else if (this._highlights?.titleRanges?.length) {
      title.appendChild(applyHighlightRanges(e.title || e.id || "", this._highlights.titleRanges));
    } else {
      title.textContent = String(e.title || e.id || "");
    }
    card.appendChild(title);

    const bodyText = isRedacted
      ? "[REDACTED — content permanently removed]"
      : String(e.snippet ?? e.body ?? e.payload?.body ?? e.text ?? "");
    if (bodyText) {
      const p = document.createElement("p");
      p.className = "body";
      if (!isRedacted && this._highlights?.snippetRanges?.length) {
        p.appendChild(applyHighlightRanges(bodyText, this._highlights.snippetRanges));
      } else {
        p.textContent = bodyText;
      }
      card.appendChild(p);
    }

    const footer = document.createElement("div");
    footer.className = "footer";
    const idSpan = document.createElement("span");
    idSpan.textContent = [e.id, e.realmPath].filter(Boolean).join(" · ");
    const authorSpan = document.createElement("span");
    authorSpan.textContent = e.authorId ? ("@" + e.authorId) : "";
    footer.appendChild(idSpan);
    footer.appendChild(authorSpan);
    card.appendChild(footer);

    root.appendChild(card);
  }
}

if (typeof customElements !== "undefined" && !customElements.get("meru-entry")) {
  customElements.define("meru-entry", MeruEntryElement);
}

// ---- Primitive 5: <meru-markdown> Thin Lazy-Loaded Token-AST Markdown Renderer ----
export class MeruMarkdownElement extends HTMLElement {
  constructor() {
    super();
    this._source = "";
    this._labels = {};
    this._renderToken = 0;
    this.attachShadow({ mode: "open" });
  }

  set source(val) {
    this._source = String(val ?? "");
    this.render();
  }

  get source() {
    return this._source;
  }

  set labels(val) {
    this._labels = val && typeof val === "object" ? val : {};
    if (this._source) this.render();
  }

  get labels() {
    return this._labels;
  }

  connectedCallback() {
    this.render();
  }

  render() {
    const root = this.shadowRoot;
    if (!root) return;
    const token = ++this._renderToken;
    const text = this._source;

    // Immediate safe plain-text fallback while lazy module loads (zero blank flash)
    while (root.firstChild) root.removeChild(root.firstChild);
    const pre = document.createElement("pre");
    pre.style.margin = "0";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.wordBreak = "break-word";
    pre.style.fontFamily = "var(--meru-font, -apple-system, BlinkMacSystemFont, sans-serif)";
    pre.style.fontSize = "13px";
    pre.style.lineHeight = "1.6";
    pre.textContent = text;
    root.appendChild(pre);

    loadMarkdownTools()
      .then((mod) => {
        if (token !== this._renderToken) return;
        mod.mountMarkdownIntoShadow(root, text, this._labels);
      })
      .catch(() => {
        // Keep safe plain-text fallback on offline/load failure
      });
  }
}

if (typeof customElements !== "undefined" && !customElements.get("meru-markdown")) {
  customElements.define("meru-markdown", MeruMarkdownElement);
}
`;

export const DEFAULT_SHELL_CSS = `/* Meru Mind Official Default Shell (v0.5.2) — Monochromatic Two-Tone + Deep Sea Sub-Logo */
:root {
  --meru-canvas: #eaeef4;
  --meru-panel: rgba(255, 255, 255, 0.9);
  --meru-surface: rgba(255, 255, 255, 0.96);
  --meru-control: rgba(20, 23, 31, 0.055);
  --meru-control-hover: rgba(20, 23, 31, 0.095);
  --meru-floating: rgba(255, 255, 255, 0.98);
  --meru-fg: #14171f;
  --meru-fg-secondary: #3e4552;
  --meru-fg-muted: #667080;
  --meru-accent: #14171f;
  --meru-accent-fg: #ffffff;
  --meru-data-hue: #2e66b8;
  --meru-logo-left: #1b3a6b;
  --meru-logo-right: #2e66b8;
  --meru-logo-top: #14171f;
  --meru-border: rgba(20, 23, 31, 0.09);
  --meru-border-strong: rgba(20, 23, 31, 0.22);
  --meru-chip-bg: rgba(20, 23, 31, 0.068);
  --meru-radius: 10px;
  --meru-font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
  --meru-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}

:root[data-theme="dark"] {
  --meru-canvas: #090b0e;
  --meru-panel: rgba(21, 25, 34, 0.9);
  --meru-surface: rgba(27, 32, 43, 0.95);
  --meru-control: rgba(255, 255, 255, 0.065);
  --meru-control-hover: rgba(255, 255, 255, 0.11);
  --meru-floating: rgba(24, 29, 39, 0.98);
  --meru-fg: #e8eef7;
  --meru-fg-secondary: #b6c0d0;
  --meru-fg-muted: #7f8b9f;
  --meru-accent: #e8eef7;
  --meru-accent-fg: #090b0e;
  --meru-data-hue: #6ca3f2;
  --meru-logo-left: #3b6cb7;
  --meru-logo-right: #6ca3f2;
  --meru-logo-top: #e8eef7;
  --meru-border: rgba(232, 238, 247, 0.1);
  --meru-border-strong: rgba(232, 238, 247, 0.24);
  --meru-chip-bg: rgba(232, 238, 247, 0.1);
}

* { box-sizing: border-box; }
html, body {
  margin: 0;
  height: 100%;
  background: var(--meru-canvas);
  color: var(--meru-fg);
  font-family: var(--meru-font);
  font-size: 13.5px;
  -webkit-font-smoothing: antialiased;
}

.app-shell {
  display: grid;
  grid-template-columns: 256px minmax(0, 1fr) 432px;
  gap: 10px;
  height: 100vh;
  padding: 10px;
}

@media (max-width: 1120px) {
  .app-shell { grid-template-columns: 224px minmax(0, 1fr) 340px; }
}

@media (max-width: 880px) {
  .app-shell { grid-template-columns: 210px minmax(0, 1fr); }
  .inspector-col { display: none; }
}

.col {
  background: var(--meru-panel);
  backdrop-filter: blur(14px);
  border: 1px solid var(--meru-border);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.col-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--meru-border);
  flex-shrink: 0;
  min-height: 48px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.brand-logo {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: block;
}
.brand-logo .logo-left { fill: var(--meru-logo-left); }
.brand-logo .logo-right { fill: var(--meru-logo-right); }
.brand-logo .logo-top { fill: var(--meru-logo-top); }
.brand-name {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.02em;
  white-space: nowrap;
}

/* Dark textless WebSocket status lamp */
.ws-lamp {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6b7280;
  display: inline-block;
  flex-shrink: 0;
}
.ws-lamp[data-status="ws"] { background: #10b981; }
.ws-lamp[data-status="long-poll"] { background: #f59e0b; }
.ws-lamp[data-status="connecting"] { background: #94a3b8; }
.ws-lamp[data-status="disconnected"],
.ws-lamp[data-status="auth-required"] { background: #ef4444; }

.icon-btn {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--meru-fg-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.icon-btn:hover {
  background: var(--meru-control);
  color: var(--meru-fg);
}
.icon-btn.active {
  background: var(--meru-control-hover);
  color: var(--meru-fg);
}
.icon-btn:focus-visible {
  outline: 2px solid var(--meru-data-hue);
  outline-offset: 1px;
}

.scroll-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  min-height: 0;
}

.section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.055em;
  color: var(--meru-fg-muted);
  margin: 14px 0 8px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.section-label:first-child { margin-top: 0; }

.realm-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 9px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--meru-fg-secondary);
  border: 1px solid transparent;
  margin-bottom: 2px;
  transition: background 110ms ease, color 110ms ease;
}
.realm-item:hover { background: var(--meru-control); color: var(--meru-fg); }
.realm-item.active {
  background: var(--meru-accent);
  color: var(--meru-accent-fg);
}
.realm-path {
  font-family: var(--meru-mono);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.count-num {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.72;
  flex-shrink: 0;
}

.obj-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 7px;
  cursor: pointer;
  color: var(--meru-fg-secondary);
  font-size: 12px;
  margin-bottom: 2px;
}
.obj-item:hover { background: var(--meru-control); color: var(--meru-fg); }
.obj-item.active {
  background: var(--meru-control-hover);
  color: var(--meru-fg);
  font-weight: 600;
}
.obj-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.obj-kind {
  font-family: var(--meru-mono);
  font-size: 10.5px;
  color: var(--meru-fg-muted);
  flex-shrink: 0;
}

.pulse-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  font-size: 12px;
  color: var(--meru-fg-secondary);
}
.pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #10b981;
  flex-shrink: 0;
}
.pulse-dot.active { background: #3b82f6; }
.pulse-dot.idle { background: #9ca3af; }
.pulse-kind {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--meru-surface-2);
  color: var(--meru-fg-muted);
  border: 1px solid var(--meru-border);
  flex-shrink: 0;
}
.pulse-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

/* Single-row bottom utility dock */
.utility-dock {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  border-top: 1px solid var(--meru-border);
  flex-shrink: 0;
  position: relative;
}
.actor-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--meru-accent);
  color: var(--meru-accent-fg);
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.actor-name {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dock-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Compact Settings Popover */
.settings-popover {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 52px;
  background: var(--meru-floating);
  border: 1px solid var(--meru-border-strong);
  border-radius: 12px;
  padding: 12px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.22);
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--meru-fg-secondary);
}
.seg-group {
  display: inline-flex;
  background: var(--meru-control);
  border-radius: 7px;
  padding: 2px;
  gap: 2px;
}
.seg-btn {
  border: none;
  background: transparent;
  color: var(--meru-fg-secondary);
  font-size: 11.5px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: 5px;
  cursor: pointer;
}
.seg-btn.active {
  background: var(--meru-surface);
  color: var(--meru-fg);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

/* Center Header & Filters */
.realm-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.realm-heading-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.filter-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 10px;
}
.filter-chip {
  border: 1px solid var(--meru-border);
  background: transparent;
  color: var(--meru-fg-secondary);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11.5px;
  font-family: var(--meru-mono);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: background 110ms ease, border-color 110ms ease, color 110ms ease;
}
.filter-chip:hover {
  background: var(--meru-control);
  color: var(--meru-fg);
}
.filter-chip.active {
  background: var(--meru-accent);
  color: var(--meru-accent-fg);
  border-color: var(--meru-accent);
}
.active-obj-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--meru-mono);
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--meru-control-hover);
  color: var(--meru-fg);
  border: none;
  cursor: pointer;
}

.entry-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rule-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-left: 2px solid var(--meru-data-hue);
  background: var(--meru-control);
  border-radius: 0 8px 8px 0;
  cursor: pointer;
}
.rule-row:hover { border-left-width: 3px; background: var(--meru-control-hover); }
.rule-title { font-size: 13px; font-weight: 500; word-break: break-word; }
.rule-tag {
  font-size: 11px;
  font-family: var(--meru-mono);
  color: var(--meru-fg-muted);
  white-space: nowrap;
}

.triage-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 0 2px;
}
.triage-select {
  flex: 1;
  height: 28px;
  border-radius: 7px;
  border: 1px solid var(--meru-border-strong);
  background: var(--meru-surface);
  color: var(--meru-fg);
  font-family: var(--meru-mono);
  font-size: 12px;
  padding: 0 8px;
}
.action-pill {
  height: 28px;
  padding: 0 11px;
  border-radius: 7px;
  border: 1px solid var(--meru-border-strong);
  background: var(--meru-accent);
  color: var(--meru-accent-fg);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.action-pill:disabled { opacity: 0.5; cursor: not-allowed; }
.small-btn {
  height: 27px;
  padding: 0 10px;
  border-radius: 7px;
  border: 1px solid var(--meru-border-strong);
  background: var(--meru-surface);
  color: var(--meru-fg);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.small-btn:hover { background: var(--meru-control); }

.load-more-wrap {
  margin-top: 12px;
  display: flex;
  justify-content: center;
}

/* Inspector */
.inspector-title {
  margin: 0 0 6px;
  font-size: 15.5px;
  font-weight: 650;
  line-height: 1.38;
  letter-spacing: -0.015em;
  word-break: break-word;
}
.inspector-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-family: var(--meru-mono);
  color: var(--meru-fg-muted);
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--meru-border);
}
.meta-pill {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--meru-chip-bg);
  color: var(--meru-fg);
}
.raw-pre,
.html-source-pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--meru-border);
  background: var(--meru-surface);
  font-family: var(--meru-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}
.html-preview-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  border-radius: 8px;
  background: var(--meru-control);
  font-size: 12px;
  color: var(--meru-fg-secondary);
}
.meru-html-sandbox-frame {
  width: 100%;
  min-height: 320px;
  height: 44vh;
  border: 1px solid var(--meru-border-strong);
  border-radius: 8px;
  background: #ffffff;
}
.payload-details {
  margin-top: 12px;
  border: 1px solid var(--meru-border);
  border-radius: 8px;
  background: var(--meru-control);
  overflow: hidden;
}
.payload-details summary {
  cursor: pointer;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--meru-fg-secondary);
  user-select: none;
}
.payload-details pre {
  margin: 0;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--meru-border);
  font-family: var(--meru-mono);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}

.chain-rail {
  border-left: 1.5px solid var(--meru-border-strong);
  margin-left: 6px;
  padding-left: 12px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.chain-node {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--meru-control);
  cursor: pointer;
}
.chain-node:hover { background: var(--meru-control-hover); }
.chain-node.head {
  border: 1px solid var(--meru-border-strong);
}

.cli-box-wrap {
  margin-top: 8px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 8px;
  background: var(--meru-control);
}
.cli-box {
  font-family: var(--meru-mono);
  font-size: 11.5px;
  color: var(--meru-fg-secondary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  flex: 1;
  min-width: 0;
}

.empty-note {
  font-size: 12.5px;
  color: var(--meru-fg-muted);
  padding: 10px 0;
}

/* Modals (Search Cmd+K & Quick Write) */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(9, 11, 14, 0.44);
  display: none;
  align-items: flex-start;
  justify-content: center;
  padding-top: 9vh;
  z-index: 40;
}
.modal-backdrop.open { display: flex; }
.modal-panel {
  width: min(640px, 92vw);
  max-height: 78vh;
  background: var(--meru-floating);
  border: 1px solid var(--meru-border-strong);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.26);
}
.search-input {
  width: 100%;
  border: none;
  border-bottom: 1px solid var(--meru-border);
  background: transparent;
  color: var(--meru-fg);
  font-size: 14px;
  padding: 14px 16px;
  outline: none;
}
.write-form {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.write-row {
  display: grid;
  grid-template-columns: 1fr 140px;
  gap: 8px;
}
.field-input,
.field-select,
.field-textarea {
  width: 100%;
  border: 1px solid var(--meru-border-strong);
  background: var(--meru-surface);
  color: var(--meru-fg);
  border-radius: 8px;
  padding: 8px 10px;
  font-family: var(--meru-font);
  font-size: 13px;
  outline: none;
}
.field-input:focus,
.field-select:focus,
.field-textarea:focus {
  border-color: var(--meru-data-hue);
}
.field-textarea {
  min-height: 148px;
  resize: vertical;
  line-height: 1.5;
  font-family: var(--meru-mono);
  font-size: 12.5px;
}
.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

.auth-screen {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.auth-card {
  width: min(460px, 100%);
  background: var(--meru-panel);
  border: 1px solid var(--meru-border);
  border-radius: 16px;
  padding: 24px;
}
.toast {
  position: fixed;
  bottom: 16px;
  right: 16px;
  background: var(--meru-accent);
  color: var(--meru-accent-fg);
  padding: 9px 14px;
  border-radius: 9px;
  font-size: 12.5px;
  display: none;
  z-index: 60;
}
.toast.show { display: block; }
`;

/**
 * Meru Mind Sub-Logo (Option A: 12-F1 Obsidian x Deep Sea Blue, dark/light aware).
 */
export const DEFAULT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><style>.l{fill:#1B3A6B}.r{fill:#2E66B8}.t{fill:#14171F}@media(prefers-color-scheme:dark){.l{fill:#3B6CB7}.r{fill:#6CA3F2}.t{fill:#E8EEF7}}</style><polygon class="l" points="34,132 124,132 244,344 154,344"/><polygon class="r" points="366,132 276,132 200,266 244,344"/><polygon class="t" points="78,56 322,56 366,132 34,132"/></svg>`;

export const DEFAULT_SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meru Mind</title>
  <link rel="icon" href="/_meru/favicon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="/_meru/shell.css" />
</head>
<body>
  <div id="app"></div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script type="module" src="/_meru/shell.js"></script>
</body>
</html>
`;

export const DEFAULT_SHELL_JS = `// Meru Mind Official Default Shell v0.5.2 (/_meru/shell.js)
// Imports ONLY /_meru/client.js — ejectable via \`meru-mind ui eject <dir>\` as a reference template.
import { createMindClient, loadMarkdownTools } from "/_meru/client.js";

const I18N = {
  en: {
    brand: "Meru Mind",
    realms: "Realms",
    objects: "Objects",
    pulse: "Active Focus",
    rules: "Binding Rules",
    inboxQueue: "Inbox Triage",
    entries: "Entries",
    allKinds: "All",
    loadMore: "Load more",
    inspector: "Inspector",
    chain: "Supersede Chain",
    payload: "Structured Payload",
    searchPlaceholder: "Search visible memory...",
    searchHint: "Search (Cmd+K)",
    refreshHint: "Refresh",
    writeHint: "Write entry",
    settingsHint: "Settings",
    logoutHint: "Sign out",
    copyHint: "Copy command",
    copied: "Copied to clipboard",
    themeLabel: "Theme",
    light: "Light",
    dark: "Dark",
    langLabel: "Language",
    realtimeLabel: "Realtime",
    noEntries: "No entries here yet.",
    noSelection: "Select an entry to inspect rendered Markdown and supersede history.",
    moveLabel: "Move",
    movedToast: "Moved {id} -> {target}",
    writtenToast: "Saved entry in {realm}",
    viewMd: "MD",
    viewRaw: "Raw",
    viewHtml: "HTML",
    htmlNotice: "Static HTML preview (scripts & network disabled).",
    htmlTooLarge: "HTML exceeds 1 MB static preview limit; showing escaped source.",
    htmlRenderBtn: "Render static preview",
    htmlHideBtn: "Show raw source",
    largeMdWarning: "Large document (>256 KB) shown as plain text.",
    renderAnyway: "Render Markdown",
    writeTitle: "New Entry",
    writeTitlePlaceholder: "Concise title...",
    writeBodyPlaceholder: "Markdown body...",
    cancel: "Cancel",
    save: "Save",
    authTitle: "Sign in via CLI",
    authDesc: "Browser sessions use a 60-second single-use CLI login code (HttpOnly Cookie; read and reversible actions only). Long-lived tokens never enter the browser.",
    cliRestrictionNote: "Irreversible governance actions (redact, rules, mounts, tokens) require a CLI Bearer token.",
    clearFilter: "Clear filter",
    inherited: "inherited",
    local: "local",
  },
  "zh-CN": {
    brand: "Meru Mind",
    realms: "领域目录",
    objects: "关联对象",
    pulse: "当前在线",
    rules: "生效规则",
    inboxQueue: "收件箱分拣",
    entries: "记忆条目",
    allKinds: "全部",
    loadMore: "加载更多",
    inspector: "详情检查",
    chain: "演进链条",
    payload: "结构化 Payload",
    searchPlaceholder: "搜索当前可见记忆...",
    searchHint: "搜索 (Cmd+K)",
    refreshHint: "刷新",
    writeHint: "新建条目",
    settingsHint: "设置",
    logoutHint: "退出登录",
    copyHint: "复制命令",
    copied: "已复制到剪贴板",
    themeLabel: "外观主题",
    light: "浅色",
    dark: "深色",
    langLabel: "界面语言",
    realtimeLabel: "实时同步",
    noEntries: "当前目录下暂无条目。",
    noSelection: "点选左侧或中间列表中的任意条目，在此查看 Markdown 渲染与演进链。",
    moveLabel: "归档",
    movedToast: "已移动 {id} -> {target}",
    writtenToast: "已写入到 {realm}",
    viewMd: "MD",
    viewRaw: "原文",
    viewHtml: "HTML",
    htmlNotice: "静态 HTML 沙箱预览（脚本与外链请求已完全禁用）。",
    htmlTooLarge: "HTML 超过 1 MB 静态预览上限，已降级为转义源码显示。",
    htmlRenderBtn: "渲染静态预览",
    htmlHideBtn: "查看源码",
    largeMdWarning: "文档超过 256 KB，默认按纯文本显示以防卡顿。",
    renderAnyway: "仍要渲染 Markdown",
    writeTitle: "写入记忆条目",
    writeTitlePlaceholder: "简短明确的标题...",
    writeBodyPlaceholder: "支持标准 Markdown 正文...",
    cancel: "取消",
    save: "保存",
    authTitle: "通过 CLI 登录",
    authDesc: "浏览器会话仅使用 60 秒一次性 CLI 登录码换取 HttpOnly Cookie（仅限读取与可逆操作），长期 Token 绝不进入浏览器。",
    cliRestrictionNote: "不可逆治理动作（redact、新增 rule、mount、签发 token）必须在 CLI 使用 Bearer Token 执行。",
    clearFilter: "清除筛选",
    inherited: "继承",
    local: "本域",
  },
};

function detectInitialLang() {
  const saved = localStorage.getItem("meru-lang");
  if (saved === "en" || saved === "zh-CN") return saved;
  const nav = (navigator.language || "").toLowerCase();
  return nav.startsWith("zh") ? "zh-CN" : "en";
}

function t(key, vars) {
  const dict = I18N[state.lang] || I18N.en;
  let out = dict[key] ?? I18N.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replace("{" + k + "}", String(v));
    }
  }
  return out;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function makeMeruSubLogo(size = 20) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "brand-logo");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 400 400");
  svg.setAttribute("aria-hidden", "true");
  const polys = [
    ["logo-left", "34,132 124,132 244,344 154,344"],
    ["logo-right", "366,132 276,132 200,266 244,344"],
    ["logo-top", "78,56 322,56 366,132 34,132"],
  ];
  for (const [cls, pts] of polys) {
    const p = document.createElementNS(SVG_NS, "polygon");
    p.setAttribute("class", cls);
    p.setAttribute("points", pts);
    svg.appendChild(p);
  }
  return svg;
}

function makeSvg(paths, size = 15) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

const ICONS = {
  logo: (size = 20) => makeMeruSubLogo(size),
  search: () => makeSvg(["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "M21 21l-4.3-4.3"], 15),
  refresh: () => makeSvg(["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"], 15),
  plus: () => makeSvg(["M12 5v14", "M5 12h14"], 15),
  settings: () => makeSvg([
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z",
  ], 15),
  logout: () => makeSvg(["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"], 15),
  copy: () => makeSvg(["M9 9h10v10H9z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"], 14),
  move: () => makeSvg(["M5 12h14", "M13 5l7 7-7 7"], 14),
  close: () => makeSvg(["M18 6L6 18", "M6 6l12 12"], 14),
};

function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = String(msg);
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 3200);
}

const savedTheme = localStorage.getItem("meru-theme") || "light";
document.documentElement.dataset.theme = savedTheme;

const client = createMindClient();
const app = document.getElementById("app");
let activeHtmlPreview = null;

function teardownHtmlPreview() {
  if (activeHtmlPreview) {
    try { activeHtmlPreview.teardown(); } catch {}
    activeHtmlPreview = null;
  }
}

let state = {
  lang: detectInitialLang(),
  theme: savedTheme,
  settingsOpen: false,
  whoami: null,
  realms: [],
  realmTreeRows: [],
  activeRealmPath: "/",
  brief: null,
  realmObjects: [],
  activeObjectFilter: null,
  kindFilter: "",
  entries: [],
  entriesTotal: 0,
  entriesNextCursor: null,
  loadingMore: false,
  inboxEntries: [],
  pulses: [],
  selectedEntry: null,
  selectedChain: null,
  inspectorView: "md", // md | raw | html
  searchOpen: false,
  searchQuery: "",
  searchResults: null,
  writeOpen: false,
  pumpStatus: "disconnected",
};

document.documentElement.lang = state.lang;

function clearEl(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function flattenRealmTree(nodes, depth = 0, out = []) {
  for (const node of nodes || []) {
    const c = node.counts || {};
    const total =
      (typeof c.subtreeConclusions === "number" ? c.subtreeConclusions : (c.directConclusions || 0)) +
      (typeof c.subtreeRules === "number" ? c.subtreeRules : (c.directRules || 0));
    out.push({
      realm: node.realm,
      depth,
      count: total,
      directCount: (c.directConclusions || 0) + (c.directRules || 0),
    });
    if (Array.isArray(node.children) && node.children.length > 0) {
      flattenRealmTree(node.children, depth + 1, out);
    }
  }
  return out;
}

function splitPayloadSection(text) {
  const str = String(text ?? "");
  const marker = "\\n## Payload\\n";
  const idx = str.indexOf(marker);
  if (idx === -1) return { main: str, payload: null };
  return {
    main: str.slice(0, idx).trimEnd(),
    payload: str.slice(idx + marker.length).trim(),
  };
}

function looksLikeHtmlDocument(text, sourceRef) {
  if (typeof sourceRef === "string" && /\\.html?$/i.test(sourceRef.trim())) return true;
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return false;
  return /^(?:<!doctype\\s+html|<html\\b|<head\\b|<body\\b|<div\\b|<section\\b|<article\\b|<main\\b|<table\\b|<style\\b)/i.test(trimmed);
}

function makeIconButton(iconNode, label, onClick, isActive = false, dataUi = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn" + (isActive ? " active" : "");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  if (dataUi) btn.dataset.ui = dataUi;
  btn.appendChild(iconNode);
  btn.addEventListener("click", onClick);
  return btn;
}

function renderAuthRequired() {
  teardownHtmlPreview();
  clearEl(app);
  const wrap = document.createElement("main");
  wrap.className = "auth-screen";
  const card = document.createElement("section");
  card.className = "auth-card";

  const brand = document.createElement("div");
  brand.className = "brand";
  brand.appendChild(ICONS.logo(24));
  const bn = document.createElement("span");
  bn.className = "brand-name";
  bn.textContent = t("brand");
  brand.appendChild(bn);
  card.appendChild(brand);

  const h = document.createElement("h2");
  h.style.margin = "16px 0 8px";
  h.style.fontSize = "17px";
  h.textContent = t("authTitle");
  card.appendChild(h);

  const p = document.createElement("p");
  p.style.margin = "0 0 12px";
  p.style.color = "var(--meru-fg-secondary)";
  p.style.lineHeight = "1.55";
  p.textContent = t("authDesc");
  card.appendChild(p);

  const cmdWrap = document.createElement("div");
  cmdWrap.className = "cli-box-wrap";
  const cmd = document.createElement("div");
  cmd.className = "cli-box";
  cmd.textContent = "meru-mind ui login --url " + window.location.origin;
  cmdWrap.appendChild(cmd);
  card.appendChild(cmdWrap);

  wrap.appendChild(card);
  app.appendChild(wrap);
}

async function fetchEntriesPage({ reset = true } = {}) {
  const res = await client.ls({
    ref: state.activeRealmPath,
    only: "entries",
    kind: state.kindFilter || undefined,
    about: state.activeObjectFilter || undefined,
    limit: 25,
    cursor: reset ? undefined : (state.entriesNextCursor || undefined),
  });
  const items = Array.isArray(res?.items) ? res.items : [];
  if (reset) {
    state.entries = items;
  } else {
    state.entries = state.entries.concat(items);
  }
  state.entriesTotal = typeof res?.totalMatched === "number" ? res.totalMatched : state.entries.length;
  state.entriesNextCursor = res?.nextCursor || null;
}

async function selectRealm(realmPath, opts = {}) {
  const changed = realmPath !== state.activeRealmPath;
  state.activeRealmPath = realmPath;
  if (changed && !opts.keepFilters) {
    state.kindFilter = "";
    state.activeObjectFilter = null;
  }
  const [showRes, objRes, inboxRes] = await Promise.all([
    client.brief(realmPath),
    client.ls({ ref: realmPath, only: "objects", limit: 40 }).catch(() => ({ objects: [] })),
    realmPath === "/inbox"
      ? client.ls({ ref: "/inbox", only: "entries", limit: 50 }).catch(() => ({ items: [] }))
      : Promise.resolve(null),
  ]);
  state.brief = showRes?.refType === "realm" ? showRes.brief : null;
  state.realmObjects = Array.isArray(objRes?.objects) ? objRes.objects : [];
  if (inboxRes) state.inboxEntries = inboxRes.items || [];
  await fetchEntriesPage({ reset: true });
  await client.pulse.setFocus([realmPath], null, realmPath).catch(() => {});
  const pulseRes = await client.pulse.list().catch(() => null);
  if (pulseRes?.pulses) state.pulses = pulseRes.pulses;
  render();
}

async function selectEntryById(entryId) {
  teardownHtmlPreview();
  try {
    const [showRes, chainRes] = await Promise.all([
      client.show(entryId, { full: true }),
      entryId.startsWith("rec_") ? client.chain(entryId).catch(() => null) : Promise.resolve(null),
    ]);
    if (showRes?.refType === "entry") {
      const e = showRes.entry;
      const flat = e.kind === "record"
        ? { ...e.record, realmPath: e.realmPath, body: showRes.content }
        : e.kind === "seabed"
          ? { ...e.seabed, realmPath: e.realmPath, title: e.seabed.kind + ":" + e.seabed.id, body: showRes.content }
          : { id: entryId, title: entryId, body: showRes.content };
      state.selectedEntry = flat;
      state.selectedChain = chainRes;
      state.inspectorView = "md";
      render();
    }
  } catch (err) {
    showToast(err?.message || "Failed to load entry");
  }
}

async function refreshAll() {
  const [treeRes, pulseRes] = await Promise.all([
    client.tree({ ref: "/", depth: "all", objects: false }),
    client.pulse.list().catch(() => ({ pulses: [] })),
  ]);
  state.realms = treeRes.realms || [];
  state.realmTreeRows = Array.isArray(treeRes.realmTree) && treeRes.realmTree.length > 0
    ? flattenRealmTree(treeRes.realmTree)
    : state.realms.map((r) => ({ realm: r, depth: 0, count: 0, directCount: 0 }));
  state.pulses = pulseRes.pulses || [];
  const hasInbox = state.realms.some((r) => r.path === "/inbox");
  if (hasInbox) {
    const lsInbox = await client.ls({ ref: "/inbox", only: "entries", limit: 50 }).catch(() => ({ items: [] }));
    state.inboxEntries = lsInbox.items || [];
  } else {
    state.inboxEntries = [];
  }
  const targetPath = state.realms.some((r) => r.path === state.activeRealmPath)
    ? state.activeRealmPath
    : (state.realms[0]?.path || "/");
  await selectRealm(targetPath, { keepFilters: true });
}

function renderSettingsPopover(parentCol) {
  if (!state.settingsOpen) return;
  const pop = document.createElement("div");
  pop.className = "settings-popover";
  pop.dataset.ui = "settings-popover";

  // Theme row
  const themeRow = document.createElement("div");
  themeRow.className = "setting-row";
  const tl = document.createElement("span");
  tl.textContent = t("themeLabel");
  const tSeg = document.createElement("div");
  tSeg.className = "seg-group";
  for (const mode of ["light", "dark"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg-btn" + (state.theme === mode ? " active" : "");
    b.dataset.themeOption = mode;
    b.textContent = t(mode);
    b.addEventListener("click", () => {
      state.theme = mode;
      document.documentElement.dataset.theme = mode;
      localStorage.setItem("meru-theme", mode);
      render();
    });
    tSeg.appendChild(b);
  }
  themeRow.appendChild(tl);
  themeRow.appendChild(tSeg);
  pop.appendChild(themeRow);

  // Language row
  const langRow = document.createElement("div");
  langRow.className = "setting-row";
  const ll = document.createElement("span");
  ll.textContent = t("langLabel");
  const lSeg = document.createElement("div");
  lSeg.className = "seg-group";
  for (const [code, label] of [["en", "English"], ["zh-CN", "中文"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg-btn" + (state.lang === code ? " active" : "");
    b.dataset.langOption = code;
    b.textContent = label;
    b.addEventListener("click", () => {
      state.lang = code;
      document.documentElement.lang = code;
      localStorage.setItem("meru-lang", code);
      render();
    });
    lSeg.appendChild(b);
  }
  langRow.appendChild(ll);
  langRow.appendChild(lSeg);
  pop.appendChild(langRow);

  // Realtime row
  const rtRow = document.createElement("div");
  rtRow.className = "setting-row";
  const rtl = document.createElement("span");
  rtl.textContent = t("realtimeLabel");
  const rtv = document.createElement("span");
  rtv.style.fontFamily = "var(--meru-mono)";
  rtv.style.fontSize = "11.5px";
  rtv.textContent = state.pumpStatus;
  rtRow.appendChild(rtl);
  rtRow.appendChild(rtv);
  pop.appendChild(rtRow);

  parentCol.appendChild(pop);
}

function renderInspectorBody(rightScroll) {
  teardownHtmlPreview();
  const entry = state.selectedEntry;
  if (!entry) {
    const emp = document.createElement("div");
    emp.className = "empty-note";
    emp.textContent = t("noSelection");
    rightScroll.appendChild(emp);
    return;
  }

  const isRedacted = Boolean(entry.redactedAt) || entry.status === "retracted";

  const titleEl = document.createElement("h3");
  titleEl.className = "inspector-title";
  titleEl.textContent = isRedacted ? "[REDACTED]" : String(entry.title || entry.id || "");
  rightScroll.appendChild(titleEl);

  const meta = document.createElement("div");
  meta.className = "inspector-meta";
  const kindPill = document.createElement("span");
  kindPill.className = "meta-pill";
  kindPill.textContent = String(entry.extKind || entry.kind || "entry");
  meta.appendChild(kindPill);

  const metaBits = [
    entry.status && entry.status !== "active" ? entry.status : null,
    entry.realmPath,
    entry.authorId ? ("@" + entry.authorId) : null,
    (entry.occurredAt || entry.createdAt) ? String(entry.occurredAt || entry.createdAt).slice(0, 16).replace("T", " ") : null,
    entry.id,
  ].filter(Boolean);
  const metaText = document.createElement("span");
  metaText.textContent = metaBits.join(" · ");
  meta.appendChild(metaText);
  rightScroll.appendChild(meta);

  const rawBody = isRedacted
    ? "[REDACTED — content permanently removed]"
    : String(entry.body ?? entry.snippet ?? entry.text ?? "");
  const split = isRedacted ? { main: rawBody, payload: null } : splitPayloadSection(rawBody);

  if (isRedacted) {
    const red = document.createElement("pre");
    red.className = "raw-pre";
    red.textContent = rawBody;
    rightScroll.appendChild(red);
  } else if (state.inspectorView === "raw") {
    const pre = document.createElement("pre");
    pre.className = "raw-pre";
    pre.textContent = rawBody;
    rightScroll.appendChild(pre);
  } else if (state.inspectorView === "html") {
    const htmlContainer = document.createElement("div");
    htmlContainer.dataset.ui = "static-html-preview";
    rightScroll.appendChild(htmlContainer);
    const currentId = entry.id;
    loadMarkdownTools()
      .then((mod) => {
        if (state.selectedEntry?.id !== currentId || state.inspectorView !== "html") return;
        activeHtmlPreview = mod.mountStaticHtmlPreview(htmlContainer, split.main, {
          notice: t("htmlNotice"),
          tooLarge: t("htmlTooLarge"),
          renderBtn: t("htmlRenderBtn"),
          hideBtn: t("htmlHideBtn"),
        });
      })
      .catch(() => {
        const pre = document.createElement("pre");
        pre.className = "raw-pre";
        pre.textContent = split.main;
        htmlContainer.appendChild(pre);
      });
  } else {
    const mdEl = document.createElement("meru-markdown");
    mdEl.labels = {
      largeWarningText: t("largeMdWarning"),
      renderAnywayLabel: t("renderAnyway"),
    };
    mdEl.source = split.main;
    rightScroll.appendChild(mdEl);
  }

  if (!isRedacted && split.payload && state.inspectorView !== "raw") {
    const details = document.createElement("details");
    details.className = "payload-details";
    const summary = document.createElement("summary");
    summary.textContent = t("payload");
    const pre = document.createElement("pre");
    pre.textContent = split.payload;
    details.appendChild(summary);
    details.appendChild(pre);
    rightScroll.appendChild(details);
  }

  if (state.selectedChain && state.selectedChain.nodes?.length > 1) {
    const chHead = document.createElement("div");
    chHead.className = "section-label";
    chHead.textContent = t("chain") + " (" + state.selectedChain.nodes.length + ")";
    rightScroll.appendChild(chHead);

    const rail = document.createElement("div");
    rail.className = "chain-rail";
    for (const n of state.selectedChain.nodes) {
      const node = document.createElement("div");
      node.className = "chain-node" + (n.id === state.selectedChain.currentHeadId ? " head" : "");
      const nt = document.createElement("div");
      nt.style.fontWeight = "600";
      nt.style.fontSize = "12.5px";
      nt.textContent = n.title;
      const nm = document.createElement("div");
      nm.style.fontSize = "11px";
      nm.style.fontFamily = "var(--meru-mono)";
      nm.style.color = "var(--meru-fg-muted)";
      nm.textContent = n.kind + " · " + n.status + " · " + n.id;
      node.appendChild(nt);
      node.appendChild(nm);
      node.addEventListener("click", () => { void selectEntryById(n.id); });
      rail.appendChild(node);
    }
    rightScroll.appendChild(rail);
  }

  const cliNote = document.createElement("div");
  cliNote.className = "empty-note";
  cliNote.style.marginTop = "12px";
  cliNote.textContent = t("cliRestrictionNote");
  rightScroll.appendChild(cliNote);

  const cliCmd = "meru-mind redact " + entry.id + ' --reason "..."';
  const cliWrap = document.createElement("div");
  cliWrap.className = "cli-box-wrap";
  const cliBox = document.createElement("div");
  cliBox.className = "cli-box";
  cliBox.textContent = cliCmd;
  cliWrap.appendChild(cliBox);
  cliWrap.appendChild(makeIconButton(ICONS.copy(), t("copyHint"), async () => {
    try {
      await navigator.clipboard.writeText(cliCmd);
      showToast(t("copied"));
    } catch {
      showToast(cliCmd);
    }
  }));
  rightScroll.appendChild(cliWrap);
}

function renderWriteModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop" + (state.writeOpen ? " open" : "");
  modal.dataset.ui = "write-modal";
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) {
      state.writeOpen = false;
      render();
    }
  });
  if (!state.writeOpen) return modal;

  const panel = document.createElement("div");
  panel.className = "modal-panel";

  const head = document.createElement("div");
  head.className = "col-header";
  const heading = document.createElement("strong");
  heading.textContent = t("writeTitle");
  head.appendChild(heading);
  head.appendChild(makeIconButton(ICONS.close(), t("cancel"), () => {
    state.writeOpen = false;
    render();
  }));
  panel.appendChild(head);

  const form = document.createElement("form");
  form.className = "write-form";

  const row = document.createElement("div");
  row.className = "write-row";

  const realmSel = document.createElement("select");
  realmSel.className = "field-select";
  realmSel.name = "in";
  for (const r of state.realms) {
    const opt = document.createElement("option");
    opt.value = r.path;
    opt.textContent = r.path;
    if (r.path === state.activeRealmPath) opt.selected = true;
    realmSel.appendChild(opt);
  }

  const kindSel = document.createElement("select");
  kindSel.className = "field-select";
  kindSel.name = "kind";
  for (const k of ["finding", "decision", "claim", "proposal", "verdict"]) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    kindSel.appendChild(opt);
  }
  row.appendChild(realmSel);
  row.appendChild(kindSel);
  form.appendChild(row);

  const titleInput = document.createElement("input");
  titleInput.className = "field-input";
  titleInput.id = "meru-write-title";
  titleInput.type = "text";
  titleInput.required = true;
  titleInput.placeholder = t("writeTitlePlaceholder");
  form.appendChild(titleInput);

  const bodyArea = document.createElement("textarea");
  bodyArea.className = "field-textarea";
  bodyArea.required = true;
  bodyArea.placeholder = t("writeBodyPlaceholder");
  form.appendChild(bodyArea);

  const footer = document.createElement("div");
  footer.className = "modal-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "small-btn";
  cancelBtn.textContent = t("cancel");
  cancelBtn.addEventListener("click", () => {
    state.writeOpen = false;
    render();
  });
  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "action-pill";
  saveBtn.textContent = t("save");
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  form.appendChild(footer);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const titleVal = titleInput.value.trim();
    const bodyVal = bodyArea.value.trim();
    if (!titleVal || !bodyVal) return;
    saveBtn.disabled = true;
    try {
      const targetRealm = realmSel.value || state.activeRealmPath;
      const wrote = await client.write({
        in: targetRealm,
        kind: kindSel.value,
        title: titleVal,
        body: bodyVal,
      });
      state.writeOpen = false;
      showToast(t("writtenToast", { realm: targetRealm }));
      await refreshAll();
      if (wrote?.record?.id) {
        await selectEntryById(wrote.record.id);
      }
    } catch (err) {
      showToast(err?.message || "Write failed");
      saveBtn.disabled = false;
    }
  });

  panel.appendChild(form);
  modal.appendChild(panel);
  return modal;
}

function render() {
  if (!state.whoami) {
    renderAuthRequired();
    return;
  }

  teardownHtmlPreview();
  clearEl(app);
  const shell = document.createElement("div");
  shell.className = "app-shell";

  // ---- LEFT COLUMN: Sub-Logo + Hierarchical Realms + Objects + Active Focus + Utility Dock ----
  const left = document.createElement("aside");
  left.className = "col";

  const leftHead = document.createElement("div");
  leftHead.className = "col-header";
  const brand = document.createElement("div");
  brand.className = "brand";
  brand.appendChild(ICONS.logo(20));
  const bn = document.createElement("span");
  bn.className = "brand-name";
  bn.textContent = t("brand");
  brand.appendChild(bn);

  const lamp = document.createElement("span");
  lamp.className = "ws-lamp";
  lamp.dataset.ui = "ws-connection-status";
  lamp.dataset.status = state.pumpStatus;
  lamp.title = t("realtimeLabel") + ": " + state.pumpStatus;
  brand.appendChild(lamp);

  leftHead.appendChild(brand);
  leftHead.appendChild(makeIconButton(ICONS.search(), t("searchHint"), () => {
    state.searchOpen = true;
    render();
    const inp = document.getElementById("meru-search-input");
    if (inp) inp.focus();
  }, false, "search-btn"));
  left.appendChild(leftHead);

  const leftScroll = document.createElement("div");
  leftScroll.className = "scroll-body";

  const rLabel = document.createElement("div");
  rLabel.className = "section-label";
  rLabel.textContent = t("realms");
  leftScroll.appendChild(rLabel);

  for (const item of state.realmTreeRows) {
    const r = item.realm;
    const row = document.createElement("div");
    row.className = "realm-item" + (r.path === state.activeRealmPath ? " active" : "");
    row.dataset.realmPath = r.path;
    if (item.depth > 0) {
      row.style.paddingLeft = (9 + Math.min(item.depth, 4) * 12) + "px";
    }
    const pSpan = document.createElement("span");
    pSpan.className = "realm-path";
    pSpan.textContent = item.depth === 0 ? r.path : ("/" + r.slug);
    pSpan.title = r.path;
    row.appendChild(pSpan);
    const displayCount = r.path === "/inbox" ? state.inboxEntries.length : item.count;
    if (displayCount > 0) {
      const cnt = document.createElement("span");
      cnt.className = "count-num";
      cnt.textContent = String(displayCount);
      row.appendChild(cnt);
    }
    row.addEventListener("click", () => { void selectRealm(r.path); });
    leftScroll.appendChild(row);
  }

  if (state.realmObjects.length > 0) {
    const oLabel = document.createElement("div");
    oLabel.className = "section-label";
    const oTitle = document.createElement("span");
    oTitle.textContent = t("objects");
    const oCount = document.createElement("span");
    oCount.className = "count-num";
    oCount.textContent = String(state.realmObjects.length);
    oLabel.appendChild(oTitle);
    oLabel.appendChild(oCount);
    leftScroll.appendChild(oLabel);

    for (const obj of state.realmObjects) {
      const oRow = document.createElement("div");
      const isObjActive = state.activeObjectFilter === obj.ref;
      oRow.className = "obj-item" + (isObjActive ? " active" : "");
      oRow.dataset.objectRef = obj.ref;
      const oname = document.createElement("span");
      oname.className = "obj-name";
      oname.textContent = obj.name;
      oname.title = obj.ref;
      const okind = document.createElement("span");
      okind.className = "obj-kind";
      okind.textContent = obj.kind;
      oRow.appendChild(oname);
      oRow.appendChild(okind);
      oRow.addEventListener("click", async () => {
        state.activeObjectFilter = isObjActive ? null : obj.ref;
        await fetchEntriesPage({ reset: true });
        render();
      });
      leftScroll.appendChild(oRow);
    }
  }

  const pLabel = document.createElement("div");
  pLabel.className = "section-label";
  pLabel.textContent = t("pulse");
  leftScroll.appendChild(pLabel);

  if (state.pulses.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = "—";
    leftScroll.appendChild(empty);
  } else {
    const formatAge = (sec) => {
      if (typeof sec !== "number" || sec < 60) return (sec || 0) + "s";
      const m = Math.floor(sec / 60);
      return m < 60 ? (m + "m") : (Math.floor(m / 60) + "h");
    };
    for (const p of state.pulses) {
      const row = document.createElement("div");
      row.className = "pulse-row";
      const dot = document.createElement("span");
      dot.className = "pulse-dot" + (p.online ? "" : (p.active ? " active" : " idle"));
      const name = document.createElement("span");
      name.className = "pulse-name";
      const target = p.focus?.length ? p.focus[0] : p.realmPath;
      name.textContent = p.actorId + (target ? (" · " + target) : "");
      const metaParts = [
        p.actorKind || "agent",
        p.clientHint ? ("client: " + p.clientHint + " (self-reported)") : "",
        p.online ? "online" : ("active " + formatAge(p.ageSeconds) + " ago"),
        p.note || "",
      ].filter(Boolean);
      name.title = metaParts.join(" · ");
      row.appendChild(dot);
      row.appendChild(name);
      if (p.actorKind === "agent") {
        const badge = document.createElement("span");
        badge.className = "pulse-kind";
        badge.textContent = p.clientHint || "agent";
        badge.title = p.clientHint ? "Agent (self-reported client)" : "Agent";
        row.appendChild(badge);
      }
      leftScroll.appendChild(row);
    }
  }
  left.appendChild(leftScroll);

  renderSettingsPopover(left);

  const dock = document.createElement("div");
  dock.className = "utility-dock";
  const actorChip = document.createElement("div");
  actorChip.className = "actor-chip";
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = String(state.whoami.actor.id || "U").slice(0, 1).toUpperCase();
  const actorName = document.createElement("span");
  actorName.className = "actor-name";
  actorName.textContent = state.whoami.actor.id;
  actorChip.appendChild(avatar);
  actorChip.appendChild(actorName);

  const dockActions = document.createElement("div");
  dockActions.className = "dock-actions";
  dockActions.appendChild(makeIconButton(
    ICONS.settings(),
    t("settingsHint"),
    () => {
      state.settingsOpen = !state.settingsOpen;
      render();
    },
    state.settingsOpen,
    "settings-btn",
  ));
  dockActions.appendChild(makeIconButton(ICONS.logout(), t("logoutHint"), async () => {
    client.pump.stop();
    await client.pulse.leave().catch(() => {});
    await client.logout();
    state.whoami = null;
    state.settingsOpen = false;
    render();
  }, false, "logout-btn"));
  dock.appendChild(actorChip);
  dock.appendChild(dockActions);
  left.appendChild(dock);

  // ---- CENTER COLUMN: Untruncated Rules + Inbox Triage + Generic Paginated Entries ----
  const center = document.createElement("main");
  center.className = "col";

  const centerHead = document.createElement("div");
  centerHead.className = "col-header";
  const headLeft = document.createElement("div");
  headLeft.className = "realm-heading";

  const headingRow = document.createElement("div");
  headingRow.className = "realm-heading-row";
  const titleSpan = document.createElement("strong");
  titleSpan.style.fontFamily = "var(--meru-mono)";
  titleSpan.textContent = state.activeRealmPath;
  headingRow.appendChild(titleSpan);

  if (state.activeObjectFilter) {
    const objPill = document.createElement("button");
    objPill.type = "button";
    objPill.className = "active-obj-pill";
    objPill.title = t("clearFilter");
    objPill.textContent = state.activeObjectFilter + " ×";
    objPill.addEventListener("click", async () => {
      state.activeObjectFilter = null;
      await fetchEntriesPage({ reset: true });
      render();
    });
    headingRow.appendChild(objPill);
  }
  headLeft.appendChild(headingRow);

  if (state.brief?.realm?.scope) {
    const sc = document.createElement("div");
    sc.style.fontSize = "12px";
    sc.style.color = "var(--meru-fg-muted)";
    sc.textContent = state.brief.realm.scope;
    headLeft.appendChild(sc);
  }
  centerHead.appendChild(headLeft);

  const centerActions = document.createElement("div");
  centerActions.className = "header-actions";
  centerActions.appendChild(makeIconButton(ICONS.plus(), t("writeHint"), () => {
    state.writeOpen = true;
    render();
    const inp = document.getElementById("meru-write-title");
    if (inp) inp.focus();
  }, false, "write-btn"));
  centerActions.appendChild(makeIconButton(ICONS.refresh(), t("refreshHint"), () => {
    void refreshAll();
  }, false, "refresh-btn"));
  centerHead.appendChild(centerActions);
  center.appendChild(centerHead);

  const centerScroll = document.createElement("div");
  centerScroll.className = "scroll-body";

  // 1. Untruncated Binding Rules (shown whenever rules exist; preserves RULE-TAIL-SENTINEL invariant)
  const rules = state.brief?.middleMind?.rules?.items || [];
  if (rules.length > 0) {
    const rulesHead = document.createElement("div");
    rulesHead.className = "section-label";
    const rulesTitle = document.createElement("span");
    rulesTitle.textContent = t("rules");
    const rulesCount = document.createElement("span");
    rulesCount.className = "count-num";
    rulesCount.textContent = String(rules.length);
    rulesHead.appendChild(rulesTitle);
    rulesHead.appendChild(rulesCount);
    centerScroll.appendChild(rulesHead);

    const ruleStack = document.createElement("div");
    ruleStack.className = "entry-stack";
    ruleStack.dataset.section = "rules";
    for (const rule of rules) {
      const rRow = document.createElement("div");
      rRow.className = "rule-row";
      rRow.dataset.ruleId = rule.id;
      const rt = document.createElement("span");
      rt.className = "rule-title";
      rt.textContent = rule.title;
      const rtag = document.createElement("span");
      rtag.className = "rule-tag";
      rtag.textContent = rule.inherited ? t("inherited") : t("local");
      rRow.appendChild(rt);
      rRow.appendChild(rtag);
      rRow.addEventListener("click", () => { void selectEntryById(rule.id); });
      ruleStack.appendChild(rRow);
    }
    centerScroll.appendChild(ruleStack);
  }

  // 2. Unified Paginated Entries List (with inline CAS Triage controls when viewing /inbox)
  const isInboxView = state.activeRealmPath === "/inbox";
  const triageTargets = isInboxView ? state.realms.filter((r) => r.path !== "/inbox") : [];

  const entriesHead = document.createElement("div");
  entriesHead.className = "section-label";
  const eTitle = document.createElement("span");
  eTitle.textContent = isInboxView ? t("inboxQueue") : t("entries");
  const eCount = document.createElement("span");
  eCount.className = "count-num";
  eCount.textContent = String(state.entriesTotal);
  entriesHead.appendChild(eTitle);
  entriesHead.appendChild(eCount);
  centerScroll.appendChild(entriesHead);

  const hist = state.brief?.kindHistogram || {};
  const histKinds = Object.entries(hist)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .sort((a, b) => b[1] - a[1]);

  if (histKinds.length > 0) {
    const fBar = document.createElement("div");
    fBar.className = "filter-bar";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "filter-chip" + (state.kindFilter === "" ? " active" : "");
    allBtn.textContent = t("allKinds");
    allBtn.addEventListener("click", async () => {
      if (state.kindFilter === "") return;
      state.kindFilter = "";
      await fetchEntriesPage({ reset: true });
      render();
    });
    fBar.appendChild(allBtn);

    for (const [kindName, count] of histKinds) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "filter-chip" + (state.kindFilter === kindName ? " active" : "");
      chip.dataset.kindFilter = kindName;
      chip.textContent = kindName + " " + count;
      chip.addEventListener("click", async () => {
        state.kindFilter = state.kindFilter === kindName ? "" : kindName;
        await fetchEntriesPage({ reset: true });
        render();
      });
      fBar.appendChild(chip);
    }
    centerScroll.appendChild(fBar);
  }

  const entryStack = document.createElement("div");
  entryStack.className = "entry-stack";
  entryStack.dataset.section = isInboxView ? "inbox-triage" : "entries";

  if (state.entries.length === 0) {
    const emp = document.createElement("div");
    emp.className = "empty-note";
    emp.textContent = t("noEntries");
    entryStack.appendChild(emp);
  } else {
    for (const item of state.entries) {
      const box = document.createElement("div");
      const el = document.createElement("meru-entry");
      el.entry = item;
      el.selected = state.selectedEntry?.id === item.id;
      el.addEventListener("meru-select", () => { void selectEntryById(item.id); });
      box.appendChild(el);

      if (isInboxView && triageTargets.length > 0) {
        const bar = document.createElement("div");
        bar.className = "triage-bar";
        const sel = document.createElement("select");
        sel.className = "triage-select";
        sel.setAttribute("aria-label", "Destination realm for " + item.id);
        for (const tgt of triageTargets) {
          const opt = document.createElement("option");
          opt.value = tgt.path;
          opt.textContent = tgt.path;
          sel.appendChild(opt);
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "action-pill";
        btn.dataset.triageEntry = item.id;
        btn.appendChild(ICONS.move());
        const span = document.createElement("span");
        span.textContent = t("moveLabel");
        btn.appendChild(span);
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await client.inbox.triage(item.id, sel.value, { expectedFromRealmRef: "/inbox" });
            showToast(t("movedToast", { id: item.id, target: sel.value }));
            await refreshAll();
          } catch (err) {
            showToast(err?.message || "Triage failed");
            btn.disabled = false;
          }
        });
        bar.appendChild(sel);
        bar.appendChild(btn);
        box.appendChild(bar);
      }

      entryStack.appendChild(box);
    }
  }
  centerScroll.appendChild(entryStack);

  if (state.entriesNextCursor) {
    const moreWrap = document.createElement("div");
    moreWrap.className = "load-more-wrap";
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "small-btn";
    moreBtn.dataset.ui = "load-more-entries";
    moreBtn.disabled = state.loadingMore;
    moreBtn.textContent = t("loadMore");
    moreBtn.addEventListener("click", async () => {
      state.loadingMore = true;
      moreBtn.disabled = true;
      try {
        await fetchEntriesPage({ reset: false });
      } finally {
        state.loadingMore = false;
        render();
      }
    });
    moreWrap.appendChild(moreBtn);
    centerScroll.appendChild(moreWrap);
  }

  center.appendChild(centerScroll);

  // ---- RIGHT COLUMN: Inspector (<meru-markdown> + Raw + Click-to-Render Static HTML + Chain + CLI) ----
  const right = document.createElement("aside");
  right.className = "col inspector-col";
  const rightHead = document.createElement("div");
  rightHead.className = "col-header";
  const rTitle = document.createElement("strong");
  rTitle.textContent = t("inspector");
  rightHead.appendChild(rTitle);

  if (state.selectedEntry && !state.selectedEntry.redactedAt && state.selectedEntry.status !== "retracted") {
    const bodyForDetect = splitPayloadSection(state.selectedEntry.body ?? state.selectedEntry.snippet ?? "").main;
    const isHtmlCandidate = looksLikeHtmlDocument(bodyForDetect, state.selectedEntry.sourceRef);
    const modeSeg = document.createElement("div");
    modeSeg.className = "seg-group";
    const modes = isHtmlCandidate
      ? [["md", t("viewMd")], ["raw", t("viewRaw")], ["html", t("viewHtml")]]
      : [["md", t("viewMd")], ["raw", t("viewRaw")]];
    for (const [mKey, mLabel] of modes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "seg-btn" + (state.inspectorView === mKey ? " active" : "");
      b.dataset.inspectorMode = mKey;
      b.textContent = mLabel;
      b.addEventListener("click", () => {
        if (state.inspectorView === mKey) return;
        state.inspectorView = mKey;
        render();
      });
      modeSeg.appendChild(b);
    }
    rightHead.appendChild(modeSeg);
  }
  right.appendChild(rightHead);

  const rightScroll = document.createElement("div");
  rightScroll.className = "scroll-body";
  renderInspectorBody(rightScroll);
  right.appendChild(rightScroll);

  shell.appendChild(left);
  shell.appendChild(center);
  shell.appendChild(right);
  app.appendChild(shell);

  // ---- Search Modal (Cmd+K) ----
  const modal = document.createElement("div");
  modal.className = "modal-backdrop" + (state.searchOpen ? " open" : "");
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) {
      state.searchOpen = false;
      render();
    }
  });
  const panel = document.createElement("div");
  panel.className = "modal-panel";

  const inp = document.createElement("input");
  inp.id = "meru-search-input";
  inp.className = "search-input";
  inp.type = "search";
  inp.placeholder = t("searchPlaceholder");
  inp.value = state.searchQuery;
  inp.addEventListener("keydown", async (ev) => {
    if (ev.key === "Escape") {
      state.searchOpen = false;
      render();
    } else if (ev.key === "Enter") {
      state.searchQuery = inp.value.trim();
      if (!state.searchQuery) return;
      try {
        state.searchResults = await client.search(state.searchQuery, { limit: 15 });
        render();
        const again = document.getElementById("meru-search-input");
        if (again) again.focus();
      } catch (err) {
        showToast(err?.message || "Search failed");
      }
    }
  });
  panel.appendChild(inp);

  const resScroll = document.createElement("div");
  resScroll.className = "scroll-body";
  if (state.searchResults?.items?.length) {
    const stack = document.createElement("div");
    stack.className = "entry-stack";
    for (const item of state.searchResults.items) {
      const el = document.createElement("meru-entry");
      el.entry = item;
      el.highlights = state.searchResults.highlights?.[item.id] || null;
      el.addEventListener("meru-select", () => {
        state.searchOpen = false;
        void selectEntryById(item.id);
      });
      stack.appendChild(el);
    }
    resScroll.appendChild(stack);
  }
  panel.appendChild(resScroll);
  modal.appendChild(panel);
  app.appendChild(modal);

  // ---- Quick Write Modal ----
  app.appendChild(renderWriteModal());
}

window.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    state.searchOpen = !state.searchOpen;
    state.writeOpen = false;
    render();
    if (state.searchOpen) {
      const inp = document.getElementById("meru-search-input");
      if (inp) inp.focus();
    }
  } else if (ev.key === "Escape" && (state.searchOpen || state.writeOpen || state.settingsOpen)) {
    state.searchOpen = false;
    state.writeOpen = false;
    state.settingsOpen = false;
    render();
  }
});

client.pump.subscribe((snap) => {
  const prevStatus = state.pumpStatus;
  state.pumpStatus = snap.status;
  if (snap.status === "auth-required") {
    teardownHtmlPreview();
    state.whoami = null;
    render();
    return;
  }
  const lamp = document.querySelector('[data-ui="ws-connection-status"]');
  if (lamp) {
    lamp.dataset.status = snap.status;
    lamp.title = t("realtimeLabel") + ": " + snap.status;
  } else if (prevStatus !== snap.status) {
    render();
  }
  if (snap.lastFrames && snap.lastFrames.length > 0) {
    const selectedId = state.selectedEntry?.id;
    const touchedSelected = selectedId && snap.lastFrames.some((f) => f.entityId === selectedId);
    void refreshAll().then(() => {
      if (touchedSelected) {
        return selectEntryById(selectedId);
      }
    });
  }
});

async function pulseKeepaliveTick() {
  if (!state.whoami || document.visibilityState !== "visible") return;
  try {
    await client.pulse.setFocus([state.activeRealmPath], null, state.activeRealmPath, "browser").catch(() => {});
    const pulseRes = await client.pulse.list().catch(() => null);
    if (pulseRes?.pulses) {
      state.pulses = pulseRes.pulses;
      render();
    }
  } catch {
    // quiet failure on background pulse tick
  }
}

setInterval(() => {
  void pulseKeepaliveTick();
}, 40000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void pulseKeepaliveTick();
  }
});

async function boot() {
  try {
    const sessRes = await fetch("/_meru/session", { credentials: "same-origin" });
    const sess = sessRes.ok ? await sessRes.json() : { authenticated: false };
    if (!sess.authenticated) {
      state.whoami = null;
      render();
      return;
    }
    state.whoami = await client.whoami();
    await refreshAll();
    client.pump.start(state.whoami.latestSeq || 0);
  } catch {
    state.whoami = null;
    render();
  }
}

void boot();
`;
