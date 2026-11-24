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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function mcpPost(
  baseUrl: string,
  token: string,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
}

describe("v0.5.8 Center Full Reader, URL SSOT SPA Fallback, Paginated Presence & Stateless Mcp-Session-Id", () => {
  it("1. SPA fallback serves built-in shell for deep-link realm/entry URLs without shadowing /_meru/*, /v1/*, /mcp, or static assets", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v058-spa-"),
      host: "127.0.0.1",
      port: 0,
      demo: true,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const deepLink = await fetch(
      `${srv.url}/projects/meru?entry=rec_abc123&view=raw`,
    );
    expect(deepLink.status).toBe(200);
    expect(deepLink.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);
    expect(await deepLink.text()).toBe(DEFAULT_SHELL_HTML);

    // Reserved prefixes & missing static assets MUST NOT be shadowed by SPA fallback
    const badMeru = await fetch(`${srv.url}/_meru/does-not-exist`);
    expect(badMeru.status).toBe(404);

    const missingAsset = await fetch(`${srv.url}/nonexistent.js`);
    expect(missingAsset.status).toBe(404);

    const mcpGet = await fetch(`${srv.url}/mcp`, { method: "GET" });
    expect(mcpGet.status).toBe(405);
    expect(mcpGet.headers.get("allow")).toBe("POST");

    const mcpDel = await fetch(`${srv.url}/mcp`, { method: "DELETE" });
    expect(mcpDel.status).toBe(405);
    expect(mcpDel.headers.get("allow")).toBe("POST");
  });

  it("2. Stateless HTTP Mcp-Session-Id emits unique random UUIDs on initialize, separates MindPulse sessions, never 404s unknown IDs, preserves x-meru-session-id priority, and supports opt-out", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v058-mcp-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const tok = srv.createToken({ actorId: "alice", actorKind: "human" });
    const initPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    };

    // Two distinct MCP connections sharing one token get two distinct random UUIDs
    const initA = await mcpPost(srv.url, tok.token, initPayload, {
      "x-meru-client": "claude-code",
    });
    expect(initA.status).toBe(200);
    const sidA = initA.headers.get("mcp-session-id") ?? "";
    expect(sidA).toMatch(UUID_RE);

    const initB = await mcpPost(srv.url, tok.token, initPayload, {
      "x-meru-client": "codex",
    });
    expect(initB.status).toBe(200);
    const sidB = initB.headers.get("mcp-session-id") ?? "";
    expect(sidB).toMatch(UUID_RE);
    expect(sidB).not.toBe(sidA);

    // Subsequent calls echoing distinct Mcp-Session-Id register TWO independent MindPulse sessions
    const callPayload = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "mind_ls", arguments: { ref: "/" } },
    };
    const callA = await mcpPost(srv.url, tok.token, callPayload, {
      "Mcp-Session-Id": sidA,
      "x-meru-client": "claude-code",
    });
    expect(callA.status).toBe(200);
    // Non-initialize request does not overwrite/re-issue a new header
    expect(callA.headers.get("mcp-session-id")).toBeNull();

    const callB = await mcpPost(srv.url, tok.token, callPayload, {
      "Mcp-Session-Id": sidB,
      "x-meru-client": "codex",
    });
    expect(callB.status).toBe(200);

    // Unknown Mcp-Session-Id (e.g. after server restart) MUST NEVER 404!
    const callRestarted = await mcpPost(srv.url, tok.token, callPayload, {
      "Mcp-Session-Id": "00000000-0000-4000-8000-000000009999",
      "x-meru-client": "cursor",
    });
    expect(callRestarted.status).toBe(200);

    // Explicit x-meru-session-id takes priority over Mcp-Session-Id
    const callPriority = await mcpPost(srv.url, tok.token, callPayload, {
      "Mcp-Session-Id": sidA,
      "x-meru-session-id": "explicit-priority-session",
      "x-meru-client": "custom-host",
    });
    expect(callPriority.status).toBe(200);

    const pulseResp = await fetch(`${srv.url}/v1/pulse`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    expect(pulseResp.status).toBe(200);
    const pulseJson = (await pulseResp.json()) as {
      pulses: Array<{ sessionId: string; sessionTag: string | null; clientHint: string | null }>;
    };
    const tags = new Set(pulseJson.pulses.map((p) => p.sessionTag));
    expect(tags.has(sidA)).toBe(true);
    expect(tags.has(sidB)).toBe(true);
    expect(tags.has("00000000-0000-4000-8000-000000009999")).toBe(true);
    expect(tags.has("explicit-priority-session")).toBe(true);
    expect(pulseJson.pulses.length).toBeGreaterThanOrEqual(4);

    // Opt-out via mcpSessionHeader: false omits the Mcp-Session-Id header
    const srvOptOut = await startMindServer({
      homeDir: makeTempDir("meru-v058-mcp-optout-"),
      host: "127.0.0.1",
      port: 0,
      mcpSessionHeader: false,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srvOptOut);
    const tok2 = srvOptOut.createToken({ actorId: "bob", actorKind: "human" });
    const initOptOut = await mcpPost(srvOptOut.url, tok2.token, initPayload);
    expect(initOptOut.status).toBe(200);
    expect(initOptOut.headers.get("mcp-session-id")).toBeNull();
  });

  it("3. Unified v0.5.8 shell assets stay in sync, valid JS, zero innerHTML, and include Reader + Rail + URL SSOT + Paginated Presence", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve("scripts/generate-ui-assets.mjs"),
      "--check",
    ]);
    expect(stdout).toContain("in sync");

    expect(() => new vm.Script(DEFAULT_SHELL_JS.replace(/^import\s+.*$/gm, ""))).not.toThrow();
    expect(DEFAULT_SHELL_JS).toContain("center-doc-reader");
    expect(DEFAULT_SHELL_JS).toContain("properties-rail");
    expect(DEFAULT_SHELL_JS).toContain("presence-pane");
    expect(DEFAULT_SHELL_JS).toContain("presence-load-more");
    expect(DEFAULT_SHELL_JS).toContain("meru-icon-switch-thumb");
    expect(DEFAULT_SHELL_CSS).toContain(".meru-icon-switch-thumb");
    expect(DEFAULT_SHELL_CSS).not.toContain(".studio-seg");
    expect(DEFAULT_SHELL_JS).toContain("popstate");
    expect(DEFAULT_SHELL_JS).toContain("pushState");
    expect(DEFAULT_SHELL_JS).not.toMatch(/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML\s*\(|document\.write\s*\(/);
    expect(DEFAULT_SHELL_JS).not.toContain("领域目录");

    // Prevent unstyled orphaned host classes from markdown-renderer.ts (light/dark contrast regression)
    for (const hostCls of [
      ".html-preview-banner",
      ".small-btn",
      ".html-source-pre",
      ".meru-html-sandbox-frame",
    ]) {
      expect(DEFAULT_SHELL_CSS).toContain(hostCls);
    }
  });
});
