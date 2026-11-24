import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
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
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_JS_SOURCE,
  DEFAULT_SHELL_JS,
  ejectDefaultUiShell,
  RemoteMindSurface,
  startMindServer,
  STRICT_UI_CSP,
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

/**
 * Minimal RFC 6455 raw client helper so we can adversarially test ALL 7 WS hard conditions
 * (bad Origin, ?token= rejection, >4KB client frame close 1009, non-hello write rejection close 1008,
 * Cookie auth, live frame delivery, and live token revocation close 4001).
 */
function rawWsConnect(params: {
  port: number;
  path: string;
  origin?: string;
  cookie?: string;
}): Promise<{
  statusCode: number;
  statusLine: string;
  socket: net.Socket;
  sendMaskedText: (text: string) => void;
  nextFrame: (timeoutMs?: number) => Promise<{ opcode: number; payload: Buffer }>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: params.port });
    const key = crypto.randomBytes(16).toString("base64");
    let headerBuf = Buffer.alloc(0);
    let handshakeDone = false;
    let frameBuf = Buffer.alloc(0);
    const frameWaiters: Array<(f: { opcode: number; payload: Buffer }) => void> = [];
    const queuedFrames: Array<{ opcode: number; payload: Buffer }> = [];

    const parseFrames = () => {
      while (frameBuf.length >= 2) {
        const opcode = frameBuf[0]! & 0x0f;
        let len = frameBuf[1]! & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (frameBuf.length < 4) return;
          len = frameBuf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (frameBuf.length < 10) return;
          len = Number(frameBuf.readBigUInt64BE(2));
          offset = 10;
        }
        if (frameBuf.length < offset + len) return;
        const payload = Buffer.from(frameBuf.subarray(offset, offset + len));
        frameBuf = frameBuf.subarray(offset + len);
        const frame = { opcode, payload };
        const waiter = frameWaiters.shift();
        if (waiter) waiter(frame);
        else queuedFrames.push(frame);
      }
    };

    socket.on("error", (err) => {
      if (!handshakeDone) reject(err);
    });

    socket.on("connect", () => {
      const lines = [
        `GET ${params.path} HTTP/1.1`,
        `Host: 127.0.0.1:${params.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
      ];
      if (params.origin !== undefined) lines.push(`Origin: ${params.origin}`);
      if (params.cookie !== undefined) lines.push(`Cookie: ${params.cookie}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });

    socket.on("data", (chunk: Buffer) => {
      if (!handshakeDone) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const sepIdx = headerBuf.indexOf("\r\n\r\n");
        if (sepIdx === -1) return;
        handshakeDone = true;
        const headText = headerBuf.subarray(0, sepIdx).toString("utf8");
        const statusLine = headText.split("\r\n")[0] ?? "";
        const m = /HTTP\/1\.1\s+(\d{3})/.exec(statusLine);
        const statusCode = m ? Number.parseInt(m[1]!, 10) : 0;
        frameBuf = headerBuf.subarray(sepIdx + 4);
        parseFrames();

        const sendMaskedText = (text: string) => {
          const payload = Buffer.from(text, "utf8");
          const mask = crypto.randomBytes(4);
          let hdr: Buffer;
          if (payload.length < 126) {
            hdr = Buffer.alloc(2);
            hdr[0] = 0x81;
            hdr[1] = 0x80 | payload.length;
          } else {
            hdr = Buffer.alloc(4);
            hdr[0] = 0x81;
            hdr[1] = 0x80 | 126;
            hdr.writeUInt16BE(payload.length, 2);
          }
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i += 1) {
            masked[i] = payload[i]! ^ mask[i % 4]!;
          }
          socket.write(Buffer.concat([hdr, mask, masked]));
        };

        const nextFrame = (timeoutMs = 3000) => {
          if (queuedFrames.length > 0) {
            return Promise.resolve(queuedFrames.shift()!);
          }
          return new Promise<{ opcode: number; payload: Buffer }>((res, rej) => {
            const t = setTimeout(() => rej(new Error("WS frame timeout")), timeoutMs);
            frameWaiters.push((f) => {
              clearTimeout(t);
              res(f);
            });
          });
        };

        resolve({
          statusCode,
          statusLine,
          socket,
          sendMaskedText,
          nextFrame,
          close: () => socket.destroy(),
        });
      } else {
        frameBuf = Buffer.concat([frameBuf, chunk]);
        parseFrames();
      }
    });
  });
}

describe("v0.4 1.5-Layer Composable Web Governance UI, 7-Condition Pump WS & In-Process MindPulse", () => {
  it("1. Enforces ALL 6 custom-UI security guardrails (loopback --web-dir, reserved /_meru/*, strict CSP, Service-Worker 404, single-use CLI login code, weakened Cookie 403)", async () => {
    const customDir = makeTempDir("meru-v04-custom-ui-");
    // Adversarial custom bundle attempting to shadow /_meru/client.js and serve custom index.html
    fs.mkdirSync(path.join(customDir, "_meru"), { recursive: true });
    fs.writeFileSync(path.join(customDir, "_meru", "client.js"), "console.log('HIJACKED');", "utf8");
    fs.writeFileSync(path.join(customDir, "index.html"), "<!doctype html><html><body>Custom Local Shell</body></html>", "utf8");
    fs.writeFileSync(path.join(customDir, "sw.js"), "self.addEventListener('fetch', () => {});", "utf8");

    // Guardrail #6: --web-dir MUST be rejected on non-loopback hosts
    await expect(
      startMindServer({
        homeDir: makeTempDir("meru-v04-nonloop-"),
        host: "0.0.0.0",
        port: 0,
        webDir: customDir,
        enableVector: false,
        accessLog: false,
      }),
    ).rejects.toThrow(/loopback-only/i);

    // Loopback --web-dir starts cleanly
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v04-ui-"),
      host: "127.0.0.1",
      port: 0,
      webDir: customDir,
      demo: true,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    // Guardrail #4: /_meru/client.js and /_meru/shell can NEVER be shadowed by --web-dir!
    const clientResp = await fetch(`${srv.url}/_meru/client.js`);
    expect(clientResp.status).toBe(200);
    const clientJs = await clientResp.text();
    expect(clientJs).not.toContain("HIJACKED");
    expect(clientJs).toContain("createMindClient");
    expect(clientJs).toContain("meru-entry");
    expect(clientResp.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);

    const shellResp = await fetch(`${srv.url}/_meru/shell`);
    expect(shellResp.status).toBe(200);
    expect(await shellResp.text()).toContain("/_meru/shell.js");
    expect(shellResp.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);

    // Custom index.html IS served at / with strict CSP enforced
    const rootResp = await fetch(`${srv.url}/`);
    expect(rootResp.status).toBe(200);
    expect(await rootResp.text()).toContain("Custom Local Shell");
    expect(rootResp.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);

    // Guardrail #5: Service-Worker: script strictly returns 404
    const swResp = await fetch(`${srv.url}/sw.js`, {
      headers: { "Service-Worker": "script" },
    });
    expect(swResp.status).toBe(404);

    // Guardrail #2: 60s single-use CLI login code -> HttpOnly; SameSite=Strict Cookie, replay fails!
    const humanTok = srv.createToken({ actorId: "matthew", actorKind: "human" });
    const mintResp = await fetch(`${srv.url}/v1/ui/login-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${humanTok.token}` },
    });
    expect(mintResp.status).toBe(200);
    const { code, loginUrl } = (await mintResp.json()) as { code: string; loginUrl: string };
    expect(code).toMatch(/^mm_code_/);

    const authResp = await httpGetNoRedirect(loginUrl, {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    expect(authResp.status).toBe(302);
    const setCookieHeader = authResp.headers["set-cookie"];
    const setCookie = Array.isArray(setCookieHeader) ? (setCookieHeader[0] ?? "") : (setCookieHeader ?? "");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookiePair = setCookie.split(";")[0]!;

    // Replaying the same single-use code MUST fail with 401/403
    const replayResp = await httpGetNoRedirect(loginUrl, {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    expect([401, 403]).toContain(replayResp.status);

    // Guardrail #1: Weakened Cookie allows read + reversible inbox triage, blocks redact/rule/mount/token with 403 + CLI cmd
    const whoResp = await fetch(`${srv.url}/v1/whoami`, { headers: { Cookie: cookiePair } });
    expect(whoResp.status).toBe(200);
    const whoJson = (await whoResp.json()) as { actor: { id: string }; write: { canRedact: boolean } };
    expect(whoJson.actor.id).toBe("matthew");
    expect(whoJson.write.canRedact).toBe(false);

    // Reversible triage move from /inbox -> /ops SUCCEEDS with Cookie (requires same-origin Origin header per v0.5.2 CSRF guardrail)
    const triageResp = await fetch(`${srv.url}/v1/move`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entryIds: [srv.demoSeed!.inboxEntryId],
        targetRealmRef: "/ops",
        expectedFromRealmRef: "/inbox",
      }),
    });
    expect(triageResp.status).toBe(200);

    // Irreversible / scope-widening verbs strictly return 403 + copyable CLI command
    for (const [ep, payload] of [
      ["/v1/redact", { entryId: srv.demoSeed!.inboxEntryId, reason: "test" }],
      ["/v1/rules", { in: "/ops", title: "Illegal", body: "Nope" }],
      ["/v1/realms/mount", { viewerRef: "/ops", targetRef: "/engineering" }],
      ["/v1/org/policy", { policy: "tree" }],
      ["/v1/tokens", { actorId: "evil", actorKind: "human" }],
    ] as const) {
      const r = await fetch(`${srv.url}${ep}`, {
        method: "POST",
        headers: {
          Cookie: cookiePair,
          Origin: srv.url,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      expect(r.status).toBe(403);
      const errJson = (await r.json()) as { try?: string };
      expect(errJson.try).toContain("meru-mind ");
    }

    // Syntax-check served client.js & shell.js as valid ES modules (Node vm.SourceTextModule / Function parse check)
    expect(() => new vm.Script(CLIENT_JS_SOURCE.replace(/\bexport\s+/g, ""))).not.toThrow();
    expect(() => new vm.Script(DEFAULT_SHELL_JS.replace(/^import\s+.*$/gm, ""))).not.toThrow();

    // Eject writes working local files pointing to /_meru/client.js
    const ejectDir = makeTempDir("meru-v04-eject-");
    const ejectedFiles = ejectDefaultUiShell(ejectDir);
    expect(ejectedFiles).toHaveLength(3);
    expect(fs.readFileSync(path.join(ejectDir, "shell.js"), "utf8")).toContain("/_meru/client.js");
  });

  it("2. Pump WebSocket (/v1/ws) enforces ALL 7 hard conditions (Cookie auth, no ?token=, Origin check, downlink-only 4KB cap, live thin frames, token revocation close 4001)", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v04-ws-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const humanTok = srv.createToken({ actorId: "alice", actorKind: "human" });
    const agentTok = srv.createToken({ actorId: "agent-ws", actorKind: "agent" });

    // Obtain valid HttpOnly Cookie via single-use login code
    const mint = await fetch(`${srv.url}/v1/ui/login-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${humanTok.token}` },
    });
    const { loginUrl } = (await mint.json()) as { loginUrl: string };
    const authRes = await httpGetNoRedirect(loginUrl, {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    const rawSetCookie = authRes.headers["set-cookie"];
    const setCookieStr = Array.isArray(rawSetCookie) ? (rawSetCookie[0] ?? "") : (rawSetCookie ?? "");
    const cookiePair = setCookieStr.split(";")[0]!;

    // Condition #1: ?token=... in WS URL MUST be rejected (400)
    const badUrl = await rawWsConnect({
      port: srv.port,
      path: `/v1/ws?token=${humanTok.token}`,
      origin: srv.url,
      cookie: cookiePair,
    });
    expect(badUrl.statusCode).toBe(400);
    badUrl.close();

    // Condition #2: Cross-origin WS handshake MUST be rejected (403)
    const badOrigin = await rawWsConnect({
      port: srv.port,
      path: "/v1/ws",
      origin: "https://evil.example.com",
      cookie: cookiePair,
    });
    expect(badOrigin.statusCode).toBe(403);
    badOrigin.close();

    // Missing Cookie MUST be rejected (401)
    const noCookie = await rawWsConnect({
      port: srv.port,
      path: "/v1/ws",
      origin: srv.url,
    });
    expect(noCookie.statusCode).toBe(401);
    noCookie.close();

    // Valid same-origin Cookie WS upgrades cleanly (101) and delivers thin frames on commit
    const ws = await rawWsConnect({
      port: srv.port,
      path: "/v1/ws",
      origin: srv.url,
      cookie: cookiePair,
    });
    expect(ws.statusCode).toBe(101);
    ws.sendMaskedText(JSON.stringify({ type: "hello", sinceSeq: 0 }));
    const welcome = JSON.parse((await ws.nextFrame()).payload.toString("utf8")) as { type: string };
    expect(welcome.type).toBe("welcome");

    // Trigger write over REST -> WS immediately pushes thin frame (no body!)
    const agentSurf = await RemoteMindSurface.connect({ baseUrl: srv.url, token: agentTok.token });
    const wrote = await agentSurf.write({
      in: "/",
      kind: "finding",
      title: "Live WS Pump event",
      body: "SECRET_BODY_MUST_NOT_BE_IN_WS_FRAME",
    });
    const pushRaw = (await ws.nextFrame()).payload.toString("utf8");
    const pushMsg = JSON.parse(pushRaw) as { type: string; frames: Array<{ entityId: string }> };
    expect(pushMsg.type).toBe("frames");
    expect(pushMsg.frames.some((f) => f.entityId === wrote.record.id)).toBe(true);
    expect(pushRaw).not.toContain("SECRET_BODY_MUST_NOT_BE_IN_WS_FRAME");

    // Condition #3a: Sending a non-hello write command over WS closes with 1008
    ws.sendMaskedText(JSON.stringify({ type: "write", title: "illegal" }));
    const closeFrame = await ws.nextFrame();
    expect(closeFrame.opcode).toBe(0x8);
    expect(closeFrame.payload.readUInt16BE(0)).toBe(1008);
    ws.close();

    // Condition #3b: Payload > 4KB closes with 1009
    const wsBig = await rawWsConnect({
      port: srv.port,
      path: "/v1/ws",
      origin: srv.url,
      cookie: cookiePair,
    });
    expect(wsBig.statusCode).toBe(101);
    wsBig.sendMaskedText("x".repeat(5000));
    const bigClose = await wsBig.nextFrame();
    expect(bigClose.opcode).toBe(0x8);
    expect(bigClose.payload.readUInt16BE(0)).toBe(1009);
    wsBig.close();

    // Condition #6: Revoking the underlying token triggers close 4001 on next batch
    const wsRevoke = await rawWsConnect({
      port: srv.port,
      path: "/v1/ws",
      origin: srv.url,
      cookie: cookiePair,
    });
    wsRevoke.sendMaskedText(JSON.stringify({ type: "hello", sinceSeq: 0 }));
    await wsRevoke.nextFrame(); // welcome
    await wsRevoke.nextFrame(); // existing frames
    srv.engine.db.revokeToken(srv.orgId, humanTok.record.id, new Date().toISOString());
    // Trigger wake -> pump rechecks token and closes with 4001!
    await agentSurf.write({
      in: "/",
      kind: "finding",
      title: "Post-revoke trigger",
      body: "Triggers pump token recheck.",
    });
    const revClose = await wsRevoke.nextFrame();
    expect(revClose.opcode).toBe(0x8);
    expect(revClose.payload.readUInt16BE(0)).toBe(4001);
    wsRevoke.close();
  });

  it("3. In-process MindPulse enforces focus<=3, note<=140, zero SQLite/change_log writes, and tree-mode sibling isolation", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v04-pulse-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    const admin = await RemoteMindSurface.connect({ baseUrl: srv.url, token: adminTok.token });
    await admin.setOrgPolicy({ policy: "tree" });
    await admin.createRealm({ parentRef: "/", slug: "alpha", name: "Alpha" });
    await admin.createRealm({ parentRef: "/", slug: "beta", name: "Beta" });

    const tokA = await admin.createToken({ actorId: "bot-a", actorKind: "agent", boundRealmRef: "/alpha" });
    const tokB = await admin.createToken({ actorId: "bot-b", actorKind: "agent", boundRealmRef: "/beta" });

    const seqBefore = srv.engine.db.getLatestChangeLogSeq(srv.orgId);

    // >3 focus refs rejected; >140 char note rejected
    const badFocus = await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ focus: ["a", "b", "c", "d"] }),
    });
    expect(badFocus.status).toBe(400);

    const badNote = await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ focus: ["service:api"], note: "x".repeat(141) }),
    });
    expect(badNote.status).toBe(400);

    // Valid pulses in /alpha and /beta
    const pA = await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ focus: ["service:alpha-api"], note: "Debugging Alpha" }),
    });
    expect(pA.status).toBe(200);

    const pB = await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokB.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ focus: ["service:beta-secret"], note: "Working on Beta" }),
    });
    expect(pB.status).toBe(200);

    // MindPulse MUST NOT write to SQLite change_log!
    expect(srv.engine.db.getLatestChangeLogSeq(srv.orgId)).toBe(seqBefore);

    // Tree-mode sibling isolation: bot-a MUST NOT see bot-b's pulse!
    const listA = await fetch(`${srv.url}/v1/pulse`, {
      headers: { Authorization: `Bearer ${tokA.token}` },
    });
    const jsonA = (await listA.json()) as { pulses: Array<{ actorId: string }> };
    expect(jsonA.pulses.map((p) => p.actorId)).toEqual(["bot-a"]);
  });
});
