# Recall and Redaction Specification

## Purpose

Define intact CJK bigram query parsing with exact JS identifier boundaries, comparable staged FTS5/vector retrieval, strict total-order lexicographic ranking, shared match-centered snippets, exact SQL counts, full-chain human-only redaction, global exact-match content-hash blocklist enforcement across all write paths, and open-source hygiene scanning.

## Requirements

### Requirement: CJK Bigram Single-Token Indexing, Prefix Queries, and Exact Identifier Boundaries
`normalizeForFts()` SHALL space CJK/Latin boundaries and emit overlapping 2-char bigrams plus trailing 1-char for contiguous Han/Hiragana/Katakana/Hangul runs (`L >= 2`), or 1-char for `L === 1`. `parseSearchQuery()` SHALL NOT call `normalizeForFts()`, mapping 1-char CJK to FTS5 prefix `"c"*`, 2-char to `"bg"`, and `>= 3` to filtered bigrams. Non-CJK identifiers enforce `-`, `/`, `:` boundaries (`1.0`/`0.0`); CJK segments count covered at `>= 0.75`.

#### Scenario: Intra-word CJK compounds, 1-char prefix queries, Hangul, and cross-punctuation precision
- **WHEN** a caller searches `"现在上线东京生产了吗"`, `"锁"`, Hangul `"배포"`, `"发布"`, `"agent-worker"`, `"api/v2/auth"`, or `"redis:6379"`
- **THEN** intact CJK/Hangul compounds and 1-char queries match at start, middle, and end of words, while `"开发，布局"` does not match `"发布"` and longer identifiers (`"agent-worker-bridge"`, `"redis:63790"`) are excluded

### Requirement: Comparable Staged Retrieval and Strict Total-Order Lexicographic Ranking
`SeaEngine.recall()` and `search()` SHALL run Pass-1 (`AND`), Pass-2 (`OR`) FTS5, and optional vector queries with `O(1)` batched hydration, normalizing `-bm25` within each `(coverageTier, matchSource)` group. Ranking SHALL sort lexicographically by `coverageTier`, `coverageRatioBand`, `lexicalMatchFlag`, `statusPriority` (3 active > 2 raw > 1 superseded), `relevanceBand`, `isOlderSameObjectSibling` ASC, SDK-only `focusFlag` (OFF on `search`), and recency DESC.

#### Scenario: Active record and stronger non-focus match rank strictly ahead while preserving sort transitivity
- **WHEN** an active record competes with a superseded record or a strong non-focus match competes with a weak focus match
- **THEN** the active record and stronger non-focus match rank strictly higher, and same-object sibling demotion produces identical order across all input permutations

### Requirement: Single-Statement Unified FTS Retrieval and Strict Scope/Filter Pushdown
`SeaEngine.recall()` and `search()` SHALL execute at most 2 unified FTS5 evaluations (`WITH m AS MATERIALIZED` joining `fts_index` and `fts_docs`, `ROW_NUMBER()` per bucket) plus optional vector search. Realm scope SHALL isolate `ledgerRealmIds` and `seabedRealmIds` strictly without unioning; `kind`, `since`, `until`, and `about` (`json_each`, with `[]` short-circuiting to 0 before FTS and vector) SHALL enforce SQL and JS parity.

#### Scenario: Strict scope isolation, empty about short-circuit, and --kind parity across SQL and vector
- **WHEN** tree-mode search runs with descendant seabed, `--about` matching 0 entries, or `--kind message`/`--kind decision` (including with vector enabled)
- **THEN** descendant seabed never leaks into items or `totalMatched`, empty `--about` short-circuits to 0 results, and `--kind` excludes non-matching source types across both SQL and vector paths

### Requirement: 1-Hop Current Head Resolution, Match-Centered Snippets, and Truncation Metadata
Superseded records via `--history` or exact lookup SHALL include `currentHeadId` (visible active head or `null` if retracted/invisible/orphan) and `orphanSuperseded`. `src/format/snippet.ts` SHALL extract readable prose (omitting internal metadata), center ~240-char excerpts, and populate `RecallItem` with `contentChars`, `shownChars`, and `truncated` (true iff snippet elided readable text). `formatSearchMarkdown()` SHALL render `[shown/total chars]` and a 1-line legend iff truncated.

#### Scenario: Redacted chain head clears currentHeadId and snippets omit metadata blobs
- **WHEN** the active head `v3` of `v1 -> v2 -> v3` is redacted or a record with `contentSha256` metadata is returned
- **THEN** lookup of `v1` reports `currentHeadId: null, orphanSuperseded: false`, and snippets contain clean centered text with zero raw `contentSha256` JSON

#### Scenario: Truncation badge and legend appear only on genuinely excerpted hits
- **WHEN** `search` returns both a short record whose full prose fits in the snippet and a long record whose prose is excerpted
- **THEN** only the long record sets `truncated: true` and displays `[shownChars/contentChars chars]`, while the short record sets `truncated: false` and displays no badge

### Requirement: Exact SQL Counting Without Silent Truncation
`SeaEngine.recall()`, `SeaEngine.search()`, and `SeaEngine.brief()` SHALL compute `totalMatched`/`totalCount` and `omittedCount` from exact SQL `COUNT(*)` queries constrained to readable realms and excluding `secret` rows, with zero silent 200/500/1000 caps.

#### Scenario: More than 500 visible records report exact omittedCount without leaking hidden counts
- **WHEN** a visible realm holds 525 normal records and 5 `secret` records while a hidden sibling holds 40 records
- **THEN** unfiltered `recall({ limit: 10 })` reports `totalMatched = 525` and `omittedCount = 515`

### Requirement: Full-Chain Human-Only Redaction and Byte-Level Purge
`LedgerEngine.redact()` SHALL require `actor.kind === 'human'` and atomically wipe target rows, purge `fts_index`/`fts_docs`/`vec_*`/`entry_objects`/`resource_tags`, clear `state_label`/`state_evidence_id` on citing inactive objects (keeping `state`/`state_since`, logging `object_evidence_redacted`), sanitize `change_log`, retract citing `distillations`, and record `redacted_blocklist`. Post-commit, it SHALL unlink unused blobs, optimize FTS5, checkpoint WAL, and return `clearedObjectIds`.

#### Scenario: Byte-level sweep finds zero residual plaintext or CJK bigrams after redaction
- **WHEN** a human redacts a record containing English and CJK canary tokens, a blob-backed seabed entry, and their citing distillation and closes all DB handles
- **THEN** raw byte inspection of `.sqlite`, `-wal`, `-shm`, and `blobs/` finds zero redacted English tokens, CJK phrases, CJK bigrams, or tag plaintext
- **AND** if a drive file still references a blob, `deletedBlobSha256` is `null` and `residualLocations` lists the live drive path

#### Scenario: Redacting an object's state evidence clears label and pointer without resurrecting the object
- **WHEN** a human redacts a record cited as `state_evidence_id` on an `inactive` object
- **THEN** the object remains `state = 'inactive'` with `state_since` intact, `state_label` and `state_evidence_id` become `null`, `change_log` records `object_evidence_redacted` with `entityId = object.id`, `RedactResult.clearedObjectIds` lists the object, and badges degrade cleanly to `<kind>:<name> inactive[ <since>]`

### Requirement: Global Exact-Match Content-Hash Blocklist Across All Write Paths
One shared helper (`src/engine/content-hash.ts`: `computeRecordContentSha256`, `computeSeabedContentSha256`, `computeFileContentSha256`, `buildWriteRecordPayload`) SHALL be used by `redact()` and all write paths (`appendRecord`, `captureSeabed`, `writeDriveFile`, `importMd`, `importJsonl`). Every path SHALL check `db.isContentShaBlocked(orgId, sha)` ignoring `source_ref`: interactive writes fail with `ACCESS_DENIED` (unless CLI `--as-human`), while importers skip (`skippedRedacted += 1`).

#### Scenario: Post-redact writes are blocked across all write paths and pre-v5 rows remain enforced
- **WHEN** a human redacts a record, seabed entry, or file artifact (including pre-v5 blocklist rows after migration v5)
- **THEN** same-minute `mind_write`, later-minute `mind_write`, `raw add`, `file write`, and renamed-file `import md`/`import jsonl` are all blocked
- **AND** sanitized content with the redacted portion removed succeeds, while CLI `--as-human` can explicitly override

### Requirement: Cooperative Exact-Match Safeguard Scope (Non-DLP Boundary)
The global `(org_id, content_sha256)` blocklist SHALL be documented and treated strictly as a cooperative safeguard preventing accidental exact-match re-ingestion of human-redacted content (such as agent retries or re-imports). A 1-character modification changes the SHA-256 hash and bypasses the blocklist; it is NOT a cryptographic security or DLP boundary.

#### Scenario: Editing redacted content produces a new hash and succeeds
- **WHEN** an author removes or modifies text from a previously redacted record and writes the sanitized revision
- **THEN** the new SHA-256 does not match `redacted_blocklist` and the sanitized write succeeds as `active`

### Requirement: Externalized Private Denylist for Open-Source Hygiene Checks
`scripts/check-oss.mjs` SHALL keep only generic hygiene rules in the repository and dynamically load optional private literal denylist terms from `MERU_MIND_OSS_DENYLIST_FILE` or `~/.config/meru-mind/oss-denylist.txt`, ignoring blank lines and `#` comments and skipping silently when absent.

#### Scenario: External denylist blocks matching repository files and skips cleanly when absent
- **WHEN** `scripts/check-oss.mjs` runs with `MERU_MIND_OSS_DENYLIST_FILE` matching a repo file
- **THEN** it exits with code `1`, and when absent or non-matching it exits with code `0`
