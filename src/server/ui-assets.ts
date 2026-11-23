/**
 * Server-hosted 1.5-Layer Composable Frontend Assets (v0.4).
 * Zero external npm packages: `/_meru/client.js` and `/_meru/shell` are always version-locked to the running server.
 */

export const CLIENT_JS_SOURCE = `// Meru Mind v0.4 Framework-Agnostic Composable Client (/_meru/client.js)
// Zero dependencies. Works in vanilla HTML, React (useSyncExternalStore), Vue, Svelte, or Solid.

const WS_FAIL_THRESHOLD = 2;
const WS_HANDSHAKE_TIMEOUT_MS = 5000;
const WS_REPROBE_INTERVAL_MS = 5 * 60 * 1000;

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
 * Zero innerHTML — 100% immune to stored XSS.
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
        if (wsFailures >= WS_FAIL_THRESHOLD) {
          void runLongPollLoop();
        } else {
          void runLongPollLoop(); // 5s handshake timeout -> immediate Long-Poll fallback per Hard Condition #6
        }
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
      setFocus: (focus, note = null, realmRef = undefined) =>
        apiRequest("POST", "/v1/pulse", { body: { focus, note, realmRef } }),
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
    background: var(--meru-surface, rgba(255, 255, 255, 0.88));
    border: 1px solid var(--meru-border, rgba(20, 23, 31, 0.1));
    border-radius: var(--meru-radius, 10px);
    padding: 12px 14px;
    transition: border-color 140ms ease, background 140ms ease;
  }
  .card:hover {
    border-color: var(--meru-border-strong, rgba(20, 23, 31, 0.24));
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
    margin-bottom: 6px;
  }
  .meta-left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .kind {
    font-size: 11px;
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
    cursor: pointer;
    word-break: break-word;
  }
  .body {
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--meru-fg-secondary, #3e4552);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .footer {
    margin-top: 8px;
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
    card.className = "card" + (isRedacted ? " redacted" : "");
    card.dataset.entryId = String(e.id || "");

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
    title.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("meru-select", {
        bubbles: true,
        composed: true,
        detail: { entry: e },
      }));
    });
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
`;

export const DEFAULT_SHELL_CSS = `/* Meru Mind Official Default Shell — Monochromatic Two-Tone Liquid Glass */
:root {
  --meru-canvas: #eaeef4;
  --meru-panel: rgba(255, 255, 255, 0.88);
  --meru-surface: rgba(255, 255, 255, 0.94);
  --meru-control: rgba(20, 23, 31, 0.055);
  --meru-floating: rgba(255, 255, 255, 0.98);
  --meru-fg: #14171f;
  --meru-fg-secondary: #3e4552;
  --meru-fg-muted: #667080;
  --meru-accent: #14171f;
  --meru-accent-fg: #ffffff;
  --meru-border: rgba(20, 23, 31, 0.09);
  --meru-border-strong: rgba(20, 23, 31, 0.22);
  --meru-chip-bg: rgba(20, 23, 31, 0.07);
  --meru-radius: 10px;
  --meru-font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
  --meru-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}

:root[data-theme="dark"] {
  --meru-canvas: #090b0e;
  --meru-panel: rgba(22, 26, 35, 0.86);
  --meru-surface: rgba(28, 33, 44, 0.92);
  --meru-control: rgba(255, 255, 255, 0.07);
  --meru-floating: rgba(24, 29, 39, 0.98);
  --meru-fg: #e8ecf4;
  --meru-fg-secondary: #b6c0d0;
  --meru-fg-muted: #7f8b9f;
  --meru-accent: #e8ecf4;
  --meru-accent-fg: #090b0e;
  --meru-border: rgba(232, 236, 244, 0.1);
  --meru-border-strong: rgba(232, 236, 244, 0.24);
  --meru-chip-bg: rgba(232, 236, 244, 0.1);
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
  grid-template-columns: 256px minmax(0, 1fr) 360px;
  gap: 10px;
  height: 100vh;
  padding: 10px;
}

@media (max-width: 1024px) {
  .app-shell { grid-template-columns: 220px minmax(0, 1fr); }
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
}

.col-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--meru-border);
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.brand-name {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.015em;
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
.icon-btn:focus-visible {
  outline: 2px solid var(--meru-accent);
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
  letter-spacing: 0.06em;
  color: var(--meru-fg-muted);
  margin: 14px 0 8px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
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
}
.count-num {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.72;
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
.pulse-dot.idle { background: #9ca3af; }
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
  padding: 10px 12px;
  border-top: 1px solid var(--meru-border);
  flex-shrink: 0;
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
  border-left: 2px solid var(--meru-accent);
  background: var(--meru-control);
  border-radius: 0 8px 8px 0;
  cursor: pointer;
}
.rule-row:hover { border-left-width: 3px; }
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
  padding: 0 10px;
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

.chain-rail {
  border-left: 1.5px solid var(--meru-border-strong);
  margin-left: 6px;
  padding-left: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chain-node {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--meru-control);
  cursor: pointer;
}
.chain-node.head {
  border: 1px solid var(--meru-border-strong);
}

.cli-box {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--meru-control);
  font-family: var(--meru-mono);
  font-size: 11.5px;
  color: var(--meru-fg-secondary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.empty-note {
  font-size: 12.5px;
  color: var(--meru-fg-muted);
  padding: 12px 0;
}

/* Search Modal (Cmd+K) */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(9, 11, 14, 0.42);
  display: none;
  align-items: flex-start;
  justify-content: center;
  padding-top: 10vh;
  z-index: 40;
}
.modal-backdrop.open { display: flex; }
.modal-panel {
  width: min(640px, 92vw);
  max-height: 76vh;
  background: var(--meru-floating);
  border: 1px solid var(--meru-border-strong);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
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

export const DEFAULT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#14171f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18L9.5 6L14 14L17 9.5L21 18H3Z"/><path d="M3 21H21"/></svg>`;

export const DEFAULT_SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Meru Mind — Governance Console</title>
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

export const DEFAULT_SHELL_JS = `// Meru Mind Official Default Shell (/_meru/shell.js)
// Imports ONLY /_meru/client.js — ejectable via \`meru-mind ui eject <dir>\` as a reference template.
import { createMindClient } from "/_meru/client.js";

const COPY = {
  brand: "Meru Mind",
  realms: "Realms",
  pulse: "Active Focus",
  rules: "Binding Rules",
  inboxQueue: "Inbox Triage",
  decisions: "Active Decisions",
  findings: "Recent Findings",
  inspector: "Inspector",
  chain: "Supersede Chain",
  searchPlaceholder: "Search visible memory...",
  noEntries: "No entries in this section.",
  noSelection: "Select an entry to inspect details and supersede history.",
  moveLabel: "Move",
  authTitle: "Sign in via CLI",
  authDesc: "Browser sessions use a 60-second single-use CLI login code (HttpOnly Cookie; read and reversible triage only). Long-lived tokens never enter the browser.",
  cliRestrictionNote: "Irreversible governance actions (redact, rules, mounts, tokens) require a CLI Bearer token.",
};

const SVG_NS = "http://www.w3.org/2000/svg";

function makeSvg(paths, size = 16) {
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
  logo: () => makeSvg(["M3 18L9.5 6L14 14L17 9.5L21 18H3Z", "M3 21H21"], 18),
  search: () => makeSvg(["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "M21 21l-4.3-4.3"], 15),
  refresh: () => makeSvg(["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"], 15),
  theme: () => makeSvg(["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"], 15),
  logout: () => makeSvg(["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"], 15),
  move: () => makeSvg(["M5 12h14", "M13 5l7 7-7 7"], 14),
  close: () => makeSvg(["M18 6L6 18", "M6 6l12 12"], 15),
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

let state = {
  whoami: null,
  realms: [],
  activeRealmPath: "/",
  brief: null,
  inboxEntries: [],
  pulses: [],
  selectedEntry: null,
  selectedChain: null,
  searchOpen: false,
  searchQuery: "",
  searchResults: null,
  pumpStatus: "disconnected",
};

function clearEl(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function renderAuthRequired() {
  clearEl(app);
  const wrap = document.createElement("main");
  wrap.className = "auth-screen";
  const card = document.createElement("section");
  card.className = "auth-card";

  const brand = document.createElement("div");
  brand.className = "brand";
  brand.appendChild(ICONS.logo());
  const bn = document.createElement("span");
  bn.className = "brand-name";
  bn.textContent = COPY.brand;
  brand.appendChild(bn);
  card.appendChild(brand);

  const h = document.createElement("h2");
  h.style.margin = "16px 0 8px";
  h.style.fontSize = "17px";
  h.textContent = COPY.authTitle;
  card.appendChild(h);

  const p = document.createElement("p");
  p.style.margin = "0 0 12px";
  p.style.color = "var(--meru-fg-secondary)";
  p.style.lineHeight = "1.55";
  p.textContent = COPY.authDesc;
  card.appendChild(p);

  const cmd = document.createElement("div");
  cmd.className = "cli-box";
  cmd.textContent = "meru-mind ui login --url " + window.location.origin;
  card.appendChild(cmd);

  wrap.appendChild(card);
  app.appendChild(wrap);
}

async function selectRealm(realmPath) {
  state.activeRealmPath = realmPath;
  const [showRes, lsRes] = await Promise.all([
    client.brief(realmPath),
    realmPath === "/inbox" ? client.ls({ ref: "/inbox", only: "entries", limit: 50 }) : Promise.resolve(null),
  ]);
  state.brief = showRes?.refType === "realm" ? showRes.brief : null;
  if (lsRes) state.inboxEntries = lsRes.items || [];
  await client.pulse.setFocus([realmPath], null, realmPath).catch(() => {});
  const pulseRes = await client.pulse.list().catch(() => null);
  if (pulseRes?.pulses) state.pulses = pulseRes.pulses;
  render();
}

async function selectEntryById(entryId) {
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
  await selectRealm(targetPath);
}

function makeIconButton(iconNode, label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.appendChild(iconNode);
  btn.addEventListener("click", onClick);
  return btn;
}

function render() {
  if (!state.whoami) {
    renderAuthRequired();
    return;
  }

  clearEl(app);
  const shell = document.createElement("div");
  shell.className = "app-shell";

  // ---- LEFT COLUMN: Brand + Realms + Pulse + Single-Row Utility Dock ----
  const left = document.createElement("aside");
  left.className = "col";

  const leftHead = document.createElement("div");
  leftHead.className = "col-header";
  const brand = document.createElement("div");
  brand.className = "brand";
  brand.appendChild(ICONS.logo());
  const bn = document.createElement("span");
  bn.className = "brand-name";
  bn.textContent = COPY.brand;
  brand.appendChild(bn);

  const lamp = document.createElement("span");
  lamp.className = "ws-lamp";
  lamp.dataset.ui = "ws-connection-status";
  lamp.dataset.status = state.pumpStatus;
  lamp.title = "Realtime: " + state.pumpStatus;
  brand.appendChild(lamp);

  leftHead.appendChild(brand);
  leftHead.appendChild(makeIconButton(ICONS.search(), "Search (Cmd+K)", () => {
    state.searchOpen = true;
    render();
    const inp = document.getElementById("meru-search-input");
    if (inp) inp.focus();
  }));
  left.appendChild(leftHead);

  const leftScroll = document.createElement("div");
  leftScroll.className = "scroll-body";

  const rLabel = document.createElement("div");
  rLabel.className = "section-label";
  rLabel.textContent = COPY.realms;
  leftScroll.appendChild(rLabel);

  for (const r of state.realms) {
    const row = document.createElement("div");
    row.className = "realm-item" + (r.path === state.activeRealmPath ? " active" : "");
    row.dataset.realmPath = r.path;
    const pSpan = document.createElement("span");
    pSpan.className = "realm-path";
    pSpan.textContent = r.path;
    row.appendChild(pSpan);
    if (r.path === "/inbox" && state.inboxEntries.length > 0) {
      const cnt = document.createElement("span");
      cnt.className = "count-num";
      cnt.textContent = String(state.inboxEntries.length);
      row.appendChild(cnt);
    }
    row.addEventListener("click", () => { void selectRealm(r.path); });
    leftScroll.appendChild(row);
  }

  const pLabel = document.createElement("div");
  pLabel.className = "section-label";
  pLabel.textContent = COPY.pulse;
  leftScroll.appendChild(pLabel);

  if (state.pulses.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = "—";
    leftScroll.appendChild(empty);
  } else {
    for (const p of state.pulses) {
      const row = document.createElement("div");
      row.className = "pulse-row";
      const dot = document.createElement("span");
      dot.className = "pulse-dot" + (p.online ? "" : " idle");
      const name = document.createElement("span");
      name.className = "pulse-name";
      name.textContent = p.actorId + (p.focus?.length ? (" · " + p.focus[0]) : "");
      name.title = p.note || p.realmPath;
      row.appendChild(dot);
      row.appendChild(name);
      leftScroll.appendChild(row);
    }
  }
  left.appendChild(leftScroll);

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
  dockActions.appendChild(makeIconButton(ICONS.theme(), "Toggle theme", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("meru-theme", next);
  }));
  dockActions.appendChild(makeIconButton(ICONS.logout(), "Sign out", async () => {
    client.pump.stop();
    await client.logout();
    state.whoami = null;
    render();
  }));
  dock.appendChild(actorChip);
  dock.appendChild(dockActions);
  left.appendChild(dock);

  // ---- CENTER COLUMN: Realm L1 Brief (Untruncated Rules + Inbox Triage + Decisions/Findings) ----
  const center = document.createElement("main");
  center.className = "col";

  const centerHead = document.createElement("div");
  centerHead.className = "col-header";
  const headLeft = document.createElement("div");
  const titleSpan = document.createElement("strong");
  titleSpan.style.fontFamily = "var(--meru-mono)";
  titleSpan.textContent = state.activeRealmPath;
  headLeft.appendChild(titleSpan);
  if (state.brief?.realm?.scope) {
    const sc = document.createElement("div");
    sc.style.fontSize = "12px";
    sc.style.color = "var(--meru-fg-muted)";
    sc.textContent = state.brief.realm.scope;
    headLeft.appendChild(sc);
  }
  centerHead.appendChild(headLeft);
  centerHead.appendChild(makeIconButton(ICONS.refresh(), "Refresh", () => { void refreshAll(); }));
  center.appendChild(centerHead);

  const centerScroll = document.createElement("div");
  centerScroll.className = "scroll-body";

  // 1. Untruncated Binding Rules
  const rules = state.brief?.middleMind?.rules?.items || [];
  const rulesHead = document.createElement("div");
  rulesHead.className = "section-label";
  const rulesTitle = document.createElement("span");
  rulesTitle.textContent = COPY.rules;
  const rulesCount = document.createElement("span");
  rulesCount.className = "count-num";
  rulesCount.textContent = String(rules.length);
  rulesHead.appendChild(rulesTitle);
  rulesHead.appendChild(rulesCount);
  centerScroll.appendChild(rulesHead);

  if (rules.length === 0) {
    const emp = document.createElement("div");
    emp.className = "empty-note";
    emp.textContent = COPY.noEntries;
    centerScroll.appendChild(emp);
  } else {
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
      rtag.textContent = rule.inherited ? "inherited" : "local";
      rRow.appendChild(rt);
      rRow.appendChild(rtag);
      rRow.addEventListener("click", () => { void selectEntryById(rule.id); });
      ruleStack.appendChild(rRow);
    }
    centerScroll.appendChild(ruleStack);
  }

  // 2. Inbox Triage Queue (when viewing /inbox)
  if (state.activeRealmPath === "/inbox") {
    const inboxHead = document.createElement("div");
    inboxHead.className = "section-label";
    inboxHead.textContent = COPY.inboxQueue + " (" + state.inboxEntries.length + ")";
    centerScroll.appendChild(inboxHead);

    const targets = state.realms.filter((r) => r.path !== "/inbox");
    const stack = document.createElement("div");
    stack.className = "entry-stack";
    stack.dataset.section = "inbox-triage";

    for (const item of state.inboxEntries) {
      const box = document.createElement("div");
      const el = document.createElement("meru-entry");
      el.entry = item;
      el.addEventListener("meru-select", () => { void selectEntryById(item.id); });
      box.appendChild(el);

      if (targets.length > 0) {
        const bar = document.createElement("div");
        bar.className = "triage-bar";
        const sel = document.createElement("select");
        sel.className = "triage-select";
        sel.setAttribute("aria-label", "Destination realm for " + item.id);
        for (const t of targets) {
          const opt = document.createElement("option");
          opt.value = t.path;
          opt.textContent = t.path;
          sel.appendChild(opt);
        }
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "action-pill";
        btn.dataset.triageEntry = item.id;
        btn.appendChild(ICONS.move());
        const span = document.createElement("span");
        span.textContent = COPY.moveLabel;
        btn.appendChild(span);
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await client.inbox.triage(item.id, sel.value, { expectedFromRealmRef: "/inbox" });
            showToast("Moved " + item.id + " -> " + sel.value);
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
      stack.appendChild(box);
    }
    centerScroll.appendChild(stack);
  }

  // 3. Active Decisions & Recent Findings (rendered via sanitized <meru-entry>)
  const decisions = state.brief?.upperLedger?.activeDecisions?.items || [];
  const findings = state.brief?.upperLedger?.recentFindings?.items || [];

  const decHead = document.createElement("div");
  decHead.className = "section-label";
  decHead.textContent = COPY.decisions + " (" + decisions.length + ")";
  centerScroll.appendChild(decHead);
  const decStack = document.createElement("div");
  decStack.className = "entry-stack";
  for (const d of decisions) {
    const el = document.createElement("meru-entry");
    el.entry = { ...d, realmPath: state.activeRealmPath };
    el.addEventListener("meru-select", () => { void selectEntryById(d.id); });
    decStack.appendChild(el);
  }
  if (decisions.length === 0) {
    const emp = document.createElement("div");
    emp.className = "empty-note";
    emp.textContent = COPY.noEntries;
    decStack.appendChild(emp);
  }
  centerScroll.appendChild(decStack);

  const findHead = document.createElement("div");
  findHead.className = "section-label";
  findHead.textContent = COPY.findings + " (" + findings.length + ")";
  centerScroll.appendChild(findHead);
  const findStack = document.createElement("div");
  findStack.className = "entry-stack";
  for (const f of findings) {
    const el = document.createElement("meru-entry");
    el.entry = { ...f, realmPath: state.activeRealmPath };
    el.addEventListener("meru-select", () => { void selectEntryById(f.id); });
    findStack.appendChild(el);
  }
  if (findings.length === 0) {
    const emp = document.createElement("div");
    emp.className = "empty-note";
    emp.textContent = COPY.noEntries;
    findStack.appendChild(emp);
  }
  centerScroll.appendChild(findStack);
  center.appendChild(centerScroll);

  // ---- RIGHT COLUMN: Inspector + Supersede Chain + CLI Governance Boundary ----
  const right = document.createElement("aside");
  right.className = "col inspector-col";
  const rightHead = document.createElement("div");
  rightHead.className = "col-header";
  const rTitle = document.createElement("strong");
  rTitle.textContent = COPY.inspector;
  rightHead.appendChild(rTitle);
  right.appendChild(rightHead);

  const rightScroll = document.createElement("div");
  rightScroll.className = "scroll-body";
  if (!state.selectedEntry) {
    const emp = document.createElement("div");
    emp.className = "empty-note";
    emp.textContent = COPY.noSelection;
    rightScroll.appendChild(emp);
  } else {
    const entryEl = document.createElement("meru-entry");
    entryEl.entry = state.selectedEntry;
    rightScroll.appendChild(entryEl);

    if (state.selectedChain && state.selectedChain.nodes?.length > 1) {
      const chHead = document.createElement("div");
      chHead.className = "section-label";
      chHead.textContent = COPY.chain + " (" + state.selectedChain.nodes.length + ")";
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
    cliNote.textContent = COPY.cliRestrictionNote;
    rightScroll.appendChild(cliNote);

    const cliBox = document.createElement("div");
    cliBox.className = "cli-box";
    cliBox.textContent = "meru-mind redact " + state.selectedEntry.id + ' --reason "..."';
    rightScroll.appendChild(cliBox);
  }
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
  inp.placeholder = COPY.searchPlaceholder;
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
}

window.addEventListener("keydown", (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    state.searchOpen = !state.searchOpen;
    render();
    if (state.searchOpen) {
      const inp = document.getElementById("meru-search-input");
      if (inp) inp.focus();
    }
  }
});

client.pump.subscribe((snap) => {
  const prevStatus = state.pumpStatus;
  state.pumpStatus = snap.status;
  if (snap.status === "auth-required") {
    state.whoami = null;
    render();
    return;
  }
  const lamp = document.querySelector('[data-ui="ws-connection-status"]');
  if (lamp) {
    lamp.dataset.status = snap.status;
    lamp.title = "Realtime: " + snap.status;
  } else if (prevStatus !== snap.status) {
    render();
  }
  if (snap.lastFrames && snap.lastFrames.length > 0) {
    void refreshAll();
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
