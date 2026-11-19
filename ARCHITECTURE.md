# Architecture

Meru Mind separates **space & visibility (`MindRealm`)** from **time & memory depth (`MindSea`)** inside a single cohesive core with four thin ports.

## Layer Overview

```
+-------------------------------------------------------------+
| Entrypoints: CLI (meru-mind) | MCP (meru-mind-mcp) | SDK    |
+-------------------------------------------------------------+
| Core Engine:                                                |
|   VisibilityPolicy (single pure-function access rule)       |
|   LedgerEngine     (append-only records, rules, verdicts)   |
|   SeaEngine        (brief, 4-stage recall, settle, rebuild) |
|   SliceExporter    (read-only .mindrealm/ & tamper check)   |
+-------------------------------------------------------------+
| Thin Ports:  DbPort | DrivePort | BlobPort | EmbedderPort   |
+-------------------------------------------------------------+
| Adapters:                                                   |
|   SqliteDb (Node 22 node:sqlite + WAL + FTS5 + sqlite-vec)  |
|   LayerFSDriveAdapter / LocalFsDriveAdapter                 |
|   LocalBlobStore (sha256, 0o444 immutable)                  |
|   OpenAICompatibleEmbedder (fails open to FTS5)             |
+-------------------------------------------------------------+
```

## Core Invariants

1. **Single Visibility Policy**: Every read, write, search, vector KNN query, and slice export resolves access through `src/policy.ts`. Sibling realms are excluded before Top-K selection (`realm_id` partition key in `sqlite-vec` and `IN (...)` in SQLite/FTS5).
2. **Two Canonical Truth Sources**: Only `seabed_entries` (+ `blobs/`) and `records` are authoritative. Decisions live once in `records` with explicit `supersedesId` / `supersededById` links.
3. **Human-Only Rules**: `kind = "rule"` records reject non-human actors inside the ledger transaction.
4. **Cross-Family & Cited Verdicts**: Agent verdicts judging agent proposals require distinct model families, and reject verdicts must cite at least one active public decision or rule.
5. **Deterministic Hard Facts in Distillations**: Counts, IDs, and participants in `distillations.hardFacts` are computed solely by code; narrative text references verified `sourceIds`.
6. **Crash-Safe Drive Mirroring**: Every committed drive file (whether via `LayerFSDriveAdapter` or `LocalFsDriveAdapter`) is mirrored into immutable `blobs/<sha256>` and indexed in `drive_files`. Calling `rebuild()` restores FTS5, `sqlite-vec`, and the entire drive working tree from canonical truth.
7. **Zero Data Inside Repository**: `createMindEngine` refuses to initialize a runtime home inside the `@meru-mind/core` source tree.
