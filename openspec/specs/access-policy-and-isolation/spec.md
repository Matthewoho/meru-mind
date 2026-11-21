# Access Policy and Isolation Specification

## Purpose

Define organization-level visibility modes (`open` and `tree`), process-level MCP identity and scope binding, default-safe CLI privilege elevation, sensitivity enforcement, and cross-reference leak sanitization.

## Requirements

### Requirement: Organization Visibility Policies (`open` and `tree`)
`computeVisibleScope()` SHALL remain exported as a pure tree-visibility function. `resolveAccessScope()`, `resolveAccess()`, `assertAccess()`, and all engine read/write/drive/export entrypoints SHALL enforce the organization's `policy`:
- Cross-organization access SHALL always resolve to `'none'` in both `open` and `tree` modes.
- In `tree` mode, visibility follows strict self/ancestor/descendant/explicit-`@mount` rules; descendant raw seabed requires explicit `includeDescendantSeabed`.
- In `open` mode, `readableLedgerIds`, `readableDriveIds`, and `readableSeabedIds` include all realms within the same organization, while `computeVisibleScope()` provides `focusRealmIds` for recall ranking boost.

#### Scenario: Cross-organization isolation holds under open policy
- **WHEN** two organizations both use `policy = 'open'` and an actor in Organization A attempts to read, search, reference, traverse supersede chains, or access drive files in Organization B
- **THEN** all access checks return `'none'` / `ACCESS_DENIED` / `NOT_FOUND` and Organization B entries never enter Organization A's results or `totalMatched` / `omittedCount`

### Requirement: Realm Topology Authorization and Scoped Realm Listing
In `tree` mode, `createRealm()`, `mountRealm()`, and `unmountRealm()` SHALL require `actor.kind === 'human'`. In `open` mode, same-organization writers MAY perform realm topology mutations and all mutations SHALL be recorded in `change_log`. `LedgerEngine.listRealms()` SHALL require a non-empty `orgId`, and in `tree` mode SHALL require `viewerRealmId` and return only realms and mounts within visible scope.

#### Scenario: Agent attempts to create or mount a realm in a tree organization
- **WHEN** an `agent` actor invokes `createRealm()`, `mountRealm()`, or `unmountRealm()` in a `tree` organization
- **THEN** the engine rejects the operation with `ACCESS_DENIED`

### Requirement: Process-Level MCP Identity and Scope Intersection
`meru-mind-mcp` SHALL bind `MERU_MIND_ORG_ID`, `MERU_MIND_VIEWER_REALM_ID` (mandatory for `tree` organizations; optional default focus for `open` organizations), `MERU_MIND_ACTOR_ID`, and `MERU_MIND_ACTOR_FAMILY` at server startup.
- MCP SHALL hardcode `actor.kind = 'agent'` and omit `actorKind` from every tool input schema.
- MCP SHALL NOT expose `rule` writes, `redact`, `setOrgPolicy`, realm topology mutations (`createRealm`/`mountRealm`/`unmountRealm`), `mind_rebuild`, or `mind_export_slice`.
- Every MCP read call SHALL evaluate effective scope as `scope(requestedViewer) ∩ scope(boundViewer)`.
- Every MCP write call SHALL enforce write permission against the bound viewer and pass `boundViewerRealmId` to the underlying engine.

#### Scenario: Narrowing MCP viewer to a child realm cannot escalate via child mounts or seabed
- **WHEN** an MCP server is bound to parent realm `B2` in a `tree` organization and child realm `C2` mounts sibling `C1` (`scope: 'all'`) and has its own seabed entries
- **THEN** calling `mind_recall`, `mind_brief`, `mind_drive_read`, `mind_get_supersede_chain`, or `mind_list_realms` with `viewerRealmId = C2` returns `C2`'s ledger items while strictly blocking `C1`'s mounted items and blocking `C2`'s seabed unless `includeDescendantSeabed = true`

### Requirement: Default-Safe CLI Privilege Model
`meru-mind` CLI SHALL default `--actor-kind` to `'agent'` and reject `--actor-kind human` unless `--as-human` is explicitly passed. Human-only operations (`rule` records, `redact`, `org set-policy`, and `tree`-mode realm mutations) SHALL require `--as-human`.

#### Scenario: Default CLI invocation attempts a human-only operation
- **WHEN** `meru-mind` runs `record --kind rule`, `redact`, or `org set-policy` without `--as-human`
- **THEN** the CLI exits non-zero with `RULE_REQUIRES_HUMAN` or `ACCESS_DENIED`

### Requirement: Sensitivity Read-Path and Export Enforcement
- `secret` entries SHALL be excluded from FTS5, `vec_pending`, `vec_items`, `listRecords`, `listSeabedEntries`, `thingId` timelines, Stage 2 structured filters, `brief`, `settle` (`sourceIds`), `exportSlice`, and `change_log` summaries; they SHALL only be readable by exact ID lookup within visible scope.
- `confidential` entries SHALL participate in in-organization recall and `brief`, but SHALL be strictly excluded (along with distillations citing them) from `exportSlice()`.

#### Scenario: Secret entry is hidden from all list paths yet readable by exact ID
- **WHEN** a `secret` record or seabed entry exists in a visible realm
- **THEN** FTS/vector recall, Stage 2 filter, `thingId` timeline, `brief`, `exportSlice`, and `listChangeLog` omit it completely
- **AND** `recall({ id })` within visible scope returns the exact entry

#### Scenario: Confidential entry is excluded from sandbox slice exports
- **WHEN** `exportSlice()` runs on a realm containing `confidential` records, seabed entries, and a cognitive card citing them
- **THEN** no file in the exported slice directory contains any `confidential` content or ID

### Requirement: Unified Field-Level Reference Sanitization
`LedgerEngine.getSupersedeChain()`, `SeaEngine.brief()`, and `SeaEngine.recall()` SHALL share a single visibility sanitizer (`createVisibilityHelpers`) that strips any invisible or `secret` reference from `record.refs`, `RecallItem.sourceRefs`, `record.supersedesId`, `record.supersededById`, `distillation.sourceIds`, and `seabed.sourceRef` (including `drive://<realmId>/...`).

#### Scenario: Ledger-mounted viewer traverses a supersede chain referencing hidden descendant seabed
- **WHEN** realm `B` has a record citing descendant `C`'s seabed, and realm `X` mounts only `B`'s `ledger`
- **THEN** calling `getSupersedeChain()` or `recall({ id })` from `X` returns `B`'s record with `C`'s seabed ID removed from `refs` and `sourceRefs`

### Requirement: Local Cooperative Trust Model Boundary
In local single-host CLI/SQLite mode, `--as-human`, TTY prompts, and `confirmedByHuman` SHALL be treated strictly as cooperative workflow markers to prevent accidental agent noise or misuse, NOT as cryptographic security boundaries against an agent possessing local shell or filesystem access. Hard enforcement of human identity and isolation against untrusted local agents requires process-separated server custody or an authoritative host harness.

#### Scenario: Cooperative marker is not relied upon as a security boundary
- **WHEN** an embedded orchestrator or multi-party verification workflow requires authoritative human verification
- **THEN** the caller supplies authenticated `Actor` identity from its own trusted control plane rather than relying on local CLI `--as-human` flags or unauthenticated `confirmedByHuman` markers
