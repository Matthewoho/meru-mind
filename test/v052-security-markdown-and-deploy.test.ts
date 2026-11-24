import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

function httpGetNoRedirect(
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

function firstSetCookie(headers: http.IncomingHttpHeaders): string {
  const raw = headers["set-cookie"];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FAVICON_SVG,
  DEFAULT_SHELL_JS,
  MARKDOWN_JS_SOURCE,
  MERU_MIND_VERSION,
  RemoteMindSurface,
  SERVE_LOCK_FILENAME,
  startMindServer,
  STRICT_UI_CSP,
  UI_HOST_SESSION_COOKIE_NAME,
  type MindServerHandle,
} from "../src/index.js";

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

describe("v0.5.2 Security Hardening, Deployment P0s, Safe Markdown Vendor & Built-in Shell", () => {
  it("P0 #1: recovers from stale same-PID lock (Docker PID 1 crash-loop) while still blocking live in-process double-serve", async () => {
    const homeDir = makeTempDir("meru-v052-pid1-");
    const lockPath = path.join(homeDir, SERVE_LOCK_FILENAME);
    // Simulate a crashed previous container boot that left pid === process.pid on disk
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        instanceId: "dead-previous-container-boot",
        startedAt: "2026-01-01T00:00:00.000Z",
        url: "http://0.0.0.0:3800",
        orgId: "org_stale",
      }),
      "utf8",
    );

    // Must recover cleanly instead of deadlocking!
    const srv = await startMindServer({
      homeDir,
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    // While srv IS genuinely active in-process, a second serve on the same homeDir MUST still fail
    await expect(
      startMindServer({
        homeDir,
        host: "127.0.0.1",
        port: 0,
        enableVector: false,
        accessLog: false,
      }),
    ).rejects.toThrow(/already holds the exclusive writer lock/i);
  });

  it("P0 #2 + P0 #4: derives public HTTPS loginUrl via Host/X-Forwarded-Proto, blocks subresource /_meru/auth without burning code, and sets __Host-meru_session on HTTPS", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v052-auth-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const humanTok = srv.createToken({ actorId: "alice", actorKind: "human" });
    const mintResp = await fetch(`${srv.url}/v1/ui/login-code`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${humanTok.token}`,
        "X-Forwarded-Proto": "https",
      },
    });
    expect(mintResp.status).toBe(200);
    const mintJson = (await mintResp.json()) as {
      code: string;
      path: string;
      loginUrl: string;
    };
    expect(mintJson.path).toBe(`/_meru/auth?code=${encodeURIComponent(mintJson.code)}`);
    expect(mintJson.loginUrl).toMatch(/^https:\/\//);
    expect(mintJson.loginUrl).not.toContain("0.0.0.0");

    // P0 #4: Subresource <img src="/_meru/auth?code=..."> MUST return 403 and NOT burn the code
    const imgProbe = await httpGetNoRedirect(`${srv.url}${mintJson.path}`, {
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Dest": "image",
    });
    expect(imgProbe.status).toBe(403);

    const corsProbe = await httpGetNoRedirect(`${srv.url}${mintJson.path}`, {
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    });
    expect(corsProbe.status).toBe(403);

    // Real top-level browser navigation over HTTPS succeeds with the EXACT SAME unburned code
    // and issues __Host-meru_session; HttpOnly; SameSite=Strict; Path=/; Secure!
    const navResp = await httpGetNoRedirect(`${srv.url}${mintJson.path}`, {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      "X-Forwarded-Proto": "https",
    });
    expect(navResp.status).toBe(302);
    const setCookie = firstSetCookie(navResp.headers);
    expect(setCookie).toContain(`${UI_HOST_SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Secure");

    const hostCookiePair = setCookie.split(";")[0]!;
    const whoResp = await fetch(`${srv.url}/v1/whoami`, {
      headers: { Cookie: hostCookiePair },
    });
    expect(whoResp.status).toBe(200);
    const whoJson = (await whoResp.json()) as { actor: { id: string } };
    expect(whoJson.actor.id).toBe("alice");
  });

  it("P0 #3: enforces JSON Content-Type + same-Origin CSRF protection on Cookie writes & logout while keeping Bearer CLI unaffected", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v052-csrf-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const humanTok = srv.createToken({ actorId: "bob", actorKind: "human" });
    const mint = await fetch(`${srv.url}/v1/ui/login-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${humanTok.token}` },
    });
    const { path: authPath } = (await mint.json()) as { path: string };
    const authRes = await httpGetNoRedirect(`${srv.url}${authPath}`, {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    expect(authRes.status).toBe(302);
    const cookiePair = firstSetCookie(authRes.headers).split(";")[0]!;

    const writePayload = JSON.stringify({
      in: "/",
      kind: "finding",
      title: "CSRF check",
      body: "Testing CSRF gate.",
    });

    // 1. text/plain Cookie write -> 403
    const textPlain = await fetch(`${srv.url}/v1/write`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: srv.url,
        "Content-Type": "text/plain",
      },
      body: writePayload,
    });
    expect(textPlain.status).toBe(403);

    // 2. Cross-origin JSON Cookie write -> 403
    const evilOrigin = await fetch(`${srv.url}/v1/write`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: "https://evil.example.com",
        "Content-Type": "application/json",
      },
      body: writePayload,
    });
    expect(evilOrigin.status).toBe(403);

    // 3. Missing-Origin JSON Cookie write -> 403
    const missingOrigin = await fetch(`${srv.url}/v1/write`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        "Content-Type": "application/json",
      },
      body: writePayload,
    });
    expect(missingOrigin.status).toBe(403);

    // 4. Same-Origin JSON Cookie write -> 200
    const goodCookieWrite = await fetch(`${srv.url}/v1/write`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: writePayload,
    });
    expect(goodCookieWrite.status).toBe(200);

    // 5. Cross-origin logout -> 403 (session remains valid!)
    const badLogout = await fetch(`${srv.url}/_meru/logout`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: "https://evil.example.com",
      },
    });
    expect(badLogout.status).toBe(403);
    const stillAuthed = await fetch(`${srv.url}/v1/whoami`, {
      headers: { Cookie: cookiePair },
    });
    expect(stillAuthed.status).toBe(200);

    // 6. Same-origin logout -> 200 (session revoked!)
    const goodLogout = await fetch(`${srv.url}/_meru/logout`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: srv.url,
      },
    });
    expect(goodLogout.status).toBe(200);
    const afterLogout = await fetch(`${srv.url}/v1/whoami`, {
      headers: { Cookie: cookiePair },
    });
    expect(afterLogout.status).toBe(401);

    // 7. Bearer write with NO Origin header -> 200
    const bearerWrite = await fetch(`${srv.url}/v1/write`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${humanTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        in: "/",
        kind: "finding",
        title: "Bearer CLI write",
        body: "CLI sends no Origin header.",
      }),
    });
    expect(bearerWrite.status).toBe(200);
  });

  it("P1: unified version, GET /mcp -> 405 Allow: POST, and human-Bearer-only online POST /v1/admin/backup", async () => {
    const homeDir = makeTempDir("meru-v052-p1-");
    const srv = await startMindServer({
      homeDir,
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const pkg = JSON.parse(
      fs.readFileSync(path.resolve("package.json"), "utf8"),
    ) as { version: string };
    expect(MERU_MIND_VERSION).toBe(pkg.version);

    const healthResp = await fetch(`${srv.url}/v1/health`);
    expect(healthResp.status).toBe(200);
    const healthJson = (await healthResp.json()) as { version: string };
    expect(healthJson.version).toBe(pkg.version);

    // GET /mcp -> 405 with Allow: POST
    const mcpGet = await fetch(`${srv.url}/mcp`, { method: "GET" });
    expect(mcpGet.status).toBe(405);
    expect(mcpGet.headers.get("allow")).toBe("POST");

    const humanTok = srv.createToken({ actorId: "ops-admin", actorKind: "human" });
    const agentTok = srv.createToken({ actorId: "bot-worker", actorKind: "agent" });

    // Agent Bearer backup -> 403
    const agentBackup = await fetch(`${srv.url}/v1/admin/backup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "agent-attempt.sqlite" }),
    });
    expect(agentBackup.status).toBe(403);

    // Cookie backup -> 403
    const mint = await fetch(`${srv.url}/v1/ui/login-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${humanTok.token}` },
    });
    const { path: authPath } = (await mint.json()) as { path: string };
    const authRes = await httpGetNoRedirect(`${srv.url}${authPath}`, {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    expect(authRes.status).toBe(302);
    const cookiePair = firstSetCookie(authRes.headers).split(";")[0]!;
    const cookieBackup = await fetch(`${srv.url}/v1/admin/backup`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "cookie-attempt.sqlite" }),
    });
    expect(cookieBackup.status).toBe(403);

    // Path traversal filename -> 400
    const traversalBackup = await fetch(`${srv.url}/v1/admin/backup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${humanTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "../escape.sqlite" }),
    });
    expect(traversalBackup.status).toBe(400);

    // Human Bearer backup -> 200 + real SQLite snapshot with verified SHA-256
    const okBackup = await fetch(`${srv.url}/v1/admin/backup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${humanTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "daily-check" }),
    });
    expect(okBackup.status).toBe(200);
    const backupJson = (await okBackup.json()) as {
      backedUp: boolean;
      filename: string;
      relativePath: string;
      sizeBytes: number;
      sha256: string;
    };
    expect(backupJson.backedUp).toBe(true);
    expect(backupJson.filename).toBe("daily-check.sqlite");
    expect(backupJson.relativePath).toBe("backups/daily-check.sqlite");
    const savedPath = path.join(homeDir, "backups", "daily-check.sqlite");
    expect(fs.existsSync(savedPath)).toBe(true);
    const savedBuf = fs.readFileSync(savedPath);
    expect(savedBuf.subarray(0, 15).toString("utf8")).toBe("SQLite format 3");
    expect(crypto.createHash("sha256").update(savedBuf).digest("hex")).toBe(
      backupJson.sha256,
    );
  });

  it("Serves pinned SHA-256 marked vendor, /_meru/markdown.js, Option A 12-F1 favicon, zero-innerHTML invariant, and non-empty claim-only realm", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v052-md-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    // 1. Pinned vendored marked.esm.js served under /_meru/vendor/ with STRICT_UI_CSP
    const vendorResp = await fetch(`${srv.url}/_meru/vendor/marked.esm.js`);
    expect(vendorResp.status).toBe(200);
    expect(vendorResp.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);
    const vendorText = await vendorResp.text();
    const vendorSha = crypto.createHash("sha256").update(vendorText, "utf8").digest("hex");
    expect(vendorSha).toBe("4d2d824f3035e79b6887380d88c6c9ca0958215d1f4f6c053c562d60babc7172");

    // 2. /_meru/markdown.js served with STRICT_UI_CSP and valid JS syntax
    const mdResp = await fetch(`${srv.url}/_meru/markdown.js`);
    expect(mdResp.status).toBe(200);
    expect(mdResp.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);
    const mdSource = await mdResp.text();
    expect(mdSource).toContain("Lexer.lex");
    expect(mdSource).toContain("default-src 'none'");
    expect(
      () =>
        new vm.Script(
          MARKDOWN_JS_SOURCE.replace(/^import\s+.*$/gm, "").replace(/\bexport\s+/g, ""),
        ),
    ).not.toThrow();

    // 3. Sub-Logo Option A (12-F1) favicon served with dark/light prefers-color-scheme
    const favResp = await fetch(`${srv.url}/_meru/favicon.svg`);
    expect(favResp.status).toBe(200);
    const favSvg = await favResp.text();
    expect(favSvg).toBe(DEFAULT_FAVICON_SVG);
    expect(favSvg).toContain("34,132 124,132 244,344 154,344");
    expect(favSvg).toContain("prefers-color-scheme:dark");

    // 4. Static zero-innerHTML invariant across built-in shell, markdown renderer & studio example
    const forbiddenDomSinks = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML\s*\(|document\.write\s*\(/;
    for (const relPath of [
      "src/server/ui-assets.ts",
      "src/server/ui-shell.generated.ts",
      "src/server/markdown-renderer.ts",
      "src/ui/shell/app.js",
    ]) {
      const text = fs.readFileSync(path.resolve(relPath), "utf8");
      expect(text, `${relPath} must contain zero unsafe HTML sinks`).not.toMatch(
        forbiddenDomSinks,
      );
    }

    // 5. Blank-column regression: realm with ONLY `claim` entries is listed via generic client.ls
    const humanTok = srv.createToken({ actorId: "matthew", actorKind: "human" });
    const surf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: humanTok.token,
    });
    await surf.createRealm({ parentRef: "/", slug: "notes", name: "Notes" });
    await surf.write({
      in: "/notes",
      kind: "claim",
      title: "Pure claim document",
      body: "# Heading\n\n- Bullet one\n- Bullet two",
    });
    const lsRes = await surf.ls({ ref: "/notes", only: "entries", limit: 25 });
    expect(lsRes.items.length).toBe(1);
    expect(lsRes.items[0]!.kind).toBe("claim");
    expect(DEFAULT_SHELL_JS).toContain('only: "entries"');
    expect(DEFAULT_SHELL_JS).toContain("meru-markdown");
    await surf.close();
  });
});
