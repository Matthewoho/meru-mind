#!/usr/bin/env bash
set -euo pipefail

# Starter MindRealm skeleton for a solo developer + multiple coding agents.
# Note: /inbox is created lazily by Meru Mind on demand — never pre-create it manually.
# Usage:
#   MERU_MIND_HOME="$HOME/.meru-mind" ./examples/realm-skeletons/solo.sh
# Or against a remote team server:
#   MERU_MIND_URL="https://mind.example.com" MERU_MIND_TOKEN="<human-token>" ./examples/realm-skeletons/solo.sh

read -r -a CLI <<< "${MERU_MIND_BIN:-meru-mind}"
HUMAN_FLAGS=()
if [[ -z "${MERU_MIND_URL:-}" ]]; then
  HUMAN_FLAGS=(--as-human)
  "${CLI[@]}" admin init --org "${MERU_ORG_NAME:-Personal}" --personal --policy open
fi

"${CLI[@]}" realm create --parent / --slug ops --name "Operations" \
  --scope "Include: infra, deployments, incidents, access boundaries, and production runbooks. Exclude: product feature specs." \
  "${HUMAN_FLAGS[@]}"

"${CLI[@]}" realm create --parent / --slug engineering --name "Engineering" \
  --scope "Include: codebase architecture, shared technical standards, benchmarks, and debugging findings. Exclude: one-off ops alerts." \
  "${HUMAN_FLAGS[@]}"

"${CLI[@]}" realm create --parent / --slug projects --name "Projects" \
  --scope "Include: portfolio-level decisions spanning multiple active projects. Exclude: individual project notes (create /projects/<slug> instead)." \
  "${HUMAN_FLAGS[@]}"

echo "Solo skeleton ready. Next: add your first binding rules with 'meru-mind rule add --in / ...' and run 'meru-mind admin doctor'."
