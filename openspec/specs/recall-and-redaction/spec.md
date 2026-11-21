# Recall and Redaction Specification

## Purpose

Define intact CJK bigram query parsing with exact JS identifier boundaries, comparable staged FTS5 retrieval, strict total-order lexicographic ranking with default-off focus tie-breaking, shared match-centered snippets, exact SQL count reporting, full-chain human-only redaction with byte-level cleanup, and externalized open-source hygiene scanning.

## Requirements

### Requirement: Intact CJK Bigram Query Parsing and Exact Identifier Boundaries
`SqliteDb` SHALL retain single-character CJK spacing (`normalizeForFts`) under FTS5 `unicode61`. `parseSearchQuery()` SHALL NEVER delete characters from inside a contiguous Han/CJK segment (preserving compound words such as `"上线"`, `"下线"`, `"在线"` intact):
- Length-1 CJK segments are dropped ONLY when standalone (separated by whitespace/non-CJK), in the curated 1-char particle set (`把/从/的/了/吗/呢/啊/在/里/给/被/将`), AND at least one concrete concept remains; otherwise kept as a 1-char literal concept (so 1-char queries like `"锁"` still match).
- Length-2 CJK segments are kept as atomic 2-char bigram concepts (dropping standalone 2-char filler segments only when at least one concrete concept remains).
- Length >= 3 CJK segments generate ALL overlapping 2-char bigrams from the intact segment (`s[i..i+2]`) and filter out ONLY complete 2-char filler bigrams from a curated bigram stopword set when at least one non-stopword bigram remains.
- Each non-CJK token/identifier scores `1.0` on exact boundary match (enforcing `-`, `/`, `:` boundaries in JS) else `0.0`.
- Each CJK segment with `K` retained bigrams scores `1.0` on exact contiguous match, else `matchedBigrams / K`, and counts as covered when `segmentScore >= 0.75` (`1/1`, `2/2`, `3/3`, `>= 3/4`).
- Query coverage ratio equals `sum(conceptScores) / totalConcepts`.

#### Scenario: Intra-word CJK compounds and 1-char queries are preserved intact
- **WHEN** a caller searches `"现在上线东京生产了吗"`, `"下线旧网关"`, `"在线人数"`, or `"锁"`
- **THEN** `"上线"`, `"下线"`, `"在线"`, and `"锁"` remain intact and match their corresponding records
- **AND** natural Chinese questions such as `"上次为什么把 openspec 从 meru 主仓删掉了"` rank the matching record at `#1`

#### Scenario: Hyphen, slash, and colon identifiers enforce exact boundaries
- **WHEN** a caller searches for `"agent-worker"`, `"api/v2/auth"`, or `"redis:6379"`
- **THEN** exact identifier occurrences match while longer identifiers (`"agent-worker-bridge"`, `"api/v2/auth-proxy"`, `"redis:63790"`) are excluded

### Requirement: Comparable Staged Retrieval, Strict Total-Order Lexicographic Ranking, Default-Off Focus, and 1-Hop Head Resolution
`SeaEngine.recall()` SHALL perform staged FTS5 candidate retrieval with SQL pushdown (`realm_id`, `status`) and batched `WHERE id IN (...)` hydration (`O(1)` SQL queries):
- **Pass 1 (`AND`)**: FTS5 `AND` over all concepts (where multi-bigram CJK segments use `OR` of their bigrams inside the parenthesized `AND` group) to generate high-precision candidates scored on the same Pass-1 `MATCH` expression. JS MUST explicitly evaluate title concept coverage (`>= 0.75`) versus title+body concept coverage (`>= 0.75`) to assign Tier 4 versus Tier 3.
- **Pass 2 (`OR`)**: FTS5 `OR` over all concepts for partial recall, scored strictly on the same Pass-2 `MATCH` expression.
- **BM25 Sign Normalization**: Because SQLite `bm25()` returns negative numbers (more negative = more relevant), `relevanceBand` MUST compute positive magnitude `score = -bm25` strictly within the same `(coverageTier, matchSource)` group (`top` = `3` within 15% of group best, `mid` = `2` within 40%, `tail` = `1` beyond 40%).
- **Strict Total-Order Lexicographic Sort Key (Zero Magic Constants or `+0.35` Focus Constant)**:
  1. `coverageTier` DESC: `4` (all concepts covered in title) > `3` (all concepts covered in title+body) > `2` (high-confidence vector-only `cosine >= 0.75` OR strong partial lexical `coverageRatio >= 0.5`) > `1` (weak partial lexical `0 < coverageRatio < 0.5`) > `0` (weak vector-only `cosine < 0.75`).
  2. `coverageRatioBand` DESC (`Math.round(coverageRatio * 10)`; vector-only Tier 2 uses `10` for `cosine >= 0.85` else `8`, with `lexicalMatchFlag` breaking exact ties in favor of lexical hits).
  3. `statusPriority` DESC: `3` (active conclusion/rule/distillation) > `2` (raw seabed) > `1` (superseded).
  4. `relevanceBand` DESC (`3` top > `2` mid > `1` tail; vector-only uses `top` within `0.05` cosine, `mid` within `0.12`, `tail` otherwise).
  5. `isOlderSameObjectSibling` ASC (`0` before `1`): pre-computed unary scalar within each exact `(coverageTier, coverageRatioBand, lexicalMatchFlag, statusPriority, relevanceBand)` bucket marking any candidate sharing an `objectId` with a strictly newer dated candidate in the same bucket, guaranteeing strict sort transitivity.
  6. Optional intra-band `focusFlag` DESC: `0` for all candidates by default (`focusBoost = false`); when explicitly opted in (`focusBoost: true`), breaks ties ONLY within the same tier, status, relevance band, and sibling flag (ahead of declared recency).
  7. Declared recency and deterministic tie-breaker: `(occurredAt !== null)` DESC, `occurredAt` DESC, `createdAt` DESC, `id` DESC.
- Time-range filters (`since`, `until`) SHALL filter strictly on `occurred_at IS NOT NULL AND occurred_at >= ? / <= ?`, excluding undated (`null`) records.
- Superseded items returned via `includeHistory`/`includeSuperseded` or direct ID lookup SHALL attach `currentHeadId` (visible active head or `null` if retracted/invisible/orphan) and `orphanSuperseded: boolean`.

#### Scenario: Strong non-focus relevance band beats weak focus relevance band by default
- **WHEN** a non-focus realm holds a stronger BM25 match than a weaker match in the focus realm (and `focusBoost` is default `false`)
- **THEN** the non-focus record ranks strictly above the focus record
- **AND** even with `focusBoost: true`, focus never jumps across coverage tiers, status priority, or relevance bands

#### Scenario: Active conclusion beats superseded record and high-confidence vector hit beats weak 1-token lexical hit
- **WHEN** an active record competes with a superseded record in the same coverage tier
- **THEN** the active record ranks strictly above the superseded record
- **AND** a pure semantic vector hit with `cosine >= 0.75` (Tier 2) outranks a weak partial 1-token lexical hit (`coverageRatio < 0.5`, Tier 1)

#### Scenario: Same-object sibling demotion preserves strict total-order transitivity
- **WHEN** multiple candidates in the same relevance bucket share overlapping `objectIds` across different `occurredAt` dates
- **THEN** pre-computed unary `isOlderSameObjectSibling` demotes older siblings behind newer ones on the same object while preserving identical sort order across all input permutations

#### Scenario: Redacted chain head clears currentHeadId while orphan superseded sets orphanSuperseded
- **WHEN** the active head `v3` of a supersede chain `v1 -> v2 -> v3` is redacted
- **THEN** direct ID lookup of `v1` returns `currentHeadId: null` and `orphanSuperseded: false`
- **AND** direct lookup of an orphan superseded record returns `currentHeadId: null` and `orphanSuperseded: true`

### Requirement: Shared Match-Centered Snippet Extraction
A single shared snippet module (`src/format/snippet.ts`) SHALL extract human-readable text from structured record payloads (`summary`/`statement`/`body`/`content`/`text`/`rationale` without dumping raw JSON metadata fields such as `contentSha256`) and center ~240-character windows around the highest query-concept match density with `...` ellipsis.

#### Scenario: Snippets omit raw JSON metadata and center around matched concepts
- **WHEN** a record with long body text and `contentSha256` metadata is returned by `recall()` or `ls()`
- **THEN** the snippet contains clean readable text centered around the matched concepts and never exposes raw `contentSha256` JSON metadata blobs

### Requirement: Exact SQL Counting Without Silent Truncation
`SeaEngine.recall()` (Stage 1b, Stage 2, and unfiltered FTS Stage 3, where `totalMatched` equals the exact SQL `COUNT(*)` of the broad Pass-2 `OR` recall union) and `SeaEngine.brief()` (including pending human questions) SHALL compute `totalMatched` / `totalCount` and `omittedCount` from exact SQL `COUNT(*)` queries constrained to readable realm IDs and excluding `secret` rows, without silent 200/500/1000 caps.

#### Scenario: More than 500 visible records report exact omittedCount without leaking hidden counts
- **WHEN** a visible realm holds 525 normal records and 5 `secret` records while a hidden sibling holds 40 records
- **THEN** Stage 2 and Stage 3 `recall({ limit: 10 })` report `totalMatched = 525` and `omittedCount = 515`

### Requirement: Full-Chain Human-Only Redaction and Byte-Level Purge
`LedgerEngine.redact()` SHALL require `actor.kind === 'human'` and perform the following inside a single transaction:
- Wipe target `records` (`status = 'retracted'`, `title = '[REDACTED]'`, `payload_json = '{}'`, `external_ref = NULL`, `source_ref = NULL`, `redacted_at/by/reason`) or `seabed_entries` (`text = '[REDACTED]'`, `metadata_json = '{}'`, `blob_sha256 = NULL`, `redacted_at/by/reason`).
- Delete target rows from `fts_index`, `vec_items`, `vec_pending`, `entry_objects`, and `resource_tags`, and sanitize associated `change_log` `entity_id` suffixes for the entry inside the same transaction.
- Retract every `distillations` row citing the entry ID in `source_ids_json` (`status = 'retracted'`, `narrative_md = '[REDACTED]'`, prune the ID from `hard_facts_json`, and delete its `fts_index`, `vec_items`, and `vec_pending` rows).
- Compute blob reference counts across `seabed_entries` and `drive_files`, collect live `drive://` paths in `residualLocations`, record `(org_id, source_ref, content_sha256)` in `redacted_blocklist` (preferring `records.source_ref` and `payload.contentSha256` when present), and append `op = 'redact'` to `change_log`.
- `ObjectEngine.tagEntryResource()` SHALL record ONLY `entryId` in `change_log.entity_id` (zero plaintext tag text or unkeyed tag hash).

After transaction commit, `redact()` SHALL unlink unreferenced blob files from disk, execute FTS5 `'optimize'` and `PRAGMA wal_checkpoint(TRUNCATE)`, and return `walCheckpoint: { busy, log, checkpointed }` and `residualLocations`.

#### Scenario: Redacting an entry deletes its resource tags and object links with zero plaintext or hash residue
- **WHEN** a human redacts a record or seabed entry that has `entry_objects` links and `resource_tags` rows
- **THEN** all `entry_objects` and `resource_tags` rows for that entry are deleted inside the redaction transaction and no longer appear in `listResourceTags` or `ls`
- **AND** `change_log.entity_id` stores only `entryId` (never tag text or unkeyed hash), so `changes()` and raw byte-level sweeps across `.sqlite`, `-wal`, `-shm`, and `blobs/` find zero occurrences of the redacted tag text

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
