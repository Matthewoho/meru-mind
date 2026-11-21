# Recall and Redaction Specification

## Purpose

Define mixed CJK/English FTS5 search with exact JS identifier boundary verification, tiered active-first and open-mode focus ranking, exact SQL count reporting, full-chain human-only redaction with byte-level cleanup, and externalized open-source hygiene scanning.

## Requirements

### Requirement: Mixed CJK/English FTS5 Query Parsing and Exact Identifier Boundaries
`SqliteDb` SHALL retain single-character CJK spacing (`normalizeForFts`) under FTS5 `unicode61`. `parseSearchQuery()` SHALL convert contiguous CJK segments into FTS5 phrases, strip generic filler stopwords only when at least one concrete concept remains, and join concepts with `OR` for broad BM25 candidate recall. `SeaEngine.recall()` SHALL verify exact boundaries in JavaScript for hyphen, slash, and colon identifiers (`-`, `/`, `:`) so FTS-only substring collisions are rejected.

#### Scenario: Contiguous CJK phrase and stopword handling
- **WHEN** a caller searches with filler words around a CJK concept (e.g. `"查找一下关于支付网关的相关"`)
- **THEN** filler stopwords are stripped to `"支付网关"`, matching contiguous `"支付网关"` and rejecting documents with scattered characters
- **AND** a query containing only stopwords preserves its terms rather than returning an empty query

#### Scenario: Hyphen, slash, and colon identifiers enforce exact boundaries
- **WHEN** a caller searches for `"agent-worker"`, `"api/v2/auth"`, or `"redis:6379"`
- **THEN** exact identifier occurrences match while longer identifiers (`"agent-worker-bridge"`, `"api/v2/auth-proxy"`, `"redis:63790"`) are excluded

### Requirement: Tiered RRF, Active-First, Focus-Boosted Ranking and 1-Hop Head Resolution
`SeaEngine.recall()` SHALL rank search candidates by concept coverage tier (Tier 3 all concepts in title > Tier 2 all concepts in body > Tier 1 partial > Tier 0 vector-only), then within-tier normalized RRF multiplied by status weight (`active` conclusion > `raw` seabed > `superseded`) plus an `open`-mode focus boost (`+0.35` for `focusRealmIds`, `+0.05` for self realm), breaking ties by `occurredAt` descending. Superseded items returned via `includeHistory`/`includeSuperseded` or direct ID lookup SHALL attach `currentHeadId` pointing to the visible active chain head, or `null` if the head is retracted, secret, or invisible.

#### Scenario: Focus realm outranks non-focus sibling in open mode
- **WHEN** two sibling realms in an `open` organization contain equivalent matching records
- **THEN** querying from realm A ranks realm A's record strictly above realm B's by at least `0.35`, and querying from realm B flips the order

#### Scenario: Multi-valued realm derivation grants focus boost in open mode only
- **WHEN** a record physically stored in realm A is linked via `entry_objects` to an object in realm B inside an `open` organization
- **THEN** querying from viewer realm B grants the record the `open`-mode focus boost (`+0.35` focus + `+0.05` self)
- **AND** in a `tree` organization, `entry_objects` never widens visibility or focus beyond physical `realm_id`

#### Scenario: Redacted chain head clears currentHeadId
- **WHEN** the active head `v3` of a supersede chain `v1 -> v2 -> v3` is redacted
- **THEN** direct ID lookup of `v1` returns `currentHeadId: null`

### Requirement: Exact SQL Counting Without Silent Truncation
`SeaEngine.recall()` (Stage 1b, Stage 2, and unfiltered FTS Stage 3) and `SeaEngine.brief()` (including pending human questions) SHALL compute `totalMatched` / `totalCount` and `omittedCount` from exact SQL `COUNT(*)` queries constrained to readable realm IDs and excluding `secret` rows, without silent 200/500/1000 caps.

#### Scenario: More than 500 visible records report exact omittedCount without leaking hidden counts
- **WHEN** a visible realm holds 525 normal records and 5 `secret` records while a hidden sibling holds 40 records
- **THEN** Stage 2 and Stage 3 `recall({ limit: 10 })` report `totalMatched = 525` and `omittedCount = 515`

### Requirement: Full-Chain Human-Only Redaction and Byte-Level Purge
`LedgerEngine.redact()` SHALL require `actor.kind === 'human'` and perform the following inside a single transaction:
- Wipe target `records` (`status = 'retracted'`, `title = '[REDACTED]'`, `payload_json = '{}'`, `external_ref = NULL`, `source_ref = NULL`, `redacted_at/by/reason`) or `seabed_entries` (`text = '[REDACTED]'`, `metadata_json = '{}'`, `blob_sha256 = NULL`, `redacted_at/by/reason`).
- Delete target rows from `fts_index`, `vec_items`, `vec_pending`, `entry_objects`, and `resource_tags`, and sanitize associated `change_log` `entity_id` suffixes for the entry inside the same transaction.
- Retract every `distillations` row citing the entry ID in `source_ids_json` (`status = 'retracted'`, `narrative_md = '[REDACTED]'`, prune the ID from `hard_facts_json`, and delete its `fts_index`, `vec_items`, and `vec_pending` rows).
- Compute blob reference counts across `seabed_entries` and `drive_files`, collect live `drive://` paths in `residualLocations`, record `(org_id, source_ref, content_sha256)` in `redacted_blocklist` (preferring `records.source_ref` and `payload.contentSha256` when present), and append `op = 'redact'` to `change_log`.

After transaction commit, `redact()` SHALL unlink unreferenced blob files from disk, execute FTS5 `'optimize'` and `PRAGMA wal_checkpoint(TRUNCATE)`, and return `walCheckpoint: { busy, log, checkpointed }` and `residualLocations`.

#### Scenario: Redacting an entry deletes its resource tags and object links with zero plaintext residue
- **WHEN** a human redacts a record or seabed entry that has `entry_objects` links and `resource_tags` rows
- **THEN** all `entry_objects` and `resource_tags` rows for that entry are deleted inside the redaction transaction and no longer appear in `listResourceTags` or `ls`
- **AND** `change_log` never stores plaintext resource tag values, so `changes()` and raw byte-level sweeps across `.sqlite`, `-wal`, `-shm`, and `blobs/` find zero occurrences of the redacted tag text

#### Scenario: Byte-level sweep finds zero residual plaintext after closing connections
- **WHEN** a human redacts a record, a blob-backed seabed entry, and their citing distillation (containing single-token secrets) and closes all database handles
- **THEN** raw byte inspection of `mind.sqlite`, `mind.sqlite-wal`, `mind.sqlite-shm`, and `blobs/` finds zero occurrences of any redacted secret token
- **AND** if an external reader holds an open read snapshot during `redact()`, `walCheckpoint.busy` reports `1`

#### Scenario: Shared drive blob is preserved and surfaced in residualLocations
- **WHEN** a seabed artifact sharing its `blob_sha256` with a live `drive_files` entry is redacted
- **THEN** `deletedBlobSha256` is `null`, the blob remains intact for the drive file, and `residualLocations` lists the live `drive://<realmId>/<relPath>@v<n>` path

### Requirement: Externalized Private Denylist for Open-Source Hygiene Checks
`scripts/check-oss.mjs` SHALL store only generic hygiene rules inside the repository and dynamically load optional private literal denylist terms from `MERU_MIND_OSS_DENYLIST_FILE` or `~/.config/meru-mind/oss-denylist.txt` (ignoring blank lines and `#` comments, and skipping silently when absent).

#### Scenario: External denylist blocks matching repository files and skips cleanly when absent
- **WHEN** `scripts/check-oss.mjs` runs with `MERU_MIND_OSS_DENYLIST_FILE` containing a literal term present in the repository
- **THEN** the script exits with code `1`
- **AND** when the external file does not exist or contains only absent terms and comments, the script exits with code `0`
