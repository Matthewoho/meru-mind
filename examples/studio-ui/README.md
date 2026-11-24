# Meru Mind Studio UI Example (`--web-dir`)

An optional zero-build Framed Sheet showcase UI built strictly on top of Meru Mind's server-hosted `/_meru/client.js` contract (`createMindClient`, `<meru-entry>`, `<meru-markdown>`, and `loadMarkdownTools`).

- **Loopback-only by design (Guardrail #6)**: `--web-dir` is strictly restricted to loopback (`127.0.0.1` / `localhost` / `::1`). Team deployments always serve the built-in official shell (`/_meru/shell`).
- **Strict CSP & Zero `innerHTML`**: Uses DOM construction + `<meru-markdown>` + sandboxed click-to-render static HTML preview.
- **Bilingual & Theme-Aware**: Includes the Meru Mind Obsidian × Deep Sea Blue sub-logo (`12-F1`), Light/Dark Liquid Glass themes, and `English / 简体中文` switching in Settings.

## Run Locally Against Demo Data

```bash
meru-mind serve --demo --host 127.0.0.1 --port 3800 --web-dir ./examples/studio-ui
```

Open the printed 60-second single-use `Demo 60s Login URL` in your browser.
