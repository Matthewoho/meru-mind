---
name: meru-mind
description: Use when the `meru-mind` CLI or `mind_*` MCP tools are available and the task needs prior decisions or findings recalled, or new ones recorded. Covers orienting in realms, choosing where to write, and superseding outdated entries.
---

# Meru Mind

Shared long-term memory, partitioned into realms (`/`, `/ops`, `/ops/cicd`). The same 7 verbs exist on both surfaces: CLI `meru-mind <verb>` = MCP `mind_<verb>`, with flags as fields (`--in` → `in`; `--about`, `--supersedes` → arrays). Syntax: `meru-mind <verb> --help`. Errors carry a `try:`; follow it.

## Before you work
1. Run `whoami`, then the `tree` call it names under Next. Tree prints each realm's scope; pick the realm your task belongs to.
2. Run `show <that realm>` for its rules (inherited ones included), active decisions and recent entries. The rules bind you. If you are bound to `/`, still pick a sub-realm: the root brief covers only root's own entries.
3. Run `search "<words>"` before asking the user or re-deriving something. Snippets are truncated; `show rec_…` gives the full entry.

## When you learn something durable
Write once a conclusion is settled or verified: one fact per entry, readable without this conversation (absolute dates, real names).
- **Where**: pass `--in <realm>` when a scope clearly owns it. If none does, omit it; the entry goes to the workspace's default realm or to `/inbox` for a human to file. Use `--in /` only for an org-wide decision. The result reports where it landed; check it.
- **Kind**: use `--kind decision` for a settled choice (listed in that realm's brief; only `rule` binds child realms). Leave the default `finding` for everything else.
- **Updates**: if it replaces an existing entry, `search` for that entry and pass `--supersedes <rec_id>` (same kind, or `decision` superseding `proposal`/`claim`/`finding`, or `finding` superseding `claim`). Without it both stay current. If the error says it is already superseded, use the id the error names.
- **Entity**: add `--about <kind>:<name>` (e.g. `service:billing-api`) so `ls service:billing-api` finds it.

## Limits
Creating realms, writing rules, and moving or redacting entries are human-only, and MCP has only the 7 verbs. On `forbidden`, `not_found` or `realm_archived`, stop and tell the human; do not probe other paths or retry.
