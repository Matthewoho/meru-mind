# Cloud Deployment & Composable AI-Built Frontend Architecture

> Design reference for Meru Mind `v0.3` (Team Server), `v0.4` (Composable Web Governance Surface), and future Cloudflare Durable Objects SaaS Track.

---

## Part 1: Deploying `meru-mind serve` to Cloud Servers (`v0.3`)

### Core Physical Constraint: Single-Writer SQLite WAL
Meru Mind `v0.3+` runs as a **single Node.js 22+ process owning one SQLite WAL database with an exclusive lock**.
- **Best fit**: Single-instance compute with a **persistent local block volume** (VPS / ECS / GCE / Fly.io Machines / Railway / Render Disk).
- **Avoid**: Multi-replica stateless containers sharing SQLite over NFS/SMB (breaks WAL locking) or ephemeral disks without persistent volumes.

### Track 1 (Open-Source Self-Hosted Primary): Docker Compose + Caddy / Fly.io

A 1 vCPU / 1 GB RAM instance handles a small-to-medium human-AI team comfortably with zero heavy middleware (no Kafka, no Elasticsearch, no Neo4j, no CockroachDB).

```
Internet (HTTPS / WSS)
   │
   ▼
[Caddy Reverse Proxy]  (auto Let's Encrypt TLS + WS Upgrade + Origin pass-through)
   │  http://meru-mind:3800
   ▼
[meru-mind serve]      (non-root Node 22-slim container, single writer, exclusive lock)
   ├── /v1/*           REST API (MindSurface + Long-Poll)
   ├── /mcp            Streamable HTTP MCP (7 tools)
   ├── /v1/ws          v0.4 Pump WebSocket (same-origin HttpOnly Cookie + Origin check)
   ├── /_meru/client.js  Zero-dependency framework-agnostic client (version-locked to server)
   ├── /_meru/shell    Built-in official Default Shell (always available as fallback)
   └── /               Active UI (--web-dir on loopback, or built-in default shell)
   │
   ▼
[Persistent Disk Volume: /var/lib/meru-mind]
   ├── mind.sqlite (+ -wal / -shm)
   ├── blobs/          (0o444 immutable evidence)
   └── backups/        (scheduled VACUUM INTO snapshots; optional Litestream → S3/R2/GCS)
```

Key operational guardrails:
1. **Safe one-shot first-token bootstrap (NEVER leave `--init-token` in `docker-compose.yml` logs)**:
   ```bash
   # Before starting the long-running server, mint the first human admin token in a one-shot container
   docker compose -f deploy/docker-compose.yml run --rm meru-mind \
     node /app/dist/cli.js token create --actor-id admin --kind human --as-human
   # Then start the persistent server + Caddy HTTPS proxy
   MERU_DOMAIN=mind.example.com docker compose -f deploy/docker-compose.yml up -d
   ```
   Mint teammate tokens and 60-second browser login links remotely with your saved admin token:
   ```bash
   MERU_MIND_URL=https://mind.example.com MERU_MIND_TOKEN=<admin-token> \
     meru-mind token create --actor-id teammate --kind human
   MERU_MIND_URL=https://mind.example.com MERU_MIND_TOKEN=<your-token> \
     meru-mind ui login
   ```
2. **Secrets stay in environment variables** (`MERU_MIND_ORIGIN`, `LINEAR_API_KEY`, etc.) — never stored in SQLite tables or `work_bindings.config_json`.
3. **Online disaster-recovery backups (no downtime required)**: Trigger an atomic `VACUUM INTO` snapshot over the live server with a human Bearer token:
   ```bash
   MERU_MIND_URL=https://mind.example.com MERU_MIND_TOKEN=<admin-token> \
     meru-mind admin backup
   ```
   Snapshots land in `<MERU_MIND_HOME>/backups/` with SHA-256 verification and can be paired with [Litestream](https://litestream.io/) for continuous WAL replication to S3 / R2 / GCS.

### Optional Standard OIDC SSO, Roles, Editable Display Names & Device-Code CLI Login (`v0.6.0` / `v0.6.1`)

Meru Mind supports standard OpenID Connect (PKCE + `nonce` + `(issuer, subject)` identity binding) with **zero IdP-specific adapters**:

- **Recommended (passkey-first lightweight IdP)**: `deploy/docker-compose.oidc-pocketid.yml` (Caddy + Meru Mind + [Pocket ID v2](https://github.com/pocket-id/pocket-id) on port `1411`, volume `/app/data`, requires `POCKET_ID_ENCRYPTION_KEY`)
- **Secondary (existing Google Workspace / GitHub SSO)**: `deploy/docker-compose.oidc-dex.yml` (Caddy + Meru Mind + [Dex v2.46.0+](https://github.com/dexidp/dex) for native `max_age` / `auth_time` support)

Configure via 4 environment variables:
- `MERU_OIDC_ISSUER` (e.g. `https://id.example.com`)
- `MERU_OIDC_CLIENT_ID`
- `MERU_OIDC_CLIENT_SECRET` (optional for public PKCE clients)
- `MERU_MIND_PUBLIC_URL` (e.g. `https://mind.example.com`; register `https://mind.example.com/_meru/oidc/callback` as redirect URI)
- Optional `MERU_OIDC_TRUST_ISSUER=true` for dedicated single-tenant IdPs (default `false`: invite-only). Auto-provisioned users under `MERU_OIDC_TRUST_ISSUER=true` are **always** created with `role: "member"` (never `"admin"`).

Organization roles (`admin` vs `member`, `v0.6.1`):
- **`member`** (default for invites and auto-provisioned SSO users): full everyday memory/ledger access within bound realm scope; can edit their own display name; receives `403` on organization admin endpoints (`/v1/tokens*`, `/v1/invites*`, `/v1/identities`, `/v1/actors/*`, `/v1/admin/backup`).
- **`admin`** (root-realm human only): manages invites, tokens, actor roles, offboarding (`actor disable`), and online backups. Self-demotion and disabling/demoting the last active admin are blocked.
- **Editable `displayName`**: authenticated users (Studio UI Profile Popover or `POST /v1/me/profile`) can customize their display name (sanitized, max 64 chars, empty resets to `null`) without mutating their stable `@actorId`.

Team member lifecycle & CLI onboarding (works over SSH / headless servers):
```bash
# 1. Admin creates a single-use invite link bound to an actorId (72h default TTL; defaults to --role member)
MERU_MIND_URL=https://mind.example.com MERU_MIND_TOKEN=<admin-token> \
  meru-mind invite create --actor-id alice --kind human --role member

# Optional: invite a co-admin explicitly, or promote/demote an existing actor later
MERU_MIND_URL=https://mind.example.com MERU_MIND_TOKEN=<admin-token> \
  meru-mind invite create --actor-id bob --kind human --role admin
MERU_MIND_URL=https://mind.example.com MERU_MIND_TOKEN=<admin-token> \
  meru-mind actor set-role alice --role admin

# 2. Teammate authenticates terminal via self-issued Device-Code flow (saves 90d token in ~/.config/meru-mind/credentials mode 0600)
meru-mind login --url https://mind.example.com

# 3. Offboarding: immediately disables account, revokes all Bearer tokens, and kills browser sessions
MERU_MIND_URL=https://mind.example.com MERU_MIND_TOKEN=<admin-token> \
  meru-mind actor disable alice --reason "offboarded"
```

### Track 2 (Future Managed Cloud / SaaS Edition): Cloudflare Workers + Durable Objects

**One tenant = One Durable Object = One isolated single-writer SQLite database**:
- **Official DO SQLite limits**: up to **10 GB per DO** (Workers Paid), native synchronous `ctx.storage.sql.exec()`, native **FTS5** (including `fts5vocab` and JSON), and **WebSocket Hibernation** (free idle connections after 10s inactivity, 0 GB-s idle billing).
- **Required adaptations when launching the hosted track**:
  - Store `blobs/` in Cloudflare R2 (async) and optional vectors in Cloudflare Vectorize (`sqlite-vec` native C extension is unavailable in V8 isolates).
  - Adapt visible-realm `IN (...)` predicates past DO's 100-bound-parameter limit (`json_each` / batching).
  - Keep `MindPulse` in an **in-process `Map` + `ws.serializeAttachment()`** (never write high-frequency heartbeats to DO SQLite — preserves hibernation and avoids row-write billing).
  - **Open compliance question to resolve before hosted launch**: verify DO SQLite PRAGMA support (`secure_delete`, `wal_checkpoint`) and how Cloudflare's 30-day Point-in-Time Recovery interacts with `redact` byte-purge guarantees.

---

## Part 2: Composable Frontend Architecture (`v0.4`) — "1.5-Layer Zero-Package Model"

Reviewed & hardened via red-team security critique: instead of shipping separate React npm packages (`@meru-mind/client`, `@meru-mind/ui-atoms`) that cause version drift and lock users into React, Meru Mind stays a **single `@meru-mind/core` package** with a **1.5-layer architecture**:

```
Browser (v0.4: --web-dir custom shell strictly loopback-only; team servers serve official shell)
 ├─ /                  Active UI (--web-dir custom shell OR built-in default shell)
 ├─ /_meru/client.js   Server-hosted zero-dependency ES module client (framework-agnostic, always version-matched)
 ├─ /_meru/shell       Built-in official Default Shell (always reachable as safe fallback)
 └─ /v1/*              REST + Pump WS (wire protocol stays private to server + /_meru/client.js)
        │ Cookie Session = READ + REVERSIBLE VERBS ONLY (inbox triage, pulse focus)
        ▼
   MindSurface Choke Point: redact / mount / org policy / token management require CLI Bearer (Cookie -> 403 + copyable CLI command)
```

### Only 4 True Primitives (Zero Styled Component Lock-In)
1. **Pump** (`pump.status` + `subscribe/getSnapshot` — React, Svelte, Vue, or zero-build `index.html` + ES module all work natively).
2. **Write Actions** (`inbox.triage()` state machine with CAS, idempotency keys, and optimistic rollback).
3. **Safe Renderer** (`<meru-entry>` framework-agnostic Web Component with built-in XSS sanitization, `[REDACTED]` placeholders, and CSS custom properties for full skinning).
4. **Visible Scope Snapshots** (`realms`, untruncated `brief.rules`, server-computed `chain(id)`, and `search()` returning highlight index ranges instead of raw HTML).

### 6 Mandatory Security Guardrails (Preventing Agent-Written UI Privilege Escalation)
1. **Weakened Cookie Sessions**: Browser Cookie sessions only allow reads and reversible actions; irreversible or scope-widening mutations (`redact`, `mount`, `org policy`, `token`) strictly return `403` with a copyable CLI command.
2. **No Browser Login Page**: `meru-mind ui login` issues a 60-second single-use CLI code exchanged for an `HttpOnly; SameSite=Strict` Cookie — long-lived tokens never enter DOM inputs.
3. **Strict Server-Enforced CSP**: `default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
4. **Reserved Prefixes**: `/_meru/*` and `/v1/*` can never be shadowed by files inside `--web-dir`.
5. **No Service Workers**: Requests carrying `Service-Worker: script` return `404` so custom bundles can never hijack the origin after `--web-dir` is removed.
6. **Loopback-Only `--web-dir` in `v0.4`**: Binding `--web-dir` on a non-loopback address fails fast at startup.

### Agent Custom UI Workflow
- `meru-mind serve --demo` boots a seeded sandbox containing rule-tail sentinels, stored-XSS test records, and unknown record kinds so any coding agent builds against real edge cases.
- `meru-mind ui eject ./my-ui` copies the built-in official shell source (which imports only `/_meru/client.js`), paired with `UI_BUILDER_SKILL.md` so the user's Agent can craft a bespoke zero-build or framework shell without breaking upgrades.
