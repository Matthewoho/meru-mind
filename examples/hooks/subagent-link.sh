#!/usr/bin/env bash
set -euo pipefail

# Opt-in PostToolUse (`invoke_subagent|swarm|Agent|Task`) / SubagentStart hook:
# - Reads stdin JSON directly from fd 0 (no env-var size limit).
# - Extracts child session IDs strictly from structured JSON fields (never regex-scraped from free text),
#   capped at 16 children per invocation, and preserves existing unexpired parent links (first-writer wins).
# - Records child -> parent links atomically into `~/.cache/meru-mind/parent-map.json`
#   (mode 0600, TTL 24h, capped at 500 entries).
# - Always prints `{}` to stdout so Antigravity hook JSON validation remains strictly valid.
#
# Optional env:
#   MERU_MIND_PARENT_MAP_FILE  Override cache path (default: $XDG_CACHE_HOME/meru-mind/parent-map.json or ~/.cache/meru-mind/parent-map.json)

if ! command -v node >/dev/null 2>&1; then
  printf '{}\n'
  exit 0
fi

node -e '
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_ENTRIES = 500;
const MAX_CHILDREN_PER_CALL = 16;
const CHILD_KEY_RE = /^(conversationId|conversation_id|childConversationId|child_session_id|agent_id|agentId|subagent_id|subagentId|workerConversationId|worker_conversation_id|thread_id|threadId)$/i;

const sanitizeId = (v) =>
  typeof v === "string"
    ? v.trim().replace(/[^A-Za-z0-9._:@/-]/g, "").slice(0, 64)
    : "";

function readHookStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function resolveParentMapPath() {
  const override = (process.env.MERU_MIND_PARENT_MAP_FILE || "").trim();
  if (override) return path.resolve(override);
  const xdg = (process.env.XDG_CACHE_HOME || "").trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".cache");
  return path.join(base, "meru-mind", "parent-map.json");
}

function collectStructuredChildIds(val, outSet, depth = 0) {
  if (depth > 6 || outSet.size >= MAX_CHILDREN_PER_CALL || val === null || val === undefined) return;
  if (typeof val === "string") {
    // Only parse if the ENTIRE string is valid JSON object/array — NEVER regex-scrape arbitrary free text
    const trimmed = val.trim();
    if (!trimmed) return;
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        collectStructuredChildIds(JSON.parse(trimmed), outSet, depth + 1);
      } catch {}
    }
    return;
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      if (outSet.size >= MAX_CHILDREN_PER_CALL) break;
      collectStructuredChildIds(item, outSet, depth + 1);
    }
    return;
  }
  if (typeof val === "object") {
    for (const [k, v] of Object.entries(val)) {
      if (outSet.size >= MAX_CHILDREN_PER_CALL) break;
      if (CHILD_KEY_RE.test(k) && typeof v === "string") {
        const id = sanitizeId(v);
        if (id) outSet.add(id);
      } else {
        collectStructuredChildIds(v, outSet, depth + 1);
      }
    }
  }
}

function main() {
  let d = {};
  try {
    const rawStdin = readHookStdin();
    if (rawStdin.trim()) {
      const parsed = JSON.parse(rawStdin);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        d = parsed;
      }
    }
  } catch {
    process.stdout.write("{}\n");
    return;
  }

  const parentId =
    sanitizeId(d.conversationId) ||
    sanitizeId(d.session_id) ||
    sanitizeId(process.env.MERU_MIND_SESSION_ID) ||
    sanitizeId(process.env.ANTIGRAVITY_CONVERSATION_ID) ||
    sanitizeId(process.env.CLAUDE_SESSION_ID) ||
    sanitizeId(process.env.CODEX_THREAD_ID) ||
    sanitizeId(process.env.OPENCODE_SESSION_ID);

  if (!parentId) {
    process.stdout.write("{}\n");
    return;
  }

  const childIds = new Set();
  for (const directKey of ["agent_id", "agentId", "subagent_id", "subagentId", "childConversationId", "child_session_id"]) {
    if (childIds.size >= MAX_CHILDREN_PER_CALL) break;
    const id = sanitizeId(d[directKey]);
    if (id && id !== parentId) childIds.add(id);
  }
  for (const outKey of ["toolOutput", "tool_output", "toolResult", "tool_result", "tool_response", "result", "output"]) {
    if (childIds.size >= MAX_CHILDREN_PER_CALL) break;
    if (d[outKey] !== undefined) {
      collectStructuredChildIds(d[outKey], childIds, 0);
    }
  }
  childIds.delete(parentId);

  if (childIds.size === 0) {
    process.stdout.write("{}\n");
    return;
  }

  const filePath = resolveParentMapPath();
  const dir = path.dirname(filePath);
  const nowMs = Date.now();
  let links = Object.create(null);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const rawLinks = parsed && typeof parsed === "object" && parsed.links && typeof parsed.links === "object"
        ? parsed.links
        : parsed;
      if (rawLinks && typeof rawLinks === "object") {
        for (const [k, v] of Object.entries(rawLinks)) {
          if (k === "version" || k === "links") continue;
          const ck = sanitizeId(k);
          const pv = v && typeof v === "object" ? sanitizeId(v.parent) : "";
          const ts = v && typeof v === "object" && typeof v.updatedAt === "number" ? v.updatedAt : NaN;
          if (
            ck &&
            pv &&
            ck !== pv &&
            Number.isFinite(ts) &&
            ts <= nowMs + MAX_FUTURE_SKEW_MS &&
            nowMs - ts <= TTL_MS
          ) {
            links[ck] = { parent: pv, updatedAt: ts };
          }
        }
      }
    }
  } catch {}

  let changed = false;
  for (const cid of childIds) {
    // First-writer wins within TTL: never allow subsequent injected output to re-parent an existing child
    if (!Object.hasOwn(links, cid)) {
      links[cid] = { parent: parentId, updatedAt: nowMs };
      changed = true;
    }
  }

  if (!changed) {
    process.stdout.write("{}\n");
    return;
  }

  const entries = Object.entries(links);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    const trimmed = Object.create(null);
    for (const [k, v] of entries.slice(0, MAX_ENTRIES)) {
      trimmed[k] = v;
    }
    links = trimmed;
  }

  let tmpPath = null;
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch {}
    }
    tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
    fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, links }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try { fs.chmodSync(tmpPath, 0o600); } catch {}
    fs.renameSync(tmpPath, filePath);
    tmpPath = null;
    try { fs.chmodSync(filePath, 0o600); } catch {}
  } catch {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  process.stdout.write("{}\n");
}

main();
' || printf '{}\n'
