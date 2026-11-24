# The Meru Mind Realm Method

> How to design, migrate, and keep a **MindRealm** tree clean so `show <realm>` stays a crisp, trustworthy working brief for humans and agents.

---

## Why Realm Structure Matters

- **Flat vector stores** dump everything into one retrieval soup with no ownership, boundary, or binding constraints.
- **Folder-based note vaults** split files by document form (`/decisions`, `/notes`, `/resources`), so entering a work area never gives you the rules and current decisions that govern it.
- **Meru Mind's differentiator**: entering a realm and running `show <realm>` returns **the exact binding rules (including inherited ancestor rules), active decisions, and recent findings** for that area, where newer truths explicitly `supersede` older ones.

**The gold standard of a healthy tree**: *Can a brand-new teammate or agent run `show <realm>` once and immediately work within the right constraints?*

---

## 1. Four Ordered Design Questions (and Two Deliberate Couplings)

Do not treat Meru Mind primitives as generic folders. Decide placement by asking four questions in order:

1. **Realm (`--in /path`) — Where does this work happen, and what governs it?**
   A realm is a **working brief and governance unit**, not a file-type bucket.
2. **Object (`--about kind:name`) — Who or what entity is this about?**
   Objects span across realms and aggregate via `ls <kind>:<name>` across your visible scope.
   - **Deliberate Coupling #1 (Object Ownership -> Tier-3 Auto-Routing)**: When `--in` is omitted on `write`, an object owned by a non-root domain realm (e.g. `service:billing-api` owned by `/engineering/billing`) automatically routes the write to that realm. An org-wide cross-cutting object owned by `/` (e.g. `person:alice`, `vendor:cloudflare`) is **intentionally skipped** by Tier-3 routing so it never hijacks placement back to `/`.
3. **Kind + Supersedes (`--kind`, `--supersedes`) — What is its force and lifecycle?**
   - `rule` (human-only): **Deliberate Coupling #2** — inherits downward to every descendant realm and is never truncated on `show`.
   - `decision`: settled choice surfaced in that realm's brief.
   - `finding` / `proposal` / `verdict`: everyday observations and reviews; use `--supersedes <rec_id>` whenever replacing an outdated conclusion.
4. **Sensitivity & Org Policy (`--sensitivity`, `org set-policy open|tree`) — Who is allowed to read it?**
   - `open | tree` is an **organization-level policy**, not a per-realm flag.
   - In an **`open`** org, creating `/people/hr` isolates **nothing** — protect sensitive records individually with `--sensitivity secret` (excluded from search/brief/list) or `confidential` (excluded from exported slices).
   - In a **`tree`** org, **the realm tree is your access-control table** (ancestors read descendants; siblings are invisible without `@mount`). Design access boundaries *before* splitting sub-realms.

---

## 2. How to Decide Whether to Create a Realm

### Necessary Condition: The Brief Test
> *Would an agent starting work here need THIS realm's `show <realm>` brief, while an agent working elsewhere does not?*

No agent works "inside `/decisions`" or "inside `/facts`" — type buckets fail the Brief Test immediately.

### Three Valid Reasons (Pass the Brief Test + at least one)
1. **Rule Boundary**: This area carries distinct binding `rule`s that agents entering it must inherit.
2. **Ownership / Repo / Visibility Boundary**: It corresponds to a distinct team, product area, Git repository (`.meru-mind-realm`), or `tree`-mode isolation branch.
3. **Independent Lifecycle**: It is a finite initiative that should be frozen cleanly via `meru-mind realm archive <realm> --as-human` when finished (e.g. `/projects/q4-migration`).

### Bucket vs. Real Boundary (Same Name, Different Test)
- `/people` storing scattered facts about coworkers is a **type bucket** -> anchor `person:*` objects on `/` and write entries in the realm where the work happened.
- `/people` owned by a dedicated People/HR team with explicit owner & exclusion in `scope` (and `tree` isolation when needed) is a **real boundary**.
- `/resources` holding general playbooks is a **form bucket** -> move each playbook into the realm whose work it governs, and promote mandatory guardrails into `rule`s.
- **Beware self-reinforcing buckets**: if a bucket realm owns `service:*` or `person:*` objects, Tier-3 routing will pull future `--about` writes right back into that bucket. Anchor domain objects in domain realms and cross-cutting objects on `/`.

---

## 3. The Non-Leaf Constitution Principle & Scope Contract

- **Every non-leaf realm (root `/` and any parent realm with children)** holds **only rules and decisions that apply to its entire subtree**. Never use `/` or `/projects` as a fallback dumping ground for everyday notes.
- **`/inbox` is the single unassigned buffer**: omitted `--in` on `write` and unmatched fallback items on `import` (in `open` orgs) land in lazy `/inbox` for triage — never silently in `/`.
- **Every realm must have a one-line routing `scope`**:
  ```text
  Include: <what belongs here>. Exclude: <what belongs elsewhere>.
  ```
  Keep `scope` policy-agnostic and free of CLI flags so it stays valid in both `open` and `tree` organizations.

---

## 4. Starter Skeletons

Do not pre-create `/inbox` (Meru Mind creates it lazily only when needed). Executable starter scripts live under [`examples/realm-skeletons/`](../examples/realm-skeletons/).

### Skeleton A — Solo + Multi-Agent (`examples/realm-skeletons/solo.sh`)
- `/` — Org-wide personal rules, cross-cutting `person:*` / `vendor:*` objects
- `/ops` — Infrastructure, deployments, credentials hygiene, production runbooks
- `/engineering` — Codebases, architecture decisions, reusable technical standards
- `/projects/<slug>` — Active finite initiatives (archive each upon completion)

### Skeleton B — Small Team, 2–10 Humans + Agents (`examples/realm-skeletons/team.sh`)
- `/` — Company-wide constitution, security/compliance rules, org-wide decisions
- `/engineering` — Shared engineering standards (add child realms per repo/domain with `.meru-mind-realm`)
- `/ops` — Production infra, release pipelines, incidents, SLOs
- `/product` — Roadmap decisions, specs, customer findings
- `/projects/<slug>` — Cross-functional finite initiatives (archive when done)

---

## 5. Migration & Periodic Hygiene Workflow

1. **Migrate cleanly (never dump a legacy vault blindly into `/`)**:
   - First distill **5–15 binding `rule`s and active `decision`s** for each core realm — that delivers 80% of Meru Mind's value immediately.
   - Import Markdown vaults **per directory** with explicit `--in <realm> --base-dir <vault-root>` and always run **`--dry-run`** first:
     ```bash
     meru-mind import md ./vault/ops --in /ops --base-dir ./vault --dry-run
     ```
2. **Weekly / Monthly Hygiene (`meru-mind admin doctor`)**:
   - Run `meru-mind admin doctor` (works both locally and remotely over HTTP; pure read-only check on your visible `tree`).
   - Clear `/inbox` or any bloated parent realm using deterministic batch moves (previewed and executed on the exact same ID list):
     ```bash
     meru-mind entry move --ids-file ./triage-ops.txt --from /inbox --to /ops --dry-run --as-human
     meru-mind entry move --ids-file ./triage-ops.txt --from /inbox --to /ops --as-human
     ```
   - Archive completed project realms (`meru-mind realm archive /projects/<done> --as-human`).
   - Promote recurring incident findings into binding `rule`s (`meru-mind rule add --in <realm> ... --as-human`).

For guided agent-assisted bootstrapping, migration planning, and periodic hygiene plans, pair this guide with [`skills/meru-mind-curator/SKILL.md`](../skills/meru-mind-curator/SKILL.md).
