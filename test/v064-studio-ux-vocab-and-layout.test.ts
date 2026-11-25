import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_JS_SOURCE,
  DEFAULT_SHELL_CSS,
  DEFAULT_SHELL_HTML,
  DEFAULT_SHELL_JS,
  startMindServer,
  STRICT_UI_CSP,
  type MindServerHandle,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];
const openServers: MindServerHandle[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v0.6.4 Studio UI UX Redesign: Unified Vocabulary, Direct Content First, Linear Composer & Auto-Collapsed Inspector", () => {
  it("1. Removes internal jargon, redundant 4-cell KPI strip, and native <select> elements across JS & CSS", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve("scripts/generate-ui-assets.mjs"),
      "--check",
    ]);
    expect(stdout).toContain("in sync");

    // Valid JS + zero raw HTML injection sinks
    expect(() => new vm.Script(DEFAULT_SHELL_JS.replace(/^import\s+.*$/gm, ""))).not.toThrow();
    expect(DEFAULT_SHELL_JS).not.toMatch(/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML\s*\(|document\.write\s*\(/);

    // Zero internal engine jargon or legacy terminology in Studio shell
    for (const forbidden of [
      "Active Conclusions",
      "Tracked Objects",
      "Binding Rules",
      "Always untruncated",
      "Write to Ledger",
      "Secret Guard scans writes automatically",
      "Policy: tree",
      "Inbox Triage",
      "Recent Conclusions",
      "Ledger Entries",
      "Subtree Conclusions",
      "ledger-strip",
      "领域目录",
    ]) {
      expect(DEFAULT_SHELL_JS).not.toContain(forbidden);
      expect(DEFAULT_SHELL_CSS).not.toContain(forbidden);
    }

    // Zero native OS <select> elements in Studio shell
    expect(DEFAULT_SHELL_JS).not.toMatch(/createElement\s*\(\s*["']select["']\s*\)/);

    // Zero colorful UI emojis in Studio shell
    expect(DEFAULT_SHELL_JS).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("2. Uses single-source-of-truth EN + ZH-CN VOCAB, certainty-family icons, and clean 3-tab + conditional Inbox navigation", () => {
    // Approved Chinese + English vocabulary
    expect(DEFAULT_SHELL_JS).toContain('realms: "识界"');
    expect(DEFAULT_SHELL_JS).toContain('tabEntries: "记录"');
    expect(DEFAULT_SHELL_JS).toContain('tabObjects: "对象"');
    expect(DEFAULT_SHELL_JS).toContain('tabRules: "规矩"');
    expect(DEFAULT_SHELL_JS).toContain('tabInbox: "待分拣"');
    expect(DEFAULT_SHELL_JS).toContain('kindFinding: "发现"');
    expect(DEFAULT_SHELL_JS).toContain('kindDecision: "决定"');
    expect(DEFAULT_SHELL_JS).toContain('kindProposal: "提议"');
    expect(DEFAULT_SHELL_JS).toContain('kindClaim: "主张"');
    expect(DEFAULT_SHELL_JS).toContain('kindVerdict: "裁决"');
    expect(DEFAULT_SHELL_JS).toContain('supersedeChain: "演进历史"');
    expect(DEFAULT_SHELL_JS).toContain('statusSuperseded: "已被取代"');

    // English equivalents present
    expect(DEFAULT_SHELL_JS).toContain('tabEntries: "Entries"');
    expect(DEFAULT_SHELL_JS).toContain('tabObjects: "Objects"');
    expect(DEFAULT_SHELL_JS).toContain('tabRules: "Rules"');
    expect(DEFAULT_SHELL_JS).toContain('tabInbox: "Inbox"');

    // Default tab is "entries", and legacy URL tabs (?tab=overview / ?tab=conclusions) alias cleanly to "entries"
    expect(DEFAULT_SHELL_JS).toContain('activeTab: "entries"');
    expect(DEFAULT_SHELL_JS).toMatch(/rawTab === "overview"\s*\|\|\s*rawTab === "conclusions"\s*\|\|\s*rawTab === "entries"/);

    // Whisper-quiet collapsible rules banner above entries list
    expect(DEFAULT_SHELL_JS).toContain("rules-whisper-banner");
    expect(DEFAULT_SHELL_CSS).toContain(".rules-whisper-banner");

    // Teaching empty states including human-only CLI rule command
    expect(DEFAULT_SHELL_JS).toContain("empty-entries");
    expect(DEFAULT_SHELL_JS).toContain("empty-objects");
    expect(DEFAULT_SHELL_JS).toContain("empty-rules");
    expect(DEFAULT_SHELL_JS).toContain("meru-mind rule add --in ");
    expect(DEFAULT_SHELL_JS).toContain("--as-human");
  });

  it("3. Implements Linear-style Composer (certainty-circle kind switcher, draft persistence, Secret Guard alert, Cmd+Enter, C/N) and auto-collapsed Inspector", () => {
    // Composer certainty-family segmented switcher + dynamic kind placeholders
    expect(DEFAULT_SHELL_JS).toContain("composer-kind-switcher");
    expect(DEFAULT_SHELL_JS).toContain('role", "radiogroup"');
    expect(DEFAULT_SHELL_JS).toContain("aria-pressed");
    expect(DEFAULT_SHELL_JS).toContain("写下你知道的一件事…");
    expect(DEFAULT_SHELL_JS).toContain("定了什么？");
    expect(DEFAULT_SHELL_JS).toContain("你想提议什么？");
    expect(DEFAULT_SHELL_JS).toContain("What did you find or confirm?");
    expect(DEFAULT_SHELL_JS).toContain("What was decided?");
    expect(DEFAULT_SHELL_JS).toContain("What are you proposing?");
    expect(DEFAULT_SHELL_JS).toContain("composer-secret-warning");
    expect(DEFAULT_SHELL_JS).toContain("parseSecretGuardError");
    expect(DEFAULT_SHELL_JS).toMatch(/lowKey === "c"\s*\|\|\s*lowKey === "n"/);

    // Clean Studio list rows (zero raw rec_xxx in main list, Copy ID strictly in Right Inspector)
    expect(DEFAULT_SHELL_JS).toContain("studio-entry-row");
    expect(DEFAULT_SHELL_JS).toContain("inspector-copy-id");
    expect(DEFAULT_SHELL_JS).toContain("formatRelativeTime");
    expect(DEFAULT_SHELL_CSS).toContain(".studio-entry-row");
    expect(DEFAULT_SHELL_CSS).toContain(".kind-switcher");

    // Right inspector defaults to collapsed (clean 2-pane layout when nothing selected)
    expect(DEFAULT_SHELL_JS).toMatch(/inspectorOpen:\s*false\b/);
    expect(DEFAULT_SHELL_JS).toContain("focusedObjectRef: null");
    expect(DEFAULT_SHELL_JS).toContain("inspector-toggle");

    // <meru-entry> Web Component remains exported & XSS-safe in /_meru/client.js for custom Agent UIs
    expect(CLIENT_JS_SOURCE).toContain("MeruEntryElement");
    expect(CLIENT_JS_SOURCE).toContain('customElements.define("meru-entry", MeruEntryElement)');
  });

  it("4. Serves the redesigned Studio UI over HTTP with strict CSP and compatible demo payload", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v064-studio-"),
      host: "127.0.0.1",
      port: 0,
      demo: true,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const [htmlRes, cssRes, jsRes, clientRes] = await Promise.all([
      fetch(`${srv.url}/`),
      fetch(`${srv.url}/_meru/shell.css`),
      fetch(`${srv.url}/_meru/shell.js`),
      fetch(`${srv.url}/_meru/client.js`),
    ]);

    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);
    expect(await htmlRes.text()).toBe(DEFAULT_SHELL_HTML);

    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);
    const cssText = await cssRes.text();
    expect(cssText).toBe(DEFAULT_SHELL_CSS);
    expect(cssText).not.toContain(".ledger-strip");

    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);
    const jsText = await jsRes.text();
    expect(jsText).toBe(DEFAULT_SHELL_JS);
    expect(jsText).toContain("composer-kind-switcher");

    expect(clientRes.status).toBe(200);
    expect(await clientRes.text()).toContain("meru-entry");
  });
});
