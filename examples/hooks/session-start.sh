#!/usr/bin/env bash
set -euo pipefail

# Opt-in SessionStart hook for coding harnesses (e.g. Claude Code).
# Reads `.meru-mind-realm` from the current repo (walks up to .git), runs `meru-mind show <realm>`
# so inherited rules, active decisions, and activePeers enter context immediately AND registers
# live MindPulse activity on the server in one round-trip.
#
# Required env for remote team server:
#   MERU_MIND_URL="https://mind.example.com"
#   MERU_MIND_TOKEN="mm_live_..."
# Optional env:
#   MERU_MIND_CLIENT="claude-code"   # self-reported display label
#   MERU_MIND_SESSION_ID="<id>"      # distinct session tag (defaults to pwd basename + pid)

if [[ -z "${MERU_MIND_URL:-}" && -z "${MERU_MIND_HOME:-}" ]]; then
  exit 0
fi

find_realm_marker() {
  local dir="$PWD"
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

export MERU_MIND_CLIENT="${MERU_MIND_CLIENT:-claude-code}"
export MERU_MIND_SESSION_ID="${MERU_MIND_SESSION_ID:-$(basename "$PWD")-$$}"

read -r -a CLI <<< "${MERU_MIND_BIN:-meru-mind}"
"${CLI[@]}" show "$REALM_PATH" || true
