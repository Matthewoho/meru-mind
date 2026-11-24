// Meru Mind Official Built-In Studio UI (v0.5.8)
// Built strictly on the server-hosted `/_meru/client.js` contract (zero direct /v1/* calls, zero innerHTML, strict CSP).
import { createMindClient, applyHighlightRanges, loadMarkdownTools } from "/_meru/client.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function makeMeruSubLogo(size = 18) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 400 400");
  svg.setAttribute("aria-hidden", "true");
  for (const [cls, pts] of [
    ["logo-left", "34,132 124,132 244,344 154,344"],
    ["logo-right", "366,132 276,132 200,266 244,344"],
    ["logo-top", "78,56 322,56 366,132 34,132"],
  ]) {
    const p = document.createElementNS(SVG_NS, "polygon");
    p.setAttribute("class", cls);
    p.setAttribute("points", pts);
    svg.appendChild(p);
  }
  return svg;
}

const STUDIO_I18N = {
  en: {
    realms: "Realms",
    activeFocus: "Active Focus",
    searchPrompt: "Search visible memory...",
    settings: "Settings",
    appearance: "Appearance",
    realtimeAuth: "Realtime & Auth",
    shortcuts: "Shortcuts",
    language: "Language",
    languageDesc: "Switch Studio chrome between English and Simplified Chinese.",
    themeTitle: "Surface Theme",
    themeDesc: "Monochromatic two-tone light or dark liquid glass.",
    md: "MD",
    raw: "Raw",
    html: "HTML",
    htmlNotice: "Static HTML preview (scripts & network disabled).",
    htmlRender: "Render static preview",
    htmlHide: "Show raw source",
    payload: "Structured Payload",
    activeHere: "Active here",
    activeInChildren: "Active in child realms",
    expandRealm: "Expand child realms",
    collapseRealm: "Collapse child realms",
    inFlight: "In Flight",
    people: "People",
    presence: "Presence",
    unkeyedBucket: "Unkeyed",
    collisionNote: "independent sessions working",
    sessionsPlural: "sessions",
    sessionSingle: "session",
    hereTag: "Here",
    loadMoreSessions: "Load more",
    properties: "Properties",
    realmProperties: "Realm",
    objectProperties: "Object",
    openDocument: "Open full document",
    linkedRefs: "Linked Objects & Tags",
    supersedeChain: "Supersede History",
    activePeers: "Active Peers",
    actions: "Actions",
    copyId: "Copy ID",
    copyLink: "Copy link",
    cliMoveCmd: "Copy CLI move command",
    cliRedactCmd: "Copy CLI redact command",
    cliRequiresBearer: "Irreversible or cross-realm governance requires a CLI Bearer token:",
    backToList: "Back to list",
    prevEntry: "Previous entry (K)",
    nextEntry: "Next entry (J)",
    noInFlight: "No active keyed work right now.",
    noPresence: "No active sessions.",
  },
  "zh-CN": {
    realms: "识界",
    activeFocus: "当前在线",
    searchPrompt: "搜索当前可见记忆...",
    settings: "设置",
    appearance: "外观与语言",
    realtimeAuth: "实时同步与认证",
    shortcuts: "快捷键",
    language: "界面语言",
    languageDesc: "在英文与简体中文之间切换界面文案。",
    themeTitle: "外观主题",
    themeDesc: "极简双色浅色 / 深色液态玻璃主题。",
    md: "MD",
    raw: "原文",
    html: "HTML",
    htmlNotice: "静态 HTML 沙箱预览（脚本与外链请求已完全禁用）。",
    htmlRender: "渲染静态预览",
    htmlHide: "查看源码",
    payload: "结构化 Payload",
    activeHere: "同域活跃",
    activeInChildren: "子识界活跃",
    expandRealm: "展开子识界",
    collapseRealm: "折叠子识界",
    inFlight: "按事",
    people: "按身份",
    presence: "当前在线",
    unkeyedBucket: "未挂事",
    collisionNote: "个独立会话同时施工",
    sessionsPlural: "个会话",
    sessionSingle: "个会话",
    hereTag: "当前域",
    loadMoreSessions: "加载更多",
    properties: "属性",
    realmProperties: "识界属性",
    objectProperties: "对象属性",
    openDocument: "在中间展开全文",
    linkedRefs: "关联对象与标签",
    supersedeChain: "演进链",
    activePeers: "同域活跃会话",
    actions: "操作",
    copyId: "复制 ID",
    copyLink: "复制文档链接",
    cliMoveCmd: "复制 CLI 移动命令",
    cliRedactCmd: "复制 CLI 销毁命令",
    cliRequiresBearer: "不可逆治理动作需在终端使用 CLI Bearer Token 执行：",
    backToList: "返回列表",
    prevEntry: "上一条 (K)",
    nextEntry: "下一条 (J)",
    noInFlight: "当前无挂事会话。",
    noPresence: "当前无活跃会话。",
  },
};

function formatPulseAge(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return "";
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60);
  return m < 60 ? (m + "m") : (Math.floor(m / 60) + "h");
}

function shortSessionHandle(sessionId) {
  const cleaned = String(sessionId || "").replace(/^ps_/, "");
  return cleaned ? ("#" + cleaned.slice(0, 4)) : "";
}

function pulseRank(p) {
  return p.online ? 2 : (p.active ? 1 : 0);
}

function groupPulsesByActor(pulses) {
  const byActor = new Map();
  for (const p of pulses || []) {
    const key = String(p.actorId || "unknown");
    let group = byActor.get(key);
    if (!group) {
      group = {
        actorId: key,
        actorKind: p.actorKind || "agent",
        online: false,
        active: false,
        sessions: [],
      };
      byActor.set(key, group);
    }
    group.sessions.push(p);
    if (p.online) group.online = true;
    if (p.active) group.active = true;
  }
  const groups = Array.from(byActor.values());
  for (const g of groups) {
    g.sessions.sort((a, b) => {
      const rankDiff = pulseRank(b) - pulseRank(a);
      if (rankDiff !== 0) return rankDiff;
      return String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
    });
  }
  groups.sort((a, b) => {
    const rankDiff = (b.online ? 2 : (b.active ? 1 : 0)) - (a.online ? 2 : (a.active ? 1 : 0));
    if (rankDiff !== 0) return rankDiff;
    return String(b.sessions[0]?.lastSeenAt || "").localeCompare(String(a.sessions[0]?.lastSeenAt || ""));
  });
  return groups;
}

function detectStudioLang() {
  const saved = localStorage.getItem("meru-studio-lang");
  if (saved === "en" || saved === "zh-CN") return saved;
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function st(key) {
  const dict = STUDIO_I18N[state.lang] || STUDIO_I18N.en;
  return dict[key] ?? STUDIO_I18N.en[key] ?? key;
}

function looksLikeHtmlDoc(text, sourceRef) {
  if (typeof sourceRef === "string" && /\.html?$/i.test(sourceRef.trim())) return true;
  return /^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<div\b|<section\b|<article\b|<main\b|<table\b|<style\b)/i.test(String(text || "").trim());
}

let activeStudioHtmlPreview = null;
function teardownStudioHtmlPreview() {
  if (activeStudioHtmlPreview) {
    try { activeStudioHtmlPreview.teardown(); } catch {}
    activeStudioHtmlPreview = null;
  }
}

function makeSvg(paths, size = 16, strokeWidth = 1.5) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

const ICONS = {
  logo: () => makeMeruSubLogo(18),
  realm: () => makeSvg(["M3 7.5A2 2 0 0 1 5 5.5h4.2l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-10Z"], 14),
  inbox: () => makeSvg(["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"], 14),
  user: () => makeSvg(["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2", "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"], 12),
  search: () => makeSvg(["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "M21 21l-4.35-4.35"], 15),
  plus: () => makeSvg(["M12 5v14", "M5 12h14"], 15),
  refresh: () => makeSvg(["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"], 15),
  panelRight: () => makeSvg(["M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Z", "M15 3v18"], 15),
  settings: () => makeSvg([
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z",
  ], 15),
  dots: () => makeSvg(["M5 12h.01", "M12 12h.01", "M19 12h.01"], 14, 2.2),
  copy: () => makeSvg(["M8 8h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z", "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"], 14),
  arrowRight: () => makeSvg(["M5 12h14", "M13 6l6 6-6 6"], 14),
  arrowLeft: () => makeSvg(["M19 12H5", "M11 18l-6-6 6-6"], 13),
  close: () => makeSvg(["M18 6L6 18", "M6 6l12 12"], 15),
  menu: () => makeSvg(["M4 7h16", "M4 12h16", "M4 17h16"], 16),
  logout: () => makeSvg(["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"], 14),
  work: () => makeSvg(["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 9a9 9 0 0 1-9 9"], 13),
  collision: () => makeSvg(["M16 3h5v5", "M4 20L21 3", "M21 16v5h-5", "M15 15l6 6", "M4 4l5 5"], 13),
  chevronRight: () => makeSvg(["M9 6l6 6-6 6"], 12),
  chevronDown: () => makeSvg(["M6 9l6 6 6-6"], 12),
  chevronUp: () => makeSvg(["M18 15l-6-6-6 6"], 14),
  link: () => makeSvg(["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"], 14),
  terminal: () => makeSvg(["M4 17l6-6-6-6", "M12 19h8"], 14),
  bookOpen: () => makeSvg(["M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z", "M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"], 14),
};

const app = document.getElementById("app");
const client = createMindClient();

const savedTheme = localStorage.getItem("meru-studio-theme") || "light";
document.documentElement.dataset.theme = savedTheme;

const ACTOR_SESSION_PAGE_SIZE = 5;

const state = {
  lang: detectStudioLang(),
  readerView: "md", // md | raw | html
  whoami: null,
  realms: [],
  realmTree: [],
  collapsedRealmIds: new Set(),
  collapsedLoadedForOrgId: null,
  realmCounts: {}, // path -> { directRules, directConclusions, subtreeConclusions, directObjects, subtreeObjects, childRealmsCount }
  hasInboxRealm: false,
  activeRealmPath: "/",
  activeTab: "overview", // overview | conclusions | objects | rules | inbox
  brief: null,
  realmEntries: [],
  realmEntriesHasMore: false,
  realmEntriesCursor: null,
  realmObjects: [],
  objectFilter: "",
  showLedgerHistory: false,
  inboxEntries: [],
  pulses: [],
  inFlight: [],
  unkeyedCount: 0,
  selfPulseSessionId: null,
  presenceCollapsed: false,
  presenceMode: "people", // "in-flight" | "people"
  presenceModeUserSet: false,
  collapsedActorIds: new Set(),
  actorVisibleCounts: new Map(), // actorId -> visible session count
  presenceHovered: false,
  pendingPulsePatch: null,
  presenceScrollTop: 0,
  openEntry: null, // entry opened full-width in Center Document Reader
  focusedEntryId: null, // list row focused via J/K (or matching openEntry)
  focusedEntry: null, // entry shown in Right Properties Rail
  selectedChain: null,
  selectedObject: null,
  previousObject: null,
  railCliCommand: null, // { label, cmd } shown ONLY on explicit action or 403
  savedListScrollTop: 0,
  restoreListScrollPending: false,
  inspectorOpen: window.innerWidth > 1120,
  mobileNavOpen: false,
  pumpStatus: "disconnected",
  pumpGeneration: null,
  pumpCursorSeq: 0,
  lastSyncedAt: null,
  modal: null, // null | "search" | "write" | "settings"
  settingsTab: "appearance",
  searchQuery: "",
  searchResults: null,
  writeKind: "finding",
  writeTitle: "",
  writeBody: "",
  writeSubmitting: false,
  writeError: null,
  popover: null,
};

function clearEl(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = String(msg);
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 3200);
}

async function copyText(text, label = "Copied command") {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label);
  } catch {
    showToast("Copy unavailable in this context");
  }
}

function makeIconBtn(iconEl, label, onClick, extraClass = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "meru-icon-btn" + (extraClass ? " " + extraClass : "");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.appendChild(iconEl);
  btn.addEventListener("click", onClick);
  return btn;
}

function formatStamp(iso) {
  if (!iso) return "-";
  return String(iso).slice(0, 16).replace("T", " ");
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}

function pathDepth(p) {
  if (!p || p === "/") return 0;
  return p.split("/").filter(Boolean).length;
}

function realmDisplayName(realm) {
  if (!realm) return "Root";
  if (realm.path === "/") return realm.name || "Organization Root";
  return realm.name || realm.path.slice(1);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("meru-studio-theme", theme);
}

function getOrgId() {
  return state.whoami?.org?.id || state.whoami?.organization?.id || "default";
}

function getOrgName() {
  return state.whoami?.org?.name || state.whoami?.organization?.name || "Workspace";
}

function getOrgPolicy() {
  return state.whoami?.org?.policy || state.whoami?.organization?.policy || null;
}

function collapsedStorageKey(orgId) {
  return "meru-studio-collapsed-realms:" + String(orgId || "default");
}

function ensureCollapsedRealmsLoaded() {
  const orgId = getOrgId();
  if (state.collapsedLoadedForOrgId === orgId) return;
  state.collapsedLoadedForOrgId = orgId;
  const next = new Set();
  try {
    const raw = localStorage.getItem(collapsedStorageKey(orgId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === "string" && id.trim()) next.add(id);
        }
      }
    }
  } catch {
    // ignore corrupt localStorage entry
  }
  state.collapsedRealmIds = next;
}

function persistCollapsedRealms() {
  const orgId = getOrgId();
  try {
    localStorage.setItem(
      collapsedStorageKey(orgId),
      JSON.stringify(Array.from(state.collapsedRealmIds)),
    );
  } catch {
    // ignore storage quota errors
  }
}

function toggleRealmCollapsed(realmId) {
  if (!realmId) return;
  ensureCollapsedRealmsLoaded();
  if (state.collapsedRealmIds.has(realmId)) {
    state.collapsedRealmIds.delete(realmId);
  } else {
    state.collapsedRealmIds.add(realmId);
  }
  persistCollapsedRealms();
  render();
}

function getEffectiveRealmTree() {
  if (Array.isArray(state.realmTree) && state.realmTree.length > 0) {
    return state.realmTree;
  }
  const byId = new Map();
  for (const r of state.realms || []) {
    byId.set(r.id, { realm: r, counts: state.realmCounts[r.path] || {}, children: [] });
  }
  const roots = [];
  for (const node of byId.values()) {
    const pid = node.realm.parentId;
    if (pid && byId.has(pid)) {
      byId.get(pid).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function expandAncestorsForPath(targetPath) {
  if (!targetPath) return;
  ensureCollapsedRealmsLoaded();
  const ancestors = [];
  function walk(nodes, chain) {
    for (const node of nodes || []) {
      if (node.realm?.path === targetPath) {
        for (const id of chain) ancestors.push(id);
        return true;
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        if (walk(node.children, [...chain, node.realm.id])) return true;
      }
    }
    return false;
  }
  walk(getEffectiveRealmTree(), []);
  let changed = false;
  for (const id of ancestors) {
    if (state.collapsedRealmIds.has(id)) {
      state.collapsedRealmIds.delete(id);
      changed = true;
    }
  }
  if (changed) persistCollapsedRealms();
}

function collectActiveDescendantPaths(node, activeSet, out = []) {
  for (const child of node.children || []) {
    if (child.realm?.path && activeSet.has(child.realm.path)) {
      out.push(child.realm.path);
    }
    collectActiveDescendantPaths(child, activeSet, out);
  }
  return out;
}

function flattenRealmTreeCounts(nodes, out = {}) {
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes) {
    if (n?.realm?.path) {
      out[n.realm.path] = n.counts || {};
    }
    if (Array.isArray(n?.children)) {
      flattenRealmTreeCounts(n.children, out);
    }
  }
  return out;
}

function collectOverviewConclusions(brief, fallbackEntries) {
  const seen = new Set();
  const list = [];
  const pushAll = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (!item?.id || seen.has(item.id)) continue;
      if (item.kind === "rule") continue;
      seen.add(item.id);
      list.push(item);
    }
  };
  pushAll(brief?.upperLedger?.activeDecisions?.items);
  pushAll(brief?.upperLedger?.recentFindings?.items);
  pushAll(brief?.recentConclusions?.items);
  if (list.length === 0) {
    pushAll(fallbackEntries);
  }
  return list;
}

/* ==================== URL as Single Source of Truth ==================== */

function isReservedShellPath(pathname) {
  return pathname === "/_meru/shell" || pathname === "/_meru/shell/";
}

function normalizeRealmPathname(rawPath) {
  if (!rawPath || rawPath === "/" || rawPath === "/index.html") return "/";
  const trimmed = rawPath.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
}

function parseUrlState() {
  const loc = window.location;
  const sp = new URLSearchParams(loc.search);
  const onShell = isReservedShellPath(loc.pathname);
  const realmPath = onShell
    ? normalizeRealmPathname(sp.get("realm") || "/")
    : normalizeRealmPathname(loc.pathname);
  const rawTab = sp.get("tab") || "";
  const validTabs = new Set(["overview", "conclusions", "objects", "rules", "inbox"]);
  const tab = validTabs.has(rawTab) ? rawTab : null;
  const entryId = sp.get("entry") || null;
  const objectRef = sp.get("object") || null;
  const rawView = sp.get("view") || "";
  const view = (rawView === "md" || rawView === "raw" || rawView === "html") ? rawView : null;
  return { realmPath, tab, entryId, objectRef, view };
}

function buildUrlFromState() {
  const onShell = isReservedShellPath(window.location.pathname);
  const basePath = onShell ? "/_meru/shell" : (state.activeRealmPath || "/");
  const sp = new URLSearchParams();
  if (onShell && state.activeRealmPath && state.activeRealmPath !== "/") {
    sp.set("realm", state.activeRealmPath);
  }
  const defaultTab = state.activeRealmPath === "/inbox" ? "inbox" : "overview";
  if (state.activeTab && state.activeTab !== defaultTab) {
    sp.set("tab", state.activeTab);
  }
  if (state.openEntry?.id) {
    sp.set("entry", state.openEntry.id);
    if (state.readerView && state.readerView !== "md") {
      sp.set("view", state.readerView);
    }
  } else if (state.selectedObject?.ref) {
    sp.set("object", state.selectedObject.ref);
  }
  const qs = sp.toString();
  return qs ? (basePath + "?" + qs) : basePath;
}

function syncUrlFromState(replace = false) {
  try {
    const nextUrl = buildUrlFromState();
    const currentUrl = window.location.pathname + window.location.search;
    if (nextUrl === currentUrl) return;
    if (replace) {
      window.history.replaceState({ meru: true }, "", nextUrl);
    } else {
      window.history.pushState({ meru: true }, "", nextUrl);
    }
  } catch {
    // ignore history API errors in restricted contexts
  }
}

function getVisibleListEntries() {
  if (state.activeTab === "overview") {
    const conclusions = collectOverviewConclusions(state.brief, state.realmEntries);
    const rules = state.brief?.middleMind?.rules?.items || [];
    return [...conclusions, ...rules];
  }
  if (state.activeTab === "conclusions") {
    return state.realmEntries.filter((x) => x.kind !== "rule");
  }
  if (state.activeTab === "rules") {
    return state.brief?.middleMind?.rules?.items || [];
  }
  if (state.activeTab === "inbox") {
    return state.inboxEntries || [];
  }
  return [];
}

function applyPulsePayload(pulseRes, deferIfHovered = false) {
  if (!pulseRes || !Array.isArray(pulseRes.pulses)) return;
  if (deferIfHovered && state.presenceHovered) {
    state.pendingPulsePatch = pulseRes;
    return;
  }
  state.pendingPulsePatch = null;
  state.pulses = pulseRes.pulses;
  state.inFlight = Array.isArray(pulseRes.inFlight) ? pulseRes.inFlight : [];
  state.unkeyedCount = typeof pulseRes.unkeyedCount === "number" ? pulseRes.unkeyedCount : 0;
  if (!state.presenceModeUserSet) {
    state.presenceMode = state.inFlight.length > 0 ? "in-flight" : "people";
  }
}

/* ==================== Data Loading ==================== */

async function loadRealmEntries(realmPath, reset = true) {
  const limit = 25;
  const res = await client.ls({
    ref: realmPath,
    only: "entries",
    limit,
    cursor: reset ? undefined : (state.realmEntriesCursor || undefined),
    history: state.showLedgerHistory ? "true" : undefined,
  }).catch(() => ({ items: [] }));
  const batch = res?.items || [];
  if (reset) {
    state.realmEntries = batch;
  } else {
    const seen = new Set(state.realmEntries.map((x) => x.id));
    for (const item of batch) {
      if (!seen.has(item.id)) state.realmEntries.push(item);
    }
  }
  state.realmEntriesCursor = res?.nextCursor || null;
  state.realmEntriesHasMore = Boolean(state.realmEntriesCursor);
}

async function selectRealm(realmPath, preferredTab, opts = {}) {
  const prevRealm = state.activeRealmPath;
  state.activeRealmPath = realmPath;
  expandAncestorsForPath(realmPath);
  state.mobileNavOpen = false;
  state.popover = null;
  state.objectFilter = "";
  if (!opts.keepReader) {
    teardownStudioHtmlPreview();
    state.openEntry = null;
    state.railCliCommand = null;
    if (prevRealm !== realmPath) {
      state.focusedEntryId = null;
      state.focusedEntry = null;
      state.selectedChain = null;
      state.selectedObject = null;
      state.previousObject = null;
      state.savedListScrollTop = 0;
    }
  }
  if (preferredTab) {
    state.activeTab = preferredTab;
  } else if (realmPath === "/inbox") {
    state.activeTab = "inbox";
  } else {
    state.activeTab = "overview";
  }

  const [showRes, objRes, inboxRes] = await Promise.all([
    client.brief(realmPath),
    client.ls({ ref: realmPath, only: "objects", limit: 120 }).catch(() => ({ objects: [] })),
    realmPath === "/inbox"
      ? client.ls({ ref: "/inbox", only: "entries", limit: 50 }).catch(() => ({ items: [] }))
      : Promise.resolve(null),
  ]);
  await loadRealmEntries(realmPath, true);

  state.brief = showRes?.refType === "realm" ? showRes.brief : null;
  state.realmObjects = (objRes?.objects || objRes?.items || []).filter((o) => o.kind !== "category");
  if (inboxRes) state.inboxEntries = inboxRes.items || [];
  state.lastSyncedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const selfPulse = await client.pulse.setFocus([realmPath], null, realmPath, "browser").catch(() => null);
  if (selfPulse?.sessionId) state.selfPulseSessionId = selfPulse.sessionId;
  const pulseRes = await client.pulse.list().catch(() => null);
  if (pulseRes?.pulses) {
    applyPulsePayload(pulseRes, false);
  }
  if (!opts.skipUrlSync) {
    syncUrlFromState(Boolean(opts.replaceUrl));
  }
  render();
}

async function selectObjectByRef(objRef, openInspector = true, opts = {}) {
  try {
    const res = await client.show(objRef);
    if (res?.refType === "object" && res.card) {
      teardownStudioHtmlPreview();
      state.selectedObject = res.card;
      state.previousObject = null;
      state.openEntry = null;
      state.focusedEntryId = null;
      state.focusedEntry = null;
      state.selectedChain = null;
      state.railCliCommand = null;
      if (openInspector) state.inspectorOpen = true;
      if (!opts.skipUrlSync) syncUrlFromState(Boolean(opts.replaceUrl));
      render();
    }
  } catch (err) {
    showToast(err?.message || "Failed to load object");
  }
}

async function fetchFlatEntry(entryId) {
  const [showRes, chainRes] = await Promise.all([
    client.show(entryId, { full: true }),
    entryId.startsWith("rec_") ? client.chain(entryId).catch(() => null) : Promise.resolve(null),
  ]);
  if (showRes?.refType !== "entry") return null;
  const e = showRes.entry;
  const flat = e.kind === "record"
    ? { ...e.record, realmPath: e.realmPath, body: showRes.content }
    : e.kind === "seabed"
      ? { ...e.seabed, realmPath: e.realmPath, title: e.seabed.kind + ":" + e.seabed.id, body: showRes.content }
      : { id: entryId, title: entryId, body: showRes.content };
  return { flat, chainRes };
}

function pickInitialReaderView(flat, requestedView) {
  const rawBody = String(flat?.body || flat?.snippet || "");
  const payloadIdx = rawBody.indexOf("\n## Payload\n");
  const mainBody = payloadIdx >= 0 ? rawBody.slice(0, payloadIdx).trim() : rawBody;
  const isHtmlDoc = looksLikeHtmlDoc(mainBody, flat?.sourceRef);
  if (requestedView === "raw") return "raw";
  if (requestedView === "html" && isHtmlDoc) return "html";
  if (requestedView === "md") return "md";
  return isHtmlDoc ? "html" : "md";
}

async function openEntryInCenter(entryId, opts = {}) {
  try {
    if (!state.openEntry) {
      const wsScroll = document.querySelector(".workspace-scroll");
      if (wsScroll) state.savedListScrollTop = wsScroll.scrollTop;
    }
    const fetched = await fetchFlatEntry(entryId);
    if (!fetched) return;
    const { flat, chainRes } = fetched;
    if (opts.fromObject && state.selectedObject) {
      state.previousObject = state.selectedObject;
    } else if (!opts.fromObject) {
      state.previousObject = null;
    }
    state.selectedObject = null;
    state.openEntry = flat;
    state.focusedEntryId = flat.id;
    state.focusedEntry = flat;
    state.selectedChain = chainRes;
    state.railCliCommand = null;
    state.readerView = pickInitialReaderView(flat, opts.requestedView || null);
    if (flat.realmPath && state.realms.some((r) => r.path === flat.realmPath)) {
      expandAncestorsForPath(flat.realmPath);
    }
    if (!opts.skipUrlSync) {
      syncUrlFromState(Boolean(opts.replaceUrl));
    }
    render();
  } catch (err) {
    showToast(err?.message || "Failed to load entry");
  }
}

function closeReaderToList(opts = {}) {
  if (!state.openEntry) return;
  teardownStudioHtmlPreview();
  state.openEntry = null;
  state.railCliCommand = null;
  state.restoreListScrollPending = true;
  if (!opts.skipUrlSync) {
    syncUrlFromState(Boolean(opts.replaceUrl));
  }
  render();
}

async function focusEntryInList(entryId, summaryHint = null) {
  state.focusedEntryId = entryId;
  state.selectedObject = null;
  state.railCliCommand = null;
  if (summaryHint) {
    state.focusedEntry = summaryHint;
  }
  render();
  // Scroll focused card/row smoothly into view
  requestAnimationFrame(() => {
    const rowEl = document.querySelector('[data-list-entry-id="' + CSS.escape(entryId) + '"]');
    if (rowEl && typeof rowEl.scrollIntoView === "function") {
      rowEl.scrollIntoView({ block: "nearest" });
    }
  });
  try {
    const fetched = await fetchFlatEntry(entryId);
    if (!fetched || state.focusedEntryId !== entryId) return;
    state.focusedEntry = fetched.flat;
    state.selectedChain = fetched.chainRes;
    render();
  } catch {
    // keep summary hint if full fetch fails quietly
  }
}

async function selectEntryById(entryId, _openInspector = true, fromObject = false) {
  await openEntryInCenter(entryId, { fromObject });
}

async function refreshAll(opts = {}) {
  ensureCollapsedRealmsLoaded();
  const [treeRes, pulseRes] = await Promise.all([
    client.tree({ ref: "/", depth: "all", objects: false }),
    client.pulse.list().catch(() => ({ pulses: [] })),
  ]);
  state.realms = treeRes.realms || [];
  state.realmTree = Array.isArray(treeRes.realmTree) ? treeRes.realmTree : [];
  state.realmCounts = flattenRealmTreeCounts(state.realmTree);
  applyPulsePayload(pulseRes, false);
  state.hasInboxRealm = state.realms.some((r) => r.path === "/inbox");
  if (state.hasInboxRealm) {
    const lsInbox = await client.ls({ ref: "/inbox", only: "entries", limit: 50 }).catch(() => ({ items: [] }));
    state.inboxEntries = lsInbox.items || [];
  } else {
    state.inboxEntries = [];
  }
  const desiredRealm = opts.realmPath || state.activeRealmPath;
  const targetPath = state.realms.some((r) => r.path === desiredRealm)
    ? desiredRealm
    : (state.realms[0]?.path || "/");
  await selectRealm(targetPath, opts.tab || state.activeTab, {
    keepReader: Boolean(opts.keepReader ?? state.openEntry),
    skipUrlSync: Boolean(opts.skipUrlSync),
    replaceUrl: Boolean(opts.replaceUrl),
  });
}

/* ==================== Component Builders ==================== */

function renderAuthScreen() {
  clearEl(app);
  const screen = document.createElement("main");
  screen.className = "auth-screen";
  const card = document.createElement("section");
  card.className = "auth-card";

  const brand = document.createElement("div");
  brand.className = "brand-identity";
  const mark = document.createElement("span");
  mark.className = "brand-mark";
  mark.appendChild(ICONS.logo());
  const word = document.createElement("span");
  word.className = "brand-wordmark";
  word.textContent = "Meru Mind";
  brand.appendChild(mark);
  brand.appendChild(word);
  card.appendChild(brand);

  const h1 = document.createElement("h1");
  h1.className = "auth-title";
  h1.textContent = "Sign in via CLI";
  card.appendChild(h1);

  const p = document.createElement("p");
  p.className = "auth-desc";
  p.textContent = "Browser sessions use a 60-second single-use CLI login link (HttpOnly Cookie; read and reversible actions only). Long-lived tokens stay in your terminal.";
  card.appendChild(p);

  const cmdText = "meru-mind ui login --url " + window.location.origin;
  const cmdRow = document.createElement("div");
  cmdRow.className = "cli-cmd-row";
  const code = document.createElement("code");
  code.className = "cli-cmd-text";
  code.textContent = cmdText;
  cmdRow.appendChild(code);
  cmdRow.appendChild(makeIconBtn(ICONS.copy(), "Copy login command", () => copyText(cmdText)));
  card.appendChild(cmdRow);

  screen.appendChild(card);
  app.appendChild(screen);
}

function buildSidebar() {
  const aside = document.createElement("aside");
  aside.className = "studio-sidebar";

  const brandBar = document.createElement("div");
  brandBar.className = "brand-bar";

  const identity = document.createElement("div");
  identity.className = "brand-identity";
  const mark = document.createElement("span");
  mark.className = "brand-mark";
  mark.appendChild(ICONS.logo());
  const word = document.createElement("span");
  word.className = "brand-wordmark";
  word.textContent = "Meru Mind";
  const lamp = document.createElement("span");
  lamp.className = "ws-lamp";
  lamp.dataset.ui = "ws-connection-status";
  lamp.dataset.status = state.pumpStatus;
  lamp.title = "Realtime transport: " + state.pumpStatus;
  identity.appendChild(mark);
  identity.appendChild(word);
  identity.appendChild(lamp);
  brandBar.appendChild(identity);
  aside.appendChild(brandBar);

  const scroll = document.createElement("div");
  scroll.className = "sidebar-scroll sidebar-realms-scroll";

  const realmLabel = document.createElement("div");
  realmLabel.className = "nav-group-label";
  realmLabel.textContent = st("realms");
  scroll.appendChild(realmLabel);

  ensureCollapsedRealmsLoaded();
  const activeRealmSet = new Set();
  for (const p of state.pulses || []) {
    if (!p.active || p.sessionId === state.selfPulseSessionId) continue;
    if (p.realmPath) activeRealmSet.add(p.realmPath);
  }

  function appendRealmTreeNode(node, depth) {
    const r = node.realm;
    if (!r) return;
    const children = Array.isArray(node.children) ? node.children : [];
    const hasChildren = children.length > 0;
    const isCollapsed = hasChildren && state.collapsedRealmIds.has(r.id);
    const effectiveDepth = r.path === "/inbox" ? 0 : Math.min(depth, 5);

    const row = document.createElement("div");
    row.className = "realm-row realm-depth-" + effectiveDepth + (r.path === state.activeRealmPath ? " active" : "");
    row.dataset.realmPath = r.path;
    row.dataset.realmId = r.id;

    if (hasChildren) {
      const chev = document.createElement("button");
      chev.type = "button";
      chev.className = "realm-chevron-btn";
      chev.dataset.ui = "realm-chevron";
      chev.dataset.realmId = r.id;
      chev.dataset.realmPath = r.path;
      chev.setAttribute("aria-expanded", String(!isCollapsed));
      const chevLabel = (isCollapsed ? st("expandRealm") : st("collapseRealm")) + ": " + r.path;
      chev.title = chevLabel;
      chev.setAttribute("aria-label", chevLabel);
      chev.appendChild(isCollapsed ? ICONS.chevronRight() : ICONS.chevronDown());
      chev.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleRealmCollapsed(r.id);
      });
      row.appendChild(chev);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "realm-chevron-spacer";
      spacer.setAttribute("aria-hidden", "true");
      row.appendChild(spacer);
    }

    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.className = "realm-select-btn";
    selectBtn.dataset.realmPath = r.path;

    const left = document.createElement("span");
    left.className = "realm-row-left";
    const ico = document.createElement("span");
    ico.className = "realm-icon";
    ico.appendChild(r.path === "/inbox" ? ICONS.inbox() : ICONS.realm());
    const name = document.createElement("span");
    name.className = "realm-label";
    if (r.path === "/") {
      name.textContent = "Root (/)";
    } else if (pathDepth(r.path) >= 2) {
      name.textContent = r.slug || r.path.split("/").pop();
    } else {
      name.textContent = r.path;
    }
    name.title = r.name + " (" + r.path + ")";
    left.appendChild(ico);
    left.appendChild(name);
    selectBtn.appendChild(left);

    const rightMeta = document.createElement("span");
    rightMeta.className = "realm-row-right";
    const directActive = activeRealmSet.has(r.path);
    const activeDescendants = isCollapsed
      ? collectActiveDescendantPaths(node, activeRealmSet)
      : [];
    if (directActive || activeDescendants.length > 0) {
      const liveDot = document.createElement("span");
      liveDot.className = "status-dot realm-live-dot";
      liveDot.dataset.ui = "realm-live-dot";
      if (!directActive && activeDescendants.length > 0) {
        liveDot.dataset.inherited = "true";
        liveDot.title = st("activeInChildren") + ": " + activeDescendants.join(", ");
      } else {
        liveDot.title = st("activeHere");
      }
      rightMeta.appendChild(liveDot);
    }

    const rc = state.realmCounts[r.path] || node.counts;
    if (r.path === "/inbox" && state.inboxEntries.length > 0) {
      const cnt = document.createElement("span");
      cnt.className = "queue-count";
      cnt.textContent = String(state.inboxEntries.length);
      rightMeta.appendChild(cnt);
    } else if (rc && (rc.subtreeConclusions || rc.directConclusions)) {
      const cnt = document.createElement("span");
      cnt.className = "realm-count-muted";
      cnt.textContent = fmtNum(
        r.path === "/" || isCollapsed
          ? (rc.subtreeConclusions || rc.directConclusions)
          : (rc.directConclusions || rc.subtreeConclusions),
      );
      rightMeta.appendChild(cnt);
    }
    if (rightMeta.childNodes.length > 0) {
      selectBtn.appendChild(rightMeta);
    }

    selectBtn.addEventListener("click", () => { void selectRealm(r.path); });
    row.appendChild(selectBtn);
    scroll.appendChild(row);

    if (hasChildren && !isCollapsed) {
      for (const child of children) {
        appendRealmTreeNode(child, effectiveDepth + 1);
      }
    }
  }

  for (const rootNode of getEffectiveRealmTree()) {
    appendRealmTreeNode(rootNode, 0);
  }

  aside.appendChild(scroll);

  // Unified Presence Pane (collapsible section, capped at 40% height, independent scroll, hover-frozen)
  const inFlight = state.inFlight || [];
  const unkeyedPulses = (state.pulses || []).filter((p) => !p.keys || p.keys.length === 0);
  const actorGroups = groupPulsesByActor(state.pulses);

  const presencePane = document.createElement("section");
  presencePane.className = "presence-pane" + (state.presenceCollapsed ? " collapsed" : "");
  presencePane.dataset.ui = "presence-pane";
  presencePane.addEventListener("mouseenter", () => {
    state.presenceHovered = true;
  });
  presencePane.addEventListener("mouseleave", () => {
    state.presenceHovered = false;
    if (state.pendingPulsePatch) {
      const pending = state.pendingPulsePatch;
      applyPulsePayload(pending, false);
      render();
    }
  });

  const presenceHeader = document.createElement("div");
  presenceHeader.className = "presence-header";

  const toggleSectionBtn = document.createElement("button");
  toggleSectionBtn.type = "button";
  toggleSectionBtn.className = "presence-collapse-btn";
  toggleSectionBtn.dataset.ui = "presence-section-toggle";
  toggleSectionBtn.setAttribute("aria-expanded", String(!state.presenceCollapsed));
  toggleSectionBtn.appendChild(state.presenceCollapsed ? ICONS.chevronRight() : ICONS.chevronDown());
  const pLbl = document.createElement("span");
  pLbl.textContent = st("presence");
  toggleSectionBtn.appendChild(pLbl);
  if (state.pulses.length > 0) {
    const totalCnt = document.createElement("span");
    totalCnt.className = "realm-count-muted";
    totalCnt.textContent = String(state.pulses.length);
    toggleSectionBtn.appendChild(totalCnt);
  }
  toggleSectionBtn.addEventListener("click", () => {
    state.presenceCollapsed = !state.presenceCollapsed;
    render();
  });
  presenceHeader.appendChild(toggleSectionBtn);

  if (!state.presenceCollapsed) {
    const seg = document.createElement("div");
    seg.className = "presence-seg";
    seg.dataset.ui = "presence-mode-switch";
    for (const [mKey, mLbl] of [["in-flight", st("inFlight")], ["people", st("people")]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "presence-seg-btn" + (state.presenceMode === mKey ? " active" : "");
      b.dataset.presenceMode = mKey;
      b.textContent = mLbl;
      b.addEventListener("click", () => {
        if (state.presenceMode === mKey) return;
        state.presenceMode = mKey;
        state.presenceModeUserSet = true;
        state.presenceScrollTop = 0;
        render();
      });
      seg.appendChild(b);
    }
    presenceHeader.appendChild(seg);
  }
  presencePane.appendChild(presenceHeader);

  if (!state.presenceCollapsed) {
    const pScroll = document.createElement("div");
    pScroll.className = "presence-scroll";
    pScroll.dataset.ui = "presence-scroll";

    if (state.presenceMode === "in-flight") {
      if (inFlight.length === 0 && unkeyedPulses.length === 0) {
        const empty = document.createElement("div");
        empty.className = "presence-empty";
        empty.textContent = st("noInFlight");
        pScroll.appendChild(empty);
      } else {
        for (const w of inFlight.slice(0, 12)) {
          const row = document.createElement("div");
          row.className = "member-row work-flight-row" + (w.hasCollision ? " has-collision" : "");
          row.dataset.workKey = w.key;
          row.tabIndex = 0;

          const left = document.createElement("div");
          left.className = "member-left";
          const av = document.createElement("span");
          av.className = "member-avatar" + (w.hasCollision ? " collision" : "");
          av.appendChild(w.hasCollision ? ICONS.collision() : ICONS.work());
          const nm = document.createElement("span");
          nm.className = "member-name";
          nm.textContent = w.label;
          const anyOnline = w.participants.some((p) => p.online || p.state === "working");
          const anyActive = w.participants.some((p) => p.active);
          const dot = document.createElement("span");
          dot.className = "status-dot" + (w.hasCollision ? " collision" : (anyOnline ? "" : (anyActive ? " active" : " idle")));
          const tip = [
            w.key,
            w.hasCollision ? (w.workingRoots + " " + st("collisionNote")) : (w.participants.length + " " + (w.participants.length === 1 ? st("sessionSingle") : st("sessionsPlural"))),
            w.realms.join(", "),
          ].filter(Boolean).join(" · ");
          row.title = tip;
          dot.title = tip;
          left.appendChild(av);
          left.appendChild(nm);
          left.appendChild(dot);

          const rightWrap = document.createElement("div");
          rightWrap.className = "member-right";
          if (w.participants.length > 1) {
            const cnt = document.createElement("span");
            cnt.className = "realm-count-muted";
            cnt.textContent = String(w.participants.length);
            rightWrap.appendChild(cnt);
          }
          const dotsBtn = document.createElement("button");
          dotsBtn.type = "button";
          dotsBtn.className = "row-dots-btn";
          dotsBtn.title = "Inspect in-flight work";
          dotsBtn.setAttribute("aria-label", "Inspect " + w.label);
          dotsBtn.appendChild(ICONS.dots());
          dotsBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const rect = dotsBtn.getBoundingClientRect();
            state.popover = { kind: "work-card", x: rect.right + 6, y: rect.top, work: w };
            render();
          });
          rightWrap.appendChild(dotsBtn);

          row.appendChild(left);
          row.appendChild(rightWrap);
          row.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const rect = row.getBoundingClientRect();
            state.popover = { kind: "work-card", x: rect.right + 8, y: rect.top, work: w };
            render();
          });
          row.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            state.popover = { kind: "work-card", x: ev.clientX, y: ev.clientY, work: w };
            render();
          });
          pScroll.appendChild(row);
        }

        if (unkeyedPulses.length > 0) {
          const unkeyedRow = document.createElement("div");
          unkeyedRow.className = "member-row unkeyed-bucket-row";
          unkeyedRow.dataset.ui = "unkeyed-bucket";
          unkeyedRow.tabIndex = 0;

          const left = document.createElement("div");
          left.className = "member-left";
          const av = document.createElement("span");
          av.className = "member-avatar";
          av.appendChild(ICONS.user());
          const nm = document.createElement("span");
          nm.className = "member-name";
          nm.textContent = st("unkeyedBucket");
          const anyOnline = unkeyedPulses.some((p) => p.online);
          const dot = document.createElement("span");
          dot.className = "status-dot" + (anyOnline ? "" : " active");
          left.appendChild(av);
          left.appendChild(nm);
          left.appendChild(dot);

          const cnt = document.createElement("span");
          cnt.className = "realm-count-muted";
          cnt.textContent = String(unkeyedPulses.length);

          unkeyedRow.appendChild(left);
          unkeyedRow.appendChild(cnt);
          const bucketGroup = {
            actorId: st("unkeyedBucket"),
            actorKind: "unkeyed",
            online: anyOnline,
            active: true,
            sessions: unkeyedPulses,
          };
          unkeyedRow.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const rect = unkeyedRow.getBoundingClientRect();
            state.popover = { kind: "member-card", x: rect.right + 8, y: rect.top, group: bucketGroup };
            render();
          });
          pScroll.appendChild(unkeyedRow);
        }
      }
    } else {
      // People mode (按身份): collapsible per actor, DEFAULT EXPANDED, paginated incremental scroll loading
      if (actorGroups.length === 0) {
        const empty = document.createElement("div");
        empty.className = "presence-empty";
        empty.textContent = st("noPresence");
        pScroll.appendChild(empty);
      } else {
        const expandableActorsWithMore = [];
        for (const g of actorGroups) {
          const isActorCollapsed = state.collapsedActorIds.has(g.actorId);
          const visibleLimit = state.actorVisibleCounts.get(g.actorId) || ACTOR_SESSION_PAGE_SIZE;

          const groupEl = document.createElement("div");
          groupEl.className = "presence-actor-group";
          groupEl.dataset.actorGroup = g.actorId;

          const row = document.createElement("div");
          row.className = "member-row presence-actor-row";
          row.dataset.actorId = g.actorId;
          row.tabIndex = 0;

          const left = document.createElement("div");
          left.className = "member-left";

          const chev = document.createElement("button");
          chev.type = "button";
          chev.className = "realm-chevron-btn";
          chev.dataset.ui = "actor-chevron";
          chev.dataset.actorId = g.actorId;
          chev.setAttribute("aria-expanded", String(!isActorCollapsed));
          chev.title = (isActorCollapsed ? "Expand " : "Collapse ") + g.actorId;
          chev.setAttribute("aria-label", chev.title);
          chev.appendChild(isActorCollapsed ? ICONS.chevronRight() : ICONS.chevronDown());
          chev.addEventListener("click", (ev) => {
            ev.stopPropagation();
            state.presenceScrollTop = pScroll.scrollTop;
            if (state.collapsedActorIds.has(g.actorId)) {
              state.collapsedActorIds.delete(g.actorId);
            } else {
              state.collapsedActorIds.add(g.actorId);
            }
            render();
          });

          const av = document.createElement("span");
          av.className = "member-avatar";
          av.appendChild(ICONS.user());
          const nm = document.createElement("span");
          nm.className = "member-name";
          nm.textContent = g.actorId;
          const dot = document.createElement("span");
          dot.className = "status-dot" + (g.online ? "" : (g.active ? " active" : " idle"));
          const countLabel = g.sessions.length + " " + (g.sessions.length === 1 ? st("sessionSingle") : st("sessionsPlural"));
          const tip = [g.actorId, g.actorKind, countLabel].filter(Boolean).join(" · ");
          dot.title = tip;
          row.title = tip;
          left.appendChild(chev);
          left.appendChild(av);
          left.appendChild(nm);
          left.appendChild(dot);

          const rightWrap = document.createElement("div");
          rightWrap.className = "member-right";
          if (g.sessions.length > 1) {
            const cnt = document.createElement("span");
            cnt.className = "realm-count-muted";
            cnt.textContent = String(g.sessions.length);
            rightWrap.appendChild(cnt);
          }
          const dotsBtn = document.createElement("button");
          dotsBtn.type = "button";
          dotsBtn.className = "row-dots-btn";
          dotsBtn.title = "Member actions";
          dotsBtn.setAttribute("aria-label", "Actions for " + g.actorId);
          dotsBtn.appendChild(ICONS.dots());
          dotsBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const rect = dotsBtn.getBoundingClientRect();
            state.popover = { kind: "member-menu", x: rect.right + 6, y: rect.top, group: g, pulse: g.sessions[0] };
            render();
          });
          rightWrap.appendChild(dotsBtn);

          row.appendChild(left);
          row.appendChild(rightWrap);

          row.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const rect = row.getBoundingClientRect();
            state.popover = { kind: "member-card", x: rect.right + 8, y: rect.top, group: g, pulse: g.sessions[0] };
            render();
          });
          row.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            state.popover = { kind: "member-menu", x: ev.clientX, y: ev.clientY, group: g, pulse: g.sessions[0] };
            render();
          });
          groupEl.appendChild(row);

          if (!isActorCollapsed) {
            const sessList = document.createElement("div");
            sessList.className = "presence-actor-sessions";
            sessList.dataset.actorSessions = g.actorId;
            const visibleSessions = g.sessions.slice(0, visibleLimit);
            for (const s of visibleSessions) {
              const sBtn = document.createElement("button");
              sBtn.type = "button";
              sBtn.className = "presence-session-row";
              sBtn.dataset.sessionId = s.sessionId;
              const sDot = document.createElement("span");
              sDot.className = "status-dot" + (s.state === "working" || s.online ? "" : (s.state === "turn_ended" ? " paused" : (s.active ? " active" : " idle")));
              const sLabel = document.createElement("span");
              sLabel.className = "presence-session-label";
              sLabel.textContent = (s.clientHint || s.actorKind || "session") + " " + shortSessionHandle(s.sessionId);
              const sDetail = document.createElement("span");
              sDetail.className = "presence-session-detail";
              sDetail.textContent = s.activity || s.note || s.realmPath || "/";
              sBtn.title = [sLabel.textContent, s.realmPath || "/", s.activity || s.note || ""].filter(Boolean).join(" · ");
              sBtn.appendChild(sDot);
              sBtn.appendChild(sLabel);
              sBtn.appendChild(sDetail);
              sBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const rect = sBtn.getBoundingClientRect();
                state.popover = { kind: "member-card", x: rect.right + 8, y: rect.top, group: g, pulse: s };
                render();
              });
              sessList.appendChild(sBtn);
            }

            const remaining = g.sessions.length - visibleSessions.length;
            if (remaining > 0) {
              expandableActorsWithMore.push(g.actorId);
              const moreBtn = document.createElement("button");
              moreBtn.type = "button";
              moreBtn.className = "presence-load-more-btn";
              moreBtn.dataset.ui = "presence-load-more";
              moreBtn.dataset.actorId = g.actorId;
              moreBtn.textContent = st("loadMoreSessions") + " (+" + remaining + ")";
              moreBtn.addEventListener("click", (ev) => {
                ev.stopPropagation();
                state.presenceScrollTop = pScroll.scrollTop;
                state.actorVisibleCounts.set(g.actorId, visibleLimit + ACTOR_SESSION_PAGE_SIZE);
                render();
              });
              sessList.appendChild(moreBtn);
            }
            groupEl.appendChild(sessList);
          }

          pScroll.appendChild(groupEl);
        }

        if (expandableActorsWithMore.length > 0) {
          let scrollLoadTriggered = false;
          pScroll.addEventListener("scroll", () => {
            state.presenceScrollTop = pScroll.scrollTop;
            if (scrollLoadTriggered) return;
            const nearBottom = pScroll.scrollTop + pScroll.clientHeight >= pScroll.scrollHeight - 24;
            if (nearBottom) {
              scrollLoadTriggered = true;
              const nextActor = expandableActorsWithMore[0];
              const cur = state.actorVisibleCounts.get(nextActor) || ACTOR_SESSION_PAGE_SIZE;
              state.actorVisibleCounts.set(nextActor, cur + ACTOR_SESSION_PAGE_SIZE);
              render();
            }
          });
        }
      }
    }

    presencePane.appendChild(pScroll);
    if (state.presenceScrollTop > 0) {
      requestAnimationFrame(() => {
        pScroll.scrollTop = state.presenceScrollTop;
      });
    }
  }

  aside.appendChild(presencePane);

  const dock = document.createElement("div");
  dock.className = "utility-dock";
  dock.dataset.ui = "utility-dock";

  const profileBtn = document.createElement("button");
  profileBtn.type = "button";
  profileBtn.className = "profile-trigger";
  profileBtn.dataset.ui = "profile-trigger";
  profileBtn.title = "Profile & session";
  const avCircle = document.createElement("span");
  avCircle.className = "avatar-circle";
  avCircle.textContent = String(state.whoami.actor.id || "U").slice(0, 1).toUpperCase();
  const actorLabel = document.createElement("span");
  actorLabel.className = "actor-label";
  actorLabel.textContent = state.whoami.actor.id;
  profileBtn.appendChild(avCircle);
  profileBtn.appendChild(actorLabel);
  profileBtn.addEventListener("click", () => {
    const rect = profileBtn.getBoundingClientRect();
    state.popover = { kind: "profile", x: rect.left, y: Math.max(16, rect.top - 130) };
    render();
  });

  const gearBtn = makeIconBtn(ICONS.settings(), "Settings (Cmd+,)", () => {
    state.popover = null;
    state.modal = "settings";
    render();
  });
  gearBtn.dataset.ui = "settings-trigger";

  dock.appendChild(profileBtn);
  dock.appendChild(gearBtn);
  aside.appendChild(dock);

  return aside;
}

function buildTopbar() {
  const header = document.createElement("header");
  header.className = "studio-topbar";

  const left = document.createElement("div");
  left.className = "topbar-left";

  const menuBtn = makeIconBtn(ICONS.menu(), "Toggle realms navigation", () => {
    state.mobileNavOpen = !state.mobileNavOpen;
    render();
  }, "mobile-menu-btn");
  left.appendChild(menuBtn);

  const crumb = document.createElement("span");
  crumb.className = "scope-crumb";
  crumb.textContent = getOrgName() + " / " + (state.activeRealmPath === "/" ? "root" : state.activeRealmPath.slice(1));
  left.appendChild(crumb);

  const searchBtn = document.createElement("button");
  searchBtn.type = "button";
  searchBtn.className = "search-trigger";
  searchBtn.dataset.ui = "global-search-trigger";
  const sLeft = document.createElement("span");
  sLeft.className = "search-trigger-left";
  sLeft.appendChild(ICONS.search());
  const sText = document.createElement("span");
  sText.textContent = st("searchPrompt");
  sLeft.appendChild(sText);
  const kbd = document.createElement("span");
  kbd.className = "kbd-hint";
  kbd.textContent = "⌘K";
  searchBtn.appendChild(sLeft);
  searchBtn.appendChild(kbd);
  searchBtn.addEventListener("click", openSearchModal);

  const actions = document.createElement("div");
  actions.className = "topbar-actions";
  actions.appendChild(makeIconBtn(ICONS.plus(), "New entry in " + state.activeRealmPath + " (N)", () => {
    state.popover = null;
    state.writeError = null;
    state.modal = "write";
    render();
  }));
  actions.appendChild(makeIconBtn(ICONS.refresh(), "Refresh realm snapshot (R)", () => {
    void refreshAll();
  }));
  actions.appendChild(makeIconBtn(
    ICONS.panelRight(),
    state.inspectorOpen ? "Hide inspector ([)" : "Show inspector ([)",
    () => {
      state.inspectorOpen = !state.inspectorOpen;
      render();
    },
    state.inspectorOpen ? "active" : "",
  ));

  header.appendChild(left);
  header.appendChild(searchBtn);
  header.appendChild(actions);
  return header;
}

function buildRulesSection(rules) {
  const sec = document.createElement("section");
  sec.className = "content-section";
  sec.dataset.section = "rules";

  const head = document.createElement("div");
  head.className = "section-head";
  const h2 = document.createElement("h2");
  h2.className = "section-title";
  h2.textContent = "Binding Rules";
  const meta = document.createElement("span");
  meta.className = "section-meta";
  meta.textContent = rules.length + " active · untruncated";
  head.appendChild(h2);
  head.appendChild(meta);
  sec.appendChild(head);

  if (rules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No explicit binding rules in this realm.";
    sec.appendChild(empty);
    return sec;
  }

  const list = document.createElement("div");
  list.className = "rule-list";
  rules.forEach((rule, idx) => {
    const row = document.createElement("button");
    row.type = "button";
    const isFocused = state.focusedEntryId === rule.id;
    row.className = "rule-row" + (isFocused ? " selected" : "");
    row.dataset.ruleId = rule.id;
    row.dataset.listEntryId = rule.id;

    const num = document.createElement("span");
    num.className = "rule-idx";
    num.textContent = String(idx + 1);

    const title = document.createElement("span");
    title.className = "rule-title";
    title.textContent = rule.title;

    const origin = document.createElement("span");
    origin.className = "origin-tag";
    origin.textContent = rule.inherited ? "inherited" : "local";

    row.appendChild(num);
    row.appendChild(title);
    row.appendChild(origin);
    row.addEventListener("click", () => { void selectEntryById(rule.id, true); });
    list.appendChild(row);
  });
  sec.appendChild(list);
  return sec;
}

function buildInboxTriageSection() {
  const sec = document.createElement("section");
  sec.className = "content-section";
  sec.dataset.section = "inbox-triage";

  const head = document.createElement("div");
  head.className = "section-head";
  const h2 = document.createElement("h2");
  h2.className = "section-title";
  h2.textContent = "Inbox Triage Queue";
  const meta = document.createElement("span");
  meta.className = "section-meta";
  meta.textContent = state.inboxEntries.length + " waiting";
  head.appendChild(h2);
  head.appendChild(meta);
  sec.appendChild(head);

  if (state.inboxEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Inbox is clear. Unassigned notes written without --in land here for routing.";
    sec.appendChild(empty);
    return sec;
  }

  const targets = state.realms.filter((r) => r.path !== "/inbox");
  const stack = document.createElement("div");
  stack.className = "triage-stack";

  for (const item of state.inboxEntries) {
    const wrap = document.createElement("div");
    wrap.className = "triage-item";

    const entryEl = document.createElement("meru-entry");
    entryEl.entry = item;
    entryEl.addEventListener("meru-select", () => { void selectEntryById(item.id, true); });
    wrap.appendChild(entryEl);

    if (targets.length > 0) {
      const bar = document.createElement("div");
      bar.className = "triage-controls";

      const destGroup = document.createElement("div");
      destGroup.className = "triage-dest-group";

      const sel = document.createElement("select");
      sel.className = "meru-select";
      sel.setAttribute("aria-label", "Destination realm for " + item.id);
      for (const t of targets) {
        const opt = document.createElement("option");
        opt.value = t.path;
        opt.textContent = t.path;
        if (t.path === "/ops") opt.selected = true;
        sel.appendChild(opt);
      }
      destGroup.appendChild(sel);

      const moveBtn = document.createElement("button");
      moveBtn.type = "button";
      moveBtn.className = "meru-btn primary";
      moveBtn.dataset.triageEntry = item.id;
      moveBtn.appendChild(ICONS.arrowRight());
      const lbl = document.createElement("span");
      lbl.textContent = "Route";
      moveBtn.appendChild(lbl);
      moveBtn.addEventListener("click", async () => {
        moveBtn.disabled = true;
        try {
          await client.inbox.triage(item.id, sel.value, { expectedFromRealmRef: "/inbox" });
          showToast("Routed to " + sel.value);
          await refreshAll();
        } catch (err) {
          showToast(err?.message || "Triage conflict");
          moveBtn.disabled = false;
        }
      });

      bar.appendChild(destGroup);
      bar.appendChild(moveBtn);
      wrap.appendChild(bar);
    }

    stack.appendChild(wrap);
  }
  sec.appendChild(stack);
  return sec;
}

function buildObjectsSection(limitCount = null) {
  const sec = document.createElement("section");
  sec.className = "content-section";
  sec.dataset.section = "objects";

  const head = document.createElement("div");
  head.className = "section-head";
  const h2 = document.createElement("h2");
  h2.className = "section-title";
  h2.textContent = limitCount ? "Key Objects" : "Objects in " + state.activeRealmPath;
  const meta = document.createElement("span");
  meta.className = "section-meta";
  meta.textContent = fmtNum(state.realmObjects.length) + " tracked";
  head.appendChild(h2);
  head.appendChild(meta);
  sec.appendChild(head);

  if (!limitCount && state.realmObjects.length > 8) {
    const bar = document.createElement("div");
    bar.className = "filter-inline-bar";
    const inp = document.createElement("input");
    inp.className = "filter-inline-input";
    inp.type = "search";
    inp.placeholder = "Filter objects by name or kind...";
    inp.value = state.objectFilter;
    inp.addEventListener("input", () => {
      state.objectFilter = inp.value;
      render();
    });
    bar.appendChild(inp);
    sec.appendChild(bar);
  }

  const q = state.objectFilter.trim().toLowerCase();
  const filtered = q
    ? state.realmObjects.filter((o) =>
        String(o.name || "").toLowerCase().includes(q) ||
        String(o.ref || "").toLowerCase().includes(q) ||
        String(o.kind || "").toLowerCase().includes(q))
    : state.realmObjects;
  const shown = limitCount ? filtered.slice(0, limitCount) : filtered;

  if (shown.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = q ? ("No objects matching \"" + state.objectFilter + "\".") : "No structured objects directly in this realm.";
    sec.appendChild(empty);
    return sec;
  }

  const grid = document.createElement("div");
  grid.className = "object-chip-grid";
  for (const obj of shown) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "object-row-btn" + (state.selectedObject?.ref === obj.ref ? " selected" : "");
    btn.dataset.objectRef = obj.ref;

    const main = document.createElement("span");
    main.className = "object-row-main";
    const nm = document.createElement("span");
    nm.className = "object-row-name";
    nm.textContent = obj.name || obj.ref;
    const kd = document.createElement("span");
    kd.className = "object-row-kind";
    kd.textContent = obj.kind + " · " + obj.realmPath;
    main.appendChild(nm);
    main.appendChild(kd);

    btn.appendChild(main);
    btn.appendChild(ICONS.arrowRight());
    btn.addEventListener("click", () => { void selectObjectByRef(obj.ref, true); });
    grid.appendChild(btn);
  }
  sec.appendChild(grid);

  if (limitCount && state.realmObjects.length > limitCount) {
    const foot = document.createElement("div");
    foot.className = "load-more-row";
    const note = document.createElement("span");
    note.className = "section-meta";
    note.textContent = "Showing " + shown.length + " of " + fmtNum(state.realmObjects.length) + " objects";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "meru-btn";
    allBtn.textContent = "Browse all objects";
    allBtn.addEventListener("click", () => {
      state.activeTab = "objects";
      render();
    });
    foot.appendChild(note);
    foot.appendChild(allBtn);
    sec.appendChild(foot);
  }

  return sec;
}

function buildRecentConclusionsSection(items, opts = {}) {
  const sec = document.createElement("section");
  sec.className = "content-section";
  sec.dataset.section = "conclusions";

  const head = document.createElement("div");
  head.className = "section-head";
  const h2 = document.createElement("h2");
  h2.className = "section-title";
  h2.textContent = opts.title || "Recent Conclusions";

  if (opts.includeHistoryToggle) {
    const toggle = document.createElement("label");
    toggle.className = "history-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.ui = "ledger-history-toggle";
    cb.checked = state.showLedgerHistory;
    cb.addEventListener("change", async () => {
      state.showLedgerHistory = cb.checked;
      await loadRealmEntries(state.activeRealmPath, true);
      render();
    });
    const lbl = document.createElement("span");
    lbl.textContent = "Include superseded & redacted";
    toggle.appendChild(cb);
    toggle.appendChild(lbl);
    head.appendChild(h2);
    head.appendChild(toggle);
  } else {
    const meta = document.createElement("span");
    meta.className = "section-meta";
    meta.textContent = opts.totalCount ? ("Latest " + items.length + " of " + fmtNum(opts.totalCount)) : String(items.length);
    head.appendChild(h2);
    head.appendChild(meta);
  }
  sec.appendChild(head);

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No direct entries in this realm. Select a child realm in the sidebar or search across the full tree with ⌘K.";
    sec.appendChild(empty);
    return sec;
  }

  const stack = document.createElement("div");
  stack.className = "entry-stack";
  for (const item of items) {
    const el = document.createElement("meru-entry");
    el.dataset.listEntryId = item.id;
    el.entry = { ...item, realmPath: item.realmPath || state.activeRealmPath };
    el.selected = state.focusedEntryId === item.id;
    el.addEventListener("meru-select", () => { void openEntryInCenter(item.id); });
    stack.appendChild(el);
  }
  sec.appendChild(stack);

  if (opts.showBrowseAll && opts.totalCount > items.length) {
    const foot = document.createElement("div");
    foot.className = "load-more-row";
    const info = document.createElement("span");
    info.className = "section-meta";
    info.textContent = fmtNum(opts.totalCount) + " total entries in " + state.activeRealmPath;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "meru-btn";
    btn.textContent = "Browse paginated ledger";
    btn.addEventListener("click", () => {
      state.activeTab = "conclusions";
      render();
    });
    foot.appendChild(info);
    foot.appendChild(btn);
    sec.appendChild(foot);
  } else if (opts.paginated && state.realmEntriesHasMore) {
    const foot = document.createElement("div");
    foot.className = "load-more-row";
    const info = document.createElement("span");
    info.className = "section-meta";
    info.textContent = "Loaded " + fmtNum(items.length) + " entries";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "meru-btn";
    btn.textContent = "Load 25 more";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await loadRealmEntries(state.activeRealmPath, false);
      render();
    });
    foot.appendChild(info);
    foot.appendChild(btn);
    sec.appendChild(foot);
  }

  return sec;
}

function buildDocumentReader() {
  const main = document.createElement("main");
  main.className = "workspace-col doc-reader-col";
  main.dataset.ui = "center-doc-reader";

  const e = state.openEntry;
  const isRedacted = Boolean(e.redactedAt) || e.status === "retracted";
  const rawBody = isRedacted
    ? "[REDACTED: content permanently removed]"
    : String(e.body || e.snippet || "No body text.");
  const payloadSplitIdx = !isRedacted ? rawBody.indexOf("\n## Payload\n") : -1;
  const mainBodyText = payloadSplitIdx >= 0 ? rawBody.slice(0, payloadSplitIdx).trim() : rawBody;
  const rawPayloadText = payloadSplitIdx >= 0 ? rawBody.slice(payloadSplitIdx + "\n## Payload\n".length).trim() : "";
  const isHtmlDoc = !isRedacted && looksLikeHtmlDoc(mainBodyText, e.sourceRef);

  const visibleEntries = getVisibleListEntries();
  const currentIdx = visibleEntries.findIndex((item) => item.id === e.id);
  const prevItem = currentIdx > 0 ? visibleEntries[currentIdx - 1] : null;
  const nextItem = currentIdx >= 0 && currentIdx < visibleEntries.length - 1 ? visibleEntries[currentIdx + 1] : null;

  const toolbar = document.createElement("div");
  toolbar.className = "reader-toolbar";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "reader-back-btn";
  backBtn.dataset.ui = "reader-back";
  backBtn.title = st("backToList") + " (Esc)";
  backBtn.appendChild(ICONS.arrowLeft());
  const backLbl = document.createElement("span");
  backLbl.textContent = state.previousObject
    ? state.previousObject.ref
    : (e.realmPath || state.activeRealmPath || "/");
  backBtn.appendChild(backLbl);
  backBtn.addEventListener("click", () => {
    if (state.previousObject) {
      const obj = state.previousObject;
      state.previousObject = null;
      teardownStudioHtmlPreview();
      state.openEntry = null;
      state.selectedObject = obj;
      syncUrlFromState(false);
      render();
    } else {
      closeReaderToList();
    }
  });
  toolbar.appendChild(backBtn);

  const rightControls = document.createElement("div");
  rightControls.className = "reader-toolbar-right";

  if (!isRedacted) {
    const seg = document.createElement("div");
    seg.className = "studio-seg reader-view-seg";
    seg.dataset.ui = "reader-view-switch";
    // Show ONLY views that actually apply to this document (never show HTML tab on plain MD!)
    const modes = isHtmlDoc
      ? [["html", st("html")], ["md", st("md")], ["raw", st("raw")]]
      : [["md", st("md")], ["raw", st("raw")]];
    const effectiveView = (state.readerView === "html" && !isHtmlDoc) ? "md" : state.readerView;
    for (const [mKey, mLbl] of modes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "studio-seg-btn" + (effectiveView === mKey ? " active" : "");
      b.dataset.readerView = mKey;
      b.textContent = mLbl;
      b.addEventListener("click", () => {
        if (state.readerView === mKey) return;
        state.readerView = mKey;
        syncUrlFromState(true);
        render();
      });
      seg.appendChild(b);
    }
    rightControls.appendChild(seg);
  }

  const navGroup = document.createElement("div");
  navGroup.className = "reader-nav-group";
  const prevBtn = makeIconBtn(ICONS.chevronUp(), st("prevEntry"), () => {
    if (prevItem) void openEntryInCenter(prevItem.id);
  });
  prevBtn.dataset.ui = "reader-prev";
  prevBtn.disabled = !prevItem;
  const nextBtn = makeIconBtn(ICONS.chevronDown(), st("nextEntry"), () => {
    if (nextItem) void openEntryInCenter(nextItem.id);
  });
  nextBtn.dataset.ui = "reader-next";
  nextBtn.disabled = !nextItem;
  navGroup.appendChild(prevBtn);
  navGroup.appendChild(nextBtn);
  rightControls.appendChild(navGroup);

  toolbar.appendChild(rightControls);
  main.appendChild(toolbar);

  const scroll = document.createElement("div");
  scroll.className = "reader-scroll";

  const canvas = document.createElement("article");
  canvas.className = "reader-canvas";
  canvas.dataset.entryId = e.id;

  const h1 = document.createElement("h1");
  h1.className = "reader-doc-title";
  h1.textContent = isRedacted ? "[REDACTED]" : String(e.title || e.id);
  canvas.appendChild(h1);

  const submeta = document.createElement("div");
  submeta.className = "reader-doc-submeta";
  const kindBadge = document.createElement("span");
  kindBadge.className = "reader-kind-pill";
  kindBadge.textContent = String(e.extKind || e.kind || "entry");
  submeta.appendChild(kindBadge);
  if (e.status && e.status !== "active" && e.status !== "evidence") {
    const stSpan = document.createElement("span");
    stSpan.textContent = String(e.status);
    submeta.appendChild(stSpan);
  }
  if (e.authorId) {
    const authSpan = document.createElement("span");
    authSpan.textContent = "@" + e.authorId;
    submeta.appendChild(authSpan);
  }
  const tsSpan = document.createElement("span");
  tsSpan.textContent = formatStamp(e.occurredAt || e.createdAt);
  submeta.appendChild(tsSpan);
  canvas.appendChild(submeta);

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "reader-doc-body";

  teardownStudioHtmlPreview();
  if (isRedacted) {
    const body = document.createElement("p");
    body.className = "inspector-body redacted";
    body.textContent = mainBodyText;
    bodyWrap.appendChild(body);
  } else {
    const effectiveView = (state.readerView === "html" && !isHtmlDoc) ? "md" : state.readerView;
    if (effectiveView === "raw") {
      const pre = document.createElement("pre");
      pre.className = "reader-raw-pre";
      pre.textContent = mainBodyText;
      bodyWrap.appendChild(pre);
    } else if (effectiveView === "html") {
      const htmlBox = document.createElement("div");
      htmlBox.className = "reader-html-box";
      bodyWrap.appendChild(htmlBox);
      const currentId = e.id;
      loadMarkdownTools().then((mod) => {
        if (state.openEntry?.id !== currentId || state.readerView !== "html") return;
        activeStudioHtmlPreview = mod.mountStaticHtmlPreview(htmlBox, mainBodyText, {
          notice: st("htmlNotice"),
          renderBtn: st("htmlRender"),
          hideBtn: st("htmlHide"),
        });
      }).catch(() => {
        const pre = document.createElement("pre");
        pre.className = "html-source-pre";
        pre.textContent = mainBodyText;
        htmlBox.appendChild(pre);
      });
    } else {
      const mdEl = document.createElement("meru-markdown");
      mdEl.className = "reader-markdown";
      mdEl.source = mainBodyText;
      bodyWrap.appendChild(mdEl);
    }
  }
  canvas.appendChild(bodyWrap);

  if (rawPayloadText) {
    const det = document.createElement("details");
    det.className = "payload-details";
    const sum = document.createElement("summary");
    sum.textContent = st("payload");
    const pre = document.createElement("pre");
    pre.className = "payload-pre";
    pre.textContent = rawPayloadText.replace(/^```json\n?|\n?```$/g, "");
    det.appendChild(sum);
    det.appendChild(pre);
    canvas.appendChild(det);
  }

  scroll.appendChild(canvas);
  main.appendChild(scroll);
  return main;
}

function buildWorkspace() {
  if (state.openEntry) {
    return buildDocumentReader();
  }
  const main = document.createElement("main");
  main.className = "workspace-col";

  const rules = state.brief?.middleMind?.rules?.items || [];
  const overviewConclusions = collectOverviewConclusions(state.brief, state.realmEntries);
  const rc = state.realmCounts[state.activeRealmPath] || {};
  const directConclusions = state.brief?.buckets?.conclusions ?? rc.directConclusions ?? overviewConclusions.length;
  const subtreeConclusions = rc.subtreeConclusions ?? directConclusions;
  const totalObjects = rc.subtreeObjects ?? state.realmObjects.length;
  const childRealmsCount = rc.childRealmsCount ?? 0;
  const activeRealmObj = state.realms.find((r) => r.path === state.activeRealmPath);

  const head = document.createElement("div");
  head.className = "workspace-header";

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";
  const h1 = document.createElement("h1");
  h1.className = "page-title";
  h1.textContent = realmDisplayName(activeRealmObj);
  const fresh = document.createElement("span");
  fresh.className = "freshness-meta";
  fresh.textContent = state.lastSyncedAt
    ? ("Synced " + state.lastSyncedAt + " · seq " + state.pumpCursorSeq)
    : "Connecting...";
  titleRow.appendChild(h1);
  titleRow.appendChild(fresh);
  head.appendChild(titleRow);

  const scopeText = state.brief?.realm?.scope || activeRealmObj?.scope || "Shared realm context, inherited rules, and active ledger conclusions.";
  const scopeP = document.createElement("p");
  scopeP.className = "scope-line";
  scopeP.textContent = scopeText;
  head.appendChild(scopeP);

  // Contextual inline Active Peers strip: strictly hidden when 0 other peers are active here
  const realmPeers = (state.pulses || []).filter(
    (p) => p.realmPath === state.activeRealmPath && p.active && p.sessionId !== state.selfPulseSessionId,
  );
  if (realmPeers.length > 0) {
    const peersBar = document.createElement("div");
    peersBar.className = "realm-peers-bar";
    peersBar.dataset.ui = "realm-peers-bar";

    const peersLbl = document.createElement("span");
    peersLbl.className = "realm-peers-label";
    peersLbl.textContent = st("activeHere");
    peersBar.appendChild(peersLbl);

    const groupsByActor = new Map(groupPulsesByActor(state.pulses).map((g) => [g.actorId, g]));
    const shownPeers = realmPeers.slice(0, 4);
    for (const peer of shownPeers) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "peer-chip";
      const dot = document.createElement("span");
      dot.className = "status-dot" + (peer.online ? "" : " active");
      const who = document.createElement("span");
      who.className = "peer-chip-who";
      who.textContent = peer.clientHint ? (peer.actorId + " · " + peer.clientHint) : peer.actorId;
      chip.appendChild(dot);
      chip.appendChild(who);

      const summary = peer.activity || peer.note || "";
      if (summary) {
        const ctx = document.createElement("span");
        ctx.className = "peer-chip-ctx";
        ctx.textContent = summary;
        chip.appendChild(ctx);
      }

      const age = document.createElement("span");
      age.className = "peer-chip-age";
      age.textContent = peer.online ? "now" : formatPulseAge(peer.ageSeconds);
      chip.appendChild(age);

      chip.title = [
        peer.actorId + " (" + (peer.actorKind || "agent") + (peer.clientHint ? ", " + peer.clientHint : "") + " " + shortSessionHandle(peer.sessionId) + ")",
        peer.activity || "",
        peer.note ? ('"' + peer.note + '"') : "",
      ].filter(Boolean).join(" · ");

      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const rect = chip.getBoundingClientRect();
        const group = groupsByActor.get(peer.actorId) || {
          actorId: peer.actorId,
          actorKind: peer.actorKind,
          online: peer.online,
          active: peer.active,
          sessions: [peer],
        };
        state.popover = { kind: "member-card", x: rect.left, y: rect.bottom + 6, group, pulse: peer };
        render();
      });
      peersBar.appendChild(chip);
    }

    if (realmPeers.length > shownPeers.length) {
      const more = document.createElement("span");
      more.className = "realm-peers-more";
      more.textContent = "+" + (realmPeers.length - shownPeers.length);
      peersBar.appendChild(more);
    }
    head.appendChild(peersBar);
  }

  const tabs = document.createElement("div");
  tabs.className = "tab-bar";
  tabs.setAttribute("role", "tablist");

  const tabDefs = [
    { id: "overview", label: "Overview", count: null },
    { id: "conclusions", label: "Ledger", count: directConclusions },
    { id: "objects", label: "Objects", count: state.realmObjects.length },
    { id: "rules", label: "Binding Rules", count: rules.length },
  ];
  if (state.hasInboxRealm) {
    tabDefs.push({ id: "inbox", label: "Inbox Triage", count: state.inboxEntries.length });
  }

  for (const t of tabDefs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.role = "tab";
    btn.className = "tab-btn" + (state.activeTab === t.id ? " active" : "");
    btn.setAttribute("aria-selected", String(state.activeTab === t.id));
    btn.dataset.tab = t.id;
    const lbl = document.createElement("span");
    lbl.textContent = t.label;
    btn.appendChild(lbl);
    if (t.count !== null) {
      const cnt = document.createElement("span");
      cnt.className = "tab-count";
      cnt.textContent = fmtNum(t.count);
      btn.appendChild(cnt);
    }
    btn.addEventListener("click", () => {
      state.activeTab = t.id;
      syncUrlFromState(true);
      render();
    });
    tabs.appendChild(btn);
  }
  head.appendChild(tabs);
  main.appendChild(head);

  const scroll = document.createElement("div");
  scroll.className = "workspace-scroll";

  if (state.activeTab === "overview") {
    const strip = document.createElement("div");
    strip.className = "ledger-strip";

    const cells = [
      {
        label: subtreeConclusions > directConclusions ? "Subtree Conclusions" : "Active Conclusions",
        value: subtreeConclusions > directConclusions ? subtreeConclusions : directConclusions,
        sub: subtreeConclusions > directConclusions ? (fmtNum(directConclusions) + " direct in " + state.activeRealmPath) : ("In " + state.activeRealmPath),
        tab: "conclusions",
        actionable: false,
      },
      {
        label: "Tracked Objects",
        value: totalObjects,
        sub: state.realmObjects.length > 0 ? (fmtNum(state.realmObjects.length) + " direct here") : "Across child realms",
        tab: "objects",
        actionable: false,
      },
      {
        label: "Binding Rules",
        value: rules.length,
        sub: "Always untruncated",
        tab: "rules",
        actionable: false,
      },
      state.hasInboxRealm
        ? {
            label: "Inbox Queue",
            value: state.inboxEntries.length,
            sub: state.inboxEntries.length > 0 ? "Needs routing" : "Clear",
            tab: "inbox",
            actionable: state.inboxEntries.length > 0,
          }
        : {
            label: "Child Realms",
            value: childRealmsCount,
            sub: getOrgPolicy() ? ("Policy: " + getOrgPolicy()) : "Scoped tree",
            tab: "overview",
            actionable: false,
          },
    ];

    for (const c of cells) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "ledger-cell";
      const l = document.createElement("span");
      l.className = "ledger-label";
      l.textContent = c.label;
      const v = document.createElement("span");
      v.className = "ledger-value" + (c.value === 0 ? " zero" : "") + (c.actionable ? " actionable" : "");
      v.textContent = fmtNum(c.value);
      const s = document.createElement("span");
      s.className = "ledger-sub";
      s.textContent = c.sub;
      cell.appendChild(l);
      cell.appendChild(v);
      cell.appendChild(s);
      cell.addEventListener("click", () => {
        state.activeTab = c.tab;
        render();
      });
      strip.appendChild(cell);
    }
    scroll.appendChild(strip);

    if (state.hasInboxRealm && state.inboxEntries.length > 0) {
      scroll.appendChild(buildInboxTriageSection());
    }

    if (overviewConclusions.length > 0) {
      scroll.appendChild(buildRecentConclusionsSection(overviewConclusions, {
        title: "Recent Conclusions",
        totalCount: directConclusions,
        showBrowseAll: true,
      }));
    }

    if (state.realmObjects.length > 0) {
      scroll.appendChild(buildObjectsSection(6));
    }

    if (rules.length > 0) {
      scroll.appendChild(buildRulesSection(rules));
    }

    if (overviewConclusions.length === 0 && state.realmObjects.length === 0 && rules.length === 0 && state.inboxEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "This parent realm organizes child realms (" + childRealmsCount + " below). Pick a child realm on the left or press ⌘K to search across all " + fmtNum(subtreeConclusions) + " conclusions.";
      scroll.appendChild(empty);
    }
  } else if (state.activeTab === "conclusions") {
    const listItems = state.realmEntries.filter((x) => x.kind !== "rule");
    scroll.appendChild(buildRecentConclusionsSection(listItems, {
      title: "Ledger Entries in " + state.activeRealmPath,
      includeHistoryToggle: true,
      paginated: true,
    }));
  } else if (state.activeTab === "objects") {
    scroll.appendChild(buildObjectsSection(null));
  } else if (state.activeTab === "rules") {
    scroll.appendChild(buildRulesSection(rules));
  } else if (state.activeTab === "inbox") {
    scroll.appendChild(buildInboxTriageSection());
  }

  main.appendChild(scroll);
  if (state.restoreListScrollPending) {
    state.restoreListScrollPending = false;
    const savedTop = state.savedListScrollTop;
    requestAnimationFrame(() => {
      scroll.scrollTop = savedTop;
    });
  }
  return main;
}

function buildPropList(rows) {
  const list = document.createElement("dl");
  list.className = "prop-list";
  for (const row of rows) {
    if (!row || row.value === undefined || row.value === null || row.value === "") continue;
    const item = document.createElement("div");
    item.className = "prop-row";
    const dt = document.createElement("dt");
    dt.className = "prop-label";
    dt.textContent = row.label;
    const dd = document.createElement("dd");
    dd.className = "prop-value" + (row.mono ? " mono" : "");
    if (typeof row.onClick === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "prop-value-btn" + (row.mono ? " mono" : "");
      btn.textContent = String(row.value);
      btn.title = row.title || String(row.value);
      btn.addEventListener("click", row.onClick);
      dd.appendChild(btn);
    } else {
      dd.textContent = String(row.value);
      dd.title = row.title || String(row.value);
    }
    item.appendChild(dt);
    item.appendChild(dd);
    list.appendChild(item);
  }
  return list;
}

function buildInspector() {
  const aside = document.createElement("aside");
  aside.className = "inspector-col";
  aside.dataset.ui = "properties-rail";

  const focusEntry = state.openEntry || state.focusedEntry;

  const head = document.createElement("div");
  head.className = "inspector-head";
  const heading = document.createElement("span");
  heading.className = "inspector-heading";
  heading.textContent = state.selectedObject
    ? st("objectProperties")
    : (focusEntry ? st("properties") : st("realmProperties"));
  head.appendChild(heading);

  const headActions = document.createElement("div");
  headActions.className = "inspector-head-actions";
  if (focusEntry || state.selectedObject) {
    const actionsBtn = makeIconBtn(ICONS.dots(), st("actions"), (ev) => {
      ev.stopPropagation();
      const rect = actionsBtn.getBoundingClientRect();
      state.popover = {
        kind: "rail-actions",
        x: Math.max(12, rect.right - 220),
        y: rect.bottom + 6,
        entry: focusEntry || null,
        object: state.selectedObject || null,
      };
      render();
    });
    actionsBtn.dataset.ui = "rail-actions-trigger";
    headActions.appendChild(actionsBtn);
  }
  headActions.appendChild(makeIconBtn(ICONS.close(), "Close properties ([)", () => {
    state.inspectorOpen = false;
    render();
  }));
  head.appendChild(headActions);
  aside.appendChild(head);

  const scroll = document.createElement("div");
  scroll.className = "inspector-scroll";

  // Mode 1: Object focus
  if (state.selectedObject) {
    const card = state.selectedObject;
    const title = document.createElement("h3");
    title.className = "inspector-title";
    title.textContent = card.name || card.ref;
    scroll.appendChild(title);

    scroll.appendChild(buildPropList([
      { label: "Ref", value: card.ref, mono: true, onClick: () => copyText(card.ref, "Copied " + card.ref) },
      { label: "Kind", value: card.kind },
      {
        label: "Realm",
        value: card.realmPath,
        mono: true,
        onClick: card.realmPath ? () => { void selectRealm(card.realmPath); } : null,
      },
      { label: "Linked", value: fmtNum(card.counts?.total ?? card.recentEntries?.length ?? 0) },
    ]));

    if (Array.isArray(card.recentEntries) && card.recentEntries.length > 0) {
      const sec = document.createElement("div");
      sec.className = "rail-section";
      const lbl = document.createElement("div");
      lbl.className = "rail-section-head";
      lbl.textContent = "Linked Context (" + card.recentEntries.length + ")";
      sec.appendChild(lbl);

      const list = document.createElement("div");
      list.className = "object-entries-list";
      for (const item of card.recentEntries) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "object-entry-mini";
        const t = document.createElement("div");
        t.className = "object-entry-mini-title";
        t.textContent = item.title || item.id;
        const m = document.createElement("div");
        m.className = "object-entry-mini-meta";
        m.textContent = (item.extKind || item.kind || "entry") + " · " + formatStamp(item.occurredAt || item.createdAt);
        btn.appendChild(t);
        btn.appendChild(m);
        btn.addEventListener("click", () => { void openEntryInCenter(item.id, { fromObject: true }); });
        list.appendChild(btn);
      }
      sec.appendChild(list);
      scroll.appendChild(sec);
    }

    aside.appendChild(scroll);
    return aside;
  }

  // Mode 2: Entry focus (either open full-width in Center Reader or focused via J/K in List)
  if (focusEntry) {
    const e = focusEntry;
    const isRedacted = Boolean(e.redactedAt) || e.status === "retracted";

    // When NOT yet open in Center Reader, show compact title + 2-line excerpt + Open button
    if (!state.openEntry) {
      const title = document.createElement("h3");
      title.className = "inspector-title";
      title.textContent = isRedacted ? "[REDACTED]" : String(e.title || e.id);
      scroll.appendChild(title);

      const snippet = isRedacted ? "" : String(e.snippet || e.body || "").trim();
      if (snippet) {
        const ex = document.createElement("p");
        ex.className = "rail-focus-excerpt";
        ex.textContent = snippet.slice(0, 220);
        scroll.appendChild(ex);
      }

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "meru-btn rail-open-btn";
      openBtn.dataset.ui = "rail-open-doc";
      openBtn.appendChild(ICONS.bookOpen());
      const lbl = document.createElement("span");
      lbl.textContent = st("openDocument");
      openBtn.appendChild(lbl);
      openBtn.addEventListener("click", () => { void openEntryInCenter(e.id); });
      scroll.appendChild(openBtn);
    }

    // Flat single-line properties (zero card-in-card, zero duplicate document body!)
    scroll.appendChild(buildPropList([
      { label: "ID", value: e.id, mono: true, onClick: () => copyText(e.id, "Copied " + e.id) },
      { label: "Kind", value: e.extKind || e.kind || "entry" },
      { label: "Status", value: e.status || "active" },
      {
        label: "Realm",
        value: e.realmPath || state.activeRealmPath,
        mono: true,
        onClick: () => { void selectRealm(e.realmPath || state.activeRealmPath); },
      },
      { label: "Author", value: e.authorId ? ("@" + e.authorId) : null, mono: true },
      { label: "Recorded", value: formatStamp(e.occurredAt || e.createdAt), mono: true },
      { label: "Source", value: e.sourceRef || null, mono: true },
    ]));

    // Linked Objects & Resource Tags — COMPLETELY HIDDEN when empty
    const linkedRefs = [
      ...(Array.isArray(e.objectIds) ? e.objectIds : []),
      ...(Array.isArray(e.refs) ? e.refs : []),
      ...(Array.isArray(e.resourceTags) ? e.resourceTags.map((t) => "#" + t) : []),
    ].filter(Boolean);
    const uniqueRefs = Array.from(new Set(linkedRefs));
    if (uniqueRefs.length > 0) {
      const sec = document.createElement("div");
      sec.className = "rail-section";
      const lbl = document.createElement("div");
      lbl.className = "rail-section-head";
      lbl.textContent = st("linkedRefs");
      sec.appendChild(lbl);

      const chipWrap = document.createElement("div");
      chipWrap.className = "rail-chip-wrap";
      for (const ref of uniqueRefs) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "rail-ref-chip";
        chip.textContent = ref;
        chip.addEventListener("click", () => {
          if (ref.startsWith("#")) {
            void copyText(ref, "Copied " + ref);
          } else {
            void selectObjectByRef(ref, true);
          }
        });
        chipWrap.appendChild(chip);
      }
      sec.appendChild(chipWrap);
      scroll.appendChild(sec);
    }

    // Supersede Provenance — COMPLETELY HIDDEN if <= 1 revision
    if (state.selectedChain && Array.isArray(state.selectedChain.nodes) && state.selectedChain.nodes.length > 1) {
      const sec = document.createElement("div");
      sec.className = "rail-section";

      const chLabel = document.createElement("div");
      chLabel.className = "rail-section-head";
      const cLeft = document.createElement("span");
      cLeft.textContent = st("supersedeChain");
      const cRight = document.createElement("span");
      cRight.textContent = String(state.selectedChain.nodes.length);
      chLabel.appendChild(cLeft);
      chLabel.appendChild(cRight);
      sec.appendChild(chLabel);

      const rail = document.createElement("div");
      rail.className = "chain-rail";
      for (const n of state.selectedChain.nodes) {
        const node = document.createElement("button");
        node.type = "button";
        const isHead = n.id === state.selectedChain.currentHeadId;
        const isCurr = n.id === e.id;
        node.className = "chain-node" + (isHead ? " head" : "") + (isCurr ? " current" : "");
        const nt = document.createElement("div");
        nt.className = "chain-node-title";
        nt.textContent = n.title;
        const nm = document.createElement("div");
        nm.className = "chain-node-meta";
        nm.textContent = (isHead ? "head · " : "") + n.kind + " · " + n.status + " · " + n.id.slice(0, 12);
        node.appendChild(nt);
        node.appendChild(nm);
        node.addEventListener("click", () => { void openEntryInCenter(n.id); });
        rail.appendChild(node);
      }
      sec.appendChild(rail);
      scroll.appendChild(sec);
    }

    // Active Peers touching this realm/entry — COMPLETELY HIDDEN if 0 peers
    const entryRealm = e.realmPath || state.activeRealmPath;
    const relevantPeers = (state.pulses || []).filter(
      (p) =>
        p.active &&
        p.sessionId !== state.selfPulseSessionId &&
        (p.realmPath === entryRealm || (Array.isArray(p.focus) && p.focus.includes(e.id))),
    );
    if (relevantPeers.length > 0) {
      const sec = document.createElement("div");
      sec.className = "rail-section";
      const lbl = document.createElement("div");
      lbl.className = "rail-section-head";
      lbl.textContent = st("activePeers");
      sec.appendChild(lbl);
      const list = document.createElement("div");
      list.className = "rail-peer-list";
      for (const peer of relevantPeers.slice(0, 5)) {
        const pRow = document.createElement("div");
        pRow.className = "rail-peer-row";
        const dot = document.createElement("span");
        dot.className = "status-dot realm-live-dot";
        const who = document.createElement("span");
        who.className = "rail-peer-who";
        who.textContent = peer.clientHint ? (peer.actorId + " · " + peer.clientHint) : peer.actorId;
        const act = document.createElement("span");
        act.className = "rail-peer-act";
        act.textContent = peer.activity || peer.note || (peer.online ? "now" : formatPulseAge(peer.ageSeconds));
        pRow.appendChild(dot);
        pRow.appendChild(who);
        pRow.appendChild(act);
        list.appendChild(pRow);
      }
      sec.appendChild(list);
      scroll.appendChild(sec);
    }

    // Contextual CLI Governance Command Box — SHOWN ONLY when explicitly requested from ⋯ menu or on 403
    if (state.railCliCommand) {
      const cliBlock = document.createElement("div");
      cliBlock.className = "rail-section rail-cli-box";
      cliBlock.dataset.ui = "rail-cli-box";
      const top = document.createElement("div");
      top.className = "rail-section-head";
      const lbl = document.createElement("span");
      lbl.textContent = state.railCliCommand.label || "CLI";
      top.appendChild(lbl);
      top.appendChild(makeIconBtn(ICONS.close(), "Dismiss", () => {
        state.railCliCommand = null;
        render();
      }));
      cliBlock.appendChild(top);

      const note = document.createElement("p");
      note.className = "cli-boundary-note";
      note.textContent = st("cliRequiresBearer");
      cliBlock.appendChild(note);

      const cmdRow = document.createElement("div");
      cmdRow.className = "cli-cmd-row";
      const cmdCode = document.createElement("code");
      cmdCode.className = "cli-cmd-text";
      cmdCode.textContent = state.railCliCommand.cmd;
      cmdCode.title = state.railCliCommand.cmd;
      cmdRow.appendChild(cmdCode);
      cmdRow.appendChild(makeIconBtn(ICONS.copy(), "Copy CLI command", () => copyText(state.railCliCommand.cmd)));
      cliBlock.appendChild(cmdRow);
      scroll.appendChild(cliBlock);
    }

    aside.appendChild(scroll);
    return aside;
  }

  // Mode 3: No specific entry/object focused -> show active Realm properties
  const activeRealmObj = state.realms.find((r) => r.path === state.activeRealmPath);
  const rc = state.realmCounts[state.activeRealmPath] || {};
  const rulesCount = state.brief?.middleMind?.rules?.items?.length || 0;
  scroll.appendChild(buildPropList([
    { label: "Path", value: state.activeRealmPath, mono: true },
    { label: "Name", value: realmDisplayName(activeRealmObj) },
    { label: "Conclusions", value: fmtNum(rc.subtreeConclusions ?? rc.directConclusions ?? 0), mono: true },
    { label: "Objects", value: fmtNum(rc.subtreeObjects ?? state.realmObjects.length), mono: true },
    { label: "Rules", value: fmtNum(rulesCount), mono: true },
    { label: "Policy", value: getOrgPolicy(), mono: true },
  ]));

  const realmPeers = (state.pulses || []).filter(
    (p) => p.active && p.sessionId !== state.selfPulseSessionId && p.realmPath === state.activeRealmPath,
  );
  if (realmPeers.length > 0) {
    const sec = document.createElement("div");
    sec.className = "rail-section";
    const lbl = document.createElement("div");
    lbl.className = "rail-section-head";
    lbl.textContent = st("activePeers");
    sec.appendChild(lbl);
    const list = document.createElement("div");
    list.className = "rail-peer-list";
    for (const peer of realmPeers.slice(0, 6)) {
      const pRow = document.createElement("div");
      pRow.className = "rail-peer-row";
      const dot = document.createElement("span");
      dot.className = "status-dot realm-live-dot";
      const who = document.createElement("span");
      who.className = "rail-peer-who";
      who.textContent = peer.clientHint ? (peer.actorId + " · " + peer.clientHint) : peer.actorId;
      const act = document.createElement("span");
      act.className = "rail-peer-act";
      act.textContent = peer.activity || peer.note || (peer.online ? "now" : formatPulseAge(peer.ageSeconds));
      pRow.appendChild(dot);
      pRow.appendChild(who);
      pRow.appendChild(act);
      list.appendChild(pRow);
    }
    sec.appendChild(list);
    scroll.appendChild(sec);
  }

  aside.appendChild(scroll);
  return aside;
}

/* ==================== Popovers & Modals ==================== */

function formatSessionStateBadge(s) {
  if (s.state === "turn_ended") return "Turn ended " + formatPulseAge(s.ageSeconds) + " ago";
  if (s.state === "silent") return "Silent " + formatPulseAge(s.ageSeconds) + " ago";
  if (s.state === "working" || (s.online && s.mode === "working")) return "Working";
  if (s.online) return "Online";
  if (s.active) return "Active " + formatPulseAge(s.ageSeconds) + " ago";
  return "Quiet " + formatPulseAge(s.ageSeconds) + " ago";
}

function buildPopoverSessionItem(s, opts = {}) {
  const item = document.createElement("div");
  item.className = "popover-session-item" + (opts.isChild ? " is-child" : "");

  const topRow = document.createElement("div");
  topRow.className = "popover-session-top";
  const leftMeta = document.createElement("span");
  leftMeta.className = "popover-session-client";
  const sDot = document.createElement("span");
  sDot.className = "status-dot" + (
    s.state === "working" || s.online ? "" : (s.state === "turn_ended" ? " paused" : (s.active ? " active" : " idle"))
  );
  const clientText = document.createElement("span");
  const whoPrefix = opts.showActor ? (s.actorId + " · ") : "";
  clientText.textContent = whoPrefix + (s.clientHint || s.actorKind || "session") + " " + shortSessionHandle(s.sessionId);
  leftMeta.appendChild(sDot);
  leftMeta.appendChild(clientText);

  const ageMeta = document.createElement("span");
  ageMeta.className = "popover-session-age";
  ageMeta.textContent = formatSessionStateBadge(s);
  topRow.appendChild(leftMeta);
  topRow.appendChild(ageMeta);
  item.appendChild(topRow);

  if (s.source || s.mode) {
    const prov = document.createElement("div");
    prov.className = "popover-session-meta";
    prov.textContent = [s.mode, s.source ? ("source=" + s.source) : ""].filter(Boolean).join(" · ");
    item.appendChild(prov);
  }

  if (s.activity) {
    const actEl = document.createElement("div");
    actEl.className = "popover-session-activity";
    actEl.textContent = s.activity;
    item.appendChild(actEl);
  }

  if (s.note) {
    const noteEl = document.createElement("div");
    noteEl.className = "popover-session-note";
    noteEl.textContent = s.note;
    item.appendChild(noteEl);
  }

  const targetRealm = s.realmPath || (s.focus && s.focus[0]) || "/";
  const realmBtn = document.createElement("button");
  realmBtn.type = "button";
  realmBtn.className = "popover-session-realm";
  realmBtn.appendChild(ICONS.arrowRight());
  const rSpan = document.createElement("span");
  rSpan.textContent = targetRealm === state.activeRealmPath
    ? (targetRealm + " · " + st("hereTag"))
    : targetRealm;
  realmBtn.appendChild(rSpan);
  realmBtn.addEventListener("click", () => {
    state.popover = null;
    void selectRealm(targetRealm);
  });
  item.appendChild(realmBtn);
  return item;
}

function renderPopover() {
  if (!state.popover) return null;
  const isWideCard = state.popover.kind === "member-card" || state.popover.kind === "work-card";
  const pop = document.createElement("div");
  pop.className = "floating-popover" + (isWideCard ? " wide" : "");
  const maxX = Math.max(12, window.innerWidth - (isWideCard ? 356 : 292));
  const maxY = Math.max(12, window.innerHeight - (isWideCard ? 404 : 200));
  pop.style.left = Math.min(Math.max(12, state.popover.x), maxX) + "px";
  pop.style.top = Math.min(Math.max(12, state.popover.y), maxY) + "px";
  pop.addEventListener("click", (ev) => ev.stopPropagation());

  if (state.popover.kind === "work-card" && state.popover.work) {
    const w = state.popover.work;
    const head = document.createElement("div");
    head.className = "popover-head";
    const nm = document.createElement("div");
    nm.className = "popover-name";
    nm.textContent = w.label;
    const sub = document.createElement("div");
    sub.className = "popover-sub" + (w.hasCollision ? " collision" : "");
    sub.textContent = w.hasCollision
      ? (w.key + " · " + w.workingRoots + " " + st("collisionNote"))
      : (w.key + " · " + w.participants.length + " " + (w.participants.length === 1 ? st("sessionSingle") : st("sessionsPlural")));
    head.appendChild(nm);
    head.appendChild(sub);
    pop.appendChild(head);

    // Order participants as parent -> children tree (pure read-only projection)
    const byId = new Map(w.participants.map((p) => [p.sessionId, p]));
    const childrenByParent = new Map();
    const roots = [];
    for (const p of w.participants) {
      if (p.parentSessionId && byId.has(p.parentSessionId)) {
        let arr = childrenByParent.get(p.parentSessionId);
        if (!arr) {
          arr = [];
          childrenByParent.set(p.parentSessionId, arr);
        }
        arr.push(p);
      } else {
        roots.push(p);
      }
    }

    const list = document.createElement("div");
    list.className = "popover-session-list";
    for (const r of roots) {
      list.appendChild(buildPopoverSessionItem(r, { showActor: true, isChild: false }));
      const kids = childrenByParent.get(r.sessionId) || [];
      for (const k of kids) {
        list.appendChild(buildPopoverSessionItem(k, { showActor: true, isChild: true }));
      }
    }
    pop.appendChild(list);
    return pop;
  }

  if (state.popover.kind === "rail-actions") {
    const entry = state.popover.entry;
    const obj = state.popover.object;
    const addAction = (iconEl, label, onClick, isDanger = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "menu-item" + (isDanger ? " danger" : "");
      b.appendChild(iconEl);
      const sp = document.createElement("span");
      sp.textContent = label;
      b.appendChild(sp);
      b.addEventListener("click", () => {
        state.popover = null;
        onClick();
      });
      pop.appendChild(b);
    };

    if (entry) {
      addAction(ICONS.copy(), st("copyId"), () => {
        render();
        void copyText(entry.id, "Copied " + entry.id);
      });
      addAction(ICONS.link(), st("copyLink"), () => {
        const u = new URL(window.location.href);
        const targetRealm = entry.realmPath || state.activeRealmPath || "/";
        u.pathname = targetRealm;
        u.search = "?entry=" + encodeURIComponent(entry.id);
        render();
        void copyText(u.toString(), "Copied document link");
      });
      const moveCmd = "meru-mind entry move " + entry.id + " --to /target-realm";
      addAction(ICONS.terminal(), st("cliMoveCmd"), () => {
        state.railCliCommand = { label: "CLI Move", cmd: moveCmd };
        render();
        void copyText(moveCmd, "Copied CLI move command");
      });
      const redactCmd = "meru-mind redact " + entry.id + ' --reason "compliance"';
      addAction(ICONS.terminal(), st("cliRedactCmd"), () => {
        state.railCliCommand = { label: "CLI Redact", cmd: redactCmd };
        render();
        void copyText(redactCmd, "Copied CLI redact command");
      }, true);
    } else if (obj) {
      addAction(ICONS.copy(), "Copy Ref", () => {
        render();
        void copyText(obj.ref, "Copied " + obj.ref);
      });
    }
    return pop;
  }

  if (state.popover.kind === "profile") {
    const head = document.createElement("div");
    head.className = "popover-head";
    const nm = document.createElement("div");
    nm.className = "popover-name";
    nm.textContent = state.whoami.actor.id;
    const sub = document.createElement("div");
    sub.className = "popover-sub";
    sub.textContent = "Weakened Cookie Session · " + state.whoami.actor.kind;
    head.appendChild(nm);
    head.appendChild(sub);
    pop.appendChild(head);

    const signOut = document.createElement("button");
    signOut.type = "button";
    signOut.className = "menu-item danger";
    signOut.appendChild(ICONS.logout());
    const t = document.createElement("span");
    t.textContent = "Sign out";
    signOut.appendChild(t);
    signOut.addEventListener("click", async () => {
      state.popover = null;
      client.pump.stop();
      await client.logout();
      state.whoami = null;
      render();
    });
    pop.appendChild(signOut);
    return pop;
  }

  const group = state.popover.group || (state.popover.pulse ? {
    actorId: state.popover.pulse.actorId,
    actorKind: state.popover.pulse.actorKind,
    online: state.popover.pulse.online,
    active: state.popover.pulse.active,
    sessions: [state.popover.pulse],
  } : null);

  if (state.popover.kind === "member-card" && group) {
    const head = document.createElement("div");
    head.className = "popover-head";
    const nm = document.createElement("div");
    nm.className = "popover-name";
    nm.textContent = group.actorId;
    const sub = document.createElement("div");
    sub.className = "popover-sub";
    const countLabel = group.sessions.length + " " + (group.sessions.length === 1 ? st("sessionSingle") : st("sessionsPlural"));
    sub.textContent = (group.actorKind || "agent") + " · " + countLabel;
    head.appendChild(nm);
    head.appendChild(sub);
    pop.appendChild(head);

    const list = document.createElement("div");
    list.className = "popover-session-list";
    for (const s of group.sessions) {
      list.appendChild(buildPopoverSessionItem(s, { showActor: group.actorKind === "unkeyed", isChild: Boolean(s.parentSessionId) }));
    }
    pop.appendChild(list);
    return pop;
  }

  if (state.popover.kind === "member-menu" && group) {
    const seenRealms = new Set();
    for (const s of group.sessions) {
      const rp = s.realmPath || "/";
      if (seenRealms.has(rp)) continue;
      seenRealms.add(rp);
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "menu-item";
      jump.appendChild(ICONS.arrowRight());
      const jSpan = document.createElement("span");
      jSpan.textContent = "Open " + rp;
      jump.appendChild(jSpan);
      jump.addEventListener("click", () => {
        state.popover = null;
        void selectRealm(rp);
      });
      pop.appendChild(jump);
    }

    const cp = document.createElement("button");
    cp.type = "button";
    cp.className = "menu-item";
    cp.appendChild(ICONS.copy());
    const cSpan = document.createElement("span");
    cSpan.textContent = "Copy actor ID";
    cp.appendChild(cSpan);
    cp.addEventListener("click", () => {
      state.popover = null;
      render();
      void copyText(group.actorId, "Copied " + group.actorId);
    });

    pop.appendChild(cp);
    return pop;
  }

  return null;
}

function openSearchModal() {
  state.popover = null;
  state.modal = "search";
  render();
  const inp = document.getElementById("studio-search-input");
  if (inp) inp.focus();
}

function renderModal() {
  if (!state.modal) return null;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) {
      state.modal = null;
      render();
    }
  });

  const panel = document.createElement("div");
  panel.className = "modal-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");

  if (state.modal === "search") {
    const head = document.createElement("div");
    head.className = "search-header";
    head.appendChild(ICONS.search());

    const inp = document.createElement("input");
    inp.id = "studio-search-input";
    inp.className = "search-input";
    inp.type = "search";
    inp.placeholder = "Search visible memory across realms... (Press Enter)";
    inp.value = state.searchQuery;
    inp.addEventListener("keydown", async (ev) => {
      if (ev.key === "Escape") {
        state.modal = null;
        render();
      } else if (ev.key === "Enter") {
        state.searchQuery = inp.value.trim();
        if (!state.searchQuery) return;
        try {
          state.searchResults = await client.search(state.searchQuery, { limit: 15 });
          render();
          const nextInp = document.getElementById("studio-search-input");
          if (nextInp) nextInp.focus();
        } catch (err) {
          showToast(err?.message || "Search failed");
        }
      }
    });
    head.appendChild(inp);
    head.appendChild(makeIconBtn(ICONS.close(), "Close search", () => {
      state.modal = null;
      render();
    }));
    panel.appendChild(head);

    const body = document.createElement("div");
    body.className = "modal-body";
    const items = state.searchResults?.items || [];
    if (!state.searchResults) {
      const hint = document.createElement("div");
      hint.className = "empty-state";
      hint.textContent = "Type keywords and press Enter. Runs live v0.5.1 FTS5 + 240-char coverage-first snippet search across all visible realms.";
      body.appendChild(hint);
    } else if (items.length === 0) {
      const none = document.createElement("div");
      none.className = "empty-state";
      none.textContent = "No matching entries for \"" + state.searchQuery + "\".";
      body.appendChild(none);
    } else {
      for (const item of items) {
        const hl = state.searchResults.highlights?.[item.id] || null;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "search-result-row";

        const top = document.createElement("div");
        top.className = "search-result-top";
        const tEl = document.createElement("span");
        tEl.className = "search-result-title";
        if (hl?.titleRanges?.length) {
          tEl.appendChild(applyHighlightRanges(item.title || item.id, hl.titleRanges));
        } else {
          tEl.textContent = String(item.title || item.id);
        }
        const tag = document.createElement("span");
        tag.className = "origin-tag";
        tag.textContent = (item.extKind || item.kind || "entry") + " · " + (item.realmPath || "/");
        top.appendChild(tEl);
        top.appendChild(tag);
        row.appendChild(top);

        if (item.snippet) {
          const sn = document.createElement("p");
          sn.className = "search-result-snippet";
          if (hl?.snippetRanges?.length) {
            sn.appendChild(applyHighlightRanges(item.snippet, hl.snippetRanges));
          } else {
            sn.textContent = item.snippet;
          }
          row.appendChild(sn);
        }

        row.addEventListener("click", () => {
          state.modal = null;
          void selectEntryById(item.id, true);
        });
        body.appendChild(row);
      }
    }
    panel.appendChild(body);
  } else if (state.modal === "write") {
    const head = document.createElement("div");
    head.className = "inspector-head";
    const h = document.createElement("span");
    h.className = "inspector-heading";
    h.textContent = "New Entry in " + state.activeRealmPath;
    head.appendChild(h);
    head.appendChild(makeIconBtn(ICONS.close(), "Close", () => {
      state.modal = null;
      render();
    }));
    panel.appendChild(head);

    const body = document.createElement("div");
    body.className = "modal-body";
    const form = document.createElement("div");
    form.className = "form-stack";

    const row2 = document.createElement("div");
    row2.className = "form-row-2";

    const kindLbl = document.createElement("label");
    kindLbl.className = "field-label";
    kindLbl.textContent = "Kind";
    const kindSel = document.createElement("select");
    kindSel.className = "meru-select";
    for (const k of ["finding", "decision", "proposal"]) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k;
      if (state.writeKind === k) opt.selected = true;
      kindSel.appendChild(opt);
    }
    kindSel.addEventListener("change", () => { state.writeKind = kindSel.value; });
    kindLbl.appendChild(kindSel);

    const realmLbl = document.createElement("label");
    realmLbl.className = "field-label";
    realmLbl.textContent = "Target Realm";
    const realmInput = document.createElement("input");
    realmInput.className = "meru-input";
    realmInput.value = state.activeRealmPath;
    realmInput.disabled = true;
    realmLbl.appendChild(realmInput);

    row2.appendChild(kindLbl);
    row2.appendChild(realmLbl);
    form.appendChild(row2);

    const titleLbl = document.createElement("label");
    titleLbl.className = "field-label";
    titleLbl.textContent = "Title";
    const titleInp = document.createElement("input");
    titleInp.className = "meru-input";
    titleInp.placeholder = "Concise decision or finding title";
    titleInp.value = state.writeTitle;
    titleInp.addEventListener("input", () => { state.writeTitle = titleInp.value; });
    titleLbl.appendChild(titleInp);
    form.appendChild(titleLbl);

    const bodyLbl = document.createElement("label");
    bodyLbl.className = "field-label";
    bodyLbl.textContent = "Body";
    const bodyTa = document.createElement("textarea");
    bodyTa.className = "meru-textarea";
    bodyTa.placeholder = "Evidence, trade-offs, or verification details (Secret Guard scans writes automatically)";
    bodyTa.value = state.writeBody;
    bodyTa.addEventListener("input", () => { state.writeBody = bodyTa.value; });
    bodyLbl.appendChild(bodyTa);
    form.appendChild(bodyLbl);

    if (state.writeError) {
      const errBox = document.createElement("div");
      errBox.className = "empty-state";
      errBox.textContent = state.writeError;
      form.appendChild(errBox);
    }

    body.appendChild(form);
    panel.appendChild(body);

    const foot = document.createElement("div");
    foot.className = "modal-foot";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "meru-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      state.modal = null;
      render();
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "meru-btn primary";
    saveBtn.disabled = state.writeSubmitting;
    saveBtn.textContent = state.writeSubmitting ? "Writing..." : "Write to Ledger";
    saveBtn.addEventListener("click", async () => {
      if (!state.writeTitle.trim()) {
        state.writeError = "Title is required.";
        render();
        return;
      }
      state.writeSubmitting = true;
      state.writeError = null;
      render();
      try {
        const res = await client.write({
          kind: state.writeKind,
          title: state.writeTitle.trim(),
          body: state.writeBody.trim(),
          in: state.activeRealmPath,
        });
        state.writeTitle = "";
        state.writeBody = "";
        state.writeSubmitting = false;
        state.modal = null;
        showToast("Written to " + state.activeRealmPath);
        await refreshAll();
        if (res?.record?.id) await selectEntryById(res.record.id, true);
      } catch (err) {
        state.writeSubmitting = false;
        state.writeError = err?.cliCommand
          ? (err.message + ". Run in CLI: " + err.cliCommand)
          : (err?.message || "Write failed");
        render();
      }
    });

    foot.appendChild(cancelBtn);
    foot.appendChild(saveBtn);
    panel.appendChild(foot);
  } else if (state.modal === "settings") {
    const head = document.createElement("div");
    head.className = "inspector-head";
    const h = document.createElement("span");
    h.className = "inspector-heading";
    h.textContent = st("settings");
    head.appendChild(h);
    head.appendChild(makeIconBtn(ICONS.close(), "Close settings", () => {
      state.modal = null;
      render();
    }));
    panel.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "settings-grid";

    const nav = document.createElement("div");
    nav.className = "settings-nav";
    for (const item of [
      { id: "appearance", label: st("appearance") },
      { id: "realtime", label: st("realtimeAuth") },
      { id: "shortcuts", label: st("shortcuts") },
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "settings-nav-btn" + (state.settingsTab === item.id ? " active" : "");
      b.textContent = item.label;
      b.addEventListener("click", () => {
        state.settingsTab = item.id;
        render();
      });
      nav.appendChild(b);
    }
    grid.appendChild(nav);

    const pane = document.createElement("div");
    pane.className = "settings-pane";

    const addSettingRow = (titleText, descText, controlEl) => {
      const r = document.createElement("div");
      r.className = "setting-row";
      const info = document.createElement("div");
      const t = document.createElement("div");
      t.className = "setting-title";
      t.textContent = titleText;
      const d = document.createElement("div");
      d.className = "setting-desc";
      d.textContent = descText;
      info.appendChild(t);
      info.appendChild(d);
      r.appendChild(info);
      r.appendChild(controlEl);
      pane.appendChild(r);
    };

    if (state.settingsTab === "appearance") {
      const themeSel = document.createElement("select");
      themeSel.className = "meru-select";
      themeSel.setAttribute("aria-label", "Theme");
      for (const [val, lbl] of [["light", "Light Liquid Glass"], ["dark", "Dark Liquid Glass"]]) {
        const o = document.createElement("option");
        o.value = val;
        o.textContent = lbl;
        if ((document.documentElement.dataset.theme || "light") === val) o.selected = true;
        themeSel.appendChild(o);
      }
      themeSel.addEventListener("change", () => {
        applyTheme(themeSel.value);
        render();
      });
      addSettingRow(st("themeTitle"), st("themeDesc"), themeSel);

      const langSel = document.createElement("select");
      langSel.className = "meru-select";
      langSel.setAttribute("aria-label", "Language");
      for (const [val, lbl] of [["en", "English"], ["zh-CN", "简体中文"]]) {
        const o = document.createElement("option");
        o.value = val;
        o.textContent = lbl;
        if (state.lang === val) o.selected = true;
        langSel.appendChild(o);
      }
      langSel.addEventListener("change", () => {
        state.lang = langSel.value;
        document.documentElement.lang = state.lang;
        localStorage.setItem("meru-studio-lang", state.lang);
        render();
      });
      addSettingRow(st("language"), st("languageDesc"), langSel);
    } else if (state.settingsTab === "realtime") {
      const statusBadge = document.createElement("span");
      statusBadge.className = "meta-val";
      statusBadge.textContent = state.pumpStatus + " · seq " + state.pumpCursorSeq;
      addSettingRow("Pump Transport", "WebSocket primary with automatic Long-Poll fallback.", statusBadge);

      const authBadge = document.createElement("span");
      authBadge.className = "meta-val";
      authBadge.textContent = "HttpOnly Cookie (read + reversible)";
      addSettingRow("Session Scope", "Irreversible actions remain CLI-only.", authBadge);
    } else {
      for (const [k, desc] of [
        ["⌘K / Ctrl+K", "Open global visible-memory search"],
        ["J / K", "Focus next / previous entry (or step in document reader)"],
        ["Enter", "Open focused entry full-width in center reader"],
        ["Esc", "Return from document reader to list / close dialogs"],
        ["N", "Open new entry drawer in active realm"],
        ["R", "Refresh current realm snapshot"],
        ["[", "Toggle right properties rail"],
        ["⌘,", "Open settings"],
      ]) {
        const keycap = document.createElement("span");
        keycap.className = "kbd-hint";
        keycap.textContent = k;
        addSettingRow(desc, "Active when no input field is focused.", keycap);
      }
    }

    grid.appendChild(pane);
    panel.appendChild(grid);
  }

  backdrop.appendChild(panel);
  return backdrop;
}

/* ==================== Root Render ==================== */

function render() {
  if (!state.whoami) {
    renderAuthScreen();
    return;
  }

  clearEl(app);

  const shell = document.createElement("div");
  shell.className = "studio-shell" + (state.mobileNavOpen ? " mobile-nav-open" : "");
  shell.addEventListener("click", () => {
    if (state.popover) {
      state.popover = null;
      render();
    }
  });

  const scrim = document.createElement("div");
  scrim.className = "sidebar-scrim";
  scrim.addEventListener("click", () => {
    state.mobileNavOpen = false;
    render();
  });

  const sheet = document.createElement("div");
  sheet.className = "studio-sheet" + (state.inspectorOpen ? "" : " inspector-hidden");
  sheet.appendChild(buildWorkspace());
  if (state.inspectorOpen) {
    sheet.appendChild(buildInspector());
  }

  shell.appendChild(buildSidebar());
  shell.appendChild(scrim);
  shell.appendChild(buildTopbar());
  shell.appendChild(sheet);
  app.appendChild(shell);

  const pop = renderPopover();
  if (pop) app.appendChild(pop);

  const modal = renderModal();
  if (modal) app.appendChild(modal);
}

/* ==================== Keyboard Shortcuts & Pump ==================== */

window.addEventListener("keydown", (ev) => {
  const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : "";
  const inInput = tag === "input" || tag === "textarea" || tag === "select";

  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
    ev.preventDefault();
    if (state.modal === "search") {
      state.modal = null;
      render();
    } else {
      openSearchModal();
    }
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key === ",") {
    ev.preventDefault();
    state.modal = state.modal === "settings" ? null : "settings";
    render();
    return;
  }
  if (ev.key === "Escape") {
    if (state.modal || state.popover) {
      state.modal = null;
      state.popover = null;
      render();
    } else if (state.openEntry) {
      closeReaderToList();
    }
    return;
  }
  if (inInput || state.modal) return;
  const lowKey = ev.key.toLowerCase();
  if (lowKey === "j" || lowKey === "k") {
    const list = getVisibleListEntries();
    if (list.length === 0) return;
    ev.preventDefault();
    const curId = state.openEntry?.id || state.focusedEntryId;
    const idx = curId ? list.findIndex((x) => x.id === curId) : -1;
    let nextIdx;
    if (lowKey === "j") {
      nextIdx = idx < 0 ? 0 : Math.min(list.length - 1, idx + 1);
    } else {
      nextIdx = idx < 0 ? list.length - 1 : Math.max(0, idx - 1);
    }
    const target = list[nextIdx];
    if (!target || target.id === curId) return;
    if (state.openEntry) {
      void openEntryInCenter(target.id);
    } else {
      void focusEntryInList(target.id, target);
    }
  } else if (ev.key === "Enter" && !state.openEntry && state.focusedEntryId) {
    // Only trigger when not clicking an interactive button/link directly
    if (tag !== "button" && tag !== "a") {
      ev.preventDefault();
      void openEntryInCenter(state.focusedEntryId);
    }
  } else if (lowKey === "r") {
    void refreshAll();
  } else if (lowKey === "n") {
    ev.preventDefault();
    state.writeError = null;
    state.modal = "write";
    render();
  } else if (ev.key === "[") {
    state.inspectorOpen = !state.inspectorOpen;
    render();
  }
});

window.addEventListener("popstate", () => {
  if (!state.whoami) return;
  void applyUrlStateFromLocation();
});

async function applyUrlStateFromLocation() {
  const parsed = parseUrlState();
  const targetRealm = state.realms.some((r) => r.path === parsed.realmPath)
    ? parsed.realmPath
    : (state.realms[0]?.path || "/");
  if (targetRealm !== state.activeRealmPath || (parsed.tab && parsed.tab !== state.activeTab)) {
    await selectRealm(targetRealm, parsed.tab || undefined, {
      keepReader: Boolean(parsed.entryId),
      skipUrlSync: true,
    });
  }
  if (parsed.entryId) {
    if (state.openEntry?.id !== parsed.entryId || (parsed.view && parsed.view !== state.readerView)) {
      await openEntryInCenter(parsed.entryId, {
        requestedView: parsed.view,
        skipUrlSync: true,
      });
    }
  } else if (parsed.objectRef) {
    await selectObjectByRef(parsed.objectRef, true, { skipUrlSync: true });
  } else if (state.openEntry) {
    closeReaderToList({ skipUrlSync: true });
  } else if (state.selectedObject) {
    state.selectedObject = null;
    render();
  }
}

client.pump.subscribe((snap) => {
  const prevStatus = state.pumpStatus;
  state.pumpStatus = snap.status;
  state.pumpGeneration = snap.generation ?? state.pumpGeneration;
  state.pumpCursorSeq = snap.cursorSeq ?? state.pumpCursorSeq;
  if (snap.status === "auth-required") {
    state.whoami = null;
    render();
    return;
  }
  const lamp = document.querySelector('[data-ui="ws-connection-status"]');
  if (lamp) {
    lamp.dataset.status = snap.status;
    lamp.title = "Realtime transport: " + snap.status;
  } else if (prevStatus !== snap.status) {
    render();
  }
  if (snap.lastFrames && snap.lastFrames.length > 0) {
    void refreshAll({ keepReader: Boolean(state.openEntry), skipUrlSync: true });
  }
});

async function studioPulseKeepaliveTick() {
  if (!state.whoami || document.visibilityState !== "visible") return;
  try {
    const selfPulse = await client.pulse.setFocus([state.activeRealmPath], null, state.activeRealmPath, "browser").catch(() => null);
    if (selfPulse?.sessionId) state.selfPulseSessionId = selfPulse.sessionId;
    const pulseRes = await client.pulse.list().catch(() => null);
    if (pulseRes?.pulses) {
      applyPulsePayload(pulseRes, true);
      if (!state.presenceHovered) {
        render();
      }
    }
  } catch {
    // quiet failure on background pulse tick
  }
}

setInterval(() => {
  void studioPulseKeepaliveTick();
}, 40000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void studioPulseKeepaliveTick();
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
    const initialUrl = parseUrlState();
    await refreshAll({
      realmPath: initialUrl.realmPath,
      tab: initialUrl.tab || undefined,
      keepReader: Boolean(initialUrl.entryId),
      skipUrlSync: true,
    });
    if (initialUrl.entryId) {
      await openEntryInCenter(initialUrl.entryId, {
        requestedView: initialUrl.view,
        replaceUrl: true,
      });
    } else if (initialUrl.objectRef) {
      await selectObjectByRef(initialUrl.objectRef, true, { replaceUrl: true });
    } else {
      syncUrlFromState(true);
    }
    client.pump.start(state.whoami.latestSeq || 0);
  } catch {
    state.whoami = null;
    render();
  }
}

void boot();
