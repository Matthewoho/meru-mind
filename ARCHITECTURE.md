# Architecture

Meru Mind separates **space & visibility (`MindRealm`)** from **time & memory depth (`MindSea`)** inside a single cohesive core with four thin ports.

## Layer Overview

```
+-------------------------------------------------------------+
| Entrypoints: CLI (meru-mind) | MCP (meru-mind-mcp) | SDK    |
+-------------------------------------------------------------+
| Core Engine:                                                |
|   VisibilityPolicy (open | tree access & scope intersection)|
|   LedgerEngine     (append-only records, rules, redact)     |
|   SeaEngine        (brief, 4-stage recall, settle, rebuild) |
|   SliceExporter    (read-only .mindrealm/ & tamper check)   |
+-------------------------------------------------------------+
| Thin Ports:  DbPort | DrivePort | BlobPort | EmbedderPort   |
+-------------------------------------------------------------+
| Adapters:                                                   |
|   SqliteDb (Node 22 node:sqlite + WAL + FTS5 + sqlite-vec)  |
|   LayerFSDriveAdapter / LocalFsDriveAdapter                 |
|   LocalBlobStore (sha256, 0o444 immutable)                  |
|   OpenAICompatibleEmbedder (off-write-path batch sync)      |
+-------------------------------------------------------------+
```

## Core Invariants

1. **Single Visibility Policy (`open` | `tree`)**: Every read, write, search, vector KNN query, drive operation, and slice export resolves access through `src/policy.ts`. Cross-organization boundaries are hard walls in both modes. In `tree` mode, sibling realms are excluded before Top-K selection (`realm_id` partition key in `sqlite-vec` and `IN (...)` in SQLite/FTS5), and all cross-references (`refs`, `sourceRefs`, `sourceIds`, `supersedes*`, `drive://<realmId>/...`) are filtered against visible scope. In `open` mode, all realms within the same organization are readable while `computeVisibleScope()` acts as `focusRealmIds` for recall ranking boost.
2. **Two Canonical Truth Sources**: Only `seabed_entries` (+ `blobs/`) and `records` are authoritative. Decisions live once in `records` with explicit `supersedesId` / `supersededById` links updated via atomic CAS inside `BEGIN IMMEDIATE` transactions.
3. **Human-Only Privileged Operations**: `kind = "rule"` writes, `redact()`, `setOrgPolicy()`, and `tree`-mode realm topology mutations (`createRealm`, `mountRealm`, `unmountRealm`) reject non-human actors inside the database transaction.
4. **Deterministic Hard Facts in Distillations**: Counts, IDs, and participants in `distillations.hardFacts` are computed solely by code; narrative text references verified `sourceIds`.
5. **Sensitivity Enforcement**: `secret` entries bypass FTS5, `vec_pending`, `vec_items`, `brief`, `exportSlice`, `change_log` summaries, and all list/timeline paths; they are only readable by exact ID lookup within visible scope. `confidential` entries participate in in-org recall and `brief`, but are strictly excluded from `exportSlice`.
6. **Crash-Safe Drive Mirroring & Durable Change Log**: Every committed drive file (whether via `LayerFSDriveAdapter` or `LocalFsDriveAdapter`) is mirrored into immutable `blobs/<sha256>` and indexed in `drive_files`. Calling `rebuild()` restores FTS5, `sqlite-vec`, and the entire drive working tree from canonical truth while preserving `change_log` and `change_log_generation`.
7. **Zero Data Inside Repository**: `createMindEngine` refuses to initialize a runtime home inside the `@meru-mind/core` source tree.

## Threat Model & Operational Semantics

### Single-Machine Cooperative Threat Model
- In local single-machine SQLite mode, any process running under the same OS user physically shares filesystem access to `mind.sqlite` and `blobs/`. The local access model guards against accidental agent misreads, cross-realm context pollution, and unauthorized tool invocations — it is **not** a kernel-level boundary against a hostile local process. Strong physical isolation requires a dedicated server process owning the SQLite file exclusively (planned for multi-tenant/centralized deployments).
- **MCP Process-Level Binding**: `meru-mind-mcp` binds `MERU_MIND_ORG_ID`, `MERU_MIND_VIEWER_REALM_ID` (required for `tree` orgs, optional default focus for `open` orgs), `MERU_MIND_ACTOR_ID`, and `MERU_MIND_ACTOR_FAMILY` at process startup. `actorKind` is hardcoded to `"agent"` and removed from all MCP tool schemas. Narrowing a call to a child `viewerRealmId` always evaluates effective visibility as `scope(requestedViewer) ∩ scope(boundViewer)` so a child's `@mount` or seabed can never widen past the bound viewer. Human-only and high-impact maintenance tools (`rule` writes, `redact`, `setOrgPolicy`, tree mutations, `rebuild`, `exportSlice`) are excluded from MCP and exposed only via CLI.

### `confirmedByHuman` Is a Cooperative Marker
- The CLI defaults to `--actor-kind agent` so automated hooks and scripts never acquire human privilege implicitly. Human-privileged CLI commands require explicit `--as-human`.
- Because any agent with unrestricted local shell/PTY access can still invoke `--as-human`, `confirmedByHuman` in single-machine mode is strictly a **cooperative provenance marker**, not a cryptographic or kernel-enforced human approval guarantee. Host orchestrators that rely on human sign-off for hard gates must assert actor identity inside their own trusted control plane.

### Organization-Scoped Idempotency Keys
- `idempotency_keys` uses `PRIMARY KEY (org_id, key)` shared across `records` and `seabed_entries`. In `tree` mode, hitting an existing key that belongs to an invisible sibling realm returns an opaque `NOT_FOUND` (zero payload or ID disclosure). However, because the namespace is org-wide, a caller could still distinguish key collision (`NOT_FOUND`) from successful creation of a fresh key. Callers that require zero key-existence signaling across sibling branches should prefix keys with their own `realmId`.

### `rebuild()` Embedding Re-computation Cost
- `rebuild()` clears `fts_index`, `vec_items`, and `vec_pending`, re-indexes all non-secret, non-redacted canonical rows, and then runs `syncEmbeddings()`. When a remote OpenAI-compatible embedding provider is configured, `rebuild()` will re-embed the entire corpus and incur API token/billing cost proportional to total database size. Use `sync-embeddings` for routine incremental indexing and reserve `rebuild()` for index corruption or drive recovery.

### `redact` Chain-Head & Residual Semantics
- `redact()` is human-only and runs with connection-level `PRAGMA secure_delete = ON`. Within a single transaction it wipes target content (`[REDACTED]`), removes FTS5 / `vec_items` / `vec_pending` rows, retracts every `distillation` citing the redacted ID (setting `narrative_md = '[REDACTED]'`, `status = 'retracted'`, pruning the ID from `hard_facts_json`, and removing its FTS5/vector rows), deletes the backing blob from `blobs/` when no `seabed_entries` or `drive_files` still reference its SHA-256, records `(org_id, source_ref, content_sha256)` in `redacted_blocklist`, and appends `op = 'redact'` to `change_log`.
- **Chain-Head Semantics**: Redacting the `active` head of a supersede chain sets its status to `retracted`. That chain thereafter has **no active current version** (`currentHeadId` resolves to `null`), and any subsequent attempt to `supersede` a `retracted` record fails with `CONFLICT`.
- **Post-Commit Hygiene & Residuals**: After commit, `redact()` unlinks unreferenced blobs, runs FTS5 `'optimize'` and `PRAGMA wal_checkpoint(TRUNCATE)`, and returns the exact `walCheckpoint: { busy, log, checkpointed }` status (non-zero `busy` warns that another open reader prevented WAL truncation) along with `residualLocations` (e.g., live `drive_files` paths or external snapshots still containing the content).
