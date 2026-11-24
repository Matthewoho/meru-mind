---
name: meru-mind-curator
description: Use on demand when bootstrapping a new Meru Mind realm tree, migrating an existing Markdown/JSONL knowledge base, or running periodic realm hygiene (`admin doctor`, `/inbox` triage, `supersedes` cleanup, archiving finished projects, and distilling rules). Do NOT preload on every everyday coding turn; use `meru-mind` for routine reads/writes.
---

# Meru Mind Curator (Architecture, Migration & Hygiene)

Reference methodology: [`docs/REALM_METHOD.md`](../../docs/REALM_METHOD.md).

## Hard Governance Rule (Plan-Only for Agents)

Creating realms, updating realm `scope`, adding `rule`s, moving entries (`entry move`), archiving realms, and redacting are **human-only** operations.
- **NEVER** pass `--as-human` autonomously on behalf of a human.
- **Always** produce a reviewable plan: exact commands, mapping files, and `--ids-file` ID lists for the human operator to inspect and run (or preview with `--dry-run` first).

---

## Workflow 1: Cold-Start Bootstrap (New Organization)

1. Interview the human briefly (max 5 questions):
   - Solo or multi-person team? Do branches need hard sibling isolation (`tree`) or shared visibility (`open`)?
   - What are the 2–5 durable working areas (teams, repos, or domains) that each need a distinct `show <realm>` brief?
   - Which active finite projects should live under `/projects/<slug>` so they can be archived when done?
   - What 3–5 non-negotiable guardrails should become binding `rule`s on `/` or core domains on day one?
   - Which cross-cutting entities (`person:*`, `vendor:*`) belong on `/`, and which domain objects (`service:*`, `project:*`) belong in domain realms?
2. Reject type-bucket realms (`/decisions`, `/notes`, `/facts`, `/resources`, or catch-all `/people`) unless a realm passes the **Brief Test** ("an agent working here needs this exact `show <realm>` brief, while others do not") plus at least one of Rule / Boundary / Lifecycle.
3. Draft an executable plan for the human:
   - `realm create` commands with one-line `Include: ... Exclude: ...` scopes (never pre-create `/inbox`; it is lazy).
   - `.meru-mind-realm` files for each code repository (single-line realm path, e.g. `/engineering/api`).
   - Initial `rule add` commands so `show <realm>` immediately delivers high-value constraints.

---

## Workflow 2: Legacy Vault Migration (Markdown / JSONL)

Never dump an unsorted vault into `/` or rely on `/inbox` to absorb thousands of unmatched historical records.

1. **Sample first**: Inspect 50–100 representative files/rows and list the natural directory/domain boundaries.
2. **Distill rules & key decisions first**: Before bulk importing history, extract the 5–15 most important rules and active decisions per realm so every realm's `show` brief is useful immediately.
3. **Anchor objects cleanly**:
   - Domain-owned objects (`service:billing-api` -> `/engineering/billing`) become Tier-3 auto-routing magnets.
   - Cross-cutting objects (`person:alice`, `vendor:cloudflare`) belong on `/` so they never hijack routing into a bucket.
4. **Use directory-scoped imports + mandatory `--dry-run`**:
   - Markdown frontmatter often lacks a realm field; directory paths carry the real structure. Import each subfolder explicitly with `--in <realm> --base-dir <vault-root>`:
     ```bash
     meru-mind import md ./vault/ops --in /ops --base-dir ./vault --dry-run
     ```
   - For JSONL, test your `mapping.json` with `meru-mind import jsonl ./events.jsonl --map ./mapping.json --dry-run`.
   - Fix **every** entry under `unresolvedRealms` and minimize `defaultRealmCount` before handing the final non-dry-run commands to the human.
5. **Post-import gate**: Run `meru-mind admin doctor` and verify zero `warn` findings.

---

## Workflow 3: Periodic Hygiene Loop (Weekly / Monthly)

1. Run read-only diagnostics:
   ```bash
   meru-mind admin doctor
   ```
   (Works identically locally and remotely via `MERU_MIND_URL` + `MERU_MIND_TOKEN`.)
2. **Triage `/inbox` and any bloated parent realm (`/` or non-leaf parents)**:
   - List entries (`meru-mind ls /inbox --only entries --json` or `meru-mind ls / --only entries --json`).
   - Group entry IDs by target realm into plain ID files (one `rec_...` per line, `#` comments allowed) and hand the human exact preview + commit commands:
     ```bash
     meru-mind entry move --ids-file ./move-to-ops.txt --from /inbox --to /ops --dry-run --as-human
     meru-mind entry move --ids-file ./move-to-ops.txt --from /inbox --to /ops --as-human
     ```
3. **Repair missing scopes**: For every `missing_scope` warning, draft exact `meru-mind realm set <realm> --scope "Include: ... Exclude: ..." --as-human` commands.
4. **Fight truth rot**:
   - Inspect active decisions in core realms (`show <realm>`); identify stale/contradictory entries that should be superseded (`write --supersedes <rec_id>`).
   - Identify finished `/projects/<slug>` realms for `meru-mind realm archive /projects/<slug> --as-human`.
   - Spot repeated incident findings and propose promoting them into durable `rule add` commands.
