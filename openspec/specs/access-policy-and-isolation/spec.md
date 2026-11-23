# Access Policy and Isolation Specification

## Purpose

Define organization visibility policies (`open` and `tree`), process-level binding (`MERU_MIND_ORG_ID`, `MERU_MIND_VIEWER_REALM_ID`), the strictly 7-tool MCP surface (`<= 6,000` wire chars), default-safe CLI privilege elevation, sensitivity enforcement, unified sanitization, and local cooperative trust boundaries.

## Requirements

### Requirement: Organization Visibility Policies (`open` and `tree`)
`computeVisibleScope()` SHALL remain exported as a pure tree-visibility function. `resolveAccessScope()`, `resolveAccess()`, and `assertAccess()` SHALL enforce organization `policy`: cross-organization access is always `'none'`; `tree` mode enforces strict self/ancestor/descendant/explicit-`@mount` visibility; `open` mode makes all same-org realms readable while preserving `focusRealmIds` for SDK-only opt-in `focusBoost`.

#### Scenario: Cross-organization isolation holds under open policy
- **WHEN** two `open` organizations exist and an actor in Org A attempts to read, search, reference, or write in Org B
- **THEN** all checks return `'none'` / `ACCESS_DENIED` / `NOT_FOUND` and Org B entries never enter Org A outputs or counts

### Requirement: Session Binding and `not_bound` Enforcement in Tree Organizations
In `open` orgs, a single org auto-resolves and missing `MERU_MIND_VIEWER_REALM_ID` defaults read visibility to `/` while everyday writes (`write`, `raw add`, `mind_write`) with omitted `--in`/`in` follow deterministic 4-tier routing (explicit `--in` -> explicit binding or hardened `.meru-mind-realm` marker -> unanimous non-root non-archived `--about` object owner -> lazy `/inbox`, never dumping implicitly into `/`). In `tree` orgs, everyday commands, non-admin management commands, and MCP startup SHALL require `MERU_MIND_VIEWER_REALM_ID` (`.meru-mind-realm` is ignored for `tree` auth), failing with `NOT_BOUND` (wire `not_bound`) and a non-root hint (never `=/`). Explicit `--as-human` org-admin commands (`org set-policy`, `realm create/set/archive/unarchive/mount/unmount`, `entry move`, `redact`) MAY run without viewer binding.

#### Scenario: Missing MERU_MIND_VIEWER_REALM_ID in tree org fails with not_bound and non-root hint
- **WHEN** `meru-mind whoami`, `meru-mind tree`, or `createMindMcpServer()` runs against a `tree` organization without `MERU_MIND_VIEWER_REALM_ID`
- **THEN** it fails with `NOT_BOUND` (wire `not_bound`) and suggests a non-root realm path (never `=/`)
- **AND** `meru-mind org set-policy --org <id> --policy open --as-human` succeeds without `MERU_MIND_VIEWER_REALM_ID`

### Requirement: Complete Removal of Legacy Commands and Flags with Self-Correcting Hints
CLI SHALL expose 7 everyday verbs (`whoami`, `tree`, `ls`, `show`, `search`, `changes`, `write`) and 11 management groups (`realm`, `entry`, `object`, `file`, `rule`, `raw`, `redact`, `settle`, `import`, `org`, `admin`) with zero aliases. Legacy commands (`recall`, `cat`, `brief`, `replay`, `record`, `capture`, `drive`, `mount`, `thing`, `tag`, `import-*`, `init`, `rebuild`, `status`, `inspect`, `log`, `add`) return `unknown_command` + `try:`; legacy flags return `unknown_flag`.

#### Scenario: Legacy commands and removed flags return self-correcting 4-field errors
- **WHEN** a caller invokes `meru-mind recall "x"`, `meru-mind status`, or `meru-mind ls / --realm /ops`
- **THEN** the CLI exits non-zero with `unknown_command` or `unknown_flag` and a runnable replacement command in `try:`

### Requirement: Realm Topology Authorization and Scoped Realm Listing
In both `open` and `tree` modes, `createRealm()`, `mountRealm()`, and `unmountRealm()` SHALL require `actor.kind === 'human'` and all mutations SHALL append to `change_log`. `LedgerEngine.listRealms()` SHALL require `orgId`, require `viewerRealmId` in `tree` mode, and return P0-1 sanitized realms only.

#### Scenario: Agent attempts to create or mount a realm in an open or tree organization
- **WHEN** an `agent` actor invokes `createRealm()`, `mountRealm()`, or `unmountRealm()` in either an `open` or `tree` organization
- **THEN** the engine rejects the operation with `ACCESS_DENIED`

### Requirement: Strictly 7-Tool Process-Bound MCP Server and Wire Schema Budget
`meru-mind-mcp` SHALL bind `MERU_MIND_ORG_ID`, `MERU_MIND_VIEWER_REALM_ID` (required in `tree`), and actor identity with hardcoded `actor.kind = 'agent'`. It SHALL expose strictly 7 tools (`mind_whoami`, `mind_tree`, `mind_ls`, `mind_show`, `mind_search`, `mind_changes`, `mind_write`) with `JSON.stringify(toolsList).length <= 6000` and descriptions `<= 220` chars (`[read]`/`[write]`), excluding `actorKind`, `rule`, `redact`, topology, and admin ops.

#### Scenario: MCP wire tools/list satisfies 7-tool count, 6000-char budget, and 220-char description cap
- **WHEN** a client calls `tools/list` on `dist/mcp.js` over stdio JSON-RPC
- **THEN** `tools.length === 7`, `JSON.stringify(result).length <= 6000`, every `description.length <= 220`, and zero tools expose `actorKind` or `rule` writes

### Requirement: MCP Scope Intersection and Bound Write Enforcement
Every MCP read tool SHALL evaluate visibility strictly within `scope(in/ref) ∩ scope(boundViewer)`, preventing child `@mount` and descendant seabed escalation. `mind_write` SHALL always pass `boundViewerRealmId` to the engine, accept optional `in` (auto-routing via bound/marker/about->`/inbox` when omitted), echo `realmPath` and `routedBy`, enforce `assertMcpWrite`, accept `occurred_at: string | null | undefined`, and return 4-field errors using the 11 snake_case wire codes.

#### Scenario: Narrowing MCP reads to a child realm cannot escalate via child mounts or seabed
- **WHEN** an MCP server bound to parent `B2` in a `tree` org calls `mind_search`, `mind_ls`, `mind_show`, or `mind_changes` targeting child `C2` (which mounts hidden `C1`)
- **THEN** `C1`'s items remain completely hidden and `C2`'s seabed is blocked unless `include_descendant_seabed: true`
- **AND** `mind_write` binds writes to `B2` and rejects `because` references pointing to `C1` with `not_found`

### Requirement: Default-Safe CLI Privilege Model and 11 Wire Error Codes
CLI SHALL default `--actor-kind` to `'agent'`, reject `--actor-kind human` without `--as-human`, and require `--as-human` for `rule add`, `redact`, `org set-policy`, and realm topology mutations (`realm create/set/archive/unarchive/mount/unmount`, `entry move`). CLI and MCP SHALL map errors via `src/format/errors.ts` to 11 codes (`unknown_command`, `unknown_flag`, `invalid_ref`, `not_found`, `ambiguous_ref`, `not_listable`, `not_bound`, `forbidden`, `conflict`, `idempotency_mismatch`, `invalid_input`) in 4 fields (`error`, `message`, `candidates?`, `try`).

#### Scenario: Default CLI invocation attempts a human-only operation
- **WHEN** `meru-mind` runs `rule add`, `redact`, or `org set-policy` without `--as-human`
- **THEN** the CLI exits non-zero with wire error `forbidden` and a runnable `try:` hint

### Requirement: Sensitivity Read-Path and Export Enforcement
Sensitivity SHALL use the kernel enum `public | internal | confidential | secret` (default `internal`). `secret` entries SHALL be excluded from FTS5, `vec_pending`, `vec_items`, `listRecords`, `listSeabedEntries`, `whoami`, `tree`, `ls`, `show` (realm/object), `search`, `changes`, `settle`, and `exportSlice`, remaining readable only by exact entry ID within visible scope. `confidential` entries SHALL be excluded from `exportSlice()`.

#### Scenario: Secret entry is hidden from all list paths yet readable by exact ID
- **WHEN** a `secret` entry exists in a visible realm
- **THEN** `whoami`, `tree`, `ls`, `search`, `changes`, and `exportSlice` omit it completely while exact ID lookup in visible scope returns it

### Requirement: Unified Field-Level Reference and Path Sanitization
All engine read methods SHALL share `createVisibilityHelpers` to strip invisible or `secret` references (`refs`, `sourceRefs`, `supersedesId`, `supersedesIds`, `supersededById`, `sourceIds`, `seabed.sourceRef`), rewrite hidden-ancestor realm paths to `@mounted/<alias>` with `parentId = null`, and set `parentObjectId = null` when an object's parent lies outside `scope.readableLedgerIds`.

#### Scenario: Ledger-mounted viewer traverses a supersede chain referencing hidden descendant seabed
- **WHEN** realm `B` has a record citing descendant `C`'s seabed, and realm `X` mounts only `B`'s `ledger`
- **THEN** `getSupersedeChain()` and `show` from `X` strip `C`'s seabed ID from `refs` and `sourceRefs`

### Requirement: Local Cooperative Trust Model and Content-Hash Blocklist Boundary
In local single-host CLI/SQLite mode, `--as-human`, `confirmedByHuman`, `whoami.store` (local-only metadata, never exposed in remote/HTTP mode), and the global `(org_id, content_sha256)` redaction blocklist SHALL be treated strictly as cooperative safeguards against accidental agent noise or exact-match re-ingestion, NOT as cryptographic security or DLP boundaries (a 1-character edit bypasses exact-hash matching). Hard isolation against untrusted agents requires process-separated server custody.

#### Scenario: Cooperative markers and exact-hash blocklist are documented as non-cryptographic safeguards
- **WHEN** an operator evaluates local CLI mode or exact-hash redaction blocking
- **THEN** exact duplicate re-writes are blocked automatically, while modified text is accepted and authoritative security boundaries remain in process-separated control planes
