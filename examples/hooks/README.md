# Opt-In Harness Hooks for Meru Mind (`MindPulse v2`)

These tiny shell hooks solve three team problems at once without adding CLI verbs or MCP tools:

1. **Zero-Friction Rule Injection**: `session-start.sh` reads `.meru-mind-realm` and prints `meru-mind show <realm>` (inherited binding rules, active decisions, and `activePeers`) into turn-0 context automatically.
2. **Multi-Session Identity Without Collisions**: All three scripts read the native `session_id` and `cwd` passed on stdin JSON by harnesses like Claude Code, so opening 3–5 concurrent sessions in the same repository keeps 3–5 distinct MindPulse entries that never overwrite each other.
3. **Automatic Workspace Context (Zero Manual Note-Typing)**: `session-start.sh` and `heartbeat.sh` automatically publish `repo@branch` (and safe edited file basename only on `PostToolUse` — never file contents or full paths) to `POST /v1/pulse` at most once per 60s per session (zero SQLite writes), and `session-end.sh` signs off that exact session via `DELETE /v1/pulse`.

> Note: Even with **zero hooks installed**, any agent calling `meru-mind` CLI or `/mcp` is automatically observed server-side via `withLivePulse`: `show <object>`, `show <entry>` (public/internal only), `search --in <realm>`, and `write` populate safe server-observed `activity` in `GET /v1/pulse` and `show <realm>` `activePeers` for 15 minutes.

## Claude Code Example (`.claude/settings.local.json`)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MERU_MIND_CLIENT=claude-code /path/to/meru-mind/examples/hooks/session-start.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MERU_MIND_CLIENT=claude-code /path/to/meru-mind/examples/hooks/heartbeat.sh"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/meru-mind/examples/hooks/session-end.sh"
          }
        ]
      }
    ]
  }
}
```

Set `MERU_MIND_URL` and `MERU_MIND_TOKEN` in your shell environment. For standalone CLI or MCP clients without hooks, pass `MERU_MIND_SESSION_ID` / `X-Meru-Session-Id` (or `Mcp-Session-Id`) and `MERU_MIND_CLIENT` / `X-Meru-Client` to separate concurrent sessions.
