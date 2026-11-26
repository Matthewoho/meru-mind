import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMermaidFrameCsp,
  DEFAULT_SHELL_CSS,
  DEFAULT_SHELL_HTML,
  DEFAULT_SHELL_JS,
  MARKDOWN_JS_SOURCE,
  MERMAID_FRAME_HTML_SOURCE,
  MERMAID_FRAME_JS_SOURCE,
  MERU_MIND_VERSION,
  startMindServer,
  STRICT_UI_CSP,
  type MindServerHandle,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const PINNED_MARKED_SHA256 =
  "4d2d824f3035e79b6887380d88c6c9ca0958215d1f4f6c053c562d60babc7172";
const PINNED_MERMAID_SHA256 =
  "581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8";

const tempDirs: string[] = [];
const openServers: MindServerHandle[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function rawHttpGet(
  urlStr: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
  });
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v0.6.6 Sandboxed Offline Mermaid, Scroll Preservation, Load More & Presence Popover UX", () => {
  it("1. Serves vendored mermaid@11.17.2, mermaid-frame.js, and sandboxed mermaid-frame.html with strict CSP and zero auth/CORP barriers", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v066-mermaid-http-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    // 1. /_meru/vendor/mermaid.min.js (publicly cached, nosniff, no CORP, SHA-256 verified)
    const vendorRes = await fetch(`${srv.url}/_meru/vendor/mermaid.min.js`);
    expect(vendorRes.status).toBe(200);
    expect(vendorRes.headers.get("content-type")).toBe(
      "application/javascript; charset=utf-8",
    );
    expect(vendorRes.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(vendorRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(vendorRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(vendorRes.headers.get("cross-origin-resource-policy")).toBeNull();
    const vendorBuf = Buffer.from(await vendorRes.arrayBuffer());
    const actualSha = crypto.createHash("sha256").update(vendorBuf).digest("hex");
    expect(actualSha).toBe(PINNED_MERMAID_SHA256);

    // 2. /_meru/mermaid-frame.js (classic JS, valid syntax, strict parent & securityLevel checks)
    const frameJsRes = await fetch(`${srv.url}/_meru/mermaid-frame.js`);
    expect(frameJsRes.status).toBe(200);
    expect(frameJsRes.headers.get("content-type")).toBe(
      "application/javascript; charset=utf-8",
    );
    expect(frameJsRes.headers.get("cache-control")).toBe("no-store");
    expect(frameJsRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(frameJsRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(frameJsRes.headers.get("cross-origin-resource-policy")).toBeNull();
    const frameJs = await frameJsRes.text();
    expect(frameJs).toBe(MERMAID_FRAME_JS_SOURCE);
    expect(() => new vm.Script(frameJs)).not.toThrow();
    expect(frameJs).toContain("ev.source !== window.parent");
    expect(frameJs).toContain('securityLevel: "strict"');
    expect(frameJs).toContain("suppressErrorRendering: true");
    expect(frameJs).toContain("maxTextSize: MAX_TEXT_SIZE");

    // 3. /_meru/mermaid-frame.html (HTTP CSP includes sandbox allow-scripts, connect-src 'none', frame-ancestors 'self', XFO SAMEORIGIN, zero inline script)
    const frameHtmlRes = await fetch(`${srv.url}/_meru/mermaid-frame.html?id=mm_test_1`);
    expect(frameHtmlRes.status).toBe(200);
    expect(frameHtmlRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(frameHtmlRes.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(frameHtmlRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(frameHtmlRes.headers.get("referrer-policy")).toBe("no-referrer");
    expect(frameHtmlRes.headers.get("cache-control")).toBe("no-store");

    const frameCsp = frameHtmlRes.headers.get("content-security-policy") ?? "";
    expect(frameCsp).toContain("sandbox allow-scripts");
    expect(frameCsp).toContain("default-src 'none'");
    expect(frameCsp).toContain("connect-src 'none'");
    expect(frameCsp).toContain("frame-ancestors 'self'");
    expect(frameCsp).toContain("base-uri 'none'");
    expect(frameCsp).toContain("form-action 'none'");
    expect(frameCsp).toContain("img-src data:");
    expect(frameCsp).toContain("style-src 'unsafe-inline'");
    expect(frameCsp).toContain(`${srv.url}/_meru/vendor/mermaid.min.js`);
    expect(frameCsp).toContain(`${srv.url}/_meru/mermaid-frame.js`);
    expect(frameCsp).not.toMatch(/script-src[^;]*'unsafe-inline'/);

    const frameHtml = await frameHtmlRes.text();
    expect(frameHtml).toBe(MERMAID_FRAME_HTML_SOURCE);
    expect(frameHtml).toContain('<script src="/_meru/vendor/mermaid.min.js"></script>');
    expect(frameHtml).toContain('<script src="/_meru/mermaid-frame.js"></script>');
    expect(frameHtml).not.toContain('type="module"');
    // Every <script> tag must have a src attribute and empty body (zero inline scripts)
    const scriptTags = Array.from(frameHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi));
    expect(scriptTags.length).toBe(2);
    for (const [, attrs, body] of scriptTags) {
      expect(attrs).toMatch(/\bsrc="\/_meru\//);
      expect(body.trim()).toBe("");
    }

    // 4. Host header injection resistance on default server (NO allowedOrigins, NO publicBaseUrl)
    for (const [label, headers, forbiddenSubstr] of [
      ["CSP directive injection", { Host: "evil.example; script-src 'unsafe-inline'" }, "evil.example"],
      ["arbitrary Host on default server", { Host: "evil.example:9999" }, "evil.example"],
      [
        "arbitrary Host + X-Forwarded-Proto: https on default server",
        { Host: "evil.example:9999", "X-Forwarded-Proto": "https" },
        "evil.example",
      ],
      ["wrong loopback port on default server", { Host: "127.0.0.1:9999" }, "127.0.0.1:9999"],
      ["X-Forwarded-Proto spoof on default loopback server", { Host: `localhost:${srv.port}`, "X-Forwarded-Proto": "https" }, "https://localhost"],
    ] as Array<[string, Record<string, string>, string]>) {
      const probeRes = await rawHttpGet(`${srv.url}/_meru/mermaid-frame.html?id=probe_1`, headers);
      expect(probeRes.status, label).toBe(200);
      const probeCsp = String(probeRes.headers["content-security-policy"] ?? "");
      expect(probeCsp, `${label} must not inject ${forbiddenSubstr}`).not.toContain(forbiddenSubstr);
      expect(probeCsp, `${label} must not allow unsafe-inline scripts`).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    }

    // Valid loopback alias on the exact bound port (e.g. localhost:<port> -> 127.0.0.1:<port>) IS allowed
    const loopbackAliasRes = await rawHttpGet(`${srv.url}/_meru/mermaid-frame.html?id=probe_alias`, {
      Host: `localhost:${srv.port}`,
    });
    expect(loopbackAliasRes.status).toBe(200);
    expect(String(loopbackAliasRes.headers["content-security-policy"] ?? "")).toContain(
      `http://localhost:${srv.port}/_meru/vendor/mermaid.min.js`,
    );

    const restrictedCsp = buildMermaidFrameCsp({
      req: {
        headers: { host: "attacker.example:3800" },
        socket: {},
      } as unknown as http.IncomingMessage,
      serverUrl: "http://127.0.0.1:3800",
      allowedOrigins: ["https://mind.example.com"],
    });
    expect(restrictedCsp).not.toContain("attacker.example");
    expect(restrictedCsp).toContain("https://mind.example.com/_meru/vendor/mermaid.min.js");

    // publicBaseUrl mode rejects wrong loopback ports
    const pubCsp = buildMermaidFrameCsp({
      req: {
        headers: { host: "127.0.0.1:9999" },
        socket: {},
      } as unknown as http.IncomingMessage,
      serverUrl: "http://127.0.0.1:3800",
      publicBaseUrl: "https://mind.example.com",
    });
    expect(pubCsp).not.toContain("127.0.0.1:9999");
    expect(pubCsp).toContain("https://mind.example.com/_meru/vendor/mermaid.min.js");

    // 5. Host STRICT_UI_CSP includes frame-src 'self' and keeps script-src strictly 'self'
    expect(STRICT_UI_CSP).toContain("frame-src 'self'");
    expect(STRICT_UI_CSP).toContain("script-src 'self';");
    expect(STRICT_UI_CSP).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(STRICT_UI_CSP).toContain("frame-ancestors 'none'");
  });

  it("2. Verifies copy-vendor.mjs SHA-256 outputs, devDependencies placement, and version/scope invariants", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
      version: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.version).toBe("0.6.6");
    expect(MERU_MIND_VERSION).toBe("0.6.6");
    expect(pkg.devDependencies?.mermaid).toBe("11.17.2");
    expect(pkg.dependencies?.mermaid).toBeUndefined();

    // dist/vendor artifacts & licenses present and SHA-256 verified
    const markedBuf = fs.readFileSync(path.resolve("dist/vendor/marked.esm.js"));
    expect(crypto.createHash("sha256").update(markedBuf).digest("hex")).toBe(
      PINNED_MARKED_SHA256,
    );
    expect(fs.existsSync(path.resolve("dist/vendor/marked.LICENSE"))).toBe(true);

    const mermaidBuf = fs.readFileSync(path.resolve("dist/vendor/mermaid.min.js"));
    expect(crypto.createHash("sha256").update(mermaidBuf).digest("hex")).toBe(
      PINNED_MERMAID_SHA256,
    );
    expect(fs.existsSync(path.resolve("dist/vendor/mermaid.LICENSE"))).toBe(true);

    // SKILL.md untouched at 23 lines
    const skillLines = fs
      .readFileSync(path.resolve("skills/meru-mind/SKILL.md"), "utf8")
      .trimEnd()
      .split("\n").length;
    expect(skillLines).toBe(23);

    // Generated shell in sync
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve("scripts/generate-ui-assets.mjs"),
      "--check",
    ]);
    expect(stdout).toContain("in sync");
  });

  it("3. Enforces zero-innerHTML, host Mermaid caps/sandbox wiring, popover layer, Load More footer, and elimination of synthetic unkeyed bucket", () => {
    const forbiddenDomSinks =
      /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML\s*\(|document\.write\s*\(/;
    for (const relPath of [
      "src/server/mermaid-frame.ts",
      "src/server/markdown-renderer.ts",
      "src/server/ui-assets.ts",
      "src/ui/shell/app.js",
      "src/server/ui-shell.generated.ts",
    ]) {
      const text = fs.readFileSync(path.resolve(relPath), "utf8");
      expect(text, `${relPath} must have zero raw HTML sinks`).not.toMatch(
        forbiddenDomSinks,
      );
    }

    // Valid JS syntax for markdown module and Studio shell
    expect(
      () =>
        new vm.Script(
          MARKDOWN_JS_SOURCE.replace(/^import\s+.*$/gm, "").replace(/\bexport\s+/g, ""),
        ),
    ).not.toThrow();
    expect(
      () => new vm.Script(DEFAULT_SHELL_JS.replace(/^import\s+.*$/gm, "")),
    ).not.toThrow();

    // Host markdown Mermaid invariants
    expect(MARKDOWN_JS_SOURCE).toContain("MAX_MERMAID_CHARS = 50_000");
    expect(MARKDOWN_JS_SOURCE).toContain("MAX_MERMAID_DIAGRAMS = 20");
    expect(MARKDOWN_JS_SOURCE).toContain('frame.setAttribute("sandbox", "allow-scripts")');
    expect(MARKDOWN_JS_SOURCE).toContain('if (ev.origin !== "null") return;');
    expect(MARKDOWN_JS_SOURCE).toContain("IntersectionObserver");
    expect(MARKDOWN_JS_SOURCE).toContain("mountSafeMarkdown");

    // Studio UI shell invariants (Pieces 2 & 3)
    expect(DEFAULT_SHELL_HTML).toContain('id="meru-popover-layer"');
    expect(DEFAULT_SHELL_HTML).toContain('id="meru-modal-layer"');
    expect(DEFAULT_SHELL_JS).toContain("meru-popover-layer");
    expect(DEFAULT_SHELL_JS).toContain("meru-modal-layer");
    expect(DEFAULT_SHELL_JS).toContain("positionPopoverElement");
    expect(DEFAULT_SHELL_JS).toContain("updatePresencePanel");
    expect(DEFAULT_SHELL_JS).toContain("load-more-pill");
    expect(DEFAULT_SHELL_JS).toContain("entries-all-shown");
    expect(DEFAULT_SHELL_JS).toContain("preserveLoadedCount");
    expect(DEFAULT_SHELL_JS).toContain("realmEntriesTotal");
    expect(DEFAULT_SHELL_CSS).toContain(".load-more-pill");
    expect(DEFAULT_SHELL_CSS).toContain("#meru-popover-layer");
    expect(DEFAULT_SHELL_CSS).toMatch(/#meru-popover-layer\s*\{[^}]*z-index:\s*75;/s);
    expect(DEFAULT_SHELL_JS).toContain("selectRealmSeq");
    expect(DEFAULT_SHELL_JS).toContain("loadMoreFailed");
    expect(MERMAID_FRAME_HTML_SOURCE).toContain("overflow: auto;");
    expect(MERMAID_FRAME_JS_SOURCE).toContain("sanitizeImportedSvg");
    expect(MERMAID_FRAME_JS_SOURCE).toContain("[svgRoot].concat");
    expect(MERMAID_FRAME_JS_SOURCE).toContain("vbscript:");
    expect(MERMAID_FRAME_JS_SOURCE).toContain("data:text/html");

    // Docs & Threat Model synced to v0.6.6
    expect(fs.readFileSync(path.resolve("docs/deployment-and-frontend.md"), "utf8")).toContain(
      "ghcr.io/matthewoho/meru-mind:${MERU_MIND_TAG:-v0.6.6}",
    );
    expect(fs.readFileSync(path.resolve("THREAT_MODEL.md"), "utf8")).toContain(
      "Opaque-Origin Offline Mermaid Sandbox",
    );

    // Eliminated synthetic bucket & hardcoded guessed popover heights
    expect(DEFAULT_SHELL_JS).not.toContain("未挂事");
    expect(DEFAULT_SHELL_JS).not.toContain("unkeyed-bucket");
    expect(DEFAULT_SHELL_JS).not.toContain('actorKind: "unkeyed"');
    expect(DEFAULT_SHELL_JS).not.toMatch(/isWideCard\s*\?\s*404/);

    // Plain-language Presence copy (ZH + EN)
    for (const expectedCopy of [
      'inFlight: "按任务"',
      'people: "按成员"',
      'unkeyedSection: "未关联任务"',
      'noActiveTasks: "当前没有进行中的任务"',
      'browsingTag: "浏览中"',
      'browserClient: "浏览器"',
      'inFlight: "By task"',
      'people: "By member"',
      'unkeyedSection: "No task"',
      'noActiveTasks: "No active tasks right now"',
      'browsingTag: "Browsing"',
      'browserClient: "Browser"',
    ]) {
      expect(DEFAULT_SHELL_JS).toContain(expectedCopy);
    }

    // Zero colorful UI emojis in Studio shell & markdown renderer
    expect(DEFAULT_SHELL_JS).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(MARKDOWN_JS_SOURCE).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
