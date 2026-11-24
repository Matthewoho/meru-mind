#!/usr/bin/env bash
set -euo pipefail

# Opt-in Stop hook: fires when an agent finishes its current turn (waiting on human/peer/overnight).
# Transitions MindPulse state cleanly to `turn_ended` (24h retention + shutdown snapshot) so the
# session stays visible overnight without false stale eviction.
#
# Required env: MERU_MIND_URL, MERU_MIND_TOKEN
# Optional env: MERU_MIND_SESSION_ID, MERU_MIND_PARENT_SESSION_ID, MERU_MIND_CLIENT, MERU_MIND_REALM

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
CLIENT_HINT="$(printf '%s' "${MERU_MIND_CLIENT:-claude-code}" | tr -cd 'A-Za-z0-9._-' | cut -c1-32)"

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

PAYLOAD="$(
  SESSION_ID="${SESSION_ID:-default}" CLIENT_HINT="$CLIENT_HINT" REALM_REF="$REALM_REF" \
    node -e '
      const body = {
        sessionId: process.env.SESSION_ID || "default",
        clientHint: process.env.CLIENT_HINT || "claude-code",
        event: "turn_end",
        source: "hook",
      };
      if (process.env.REALM_REF) body.realmRef = process.env.REALM_REF;
      process.stdout.write(JSON.stringify(body));
    '
)"

curl -fsS -m 3 -X POST "${MERU_MIND_URL%/}/v1/pulse" \
  -H "Authorization: Bearer ${MERU_MIND_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Meru-Session-Id: ${SESSION_ID:-default}" \
  -H "X-Meru-Client: ${CLIENT_HINT}" \
  -d "$PAYLOAD" >/dev/null 2>&1 || true
