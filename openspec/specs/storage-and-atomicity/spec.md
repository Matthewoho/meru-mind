# Storage and Atomicity Specification

## Purpose

Define durable SQLite schema migrations (v1–v8), SQLite version and `busy_timeout` guards, `fts_docs` side-table and partial covering indexes, causal object lifecycle columns and `object_aliases`, realm `scope` and archive freeze metadata, atomic `entry move` across realms, nullable `occurred_at` vs `created_at` semantics, atomic single- and multi-predecessor CAS supersede DAGs, orphan superseded ingestion, organization-scoped and auto-generated idempotency keys, operational change logging, and off-write-path vector indexing.

## Requirements

### Requirement: Connection-Level Secure Delete and Concurrent Migrations v1–v8
`SqliteDb` SHALL require SQLite `>= 3.43.0`, set shared `DEFAULT_BUSY_TIMEOUT_MS = 30000`, enable `secure_delete = ON`, `foreign_keys = ON`, and `WAL`, and run migrations `[1..8]` in one `BEGIN IMMEDIATE` transaction. Migration v6 SHALL create zero-plaintext `fts_docs`, contentless_delete `fts_index`, and partial covering indexes. Migration v7 SHALL add `objects.(state, state_label, state_since, state_evidence_id)`, `idx_objects_inactive`, and `object_aliases` with keyset `is_name = 1` backfill. Migration v8 SHALL add nullable `realms.scope TEXT` without mutating existing rows.

#### Scenario: Upgrading a V0.1, v5, v6, or v7 database preserves isolation and records migrations 1 through 8
- **WHEN** `SqliteDb` opens an existing V0.1, v5, v6, or v7 database containing records, seabed entries, objects, secrets, and redacted rows
- **THEN** migrations `[1, 2, 3, 4, 5, 6, 7, 8]` complete cleanly with `fts_docs` populated via keyset batches, `object_aliases` backfilled with `is_name = 1` (skipping empty normalized names), `realms.scope` added as nullable TEXT, and `PRAGMA busy_timeout = 30000` before and after `redact()`

#### Scenario: Multiple OS processes open an unmigrated database simultaneously
- **WHEN** multiple OS processes invoke `new SqliteDb(...)` against the same V0.1, v2, v5, v6, or v7 file concurrently
- **THEN** all processes complete initialization with zero `duplicate column` or lock-race failures and record `[1, 2, 3, 4, 5, 6, 7, 8]`

#### Scenario: Migration v5, v6, and v7 preserve pre-v5 redacted_blocklist rows
- **WHEN** a v4 database containing a pre-v5 `redacted_blocklist` row is reopened on v7
- **THEN** migrations v5 through v7 preserve existing blocklist rows and `idx_redacted_blocklist_org_sha`
- **AND** subsequent writes matching the pre-v5 `content_sha256` are blocked immediately

#### Scenario: Rebuild streams canonical tables via keyset batches inside one transaction
- **WHEN** `SeaEngine.rebuild()` runs on a store with records, seabed entries, and distillations
- **THEN** it clears `fts_index` (`'delete-all'`) and `fts_docs`, streams keyset batches (`LIMIT 500`), verifies `sourceIds` via ID-only queries, and commits atomically

### Requirement: Nullable `occurred_at` Semantics Versus `created_at` Audit Semantics
`records.occurred_at` and `seabed_entries.occurred_at` SHALL be nullable (`string | null`) representing declared event time, while `created_at` governs audit ordering and `change_log`. `appendRecord()` and `captureSeabed()` SHALL preserve explicit `null` without coalescing to `now()`, and `SqliteDb` row mappers SHALL never coalesce `NULL` to `created_at`.

#### Scenario: Undated records are excluded from time-range filters and sort behind dated records
- **WHEN** a record is written with explicit `occurredAt: null` (CLI `--occurred-at none` or MCP `occurred_at: null`) alongside dated records
- **THEN** `occurredAt` persists as `null`, time-range filters (`since`/`until`) exclude it, and recency lists place dated records before undated ones

### Requirement: Recency Ordering and Time-Range Filtering
Recall, `ls`, `show`, and `replay` recency ordering SHALL sort dated entries before undated entries via `ORDER BY (occurred_at IS NULL) ASC, occurred_at DESC, created_at DESC, id DESC`. Time-range filters (`since`, `until`) SHALL filter strictly on `occurred_at IS NOT NULL AND occurred_at >= ? / <= ?`.

#### Scenario: Time-range query excludes undated rows cleanly
- **WHEN** `search` or `ls` runs with `--since` or `--until`
- **THEN** only entries with non-null `occurred_at` inside the inclusive range are returned

### Requirement: Newly Created Organizations Default to Open Policy
`LedgerEngine.createOrg()` SHALL default `policy` to `'open'` while accepting explicit `policy: 'tree'`. Changing an organization's policy via `setOrgPolicy()` SHALL require `actor.kind === 'human'` and append an `org_policy_change` entry to `change_log` (using `'__org__'` when no root realm exists).

#### Scenario: Non-human attempts to change organization policy
- **WHEN** an `agent` or `system` actor invokes `setOrgPolicy()`
- **THEN** the engine rejects the call with `ACCESS_DENIED` and leaves `orgs.policy` unchanged

### Requirement: Single-Transaction Write Validation and Multi-Predecessor Atomic CAS
`LedgerEngine.appendRecord()` and `LedgerEngine.captureSeabed()` SHALL execute idempotency lookup, access checks, global content-hash blocklist checks, reference validation, supersede CAS, row insertion, FTS5 sync, `vec_pending` enqueue, and `change_log` append in one `BEGIN IMMEDIATE` transaction. All `supersedesIds` predecessors SHALL transition atomically via CAS (`changes === 1` with `org_id` guard) or roll back entirely with `CONFLICT`.

#### Scenario: Concurrent processes supersede the same active chain head
- **WHEN** multiple OS processes concurrently call `appendRecord()` or CLI `write --supersedes` on the same active record
- **THEN** strictly one writer succeeds while all contenders roll back with `CONFLICT` (wire `conflict`) and leave zero forks

#### Scenario: Multi-predecessor supersede is all-or-nothing atomic across the DAG
- **WHEN** `appendRecord()` is invoked with `supersedesIds: [a, b]` where `b` is already superseded
- **THEN** the entire transaction rolls back with `CONFLICT`, leaving `a` active with `supersededById = null`

#### Scenario: Policy-scoped cross-realm supersede
- **WHEN** a writer in an `open` org supersedes an active same-kind record in another realm of the same org
- **THEN** `appendRecord()` supersedes it atomically, whereas in a `tree` org cross-realm supersede returns opaque `NOT_FOUND`

### Requirement: Supersede DAG Traversal and Orphan Superseded Ingestion
`LedgerEngine.getSupersedeChain()` SHALL traverse the supersede DAG via visited-bounded BFS, sanitized via `createVisibilityHelpers`, returning chronologically ordered `nodes`, `currentHeadId`, and `orphanSuperseded`. `appendRecord()` MAY accept `initialStatus: 'active' | 'superseded'` (rejecting `'retracted'` with `INVALID_INPUT`); orphan superseded rows have `supersededById = null` and cannot be superseded (`CONFLICT`).

#### Scenario: Orphan superseded ingestion uses canonical write path and rejects retracted status
- **WHEN** `appendRecord()` runs with `initialStatus: 'superseded'`
- **THEN** the record persists as `'superseded'` with `supersededById = null` and `orphanSuperseded: true`
- **AND** passing `initialStatus: 'retracted'` or superseding a `'retracted'` record fails with `INVALID_INPUT` / `CONFLICT`

### Requirement: Organization-Scoped Cross-Table Idempotency Keys
`idempotency_keys` SHALL enforce `PRIMARY KEY (org_id, key)` across `records` and `seabed_entries` using canonical key-sorted JSON SHA-256 payload hashes. Explicit `--idempotency-key` reuse with a different payload or table SHALL fail with `IDEMPOTENCY_MISMATCH` (wire `idempotency_mismatch`), and hidden-sibling collisions SHALL return opaque `NOT_FOUND`.

#### Scenario: Identical payload returns original entry while mismatched payload fails
- **WHEN** a write repeats an explicit `idempotencyKey` with semantically identical payload fields
- **THEN** the existing entry is returned without duplicating rows
- **AND** reusing the same key with a different payload rolls back with `IDEMPOTENCY_MISMATCH`

### Requirement: Everyday Auto-Idempotency and Minute-Bucket Boundary Semantics
Without an explicit `--idempotency-key`, CLI `write` and MCP `mind_write` SHALL hash all canonical write fields plus `occurred_at` (or a 1-minute UTC bucket `YYYY-MM-DDTHH:MM` when omitted). Active hits return the existing record; `superseded` hits derive `:after:<headOrId>` for rollbacks; `retracted` hits fail immediately with `ACCESS_DENIED` (`forbidden`). Retries straddling a minute boundary create a second entry unless `occurred_at` or `--idempotency-key` is supplied.

#### Scenario: Auto-idempotency deduplicates same-minute retries, handles rollback, and blocks retracted retries
- **WHEN** `mind_write` retries identical fields within the same UTC minute
- **THEN** the existing active record ID is returned with zero duplicates, while changing `sensitivity` creates a distinct record with zero `idempotency_mismatch`
- **AND** rolling back `A -> B -> A` creates a new active record `A2`, whereas retrying a redacted record fails immediately with `forbidden`

### Requirement: Durable Change Log and Off-Write-Path Batch Embedding Sync
`change_log` SHALL preserve monotonic `seq` across commits and survive `SeaEngine.rebuild()` unchanged; only `resetChangeLog()` clears entries and bumps `change_log_generation`. Write paths SHALL never invoke `embedder.embed()`; `SeaEngine.syncEmbeddings()` SHALL embed queued `vec_pending` batches and re-verify inside a transaction that the pending row and live canonical non-secret, non-redacted row still match before updating `vec_items`.

#### Scenario: Rebuild preserves change log and syncEmbeddings skips mid-flight redactions
- **WHEN** `SeaEngine.rebuild()` runs or an entry is redacted while `embedBatch()` is in flight
- **THEN** `change_log` rows and `change_log_generation` remain intact
- **AND** `syncEmbeddings()` skips writing stale vectors for redacted entries and writes live `'superseded'` status for superseded entries
