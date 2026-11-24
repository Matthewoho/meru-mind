#!/usr/bin/env bash
set -euo pipefail

# Opt-in PostToolUse heartbeat + delta overlap hook:
# - Reads native harness JSON on stdin (`session_id`, `cwd`, `tool_name`, `tool_input.file_path`).
# - Automatically promotes `mode: "working"` on edit/write/shell mutation tools (never relies on
#   the model remembering to self-declare).
# - Throttled to at most once per 60s per session (bypasses throttle on first promotion to working
#   or editing a new file) with ZERO SQLite writes on the server.
# - Silent (0 stdout bytes) normally; emits a concise framed `<mindpulse-radar>` delta warning
#   ONLY when a newly colliding peer appears mid-flight.
#
# Required env: MERU_MIND_URL, MERU_MIND_TOKEN
# Optional env: MERU_MIND_SESSION_ID, MERU_MIND_PARENT_SESSION_ID, MERU_MIND_CLIENT, MERU_MIND_REALM, MERU_MIND_NOTE

if [[ -z "${MERU_MIND_URL:-}" || -z "${MERU_MIND_TOKEN:-}" ]]; then
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

HOOK_STDIN=""
if [[ ! -t 0 ]]; then
  HOOK_STDIN="$(cat || true)"
fi

export HOOK_STDIN
export WORK_PWD="$PWD"

node -e '
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const WRITE_TOOLS = new Set([
  "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash",
  "edit_file", "write_file", "replace_file_content", "multi_replace_file_content", "write_to_file", "run_command",
]);

async function main() {
  let parsed = {};
  try {
    if (process.env.HOOK_STDIN && process.env.HOOK_STDIN.trim()) {
      parsed = JSON.parse(process.env.HOOK_STDIN);
    }
  } catch {}

  const rawCwd = typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd.trim() : process.env.WORK_PWD || process.cwd();
  const workDir = fs.existsSync(rawCwd) ? rawCwd : process.cwd();

  let gitBranch = "";
  let repoName = path.basename(workDir);
  try {
    gitBranch = execFileSync("git", ["-C", workDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const top = execFileSync("git", ["-C", workDir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top) repoName = path.basename(top);
  } catch {}

  const nativeSid = typeof parsed.session_id === "string" ? parsed.session_id.trim() : "";
  const defaultSid = nativeSid || (repoName + (gitBranch ? "@" + gitBranch : ""));
  const sessionId = (process.env.MERU_MIND_SESSION_ID || defaultSid || "default")
    .replace(/[^A-Za-z0-9._:@/-]/g, "")
    .slice(0, 64) || "default";
  const parentSessionId = (process.env.MERU_MIND_PARENT_SESSION_ID || (typeof parsed.parent_session_id === "string" ? parsed.parent_session_id : ""))
    .replace(/[^A-Za-z0-9._:@/-]/g, "")
    .slice(0, 64) || null;
  const clientHint = (process.env.MERU_MIND_CLIENT || "claude-code")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 32) || "claude-code";

  const toolName = typeof parsed.tool_name === "string" ? parsed.tool_name.trim() : "";
  const isMutationTool = WRITE_TOOLS.has(toolName);
  const ti = parsed.tool_input && typeof parsed.tool_input === "object" ? parsed.tool_input : {};
  const rawFp = typeof ti.file_path === "string" ? ti.file_path : (typeof ti.path === "string" ? ti.path : "");
  const fileBase = rawFp ? path.basename(rawFp).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 48) : "";

  const intervalSec = Math.max(5, Number(process.env.MERU_MIND_HEARTBEAT_INTERVAL || 60) || 60);
  const safeKey = sessionId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 48) || "default";
  const stampFile = path.join(os.tmpdir(), `meru-mind-pulse-${safeKey}.json`);
  const nowSec = Math.floor(Date.now() / 1000);

  let prev = { ts: 0, working: false, fileBase: "" };
  try {
    prev = Object.assign(prev, JSON.parse(fs.readFileSync(stampFile, "utf8")));
  } catch {}

  const promotedToWorking = isMutationTool && !prev.working;
  const switchedFile = isMutationTool && fileBase && fileBase !== prev.fileBase;
  if (!promotedToWorking && !switchedFile && nowSec - prev.ts < intervalSec) {
    return;
  }

  try {
    fs.writeFileSync(stampFile, JSON.stringify({ ts: nowSec, working: prev.working || isMutationTool, fileBase: fileBase || prev.fileBase }), { mode: 0o600 });
  } catch {}

  const findRealm = (startDir) => {
    let dir = startDir;
    while (dir && dir !== path.dirname(dir)) {
      const marker = path.join(dir, ".meru-mind-realm");
      try {
        const st = fs.lstatSync(marker);
        if (st.isFile() && !st.isSymbolicLink()) {
          const first = fs.readFileSync(marker, "utf8").split(/\r?\n/)[0].trim();
          if (first) return first;
        }
      } catch {}
      if (fs.existsSync(path.join(dir, ".git"))) break;
      dir = path.dirname(dir);
    }
    return "";
  };

  const realmRef = (process.env.MERU_MIND_REALM || findRealm(workDir) || "")
    .replace(/[^A-Za-z0-9._/-]/g, "")
    .slice(0, 120);

  const keys = [];
  if (repoName && gitBranch && !["main", "master", "HEAD", "develop", "dev"].includes(gitBranch)) {
    keys.push(`${repoName}@${gitBranch}`);
  }
  if (fileBase && isMutationTool) {
    keys.push(`file:${fileBase}`);
  }

  const autoNote = (
    process.env.MERU_MIND_NOTE ||
    `${repoName}${gitBranch ? "@" + gitBranch : ""}${fileBase ? " · " + fileBase : ""}`
  ).slice(0, 140) || null;

  const body = {
    sessionId,
    ...(parentSessionId ? { parentSessionId } : {}),
    clientHint,
    ...(realmRef ? { realmRef, focus: [realmRef] } : { focus: [] }),
    keys,
    note: autoNote,
    event: "heartbeat",
    source: "hook",
    ...(isMutationTool ? { mode: "working" } : {}),
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
    return;
  } finally {
    clearTimeout(timer);
  }

  if (!resJson || !Array.isArray(resJson.overlaps) || resJson.overlaps.length === 0) {
    return;
  }

  // Mid-flight delta alert: ONLY warn on NEW key/file collisions (or new working peer)
  const seenFile = path.join(os.tmpdir(), `meru-mind-seen-${safeKey}.json`);
  let prevSeen = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(seenFile, "utf8"));
    if (Array.isArray(raw)) prevSeen = new Set(raw);
  } catch {}

  const sigOf = (o) => `${o.sessionId}|${(o.matchedKeys || []).join(",")}|${o.matchKind}|${o.mode}`;
  const currentSigs = resJson.overlaps.map(sigOf);
  const fresh = resJson.overlaps.filter((o) => !prevSeen.has(sigOf(o)) && (o.matchKind === "key" || o.mode === "working"));

  try {
    fs.writeFileSync(seenFile, JSON.stringify(Array.from(new Set([...prevSeen, ...currentSigs]))), { mode: 0o600 });
  } catch {}

  if (fresh.length === 0) return;

  const clean = (s) => String(s || "").replace(/[\x00-\x1f\x7f<>]+/g, " ").trim().slice(0, 120);
  const o = fresh[0];
  const handle = "#" + String(o.sessionId || "").replace(/^ps_/, "").slice(0, 4);
  const matched = o.matchedKeys && o.matchedKeys.length > 0 ? o.matchedKeys.map(clean).join(", ") : clean(o.realmPath);
  const detail = clean(o.activity || o.note || "");
  process.stdout.write(
    `<mindpulse-radar type="untrusted-peer-data">New overlapping peer: ${clean(o.actorId)} (${clean(o.clientHint || o.actorKind)} ${handle}) · ${clean(o.state)} · matched=[${matched}]${detail ? ` · "${detail}"` : ""}</mindpulse-radar>\n`,
  );
}

main().catch(() => {});
' || true
