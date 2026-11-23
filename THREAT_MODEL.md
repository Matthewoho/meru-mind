# Meru Mind Threat Model & Security Boundaries

> Applies to `v0.3+` (`meru-mind serve`, `MindSurface`, Streamable HTTP MCP, and `v0.4` Web Governance Surface).

## 1. Trust Boundaries & Tenancy

1. **Single-Organization Server Instance**: Open-source `meru-mind serve` hosts **one organization per process and SQLite file**. Future managed multi-tenant deployments use **one tenant = one isolated SQLite file / Durable Object** — eliminating cross-tenant SQL injection or query-filter leaks by physical architecture.
2. **Server-Authoritative Identity (`Principal`)**:
   - Every token row in `tokens` stores **only a SHA-256 hash** (`token_hash`). Plaintext tokens (`mm_live_...`) are shown once at mint time and never persisted.
   - `actor_kind` (`"human" | "agent"`) is fixed in SQLite at token issuance. Remote clients **cannot** elevate privilege via headers, JSON fields, or `--as-human` (CLI rejects `--as-human` in remote mode).
   - Token revocation (`revoked_at`) takes effect immediately across REST, Streamable HTTP MCP, Long-Poll, and WebSocket pumps.
3. **Exclusive Single-Writer Lock (`mind.serve.lock`)**:
   - While `meru-mind serve` runs, local CLI / stdio MCP processes are blocked from opening `mind.sqlite` directly so same-host agents cannot bypass `Principal` authentication.
4. **Same-Machine Agent Risk**:
   - On a developer laptop where local coding agents run under the same OS user, any credential written to disk in the workspace or home directory is readable by those agents.
   - **Mitigation**: Keep human governance tokens out of project files and `.env` files. In `v0.4`, browser governance sessions use `HttpOnly; SameSite=Strict` cookies minted via 60-second single-use CLI codes (`meru-mind ui login`) and are restricted to **read + reversible actions only**.

## 2. Weakened Browser Cookie Boundary (`v0.4` Composable UI)

Because `v0.4` allows users/agents to author bespoke local UI shells via `--web-dir`, a malicious or buggy script running on the UI origin shares the browser cookie jar. Meru Mind enforces **6 hard guardrails**:

1. **Weakened Cookie Capabilities**: Cookie sessions may only read visible scope and perform reversible actions (`write`, `move` / inbox triage, `pulse` focus). Irreversible or scope-widening mutations (`rule add`, `redact`, `realm mount/unmount/create/archive`, `org set-policy`, `token create/list/revoke`) strictly return `403` with a copyable CLI command requiring a Bearer token.
2. **No Browser Login Form**: Long-lived tokens never enter DOM inputs; `meru-mind ui login` exchanges a 60s single-use code for an `HttpOnly; SameSite=Strict` cookie.
3. **Strict Server CSP**: `default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
4. **Reserved Prefixes**: `/_meru/*` and `/v1/*` can never be shadowed by custom `--web-dir` files.
5. **No Service Workers**: Any request with `Service-Worker: script` returns `404`.
6. **Loopback-Only `--web-dir`**: Custom UI directories are rejected at startup on non-loopback bind addresses in `v0.4`.

## 3. Secrets, Access Logs & `redact` Residual Checklist

- **Write-Time Secret Guard**: `write`, `raw add`, and `rule add` intercept common plaintext credentials (`sk-...`, `ghp_...`, `mm_live_...`, `lin_api_...`, `AKIA...`, `xox...`, PEM private keys) unless explicitly classified `sensitivity: "secret"`.
- **External Work Bindings (`v0.5`)**: `work_bindings.config_json` must store **environment variable references only** (e.g. `env:LINEAR_API_KEY`), never raw API keys.
- **Redacted Access Logs**: `meru-mind serve` logs `method`, `pathname`, `statusCode`, `durationMs`, and `actorId` only — **never** query strings, `Authorization`, `Cookie`, or request bodies.
- **`redact` Residual Locations**: Redaction zeroes live SQLite rows (`secure_delete = ON`), drops FTS/vector rows, deletes unreferenced blobs, checkpoints WAL, and records content SHA-256 in `redacted_blocklist`. Operators must additionally inspect/rotate:
  1. Earlier `VACUUM INTO` snapshots in `<homeDir>/backups/`
  2. Exported read-only slices (`admin export-slice`)
  3. Downstream Git JSONL projections (committed Git history is immutable)
  4. External issue comments if optional `bodyMarkdown` was opted into `annotate()`

## 4. Realtime Pump Isolation

- `change_log` Pump frames contain **only coordinates** (`seq`, `generation`, `realmId`, `entityType`, `entityId`, `op`, `assetClass`, `actorId`, `createdAt`) — never record body, title, or payload.
- Pump SQL strictly separates `(ledgerSet, seabedSet, driveSet)` and enforces the `__org__` invariant (`realm_id = '__org__'` is only emitted when `entity_type = 'org'`), preventing sibling-realm leaks in `tree` mode.

## 5. Runtime & Plugin Isolation

- **Node.js `node:sqlite`**: Uses Node 22+ built-in `node:sqlite` (`DatabaseSync`), tested across Node 22 and Node 24 in CI.
- **Plugin Isolation (`v0.5`)**: Official providers (`linear`, `github`) load statically in-process with per-call timeouts and circuit breakers. Meru Mind never `import()`s arbitrary user-configured code paths; third-party providers run out-of-process over MCP.
