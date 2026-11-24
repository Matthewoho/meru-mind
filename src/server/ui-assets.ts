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
    profile: {
      updateDisplayName: (displayName) =>
        apiRequest("POST", "/v1/me/profile", { body: { displayName } }),
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


/**
 * Meru Mind Sub-Logo (Option A: 12-F1 Obsidian x Deep Sea Blue, dark/light aware).
 */
export const DEFAULT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><style>.l{fill:#1B3A6B}.r{fill:#2E66B8}.t{fill:#14171F}@media(prefers-color-scheme:dark){.l{fill:#3B6CB7}.r{fill:#6CA3F2}.t{fill:#E8EEF7}}</style><polygon class="l" points="34,132 124,132 244,344 154,344"/><polygon class="r" points="366,132 276,132 200,266 244,344"/><polygon class="t" points="78,56 322,56 366,132 34,132"/></svg>`;

export {
  DEFAULT_SHELL_HTML,
  DEFAULT_SHELL_CSS,
  DEFAULT_SHELL_JS,
} from "./ui-shell.generated.js";
