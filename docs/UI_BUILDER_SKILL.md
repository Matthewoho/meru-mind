# Meru Mind Custom UI Builder Skill (`v0.4`)

Use this skill when crafting a bespoke local governance UI for a user's Meru Mind instance using `--web-dir`.

## Quick Start (Zero-Build or Any Framework)

1. Start a live sandbox seeded with edge cases (12 rules + rule-tail sentinel, stored XSS probe, redacted tombstone, unknown `extKind`, supersede chain, `/inbox` triage queue):
   ```bash
   meru-mind serve --demo --host 127.0.0.1 --port 3800
   ```
2. Optional — eject the built-in official shell as a working starting point:
   ```bash
   meru-mind ui eject ./my-ui
   meru-mind serve --demo --host 127.0.0.1 --port 3800 --web-dir ./my-ui
   ```
3. Open the 60-second single-use login URL printed by `meru-mind ui login` (or `--demo`). The built-in fallback shell is always reachable at `/_meru/shell`.

## Contract: Import ONLY `/_meru/client.js`

Do **not** call `/v1/*` wire endpoints directly or re-implement WebSocket reconnect/fallback logic. Always import the server-hosted, zero-dependency, version-locked ES module:

```js
import {
  createMindClient,
  applyHighlightRanges,
} from "/_meru/client.js";
```

### The 4 Primitives
1. **Pump (`client.pump`)**: `start(initialSeq)`, `stop()`, `getSnapshot()`, `subscribe(fn)` (works directly with React `useSyncExternalStore`, Svelte stores, Vue refs, or vanilla DOM). Automatically handles `WS /v1/ws` -> `GET /v1/changes?wait=25` Long-Poll fallback with the exact same `(generation, cursor)`.
2. **Inbox Triage (`client.inbox.triage(entryId, targetRealmRef, opts)`)**: Enforces CAS (`expectedFromRealmRef`) and idempotency keys.
3. **Safe Renderer (`<meru-entry>`)**: Framework-agnostic Web Component that safely renders entries via `textContent` inside Shadow DOM, displays `[REDACTED]` placeholders, handles unknown record kinds cleanly, and exposes CSS custom properties (`--meru-surface`, `--meru-fg`, `--meru-fg-secondary`, `--meru-fg-muted`, `--meru-border`, `--meru-accent`, `--meru-radius`, `--meru-font`, `--meru-mono`).
4. **Visible Scope Snapshots**: `whoami()`, `tree()`, `brief(realmPath)`, `ls()`, `show(ref)`, `chain(entryId)`, `search(q)` (returns safe `[start, end]` `highlights` index ranges — render via `applyHighlightRanges()`, never raw HTML!), `pulse.list()`, `pulse.setFocus(focus, note)`.

## Non-Negotiable UI & Security Invariants

1. **Never truncate rules**: Render every item in `brief.middleMind.rules.items` (verify `RULE-TAIL-SENTINEL` is visible in `--demo`).
2. **Never use `innerHTML` on record titles/bodies**: Use `<meru-entry>` or `textContent` / `applyHighlightRanges()` (verify `window.__xss === undefined` on `--demo`).
3. **Respect strict CSP**: No inline `<script>` tags and no remote CDN scripts (`script-src 'self'`).
4. **No browser token inputs**: Authentication happens exclusively via `meru-mind ui login` (60s single-use code -> `HttpOnly; SameSite=Strict` Cookie).
5. **Respect weakened Cookie sessions**: Browser Cookie sessions only allow reads and reversible actions (`inbox.triage`, `write`, `pulse.setFocus`). Irreversible or scope-widening actions (`redact`, `rule add`, `mount`, `org set-policy`, `token`) return `403` with `err.cliCommand` — display that copyable CLI command instead of pretending the browser can execute it.
6. **Reserved prefixes & no Service Workers**: Never place files shadowing `/_meru/*`, `/v1/*`, or `/mcp`, and never register a Service Worker (`Service-Worker: script` returns `404`).
