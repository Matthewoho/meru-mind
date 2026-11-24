#!/usr/bin/env bash
set -euo pipefail

# Starter MindRealm skeleton for a 2–10 person human + AI agent team.
# Note: /inbox is created lazily by Meru Mind on demand — never pre-create it manually.
# Usage (local):
#   MERU_MIND_HOME="$HOME/.meru-mind-team" MERU_ORG_NAME="Acme" ./examples/realm-skeletons/team.sh
# Usage (remote server):
#   MERU_MIND_URL="https://mind.example.com" MERU_MIND_TOKEN="<human-admin-token>" ./examples/realm-skeletons/team.sh

read -r -a CLI <<< "${MERU_MIND_BIN:-meru-mind}"
HUMAN_FLAGS=()
if [[ -z "${MERU_MIND_URL:-}" ]]; then
  HUMAN_FLAGS=(--as-human)
  "${CLI[@]}" admin init --org "${MERU_ORG_NAME:-Team}" --policy "${MERU_ORG_POLICY:-open}"
fi

"${CLI[@]}" realm create --parent / --slug engineering --name "Engineering" \
  --scope "Include: architecture, shared services, code standards, and repo-level engineering decisions. Exclude: production release tickets and product marketing." \
  "${HUMAN_FLAGS[@]}"

"${CLI[@]}" realm create --parent / --slug ops --name "Operations" \
  --scope "Include: cloud infrastructure, releases, rollbacks, SLOs, monitoring, and incident postmortems. Exclude: feature discovery and UI prototypes." \
  "${HUMAN_FLAGS[@]}"

"${CLI[@]}" realm create --parent / --slug product --name "Product" \
  --scope "Include: product specifications, roadmap trade-offs, user research, and launch readiness. Exclude: infrastructure topology and secrets." \
  "${HUMAN_FLAGS[@]}"

"${CLI[@]}" realm create --parent / --slug projects --name "Projects" \
  --scope "Include: cross-project portfolio rules and coordination decisions only. Exclude: project-specific work (create /projects/<slug> and archive when done)." \
  "${HUMAN_FLAGS[@]}"

echo "Team skeleton ready. Next: add .meru-mind-realm markers to repos, add binding rules, and run 'meru-mind admin doctor'."
