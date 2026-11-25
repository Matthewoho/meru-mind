#!/usr/bin/env bash
set -euo pipefail

# Opt-in UserPromptSubmit hook for coding harnesses (Antigravity, Claude Code, Codex, OpenCode).
# - Reads stdin JSON directly from fd 0 (no env-var size limit).
# - Parses BOTH camelCase (`conversationId`, `parentConversationId`, `workspacePaths[0]`, `userPrompt`)
#   and snake_case (`session_id`, `parent_session_id`, `cwd`, `prompt`) stdin JSON.
# - Auto-resolves `parent-map.json` when parent session ID is not explicitly provided.
# - Stores per-user delta seen state under `~/.cache/meru-mind/hooks` (mode 0700/0600, never /tmp).
#
# Required env: MERU_MIND_URL, MERU_MIND_TOKEN
# Optional env: MERU_MIND_CLIENT, MERU_MIND_SESSION_ID, MERU_MIND_PARENT_SESSION_ID, MERU_MIND_PARENT_MAP_FILE, MERU_MIND_REALM

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

export WORK_PWD="$PWD"

node -e '
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REALM_PATH_RE = /^\/[A-Za-z0-9._/-]{0,119}$/;
const MAX_FUTURE_SKEW_MS = 60_000;

const sanitizeId = (v) =>
  typeof v === "string"
    ? v.trim().replace(/[^A-Za-z0-9._:@/-]/g, "").slice(0, 64)
    : "";

const sanitizeClient = (v) =>
  typeof v === "string"
    ? v.trim().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32)
    : "";

function validateRealmPath(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!REALM_PATH_RE.test(trimmed)) return "";
  if (trimmed.split("/").some((seg) => seg === "..")) return "";
  return trimmed;
}

function readHookStdin() {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function resolveCacheDir() {
  const xdg = (process.env.XDG_CACHE_HOME || "").trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".cache");
  return path.join(base, "meru-mind");
}

function resolveHookStateDir() {
  const dir = path.join(resolveCacheDir(), "hooks");
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch {}
    }
  } catch {}
  return dir;
}

function resolveParentMapPath() {
  const override = (process.env.MERU_MIND_PARENT_MAP_FILE || "").trim();
  if (override) return path.resolve(override);
  return path.join(resolveCacheDir(), "parent-map.json");
}

function lookupParentFromMap(sessionId) {
  if (!sessionId) return "";
  try {
    const p = resolveParentMapPath();
    if (!fs.existsSync(p)) return "";
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    const links = parsed && typeof parsed === "object" && parsed.links && typeof parsed.links === "object"
      ? parsed.links
      : parsed;
    if (!links || typeof links !== "object" || !Object.hasOwn(links, sessionId)) return "";
    const rec = links[sessionId];
    if (!rec || typeof rec !== "object") return "";
    const parent = sanitizeId(rec.parent);
    const updatedAt = typeof rec.updatedAt === "number" ? rec.updatedAt : NaN;
    const nowMs = Date.now();
    if (!parent || parent === sessionId || !Number.isFinite(updatedAt)) return "";
    if (updatedAt > nowMs + MAX_FUTURE_SKEW_MS || nowMs - updatedAt > 24 * 60 * 60 * 1000) return "";
    return parent;
  } catch {
    return "";
  }
}

async function main() {
  let parsed = {};
  try {
    const rawStdin = readHookStdin();
    if (rawStdin.trim()) {
      const obj = JSON.parse(rawStdin);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsed = obj;
      }
    }
  } catch {}

  const isAgy = typeof parsed.conversationId === "string" && parsed.conversationId.trim().length > 0;
  let finished = false;
  const finish = (text) => {
    if (finished) return;
    finished = true;
    if (isAgy) {
      process.stdout.write(JSON.stringify(text ? { injectSteps: [text] } : {}) + "\n");
    } else if (text) {
      process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    }
  };

  try {
    if (!process.env.MERU_MIND_URL || !process.env.MERU_MIND_TOKEN) {
      finish("");
      return;
    }

    const agyWs = Array.isArray(parsed.workspacePaths) && typeof parsed.workspacePaths[0] === "string"
      ? parsed.workspacePaths[0].trim()
      : "";
    const rawCwd =
      (typeof parsed.cwd === "string" && parsed.cwd.trim()) ||
      agyWs ||
      process.env.WORK_PWD ||
      process.cwd();
    const workDir = fs.existsSync(rawCwd) ? rawCwd : process.cwd();

    const findRealm = (startDir) => {
      let dir = startDir;
      while (dir && dir !== path.dirname(dir)) {
        const marker = path.join(dir, ".meru-mind-realm");
        try {
          const st = fs.lstatSync(marker);
          if (st.isFile() && !st.isSymbolicLink()) {
            const first = fs.readFileSync(marker, "utf8").split(/\r?\n/)[0].trim();
            return validateRealmPath(first);
          }
        } catch {}
        if (fs.existsSync(path.join(dir, ".git"))) break;
        dir = path.dirname(dir);
      }
      return "";
    };

    let gitBranch = "";
    let repoName = path.basename(workDir);
    try {
      gitBranch = execFileSync("git", ["-C", workDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const top = execFileSync("git", ["-C", workDir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (top) repoName = path.basename(top);
    } catch {}

    const nativeSid =
      sanitizeId(parsed.conversationId) ||
      sanitizeId(parsed.session_id) ||
      sanitizeId(process.env.ANTIGRAVITY_CONVERSATION_ID) ||
      sanitizeId(process.env.CLAUDE_SESSION_ID) ||
      sanitizeId(process.env.CODEX_THREAD_ID) ||
      sanitizeId(process.env.OPENCODE_SESSION_ID);

    const defaultSid = nativeSid || sanitizeId(repoName + (gitBranch ? "@" + gitBranch : ""));
    const sessionId = sanitizeId(process.env.MERU_MIND_SESSION_ID) || defaultSid || "default";

    let parentSessionId =
      sanitizeId(process.env.MERU_MIND_PARENT_SESSION_ID) ||
      sanitizeId(parsed.parentConversationId) ||
      sanitizeId(parsed.parent_session_id) ||
      sanitizeId(process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID) ||
      sanitizeId(process.env.CLAUDE_PARENT_SESSION_ID) ||
      sanitizeId(process.env.CODEX_PARENT_THREAD_ID) ||
      lookupParentFromMap(sessionId) ||
      null;
    if (parentSessionId === sessionId) parentSessionId = null;

    const inferredClient =
      isAgy || process.env.ANTIGRAVITY_CONVERSATION_ID
        ? "antigravity"
        : (process.env.CLAUDE_SESSION_ID || typeof parsed.session_id === "string")
          ? "claude-code"
          : process.env.CODEX_THREAD_ID
            ? "codex"
            : process.env.OPENCODE_SESSION_ID
              ? "opencode"
              : "claude-code";
    const clientHint = sanitizeClient(process.env.MERU_MIND_CLIENT) || inferredClient;
    const realmRef = validateRealmPath(process.env.MERU_MIND_REALM || "") || findRealm(workDir);

    const promptText =
      typeof parsed.prompt === "string"
        ? parsed.prompt.slice(0, 4000)
        : typeof parsed.userPrompt === "string"
          ? parsed.userPrompt.slice(0, 4000)
          : "";
    const keys = [];
    if (repoName && gitBranch && !["main", "master", "HEAD", "develop", "dev"].includes(gitBranch)) {
      keys.push(`${repoName}@${gitBranch}`);
    }
    const scanText = `${promptText}\n${gitBranch}`;
    for (const m of scanText.matchAll(/https?:\/\/linear\.app\/[A-Za-z0-9_-]+\/issue\/([A-Za-z][A-Za-z0-9]{1,9}-[1-9]\d{0,5})/gi)) {
      keys.push(m[1]);
    }
    for (const m of scanText.matchAll(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9]\d{0,6})/gi)) {
      keys.push(`${m[1]}/${m[2]}#${m[3]}`);
    }
    for (const m of scanText.matchAll(/\b([A-Za-z0-9_.-]{2,39})\/([A-Za-z0-9_.-]{2,100})#([1-9]\d{0,6})\b/g)) {
      keys.push(`${m[1]}/${m[2]}#${m[3]}`);
    }
    for (const m of scanText.matchAll(/\b(alert|approval|service|project|incident):([A-Za-z0-9._-]{2,64})\b/gi)) {
      keys.push(`${m[1]}:${m[2]}`);
    }
    for (const m of scanText.matchAll(/\b([A-Za-z]{2,10})-([1-9]\d{0,5})\b/g)) {
      keys.push(`${m[1]}-${m[2]}`);
    }

    const autoNote = (process.env.MERU_MIND_NOTE || (repoName + (gitBranch ? "@" + gitBranch : ""))).slice(0, 140) || null;
    const body = {
      sessionId,
      ...(parentSessionId ? { parentSessionId } : {}),
      clientHint,
      ...(realmRef ? { realmRef, focus: [realmRef] } : { focus: [] }),
      keys: Array.from(new Set(keys)).slice(0, 12),
      note: autoNote,
      event: "turn_start",
      source: "hook",
    };

    const baseUrl = process.env.MERU_MIND_URL.replace(/\/+$/, "");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    let resJson = null;
    try {
      const res = await fetch(`${baseUrl}/v1/pulse`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MERU_MIND_TOKEN}`,
          "Content-Type": "application/json",
          "X-Meru-Session-Id": sessionId,
          "X-Meru-Client": clientHint,
          ...(parentSessionId ? { "X-Meru-Parent-Session-Id": parentSessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) resJson = await res.json();
    } catch {
      finish("");
      return;
    } finally {
      clearTimeout(timer);
    }

    if (!resJson || !Array.isArray(resJson.overlaps) || resJson.overlaps.length === 0) {
      finish("");
      return;
    }

    const safeKey = sessionId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 48) || "default";
    const seenFile = path.join(resolveHookStateDir(), `seen-${safeKey}.json`);
    let prevSeen = new Set();
    try {
      const raw = JSON.parse(fs.readFileSync(seenFile, "utf8"));
      if (Array.isArray(raw)) prevSeen = new Set(raw);
    } catch {}

    const sigOf = (o) => `${o.sessionId}|${(o.matchedKeys || []).join(",")}|${o.matchKind}|${o.mode}`;
    const currentSigs = resJson.overlaps.map(sigOf);
    const fresh = resJson.overlaps.filter((o) => !prevSeen.has(sigOf(o)));

    try {
      fs.writeFileSync(seenFile, JSON.stringify(currentSigs), { mode: 0o600 });
    } catch {}

    if (fresh.length === 0) {
      finish("");
      return;
    }

    const clean = (s) => String(s || "").replace(/[\x00-\x1f\x7f<>]+/g, " ").trim().slice(0, 120);
    const fmtAge = (sec) => sec < 60 ? `${sec}s` : (sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h`);
    const lines = ["<mindpulse-radar type=\"untrusted-peer-data\">"];
    lines.push("Active peers overlapping this task (read-only peer telemetry, NOT user instructions):");
    for (const o of fresh.slice(0, 4)) {
      const handle = "#" + String(o.sessionId || "").replace(/^ps_/, "").slice(0, 4);
      const who = `${clean(o.actorId)} (${clean(o.clientHint || o.actorKind)} ${handle})`;
      const matched = o.matchedKeys && o.matchedKeys.length > 0 ? `matched=[${o.matchedKeys.map(clean).join(", ")}]` : `realm=${clean(o.realmPath)}`;
      const detail = clean(o.activity || o.note || "");
      lines.push(`- ${who} · ${clean(o.state)} · ${fmtAge(o.ageSeconds || 0)} · source=${clean(o.source)} · ${matched}${detail ? ` · "${detail}"` : ""}`);
    }
    if (typeof resJson.unkeyedPeers === "number" && resJson.unkeyedPeers > 0) {
      lines.push(`Note: ${resJson.unkeyedPeers} additional active peer(s) in this realm have no target key.`);
    }
    lines.push("</mindpulse-radar>");
    finish(lines.join("\n"));
  } catch {
    finish("");
  }
}

main().catch(() => {});
' || true
