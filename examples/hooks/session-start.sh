#!/usr/bin/env bash
set -euo pipefail

# Opt-in SessionStart hook for coding harnesses (e.g. Claude Code).
# - Reads native harness JSON on stdin (`session_id`, `cwd`) so multiple concurrent sessions
#   in the same repository get distinct MindPulse identities and never overwrite each other.
# - Walks up to `.git` for `.meru-mind-realm`, auto-detects `repo@branch`, registers an initial
#   MindPulse heartbeat with branch context, and prints `meru-mind show <realm>` (inherited
#   binding rules, active decisions, and `activePeers`) straight into turn-0 context.
#
# Required env for remote team server:
#   MERU_MIND_URL="https://mind.example.com"
#   MERU_MIND_TOKEN="mm_live_..."
# Optional env:
#   MERU_MIND_CLIENT="claude-code"
#   MERU_MIND_SESSION_ID="<override>"
#   MERU_MIND_NOTE="<override>"

if [[ -z "${MERU_MIND_URL:-}" && -z "${MERU_MIND_HOME:-}" ]]; then
  exit 0
fi

HOOK_STDIN=""
if [[ ! -t 0 ]]; then
  HOOK_STDIN="$(cat || true)"
fi

PARSED_SESSION=""
PARSED_CWD=""
if [[ -n "$HOOK_STDIN" ]] && command -v node >/dev/null 2>&1; then
  IFS=$'\t' read -r PARSED_SESSION PARSED_CWD < <(
    printf '%s' "$HOOK_STDIN" | node -e '
      const fs = require("fs");
      try {
        const d = JSON.parse(fs.readFileSync(0, "utf8"));
        const sid = typeof d.session_id === "string" ? d.session_id.replace(/[\t\r\n]/g, "") : "";
        const cwd = typeof d.cwd === "string" ? d.cwd.replace(/[\t\r\n]/g, "") : "";
        process.stdout.write(sid + "\t" + cwd + "\n");
      } catch {
        process.stdout.write("\t\n");
      }
    ' 2>/dev/null || printf '\t\n'
  )
fi

WORK_DIR="${PARSED_CWD:-$PWD}"
[[ -d "$WORK_DIR" ]] || WORK_DIR="$PWD"

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

REALM_PATH="$(find_realm_marker || true)"
if [[ -z "$REALM_PATH" ]]; then
  exit 0
fi

GIT_BRANCH="$(git -C "$WORK_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
REPO_NAME="$(basename "$(git -C "$WORK_DIR" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$WORK_DIR")")"
DEFAULT_SESSION="${PARSED_SESSION:-${REPO_NAME}${GIT_BRANCH:+@${GIT_BRANCH}}}"
SESSION_ID="$(printf '%s' "${MERU_MIND_SESSION_ID:-$DEFAULT_SESSION}" | tr -cd 'A-Za-z0-9._:@/-' | cut -c1-64)"
CLIENT_HINT="$(printf '%s' "${MERU_MIND_CLIENT:-claude-code}" | tr -cd 'A-Za-z0-9._-' | cut -c1-32)"
AUTO_NOTE="${MERU_MIND_NOTE:-${REPO_NAME}${GIT_BRANCH:+@${GIT_BRANCH}}}"

export MERU_MIND_CLIENT="$CLIENT_HINT"
export MERU_MIND_SESSION_ID="${SESSION_ID:-default}"

if [[ -n "${MERU_MIND_URL:-}" && -n "${MERU_MIND_TOKEN:-}" ]] && command -v node >/dev/null 2>&1; then
  PAYLOAD="$(
    SESSION_ID="$MERU_MIND_SESSION_ID" CLIENT_HINT="$CLIENT_HINT" REALM_PATH="$REALM_PATH" AUTO_NOTE="$AUTO_NOTE" \
      node -e 'process.stdout.write(JSON.stringify({ sessionId: process.env.SESSION_ID, clientHint: process.env.CLIENT_HINT, realmRef: process.env.REALM_PATH, focus: [process.env.REALM_PATH], note: (process.env.AUTO_NOTE || "").slice(0, 140) || null }));'
  )"
  curl -fsS -m 3 -X POST "${MERU_MIND_URL%/}/v1/pulse" \
    -H "Authorization: Bearer ${MERU_MIND_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "X-Meru-Session-Id: ${MERU_MIND_SESSION_ID}" \
    -H "X-Meru-Client: ${CLIENT_HINT}" \
    -d "$PAYLOAD" >/dev/null 2>&1 || true
fi

read -r -a CLI <<< "${MERU_MIND_BIN:-meru-mind}"
"${CLI[@]}" show "$REALM_PATH" || true
