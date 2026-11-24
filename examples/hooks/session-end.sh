#!/usr/bin/env bash
set -euo pipefail

# Opt-in SessionEnd hook: idempotently signs off the caller's own MindPulse session.
# Required env: MERU_MIND_URL, MERU_MIND_TOKEN
# Optional env: MERU_MIND_SESSION_ID

if [[ -z "${MERU_MIND_URL:-}" || -z "${MERU_MIND_TOKEN:-}" ]]; then
  exit 0
fi

SESSION_ID="$(printf '%s' "${MERU_MIND_SESSION_ID:-$(basename "$PWD")}" | tr -cd 'A-Za-z0-9._:-' | cut -c1-64)"
PAYLOAD="$(printf '{"sessionId":"%s"}' "$SESSION_ID")"

curl -fsS -m 3 -X DELETE "${MERU_MIND_URL%/}/v1/pulse" \
  -H "Authorization: Bearer ${MERU_MIND_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Meru-Session-Id: ${SESSION_ID}" \
  -d "$PAYLOAD" >/dev/null 2>&1 || true
