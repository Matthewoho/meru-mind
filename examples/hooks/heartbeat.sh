#!/usr/bin/env bash
set -euo pipefail

# Opt-in throttled PostToolUse heartbeat hook (at most once per 60s per session via local stamp).
# - Reads native harness JSON on stdin (`session_id`, `cwd`, optional `tool_input.file_path`) so
#   multiple concurrent sessions in the same repo keep separate MindPulse identities & stamp files.
# - Auto-publishes `repo@branch` (plus safe edited file basename only — NEVER full path or content)
#   to `POST /v1/pulse` with zero SQLite writes on the server.
#
# Required env: MERU_MIND_URL, MERU_MIND_TOKEN
# Optional env: MERU_MIND_SESSION_ID, MERU_MIND_CLIENT, MERU_MIND_REALM, MERU_MIND_NOTE

if [[ -z "${MERU_MIND_URL:-}" || -z "${MERU_MIND_TOKEN:-}" ]]; then
  exit 0
fi

HOOK_STDIN=""
if [[ ! -t 0 ]]; then
  HOOK_STDIN="$(cat || true)"
fi

PARSED_SESSION=""
PARSED_CWD=""
PARSED_FILE_BASE=""
if [[ -n "$HOOK_STDIN" ]] && command -v node >/dev/null 2>&1; then
  IFS=$'\t' read -r PARSED_SESSION PARSED_CWD PARSED_FILE_BASE < <(
    printf '%s' "$HOOK_STDIN" | node -e '
      const fs = require("fs");
      const path = require("path");
      try {
        const d = JSON.parse(fs.readFileSync(0, "utf8"));
        const sid = typeof d.session_id === "string" ? d.session_id.replace(/[\t\r\n]/g, "") : "";
        const cwd = typeof d.cwd === "string" ? d.cwd.replace(/[\t\r\n]/g, "") : "";
        const ti = d.tool_input && typeof d.tool_input === "object" ? d.tool_input : {};
        const fp = typeof ti.file_path === "string" ? ti.file_path : (typeof ti.path === "string" ? ti.path : "");
        const base = fp ? path.basename(fp).replace(/[\t\r\n]/g, "").slice(0, 48) : "";
        process.stdout.write(sid + "\t" + cwd + "\t" + base + "\n");
      } catch {
        process.stdout.write("\t\t\n");
      }
    ' 2>/dev/null || printf '\t\t\n'
  )
fi

WORK_DIR="${PARSED_CWD:-$PWD}"
[[ -d "$WORK_DIR" ]] || WORK_DIR="$PWD"

GIT_BRANCH="$(git -C "$WORK_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
REPO_NAME="$(basename "$(git -C "$WORK_DIR" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$WORK_DIR")")"
DEFAULT_SESSION="${PARSED_SESSION:-${REPO_NAME}${GIT_BRANCH:+@${GIT_BRANCH}}}"
SESSION_ID="$(printf '%s' "${MERU_MIND_SESSION_ID:-$DEFAULT_SESSION}" | tr -cd 'A-Za-z0-9._:@/-' | cut -c1-64)"
CLIENT_HINT="$(printf '%s' "${MERU_MIND_CLIENT:-claude-code}" | tr -cd 'A-Za-z0-9._-' | cut -c1-32)"
INTERVAL_SECONDS="${MERU_MIND_HEARTBEAT_INTERVAL:-60}"

SAFE_KEY="$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9._-' | cut -c1-48)"
STAMP_FILE="${TMPDIR:-/tmp}/meru-mind-pulse-${SAFE_KEY:-default}.stamp"
NOW_SEC="$(date +%s)"

if [[ -f "$STAMP_FILE" ]]; then
  PREV_SEC="$(cat "$STAMP_FILE" 2>/dev/null || echo 0)"
  if [[ "$PREV_SEC" =~ ^[0-9]+$ ]] && (( NOW_SEC - PREV_SEC < INTERVAL_SECONDS )); then
    exit 0
  fi
fi

printf '%s\n' "$NOW_SEC" > "$STAMP_FILE"

find_realm_marker() {
  local dir="$WORK_DIR"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/.meru-mind-realm" && ! -L "$dir/.meru-mind-realm" ]]; then
      head -n 1 "$dir/.meru-mind-realm" | tr -d '\r\n '
      return 0
    fi
    if [[ -e "$dir/.git" ]]; then
      break
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

REALM_REF="${MERU_MIND_REALM:-$(find_realm_marker || true)}"
REALM_REF="$(printf '%s' "$REALM_REF" | tr -cd 'A-Za-z0-9._/-' | cut -c1-120)"

AUTO_NOTE="${MERU_MIND_NOTE:-${REPO_NAME}${GIT_BRANCH:+@${GIT_BRANCH}}${PARSED_FILE_BASE:+ · ${PARSED_FILE_BASE}}}"

if command -v node >/dev/null 2>&1; then
  PAYLOAD="$(
    SESSION_ID="$SESSION_ID" CLIENT_HINT="$CLIENT_HINT" REALM_REF="$REALM_REF" AUTO_NOTE="$AUTO_NOTE" \
      node -e '
        const body = {
          sessionId: process.env.SESSION_ID || "default",
          clientHint: process.env.CLIENT_HINT || "claude-code",
          focus: process.env.REALM_REF ? [process.env.REALM_REF] : [],
          note: (process.env.AUTO_NOTE || "").slice(0, 140) || null,
        };
        if (process.env.REALM_REF) body.realmRef = process.env.REALM_REF;
        process.stdout.write(JSON.stringify(body));
      '
  )"
elif [[ -n "$REALM_REF" ]]; then
  PAYLOAD="$(printf '{"sessionId":"%s","clientHint":"%s","realmRef":"%s","focus":["%s"]}' "$SESSION_ID" "$CLIENT_HINT" "$REALM_REF" "$REALM_REF")"
else
  PAYLOAD="$(printf '{"sessionId":"%s","clientHint":"%s","focus":[]}' "$SESSION_ID" "$CLIENT_HINT")"
fi

curl -fsS -m 3 -X POST "${MERU_MIND_URL%/}/v1/pulse" \
  -H "Authorization: Bearer ${MERU_MIND_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Meru-Session-Id: ${SESSION_ID}" \
  -H "X-Meru-Client: ${CLIENT_HINT}" \
  -d "$PAYLOAD" >/dev/null 2>&1 || true
