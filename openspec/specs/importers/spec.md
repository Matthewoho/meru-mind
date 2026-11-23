# Importers Specification

## Purpose

Define the open-source-clean Markdown (`import md`) and JSONL (`import jsonl`) importers sharing `ImportMappingConfig`, cooperative trust defaults, canonical write-path transactions, nullable undated timestamps, global content-hash `redacted_blocklist` enforcement, rollback-safe revisioning, multi-predecessor supersedes, and consistency verification (`import verify`).

## Requirements

### Requirement: Importer Trust Defaults and Canonical Write Path
`ImporterEngine.importMd()` and `ImporterEngine.importJsonl()` SHALL default to `actor.kind = 'agent'` (`confirmedByHuman = false`), setting `confirmedByHuman = true` only when explicitly invoked with a human actor (such as CLI `--as-human`). Every imported item SHALL persist through `LedgerEngine.appendRecord()` or `LedgerEngine.captureSeabed()` transactions so all storage, index, and visibility invariants apply.

#### Scenario: Default import marks records as agent-authored while --as-human sets confirmedByHuman
- **WHEN** `meru-mind import md` runs without `--as-human`
- **THEN** created records have `authorKind = "agent"` and `confirmedByHuman = false`
- **AND** with `--as-human`, created records have `authorKind = "human"` and `confirmedByHuman = true`

### Requirement: Never Fabricate Timestamps for Undated Sources
When a Markdown file or JSONL row has no declared timestamp in frontmatter, header metadata, mapped fields, or explicit opt-in `filenameDatePattern`, importers SHALL pass `occurredAt: null` explicitly (never filesystem `mtime` and never `now()`). `ImportMdResult` and `ImportJsonlResult` SHALL report exact `undatedCount` and `defaultRealmCount`.

#### Scenario: Undated Markdown file persists null occurredAt without reading filesystem mtime
- **WHEN** a Markdown file without a declared date has filesystem `mtime` set to `2010-01-01` and is imported via `importMd()`
- **THEN** the persisted record has `occurredAt === null` and `ImportMdResult.undatedCount` is `1`

### Requirement: Unified Domain-Agnostic Mapping Contract
`importMd()` and `importJsonl()` SHALL share `ImportMappingConfig` (`JsonlMappingConfig` re-exported as alias) with zero hardcoded private schemas, supporting `occurredAt`, optional `filenameDatePattern`, `realmPath`/`realmMap`/`defaultRealm`, `objectRefs`/`objectMap`, `resourceTags`, `kind`/`kindMap`, `sensitivity`, `sourceRef`, `thingRef`, `externalRef`, and `extractFields`.

#### Scenario: Shared mapping config maps realms, objects, tags, and extracted fields cleanly
- **WHEN** `importMd()` or `importJsonl()` runs with an `ImportMappingConfig`
- **THEN** records are routed to mapped realms, linked to mapped objects/tags, and preserve allowlisted `extractFields`

### Requirement: Lifecycle Status Mapping, `validUntil`, and Multi-Predecessor Supersedes
`status` and `statusMap` SHALL map source lifecycle values strictly to `'active' | 'superseded'`, rejecting `'retracted'` or unknown targets with `INVALID_INPUT`. Past `validUntil` timestamps SHALL write `initialStatus: 'superseded'` via `appendRecord()`. `supersedes` SHALL accept scalar `string` or `string[]`, atomically superseding predecessors (degrading visible cross-realm predecessors in `tree` mode to `refs` + `payload.crossRealmSupersedes`).

#### Scenario: Mapping to retracted fails while expired or array-superseding items persist atomically
- **WHEN** a mapping maps any status to `'retracted'`
- **THEN** the importer throws `INVALID_INPUT` before writing
- **AND** expired `validUntil` items persist as orphan `'superseded'`, while `supersedes: ["s1", "s2"]` supersedes both atomically or rolls back on conflict

### Requirement: Global Redaction Blocklist and Rollback-Safe Markdown Revisioning
`importMd()` SHALL check `db.isContentShaBlocked(orgId, sha)` globally regardless of `source_ref`, skipping redacted content (`skippedRedacted += 1`) even if the file was renamed, while allowing sanitized new content. It SHALL skip unchanged active heads (`skippedUnchanged += 1`), preserve human `entry move` realm placements when re-importing without an explicit per-file mapping realm (skipping cleanly in `tree` mode when the moved head lives in another realm), and create superseding revisions (`import-md:${sourceRef}:after:${head.id}:${newSha256}`) on edits, `v1 -> v2 -> v1` rollbacks, or explicit `open`-mode realm reassignments.

#### Scenario: Unchanged re-import skips, v1->v2->v1 rollback succeeds, and renamed redacted file is blocked
- **WHEN** a Markdown file is imported as `v1`, re-imported unchanged, updated to `v2`, and rolled back to `v1`
- **THEN** unchanged re-import writes nothing, `v2` supersedes `v1`, and rollback creates active `v3` superseding `v2` without `IDEMPOTENCY_MISMATCH`
- **AND** after a human redacts a file, re-importing the same bytes even under a brand-new `source_ref` skips with `skippedRedacted = 1`

### Requirement: Chronological JSONL Ordering and Global Blocklist Enforcement
`importJsonl()` SHALL sort batches ascending by `occurred_at` (undated rows last) with topological sorting for `supersedes` dependencies before writing, skip `secret` rows by default, and skip any row whose row hash or canonical entry hash hits `db.isContentShaBlocked(orgId, sha)` regardless of `source_ref` (`skippedRedacted += 1`).

#### Scenario: Out-of-order JSONL builds chronological chains and blocks redacted rows across renamed files
- **WHEN** a JSONL batch lists a superseding row before its predecessor
- **THEN** `importJsonl()` sorts chronologically so the predecessor is written first, degrades cross-realm supersedes in `tree` mode, and skips redacted rows even under a new `source_ref`

### Requirement: Full-Corpus Import Consistency Verification (`import verify`)
`ImporterEngine.verifyImportConsistency()` and CLI `meru-mind import verify --source <file|dir> [--map <path>]` SHALL verify DB rows against source expectations, failing on `activeSupersededMismatches` or `timestampMismatches` and reporting exact `undatedCount` and `defaultRealmFallbackCount`.

#### Scenario: Consistency checker detects active-vs-superseded and timestamp drift
- **WHEN** a corpus is verified cleanly and then a mapped-superseded row is flipped to `'active'` in SQLite
- **THEN** `verifyImportConsistency()` passes before mutation and fails after mutation identifying the drifted item
