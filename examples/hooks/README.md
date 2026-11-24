# Opt-In Harness Hooks for Meru Mind (`MindPulse v3`)

These lightweight shell hooks turn MindPulse from passive pull-only status into a **zero-noise push radar** without adding MCP tools, CLI verbs, or SQLite task tables:

1. **Zero-Friction Rule Injection (`session-start.sh`)**: Reads `.meru-mind-realm`, registers `repo@branch` keys, and prints `meru-mind show <realm>` (inherited rules, active decisions, and `activePeers`) straight into turn-0 context.
2. **Pre-Flight Overlap Push (`prompt-check.sh` · `UserPromptSubmit`)**: Runs BEFORE the agent makes its first tool call on every prompt. Extracts deterministic keys from the prompt + git branch (`ENG-42`, GitHub PR URLs, `service:*`, `alert:*`, non-default branch), performs a single `POST /v1/pulse` handshake, and stays **100% silent (0 stdout bytes)** unless new overlapping peers exist (wrapped in an untrusted-data `<mindpulse-radar>` frame).
3. **Automatic `working` Promotion & Mid-Flight Delta Alert (`heartbeat.sh` · `PostToolUse`)**: Automatically promotes the session to `mode: "working"` when edit/write/shell tools fire (never relying on the model to self-register), attaches `file:<basename>`, throttles to 60s (zero SQLite writes), and prints a 1-line delta warning ONLY if a new overlapping peer appears mid-flight.
4. **Overnight Retention (`turn-stop.sh` · `Stop`)**: Marks paused turns as `turn_ended` (24-hour retention + clean shutdown snapshot) instead of expiring after 45 minutes.
5. **Clean Sign-Off (`session-end.sh` · `SessionEnd`)**: Calls `DELETE /v1/pulse` and cleans up local temporary stamp/delta files.

> **Multi-Session & Sub-Sessions**: All hooks read native harness stdin JSON (`session_id`, `cwd`, optional `parent_session_id`), so running 3–5 concurrent sessions in the same repo keeps separate MindPulse identities. Sub-sessions sharing the same `MERU_MIND_PARENT_SESSION_ID` under the same principal are grouped as collaborators and never trigger false self-collisions.

## Claude Code Configuration (`.claude/settings.local.json`)

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
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MERU_MIND_CLIENT=claude-code /path/to/meru-mind/examples/hooks/prompt-check.sh"
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
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MERU_MIND_CLIENT=claude-code /path/to/meru-mind/examples/hooks/turn-stop.sh"
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

## Pre-Dispatch Check for External Orchestrators (Alert Bots / Dispatchers)

Before dispatching a signal batch for `ENG-42` or `alert:4044` / `service:billing`, run a `<10ms` read-only pre-flight check:

```bash
curl -fsS -H "Authorization: Bearer ${MERU_MIND_TOKEN}" \
  "${MERU_MIND_URL%/}/v1/pulse?match=ENG-42,service:billing&mode=working"
```

Inspect `.overlaps` (and `.unkeyedPeers`): if another session is already working on the same target key, prepend a concise untrusted-data overlap header into the dispatched signal or route directly via `.overlaps[].sessionTag`.
