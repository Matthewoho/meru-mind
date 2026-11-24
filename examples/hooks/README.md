# Opt-In Harness Hooks for Meru Mind (`MindPulse v2`)

These tiny zero-dependency shell hooks solve two team problems at once without adding CLI verbs or MCP tools:

1. **Zero-Friction Rule Injection**: `session-start.sh` reads `.meru-mind-realm` and prints `meru-mind show <realm>` (inherited binding rules, active decisions, and `activePeers`) into turn-0 context automatically.
2. **Accurate Live Agent Presence**: `heartbeat.sh` refreshes `POST /v1/pulse` at most once per 60 seconds (zero SQLite writes), and `session-end.sh` signs off cleanly via `DELETE /v1/pulse`.

> Note: Even with **zero hooks installed**, any agent calling `meru-mind` CLI or `/mcp` is automatically observed server-side via `withLivePulse` and appears in `GET /v1/pulse` and `show <realm>` `activePeers` for 15 minutes.

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

Set `MERU_MIND_URL` and `MERU_MIND_TOKEN` in your shell environment. To run multiple concurrent agent sessions with the same token without colliding, set a distinct `MERU_MIND_SESSION_ID` per terminal or worktree (or pass `X-Meru-Session-Id` / `X-Meru-Client` headers in your MCP client config).
