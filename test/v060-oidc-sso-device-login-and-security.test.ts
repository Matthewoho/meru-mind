import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as jose from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVICE_TX_COOKIE_NAME,
  INVITE_TX_COOKIE_NAME,
  OIDC_TX_COOKIE_PREFIX,
  readCredentialsFile,
  sanitizeReturnTo,
  startMindServer,
  UI_SESSION_COOKIE_NAME,
  type MindServerHandle,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];
const openServers: MindServerHandle[] = [];
const openMockIdps: MockOidcIdpHandle[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface MockOidcUser {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  /** Override auth_time epoch seconds; pass null to omit auth_time completely */
  authTimeSec?: number | null;
}

interface MockOidcIdpHandle {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  setNextUser(user: MockOidcUser): void;
  getLastAuthorizeParams(): URLSearchParams | null;
  close(): Promise<void>;
}

/**
 * Real standard OpenID Connect provider in-process using RS256 JWKS (`jose`) + PKCE S256 verification.
 * Speaks pure OIDC Discovery, `/authorize`, `/token`, and `/jwks` with zero Meru-specific shortcuts.
 */
async function startMockOidcIdp(opts?: {
  clientId?: string;
  clientSecret?: string;
}): Promise<MockOidcIdpHandle> {
  const clientId = opts?.clientId ?? "meru-test-client";
  const clientSecret = opts?.clientSecret ?? "meru-test-secret-xyz";
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = await jose.exportJWK(publicKey);
  const kid = `kid-${crypto.randomBytes(4).toString("hex")}`;
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = "RS256";

  let nextUser: MockOidcUser = {
    sub: "sub-alice-001",
    email: "alice@example.com",
    name: "Alice Lin",
    preferred_username: "alice",
  };
  let lastAuthorizeParams: URLSearchParams | null = null;
  const authCodes = new Map<
    string,
    {
      nonce: string | null;
      codeChallenge: string | null;
      redirectUri: string;
      user: MockOidcUser;
      maxAgeRequested: string | null;
    }
  >();

  let issuer = "";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer || "http://127.0.0.1");
    if (
      req.method === "GET" &&
      url.pathname === "/.well-known/openid-configuration"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [
            "client_secret_basic",
            "client_secret_post",
          ],
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/jwks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      lastAuthorizeParams = new URLSearchParams(url.searchParams);
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const nonce = url.searchParams.get("nonce");
      const codeChallenge = url.searchParams.get("code_challenge");
      const maxAgeRequested = url.searchParams.get("max_age");
      const code = `idp_code_${crypto.randomBytes(10).toString("hex")}`;
      authCodes.set(code, {
        nonce,
        codeChallenge,
        redirectUri,
        user: { ...nextUser },
        maxAgeRequested,
      });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      res.writeHead(302, { Location: back.href });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const chunks: Buffer[] = [];
      for await (const c of req)
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const code = form.get("code") ?? "";
      const codeVerifier = form.get("code_verifier") ?? "";
      const rec = authCodes.get(code);
      authCodes.delete(code);
      if (!rec) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      if (rec.codeChallenge) {
        const expectedChallenge = crypto
          .createHash("sha256")
          .update(codeVerifier, "utf8")
          .digest("base64url");
        if (expectedChallenge !== rec.codeChallenge) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "PKCE mismatch",
            }),
          );
          return;
        }
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: issuer,
        sub: rec.user.sub,
        aud: clientId,
        iat: nowSec,
        exp: nowSec + 300,
      };
      if (rec.user.authTimeSec !== null) {
        claims.auth_time = rec.user.authTimeSec ?? nowSec;
      }
      if (rec.nonce) claims.nonce = rec.nonce;
      if (rec.user.email) claims.email = rec.user.email;
      if (rec.user.name) claims.name = rec.user.name;
      if (rec.user.preferred_username)
        claims.preferred_username = rec.user.preferred_username;

      const idToken = await new jose.SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid })
        .sign(privateKey);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: `idp_at_${crypto.randomBytes(8).toString("hex")}`,
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}`;

  const handle: MockOidcIdpHandle = {
    issuer,
    clientId,
    clientSecret,
    setNextUser(u) {
      nextUser = u;
    },
    getLastAuthorizeParams() {
      return lastAuthorizeParams;
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
  openMockIdps.push(handle);
  return handle;
}

function httpRequestNoRedirect(params: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(params.url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: params.method ?? "GET",
        headers: params.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) =>
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
        );
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (params.body) req.write(params.body);
    req.end();
  });
}

function extractCookies(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const item of list) {
    const pair = item.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) {
      out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return out;
}

function getSetCookieLines(headers: http.IncomingHttpHeaders): string[] {
  const raw = headers["set-cookie"];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

/**
 * Walks the real 3-hop OIDC login flow (Meru /_meru/oidc/login -> IdP /authorize -> Meru /_meru/oidc/callback).
 */
async function performOidcLoginFlow(
  loginUrl: string,
  extraStep1Headers?: Record<string, string>,
) {
  const step1 = await httpRequestNoRedirect({
    url: loginUrl,
    headers: extraStep1Headers,
  });
  expect(step1.status).toBe(302);
  const idpAuthUrl = step1.headers.location!;
  const step1Cookies = extractCookies(step1.headers);
  const oidcCookieEntry = Object.entries(step1Cookies).find(([k]) =>
    k.startsWith(OIDC_TX_COOKIE_PREFIX),
  );
  expect(oidcCookieEntry).toBeTruthy();
  const oidcTxCookie = `${oidcCookieEntry![0]}=${oidcCookieEntry![1]}`;

  const step2 = await httpRequestNoRedirect({ url: idpAuthUrl });
  expect(step2.status).toBe(302);
  const callbackUrl = step2.headers.location!;

  const step3 = await httpRequestNoRedirect({
    url: callbackUrl,
    headers: { Cookie: oidcTxCookie },
  });
  return { step1, step2, step3, cookies: extractCookies(step3.headers) };
}

/**
 * Submits the explicit invite confirmation POST rendered after OIDC callback for a new invite.
 */
async function confirmInviteAcceptance(params: {
  serverUrl: string;
  callbackRes: { headers: http.IncomingHttpHeaders; body: string };
  decision?: "accept" | "cancel";
}) {
  const cbCookies = extractCookies(params.callbackRes.headers);
  const invTx = cbCookies[INVITE_TX_COOKIE_NAME];
  expect(invTx).toBeTruthy();
  const csrfMatch = /name="csrf"\s+value="([^"]+)"/.exec(
    params.callbackRes.body,
  );
  expect(csrfMatch?.[1]).toBeTruthy();
  const postRes = await httpRequestNoRedirect({
    url: `${params.serverUrl}/_meru/oidc/invite-confirm`,
    method: "POST",
    headers: {
      Cookie: `${INVITE_TX_COOKIE_NAME}=${invTx}`,
      Origin: params.serverUrl,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      csrf: csrfMatch![1]!,
      decision: params.decision ?? "accept",
    }).toString(),
  });
  return { postRes, cookies: extractCookies(postRes.headers) };
}

/**
 * Opens a raw WebSocket handshake to `/v1/ws` and resolves close code/reason when closed by server.
 */
function connectRawWebSocket(params: {
  serverUrl: string;
  cookieHeader: string;
}): Promise<{
  closePromise: Promise<{ code: number; reason: string }>;
  destroy: () => void;
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(params.serverUrl);
    const sock = net.createConnection(
      { host: parsed.hostname, port: Number(parsed.port) },
      () => {
        const wsKey = crypto.randomBytes(16).toString("base64");
        sock.write(
          [
            `GET /v1/ws HTTP/1.1`,
            `Host: ${parsed.host}`,
            `Origin: ${parsed.origin}`,
            `Cookie: ${params.cookieHeader}`,
            `Upgrade: websocket`,
            `Connection: Upgrade`,
            `Sec-WebSocket-Key: ${wsKey}`,
            `Sec-WebSocket-Version: 13`,
            `\r\n`,
          ].join("\r\n"),
        );
      },
    );
    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    let resolveClose!: (v: { code: number; reason: string }) => void;
    const closePromise = new Promise<{ code: number; reason: string }>((r) => {
      resolveClose = r;
    });

    sock.on("error", (err) => {
      if (!handshakeDone) reject(err);
    });
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshakeDone) {
        const sep = buf.indexOf("\r\n\r\n");
        if (sep === -1) return;
        const headerStr = buf.subarray(0, sep).toString("utf8");
        if (!headerStr.startsWith("HTTP/1.1 101")) {
          reject(new Error(`WS handshake rejected: ${headerStr.split("\r\n")[0]}`));
          sock.destroy();
          return;
        }
        handshakeDone = true;
        buf = buf.subarray(sep + 4);
        resolve({ closePromise, destroy: () => sock.destroy() });
      }
      // Parse server frames looking for close opcode (0x8)
      while (buf.length >= 2) {
        const opcode = buf[0]! & 0x0f;
        let len = buf[1]! & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        }
        if (buf.length < offset + len) return;
        const payload = buf.subarray(offset, offset + len);
        buf = buf.subarray(offset + len);
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
          resolveClose({ code, reason });
          sock.destroy();
          return;
        }
      }
    });
    sock.on("close", () => {
      resolveClose({ code: 1006, reason: "closed" });
    });
  });
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.close().catch(() => {});
  }
  while (openMockIdps.length > 0) {
    await openMockIdps.pop()!.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v0.6.0 Standard OIDC SSO, Single-Use Invites, Self-Issued Device-Code Login & Security Red-Lines", () => {
  it("1. Invite onboarding (explicit confirmation page + already-bound notice) + SameSite=Strict HTTP 200 bounce + used/expired/revoked invite rejection", async () => {
    const idp = await startMockOidcIdp();
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v060-invite-"),
      host: "127.0.0.1",
      port: 0,
      oidc: {
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        trustIssuer: false,
      },
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    // Verify sanitizeReturnTo strictly blocks open redirects
    expect(sanitizeReturnTo("/projects/meru?entry=rec_1")).toBe(
      "/projects/meru?entry=rec_1",
    );
    expect(sanitizeReturnTo("https://evil.example.com")).toBe("/");
    expect(sanitizeReturnTo("//evil.example.com/phish")).toBe("/");
    expect(sanitizeReturnTo("/\\evil.example.com")).toBe("/");

    // /_meru/session advertises OIDC enabled
    const preSess = (await (await fetch(`${srv.url}/_meru/session`)).json()) as {
      authenticated: boolean;
      oidcEnabled: boolean;
      oidcLoginUrl: string;
    };
    expect(preSess.authenticated).toBe(false);
    expect(preSess.oidcEnabled).toBe(true);
    expect(preSess.oidcLoginUrl).toBe("/_meru/oidc/login");

    // Uninvited user MUST be rejected when trustIssuer=false
    idp.setNextUser({ sub: "sub-stranger", email: "stranger@example.com" });
    const uninvited = await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`);
    expect(uninvited.step3.status).toBe(403);
    expect(uninvited.cookies[UI_SESSION_COOKIE_NAME]).toBeUndefined();

    // Admin creates single-use invite for alice
    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    const invResp = await fetch(`${srv.url}/v1/invites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        actorId: "alice",
        actorKind: "human",
        ttlHours: 24,
      }),
    });
    expect(invResp.status).toBe(200);
    const invJson = (await invResp.json()) as {
      code: string;
      inviteUrl: string;
      record: { id: string };
    };
    expect(invJson.code).toMatch(/^mm_inv_/);

    // Alice opens invite link -> lands on explicit Invite Confirmation page (NOT auto-bound on GET!)
    idp.setNextUser({
      sub: "sub-alice-001",
      email: "alice@example.com",
      name: "Alice Lin",
      preferred_username: "alice",
    });
    const loginRes = await performOidcLoginFlow(
      `${srv.url}/_meru/oidc/login?invite=${encodeURIComponent(invJson.code)}&return_to=${encodeURIComponent("/projects/meru?entry=rec_1")}`,
    );
    expect(loginRes.step3.status).toBe(200);
    expect(loginRes.step3.headers["referrer-policy"]).toBe("same-origin");
    expect(loginRes.step3.body).toContain("Confirm Invitation");
    expect(loginRes.step3.body).toContain("/_meru/oidc/invite-confirm");
    expect(loginRes.cookies[UI_SESSION_COOKIE_NAME]).toBeUndefined();
    // Invite is STILL unused until user explicitly POSTs accept!
    expect(srv.engine.db.getIdentityBySubject(srv.orgId, idp.issuer, "sub-alice-001")).toBeNull();

    // Alice clicks Accept & Join -> HTTP 200 same-origin bounce + SameSite=Strict Cookie!
    const confirmed = await confirmInviteAcceptance({
      serverUrl: srv.url,
      callbackRes: loginRes.step3,
    });
    expect(confirmed.postRes.status).toBe(200);
    expect(confirmed.postRes.body).toContain('http-equiv="refresh"');
    expect(confirmed.postRes.body).toContain("/projects/meru?entry=rec_1");
    const setCookies = getSetCookieLines(confirmed.postRes.headers);
    const sessionLine =
      setCookies.find((c) => c.startsWith(`${UI_SESSION_COOKIE_NAME}=`)) ?? "";
    expect(sessionLine).toContain("HttpOnly");
    expect(sessionLine).toContain("SameSite=Strict");
    const aliceCookie = `${UI_SESSION_COOKIE_NAME}=${confirmed.cookies[UI_SESSION_COOKIE_NAME]}`;

    // Immediate first screen after bounce is authenticated!
    const whoResp = await fetch(`${srv.url}/v1/whoami`, {
      headers: { Cookie: aliceCookie },
    });
    expect(whoResp.status).toBe(200);
    const whoJson = (await whoResp.json()) as {
      actor: { id: string; kind: string };
    };
    expect(whoJson.actor.id).toBe("alice");
    expect(whoJson.actor.kind).toBe("human");

    // Already-bound user clicking a second invite link gets explicit notice and does NOT consume the invite!
    const unusedInv = (await (
      await fetch(`${srv.url}/v1/invites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminTok.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ actorId: "frank", actorKind: "human" }),
      })
    ).json()) as { code: string; record: { id: string } };
    const alreadyBoundClick = await performOidcLoginFlow(
      `${srv.url}/_meru/oidc/login?invite=${encodeURIComponent(unusedInv.code)}`,
    );
    expect(alreadyBoundClick.step3.status).toBe(200);
    expect(alreadyBoundClick.step3.body).toContain("Already linked");
    expect(alreadyBoundClick.step3.body).toContain("not");
    expect(srv.engine.db.getInvite(srv.orgId, unusedInv.record.id)?.usedAt).toBeNull();

    // Cookie session CANNOT create invites or disable actors (403)
    const cookieInv = await fetch(`${srv.url}/v1/invites`, {
      method: "POST",
      headers: {
        Cookie: aliceCookie,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actorId: "hacker", actorKind: "human" }),
    });
    expect(cookieInv.status).toBe(403);

    // Negative #4a: Replaying ALREADY-USED invite code with a second subject MUST fail (403)
    idp.setNextUser({ sub: "sub-bob-replay", email: "bob@example.com" });
    const replay = await performOidcLoginFlow(
      `${srv.url}/_meru/oidc/login?invite=${encodeURIComponent(invJson.code)}`,
    );
    expect(replay.step3.status).toBe(403);

    // Negative #4b: Revoked invite MUST fail (403)
    const inv2 = (await (
      await fetch(`${srv.url}/v1/invites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminTok.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ actorId: "carol", actorKind: "human" }),
      })
    ).json()) as { code: string; record: { id: string } };
    await fetch(`${srv.url}/v1/invites/revoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inviteId: inv2.record.id }),
    });
    idp.setNextUser({ sub: "sub-carol", email: "carol@example.com" });
    const revokedAttempt = await performOidcLoginFlow(
      `${srv.url}/_meru/oidc/login?invite=${encodeURIComponent(inv2.code)}`,
    );
    expect(revokedAttempt.step3.status).toBe(403);

    // Negative #4c: Expired invite MUST fail (403)
    const expCode = `mm_inv_${crypto.randomBytes(16).toString("hex")}`;
    srv.engine.db.insertInvite({
      id: "inv_expired_test",
      orgId: srv.orgId,
      codeHash: crypto.createHash("sha256").update(expCode, "utf8").digest("hex"),
      actorId: "dave",
      actorKind: "human",
      boundRealmId: null,
      createdBy: "admin",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      usedAt: null,
      usedByIssuer: null,
      usedBySubject: null,
      revokedAt: null,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });
    idp.setNextUser({ sub: "sub-dave", email: "dave@example.com" });
    const expiredAttempt = await performOidcLoginFlow(
      `${srv.url}/_meru/oidc/login?invite=${encodeURIComponent(expCode)}`,
    );
    expect(expiredAttempt.step3.status).toBe(403);
  });

  it("2. Security Red-Line #1 + P1-3: Same email with different (iss, sub), reserved names, pending invites, and historical authors MUST NEVER be hijacked under trustIssuer=true", async () => {
    const idp = await startMockOidcIdp();
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v060-email-hijack-"),
      host: "127.0.0.1",
      port: 0,
      oidc: {
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        trustIssuer: true,
      },
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    // Seed a historical record written by local actor "founder" (who has NO token or identity row!)
    const rootRealm = srv.engine.db.getRealmByPath(srv.orgId, "/")!;
    await srv.engine.ledger.appendRecord({
      actor: { id: "founder", kind: "human" },
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Founder decision",
      payload: { body: "Written locally before OIDC existed." },
    });
    // Seed a pending unused invite reserving "reserved-bob"
    await fetch(`${srv.url}/v1/invites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actorId: "reserved-bob", actorKind: "human" }),
    });

    // Legitimate Alice provisions first via trustIssuer=true
    idp.setNextUser({
      sub: "sub-alice-original",
      email: "alice@example.com",
      preferred_username: "alice",
    });
    const first = await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`);
    expect(first.step3.status).toBe(200);
    const aliceCookie = `${UI_SESSION_COOKIE_NAME}=${first.cookies[UI_SESSION_COOKIE_NAME]}`;
    const who1 = (await (
      await fetch(`${srv.url}/v1/whoami`, { headers: { Cookie: aliceCookie } })
    ).json()) as { actor: { id: string } };
    expect(who1.actor.id).toBe("alice");

    // Attacker A: SAME email + preferred_username, DIFFERENT sub -> 403!
    idp.setNextUser({
      sub: "sub-attacker-impostor",
      email: "alice@example.com",
      preferred_username: "alice",
    });
    const impostor = await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`);
    expect(impostor.step3.status).toBe(403);
    expect(impostor.cookies[UI_SESSION_COOKIE_NAME]).toBeUndefined();

    // Attacker B: tries to claim historical local author "founder" -> 403!
    idp.setNextUser({
      sub: "sub-attacker-founder",
      email: "founder@evil.com",
      preferred_username: "founder",
    });
    expect((await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`)).step3.status).toBe(403);

    // Attacker C: tries to claim pending-invited name "reserved-bob" -> 403!
    idp.setNextUser({
      sub: "sub-attacker-bob",
      email: "bob@evil.com",
      preferred_username: "reserved-bob",
    });
    expect((await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`)).step3.status).toBe(403);

    // Attacker D: tries reserved names ("system", "admin", "..") -> 403!
    for (const badName of ["system", "admin", ".."]) {
      idp.setNextUser({
        sub: `sub-attacker-${badName}`,
        preferred_username: badName,
      });
      expect((await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`)).step3.status).toBe(403);
    }
  });

  it("3. Security Red-Line #2 + T1 Mutation A Guard + Cascade + Immediate WS Close: actor disable revokes tokens/sessions/invites/agent-tokens/WS and blocks direct disabled_actors state", async () => {
    const idp = await startMockOidcIdp();
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v060-disable-"),
      host: "127.0.0.1",
      port: 0,
      oidc: {
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        trustIssuer: true,
      },
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    idp.setNextUser({
      sub: "sub-bob-live",
      email: "bob@example.com",
      preferred_username: "bob",
    });
    const login = await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`);
    expect(login.step3.status).toBe(200);
    const bobCookie = `${UI_SESSION_COOKIE_NAME}=${login.cookies[UI_SESSION_COOKIE_NAME]}`;
    const bobTok = srv.createToken({ actorId: "bob", actorKind: "human" });
    // Promote bob to admin explicitly (v0.6.1: trustIssuer auto-provision creates member, not admin)
    const promoteBob = await fetch(`${srv.url}/v1/actors/role`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actorId: "bob", role: "admin" }),
    });
    expect(promoteBob.status).toBe(200);

    // Bob creates an unused invite and a delegated agent token before being disabled (P1-2!)
    const bobInv = (await (
      await fetch(`${srv.url}/v1/invites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bobTok.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ actorId: "bob-backdoor", actorKind: "human" }),
      })
    ).json()) as { code: string };
    const bobAgentTok = srv.createToken({
      actorId: "bob-agent",
      actorKind: "agent",
      createdBy: "bob",
    });

    // Open a live WebSocket as Bob BEFORE disable (P1-7!)
    const bobWs = await connectRawWebSocket({
      serverUrl: srv.url,
      cookieHeader: bobCookie,
    });

    // BEFORE disable: Bearer, Cookie, and delegated agent token return 200
    expect(
      (await fetch(`${srv.url}/v1/whoami`, { headers: { Authorization: `Bearer ${bobTok.token}` } })).status,
    ).toBe(200);
    expect(
      (await fetch(`${srv.url}/v1/whoami`, { headers: { Cookie: bobCookie } })).status,
    ).toBe(200);
    expect(
      (await fetch(`${srv.url}/v1/whoami`, { headers: { Authorization: `Bearer ${bobAgentTok.token}` } })).status,
    ).toBe(200);

    // Self-disable MUST be rejected (400)
    const selfDisable = await fetch(`${srv.url}/v1/actors/disable`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actorId: "admin" }),
    });
    expect(selfDisable.status).toBe(400);

    // Admin disables bob
    const disResp = await fetch(`${srv.url}/v1/actors/disable`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actorId: "bob", reason: "left company" }),
    });
    expect(disResp.status).toBe(200);
    const disJson = (await disResp.json()) as {
      disabled: boolean;
      revokedTokens: number;
      revokedAgentTokens: number;
      revokedInvites: number;
      revokedSessions: number;
      closedWebSockets: number;
    };
    expect(disJson.disabled).toBe(true);
    expect(disJson.revokedTokens).toBeGreaterThanOrEqual(1);
    expect(disJson.revokedAgentTokens).toBeGreaterThanOrEqual(1);
    expect(disJson.revokedInvites).toBeGreaterThanOrEqual(1);
    expect(disJson.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(disJson.closedWebSockets).toBeGreaterThanOrEqual(1);

    // Live WebSocket MUST be closed immediately with 4001!
    const wsClose = await Promise.race([
      bobWs.closePromise,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("WS was not closed on disable")), 2000),
      ),
    ]);
    expect(wsClose.code).toBe(4001);

    // IMMEDIATELY AFTER disable: Bearer, Cookie, delegated agent token -> 401; pre-created invite -> 403!
    expect(
      (await fetch(`${srv.url}/v1/whoami`, { headers: { Authorization: `Bearer ${bobTok.token}` } })).status,
    ).toBe(401);
    expect(
      (await fetch(`${srv.url}/v1/whoami`, { headers: { Cookie: bobCookie } })).status,
    ).toBe(401);
    expect(
      (await fetch(`${srv.url}/v1/whoami`, { headers: { Authorization: `Bearer ${bobAgentTok.token}` } })).status,
    ).toBe(401);
    idp.setNextUser({ sub: "sub-backdoor-attempt", email: "evil@example.com" });
    expect(
      (await performOidcLoginFlow(`${srv.url}/_meru/oidc/login?invite=${encodeURIComponent(bobInv.code)}`)).step3.status,
    ).toBe(403);

    // Re-attempting OIDC login as disabled bob MUST fail (403)
    idp.setNextUser({ sub: "sub-bob-live", email: "bob@example.com", preferred_username: "bob" });
    expect((await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`)).step3.status).toBe(403);

    // ---- Direct `db.isActorDisabled(...)` Enforcement Test (Independent of Bulk Token/Session Revocation!) ----
    // Exercises BOTH `resolvePrincipalFromToken` and `isPrincipalTokenActive` directly when `disabled_actors`
    // is populated while tokens & in-memory UI sessions remain unrevoked (e.g., offline CLI disable / multi-reader).
    const directTok = srv.createToken({ actorId: "charlie", actorKind: "human" });
    const directSession = srv.uiSessions.createSessionForPrincipal(
      {
        tokenId: null,
        orgId: srv.orgId,
        actor: { id: "charlie", kind: "human" },
        boundRealmId: srv.engine.db.getRealmByPath(srv.orgId, "/")!.id,
        boundSource: "test",
        authKind: "cookie",
      },
      srv.engine.db,
    );
    const directCookie = `${UI_SESSION_COOKIE_NAME}=${directSession.sessionId}`;
    // Confirm both active BEFORE inserting into disabled_actors
    expect(
      (await fetch(`${srv.url}/v1/whoami`, { headers: { Authorization: `Bearer ${directTok.token}` } })).status,
    ).toBe(200);
    expect(
      (await fetch(`${srv.url}/v1/whoami`, { headers: { Cookie: directCookie } })).status,
    ).toBe(200);

    // Insert ONLY into disabled_actors (do NOT revoke token in SQLite and do NOT call revokeSessionsForActor!)
    const rawSqlite = (srv.engine.db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    rawSqlite
      .prepare(
        `INSERT INTO disabled_actors (org_id, actor_id, reason, disabled_by, disabled_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(srv.orgId, "charlie", "direct-db-test", "admin", new Date().toISOString());

    // BOTH unrevoked Bearer token AND live unrevoked Cookie session MUST IMMEDIATELY fail!
    expect(
      (await fetch(`${srv.url}/v1/whoami`, { headers: { Authorization: `Bearer ${directTok.token}` } })).status,
    ).toBe(401);
    const directSessResp = (await (
      await fetch(`${srv.url}/_meru/session`, { headers: { Cookie: directCookie } })
    ).json()) as { authenticated: boolean };
    expect(directSessResp.authenticated).toBe(false);
    expect(
      (await fetch(`${srv.url}/v1/whoami`, { headers: { Cookie: directCookie } })).status,
    ).toBe(401);
  });

  it("4. Security Red-Line #3 + #5 + P0-1/P1-5/P1-6/P1-9: Device-code flow sends Referrer-Policy: same-origin, rejects Origin: null & missing auth_time & UI cookie, enforces HTTPS in CLI, and writes 0600 credentials", async () => {
    const idp = await startMockOidcIdp();
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v060-device-"),
      host: "127.0.0.1",
      port: 0,
      oidc: {
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        trustIssuer: true,
      },
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    // First, Alice gets a normal browser UI session cookie
    idp.setNextUser({
      sub: "sub-alice-dev",
      email: "alice@example.com",
      preferred_username: "alice",
    });
    const uiLogin = await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`);
    expect(uiLogin.step3.status).toBe(200);
    const uiCookie = `${UI_SESSION_COOKIE_NAME}=${uiLogin.cookies[UI_SESSION_COOKIE_NAME]}`;

    // Start a device code (include bidi/control chars in hostname to test strict ASCII sanitization!)
    const startRes = (await (
      await fetch(`${srv.url}/_meru/device/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname: "dev\u202Ebox<>1",
          clientLabel: "claude-code",
          kind: "agent",
        }),
      })
    ).json()) as { deviceCode: string; userCode: string };
    expect(startRes.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // P1-5: Unverified manual code page uses same-origin action="/_meru/device" and Referrer-Policy: same-origin!
    const manualDevPage = await httpRequestNoRedirect({
      url: `${srv.url}/_meru/device`,
    });
    expect(manualDevPage.status).toBe(200);
    expect(manualDevPage.headers["referrer-policy"]).toBe("same-origin");
    expect(manualDevPage.body).toContain('action="/_meru/device"');
    expect(manualDevPage.body).not.toContain('action="/_meru/oidc/login"');

    // P1-6: Cross-site GET /_meru/device?code=... MUST NOT prefill the code!
    const crossSiteDevPage = await httpRequestNoRedirect({
      url: `${srv.url}/_meru/device?code=${encodeURIComponent(startRes.userCode)}`,
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSiteDevPage.status).toBe(200);
    expect(crossSiteDevPage.body).not.toContain(startRes.userCode);

    // Attack A: Trying to approve device code with ONLY the UI cookie MUST return 401!
    const hijackApprove = await httpRequestNoRedirect({
      url: `${srv.url}/_meru/device/approve`,
      method: "POST",
      headers: {
        Cookie: uiCookie,
        Origin: srv.url,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code: startRes.userCode,
        csrf: "forged",
      }).toString(),
    });
    expect(hijackApprove.status).toBe(401);

    // P0-1: Origin: null or Sec-Fetch-Site: cross-site MUST return 403!
    const nullOriginApprove = await httpRequestNoRedirect({
      url: `${srv.url}/_meru/device/approve`,
      method: "POST",
      headers: {
        Cookie: uiCookie,
        Origin: "null",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code: startRes.userCode, csrf: "x" }).toString(),
    });
    expect(nullOriginApprove.status).toBe(403);

    // Attack B: GET /_meru/device with UI cookie MUST NOT trust UI cookie or show Approve form
    const devPageWithUiCookie = await httpRequestNoRedirect({
      url: `${srv.url}/_meru/device?code=${encodeURIComponent(startRes.userCode)}`,
      headers: { Cookie: uiCookie },
    });
    expect(devPageWithUiCookie.status).toBe(200);
    expect(devPageWithUiCookie.headers["referrer-policy"]).toBe("same-origin");
    expect(devPageWithUiCookie.body).toContain("Verify with SSO");
    expect(devPageWithUiCookie.body).not.toContain("/_meru/device/approve");
    expect(devPageWithUiCookie.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );

    // Attack C1: Stale auth_time (> 90s old) during fresh device OIDC flow MUST be rejected!
    idp.setNextUser({
      sub: "sub-alice-dev",
      email: "alice@example.com",
      preferred_username: "alice",
      authTimeSec: Math.floor(Date.now() / 1000) - 600,
    });
    const staleFlow = await performOidcLoginFlow(
      `${srv.url}/_meru/oidc/login?flow=device&code=${encodeURIComponent(startRes.userCode)}`,
    );
    expect(idp.getLastAuthorizeParams()?.get("max_age")).toBe("0");
    expect(idp.getLastAuthorizeParams()?.get("prompt")).toBe("login");
    expect([400, 403]).toContain(staleFlow.step3.status);
    expect(staleFlow.cookies[DEVICE_TX_COOKIE_NAME]).toBeUndefined();

    // Attack C2: Missing auth_time claim MUST be rejected!
    idp.setNextUser({
      sub: "sub-alice-dev",
      email: "alice@example.com",
      preferred_username: "alice",
      authTimeSec: null,
    });
    const missingAuthTimeFlow = await performOidcLoginFlow(
      `${srv.url}/_meru/oidc/login?flow=device&code=${encodeURIComponent(startRes.userCode)}`,
    );
    expect([400, 403]).toContain(missingAuthTimeFlow.step3.status);
    expect(missingAuthTimeFlow.cookies[DEVICE_TX_COOKIE_NAME]).toBeUndefined();

    // P1-9: CLI MUST refuse remote http:// URLs!
    await expect(
      execFileAsync(process.execPath, [
        path.resolve("dist/cli.js"),
        "login",
        "--url",
        "http://mind.remote-example.com",
      ]),
    ).rejects.toThrow(/https/i);

    // Real CLI `meru-mind login` E2E flow with fresh auth_time + 0600 credentials file!
    const credDir = makeTempDir("meru-v060-creds-");
    const credFile = path.join(credDir, "credentials");
    idp.setNextUser({
      sub: "sub-alice-dev",
      email: "alice@example.com",
      preferred_username: "alice",
      authTimeSec: Math.floor(Date.now() / 1000),
    });

    const cliChild = execFileAsync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "login",
        "--url",
        srv.url,
        "--kind",
        "agent",
        "--label",
        "ssh-box",
        "--timeout",
        "15",
        "--json",
      ],
      {
        env: {
          ...process.env,
          MERU_MIND_CREDENTIALS_FILE: credFile,
        },
      },
    );

    let discoveredUserCode = "";
    cliChild.child.stderr?.on("data", (chunk: Buffer | string) => {
      const m = /Verification code:\s*([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(
        String(chunk),
      );
      if (m) discoveredUserCode = m[1]!;
    });

    const waitDeadline = Date.now() + 5000;
    while (!discoveredUserCode && Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(discoveredUserCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Complete fresh OIDC round-trip for the CLI's device code
    const freshDeviceOidc = await performOidcLoginFlow(
      `${srv.url}/_meru/oidc/login?flow=device&code=${encodeURIComponent(discoveredUserCode)}`,
    );
    expect(freshDeviceOidc.step3.status).toBe(200);
    const devTxCookie = `${DEVICE_TX_COOKIE_NAME}=${freshDeviceOidc.cookies[DEVICE_TX_COOKIE_NAME]}`;

    // Load confirmation page and check Referrer-Policy, IP display, unverified warning, and CSRF token
    const confirmPage = await httpRequestNoRedirect({
      url: `${srv.url}/_meru/device?code=${encodeURIComponent(discoveredUserCode)}`,
      headers: { Cookie: devTxCookie },
    });
    expect(confirmPage.status).toBe(200);
    expect(confirmPage.headers["referrer-policy"]).toBe("same-origin");
    expect(confirmPage.body).toContain(discoveredUserCode);
    expect(confirmPage.body).toContain("ssh-box");
    expect(confirmPage.body).toContain("Request IP");
    expect(confirmPage.body).toContain("self-reported");
    const csrfMatch = /name="csrf"\s+value="([^"]+)"/.exec(confirmPage.body);
    expect(csrfMatch?.[1]).toBeTruthy();

    // Attack D: Submitting mismatched code B with freshDeviceTx bound to code A MUST fail (403)!
    const mismatchApprove = await httpRequestNoRedirect({
      url: `${srv.url}/_meru/device/approve`,
      method: "POST",
      headers: {
        Cookie: devTxCookie,
        Origin: srv.url,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code: startRes.userCode,
        csrf: csrfMatch![1]!,
      }).toString(),
    });
    expect(mismatchApprove.status).toBe(403);

    // Legitimate Approve for discoveredUserCode
    const approved = await httpRequestNoRedirect({
      url: `${srv.url}/_meru/device/approve`,
      method: "POST",
      headers: {
        Cookie: devTxCookie,
        Origin: srv.url,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code: discoveredUserCode,
        csrf: csrfMatch![1]!,
      }).toString(),
    });
    expect(approved.status).toBe(200);

    // Wait for CLI to pick up token and write 0600 credentials file!
    const { stdout: loginStdout } = await cliChild;
    expect(loginStdout).not.toContain("mm_live_");
    const loginJson = JSON.parse(loginStdout) as {
      authenticated: boolean;
      actorId: string;
      actorKind: string;
      expiresAt: string;
      credentialsPath: string;
    };
    expect(loginJson.authenticated).toBe(true);
    expect(loginJson.actorId).toBe("alice");
    expect(loginJson.actorKind).toBe("agent");
    const ttlDays =
      (Date.parse(loginJson.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(ttlDays).toBeGreaterThan(89);
    expect(ttlDays).toBeLessThan(91);

    const mode = fs.statSync(credFile).mode & 0o777;
    expect(mode).toBe(0o600);

    // Subsequent CLI call works automatically via saved credentials WITHOUT passing --token!
    const { stdout: whoamiStdout } = await execFileAsync(
      process.execPath,
      [path.resolve("dist/cli.js"), "whoami", "--url", srv.url, "--json"],
      {
        env: {
          ...process.env,
          MERU_MIND_CREDENTIALS_FILE: credFile,
          MERU_MIND_TOKEN: "",
        },
      },
    );
    const whoamiJson = JSON.parse(whoamiStdout) as {
      actor: { id: string; kind: string };
    };
    expect(whoamiJson.actor.id).toBe("alice");
    expect(whoamiJson.actor.kind).toBe("agent");

    // Overly permissive credentials file (0644) MUST be rejected by readCredentialsFile!
    if (process.platform !== "win32") {
      fs.chmodSync(credFile, 0o644);
      expect(() =>
        readCredentialsFile({ MERU_MIND_CREDENTIALS_FILE: credFile }),
      ).toThrow(/chmod 600/i);
      fs.chmodSync(credFile, 0o600);
    }

    // Token Expiry Check: an expired token strictly returns 401 with `meru-mind login` hint
    const expiredTok = srv.createToken({
      actorId: "alice",
      actorKind: "human",
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });
    const expResp = await fetch(`${srv.url}/v1/whoami`, {
      headers: { Authorization: `Bearer ${expiredTok.token}` },
    });
    expect(expResp.status).toBe(401);
    const expBody = (await expResp.json()) as { message: string; try?: string };
    expect(expBody.message).toMatch(/expired/i);
    expect(expBody.try).toContain("meru-mind login");
  });

  it("5. Security Red-Line #6: Swapping MERU_OIDC_ISSUER requires zero schema changes and rejects old (iss, sub) until explicitly re-bound", async () => {
    const sharedHome = makeTempDir("meru-v060-swap-idp-");
    const idp1 = await startMockOidcIdp({
      clientId: "client-a",
      clientSecret: "sec-a",
    });

    const srv1 = await startMindServer({
      homeDir: sharedHome,
      host: "127.0.0.1",
      port: 0,
      oidc: {
        issuer: idp1.issuer,
        clientId: idp1.clientId,
        clientSecret: idp1.clientSecret,
        trustIssuer: false,
      },
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv1);

    const adminTok = srv1.createToken({ actorId: "admin", actorKind: "human" });
    const inv1 = (await (
      await fetch(`${srv1.url}/v1/invites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminTok.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ actorId: "alice", actorKind: "human" }),
      })
    ).json()) as { code: string };

    idp1.setNextUser({ sub: "same-sub-999", email: "alice@example.com" });
    const login1 = await performOidcLoginFlow(
      `${srv1.url}/_meru/oidc/login?invite=${encodeURIComponent(inv1.code)}`,
    );
    expect(login1.step3.status).toBe(200);
    const conf1 = await confirmInviteAcceptance({
      serverUrl: srv1.url,
      callbackRes: login1.step3,
    });
    expect(conf1.postRes.status).toBe(200);
    await srv1.close();
    openServers.pop();

    // Swap to completely different IdP #2 on the EXACT same SQLite homeDir (zero schema/code change!)
    const idp2 = await startMockOidcIdp({
      clientId: "client-b",
      clientSecret: "sec-b",
    });
    const srv2 = await startMindServer({
      homeDir: sharedHome,
      host: "127.0.0.1",
      port: 0,
      oidc: {
        issuer: idp2.issuer,
        clientId: idp2.clientId,
        clientSecret: idp2.clientSecret,
        trustIssuer: false,
      },
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv2);

    // Same `sub` from IdP #2 does NOT match `(idp1.issuer, "same-sub-999")` -> 403!
    idp2.setNextUser({ sub: "same-sub-999", email: "alice@example.com" });
    const swappedUninvited = await performOidcLoginFlow(
      `${srv2.url}/_meru/oidc/login`,
    );
    expect(swappedUninvited.step3.status).toBe(403);
    expect(swappedUninvited.step3.body).toMatch(/invite|not linked/i);

    // Re-binding with a fresh invite works cleanly with zero migration
    const inv2 = (await (
      await fetch(`${srv2.url}/v1/invites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminTok.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ actorId: "alice", actorKind: "human" }),
      })
    ).json()) as { code: string };
    const swappedRebound = await performOidcLoginFlow(
      `${srv2.url}/_meru/oidc/login?invite=${encodeURIComponent(inv2.code)}`,
    );
    expect(swappedRebound.step3.status).toBe(200);
    const conf2 = await confirmInviteAcceptance({
      serverUrl: srv2.url,
      callbackRes: swappedRebound.step3,
    });
    expect(conf2.postRes.status).toBe(200);
  });

  it("6. P0-2 Anti-DoS (stateless AEAD OIDC tx + per-IP device quota), P1-1 Realm-Scoped Human AuthZ, and Pocket ID v2 / Dex v2.46 Compose hygiene", async () => {
    const idp = await startMockOidcIdp();
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v060-dos-authz-"),
      host: "127.0.0.1",
      port: 0,
      oidc: {
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        trustIssuer: true,
      },
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    // P0-2a: Non-navigation browser requests (e.g. <img src="/_meru/oidc/login">) MUST be blocked (403)
    const imgAbuse = await httpRequestNoRedirect({
      url: `${srv.url}/_meru/oidc/login`,
      headers: { "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" },
    });
    expect(imgAbuse.status).toBe(403);

    // P0-2b: 600 anonymous GET /_meru/oidc/login requests MUST allocate ZERO server slots and NEVER lock out a real login!
    for (let i = 0; i < 600; i += 1) {
      const r = await httpRequestNoRedirect({ url: `${srv.url}/_meru/oidc/login` });
      expect(r.status).toBe(302);
    }
    idp.setNextUser({ sub: "sub-legit-after-flood", email: "legit@example.com", preferred_username: "legit" });
    const afterFlood = await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`);
    expect(afterFlood.step3.status).toBe(200);

    // P0-2c: /_meru/device/start rejects non-JSON Content-Type (415) and browser Origin header (403)
    const badCt = await fetch(`${srv.url}/_meru/device/start`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hostname=evil",
    });
    expect(badCt.status).toBe(415);
    const badOrigin = await fetch(`${srv.url}/_meru/device/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ hostname: "evil" }),
    });
    expect(badOrigin.status).toBe(403);

    // P0-2d: Per-IP quota caps one flooding IP (429 after 8 pending) while another IP STILL succeeds (200)!
    for (let i = 0; i < 8; i += 1) {
      const ok = await fetch(`${srv.url}/_meru/device/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Real-IP": "198.51.100.10",
        },
        body: JSON.stringify({ hostname: `attacker-${i}` }),
      });
      expect(ok.status).toBe(200);
    }
    const attacker9 = await fetch(`${srv.url}/_meru/device/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Real-IP": "198.51.100.10",
      },
      body: JSON.stringify({ hostname: "attacker-9" }),
    });
    expect(attacker9.status).toBe(429);
    const victimFromOtherIp = await fetch(`${srv.url}/_meru/device/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Real-IP": "203.0.113.42",
      },
      body: JSON.stringify({ hostname: "victim-laptop" }),
    });
    expect(victimFromOtherIp.status).toBe(200);

    // P1-1: Realm-scoped human (/team-a) MUST be blocked (403) from org-admin routes & token minting!
    const rootRealm = srv.engine.db.getRealmByPath(srv.orgId, "/")!;
    const teamA = srv.engine.ledger.createRealm({
      orgId: srv.orgId,
      parentId: rootRealm.id,
      slug: "team-a",
      name: "Team A",
      actor: { id: "admin", kind: "human" },
    });
    const scopedHumanTok = srv.createToken({
      actorId: "scoped-alice",
      actorKind: "human",
      boundRealmId: teamA.id,
    });
    for (const [method, endpoint, body] of [
      ["POST", "/v1/invites", { actorId: "hijack", actorKind: "human" }],
      ["GET", "/v1/identities", undefined],
      ["POST", "/v1/actors/disable", { actorId: "legit" }],
      ["POST", "/v1/tokens", { actorId: "root-bot", actorKind: "human" }],
    ] as const) {
      const r = await fetch(`${srv.url}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${scopedHumanTok.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(r.status).toBe(403);
    }

    // P1-8: Pocket ID v2 and Dex v2.46+ Docker Compose hygiene & Caddy escaping check
    const pocketId = fs.readFileSync(
      path.resolve("deploy/docker-compose.oidc-pocketid.yml"),
      "utf8",
    );
    const dex = fs.readFileSync(
      path.resolve("deploy/docker-compose.oidc-dex.yml"),
      "utf8",
    );
    expect(pocketId).toContain("ghcr.io/pocket-id/pocket-id:v2");
    expect(pocketId).toContain("APP_URL:");
    expect(pocketId).toContain("ENCRYPTION_KEY:");
    expect(pocketId).toContain("/app/data");
    expect(pocketId).toContain("pocket-id:1411");
    expect(pocketId).toContain("{$$MERU_DOMAIN}");
    expect(pocketId).toContain("{$$OIDC_DOMAIN}");
    expect(dex).toContain("ghcr.io/dexidp/dex:v2.46.0");
    expect(dex).toContain("{$$MERU_DOMAIN}");
    expect(dex).toContain("{$$OIDC_DOMAIN}");
    expect(dex).toContain("SECURITY WARNING");
  });
});
