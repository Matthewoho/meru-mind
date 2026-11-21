# Importers Specification

## Purpose

Define the open-source-clean, domain-agnostic Markdown (`import-md`) and JSONL (`import-jsonl`) importers sharing a unified `ImportMappingConfig`, enforcing cooperative trust defaults, canonical write-path transactions, nullable undated timestamps without fabrication, `redacted_blocklist` enforcement, rollback-safe chain-head revisioning, multi-predecessor supersedes, and full-corpus consistency verification (`import-verify`).

## Requirements

### Requirement: Importer Trust Defaults and Canonical Write Path
`ImporterEngine.importMd()` and `ImporterEngine.importJsonl()` SHALL default to `actor.kind = 'agent'` (`confirmedByHuman = false`), elevating to `confirmedByHuman = true` ONLY when explicitly invoked with a human actor (such as CLI `--as-human`). Every imported item SHALL be persisted exclusively through `LedgerEngine.appendRecord()` or `LedgerEngine.captureSeabed()` transactions so idempotency keys, CAS supersedes, FTS5, `vec_pending`, `change_log`, and visibility invariants always apply.

#### Scenario: Default import marks records as agent-authored while --as-human sets confirmedByHuman
- **WHEN** `import-md` runs via CLI without `--as-human`
- **THEN** every created record has `authorKind = "agent"` and `confirmedByHuman = false`
- **AND** when run with `--as-human`, created records have `authorKind = "human"` and `confirmedByHuman = true`

### Requirement: Never Fabricate Timestamps for Undated Sources
When a Markdown file or JSONL row has no declared timestamp in frontmatter, header metadata, mapped fields, or explicit opt-in `filenameDatePattern`, importers SHALL pass `occurredAt: null` explicitly so SQLite stores `NULL` (NEVER filesystem `mtime` and NEVER import time `now()`). `ImportMdResult` and `ImportJsonlResult` SHALL report exact `undatedCount` and `defaultRealmCount`.

#### Scenario: Undated Markdown file and JSONL row persist null occurredAt without reading filesystem mtime
- **WHEN** a Markdown file without a declared timestamp has its filesystem `mtime` set to `2010-01-01` and is imported via `importMd()`
- **THEN** the persisted record has `occurredAt === null` (neither `2010-01-01` nor import time)
- **AND** `ImportMdResult.undatedCount` is `1`

### Requirement: Unified Domain-Agnostic Mapping Contract for Both Importers
`ImporterEngine.importMd()` and `ImporterEngine.importJsonl()` SHALL share a unified `ImportMappingConfig` (re-exporting `JsonlMappingConfig` as a backward-compatible type alias) with zero hardcoded private schemas or private status strings:
- `occurredAt` (dot-paths or frontmatter/header field names, plus optional explicit `filenameDatePattern` regex opt-in via mapping).
- `status` and `statusMap` mapping source lifecycle values strictly to `'active' | 'superseded'`; any mapping value targeting `'retracted'` or an unknown status SHALL throw `INVALID_INPUT`.
- `validUntil` (dot-path or frontmatter field for ISO expiry date; if `< now` at import time and not already mapped superseded, writes `initialStatus: 'superseded'` through `appendRecord()`).
- `supersedes` supporting both scalar `string` and `string[]` arrays, passing normalized `supersedesIds` through `LedgerEngine.appendRecord()` (degrading visible cross-realm predecessors in `tree` mode to `refs` plus `payload.crossRealmSupersedes` while still atomically superseding same-realm predecessors).
- `realmPath` / `realmMap` / `defaultRealm`, `objectRefs` / `objectMap`, `resourceTags`, `kind` / `kindMap`, `sensitivity`, `sourceRef`, `thingRef`, `externalRef`, and `extractFields`.

#### Scenario: Mapping a source status to retracted is rejected with INVALID_INPUT
- **WHEN** `importJsonl()` or `importMd()` receives a mapping whose `statusMap` maps any source status to `'retracted'`
- **THEN** the importer rejects the call with `MindError("INVALID_INPUT")` before writing any rows

#### Scenario: Source mapped as superseded or expired persists as orphan superseded
- **WHEN** a JSONL row or Markdown file maps to `status: 'superseded'` (or has `validUntil` in the past)
- **THEN** it is written via `appendRecord({ initialStatus: 'superseded' })` with `status = 'superseded'`, `supersededById = null`, excluded from default `recall()` and `ls`, and reports `currentHeadId: null, orphanSuperseded: true`

#### Scenario: Array supersedes atomically marks all predecessors or rolls back on conflict
- **WHEN** a JSONL row specifies `supersedes: ["s1", "s2"]` in an `open` organization
- **THEN** both `s1` and `s2` become `'superseded'` pointing to the new record
- **AND** if `s2` is already superseded, the entire write rolls back with `CONFLICT` leaving `s1` active

### Requirement: Markdown Importer Redaction Blocklist and Rollback-Safe Revisioning
`ImporterEngine.importMd()` SHALL:
- Skip any file whose `(org_id, source_ref, content_sha256)` matches `redacted_blocklist` while allowing re-import once content changes to a new SHA-256.
- Look up the current active chain head via indexed `records.source_ref`: in `open` mode across `(org_id, source_ref)` and in `tree` mode within `(org_id, realm_id, source_ref)`.
- Skip with zero writes when `head.payload.contentSha256 === newSha256` and `head.realmId === targetRealmId`.
- Insert an initial record with idempotency key `import-md:${sourceRef}:init:${newSha256}` when no active head exists.
- Create a superseding revision (`supersedesId = head.id`) with idempotency key `import-md:${sourceRef}:after:${head.id}:${newSha256}` whenever content changes (including rollback `v1 -> v2 -> v1`) or when `open` mode reassigns the file to a different realm.

#### Scenario: Unchanged re-import writes nothing, edits supersede, and v1->v2->v1 rollback succeeds without IDEMPOTENCY_MISMATCH
- **WHEN** a Markdown file is imported as `v1`, re-imported unchanged, updated to `v2`, and then reverted back to exact `v1` content
- **THEN** the unchanged re-import performs zero writes (`skippedUnchanged = 1`)
- **AND** `v2` supersedes `v1`, and the rollback to `v1` creates a new active `v3` superseding `v2` without triggering `IDEMPOTENCY_MISMATCH` and leaving strictly one active record

#### Scenario: Re-importing a file into a different realm in open mode supersedes the old realm head
- **WHEN** a Markdown file imported into realm `A` in an `open` organization is re-imported with the same `sourceRef` into realm `B`
- **THEN** `importMd()` finds the active head in realm `A`, creates a new active record in realm `B` superseding realm `A`'s head, and leaves zero dual-active heads

#### Scenario: Redacted content hash is blocked while sanitized new content is imported
- **WHEN** an imported Markdown record is redacted by a human and the identical file is re-imported
- **THEN** `importMd()` skips it (`skippedRedacted = 1`)
- **AND** after editing the file to remove the sensitive text (changing its SHA-256), `importMd()` imports the new revision cleanly

### Requirement: Chronological Batch Ordering and Policy-Aware Cross-Realm Supersedes
`ImporterEngine.importJsonl()` SHALL sort the entire batch ascending by `occurred_at` (with undated rows ordered after dated rows and topological ordering for `supersedes` dependencies) before writing, execute atomic cross-realm supersedes in `open` mode, degrade visible cross-realm supersedes in `tree` mode to `refs` plus `payload.crossRealmSupersedes` counted in `treeDegradedCrossRealmSupersedes`, skip `secret` rows by default, and skip `redacted_blocklist` hits.

#### Scenario: Out-of-order JSONL batch builds chronological supersede chains with policy-aware cross-realm handling
- **WHEN** a JSONL file lists a superseding event before the earlier event it replaces
- **THEN** `importJsonl()` sorts by `occurred_at` ascending so the base record is created first
- **AND** in an `open` organization, a cross-realm `supersedes` marks the older record `'superseded'` atomically
- **AND** in a `tree` organization, a visible cross-realm `supersedes` is degraded to `refs` + `payload.crossRealmSupersedes` with `treeDegradedCrossRealmSupersedes = 1`

### Requirement: Full-Corpus Import Consistency Verification (`verifyImportConsistency`)
`ImporterEngine.verifyImportConsistency()` and CLI `import-verify --source <file|dir> [--map <path>]` SHALL verify database rows against mapped source expectations and fail when:
- Any source item mapped as `superseded` or expired (`validUntil < now`) is still `'active'` in the database (`activeSupersededMismatches`).
- Any source item's declared timestamp (or undated `null`) differs from the stored `occurred_at` (`timestampMismatches`).
- It SHALL also report exact `undatedCount` and `defaultRealmFallbackCount`.

#### Scenario: Consistency checker detects active-vs-superseded and timestamp drift
- **WHEN** a corpus is imported and verified with `verifyImportConsistency()`
- **THEN** a clean import passes with zero `activeSupersededMismatches` and zero `timestampMismatches`
- **AND** if a mapped-superseded item is manually flipped to `'active'` or a declared `occurred_at` is altered in SQLite, `verifyImportConsistency()` fails and identifies the exact mismatched source items
