import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import * as jose from "jose";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_JS_SOURCE,
  DEFAULT_SHELL_CSS,
  DEFAULT_SHELL_JS,
  INVITE_TX_COOKIE_NAME,
  MAX_PENDING_DEVICE_CODES_GLOBAL,
  normalizeIpRateLimitKey,
  OIDC_TX_COOKIE_PREFIX,
  sanitizeDisplayName,
  SqliteDb,
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
  authTimeSec?: number | null;
}

interface MockOidcIdpHandle {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  setNextUser(user: MockOidcUser): void;
  close(): Promise<void>;
}

async function startMockOidcIdp(): Promise<MockOidcIdpHandle> {
  const clientId = "meru-v061-client";
  const clientSecret = "meru-v061-secret";
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = await jose.exportJWK(publicKey);
  const kid = `kid-${crypto.randomBytes(4).toString("hex")}`;
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = "RS256";

  let nextUser: MockOidcUser = {
    sub: "sub-default",
    email: "default@example.com",
    name: "Default User",
    preferred_username: "default-user",
  };
  const authCodes = new Map<
    string,
    {
      nonce: string | null;
      codeChallenge: string | null;
      user: MockOidcUser;
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
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
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
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const nonce = url.searchParams.get("nonce");
      const codeChallenge = url.searchParams.get("code_challenge");
      const code = `idp_code_${crypto.randomBytes(10).toString("hex")}`;
      authCodes.set(code, { nonce, codeChallenge, user: { ...nextUser } });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      res.writeHead(302, { Location: back.href });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const chunks: Buffer[] = [];
      for await (const c of req) {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      }
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
        const expected = crypto
          .createHash("sha256")
          .update(codeVerifier, "utf8")
          .digest("base64url");
        if (expected !== rec.codeChallenge) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
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
      if (rec.user.preferred_username) {
        claims.preferred_username = rec.user.preferred_username;
      }
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

async function performOidcLoginFlow(loginUrl: string) {
  const step1 = await httpRequestNoRedirect({ url: loginUrl });
  const step1Cookies = extractCookies(step1.headers);
  const oidcCookieEntry = Object.entries(step1Cookies).find(([k]) =>
    k.startsWith(OIDC_TX_COOKIE_PREFIX),
  );
  const loc1 = String(step1.headers.location ?? "");
  const step2 = await httpRequestNoRedirect({ url: loc1 });
  const loc2 = String(step2.headers.location ?? "");
  const txCookieHeader = oidcCookieEntry
    ? `${oidcCookieEntry[0]}=${oidcCookieEntry[1]}`
    : "";
  const step3 = await httpRequestNoRedirect({
    url: loc2,
    headers: txCookieHeader ? { Cookie: txCookieHeader } : {},
  });
  return {
    step1,
    step2,
    step3,
    callbackUrl: loc2,
    txCookieHeader,
    cookies: extractCookies(step3.headers),
  };
}

async function confirmInviteAcceptance(params: {
  serverUrl: string;
  callbackRes: { headers: http.IncomingHttpHeaders; body: string };
}) {
  const invCookies = extractCookies(params.callbackRes.headers);
  const invCookieVal = invCookies[INVITE_TX_COOKIE_NAME];
  const csrfMatch = /name="csrf"\s+value="([^"]+)"/.exec(
    params.callbackRes.body,
  );
  const postRes = await httpRequestNoRedirect({
    url: `${params.serverUrl}/_meru/oidc/invite-confirm`,
    method: "POST",
    headers: {
      Cookie: `${INVITE_TX_COOKIE_NAME}=${invCookieVal}`,
      Origin: params.serverUrl,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      csrf: csrfMatch?.[1] ?? "",
      decision: "accept",
    }).toString(),
  });
  return { postRes, cookies: extractCookies(postRes.headers) };
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

describe("v0.6.1 Actors Role, Editable DisplayName & Fable R2 Hardenings", () => {
  it("1. Enforces actors.role (admin vs member) across trustIssuer, invites (--role), token minting, actor set-role CLI/API, self-demotion, last-admin guard & v12->v13 backfill", async () => {
    const idp = await startMockOidcIdp();
    const homeDir = makeTempDir("meru-v061-roles-");
    const srv = await startMindServer({
      homeDir,
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

    // Bootstrap admin gets role="admin"
    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    expect(srv.engine.db.getActor(srv.orgId, "admin")?.role).toBe("admin");
    expect(srv.engine.db.countActiveAdmins(srv.orgId)).toBe(1);

    // 1a. Auto-provisioned user under trustIssuer=true ALWAYS gets role="member" (NEVER "admin")
    idp.setNextUser({
      sub: "sub-auto-alice",
      email: "alice@example.com",
      name: "Alice Auto",
      preferred_username: "alice",
    });
    const autoLogin = await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`);
    expect(autoLogin.step3.status).toBe(200);
    const aliceCookie = `${UI_SESSION_COOKIE_NAME}=${autoLogin.cookies[UI_SESSION_COOKIE_NAME]}`;
    const aliceSess = (await (
      await fetch(`${srv.url}/_meru/session`, { headers: { Cookie: aliceCookie } })
    ).json()) as { authenticated: boolean; actor: { id: string; role: string; displayName?: string } };
    expect(aliceSess.authenticated).toBe(true);
    expect(aliceSess.actor.role).toBe("member");
    expect(aliceSess.actor.displayName).toBe("Alice Auto");

    // Minting a token for existing member "alice" MUST NOT silently elevate her to admin!
    const aliceTok = srv.createToken({ actorId: "alice", actorKind: "human" });
    expect(srv.engine.db.getActor(srv.orgId, "alice")?.role).toBe("member");
    const aliceWhoami = (await (
      await fetch(`${srv.url}/v1/whoami`, {
        headers: { Authorization: `Bearer ${aliceTok.token}` },
      })
    ).json()) as { actor: { id: string; role: string; displayName?: string } };
    expect(aliceWhoami.actor.role).toBe("member");
    expect(aliceWhoami.actor.displayName).toBe("Alice Auto");

    // Member Bearer token MUST get 403 on ALL org-admin endpoints!
    for (const [method, endpoint, body] of [
      ["POST", "/v1/tokens", { actorId: "rogue", actorKind: "human" }],
      ["GET", "/v1/tokens", undefined],
      ["POST", "/v1/tokens/revoke", { tokenId: adminTok.record.id }],
      ["POST", "/v1/invites", { actorId: "rogue2", actorKind: "human" }],
      ["GET", "/v1/invites", undefined],
      ["GET", "/v1/identities", undefined],
      ["POST", "/v1/actors/disable", { actorId: "admin" }],
      ["POST", "/v1/actors/enable", { actorId: "admin" }],
      ["POST", "/v1/actors/role", { actorId: "alice", role: "admin" }],
      ["POST", "/v1/admin/backup", {}],
    ] as const) {
      const r = await fetch(`${srv.url}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${aliceTok.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(r.status, `${method} ${endpoint} should be 403 for member`).toBe(403);
    }

    // 1b. Default invite grants role="member"; explicit --role admin grants role="admin"
    const defInvResp = await fetch(`${srv.url}/v1/invites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actorId: "dave", actorKind: "human" }),
    });
    expect(defInvResp.status).toBe(200);
    const defInv = (await defInvResp.json()) as { code: string; record: { actorRole: string } };
    expect(defInv.record.actorRole).toBe("member");

    idp.setNextUser({ sub: "sub-dave", email: "dave@example.com", name: "Dave Member" });
    const daveFlow = await performOidcLoginFlow(
      `${srv.url}/_meru/oidc/login?invite=${encodeURIComponent(defInv.code)}`,
    );
    expect(daveFlow.step3.status).toBe(200);
    expect(daveFlow.step3.body).toContain("member");
    const daveConf = await confirmInviteAcceptance({
      serverUrl: srv.url,
      callbackRes: daveFlow.step3,
    });
    expect(daveConf.postRes.status).toBe(200);
    expect(srv.engine.db.getActor(srv.orgId, "dave")?.role).toBe("member");

    // Agent invite with role="admin" MUST be rejected (400)
    const badAgentInv = await fetch(`${srv.url}/v1/invites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actorId: "bot-admin", actorKind: "agent", role: "admin" }),
    });
    expect(badAgentInv.status).toBe(400);

    // Explicit role="admin" invite grants admin upon redemption
    const adminInvResp = await fetch(`${srv.url}/v1/invites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actorId: "carol", actorKind: "human", role: "admin" }),
    });
    expect(adminInvResp.status).toBe(200);
    const adminInv = (await adminInvResp.json()) as { code: string; record: { actorRole: string } };
    expect(adminInv.record.actorRole).toBe("admin");

    idp.setNextUser({ sub: "sub-carol", email: "carol@example.com", name: "Carol Admin" });
    const carolFlow = await performOidcLoginFlow(
      `${srv.url}/_meru/oidc/login?invite=${encodeURIComponent(adminInv.code)}`,
    );
    expect(carolFlow.step3.status).toBe(200);
    expect(carolFlow.step3.body).toContain("admin");
    const carolConf = await confirmInviteAcceptance({
      serverUrl: srv.url,
      callbackRes: carolFlow.step3,
    });
    expect(carolConf.postRes.status).toBe(200);
    expect(srv.engine.db.getActor(srv.orgId, "carol")?.role).toBe("admin");
    expect(srv.engine.db.countActiveAdmins(srv.orgId)).toBe(2);

    // Carol (now admin) can call org-admin endpoints using a Bearer token
    const carolTok = srv.createToken({ actorId: "carol", actorKind: "human" });
    const carolIdentities = await fetch(`${srv.url}/v1/identities`, {
      headers: { Authorization: `Bearer ${carolTok.token}` },
    });
    expect(carolIdentities.status).toBe(200);

    // 1c. Cannot demote self (400)
    const selfDemote = await fetch(`${srv.url}/v1/actors/role`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${carolTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actorId: "carol", role: "member" }),
    });
    expect(selfDemote.status).toBe(400);

    // 1d. Remote CLI `meru-mind actor set-role` promotes alice -> admin, then demotes carol -> member
    const { stdout: promoOut } = await execFileAsync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "actor",
        "set-role",
        "alice",
        "--role",
        "admin",
        "--url",
        srv.url,
        "--token",
        adminTok.token,
        "--json",
      ],
    );
    expect(JSON.parse(promoOut).role).toBe("admin");
    expect(
      (
        await fetch(`${srv.url}/v1/identities`, {
          headers: { Authorization: `Bearer ${aliceTok.token}` },
        })
      ).status,
    ).toBe(200);

    // Demote both carol and alice back to member so only "admin" remains as last active admin
    for (const target of ["carol", "alice"]) {
      const r = await fetch(`${srv.url}/v1/actors/role`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminTok.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ actorId: target, role: "member" }),
      });
      expect(r.status).toBe(200);
    }
    expect(srv.engine.db.countActiveAdmins(srv.orgId)).toBe(1);
    expect(
      (
        await fetch(`${srv.url}/v1/identities`, {
          headers: { Authorization: `Bearer ${aliceTok.token}` },
        })
      ).status,
    ).toBe(403);

    // Close server and test local CLI `--as-human`: last active admin cannot be demoted or disabled!
    await srv.close();
    openServers.pop();

    await expect(
      execFileAsync(process.execPath, [
        path.resolve("dist/cli.js"),
        "--home",
        homeDir,
        "actor",
        "set-role",
        "admin",
        "--role",
        "member",
        "--as-human",
        "--json",
      ]),
    ).rejects.toThrow(/last active/i);

    await expect(
      execFileAsync(process.execPath, [
        path.resolve("dist/cli.js"),
        "--home",
        homeDir,
        "actor",
        "disable",
        "admin",
        "--as-human",
        "--json",
      ]),
    ).rejects.toThrow(/last active/i);

    // Local CLI `actor set-role alice --role admin --as-human` works cleanly
    const { stdout: localPromo } = await execFileAsync(process.execPath, [
      path.resolve("dist/cli.js"),
      "--home",
      homeDir,
      "actor",
      "set-role",
      "alice",
      "--role",
      "admin",
      "--as-human",
      "--json",
    ]);
    expect(JSON.parse(localPromo).role).toBe("admin");

    // Local CLI `invite create --role admin --as-human` stores actorRole="admin"
    const { stdout: localInvOut } = await execFileAsync(process.execPath, [
      path.resolve("dist/cli.js"),
      "--home",
      homeDir,
      "invite",
      "create",
      "--actor-id",
      "eve",
      "--kind",
      "human",
      "--role",
      "admin",
      "--as-human",
      "--json",
    ]);
    expect(JSON.parse(localInvOut).record.actorRole).toBe("admin");

    // 1e. Verify Migration v12 -> v13 backfill on a simulated v12 database
    const migDir = makeTempDir("meru-v061-mig13-");
    const dbPath = path.join(migDir, "mind.sqlite");
    const initDb = new SqliteDb({ dbPath, enableVector: false });
    const rawConn = (
      initDb as unknown as {
        db: { exec: (sql: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void } };
      }
    ).db;
    const now = new Date().toISOString();
    initDb.insertOrg({
      id: "org_mig",
      name: "MigOrg",
      isPersonalRoot: true,
      policy: "open",
      createdAt: now,
    });
    initDb.insertRealm({
      id: "rlm_root",
      orgId: "org_mig",
      parentId: null,
      slug: "root",
      path: "/",
      name: "Root",
      archivedAt: null,
      createdAt: now,
    });
    initDb.insertRealm({
      id: "rlm_sub",
      orgId: "org_mig",
      parentId: "rlm_root",
      slug: "sub",
      path: "/sub",
      name: "Sub",
      archivedAt: null,
      createdAt: now,
    });
    initDb.insertToken({
      id: "tok_root_human",
      orgId: "org_mig",
      tokenHash: "h1",
      actorId: "LegacyAdmin",
      actorKind: "human",
      actorFamily: null,
      boundRealmId: null,
      label: null,
      createdBy: "serve-init",
      createdAt: now,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    });
    initDb.insertToken({
      id: "tok_scoped_human",
      orgId: "org_mig",
      tokenHash: "h2",
      actorId: "scoped-user",
      actorKind: "human",
      actorFamily: null,
      boundRealmId: "rlm_sub",
      label: null,
      createdBy: "LegacyAdmin",
      createdAt: now,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    });
    initDb.insertToken({
      id: "tok_agent",
      orgId: "org_mig",
      tokenHash: "h3",
      actorId: "ci-bot",
      actorKind: "agent",
      actorFamily: null,
      boundRealmId: null,
      label: null,
      createdBy: "LegacyAdmin",
      createdAt: now,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    });
    initDb.insertIdentity({
      id: "oid_legacy",
      orgId: "org_mig",
      issuer: "https://idp.example.com",
      subject: "sub-legacy",
      actorId: "OidcRoot",
      actorKind: "human",
      boundRealmId: null,
      email: "root@example.com",
      displayName: "Legacy OIDC Root",
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    });
    // Roll schema back to v12 state and reopen to trigger Migration v13 backfill
    rawConn.exec(`DROP TABLE actors; DELETE FROM schema_migrations WHERE version = 13;`);
    initDb.close();

    const upgradedDb = new SqliteDb({ dbPath, enableVector: false });
    try {
      expect(upgradedDb.getActor("org_mig", "legacyadmin")?.role).toBe("admin");
      expect(upgradedDb.getActor("org_mig", "LEGACYADMIN")?.role).toBe("admin");
      const oidcRoot = upgradedDb.getActor("org_mig", "oidcroot");
      expect(oidcRoot?.role).toBe("admin");
      expect(oidcRoot?.displayName).toBe("Legacy OIDC Root");
      expect(upgradedDb.getActor("org_mig", "scoped-user")?.role).toBe("member");
      expect(upgradedDb.getActor("org_mig", "ci-bot")?.role).toBe("member");
      expect(upgradedDb.isActorIdClaimedInOrg("org_mig", "legacyadmin")).toBe(true);
    } finally {
      upgradedDb.close();
    }
  });

  it("2. POST /v1/me/profile updates displayName (Bearer & Cookie+Origin), sanitizes control/bidi chars, reflects immediately in /v1/whoami & /_meru/session, and Studio UI stays clean & synced", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v061-profile-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const adminTok = srv.createToken({ actorId: "alice", actorKind: "human" });
    const rootRealm = srv.engine.db.getRealmByPath(srv.orgId, "/")!;
    const sess = srv.uiSessions.createSessionForPrincipal(
      {
        tokenId: adminTok.record.id,
        orgId: srv.orgId,
        actor: { id: "alice", kind: "human" },
        boundRealmId: rootRealm.id,
        boundSource: "test",
        authKind: "cookie",
      },
      srv.engine.db,
    );
    const cookieHeader = `${UI_SESSION_COOKIE_NAME}=${sess.sessionId}`;

    // Cross-origin Cookie write MUST fail CSRF check (403)
    const badOrigin = await fetch(`${srv.url}/v1/me/profile`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        Origin: "https://evil.example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "Hacked" }),
    });
    expect(badOrigin.status).toBe(403);

    // Same-origin Cookie write succeeds and sanitizes bidi/control chars + max 64 chars
    const dirtyName = "  \u202eAlice\x00\x1f\u2066 Lin\x7f  ";
    const cookieUpd = await fetch(`${srv.url}/v1/me/profile`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: dirtyName }),
    });
    expect(cookieUpd.status).toBe(200);
    const cookieUpdJson = (await cookieUpd.json()) as {
      actorId: string;
      displayName: string | null;
      role: string;
    };
    expect(cookieUpdJson).toEqual({
      actorId: "alice",
      displayName: "Alice Lin",
      role: "admin",
    });

    // Immediately reflected in BOTH /v1/whoami and /_meru/session!
    const who1 = (await (
      await fetch(`${srv.url}/v1/whoami`, {
        headers: { Cookie: cookieHeader },
      })
    ).json()) as { actor: { id: string; displayName?: string; role?: string } };
    expect(who1.actor.displayName).toBe("Alice Lin");
    expect(who1.actor.role).toBe("admin");

    const sess1 = (await (
      await fetch(`${srv.url}/_meru/session`, {
        headers: { Cookie: cookieHeader },
      })
    ).json()) as { authenticated: boolean; actor: { id: string; displayName?: string; role?: string } };
    expect(sess1.authenticated).toBe(true);
    expect(sess1.actor.displayName).toBe("Alice Lin");
    expect(sess1.actor.role).toBe("admin");

    // Bearer update with >64 chars truncates cleanly to 64 chars
    const longName = "A".repeat(90);
    const bearerUpd = await fetch(`${srv.url}/v1/me/profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: longName }),
    });
    expect(bearerUpd.status).toBe(200);
    const bearerJson = (await bearerUpd.json()) as { displayName: string };
    expect(bearerJson.displayName.length).toBe(64);

    // Whitespace-only / empty string clears displayName -> null (omitted from /v1/whoami & /_meru/session)
    const clearUpd = await fetch(`${srv.url}/v1/me/profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "   \u202e  " }),
    });
    expect(clearUpd.status).toBe(200);
    expect((await clearUpd.json()).displayName).toBeNull();
    const whoCleared = (await (
      await fetch(`${srv.url}/v1/whoami`, {
        headers: { Authorization: `Bearer ${adminTok.token}` },
      })
    ).json()) as { actor: { displayName?: string } };
    expect(whoCleared.actor.displayName).toBeUndefined();

    // Invalid payload type -> 400
    const badType = await fetch(`${srv.url}/v1/me/profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: 42 }),
    });
    expect(badType.status).toBe(400);

    expect(sanitizeDisplayName("ok\u202e\x07test")).toBe("oktest");

    // Verify client.js & built-in Studio UI assets stay in sync, valid JS, zero innerHTML
    const { stdout: syncOut } = await execFileAsync(process.execPath, [
      path.resolve("scripts/generate-ui-assets.mjs"),
      "--check",
    ]);
    expect(syncOut).toContain("in sync");
    expect(CLIENT_JS_SOURCE).toContain("updateDisplayName");
    expect(DEFAULT_SHELL_JS).toContain("profile-display-name-input");
    expect(DEFAULT_SHELL_JS).toContain("profile-save-btn");
    expect(DEFAULT_SHELL_JS).toContain("profile-role-badge");
    expect(DEFAULT_SHELL_CSS).toContain(".profile-role-badge");
    expect(DEFAULT_SHELL_CSS).toContain(".profile-edit-form");
    expect(() => new vm.Script(DEFAULT_SHELL_JS.replace(/^import\s+.*$/gm, ""))).not.toThrow();
    expect(DEFAULT_SHELL_JS).not.toMatch(/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML\s*\(|document\.write\s*\(/);
  });

  it("3. R2-P1-2: Missing non-null boundRealmId fails closed (401/403) and NEVER falls back to root /", async () => {
    const idp = await startMockOidcIdp();
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v061-r2p12-"),
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

    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    const rootRealm = srv.engine.db.getRealmByPath(srv.orgId, "/")!;
    const teamX = srv.engine.ledger.createRealm({
      orgId: srv.orgId,
      parentId: rootRealm.id,
      slug: "team-x",
      name: "Team X",
      actor: { id: "admin", kind: "human" },
    });

    // Create a realm-scoped Bearer token AND a realm-scoped OIDC identity bound to /team-x
    const scopedTok = srv.createToken({
      actorId: "scoped-token-user",
      actorKind: "human",
      boundRealmId: teamX.id,
    });
    const inv = (await (
      await fetch(`${srv.url}/v1/invites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminTok.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actorId: "scoped-oidc-user",
          actorKind: "human",
          boundRealmRef: "/team-x",
        }),
      })
    ).json()) as { code: string };
    idp.setNextUser({
      sub: "sub-scoped-oidc",
      email: "scoped@example.com",
      name: "Scoped OIDC",
    });
    const onboard = await performOidcLoginFlow(
      `${srv.url}/_meru/oidc/login?invite=${encodeURIComponent(inv.code)}`,
    );
    expect(onboard.step3.status).toBe(200);
    const conf = await confirmInviteAcceptance({
      serverUrl: srv.url,
      callbackRes: onboard.step3,
    });
    expect(conf.postRes.status).toBe(200);
    const scopedCookie = `${UI_SESSION_COOKIE_NAME}=${conf.cookies[UI_SESSION_COOKIE_NAME]}`;

    // Before deleting realm: both Bearer and Cookie succeed and stay scoped to /team-x
    const whoTokBefore = (await (
      await fetch(`${srv.url}/v1/whoami`, {
        headers: { Authorization: `Bearer ${scopedTok.token}` },
      })
    ).json()) as { bound: { realmPath: string } };
    expect(whoTokBefore.bound.realmPath).toBe("/team-x");

    // Simulate realm disappearance in SQLite (PRAGMA foreign_keys = OFF to emulate deleted/orphaned realm row)
    const rawConn = (
      srv.engine.db as unknown as { db: { exec: (s: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void } } }
    ).db;
    rawConn.exec("PRAGMA foreign_keys = OFF;");
    rawConn.prepare("DELETE FROM realms WHERE id = ?").run(teamX.id);
    rawConn.exec("PRAGMA foreign_keys = ON;");

    // Bearer token MUST fail closed (401) — NEVER fall back to root "/"!
    const tokAfter = await fetch(`${srv.url}/v1/whoami`, {
      headers: { Authorization: `Bearer ${scopedTok.token}` },
    });
    expect([401, 403]).toContain(tokAfter.status);

    // Existing Cookie session MUST fail closed (401)!
    const cookieAfter = await fetch(`${srv.url}/v1/whoami`, {
      headers: { Cookie: scopedCookie },
    });
    expect([401, 403]).toContain(cookieAfter.status);

    // Fresh OIDC login for that scoped identity MUST fail closed (403) — NEVER mint a root session!
    const oidcAfter = await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`);
    expect(oidcAfter.step3.status).toBe(403);
    expect(oidcAfter.cookies[UI_SESSION_COOKIE_NAME]).toBeUndefined();
  });

  it("4. R2-P1-3: Failed/anonymous OIDC callbacks leave usedOidcStates size 0; valid callback replay still fails 400", async () => {
    const idp = await startMockOidcIdp();
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v061-r2p13-"),
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

    const usedStates = (
      srv.oidcManager as unknown as { usedOidcStates: Map<string, number> }
    ).usedOidcStates;
    expect(usedStates.size).toBe(0);

    // Anonymous / unauthenticated callback floods with forged codes (even with valid AEAD login cookies!)
    for (let i = 0; i < 15; i += 1) {
      const start = await httpRequestNoRedirect({
        url: `${srv.url}/_meru/oidc/login`,
      });
      const startCookies = extractCookies(start.headers);
      const txPair = Object.entries(startCookies).find(([k]) =>
        k.startsWith(OIDC_TX_COOKIE_PREFIX),
      )!;
      const authLoc = new URL(String(start.headers.location));
      const state = authLoc.searchParams.get("state")!;
      const forged = await httpRequestNoRedirect({
        url: `${srv.url}/_meru/oidc/callback?state=${encodeURIComponent(state)}&code=forged_invalid_code_${i}`,
        headers: { Cookie: `${txPair[0]}=${txPair[1]}` },
      });
      expect(forged.status).toBe(400);
    }
    // Zero entries allocated in usedOidcStates from failed/forged callbacks!
    expect(usedStates.size).toBe(0);

    // Now perform a genuine valid callback -> succeeds (200) and records 1 state
    idp.setNextUser({
      sub: "sub-valid-replay",
      email: "replay@example.com",
      preferred_username: "replay-user",
    });
    const valid = await performOidcLoginFlow(`${srv.url}/_meru/oidc/login`);
    expect(valid.step3.status).toBe(200);
    expect(usedStates.size).toBe(1);

    // Replaying the exact same valid callback URL + cookie MUST fail with 400!
    const replay = await httpRequestNoRedirect({
      url: valid.callbackUrl,
      headers: { Cookie: valid.txCookieHeader },
    });
    expect(replay.status).toBe(400);
  });

  it("5. R2-P1-4: Invalid X-Real-IP is ignored, IPv6 /64 shares quota, and global cap evicts oldest pending entry instead of blocking new users", async () => {
    const idp = await startMockOidcIdp();
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v061-r2p14-"),
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

    // Pure IPv6 /64 prefix normalization checks
    expect(normalizeIpRateLimitKey("2001:db8:abcd:12::1")).toBe(
      "2001:0db8:abcd:0012::/64",
    );
    expect(normalizeIpRateLimitKey("2001:0db8:abcd:0012:ffff:1:2:3")).toBe(
      "2001:0db8:abcd:0012::/64",
    );
    expect(normalizeIpRateLimitKey("2001:db8:abcd:13::1")).toBe(
      "2001:0db8:abcd:0013::/64",
    );
    expect(normalizeIpRateLimitKey("::ffff:198.51.100.5")).toBe("198.51.100.5");

    // 5a. Invalid X-Real-IP: "evil<script>" MUST be discarded (falls back to socket IP, never stored!)
    const badIpResp = await fetch(`${srv.url}/_meru/device/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Real-IP": "evil<script>",
      },
      body: JSON.stringify({ hostname: "box-1" }),
    });
    expect(badIpResp.status).toBe(200);
    const badIpJson = (await badIpResp.json()) as { deviceCode: string };
    const deviceCodesMap = (
      srv.oidcManager as unknown as {
        deviceCodesByHash: Map<
          string,
          {
            deviceCodeHash: string;
            userCode: string;
            orgId: string;
            remoteIp: string;
            rateLimitKey: string;
            hostname: string;
            clientLabel: string;
            requestedKind: "human" | "agent";
            status: "pending" | "approved" | "denied";
            mintedToken: string | null;
            mintedTokenId: string | null;
            approvedActorId: string | null;
            approvedActorKind: "human" | "agent" | null;
            mintedExpiresAt: string | null;
            expiresAtMs: number;
            createdAtMs: number;
            createdAtIso: string;
          }
        >;
        deviceHashByUserCode: Map<string, string>;
      }
    ).deviceCodesByHash;
    const hashOfFirst = crypto
      .createHash("sha256")
      .update(badIpJson.deviceCode, "utf8")
      .digest("hex");
    const storedEntry = deviceCodesMap.get(hashOfFirst)!;
    expect(storedEntry.remoteIp).not.toContain("evil");
    expect(storedEntry.remoteIp).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);

    // 5b. IPv6 addresses inside the SAME /64 share the 8-code per-IP quota!
    for (let i = 1; i <= 8; i += 1) {
      const ok = await fetch(`${srv.url}/_meru/device/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Real-IP": `2001:db8:cafe:0042::${i.toString(16)}`,
        },
        body: JSON.stringify({ hostname: `v6-host-${i}` }),
      });
      expect(ok.status).toBe(200);
    }
    // 9th request from a DIFFERENT interface ID in the SAME /64 MUST return 429!
    const v6SamePrefix9 = await fetch(`${srv.url}/_meru/device/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Real-IP": "2001:db8:cafe:42:dead:beef:1234:5678",
      },
      body: JSON.stringify({ hostname: "v6-host-9" }),
    });
    expect(v6SamePrefix9.status).toBe(429);

    // Different /64 MUST still succeed (200)!
    const v6OtherPrefix = await fetch(`${srv.url}/_meru/device/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Real-IP": "2001:db8:cafe:0043::1",
      },
      body: JSON.stringify({ hostname: "v6-other-net" }),
    });
    expect(v6OtherPrefix.status).toBe(200);

    // 5c. Global cap LRU eviction: fill map to MAX_PENDING_DEVICE_CODES_GLOBAL, then a new user succeeds
    // and evicts the oldest pending entry (`badIpJson.deviceCode`)!
    const userCodeMap = (
      srv.oidcManager as unknown as {
        deviceHashByUserCode: Map<string, string>;
      }
    ).deviceHashByUserCode;
    const futureExp = Date.now() + 5 * 60 * 1000;
    const nowIso = new Date().toISOString();
    let idx = 0;
    while (deviceCodesMap.size < MAX_PENDING_DEVICE_CODES_GLOBAL) {
      idx += 1;
      const syntheticHash = `syn_hash_${idx}`;
      const syntheticUserCode = `SYN-${String(idx).padStart(4, "0")}`;
      deviceCodesMap.set(syntheticHash, {
        deviceCodeHash: syntheticHash,
        userCode: syntheticUserCode,
        orgId: srv.orgId,
        remoteIp: `198.51.${Math.floor(idx / 250)}.${idx % 250}`,
        rateLimitKey: `198.51.${Math.floor(idx / 250)}.${idx % 250}`,
        hostname: "flood-bot",
        clientLabel: "cli",
        requestedKind: "agent",
        status: "pending",
        mintedToken: null,
        mintedTokenId: null,
        approvedActorId: null,
        approvedActorKind: null,
        mintedExpiresAt: null,
        createdAtMs: Date.now(),
        createdAtIso: nowIso,
        expiresAtMs: futureExp,
      });
      userCodeMap.set(syntheticUserCode, syntheticHash);
    }
    expect(deviceCodesMap.size).toBe(MAX_PENDING_DEVICE_CODES_GLOBAL);

    // New legitimate user from fresh IP MUST succeed (200) via LRU eviction!
    const legitAfterFull = await fetch(`${srv.url}/_meru/device/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Real-IP": "203.0.113.99",
      },
      body: JSON.stringify({ hostname: "legit-laptop" }),
    });
    expect(legitAfterFull.status).toBe(200);
    expect(deviceCodesMap.size).toBe(MAX_PENDING_DEVICE_CODES_GLOBAL);
    // Oldest pending entry (`badIpJson.deviceCode`) was evicted!
    expect(deviceCodesMap.has(hashOfFirst)).toBe(false);
    const pollEvicted = (await (
      await fetch(`${srv.url}/_meru/device/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceCode: badIpJson.deviceCode }),
      })
    ).json()) as { status: string };
    expect(pollEvicted.status).toBe("expired_token");
  });
});
