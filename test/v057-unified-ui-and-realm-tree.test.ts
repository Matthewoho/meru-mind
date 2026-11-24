import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SHELL_CSS,
  DEFAULT_SHELL_HTML,
  DEFAULT_SHELL_JS,
  ejectDefaultUiShell,
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

describe("v0.5.7 Unified Official Built-In Studio UI, 识界 Rename & Collapsible Realm Tree", () => {
  it("1. Generated UI shell bundle stays byte-for-byte synchronized with src/ui/shell/*", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve("scripts/generate-ui-assets.mjs"),
      "--check",
    ]);
    expect(stdout).toContain("in sync");

    expect(DEFAULT_SHELL_HTML).toBe(
      fs.readFileSync(path.resolve("src/ui/shell/index.html"), "utf8"),
    );
    expect(DEFAULT_SHELL_CSS).toBe(
      fs.readFileSync(path.resolve("src/ui/shell/styles.css"), "utf8"),
    );
    expect(DEFAULT_SHELL_JS).toBe(
      fs.readFileSync(path.resolve("src/ui/shell/app.js"), "utf8"),
    );
  });

  it("2. Serves the unified Studio UI directly at / and /_meru/shell with strict CSP and zero legacy parallel shell", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v057-builtin-"),
      host: "127.0.0.1",
      port: 0,
      demo: true,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const rootResp = await fetch(`${srv.url}/`);
    expect(rootResp.status).toBe(200);
    expect(rootResp.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);
    const rootHtml = await rootResp.text();
    expect(rootHtml).toBe(DEFAULT_SHELL_HTML);
    expect(rootHtml).toContain("/_meru/shell.css");
    expect(rootHtml).toContain("/_meru/shell.js");
    // Strict CSP: zero inline scripts and zero inline event attributes
    expect(rootHtml).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(rootHtml).not.toMatch(/\son[a-z]+\s*=/i);

    const shellResp = await fetch(`${srv.url}/_meru/shell`);
    expect(shellResp.status).toBe(200);
    expect(await shellResp.text()).toBe(DEFAULT_SHELL_HTML);

    const cssResp = await fetch(`${srv.url}/_meru/shell.css`);
    expect(cssResp.status).toBe(200);
    expect(cssResp.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);
    const cssText = await cssResp.text();
    expect(cssText).toContain(".studio-shell");
    expect(cssText).toContain(".realm-chevron-btn");
    expect(cssText).toContain("--meru-live-dot");

    const jsResp = await fetch(`${srv.url}/_meru/shell.js`);
    expect(jsResp.status).toBe(200);
    expect(jsResp.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);
    const jsText = await jsResp.text();
    expect(jsText).toContain("studio-sidebar");
    expect(jsText).toContain("meru-studio-collapsed-realms:");
    expect(jsText).toContain('data-ui = "realm-chevron"'.replace('data-ui = ', 'dataset.ui = '));
    expect(jsText).toContain('dataset.inherited = "true"');
    expect(() => new vm.Script(jsText.replace(/^import\s+.*$/gm, ""))).not.toThrow();

    // Eject writes the unified Studio shell cleanly
    const ejectDir = makeTempDir("meru-v057-eject-");
    const ejected = ejectDefaultUiShell(ejectDir);
    expect(ejected).toHaveLength(3);
    const ejectedHtml = fs.readFileSync(path.join(ejectDir, "index.html"), "utf8");
    expect(ejectedHtml).toContain("./shell.css");
    expect(ejectedHtml).toContain("./shell.js");
    expect(fs.readFileSync(path.join(ejectDir, "shell.js"), "utf8")).toBe(
      DEFAULT_SHELL_JS,
    );
  });

  it("3. Renames 领域目录 to 识界 everywhere across source and docs (zero remaining occurrences)", () => {
    const rootsToScan = ["src", "docs", "examples", "scripts"];
    const offending: string[] = [];

    function walk(dir: string) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const text = fs.readFileSync(full, "utf8");
          if (text.includes("领域目录")) {
            offending.push(path.relative(process.cwd(), full));
          }
        }
      }
    }

    for (const r of rootsToScan) walk(path.resolve(r));
    expect(offending).toEqual([]);
    expect(DEFAULT_SHELL_JS).toContain('realms: "识界"');
    expect(DEFAULT_SHELL_JS).not.toContain("领域目录");
  });

  it("4. Keeps --web-dir strictly loopback-only on non-loopback hosts", async () => {
    const customDir = makeTempDir("meru-v057-webdir-");
    fs.writeFileSync(path.join(customDir, "index.html"), "<html></html>", "utf8");
    await expect(
      startMindServer({
        homeDir: makeTempDir("meru-v057-nonloop-"),
        host: "0.0.0.0",
        port: 0,
        webDir: customDir,
        enableVector: false,
        accessLog: false,
      }),
    ).rejects.toThrow(/loopback-only/i);
  });
});
