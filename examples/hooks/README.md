# Opt-In Harness Hooks for Meru Mind (`MindPulse v3`)

These lightweight shell hooks turn MindPulse from passive pull-only status into a **zero-noise push radar** without adding MCP tools, CLI verbs, or SQLite task tables:

1. **Zero-Friction Rule Injection (`session-start.sh`)**: Reads `.meru-mind-realm`, registers `repo@branch` keys, resolves any recorded parent session from `parent-map.json`, and emits `meru-mind show <realm>` (inherited rules, active decisions, and `activePeers`) straight into turn-0 context.
2. **Pre-Flight Overlap Push (`prompt-check.sh` · `UserPromptSubmit`)**: Runs BEFORE the agent makes its first tool call on every prompt. Extracts deterministic keys from the prompt + git branch (`ENG-42`, GitHub PR URLs, `service:*`, `alert:*`, non-default branch), performs a single `POST /v1/pulse` handshake, and stays silent unless new overlapping peers exist (wrapped in an untrusted-data `<mindpulse-radar>` frame).
3. **Subagent / Swarm Parent Auto-Linking (`subagent-link.sh` · `PostToolUse` / `SubagentStart`)**: Captures spawned subagent or `/swarm` worker conversation/session IDs and atomically records `child -> parent` in `~/.cache/meru-mind/parent-map.json` (mode `0600`, 24h TTL, cap 500). Child sessions then automatically send `X-Meru-Parent-Session-Id` from both hooks and `meru-mind` CLI/SDK calls (`RemoteMindSurface`), grouping the whole tree as collaborators with zero false self-collisions.
4. **Automatic `working` Promotion & Mid-Flight Delta Alert (`heartbeat.sh` · `PostToolUse`)**: Automatically promotes the session to `mode: "working"` when edit/write/shell tools fire (never relying on the model to self-register), attaches `file:<basename>`, throttles to 60s (zero SQLite writes), and emits a 1-line delta warning ONLY if a new overlapping peer appears mid-flight.
5. **Overnight Retention (`turn-stop.sh` · `Stop`)**: Marks paused turns as `turn_ended` (24-hour retention + clean shutdown snapshot) instead of expiring after 45 minutes.
6. **Clean Sign-Off (`session-end.sh` · `SessionEnd`)**: Calls `DELETE /v1/pulse` and cleans up local temporary stamp/delta files.

> **Multi-Harness & Stdout Contract (`v0.6.2`)**: All hooks parse BOTH **camelCase** (`conversationId`, `parentConversationId`, `workspacePaths[0]`, `toolName`, `toolInput`) and **snake_case** (`session_id`, `parent_session_id`, `cwd`, `tool_name`, `tool_input`) stdin JSON, falling back to native env vars (`MERU_MIND_SESSION_ID`, `ANTIGRAVITY_CONVERSATION_ID`, `CLAUDE_SESSION_ID`, `CODEX_THREAD_ID`, `OPENCODE_SESSION_ID`).
> - When Antigravity camelCase `conversationId` is detected, hooks emit strictly valid JSON on stdout (`{}` when quiet or `{"injectSteps":[...]}` when injecting context/alerts).
> - For Claude Code / Codex snake_case payloads, hooks print plain text (and `0` bytes when quiet). `subagent-link.sh` always prints `{}`.

## Antigravity Configuration (Drop-In `agy-hooks.json`, `/swarm` & Subagents)

Copy [`examples/hooks/agy-hooks.json`](./agy-hooks.json) into your Antigravity hooks configuration and replace `/path/to/meru-mind` with your local checkout path:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/meru-mind/examples/hooks/session-start.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "invoke_subagent|swarm",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/meru-mind/examples/hooks/subagent-link.sh"
          }
        ]
      },
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/meru-mind/examples/hooks/heartbeat.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/meru-mind/examples/hooks/turn-stop.sh"
          }
        ]
      }
    ]
  }
}
```

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
        "matcher": "Agent|Task",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/meru-mind/examples/hooks/subagent-link.sh"
          }
        ]
      },
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

## Codex / OpenCode & Direct CLI Session Propagation

When running inside Codex (`CODEX_THREAD_ID`, optional `CODEX_PARENT_THREAD_ID`), OpenCode (`OPENCODE_SESSION_ID`), Claude Code (`CLAUDE_SESSION_ID`), or Antigravity (`ANTIGRAVITY_CONVERSATION_ID`), `meru-mind` CLI and `RemoteMindSurface` automatically resolve `X-Meru-Session-Id`, `X-Meru-Parent-Session-Id` (including `~/.cache/meru-mind/parent-map.json`), and `X-Meru-Client` with zero extra flags.

## Pre-Dispatch Check for External Orchestrators (Alert Bots / Dispatchers)

Before dispatching a signal batch for `ENG-42` or `alert:4044` / `service:billing`, run a `<10ms` read-only pre-flight check:

```bash
curl -fsS -H "Authorization: Bearer ${MERU_MIND_TOKEN}" \
  "${MERU_MIND_URL%/}/v1/pulse?match=ENG-42,service:billing&mode=working"
```

Inspect `.overlaps` (and `.unkeyedPeers`): if another session is already working on the same target key, prepend a concise untrusted-data overlap header into the dispatched signal or route directly via `.overlaps[].sessionTag`.
