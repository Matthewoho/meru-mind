#!/usr/bin/env bash
set -euo pipefail

# Opt-in SessionStart hook for coding harnesses (Antigravity, Claude Code, Codex, OpenCode).
# - Reads stdin JSON directly from fd 0 (no env-var size limit).
# - Parses BOTH camelCase (`conversationId`, `parentConversationId`, `workspacePaths[0]`)
#   and snake_case (`session_id`, `parent_session_id`, `cwd`) stdin JSON, plus env fallbacks.
# - Auto-resolves `parent-map.json` (written by `subagent-link.sh`) so subagents/swarm workers
#   automatically attach under their parent session in MindPulse.
# - Strictly validates `.meru-mind-realm` against `^/[A-Za-z0-9._/-]{0,119}$` and passes `--`
#   before the realm argument to `meru-mind show` to prevent CLI flag injection.
#
# Required env for remote team server:
#   MERU_MIND_URL="https://mind.example.com"
#   MERU_MIND_TOKEN="mm_live_..."
# Optional env:
#   MERU_MIND_CLIENT, MERU_MIND_SESSION_ID, MERU_MIND_PARENT_SESSION_ID, MERU_MIND_PARENT_MAP_FILE, MERU_MIND_NOTE

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

function resolveParentMapPath() {
  const override = (process.env.MERU_MIND_PARENT_MAP_FILE || "").trim();
  if (override) return path.resolve(override);
  const xdg = (process.env.XDG_CACHE_HOME || "").trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".cache");
  return path.join(base, "meru-mind", "parent-map.json");
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
  let d = {};
  try {
    const rawStdin = readHookStdin();
    if (rawStdin.trim()) {
      const parsed = JSON.parse(rawStdin);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        d = parsed;
      }
    }
  } catch {}

  const isAgy = typeof d.conversationId === "string" && d.conversationId.trim().length > 0;
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
    if (!process.env.MERU_MIND_URL && !process.env.MERU_MIND_HOME) {
      finish("");
      return;
    }

    const agyWs = Array.isArray(d.workspacePaths) && typeof d.workspacePaths[0] === "string"
      ? d.workspacePaths[0].trim()
      : "";
    const rawCwd = (typeof d.cwd === "string" && d.cwd.trim()) || agyWs || process.env.WORK_PWD || process.cwd();
    const workDir = fs.existsSync(rawCwd) ? rawCwd : process.cwd();

    const findRealm = (startDir) => {
      let dir = startDir;
      while (dir && dir !== path.dirname(dir)) {
        const marker = path.join(dir, ".meru-mind-realm");
        try {
          const st = fs.lstatSync(marker);
          if (st.isFile() && !st.isSymbolicLink()) {
            const first = fs.readFileSync(marker, "utf8").split(/\r?\n/)[0].trim();
            const safeRealm = validateRealmPath(first);
            if (safeRealm) return safeRealm;
            return "";
          }
        } catch {}
        if (fs.existsSync(path.join(dir, ".git"))) break;
        dir = path.dirname(dir);
      }
      return "";
    };

    const realmPath = findRealm(workDir);
    if (!realmPath) {
      finish("");
      return;
    }

    let gitBranch = "";
    let repoName = path.basename(workDir);
    try {
      gitBranch = execFileSync("git", ["-C", workDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const top = execFileSync("git", ["-C", workDir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (top) repoName = path.basename(top);
    } catch {}

    const nativeSid =
      sanitizeId(d.conversationId) ||
      sanitizeId(d.session_id) ||
      sanitizeId(process.env.ANTIGRAVITY_CONVERSATION_ID) ||
      sanitizeId(process.env.CLAUDE_SESSION_ID) ||
      sanitizeId(process.env.CODEX_THREAD_ID) ||
      sanitizeId(process.env.OPENCODE_SESSION_ID);

    const defaultSid = nativeSid || sanitizeId(repoName + (gitBranch ? "@" + gitBranch : ""));
    const sessionId = sanitizeId(process.env.MERU_MIND_SESSION_ID) || defaultSid || "default";

    let parentSessionId =
      sanitizeId(process.env.MERU_MIND_PARENT_SESSION_ID) ||
      sanitizeId(d.parentConversationId) ||
      sanitizeId(d.parent_session_id) ||
      sanitizeId(process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID) ||
      sanitizeId(process.env.CLAUDE_PARENT_SESSION_ID) ||
      sanitizeId(process.env.CODEX_PARENT_THREAD_ID) ||
      lookupParentFromMap(sessionId);
    if (parentSessionId === sessionId) parentSessionId = "";

    const inferredClient =
      isAgy || process.env.ANTIGRAVITY_CONVERSATION_ID
        ? "antigravity"
        : (process.env.CLAUDE_SESSION_ID || typeof d.session_id === "string")
          ? "claude-code"
          : process.env.CODEX_THREAD_ID
            ? "codex"
            : process.env.OPENCODE_SESSION_ID
              ? "opencode"
              : "claude-code";
    const clientHint = sanitizeClient(process.env.MERU_MIND_CLIENT) || inferredClient;
    const autoNote = (process.env.MERU_MIND_NOTE || (repoName + (gitBranch ? "@" + gitBranch : ""))).slice(0, 140) || null;

    if (process.env.MERU_MIND_URL && process.env.MERU_MIND_TOKEN) {
      const keys = [];
      if (repoName && gitBranch && !["main", "master", "HEAD", "develop", "dev"].includes(gitBranch)) {
        keys.push(`${repoName}@${gitBranch}`);
      }
      const body = {
        sessionId,
        ...(parentSessionId ? { parentSessionId } : {}),
        clientHint,
        realmRef: realmPath,
        focus: [realmPath],
        keys,
        note: autoNote,
        source: "hook",
      };
      const baseUrl = process.env.MERU_MIND_URL.replace(/\/+$/, "");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      try {
        await fetch(`${baseUrl}/v1/pulse`, {
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
      } catch {
        // non-fatal
      } finally {
        clearTimeout(timer);
      }
    }

    const cliParts = (process.env.MERU_MIND_BIN || "meru-mind").trim().split(/\s+/).filter(Boolean);
    const childEnv = {
      ...process.env,
      MERU_MIND_CLIENT: clientHint,
      MERU_MIND_SESSION_ID: sessionId,
      ...(parentSessionId ? { MERU_MIND_PARENT_SESSION_ID: parentSessionId } : {}),
    };
    let showOut = "";
    try {
      showOut = execFileSync(cliParts[0], [...cliParts.slice(1), "show", "--", realmPath], {
        cwd: workDir,
        encoding: "utf8",
        env: childEnv,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      showOut = "";
    }
    finish(showOut);
  } catch {
    finish("");
  }
}

main().catch(() => {});
' || true
