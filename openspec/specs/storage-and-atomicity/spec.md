# Storage and Atomicity Specification

## Purpose

Define durable SQLite schema migration, nullable declared timestamps versus audit timestamps, atomic single- and multi-predecessor CAS supersede DAGs, orphan superseded ingestion, organization-scoped idempotency, operational change logging, and off-write-path vector indexing for Meru Mind.

## Requirements

### Requirement: Connection-Level Secure Delete and Concurrent Schema Migration
`SqliteDb` SHALL enable `PRAGMA secure_delete = ON`, `PRAGMA foreign_keys = ON`, and `PRAGMA journal_mode = WAL` on every connection, and execute all versioned schema migrations inside a single `BEGIN IMMEDIATE` transaction recorded in `schema_migrations`.

#### Scenario: Upgrading a V0.1 database preserves tree isolation and backfills metadata
- **WHEN** `SqliteDb` opens an existing V0.1 database containing organizations, records, seabed entries, and distillations
- **THEN** migration v2 backfills `orgs.policy = 'tree'` on all existing organizations (never silently opening legacy walls)
- **AND** backfills `org_id` and `occurred_at` on existing `records` and `seabed_entries`, and `confirmed_by_human = 1` on existing human-authored records
- **AND** rebuilds `vec_pending` and re-enqueues every non-secret, non-redacted entry missing from `vec_items`

#### Scenario: Multiple OS processes open an unmigrated database simultaneously
- **WHEN** multiple processes invoke `new SqliteDb(...)` against the same V0.1 file concurrently
- **THEN** all processes complete initialization cleanly with zero `duplicate column` or lock-race failures and record migrations `[1, 2, 3, 4]`

#### Scenario: Migration v3 creates object/tag tables and record reference columns without a separate things table
- **WHEN** `SqliteDb` runs migration v3 inside `BEGIN IMMEDIATE`
- **THEN** it creates `objects`, `entry_objects`, and `resource_tags` with their organization-scoped indexes
- **AND** adds `external_ref` (indexed by `(org_id, external_ref)`) and `source_ref` (indexed by `(org_id, source_ref, status)`) to `records` without creating a separate `things` table
- **AND** safely backfills `source_ref` and `external_ref` on pre-existing rows from `payload_json` (or `source_refs_json[0]` when present)

#### Scenario: Migration v4 adds multi-predecessor supersedes column and nullable occurred_at expression indexes
- **WHEN** `SqliteDb` runs migration v4 inside `BEGIN IMMEDIATE`
- **THEN** it adds nullable column `records.supersedes_ids_json TEXT` (`NULL` when zero predecessors, JSON `string[]` when one or more predecessors, with `supersedes_id` retaining `supersedesIds[0] ?? null`)
- **AND** creates expression indexes `idx_records_realm_occ_nulls` on `records(realm_id, (occurred_at IS NULL), occurred_at DESC, created_at DESC, id DESC)` and `idx_seabed_realm_occ_nulls` on `seabed_entries(realm_id, (occurred_at IS NULL), occurred_at DESC, created_at DESC, id DESC)`
- **AND** records version `4` in `schema_migrations` without rolling back migration v2's one-time legacy `occurred_at` backfill on pre-v2 databases (benchmark databases must be freshly re-imported from source)

### Requirement: Nullable `occurred_at` Semantics Versus `created_at` Audit Semantics
`records.occurred_at` and `seabed_entries.occurred_at` SHALL be nullable (`string | null`) representing the declared time an event or document occurred, whereas `created_at` SHALL govern strictly audit ordering and `change_log`.
- `LedgerEngine.appendRecord()` and `LedgerEngine.captureSeabed()` SHALL accept `occurredAt?: string | null` and preserve explicit `occurredAt: null` without coalescing `null` to `created_at` or `now()`. When `occurredAt` is `undefined` on a real-time interactive write, it defaults to `now()`.
- `SqliteDb` row mappers SHALL return `occurredAt: row.occurred_at == null ? null : String(row.occurred_at)` and NEVER coalesce `null` to `row.created_at`.
- Recall, list, brief, and replay recency ordering SHALL sort dated entries before undated entries via `ORDER BY (occurred_at IS NULL) ASC, occurred_at DESC, created_at DESC, id DESC`.
- Time-range filters (`since`/`until`) SHALL filter strictly on `occurred_at IS NOT NULL AND occurred_at >= ? / <= ?`.
- MCP Zod schemas for `occurredAt` SHALL accept `z.string().nullable().optional()`, and CLI `--occurred-at none` or `--occurred-at null` SHALL pass `occurredAt: null`.

#### Scenario: Undated records are excluded from time-range filters and sort behind dated records
- **WHEN** a record is written with explicit `occurredAt: null` alongside dated records
- **THEN** `occurredAt` is persisted and read back as `null`
- **AND** queries with `since` or `until` exclude the undated record
- **AND** recency listings place dated records strictly before undated records

### Requirement: Newly Created Organizations Default to Open Policy
`LedgerEngine.createOrg()` SHALL default `policy` to `'open'` for newly created organizations while accepting explicit `policy: 'tree'`. Changing an existing organization's policy via `setOrgPolicy()` SHALL require `actor.kind === 'human'` and append an `org_policy_change` entry to `change_log` (using `'__org__'` if no root realm exists).

#### Scenario: Non-human attempts to change organization policy
- **WHEN** an `agent` or `system` actor invokes `setOrgPolicy()`
- **THEN** the engine rejects the call with `ACCESS_DENIED` and leaves `orgs.policy` unchanged

### Requirement: Single-Transaction Write Validation, Multi-Predecessor Atomic CAS Supersede DAG, and Orphan Superseded Ingestion
`LedgerEngine.appendRecord()` and `LedgerEngine.captureSeabed()` SHALL execute idempotency lookup, visibility/access checks, reference validation, supersede CAS, row insertion, synchronous FTS5 update, `vec_pending` enqueue, and `change_log` append within a single `BEGIN IMMEDIATE` transaction.
- `appendRecord()` SHALL accept `supersedesIds?: string[]` (merged and deduplicated with backward-compatible `supersedesId?: string`), storing `supersedes_id = list[0] ?? null` and `supersedes_ids_json = list.length > 0 ? JSON.stringify(list) : null`.
- All predecessors in `supersedesIds` SHALL be validated against visibility, policy, and kind rules and transitioned atomically via CAS (`WHERE id = ? AND org_id = ? AND status = 'active' AND superseded_by_id IS NULL` requiring `changes === 1` for every predecessor). If ANY predecessor fails validation or CAS, the ENTIRE transaction SHALL roll back with zero partial updates.
- `LedgerEngine.getSupersedeChain()` SHALL traverse the supersede DAG via visited-bounded BFS (backward across `supersedes_ids_json`/`supersedes_id`, forward across `superseded_by_id`), filtered and sanitized through `createVisibilityHelpers`, returning chronologically ordered `nodes`, `currentHeadId` (`null` if redacted, invisible, orphan, or multiple active heads), and `orphanSuperseded: boolean`.
- `appendRecord()` MAY accept `initialStatus?: 'active' | 'superseded'`. Passing `'retracted'` or any unknown status SHALL be rejected with `INVALID_INPUT` (`'retracted'` is reserved exclusively for `LedgerEngine.redact()`). Orphan superseded records (`initialStatus: 'superseded'`) MUST execute through the canonical `appendRecord()` transaction with `superseded_by_id = NULL`, cannot be superseded via CAS (`CONFLICT`), and report `currentHeadId: null` with `orphanSuperseded: true`.

#### Scenario: Concurrent processes supersede the same active chain head
- **WHEN** multiple OS processes concurrently call `appendRecord()` with `supersedesId` pointing to the same active record
- **THEN** `markRecordSuperseded()` enforces `WHERE id = ? AND org_id = ? AND status = 'active' AND superseded_by_id IS NULL` with `changes === 1`
- **AND** strictly one writer succeeds while all contenders roll back with `CONFLICT` and leave zero forked or dirty rows

#### Scenario: Multi-predecessor supersede is all-or-nothing atomic across the DAG
- **WHEN** `appendRecord()` is invoked with `supersedesIds: [a, b]` where `a` is active and `b` is already superseded
- **THEN** the entire transaction rolls back with `CONFLICT`, leaving `a` active with `supersededById = null`
- **AND** when both `a` and `b` are active same-kind records, both transition to `'superseded'` pointing to the new record and `getSupersedeChain()` returns all three DAG nodes in chronological order

#### Scenario: Policy-scoped cross-realm supersede
- **WHEN** a writer in an `open` organization appends a record superseding an active same-kind record in another realm of the same organization
- **THEN** `appendRecord()` atomically supersedes the old record via CAS so only the new record remains `'active'`
- **AND** when an organization uses `policy = 'tree'`, cross-realm `supersedesId`/`supersedesIds` is rejected with opaque `NOT_FOUND` (and cross-organization supersede is always rejected in both modes)

#### Scenario: Orphan superseded ingestion uses canonical write path and rejects retracted status
- **WHEN** `appendRecord()` is called with `initialStatus: 'superseded'`
- **THEN** the record is persisted with `status = 'superseded'`, `supersededById = null`, FTS5/vec/change_log synced, cannot be superseded again (`CONFLICT`), and `getSupersedeChain()` returns `currentHeadId: null, orphanSuperseded: true`
- **AND** calling `appendRecord()` with `initialStatus: 'retracted'` is rejected with `INVALID_INPUT`

#### Scenario: Superseding a retracted record is rejected
- **WHEN** an actor attempts to supersede a record whose status is `'retracted'`
- **THEN** `appendRecord()` rolls back with `CONFLICT`

### Requirement: Organization-Scoped Cross-Table Idempotency Keys
`idempotency_keys` SHALL enforce `PRIMARY KEY (org_id, key)` across both `records` and `seabed_entries` using canonical key-sorted JSON SHA-256 payload hashes.

#### Scenario: Identical payload with reordered JSON keys returns original entry
- **WHEN** a write repeats an existing `idempotencyKey` with semantically identical payload fields in a different key order
- **THEN** the engine returns the existing record or seabed entry without inserting duplicates or appending another `change_log` entry

#### Scenario: Same key with different payload or cross-table reuse fails
- **WHEN** a write reuses an existing `idempotencyKey` with a different payload hash or across `records` and `seabed_entries`
- **THEN** the engine rolls back with `IDEMPOTENCY_MISMATCH`

#### Scenario: Hidden sibling key collision returns opaque NOT_FOUND
- **WHEN** a caller in `tree` mode submits an `idempotencyKey` owned by an invisible sibling realm
- **THEN** the engine returns opaque `NOT_FOUND` without disclosing the existing entry or payload

### Requirement: Durable Change Log and Generation Semantics
`change_log` SHALL act as an append-only operational event log whose `seq` is monotonic across committed transactions and rolled back on failed transactions. `SeaEngine.rebuild()` SHALL preserve `change_log` and `meta.change_log_generation`; only `resetChangeLog()` SHALL clear entries and increment `change_log_generation`.

#### Scenario: Rebuild preserves change log and generation
- **WHEN** `SeaEngine.rebuild()` reconstructs derived FTS5, vector, and drive state
- **THEN** all existing `change_log` rows remain intact and `change_log_generation` is unchanged

### Requirement: Off-Write-Path Batch Embedding Sync
Write paths (`appendRecord`, `captureSeabed`, `settle`) SHALL NEVER call `embedder.embed()` or `embedder.embedBatch()`. They SHALL enqueue non-secret entries in `vec_pending`, and `SeaEngine.syncEmbeddings()` SHALL embed batches asynchronously and re-verify inside a transaction before writeback that (1) the `vec_pending` row still exists with matching `queuedAt` and `text`, (2) the canonical row still exists and is neither redacted, retracted, nor `secret`, and (3) the live canonical `status` is written to `vec_items`.

#### Scenario: Entry is redacted or superseded while embedBatch is in flight
- **WHEN** a record or seabed entry is redacted during an in-flight `embedBatch()` call
- **THEN** `syncEmbeddings()` skips writing the stale vector to `vec_items` and removes the `vec_pending` row
- **AND** if a record is superseded mid-flight, `syncEmbeddings()` writes the live `'superseded'` status into `vec_items`
