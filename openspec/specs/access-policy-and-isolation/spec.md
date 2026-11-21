# Access Policy and Isolation Specification

## Purpose

Define organization-level visibility modes (`open` and `tree`), unambiguous separation of session binding (`MERU_MIND_ORG_ID`, `MERU_MIND_VIEWER_REALM_ID`), positional `<target>`, and `--focus` / `focus` narrowing, complete removal of `--realm`, unified MCP `target` + `focus` schemas, default-safe CLI privilege elevation, sensitivity enforcement, and cross-reference leak sanitization.

## Requirements

### Requirement: Organization Visibility Policies (`open` and `tree`)
`computeVisibleScope()` SHALL remain exported as a pure tree-visibility function. `resolveAccessScope()`, `resolveAccess()`, `assertAccess()`, and all engine read/write/drive/export entrypoints SHALL enforce the organization's `policy`:
- Cross-organization access SHALL always resolve to `'none'` in both `open` and `tree` modes.
- In `tree` mode, visibility follows strict self/ancestor/descendant/explicit-`@mount` rules; descendant raw seabed requires explicit `includeDescendantSeabed`.
- In `open` mode, `readableLedgerIds`, `readableDriveIds`, and `readableSeabedIds` include all realms within the same organization, while `computeVisibleScope()` provides `focusRealmIds` for optional opt-in intra-band tie-breaking (`focusBoost: true`, default OFF).

#### Scenario: Cross-organization isolation holds under open policy
- **WHEN** two organizations both use `policy = 'open'` and an actor in Organization A attempts to read, search, reference, traverse supersede chains, or access drive files in Organization B
- **THEN** all access checks return `'none'` / `ACCESS_DENIED` / `NOT_FOUND` and Organization B entries never enter Organization A's results or `totalMatched` / `omittedCount`

### Requirement: Unambiguous Separation of Session Binding, Positional Target, Focus Narrowing, and Removal of `--realm`
CLI and MCP SHALL strictly separate permission binding, target selection, and optional read focus:
- **Session Binding (`MERU_MIND_ORG_ID`, `MERU_MIND_VIEWER_REALM_ID`)**:
  - In `open` organizations: a single organization auto-resolves without `--org`; missing `MERU_MIND_VIEWER_REALM_ID` defaults viewer to `/`.
  - In `tree` organizations: ALL normal read/write CLI commands (`tree`, `ls`, `brief`, `cat`, `recall`, `replay`, `changes`, `write`, `drive`, `settle`, `object`, `tag`, `thing`, `realm list`, `import-md`, `import-jsonl`, `import-verify`, `export-slice`) AND MCP server startup SHALL STRICTLY REQUIRE `MERU_MIND_VIEWER_REALM_ID` (missing -> `INVALID_INPUT`; NEVER default to `/`).
  - Explicit human org-admin CLI commands (`--as-human` required): `org set-policy`, `realm create` (explicit `--org` + `--parent`), `mount` / `unmount` (explicit `--viewer` + `--target`), and `redact --id <entryId> --as-human` are permitted without `MERU_MIND_VIEWER_REALM_ID` because they carry explicit admin targets, require `--as-human`, and record `actor.id` and `op` in `change_log`.
- **Positional `<target>`**:
  - Read commands accept positional targets (`tree [target]`, `ls [target]`, `brief [target]`, `cat <id|drive-path>`, `replay <id>`, `changes [target]`, `recall [query]`).
  - Write commands (`write <targetRealm>`, `drive write <targetRealm>`, `settle <targetRealm>`) REQUIRE an explicit positional `<targetRealm>` with no silent root fallback.
- **Focus (`--focus <realmPath|realmId>` / MCP `focus`) — Distinct Mode Semantics**:
  - In `tree` mode: `focus` acts strictly as a read sub-scope narrowing filter (`scope(focus) ∩ scope(bound)`), never widening past bound scope and rejecting out-of-scope focus with opaque `NOT_FOUND`/`ACCESS_DENIED`.
  - In `open` mode: `focus` sets the optional `brief` center or optional intra-band ranking hint (ranking boost remains OFF by default unless `--focus-boost` / `focusBoost: true` is passed; never alters org-wide visibility).
  - Write commands and MCP write tools SHALL NEVER accept `--focus` / `focus` or per-call viewer overrides; MCP write tools always bind engine writes to `boundViewerRealmId`.
- **Complete Removal of `--realm`**:
  - Passing `--realm` to ANY CLI command SHALL exit non-zero with `INVALID_INPUT` and migration guidance pointing to positional `<target>`, `--focus`, or `MERU_MIND_VIEWER_REALM_ID`.

#### Scenario: Passing removed --realm flag or omitting MERU_MIND_VIEWER_REALM_ID in tree mode fails with INVALID_INPUT
- **WHEN** a caller passes `--realm /ops` to any CLI command
- **THEN** the CLI exits non-zero with `INVALID_INPUT` explaining the migration to positional `<target>`, `--focus`, or `MERU_MIND_VIEWER_REALM_ID`
- **AND** running `meru-mind tree` or `meru-mind ls` against a `tree` organization without `MERU_MIND_VIEWER_REALM_ID` exits non-zero with `INVALID_INPUT`
- **AND** running `meru-mind org set-policy --org <id> --policy open --as-human` without `MERU_MIND_VIEWER_REALM_ID` succeeds and appends an `org_policy_change` record to `change_log`

### Requirement: Realm Topology Authorization and Scoped Realm Listing
In `tree` mode, `createRealm()`, `mountRealm()`, and `unmountRealm()` SHALL require `actor.kind === 'human'`. In `open` mode, same-organization writers MAY perform realm topology mutations and all mutations SHALL be recorded in `change_log`. `LedgerEngine.listRealms()` SHALL require a non-empty `orgId`, and in `tree` mode SHALL require `viewerRealmId` and return only visible realms sanitized via the P0-1 zero-leak sanitizer.

#### Scenario: Agent attempts to create or mount a realm in a tree organization
- **WHEN** an `agent` actor invokes `createRealm()`, `mountRealm()`, or `unmountRealm()` in a `tree` organization
- **THEN** the engine rejects the operation with `ACCESS_DENIED`

### Requirement: Process-Level MCP Identity, Unified `target` + `focus` Schemas, and Scope Intersection
`meru-mind-mcp` SHALL bind `MERU_MIND_ORG_ID`, `MERU_MIND_VIEWER_REALM_ID` (mandatory for `tree` organizations; optional default focus for `open` organizations), `MERU_MIND_ACTOR_ID`, and `MERU_MIND_ACTOR_FAMILY` at server startup.
- MCP SHALL hardcode `actor.kind = 'agent'` and omit `actorKind` from every tool input schema.
- MCP SHALL NOT expose `rule` writes, `redact`, `setOrgPolicy`, realm topology mutations (`createRealm`/`mountRealm`/`unmountRealm`), `mind_rebuild`, or `mind_export_slice`.
- All MCP tools SHALL use unified `target` (accepting realm path OR ID) and (on read tools only) `focus` (accepting realm path OR ID), evaluating effective read scope as `scope(focus) ∩ scope(boundViewer)` and binding all write calls to `boundViewerRealmId`.

#### Scenario: Narrowing MCP focus to a child realm cannot escalate via child mounts or seabed
- **WHEN** an MCP server is bound to parent realm `B2` in a `tree` organization and child realm `C2` mounts sibling `C1` (`scope: 'all'`) and has its own seabed entries
- **THEN** calling `mind_recall`, `mind_brief`, `mind_tree`, `mind_ls`, `mind_cat`, `mind_replay`, `mind_changes`, `mind_list_objects`, `mind_list_tags`, `mind_list_things`, `mind_drive_read`, `mind_get_supersede_chain`, or `mind_list_realms` with `focus = C2` (by path or ID) stays strictly within `scope(C2) ∩ scope(B2)`, blocking `C1`'s mounted items and blocking `C2`'s seabed unless `includeDescendantSeabed = true`

#### Scenario: MCP write tools accept target path or ID and always bind engine writes to boundViewerRealmId
- **WHEN** an MCP server bound to parent realm `B2` in a `tree` organization receives a write call (`mind_append_record`, `mind_write_conclusion`, `mind_capture_seabed`, `mind_write_raw`, `mind_drive_write`, or `mind_settle`) with `target = "/b2"` (or `B2.id`)
- **THEN** the MCP server passes `boundViewerRealmId` (`B2`) to the underlying engine so valid writes to `B2` succeed while references to `C2`'s private mounts (such as `C1`) are rejected with `NOT_FOUND`

### Requirement: Default-Safe CLI Privilege Model
`meru-mind` CLI SHALL default `--actor-kind` to `'agent'` and reject `--actor-kind human` unless `--as-human` is explicitly passed. Human-only operations (`rule` records, `redact`, `org set-policy`, and `tree`-mode realm mutations) SHALL require `--as-human`.

#### Scenario: Default CLI invocation attempts a human-only operation
- **WHEN** `meru-mind` runs `write <target> --class rule`, `redact`, or `org set-policy` without `--as-human`
- **THEN** the CLI exits non-zero with `RULE_REQUIRES_HUMAN` or `ACCESS_DENIED`

### Requirement: Sensitivity Read-Path and Export Enforcement
- `secret` entries SHALL be excluded from FTS5, `vec_pending`, `vec_items`, `listRecords`, `listSeabedEntries`, `thingId` timelines, Stage 2 structured filters, `brief`, `tree`, `ls`, `settle` (`sourceIds`), `exportSlice`, and `change_log` summaries; they SHALL only be readable by exact ID lookup within visible scope.
- `confidential` entries SHALL participate in in-organization recall and `brief`, but SHALL be strictly excluded (along with distillations citing them) from `exportSlice()`.

#### Scenario: Secret entry is hidden from all list paths yet readable by exact ID
- **WHEN** a `secret` record or seabed entry exists in a visible realm
- **THEN** FTS/vector recall, Stage 2 filter, `thingId` timeline, `brief`, `tree`, `ls`, `exportSlice`, and `listChangeLog` omit it completely
- **AND** `recall({ id })` within visible scope returns the exact entry

#### Scenario: Confidential entry is excluded from sandbox slice exports
- **WHEN** `exportSlice()` runs on a realm containing `confidential` records, seabed entries, and a cognitive card citing them
- **THEN** no file in the exported slice directory contains any `confidential` content or ID

### Requirement: Unified Field-Level Reference and Path Sanitization
`LedgerEngine` (`listRealms()`, `getSupersedeChain()`, `listThings()`, `findThingByExternalRef()`), `ObjectEngine` (`getObject()`, `listObjects()`), and `SeaEngine` (`tree()`, `brief()`, `recall()`, `ls()`, `cat()`, `replay()`, `changes()`) SHALL share a single visibility sanitizer (`createVisibilityHelpers`) that strips invisible or `secret` references (`refs`, `sourceRefs`, `supersedesId`, `supersedesIds`, `supersededById`, `sourceIds`, `seabed.sourceRef`), rewrites hidden-ancestor realm paths to `@mounted/<alias>` with `parentId = null`, and sets `parentObjectId = null` when an object's parent lies outside `scope.readableLedgerIds`.

#### Scenario: Ledger-mounted viewer traverses a supersede chain referencing hidden descendant seabed
- **WHEN** realm `B` has a record citing descendant `C`'s seabed, and realm `X` mounts only `B`'s `ledger`
- **THEN** calling `getSupersedeChain()` or `recall({ id })` from `X` returns `B`'s record with `C`'s seabed ID removed from `refs` and `sourceRefs`

### Requirement: Local Cooperative Trust Model Boundary
In local single-host CLI/SQLite mode, `--as-human`, TTY prompts, and `confirmedByHuman` SHALL be treated strictly as cooperative workflow markers to prevent accidental agent noise or misuse, NOT as cryptographic security boundaries against an agent possessing local shell or filesystem access. Hard enforcement of human identity and isolation against untrusted local agents requires process-separated server custody or an authoritative host harness.

#### Scenario: Cooperative marker is not relied upon as a security boundary
- **WHEN** an embedded orchestrator or multi-party verification workflow requires authoritative human verification
- **THEN** the caller supplies authenticated `Actor` identity from its own trusted control plane rather than relying on local CLI `--as-human` flags or unauthenticated `confirmedByHuman` markers
