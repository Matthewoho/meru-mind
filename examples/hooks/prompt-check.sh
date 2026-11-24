#!/usr/bin/env bash
set -euo pipefail

# Opt-in UserPromptSubmit hook for coding harnesses (e.g. Claude Code).
# Runs BEFORE the agent makes its first tool call on each user prompt:
# - Reads native stdin JSON (`session_id`, `cwd`, `prompt`, optional `parent_session_id`).
# - Extracts deterministic target keys (Linear/GitHub issue & PR keys/URLs, service:*,
#   alert:*, non-default repo@branch) synchronously with zero LLM calls.
# - Performs a single POST /v1/pulse handshake (`event: "turn_start"`, `source: "hook"`).
# - Silent (0 stdout bytes) when no new overlaps exist; injects a concise untrusted-data
#   framed `<mindpulse-radar>` block ONLY when new overlaps appear.
#
# Required env: MERU_MIND_URL, MERU_MIND_TOKEN
# Optional env: MERU_MIND_CLIENT, MERU_MIND_SESSION_ID, MERU_MIND_PARENT_SESSION_ID, MERU_MIND_REALM

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

async function main() {
  let parsed = {};
  try {
    if (process.env.HOOK_STDIN && process.env.HOOK_STDIN.trim()) {
      parsed = JSON.parse(process.env.HOOK_STDIN);
    }
  } catch {}

  const rawCwd = typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd.trim() : process.env.WORK_PWD || process.cwd();
  const workDir = fs.existsSync(rawCwd) ? rawCwd : process.cwd();

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
  const realmRef = (process.env.MERU_MIND_REALM || findRealm(workDir) || "")
    .replace(/[^A-Za-z0-9._/-]/g, "")
    .slice(0, 120);

  const promptText = typeof parsed.prompt === "string" ? parsed.prompt.slice(0, 4000) : "";
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
    return;
  } finally {
    clearTimeout(timer);
  }

  if (!resJson || !Array.isArray(resJson.overlaps) || resJson.overlaps.length === 0) {
    return;
  }

  // Delta-only suppression: emit ONLY when newly appearing overlap signatures exist
  const safeKey = sessionId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 48) || "default";
  const seenFile = path.join(os.tmpdir(), `meru-mind-seen-${safeKey}.json`);
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

  if (fresh.length === 0) return;

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
  process.stdout.write(lines.join("\n") + "\n");
}

main().catch(() => {});
' || true
