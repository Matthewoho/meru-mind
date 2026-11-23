# Object Tree and Views Specification

## Purpose

Define the 4 canonical typed reference shapes, unified object read/write semantics, single-parent object hierarchy, P0-1 zero-leak mounted-realm sanitization, longest-visible-prefix `file:` resolution, `records.kind = 'thing'` anchors, and O(1)-query scoped read views (`whoami`, `tree`, `ls`, `show`, `search`, `changes`).

## Requirements

### Requirement: 4 Canonical Typed Reference Shapes and Verbatim Round-Trip
CLI and MCP SHALL share `src/engine/refs.ts` supporting 4 ref shapes: Realm (`/path`, `@mounted/<alias>`, `realm_...`), Unified Object (`<kind>:<name>`, `/<realm>/<kind>:<name>`, `obj_...`), Entry (`rec_...`, `sea_...`), and File (`file:/<realm>/<relPath>`, `file:@mounted/<alias>/<relPath>`). Every ref printed by `tree`, `ls`, `search`, or `changes` SHALL work verbatim in `show`. Stored `drive://...` sourceRefs SHALL format as `file:...`.

#### Scenario: Every printed ref round-trips verbatim into show
- **WHEN** `tree`, `ls`, `search`, or `changes` prints `/path`, `@mounted/<alias>`, `<kind>:<name>`, `rec_...`, or `file:...`
- **THEN** passing that exact ref to `show` succeeds without translation or prefix stripping

### Requirement: Unified Object Reads, Realm Qualification, and Zero-Leak Disambiguation
Unqualified `<kind>:<name>` reads (`show`, `ls`, `search --about`) SHALL take the union of visible `objects`, `resource_tags`, and active `thing` records. Realm-qualified `/<realm>/<kind>:<name>` SHALL scope to that realm's object, tags, and things. Unqualified matches against `>= 2` visible `objects` in different realms SHALL throw `AMBIGUOUS_REF` with visible-only `candidates`; hidden objects SHALL NEVER trigger ambiguity or leak.

#### Scenario: Hidden sibling object never triggers ambiguity or leaks into candidates
- **WHEN** a `tree` org has `service:core` in hidden `/alpha` and `service:core` in visible `/beta`
- **THEN** `show service:core` from `/beta` resolves cleanly to `/beta`'s object with zero ambiguity and zero `/alpha` leakage
- **AND** when two visible realms both hold `service:api`, `show service:api` throws `ambiguous_ref` listing only visible candidates

### Requirement: Unified `--about` Write Resolution
Everyday `write` / `mind_write` `--about <objRef>` SHALL attach unique visible `objects` to `entry_objects`, reject ambiguous visible objects with `AMBIGUOUS_REF`, link matching visible active `thing` records (`thingId` + tag), attach unmatched valid `<type>:<name>` strings to `resourceTags`, reject `file:` with `INVALID_INPUT`, and reject malformed tokens with `INVALID_REF`.

#### Scenario: Write --about resolves objects, things, and lightweight resource tags uniformly
- **WHEN** a caller writes with `--about service:payments` where no `object` row exists
- **THEN** the entry is tagged with `service:payments` and immediately discoverable via `ls service:payments` and `search --about service:payments`

### Requirement: Longest-Visible-Prefix `file:` Resolution and Reserved `file` Prefix
`file` SHALL be a reserved prefix rejected as an object `kind` on `object create` and tag prefix on `tag add` with `INVALID_INPUT`. `file:/<realm-path>/<rel-path>` and `file:@mounted/<alias>/<rel-path>` SHALL resolve by matching the longest visible sanitized realm prefix in `scope.readableDriveIds`, rejecting `..`, `.`, `\`, and null bytes with `INVALID_INPUT`, and returning identical opaque `NOT_FOUND` for hidden realms and missing files.

#### Scenario: Nested visible realm shadows root drive path while traversal is rejected
- **WHEN** root `/` has `ops/cicd/sop.md` and visible nested realm `/ops/cicd` has `sop.md`
- **THEN** `show file:/ops/cicd/sop.md` returns `/ops/cicd`'s file
- **AND** `show file:/ops/../secret.md` fails with `invalid_input`, while `object create --kind file` fails with `invalid_input`

### Requirement: Single-Parent Object Tree with Acyclicity and Hidden-Parent Sanitization
`ObjectEngine` SHALL manage organization-scoped `objects` anchored to a `realm_id` with optional `parent_object_id`, rejecting parent cycles (`INVALID_INPUT`) and non-empty deletes (`CONFLICT`). Linking or querying hidden/nonexistent objects SHALL return identical opaque `NOT_FOUND` (`"Object not found in visible scope"`). Whenever a visible object's `parentObjectId` lies outside `scope.readableLedgerIds`, all read outputs SHALL sanitize `parentObjectId = null`.

#### Scenario: Cycle is rejected and hidden-realm object parent is sanitized
- **WHEN** a caller moves object `A` under its descendant `B`, or views a mounted object whose parent lies in a hidden sibling realm
- **THEN** `moveObject()` throws `INVALID_INPUT`, and all read views sanitize hidden `parentObjectId` to `null`

### Requirement: Causal Object Lifecycle State, Aliases, and Read-Time Inactive Badges
CLI `object set` and `object alias` SHALL manage `objects` lifecycle state (`active`|`inactive`, validated `state_label`, strict `YYYY-MM-DD` `state_since`, mandatory active visible `--because` for non-humans) and explicit aliases (`<= 80` chars, `<= 32` per object, Latin `>= 3` / CJK `>= 2`, refusing `--remove` of `is_name = 1`), omitting active state JSON fields and stripping invisible `stateEvidenceId` everywhere. Read views SHALL add exception-only badges with zero ranking change.

#### Scenario: Inactive objects annotate visible reads conservatively without leaking hidden realms
- **WHEN** a visible object is marked `inactive` with `--label`, `--since`, `--because`, and aliases, while another inactive object exists in a hidden `tree` realm
- **THEN** `search`, `ls`, `show`, and `tree` attach exception-only badges (`⚠ <kind>:<name> <label>[ <since>]`, capped at 2 + `(+N)`, suppressed on the evidence record itself, connector-bounded for Latin) with zero ranking change
- **AND** hidden-realm inactive objects emit zero badges, zero `affected` counts, never trigger visible alias ambiguity, and have invisible `stateEvidenceId` stripped everywhere

### Requirement: Open-Mode Multi-Valued Realms and Tree-Mode Zero Amplification
In `open` mode, `entry_objects` links SHALL derive multi-valued realm membership for realm aggregation in `ls <realm>` and SDK-only opt-in `recall({ focusBoost: true })`. In `tree` mode, physical `realm_id` SHALL remain the sole hard isolation boundary: `entry_objects` SHALL never widen visibility, and all read views SHALL intersect results with readable scope and exclude `secret` entries.

#### Scenario: Multi-object entry aggregates in open mode without amplifying in tree mode
- **WHEN** an entry physically in realm `A` links to an object in realm `B`
- **THEN** `ls /b` includes it in `open` mode via SQL `UNION`, while in `tree` mode viewer `B` sees zero entries from hidden sibling `A`

### Requirement: Hard-Wall Zero-Leak Mounted Realm Sanitization (P0-1)
Across all read views (`whoami`, `listRealms`, `tree`, `ls`, `show`, `brief`, `search`, `recall`, `cat`, `replay`, `changes`) in JSON and Markdown, if any ancestor of a visible realm is outside `scope.readableLedgerIds`, `realm.path` SHALL be rewritten to `@mounted/<alias>` (derived strictly from its own `slug`, disambiguated by own short ID on collision) with `parentId = null`. Resolving the real hidden-ancestor path SHALL return opaque `NOT_FOUND`.

#### Scenario: Mounted realm under hidden branch leaks zero ancestor slugs or IDs
- **WHEN** viewer `C2` in a `tree` org mounts `C1` (`slug: "shared-c1"`) under hidden branch `B1` (`slug: "secret-branch-b1"`)
- **THEN** all JSON and Markdown views represent `C1` as `@mounted/shared-c1` with `parentId = null` and zero occurrences of `B1.id` or `"secret-branch-b1"`

### Requirement: Leak-Free `whoami` and Linux-Style `tree` View
`SeaEngine.whoami()` SHALL return org, actor, bound realm, capabilities, local-only `store`, strictly visible non-secret `corpus` counts, visible `latestSeq`, version/schemaVersion, and runnable `next` command. `SeaEngine.tree()` SHALL compute counts in `O(1)` `GROUP BY` queries, report unreadable raw seabed as `null` (`—`), restrict subtree rollups to self/descendants (`null` on ancestors/`@mounted`), and honor `--depth`/`-L` (default `1`) and `--limit` (default `60`).

#### Scenario: whoami hides sibling activity and tree renders unreadable raw as dash
- **WHEN** a hidden sibling realm writes entries after the viewer's last write in a `tree` org
- **THEN** `whoami` reports strictly visible counts and `latestSeq` excluding the hidden sibling
- **AND** `tree` computes counts in O(1) queries and renders unreadable descendant raw counts as `—` (`null`)

#### Scenario: tree caps inline objects per realm without duplicating an objects block
- **WHEN** a realm contains more than 6 objects while sibling realms follow at the same depth
- **THEN** `formatTreeMarkdown()` renders at most 5 inline objects per realm plus a `(+N more objects; run \`meru-mind ls <realm> --only objects\`)` summary line, includes `objects=` in subtree rollups, keeps subsequent sibling realms visible within the default 60-line cap, and omits any redundant trailing `## Objects` block

### Requirement: Literal Sensitivity Exclusion, Covering Counts, and Disjoint `UNION ALL` `ls`
`SqliteDb` SHALL emit literal `sensitivity != '...'` SQL predicates so active count and direct `ls` queries use partial covering indexes (`idx_records_live_counts`, `idx_records_live_ls`, `idx_seabed_live_ls`) with zero temp B-trees. `lsRealmEntriesUnified()` SHALL combine disjoint branches via `UNION ALL` with per-branch ordered `LIMIT (offset + limit)`, `CROSS JOIN` derived tables (`objects -> entry_objects -> PK`) for open-mode object links, and a sum of disjoint `COUNT(*)` subqueries.

#### Scenario: Covering index counts and disjoint UNION ALL ls avoid table lookups and temp B-trees
- **WHEN** `EXPLAIN QUERY PLAN` inspects `countActiveRecordsByRealm`, `countRecordsByKind`, `countSeabedByRealm`, and `lsRealmEntriesUnified` direct/open-mode branches (excluding `['secret']` or `['secret', 'confidential']`)
- **THEN** SQLite selects `USING COVERING INDEX` with zero `USE TEMP B-TREE FOR ORDER BY` on direct branches and drives open-mode links via `objects -> entry_objects -> PK` without scanning org-wide records

### Requirement: Polymorphic `show`, Single-Query `ls`, and `NOT_LISTABLE`
`SeaEngine.show()` SHALL inspect realms (`brief` with `kindHistogram`, `recentConclusions`, `childSummaries`, raw seabed lines capped at 500 chars in MD), unified objects (card + top 5 recent entries + `try`), entries (`cat` + optional `--history`/`--context`), and `file:` refs. `SeaEngine.ls()` SHALL support `--only`, `--kind`, `--about`, `--since`, `--until`, `--history`, `--limit` (default `20`), and `--cursor`, throwing `NOT_LISTABLE` on entries/files.

#### Scenario: ls on entry or file returns not_listable and show inspects all 4 ref shapes
- **WHEN** a caller invokes `ls rec_...` or `ls file:/readme.md`
- **THEN** `ls` throws `NOT_LISTABLE` (wire `not_listable`) with `try: meru-mind show <ref>`
- **AND** `show` returns the realm brief (with raw seabed lines capped at 500 chars in Markdown), unified object card, bounded entry content, or bounded file content respectively

#### Scenario: show realm childSummaries report real active conclusions, rules, and objects excluding secrets
- **WHEN** a child realm holds active `finding` conclusions, active `rule` records, objects, and a `secret` record
- **THEN** `show <parentRealm>` reports `activeConclusions`, `activeRules`, and `activeObjects` accurately excluding `secret` and hidden-realm items in both JSON and Markdown (`conclusions=..., rules=..., objects=...`)

### Requirement: Engine-Bounded `show` Window and Compact MCP JSON
`SeaEngine.show()` SHALL enforce engine-level bounded windowing (default `3500` chars, `--around`, `--cursor`, `--limit`, `--full`; 1:1 CLI and compact-JSON MCP) across records (keeping non-metadata payload keys, stripping `payload` whenever `!full` and truncated/cursor/oversized), seabed, distillations, and files (version-pinned `v<ver>:<offset>` cursor with `CONFLICT` on drift), stripping `payload` in `history`/`context`, and rejecting window flags on realms/objects (`INVALID_INPUT`).

#### Scenario: Engine-level show window bounds Markdown, JSON, and MCP with lossless cursor pagination
- **WHEN** a caller inspects a multi-kilobyte entry or file via CLI Markdown, CLI `--json`, or MCP `mind_show` with default cap, `--around`, `--cursor`, `--history`, or `--context`
- **THEN** output stays strictly bounded (including stripped payloads in `history`/`context`), continuation pages emit a 1-line header omitting repeated history/context, and stitching all cursor pages matches the canonical text losslessly across CJK, surrogate emojis, and newline-free mega-lines

#### Scenario: Window flag validation, file cursor conflict, and out-of-bounds recovery
- **WHEN** a caller passes window flags on a `/realm` or `kind:name` ref, passes `--around` with `--cursor`, reads a file whose version changed mid-pagination, or passes an out-of-bounds entry cursor
- **THEN** realm/object window flags and combined `--around`+`--cursor` fail with `INVALID_INPUT`, stale file cursors fail with `CONFLICT` + `try` hint, and out-of-bounds cursors return a clean empty slice

### Requirement: Identity Anchors (`thing`), Scoped `changes --in` SQL Pushdown, and EPIPE
Identity anchors SHALL reuse `records WHERE kind = 'thing'` and `external_ref` (no separate `things` table). `SeaEngine.changes()` with `--in <realm>` SHALL push narrowed visible realm IDs directly into `db.listChangeLog()` SQL (never JS post-filtered), preserving `B2` `scannedSeq` pagination across invisible rows. CLI read views SHALL default to compact Markdown, preserve `--json`, cap output with `--cursor` hints, and exit `0` on `EPIPE`.

#### Scenario: changes --in pushes realm filter into SQL without skipping visible changes
- **WHEN** 120 hidden-realm changes sit between two visible `/ops/cicd` changes and `changes --in /ops/cicd --limit 5` runs
- **THEN** SQL pushdown returns both visible changes in one page with accurate `latestSeq`, and piping CLI views to `head` exits cleanly without `EPIPE` crashes
