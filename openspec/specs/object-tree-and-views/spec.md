# Object Tree and Views Specification

## Purpose

Define the single-parent object hierarchy, multi-valued realm derivation in `open` mode with zero amplification in `tree` mode, zero-leak mounted-realm and hidden-parent sanitization, realm path addressing with opaque `NOT_FOUND`, `records.kind = 'thing'` identity anchors, `<type>:<name>` resource tags, and O(1)-query scoped Markdown/JSON read views (`tree`, `ls`, `cat`, `brief`, `replay`, `changes`).

## Requirements

### Requirement: Single-Parent Object Tree with Acyclicity, Scoped Linking, and Hidden-Parent Sanitization
`ObjectEngine` SHALL manage organization-scoped `objects` nodes anchored to a `realm_id` with an optional single `parent_object_id`. Creating or moving an object SHALL verify that the target realm exists within write scope, the parent object exists in the same organization and visible scope, and no parent cycle is introduced. Deleting an object SHALL fail with `CONFLICT` while child objects exist. Linking an entry to an object (`linkEntryObject()` or write-path `objectIds`) SHALL require the target object to exist in the same organization and within the caller's readable scope, returning the exact opaque `NOT_FOUND` (`"Object not found in visible scope"`) for both hidden and nonexistent objects. Whenever a visible object's `parentObjectId` belongs to a realm outside `scope.readableLedgerIds`, ALL read outputs (`listObjects`, `getObject`, `tree`) SHALL set `parentObjectId = null`.

#### Scenario: Cycle in object hierarchy is rejected
- **WHEN** a caller attempts to move object `A` under its own descendant `B`
- **THEN** `moveObject()` rejects the call with `INVALID_INPUT` and leaves the existing parent unchanged

#### Scenario: Linking or querying a hidden-realm object in tree mode returns opaque NOT_FOUND and sanitizes hidden parents
- **WHEN** a viewer in sibling realm `beta` of a `tree` organization queries or links an object belonging to hidden sibling realm `alpha`
- **THEN** the error code and message are identical to querying or linking a nonexistent object ID (`NOT_FOUND`, `"Object not found in visible scope"`)
- **AND** if a visible mounted object has a `parentObjectId` anchored in hidden realm `alpha`, all outputs sanitize `parentObjectId` to `null`

### Requirement: Open-Mode Multi-Valued Realms and Tree-Mode Zero Amplification
In `open` mode, an entry linked via `entry_objects` to objects in multiple realms SHALL derive multi-valued realm membership for realm aggregation in `ls <realm>` and optional opt-in focus tie-breaking in `recall()` (`focusBoost: true`). In `tree` mode, physical `realm_id` SHALL remain the sole hard isolation partition: `entry_objects` SHALL NEVER widen visibility, and `ls`, `tree`, `cat`, `replay`, and `changes` SHALL strictly intersect every result with the caller's effective readable scope and exclude `secret` entries.

#### Scenario: Multi-object entry aggregates into linked realms in open mode but never amplifies in tree mode
- **WHEN** an entry physically stored in realm `A` is linked to an object in realm `B`
- **THEN** in an `open` organization, `ls` on realm `B` includes the entry via single-query SQL `UNION`
- **AND** after switching the organization to `tree` policy (or inside a `tree` organization), a viewer in realm `B` sees zero items from hidden sibling realm `A` in `ls obj:<id>` or `ls <realm>`

### Requirement: Hard-Wall Zero-Leak Mounted Realm Sanitization (P0-1)
Across ALL read views (`listRealms`, `tree`, `ls`, `brief`, `recall`, `cat`, `replay`, `changes`) in BOTH JSON and Markdown formats, if ANY ancestor of a visible realm is NOT in `scope.readableLedgerIds` (such as a mounted child `C1` under hidden branch `B1`):
- The engine SHALL rewrite `realm.path` to `"@mounted/" + alias`, where `alias` is derived strictly from the realm's own `slug` (deterministically disambiguated with its own short ID suffix on slug collision), NEVER exposing any hidden ancestor slug.
- The engine SHALL set `realm.parentId = null`, NEVER exposing any hidden ancestor realm ID.
- Resolving the real hidden-ancestor path (e.g. `/hidden-branch/shared`) from a viewer who cannot read the ancestor SHALL return opaque `NOT_FOUND` (`"Realm not found in visible scope"`), while `@mounted/<alias>` resolves cleanly.

#### Scenario: Mounted realm under hidden branch leaks zero ancestor slugs or IDs in JSON and Markdown
- **WHEN** viewer `C2` in a `tree` organization mounts child `C1` (`slug: "shared-c1"`) under hidden branch `B1` (`slug: "secret-branch-b1"`)
- **THEN** `listRealms`, `tree`, `ls`, `brief`, `recall`, `cat`, `replay`, and `changes` in both JSON and Markdown represent `C1` as `path = "@mounted/shared-c1"` with `parentId = null`
- **AND** zero occurrences of `B1.id` or `"secret-branch-b1"` appear anywhere in serialized JSON or Markdown output

### Requirement: Leak-Free Linux-Style `tree` View with Batch Aggregate SQL and Line Caps
`SeaEngine.tree()` and CLI `tree [target]` SHALL accept optional `target`, `--depth <n>` / `-L <n>` (default `1`; `0` = target only; `all` = unlimited up to line cap), `--objects` / `--no-objects` (default `true`), and `--limit <n>` (default `60` output lines with `... and N more`):
- All counts SHALL be computed via `GROUP BY realm_id` batch SQL (`O(1)` queries) strictly over readable, non-secret, non-redacted active entries.
- Unreadable raw seabed count SHALL be `null` (rendered as `—`, NEVER `0`).
- Subtree rollups (`subtreeConclusions`, `subtreeRules`, `subtreeRaw`, `subtreeObjects`) SHALL be computed ONLY for self and visible descendants (`null` on ancestors and `@mounted` realms). In `open` mode, physical direct counts SHALL be kept separate from `linkedViaObjects` counts (never double-counted).
- `childRealmsCount` SHALL count strictly visible child realms.
- Targeting a hidden realm SHALL return identical opaque `NOT_FOUND` (`"Realm not found in visible scope"`).

#### Scenario: Tree view enforces default depth 1, null for unreadable raw, direct-only counts on mounted/ancestor realms, and O(1) SQL queries
- **WHEN** `tree` runs on a multi-branch hierarchy with default options
- **THEN** it expands to depth `1`, renders unreadable raw seabed counts as `—` (`null`), omits subtree rollups on ancestors and `@mounted` realms, enforces the line cap, and executes a constant number of SQL queries independent of database size

### Requirement: `brief` Driven by Kind Histogram, `occurred_at` Recency, Batch SQL, and Bounded Child Summaries
`SeaEngine.brief()` SHALL report exact `kindHistogram` (`GROUP BY kind`), `recentConclusions` ordered by `(occurred_at IS NULL) ASC, occurred_at DESC, created_at DESC, id DESC`, `buckets` (`rules`, `conclusions`, `raw`), `pendingQuestions`, `activeThings`, `activeDecisions`, `realmCard` (with `cardSeq` and `changesSinceCard`), `rules`, `recentMessages`, and `childSummaries` computed via batch `GROUP BY` SQL (zero per-child N+1 loops) bounded by configurable cap (default `20`) with exact `omittedChildRealmsCount`.

#### Scenario: Brief computes child summaries in O(1) queries and caps omitted children
- **WHEN** `brief` runs on a parent realm with 25 visible child realms
- **THEN** `brief` returns 20 child summaries with `omittedChildRealmsCount = 5`, accurate `kindHistogram`, and constant SQL query count independent of child realm count

### Requirement: Single-Query `ls` with `UNION` SQL, Explicit Prefixes, Filters, and Sub-Realm Header
`SeaEngine.ls()` SHALL require explicit target prefixes with zero database existence-probe guessing:
- `/path`, `@mounted/<alias>`, `realm:<id|path>`, or `realm_...` -> `realm`
- `obj:<id|name>` or `obj_...` -> `object`
- `thing:<external_ref|id>` -> `thing`
- `tag:<type:name>` -> `resource`
- Bare unknown strings -> `INVALID_INPUT` with usage hint.

`ls` on a realm SHALL execute ONE SQL `UNION` combining physical `realm_id = ?` rows and (in `open` mode only) `entry_objects`-linked rows ordered by `(occurred_at IS NULL) ASC, occurred_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?` plus ONE exact `COUNT(*)` query and batched hydration (`O(1)` queries, zero `limit: 10_000`), supporting `--kind`, `--tag`, `--limit` (default `20`), `--offset`, and surfacing visible direct `subRealms`.

#### Scenario: Bare unknown ls target fails with INVALID_INPUT and open-mode ls uses O(1) UNION SQL
- **WHEN** a caller runs `ls unknown-bare-token` without an explicit prefix
- **THEN** `ls` throws `MindError("INVALID_INPUT")` with prefix usage guidance
- **AND** running `ls /realm` with `--kind` or `--tag` executes constant SQL queries independent of total corpus size and `limit`

### Requirement: Realm Path Addressing with Opaque NOT_FOUND
`ObjectEngine.resolveRealmRef()` and view commands SHALL accept a stable `realm_id`, slash path (`/ops/cicd`), or `@mounted/<alias>`. In `tree` mode, resolving a hidden realm path and resolving a nonexistent path SHALL return the exact same opaque `NOT_FOUND` (`"Realm not found in visible scope"`).

#### Scenario: Hidden realm path and nonexistent path are indistinguishable in tree mode
- **WHEN** a viewer in `/beta` of a `tree` organization resolves `/alpha/secret-team` (an existing hidden realm) and `/does/not/exist`
- **THEN** both calls throw `MindError` with `code = "NOT_FOUND"` and the exact same message `"Realm not found in visible scope"`

### Requirement: Identity Anchors Reuse `records.kind = 'thing'` and `external_ref`
Meru Mind SHALL NOT create a separate `things` table. `LedgerEngine.createThing()`, `listThings()`, and `findThingByExternalRef()` SHALL read and write `records WHERE kind = 'thing'` using `records.external_ref` as a pure identity anchor (storing no task status or assignee), thereby inheriting full `sensitivity`, `redact`, visibility, FTS5, and `change_log` guarantees.

#### Scenario: Thing identity anchors support external_ref deduplication and obey sensitivity and redaction
- **WHEN** a caller creates a `thing` with `externalRef = "tracker:ENG-42"` and invokes `findThingByExternalRef()` or `createThing({ dedupeByExternalRef: true })`
- **THEN** the existing visible active record is returned without duplicating rows
- **AND** a `secret` thing or a redacted thing is excluded from `findThingByExternalRef()` and `listThings()`

### Requirement: Validated Resource Tags and Scoped Tag Listing
`ObjectEngine.tagEntryResource()` and write-path `resourceTags` SHALL enforce `<type>:<name>` format (no whitespace) and normalize `<type>` to lowercase. `ObjectEngine.listResourceTags()` SHALL return tag counts strictly computed from visible, non-secret, non-redacted entries within caller scope.

#### Scenario: Malformed tags are rejected and secret or hidden tags are never listed
- **WHEN** a caller tags an entry with `"invalid tag"` (missing colon or containing whitespace)
- **THEN** the engine rejects the call with `INVALID_INPUT`
- **AND** `listResourceTags()` omits tags attached only to `secret`, redacted, or hidden-realm entries

### Requirement: `replay` Undated Anchor Fallback, Universal Output Caps, and Graceful `EPIPE`
- `SeaEngine.replay()` SHALL order surrounding entries by `(occurred_at, id)` (`timeBasis: "occurred_at"`) when the anchor has `occurredAt !== null`, and deterministically fall back to `(created_at, id)` (`timeBasis: "created_at"`) when the anchor has `occurredAt === null`.
- `SeaEngine.changes()` SHALL filter strictly by readable ledger/seabed realms, exclude `secret` entries, and advance `latestSeq` strictly to the last scanned row in the current batch.
- CLI view commands SHALL default to compact Markdown (preserving `--json`), enforce default output caps with omitted counts, and exit cleanly (`0`) on stdout `EPIPE` when piped to `head`.

#### Scenario: Undated anchor replay falls back to created_at and CLI handles EPIPE cleanly
- **WHEN** `replay` is invoked on an entry with `occurredAt = null`
- **THEN** it returns `timeBasis: "created_at"` with deterministic `before` and `after` windows ordered by `(created_at, id)`
- **AND** piping a large CLI view into a closed reader (`head -n 2`) exits cleanly without unhandled `EPIPE` crashes
