#!/usr/bin/env bash
set -euo pipefail

# Opt-in SessionEnd hook: reads native harness `session_id` from stdin JSON (matching
# session-start.sh / heartbeat.sh) and idempotently signs off ONLY that session.
# Required env: MERU_MIND_URL, MERU_MIND_TOKEN
# Optional env: MERU_MIND_SESSION_ID

if [[ -z "${MERU_MIND_URL:-}" || -z "${MERU_MIND_TOKEN:-}" ]]; then
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
GIT_BRANCH="$(git -C "$WORK_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
REPO_NAME="$(basename "$(git -C "$WORK_DIR" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$WORK_DIR")")"
DEFAULT_SESSION="${PARSED_SESSION:-${REPO_NAME}${GIT_BRANCH:+@${GIT_BRANCH}}}"
SESSION_ID="$(printf '%s' "${MERU_MIND_SESSION_ID:-$DEFAULT_SESSION}" | tr -cd 'A-Za-z0-9._:@/-' | cut -c1-64)"

SAFE_KEY="$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9._-' | cut -c1-48)"
rm -f "${TMPDIR:-/tmp}/meru-mind-pulse-${SAFE_KEY:-default}.stamp" >/dev/null 2>&1 || true

PAYLOAD="$(printf '{"sessionId":"%s"}' "$SESSION_ID")"

curl -fsS -m 3 -X DELETE "${MERU_MIND_URL%/}/v1/pulse" \
  -H "Authorization: Bearer ${MERU_MIND_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Meru-Session-Id: ${SESSION_ID}" \
  -d "$PAYLOAD" >/dev/null 2>&1 || true
