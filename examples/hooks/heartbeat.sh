#!/usr/bin/env bash
set -euo pipefail

# Opt-in throttled PostToolUse heartbeat hook (at most once per 60s via local stamp file).
# Keeps an active coding session marked online in MindPulse without writing to SQLite.
#
# Required env: MERU_MIND_URL, MERU_MIND_TOKEN
# Optional env: MERU_MIND_SESSION_ID, MERU_MIND_CLIENT, MERU_MIND_REALM

if [[ -z "${MERU_MIND_URL:-}" || -z "${MERU_MIND_TOKEN:-}" ]]; then
  exit 0
fi

SESSION_ID="$(printf '%s' "${MERU_MIND_SESSION_ID:-$(basename "$PWD")}" | tr -cd 'A-Za-z0-9._:-' | cut -c1-64)"
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

REALM_REF="${MERU_MIND_REALM:-}"
if [[ -z "$REALM_REF" && -f ".meru-mind-realm" && ! -L ".meru-mind-realm" ]]; then
  REALM_REF="$(head -n 1 ".meru-mind-realm" | tr -d '\r\n ')"
fi
REALM_REF="$(printf '%s' "$REALM_REF" | tr -cd 'A-Za-z0-9._/-' | cut -c1-120)"

if [[ -n "$REALM_REF" ]]; then
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
