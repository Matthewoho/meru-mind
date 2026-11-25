#!/usr/bin/env bash
set -euo pipefail

# Opt-in SessionEnd hook (Antigravity, Claude Code, Codex, OpenCode):
# Reads stdin JSON directly from fd 0 (no env-var size limit) and idempotently signs off ONLY that session.
# Required env: MERU_MIND_URL, MERU_MIND_TOKEN
# Optional env: MERU_MIND_SESSION_ID

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

export WORK_PWD="$PWD"

node -e '
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

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

function resolveHookStateDir() {
  const xdg = (process.env.XDG_CACHE_HOME || "").trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".cache");
  return path.join(base, "meru-mind", "hooks");
}

async function main() {
  let d = {};
  try {
    const rawStdin = readHookStdin();
    if (rawStdin.trim()) {
      const obj = JSON.parse(rawStdin);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        d = obj;
      }
    }
  } catch {}

  const isAgy = typeof d.conversationId === "string" && d.conversationId.trim().length > 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (isAgy) process.stdout.write("{}\n");
  };

  try {
    if (!process.env.MERU_MIND_URL || !process.env.MERU_MIND_TOKEN) {
      finish();
      return;
    }

    const agyWs = Array.isArray(d.workspacePaths) && typeof d.workspacePaths[0] === "string"
      ? d.workspacePaths[0].trim()
      : "";
    const rawCwd = (typeof d.cwd === "string" && d.cwd.trim()) || agyWs || process.env.WORK_PWD || process.cwd();
    const workDir = fs.existsSync(rawCwd) ? rawCwd : process.cwd();

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

    const safeKey = sessionId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 48) || "default";
    const stateDir = resolveHookStateDir();
    for (const fname of [
      `pulse-${safeKey}.json`,
      `seen-${safeKey}.json`,
    ]) {
      try {
        fs.rmSync(path.join(stateDir, fname), { force: true });
      } catch {}
    }

    const baseUrl = process.env.MERU_MIND_URL.replace(/\/+$/, "");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      await fetch(`${baseUrl}/v1/pulse`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${process.env.MERU_MIND_TOKEN}`,
          "Content-Type": "application/json",
          "X-Meru-Session-Id": sessionId,
        },
        body: JSON.stringify({ sessionId }),
        signal: ctrl.signal,
      });
    } catch {
      // non-fatal
    } finally {
      clearTimeout(timer);
    }
    finish();
  } catch {
    finish();
  }
}

main().catch(() => {});
' || true
