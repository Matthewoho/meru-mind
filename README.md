# Meru Mind

**Scoped visibility (`MindRealm`) and layered memory & ledger engine (`MindSea`) for multi-agent teams.**

Meru Mind is a lightweight, standalone TypeScript engine (`CLI` + `MCP Server` + `SDK`) designed to give multi-agent systems a single source of truth without context flooding or cross-scope leakage.

## Core Concepts

- **MindRealm (Space & Boundary)**: A hierarchical tree of realms (one realm = one workspace/group scope) governed by a single pure-function visibility policy:
  - **Ancestors**: inherited read-only (rules, decisions, drive, seabed).
  - **Self**: writable ledger/drive/seabed; rules are writable **only by humans**.
  - **Siblings**: 100% invisible across every entrypoint (`brief`, `recall`, FTS5, `sqlite-vec`, slice export, drive).
  - **Explicit `@mount`**: opt-in cross-branch read-only access.
  - **Parent -> Descendant**: parent reads child ledger/cards by default, while raw descendant seabed is only retrieved on explicit dive.
- **MindSea (Time & Depth)**: Five conceptual layers backed by only **two canonical truth sources**:
  1. **Seabed (`seabed_entries` + immutable `0o444` `blobs/`)**: append-only raw messages, artifacts, evidence, and signals.
  2. **Ledger (`records`)**: append-only facts, things, proposals, verdicts, findings, decisions, and rules with `supersedes` chains (decisions are stored once, never duplicated).
  - All derived layers (FTS5 index, `sqlite-vec` vector partitions, event slices, cognitive cards, and disposable drive working trees) can be destroyed and reconstructed via `rebuild`.

## Quick Start

Requires **Node.js >= 22.13** (uses built-in `node:sqlite` + `sqlite-vec`).

```bash
pnpm install
pnpm build
pnpm test
```

### CLI Usage

Runtime data is always stored outside the repository (defaults to `~/.meru-mind` or `MERU_MIND_HOME` / `--home`).

```bash
export MERU_MIND_HOME="$HOME/.meru-mind"

# 1. Initialize personal root org & root realm
node dist/cli.js admin init --org "Acme"

# 2. Create child realms (realm topology & lifecycle are human-only in both open and tree modes)
node dist/cli.js realm create --parent / --slug backend --name "Backend" --scope "Include: API design, storage, backend deploys. Exclude: marketing." --as-human
node dist/cli.js realm create --parent / --slug marketing --name "Marketing" --scope "Include: launches, campaigns. Exclude: backend infra." --as-human

# 3. Record a human rule, an explicit-realm conclusion, and a zero-flag note (auto-routes to /inbox)
node dist/cli.js rule add --in / --title "Never deploy without passing integration tests" --body "All merges require passing CI." --as-human
node dist/cli.js write --in /backend --kind decision --title "Use PostgreSQL 17 for primary storage" --body "Standardize on PG 17."
node dist/cli.js write --title "Investigate p95 latency spike" --body "Omitted --in lands in /inbox for triage."

# 4. Capture seabed messages & write shared drive files
node dist/cli.js raw add --in /backend --kind message --text "Benchmarked PostgreSQL connection pool sizing"
node dist/cli.js file write file:/backend/STATE.md --content "# Backend State"

# 5. Inspect identity/inbox count, workspace tree, and realm brief
node dist/cli.js whoami
node dist/cli.js tree
node dist/cli.js show /backend

# 6. Scoped search (ID -> filter -> FTS5 + local-passage window -> optional sqlite-vec)
node dist/cli.js search "PostgreSQL" --in /backend

# 7. Govern realms & move entries atomically (human-only)
node dist/cli.js realm set /backend --scope "Include: API, storage, database migrations. Exclude: frontend." --as-human
node dist/cli.js entry move <rec_id> --to /backend --dry-run --as-human
node dist/cli.js realm archive /marketing --as-human
node dist/cli.js tree --all

# 8. Export a read-only slice for sandboxed agents
node dist/cli.js admin export-slice --in /backend --out /tmp/agent-slice/.meru/.mindrealm
```

### MCP Server Usage

`meru-mind-mcp` exposes a compact **7-tool** contract (`mind_whoami`, `mind_tree`, `mind_ls`, `mind_show`, `mind_search`, `mind_changes`, `mind_write`). Connect any MCP-compatible client (Claude Code, Codex, Antigravity, Cursor, etc.):

```json
{
  "mcpServers": {
    "meru-mind": {
      "command": "node",
      "args": ["/path/to/meru-mind/dist/mcp.js"],
      "env": {
        "MERU_MIND_HOME": "/path/to/your/data-dir"
      }
    }
  }
}
```

### Optional Semantic Vector Search (`sqlite-vec`)

By default, `sqlite-vec` loads automatically inside `node:sqlite` with `realm_id` partition-key pre-filtering. Configure any OpenAI-compatible embedding endpoint to enable hybrid FTS5 + vector RRF recall:

```bash
export MERU_MIND_EMBED_URL="https://api.openai.com/v1"
export MERU_MIND_EMBED_API_KEY="your-key"
export MERU_MIND_EMBED_MODEL="text-embedding-3-small"
export MERU_MIND_EMBED_DIM="1536"
```

When unconfigured or offline, Meru Mind degrades gracefully to FTS5 and queues pending vectors for backfill on `rebuild`.

### Concurrent Shared Drive (`LayerFS` & `local`)

Meru Mind abstracts its shared file drive behind `DrivePort`:
- `local` (default): zero-Docker local filesystem adapter with optimistic `expectedVersion` conflict detection.
- `layerfs`: concurrent LayerFS SDK adapter (`@layerfs/agent` or `LAYERFS_SDK_DIR`) with native commit conflict detection and automatic mirroring into immutable `blobs/` for crash recovery.

## License

MIT
