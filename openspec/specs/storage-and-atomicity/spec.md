# Storage and Atomicity Specification

## Purpose

Define durable SQLite schema migration, atomic write-path invariants, organization-scoped idempotency, operational change logging, and off-write-path vector indexing for Meru Mind.

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
- **THEN** all processes complete initialization cleanly with zero `duplicate column` or lock-race failures and record migrations `[1, 2, 3]`

#### Scenario: Migration v3 creates object/tag tables and record reference columns without a separate things table
- **WHEN** `SqliteDb` runs migration v3 inside `BEGIN IMMEDIATE`
- **THEN** it creates `objects`, `entry_objects`, and `resource_tags` with their organization-scoped indexes
- **AND** adds `external_ref` (indexed by `(org_id, external_ref)`) and `source_ref` (indexed by `(org_id, source_ref, status)`) to `records` without creating a separate `things` table
- **AND** safely backfills `source_ref` and `external_ref` on pre-existing rows from `payload_json` (or `source_refs_json[0]` when present)

### Requirement: Newly Created Organizations Default to Open Policy
`LedgerEngine.createOrg()` SHALL default `policy` to `'open'` for newly created organizations while accepting explicit `policy: 'tree'`. Changing an existing organization's policy via `setOrgPolicy()` SHALL require `actor.kind === 'human'` and append an `org_policy_change` entry to `change_log` (using `'__org__'` if no root realm exists).

#### Scenario: Non-human attempts to change organization policy
- **WHEN** an `agent` or `system` actor invokes `setOrgPolicy()`
- **THEN** the engine rejects the call with `ACCESS_DENIED` and leaves `orgs.policy` unchanged

### Requirement: Single-Transaction Write Validation and Atomic CAS Supersede
`LedgerEngine.appendRecord()` and `LedgerEngine.captureSeabed()` SHALL execute idempotency lookup, visibility/access checks, reference validation, supersede CAS, row insertion, synchronous FTS5 update, `vec_pending` enqueue, and `change_log` append within a single `BEGIN IMMEDIATE` transaction.

#### Scenario: Concurrent processes supersede the same active chain head
- **WHEN** multiple OS processes concurrently call `appendRecord()` with `supersedesId` pointing to the same active record
- **THEN** `markRecordSuperseded()` enforces `WHERE id = ? AND org_id = ? AND status = 'active' AND superseded_by_id IS NULL` with `changes === 1`
- **AND** strictly one writer succeeds while all contenders roll back with `CONFLICT` and leave zero forked or dirty rows

#### Scenario: Policy-scoped cross-realm supersede
- **WHEN** a writer in an `open` organization appends a record superseding an active same-kind record in another realm of the same organization
- **THEN** `appendRecord()` atomically supersedes the old record via CAS so only the new record remains `'active'`
- **AND** when an organization uses `policy = 'tree'`, cross-realm `supersedesId` is rejected with opaque `NOT_FOUND` (and cross-organization `supersedesId` is always rejected in both modes)

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
