# Meru Mind Built-In Studio UI

As of `v0.5.7`, the Studio UI has been promoted to be Meru Mind's **single official built-in Web UI**, served directly at `/` and `/_meru/shell` on both local and team deployments without requiring `--web-dir`.

- Canonical source lives in `src/ui/shell/` (bundled at build time into `src/server/ui-shell.generated.ts`).
- To customize a local UI via loopback-only `--web-dir`, eject a working copy of the built-in official shell:

```bash
meru-mind ui eject ./my-ui
meru-mind serve --demo --host 127.0.0.1 --port 3800 --web-dir ./my-ui
```

See [docs/UI_BUILDER_SKILL.md](../../docs/UI_BUILDER_SKILL.md) for the `/_meru/client.js` contract and security guardrails.
