# Importers Specification

## Purpose

Define the open-source-clean, domain-agnostic Markdown (`import-md`) and JSONL (`import-jsonl`) importers, enforcing cooperative trust defaults, canonical write-path transactions, declared-timestamp extraction without filesystem `mtime`, `redacted_blocklist` enforcement, rollback-safe chain-head revisioning, and policy-aware cross-realm supersede handling.

## Requirements

### Requirement: Importer Trust Defaults and Canonical Write Path
`ImporterEngine.importMd()` and `ImporterEngine.importJsonl()` SHALL default to `actor.kind = 'agent'` (`confirmedByHuman = false`), elevating to `confirmedByHuman = true` ONLY when explicitly invoked with a human actor (such as CLI `--as-human`). Every imported item SHALL be persisted exclusively through `LedgerEngine.appendRecord()` or `LedgerEngine.captureSeabed()` transactions so idempotency keys, CAS supersedes, FTS5, `vec_pending`, `change_log`, and visibility invariants always apply.

#### Scenario: Default import marks records as agent-authored while --as-human sets confirmedByHuman
- **WHEN** `import-md` runs via CLI without `--as-human`
- **THEN** every created record has `authorKind = "agent"` and `confirmedByHuman = false`
- **AND** when run with `--as-human`, created records have `authorKind = "human"` and `confirmedByHuman = true`

### Requirement: Markdown Importer Declared Timestamps, Redaction Blocklist, and Rollback-Safe Revisioning
`ImporterEngine.importMd()` SHALL:
- Extract explicitly declared timestamps (such as `occurred_at`, `updated_at`, `valid_from`, `created_at`, or `date` in frontmatter or header metadata) and NEVER read filesystem `mtime`.
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

#### Scenario: Filesystem mtime is never used for occurredAt
- **WHEN** a Markdown file without a declared timestamp has its filesystem `mtime` manually set to an older historical year (e.g. `2010-01-01`)
- **THEN** the imported record's `occurredAt` reflects import time rather than the filesystem `mtime`

### Requirement: Generic Field-Mapped JSONL Importer
`ImporterEngine.importJsonl()` SHALL accept an external domain-agnostic `JsonlMappingConfig` (`id`, `kind`, `kindMap`, `title`, `body`, `occurredAt`, `realmPath`, `realmMap`, `objectRefs`, `resourceTags`, `thingRef`, `supersedes`, `sensitivity`, `sourceRef`, `extractFields`) with zero hardcoded private schemas. It SHALL:
- Sort the entire batch ascending by `occurred_at` (with topological ordering for same-timestamp `supersedes`) before writing.
- Execute normal atomic cross-realm `supersedes` in `open` mode so replaced items become `'superseded'`.
- Degrade visible cross-realm `supersedes` in `tree` mode to `refs` plus `payload.crossRealmSupersedes` and report the exact count in `treeDegradedCrossRealmSupersedes`.
- Restrict payload fields to `extractFields` when configured, skip `secret` rows by default, skip `redacted_blocklist` hits, and optionally invoke `syncEmbeddings()`.

#### Scenario: Out-of-order JSONL batch builds chronological supersede chains with policy-aware cross-realm handling
- **WHEN** a JSONL file lists a superseding event before the earlier event it replaces
- **THEN** `importJsonl()` sorts by `occurred_at` ascending so the base record is created first
- **AND** in an `open` organization, a cross-realm `supersedes` marks the older record `'superseded'` atomically
- **AND** in a `tree` organization, a visible cross-realm `supersedes` is degraded to `refs` + `payload.crossRealmSupersedes` with `treeDegradedCrossRealmSupersedes = 1`
