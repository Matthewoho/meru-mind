import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWriteAccess,
  detectPlaintextSecret,
  getWritableRealmIds,
  isRealmEffectivelyArchived,
  MAX_IMPORT_ITEM_BYTES,
  MAX_VERIFY_MANIFEST_ITEMS,
  planJsonlImport,
  planMarkdownImport,
  planSourceVerification,
  RemoteMindSurface,
  resolveAccess,
  resolveAccessScope,
  resolveWriteAccess,
  SqliteDb,
  startMindServer,
  type Actor,
  type AssetKind,
  type MindEngine,
  type MindServerHandle,
  type OrgPolicy,
} from "../src/index.js";

const tempDirs: string[] = [];
const openEngines: MindEngine[] = [];
const openServers: MindServerHandle[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const CLI_DIST = path.resolve(process.cwd(), "dist/cli.js");

function runCli(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; expectFail?: boolean } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    delete cleanEnv.MERU_MIND_HOME;
    delete cleanEnv.MERU_MIND_URL;
    delete cleanEnv.MERU_MIND_TOKEN;
    delete cleanEnv.MERU_MIND_ORG_ID;
    delete cleanEnv.MERU_MIND_VIEWER_REALM_ID;
    Object.assign(cleanEnv, opts.env ?? {});
    const child = spawn(process.execPath, [CLI_DIST, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const status = code ?? 1;
      if (!opts.expectFail && status !== 0) {
        reject(
          new Error(
            `CLI failed (${status}): meru-mind ${args.join(" ")}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`,
          ),
        );
        return;
      }
      resolve({ status, stdout, stderr });
    });
  });
}

function httpGetNoRedirect(
  targetUrl: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += String(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.close().catch(() => {});
  }
  while (openEngines.length > 0) {
    await openEngines.pop()!.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function setupTreeServer(): Promise<{
  srv: MindServerHandle;
  adminToken: string;
  opsId: string;
  opsInfraId: string;
  opsK8sId: string;
  opsArchivedId: string;
  opsXId: string;
  secId: string;
}> {
  const homeDir = makeTempDir("meru-v065-srv-");
  const srv = await startMindServer({
    homeDir,
    host: "127.0.0.1",
    port: 0,
    enableVector: false,
    accessLog: false,
  });
  openServers.push(srv);

  const rootAdmin: Actor = { id: "alice-admin", kind: "human" };
  srv.engine.ledger.setOrgPolicy({
    orgId: srv.orgId,
    policy: "tree",
    actor: rootAdmin,
  });
  const root = srv.engine.db.getRealmByPath(srv.orgId, "/")!;
  const ops = srv.engine.ledger.createRealm({
    orgId: srv.orgId,
    parentId: root.id,
    slug: "ops",
    name: "Operations",
    scope: "Include: ops infra and runbooks. Exclude: security secrets.",
    actor: rootAdmin,
  });
  const opsInfra = srv.engine.ledger.createRealm({
    orgId: srv.orgId,
    parentId: ops.id,
    slug: "infra",
    name: "Infrastructure",
    scope: "Include: clusters and cloud. Exclude: HR.",
    actor: rootAdmin,
  });
  const opsK8s = srv.engine.ledger.createRealm({
    orgId: srv.orgId,
    parentId: opsInfra.id,
    slug: "k8s",
    name: "Kubernetes",
    scope: "Include: k8s manifests. Exclude: billing.",
    actor: rootAdmin,
  });
  const opsArchived = srv.engine.ledger.createRealm({
    orgId: srv.orgId,
    parentId: ops.id,
    slug: "legacy",
    name: "Legacy Ops",
    scope: "Include: archived ops. Exclude: active.",
    actor: rootAdmin,
  });
  srv.engine.ledger.archiveRealm({
    orgId: srv.orgId,
    realmId: opsArchived.id,
    actor: rootAdmin,
  });
  // Prefix-colliding sibling (/ops-x starts with /ops!)
  const opsX = srv.engine.ledger.createRealm({
    orgId: srv.orgId,
    parentId: root.id,
    slug: "ops-x",
    name: "Ops External",
    scope: "Include: external partner ops. Exclude: internal.",
    actor: rootAdmin,
  });
  // Hidden sibling (/sec)
  const sec = srv.engine.ledger.createRealm({
    orgId: srv.orgId,
    parentId: root.id,
    slug: "sec",
    name: "Security",
    scope: "Include: security audits. Exclude: public.",
    actor: rootAdmin,
  });
  // Mount /sec read-only (ledger) into /ops
  srv.engine.ledger.mountRealm({
    actor: rootAdmin,
    viewerRealmId: ops.id,
    targetRealmId: sec.id,
    scope: "ledger",
  });

  const adminMinted = srv.createToken({
    actorId: "alice-admin",
    actorKind: "human",
    actorRole: "admin",
  });

  return {
    srv,
    adminToken: adminMinted.token,
    opsId: ops.id,
    opsInfraId: opsInfra.id,
    opsK8sId: opsK8s.id,
    opsArchivedId: opsArchived.id,
    opsXId: opsX.id,
    secId: sec.id,
  };
}

describe("Meru Mind v0.6.5 — Subtree WriteScope, Remote Objects & Unified Import/Verify", () => {
  it("1. Read differential matrix: writeScope self vs subtree produces 100% identical read results + lock/remote error hints", async () => {
    const { srv, opsId, opsInfraId, opsK8sId, opsXId, secId } =
      await setupTreeServer();
    const root = srv.engine.db.getRealmByPath(srv.orgId, "/")!;
    const rootAdmin: Actor = { id: "alice-admin", kind: "human" };

    // Seed entries in every realm (root, /ops, /ops/infra, /ops/infra/k8s, /ops-x, /sec)
    for (const [realmId, tag] of [
      [root.id, "root"],
      [opsId, "ops"],
      [opsInfraId, "infra"],
      [opsK8sId, "k8s"],
      [opsXId, "opsx"],
      [secId, "sec"],
    ] as const) {
      await srv.engine.ledger.appendRecord({
        actor: rootAdmin,
        viewerRealmId: realmId,
        targetRealmId: realmId,
        kind: "decision",
        title: `Decision in ${tag}`,
        payload: { body: `shared-matrix-keyword content for ${tag}` },
      });
      await srv.engine.ledger.captureSeabed({
        actor: rootAdmin,
        viewerRealmId: realmId,
        targetRealmId: realmId,
        kind: "evidence",
        text: `shared-matrix-keyword raw seabed in ${tag}`,
      });
    }

    // 1a. Exhaustive resolveAccess policy matrix: read access is completely unaffected by writeScope
    const realms = srv.engine.db.listRealms();
    const mounts = srv.engine.db.listMounts();
    const agentActor: Actor = { id: "worker-bot", kind: "agent" };
    const assets: AssetKind[] = ["ledger", "rule", "seabed", "drive"];
    const targetIds = [root.id, opsId, opsInfraId, opsK8sId, opsXId, secId];
    for (const targetId of targetIds) {
      for (const assetKind of assets) {
        for (const dive of [false, true]) {
          const a = resolveAccess({
            realms,
            mounts,
            actor: agentActor,
            viewerRealmId: opsId,
            targetRealmId: targetId,
            assetKind,
            explicitDescendantDive: dive,
            orgPolicy: "tree",
          });
          // Verify subtree token never leaks write into resolveAccess
          if (targetId === opsInfraId || targetId === opsK8sId) {
            expect(a).not.toBe("write");
          }
        }
      }
    }

    // 1b. Surface-level differential comparison: self vs subtree tokens bound to /ops
    const selfTok = srv.createToken({
      actorId: "bot-self",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "self",
    });
    const subTok = srv.createToken({
      actorId: "bot-sub",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    expect(selfTok.record.writeScope).toBe("self");
    expect(subTok.record.writeScope).toBe("subtree");

    const selfSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: selfTok.token,
    });
    const subSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subTok.token,
    });

    const selfWho = await selfSurf.whoami();
    const subWho = await subSurf.whoami();
    expect(selfWho.write.scope).toBe("self");
    expect(subWho.write.scope).toBe("subtree");
    expect(subWho.write.allowed).toContain("subtree");
    expect(selfWho.read).toEqual(subWho.read);
    expect(selfWho.corpus).toEqual(subWho.corpus);

    // Compare tree, ls, ls(descendant seabed), show, search, changes byte-for-byte
    expect(await selfSurf.tree({ depth: "all" })).toEqual(
      await subSurf.tree({ depth: "all" }),
    );
    for (const ref of ["/ops", "/ops/infra", "/ops/infra/k8s"]) {
      expect(await selfSurf.ls({ ref })).toEqual(await subSurf.ls({ ref }));
      expect(
        await selfSurf.ls({ ref, includeDescendantSeabed: true }),
      ).toEqual(await subSurf.ls({ ref, includeDescendantSeabed: true }));
      const selfShow = await selfSurf.show({ ref });
      const subShow = await subSurf.show({ ref });
      const stripVolatileShow = (s: typeof selfShow) =>
        s.refType === "realm"
          ? {
              ...s,
              activePeers: undefined,
              brief: { ...s.brief, generatedAt: "<normalized>" },
            }
          : s;
      expect(stripVolatileShow(selfShow)).toEqual(stripVolatileShow(subShow));
    }
    expect(
      await selfSurf.search({ query: "shared-matrix-keyword" }),
    ).toEqual(await subSurf.search({ query: "shared-matrix-keyword" }));
    expect(
      await selfSurf.search({
        query: "shared-matrix-keyword",
        includeDescendantSeabed: true,
      }),
    ).toEqual(
      await subSurf.search({
        query: "shared-matrix-keyword",
        includeDescendantSeabed: true,
      }),
    );
    expect(await selfSurf.changes({ sinceSeq: 0 })).toEqual(
      await subSurf.changes({ sinceSeq: 0 }),
    );

    // 1c. Server writer-lock conflict error includes MERU_MIND_URL hint
    const lockFail = await runCli(["whoami", "--json"], {
      env: { MERU_MIND_HOME: srv.homeDir },
      expectFail: true,
    });
    expect(lockFail.status).toBe(1);
    expect(lockFail.stderr).toContain("MERU_MIND_URL=");

    // 1d. Remote HTTP errors NEVER tell users to pass --as-human
    const remoteRuleFail = await fetch(`${srv.url}/v1/rules`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${subTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        in: "/ops",
        title: "No agent rule",
        body: "Denied",
      }),
    });
    expect(remoteRuleFail.status).toBe(403);
    const errBody = await remoteRuleFail.text();
    expect(errBody).not.toContain("--as-human");
  });

  it("2. Out-of-bounds write denial, root '/' subtree rejection (agent & human), and Cookie downgrade to self", async () => {
    const { srv, adminToken } = await setupTreeServer();

    // 2a. Root "/" + writeScope "subtree" MUST be rejected for BOTH agent AND human
    expect(() =>
      srv.createToken({
        actorId: "root-agent-sub",
        actorKind: "agent",
        boundRealmId: "/",
        writeScope: "subtree",
      }),
    ).toThrow(/cannot be bound to root realm/i);

    expect(() =>
      srv.createToken({
        actorId: "root-human-sub",
        actorKind: "human",
        boundRealmId: "/",
        writeScope: "subtree",
      }),
    ).toThrow(/cannot be bound to root realm/i);

    // Omitted boundRealmId (defaults to root "/") + subtree MUST also be rejected
    expect(() =>
      srv.createToken({
        actorId: "implicit-root-sub",
        actorKind: "human",
        writeScope: "subtree",
      }),
    ).toThrow(/cannot be bound to root realm/i);

    // Also via HTTP POST /v1/tokens
    const httpRootSub = await fetch(`${srv.url}/v1/tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        actorId: "http-root-sub",
        actorKind: "agent",
        boundRealmRef: "/",
        writeScope: "subtree",
      }),
    });
    expect(httpRootSub.status).toBe(400);

    // 2b. Non-root /ops subtree agent CAN write to /ops, /ops/infra, /ops/infra/k8s
    const subAgent = srv.createToken({
      actorId: "ops-agent",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const surf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subAgent.token,
    });

    const w1 = await surf.write({
      in: "/ops/infra/k8s",
      title: "K8s HPA tuning",
      body: "Set minReplicas=3 on ingress gateway.",
    });
    expect(w1.record.kind).toBe("finding");
    const r1 = await surf.rawAdd({
      in: "/ops/infra",
      kind: "evidence",
      text: "kubectl top pods snapshot",
    });
    expect(r1.kind).toBe("evidence");

    // 2c. Out-of-bounds writes MUST be rejected: ancestor "/", prefix-colliding "/ops-x",
    // hidden sibling "/sec", mounted "@mounted/sec", archived descendant "/ops/legacy"
    for (const forbiddenRef of [
      "/",
      "/ops-x",
      "/sec",
      "@mounted/sec",
      "/ops/legacy",
    ]) {
      await expect(
        surf.write({
          in: forbiddenRef,
          title: `Attempt ${forbiddenRef}`,
          body: "Should fail",
        }),
      ).rejects.toThrow();
    }

    // 2d. Self-scope token on /ops CANNOT write to descendant /ops/infra
    const selfAgent = srv.createToken({
      actorId: "ops-self-agent",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "self",
    });
    const selfSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: selfAgent.token,
    });
    await expect(
      selfSurf.write({
        in: "/ops/infra",
        title: "Self cannot write child",
        body: "Denied",
      }),
    ).rejects.toThrow(/denied|read-only|write/i);

    // 2e. Cookie downgrade: human token bound to /ops with writeScope="subtree" -> login-code -> Cookie MUST downgrade to "self"
    const subHuman = srv.createToken({
      actorId: "ops-human-sub",
      actorKind: "human",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const mintRes = await fetch(`${srv.url}/v1/ui/login-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${subHuman.token}` },
    });
    expect(mintRes.status).toBe(200);
    const { path: authPath } = (await mintRes.json()) as { path: string };
    const authRes = await httpGetNoRedirect(`${srv.url}${authPath}`, {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    const rawCookie = authRes.headers["set-cookie"];
    const cookiePair = (
      Array.isArray(rawCookie) ? rawCookie[0] : (rawCookie ?? "")
    ).split(";")[0]!;
    expect(cookiePair).toBeTruthy();

    // Cookie whoami MUST report write.scope === "self"
    const cookieWhoRes = await fetch(`${srv.url}/v1/whoami`, {
      headers: { Cookie: cookiePair },
    });
    expect(cookieWhoRes.status).toBe(200);
    const cookieWho = (await cookieWhoRes.json()) as {
      write: { scope?: string };
    };
    expect(cookieWho.write.scope).toBe("self");

    // Cookie CAN write to self (/ops)
    const cookieSelfWrite = await fetch(`${srv.url}/v1/write`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        in: "/ops",
        title: "Cookie self write",
        body: "Allowed in bound realm",
      }),
    });
    expect(cookieSelfWrite.status).toBe(200);

    // Cookie CANNOT write to descendant (/ops/infra) because Cookie downgraded to "self"
    const cookieSubWrite = await fetch(`${srv.url}/v1/write`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        in: "/ops/infra",
        title: "Cookie descendant write",
        body: "MUST be denied",
      }),
    });
    expect(cookieSubWrite.status).toBe(403);
  });

  it("3. sourceRef collision across hidden sibling realms: zero existence disclosure; writable subtree collision requires --relocate", async () => {
    const { srv, secId } = await setupTreeServer();
    const rootAdmin: Actor = { id: "alice-admin", kind: "human" };

    // Remove mount so /sec is 100% hidden sibling of /ops
    srv.engine.ledger.unmountRealm({
      actor: rootAdmin,
      viewerRealmId: srv.engine.db.getRealmByPath(srv.orgId, "/ops")!.id,
      targetRealmId: secId,
    });

    // Seed identical sourceRef in hidden sibling /sec (both record and seabed)
    const secretBody = "Top-secret security roadmap body.";
    await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: secId,
      targetRealmId: secId,
      kind: "claim",
      title: "Secret Roadmap",
      payload: { body: secretBody, contentSha256: sha256(secretBody) },
      sourceRef: "roadmap.md",
    });
    await srv.engine.ledger.captureSeabed({
      actor: rootAdmin,
      viewerRealmId: secId,
      targetRealmId: secId,
      kind: "artifact",
      text: "Raw secret artifact text",
      preserveExactText: true,
      sourceRef: "raw-secret.md",
    });

    const opsSub = srv.createToken({
      actorId: "ops-importer",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const surf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: opsSub.token,
    });

    // Probing hidden sibling sourceRef "roadmap.md" & "raw-secret.md" MUST behave identically to nonexistent
    const probeRes = await surf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "roadmap.md",
          realmRef: "/ops/infra",
          title: "Ops Roadmap",
          body: secretBody,
          contentSha256: sha256(secretBody),
        },
        {
          target: "seabed",
          sourceRef: "raw-secret.md",
          realmRef: "/ops/infra",
          text: "Raw secret artifact text",
          contentSha256: sha256("Raw secret artifact text"),
        },
      ],
    });
    expect(probeRes.created).toBe(2);
    expect(probeRes.skippedUnchanged).toBe(0);

    // Hidden sibling /sec records remain completely untouched
    const secRecs = srv.engine.db.findActiveRecordsBySourceRefInRealms(
      srv.orgId,
      "roadmap.md",
      [secId],
    );
    expect(secRecs).toHaveLength(1);
    expect(secRecs[0]!.title).toBe("Secret Roadmap");

    // Collision inside caller's OWN writable subtree (/ops/infra -> /ops/infra/k8s):
    // WITHOUT relocate -> 409 CONFLICT
    await expect(
      surf.importBatch({
        items: [
          {
            target: "record",
            sourceRef: "roadmap.md",
            realmRef: "/ops/infra/k8s",
            title: "Ops Roadmap",
            body: secretBody,
            contentSha256: sha256(secretBody),
          },
        ],
      }),
    ).rejects.toThrow(/already exists in writable realm "\/ops\/infra"/i);

    // P0-3: Agent with relocate: true MUST be rejected (relocate is strictly human-only!)
    await expect(
      surf.importBatch({
        relocate: true,
        items: [
          {
            target: "record",
            sourceRef: "roadmap.md",
            realmRef: "/ops/infra/k8s",
            title: "Ops Roadmap",
            body: secretBody,
            contentSha256: sha256(secretBody),
          },
        ],
      }),
    ).rejects.toThrow(/Only human actors can use --relocate/i);

    // Human subtree token WITH relocate: true -> cleanly relocates from /ops/infra to /ops/infra/k8s
    const opsHumanSub = srv.createToken({
      actorId: "ops-human-relocator",
      actorKind: "human",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const humanSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: opsHumanSub.token,
    });
    const relocatedRes = await humanSurf.importBatch({
      relocate: true,
      items: [
        {
          target: "record",
          sourceRef: "roadmap.md",
          realmRef: "/ops/infra/k8s",
          title: "Ops Roadmap",
          body: secretBody,
          contentSha256: sha256(secretBody),
        },
      ],
    });
    expect(relocatedRes.relocated).toBe(1);
    expect(relocatedRes.items[0]!.action).toBe("relocated");
    expect(relocatedRes.items[0]!.realmPath).toBe("/ops/infra/k8s");

    // P0-3 archive freeze: relocating a record OR seabed entry out of an archived realm MUST fail (409 CONFLICT)!
    const opsArchivedId = srv.engine.db.getRealmByPath(
      srv.orgId,
      "/ops/legacy",
    )!.id;
    srv.engine.ledger.unarchiveRealm({
      orgId: srv.orgId,
      realmId: opsArchivedId,
      actor: rootAdmin,
    });
    await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: opsArchivedId,
      targetRealmId: opsArchivedId,
      kind: "claim",
      title: "Archived Record",
      payload: { body: "Frozen record", contentSha256: sha256("Frozen record") },
      sourceRef: "frozen-rec.md",
    });
    await srv.engine.ledger.captureSeabed({
      actor: rootAdmin,
      viewerRealmId: opsArchivedId,
      targetRealmId: opsArchivedId,
      kind: "artifact",
      text: "Frozen seabed",
      preserveExactText: true,
      sourceRef: "frozen-sea.md",
    });
    srv.engine.ledger.archiveRealm({
      orgId: srv.orgId,
      realmId: opsArchivedId,
      actor: rootAdmin,
    });

    await expect(
      humanSurf.importBatch({
        relocate: true,
        items: [
          {
            target: "record",
            sourceRef: "frozen-rec.md",
            realmRef: "/ops/infra",
            title: "Archived Record",
            body: "Frozen record",
            contentSha256: sha256("Frozen record"),
          },
        ],
      }),
    ).rejects.toThrow(/archived/i);

    await expect(
      humanSurf.importBatch({
        relocate: true,
        items: [
          {
            target: "seabed",
            sourceRef: "frozen-sea.md",
            realmRef: "/ops/infra",
            text: "Frozen seabed",
            contentSha256: sha256("Frozen seabed"),
          },
        ],
      }),
    ).rejects.toThrow(/archived/i);
  });

  it("4. Admin verb boundaries: agents blocked on all admin verbs; subtree human blocked on invite/token/rule/deleteObject(descendant) while keeping bound-subtree realm/redact governance (including unarchive & archived redact)", async () => {
    const { srv, opsId, opsInfraId, opsArchivedId } = await setupTreeServer();
    const rootAdmin: Actor = { id: "alice-admin", kind: "human" };
    const root = srv.engine.db.getRealmByPath(srv.orgId, "/")!;

    // Seed entries in root, /ops/infra, and archived /ops/legacy
    const rootRec = await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: root.id,
      targetRealmId: root.id,
      kind: "decision",
      title: "Root entry",
      payload: { body: "Stored in /" },
    });
    const infraRec = await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: opsInfraId,
      targetRealmId: opsInfraId,
      kind: "decision",
      title: "Infra entry",
      payload: { body: "Stored in /ops/infra" },
    });
    // Temporarily unarchive /ops/legacy to seed a leaked record, then re-archive
    srv.engine.ledger.unarchiveRealm({
      orgId: srv.orgId,
      realmId: opsArchivedId,
      actor: rootAdmin,
    });
    const archivedRec = await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: opsArchivedId,
      targetRealmId: opsArchivedId,
      kind: "claim",
      title: "Leaked in archived realm",
      payload: { body: "Needs redaction despite archive freeze" },
    });
    srv.engine.ledger.archiveRealm({
      orgId: srv.orgId,
      realmId: opsArchivedId,
      actor: rootAdmin,
    });

    const infraObj = srv.engine.objects.createObject({
      actor: rootAdmin,
      viewerRealmId: opsInfraId,
      kind: "service",
      name: "infra-gw",
    });
    const opsObj = srv.engine.objects.createObject({
      actor: rootAdmin,
      viewerRealmId: opsId,
      kind: "service",
      name: "ops-root-svc",
    });

    const subHuman = srv.createToken({
      actorId: "ops-lead",
      actorKind: "human",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const subAgent = srv.createToken({
      actorId: "ops-bot",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });

    const humanSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subHuman.token,
    });
    const agentSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subAgent.token,
    });

    // Invite & Token issuance rejected for non-root subtree human & agent
    for (const tok of [subHuman.token, subAgent.token]) {
      const invRes = await fetch(`${srv.url}/v1/invites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ actorId: "newbie", actorKind: "human" }),
      });
      expect(invRes.status).toBe(403);
    }
    await expect(
      humanSurf.createToken({ actorId: "x", actorKind: "agent" }),
    ).rejects.toThrow();
    await expect(
      agentSurf.createToken({ actorId: "x", actorKind: "agent" }),
    ).rejects.toThrow();

    // Rule add on descendant /ops/infra rejected even for subtree human; agent rejected everywhere
    await expect(
      humanSurf.addRule({
        in: "/ops/infra",
        title: "Descendant rule",
        body: "Should be denied",
      }),
    ).rejects.toThrow();
    await expect(
      agentSurf.addRule({
        in: "/ops",
        title: "Agent rule",
        body: "Should be denied",
      }),
    ).rejects.toThrow();

    // Agent STILL rejected on realm create, archive, unarchive, redact
    await expect(
      agentSurf.createRealm({
        parentRef: "/ops/infra",
        slug: "bot-sub",
        name: "Bot Sub",
        scope: "Include: sub. Exclude: none.",
      }),
    ).rejects.toThrow();
    await expect(
      agentSurf.archiveRealm({ ref: "/ops/infra" }),
    ).rejects.toThrow();
    await expect(
      agentSurf.unarchiveRealm({ ref: "/ops/legacy" }),
    ).rejects.toThrow();
    await expect(
      agentSurf.redact({ entryId: infraRec.id, reason: "test" }),
    ).rejects.toThrow();

    // P1-3: Non-root human bound to /ops CANNOT govern outside bound subtree (e.g. ancestor /),
    // but CAN create child realms, archive & unarchive descendants, and redact even inside archived descendants!
    await expect(
      humanSurf.createRealm({
        parentRef: "/",
        slug: "illegal-sibling",
        name: "Illegal",
        scope: "Include: x. Exclude: y.",
      }),
    ).rejects.toThrow();
    await expect(
      humanSurf.archiveRealm({ ref: "/" }),
    ).rejects.toThrow();
    await expect(
      humanSurf.redact({ entryId: rootRec.id, reason: "out of subtree" }),
    ).rejects.toThrow();

    const childRealm = await humanSurf.createRealm({
      parentRef: "/ops/infra",
      slug: "sub",
      name: "Sub",
      scope: "Include: sub. Exclude: none.",
    });
    expect(childRealm.path).toBe("/ops/infra/sub");

    const archived = await humanSurf.archiveRealm({ ref: "/ops/infra/sub" });
    expect(archived.realm.archivedAt).toBeTruthy();
    const unarchived = await humanSurf.unarchiveRealm({ ref: "/ops/infra/sub" });
    expect(unarchived.realm.archivedAt).toBeNull();

    // Redact inside archived /ops/legacy MUST succeed for bound-subtree human (emergency secret cleanup!)
    const redacted = await humanSurf.redact({
      entryId: archivedRec.id,
      reason: "Emergency secret remediation in archived realm",
    });
    expect(redacted.entryId).toBe(archivedRec.id);
    expect(redacted.redactedAt).toBeTruthy();

    // object delete on descendant /ops/infra rejected for BOTH agent AND subtree human!
    await expect(
      agentSurf.deleteObject({ ref: infraObj.id }),
    ).rejects.toThrow();
    await expect(
      humanSurf.deleteObject({ ref: infraObj.id }),
    ).rejects.toThrow();

    // object delete on self (/ops) rejected for agent, ALLOWED for human bound to /ops
    await expect(
      agentSurf.deleteObject({ ref: opsObj.id }),
    ).rejects.toThrow(/human/i);
    expect(await humanSurf.deleteObject({ ref: opsObj.id })).toBe(true);
  });

  it("5. Remote object lifecycle (all 7 verbs + --if-not-exists idempotency/drift/conflicts/zero-oracle + Cookie blocks)", async () => {
    const { srv, secId } = await setupTreeServer();
    const rootAdmin: Actor = { id: "alice-admin", kind: "human" };

    // Remove mount so /sec is hidden sibling
    srv.engine.ledger.unmountRealm({
      actor: rootAdmin,
      viewerRealmId: srv.engine.db.getRealmByPath(srv.orgId, "/ops")!.id,
      targetRealmId: secId,
    });

    // Seed hidden object service:ghost in /sec
    srv.engine.objects.createObject({
      actor: rootAdmin,
      viewerRealmId: secId,
      kind: "service",
      name: "ghost",
    });

    const subAgent = srv.createToken({
      actorId: "obj-agent",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const subHuman = srv.createToken({
      actorId: "obj-human",
      actorKind: "human",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });

    const agentSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subAgent.token,
    });
    const humanSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subHuman.token,
    });

    // 5a. Hidden-realm zero existence oracle: creating service:ghost in /ops/infra with ifNotExists succeeds cleanly!
    const ghostCreated = await agentSurf.createObject({
      in: "/ops/infra",
      kind: "service",
      name: "ghost",
      ifNotExists: true,
    });
    expect(ghostCreated.created).toBe(true);
    expect(ghostCreated.drift).toBeUndefined();

    // 5b. Create parent & child, verify --if-not-exists idempotency & drift reporting without mutating parent
    const parent1 = await agentSurf.createObject({
      in: "/ops",
      kind: "system",
      name: "platform",
      ifNotExists: true,
    });
    const parent2 = await agentSurf.createObject({
      in: "/ops",
      kind: "system",
      name: "edge",
      ifNotExists: true,
    });
    const svcFirst = await agentSurf.createObject({
      in: "/ops/infra",
      kind: "service",
      name: "gateway",
      parentRef: parent1.object.id,
      ifNotExists: true,
    });
    expect(svcFirst.created).toBe(true);

    // Identical repeat -> created: false, no drift
    const svcRepeat = await agentSurf.createObject({
      in: "/ops/infra",
      kind: "service",
      name: "gateway",
      parentRef: parent1.object.id,
      ifNotExists: true,
    });
    expect(svcRepeat.created).toBe(false);
    expect(svcRepeat.object.id).toBe(svcFirst.object.id);
    expect(svcRepeat.drift).toBeUndefined();

    // Repeat with DIFFERENT parent -> created: false + drift reported, parent NOT mutated!
    const svcDrift = await agentSurf.createObject({
      in: "/ops/infra",
      kind: "service",
      name: "gateway",
      parentRef: parent2.object.id,
      ifNotExists: true,
    });
    expect(svcDrift.created).toBe(false);
    expect(svcDrift.object.parentObjectId).toBe(parent1.object.id);
    expect(svcDrift.drift?.parentObjectId).toEqual({
      existing: parent1.object.id,
      requested: parent2.object.id,
    });

    // Visible-realm conflict: creating service:gateway in /ops/infra/k8s while it exists in visible /ops/infra -> CONFLICT
    await expect(
      agentSurf.createObject({
        in: "/ops/infra/k8s",
        kind: "service",
        name: "gateway",
        ifNotExists: true,
      }),
    ).rejects.toThrow(/already exists in visible realm "\/ops\/infra"/i);

    // 5c. move, link, unlink, set, alias via Remote CLI + Surface
    const moved = await agentSurf.moveObject({
      ref: svcFirst.object.id,
      parentRef: parent2.object.id,
    });
    expect(moved.parentObjectId).toBe(parent2.object.id);

    const entry = await agentSurf.write({
      in: "/ops/infra",
      title: "Gateway deprecation",
      body: "Moving gateway traffic to v2.",
    });
    const linked = await agentSurf.linkObject({
      entryId: entry.record.id,
      objectRef: svcFirst.object.id,
    });
    expect(linked.objectId).toBe(svcFirst.object.id);

    const stateRes = await agentSurf.setObjectState({
      ref: svcFirst.object.id,
      state: "inactive",
      label: "deprecated",
      since: "2026-11-01",
      because: entry.record.id,
    });
    expect(stateRes.object.state).toBe("inactive");

    const aliasRes = await agentSurf.updateObjectAliases({
      ref: svcFirst.object.id,
      add: ["API Gateway"],
    });
    expect(aliasRes.added).toContain("API Gateway");

    const unlinked = await agentSurf.unlinkObject({
      entryId: entry.record.id,
      objectRef: svcFirst.object.id,
    });
    expect(unlinked).toBe(true);

    // Remote CLI object create --if-not-exists & delete
    const cliObjCreate = await runCli(
      [
        "object",
        "create",
        "--in",
        "/ops",
        "--kind",
        "service",
        "--name",
        "cli-svc",
        "--if-not-exists",
        "--json",
      ],
      { env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: subHuman.token } },
    );
    const cliObj = JSON.parse(cliObjCreate.stdout) as {
      id: string;
      created: boolean;
    };
    expect(cliObj.created).toBe(true);

    const cliDel = await runCli(
      ["object", "delete", cliObj.id, "--json"],
      { env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: subHuman.token } },
    );
    expect(JSON.parse(cliDel.stdout).removed).toBe(true);

    // 5d. Cookie session blocked on /v1/objects/move and /v1/objects/delete (allowed on /v1/objects create in self)
    const mintRes = await fetch(`${srv.url}/v1/ui/login-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${subHuman.token}` },
    });
    const { path: authPath } = (await mintRes.json()) as { path: string };
    const authRes = await httpGetNoRedirect(`${srv.url}${authPath}`, {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    const cookiePair = (
      Array.isArray(authRes.headers["set-cookie"])
        ? authRes.headers["set-cookie"][0]
        : (authRes.headers["set-cookie"] ?? "")
    ).split(";")[0]!;

    const cookieCreate = await fetch(`${srv.url}/v1/objects`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        in: "/ops",
        kind: "service",
        name: "cookie-created",
      }),
    });
    expect(cookieCreate.status).toBe(200);
    const cookieCreatedObj = (await cookieCreate.json()) as {
      object: { id: string };
    };

    const cookieMove = await fetch(`${srv.url}/v1/objects/move`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: cookieCreatedObj.object.id,
        parentRef: parent1.object.id,
      }),
    });
    expect(cookieMove.status).toBe(403);

    const cookieDel = await fetch(`${srv.url}/v1/objects/delete`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: cookieCreatedObj.object.id }),
    });
    expect(cookieDel.status).toBe(403);

    // Suppress unused warning
    expect(humanSurf.mode).toBe("remote");
  });

  it("6. Surface parity: Local CLI vs Remote CLI import md (record & seabed) + verify produce identical state", async () => {
    const corpusDir = makeTempDir("meru-v065-parity-docs-");
    fs.mkdirSync(path.join(corpusDir, "sub"), { recursive: true });
    fs.writeFileSync(
      path.join(corpusDir, "alpha.md"),
      "---\ntitle: Alpha Runbook\ndate: 2026-11-10\ndomain: infra\n---\nFull alpha runbook body with zero truncation.\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(corpusDir, "sub", "beta.md"),
      "---\ntitle: Beta K8s Guide\ndate: 2026-11-11\ndomain: k8s\n---\nFull beta Kubernetes checklist.\n",
      "utf8",
    );
    const mapFile = path.join(makeTempDir("meru-v065-map-"), "map.json");
    fs.writeFileSync(
      mapFile,
      JSON.stringify({
        realmPath: "domain",
        realmMap: { infra: "/ops/infra", k8s: "/ops/infra/k8s" },
      }),
      "utf8",
    );

    // Store A: Local CLI
    const localHome = makeTempDir("meru-v065-parity-local-");
    await runCli(["admin", "init", "--org", "ParityOrg", "--policy", "open"], {
      env: { MERU_MIND_HOME: localHome },
    });
    await runCli(
      [
        "realm",
        "create",
        "--parent",
        "/",
        "--slug",
        "ops",
        "--name",
        "Ops",
        "--scope",
        "Include: ops. Exclude: none.",
        "--as-human",
      ],
      { env: { MERU_MIND_HOME: localHome } },
    );
    await runCli(
      [
        "realm",
        "create",
        "--parent",
        "/ops",
        "--slug",
        "infra",
        "--name",
        "Infra",
        "--scope",
        "Include: infra. Exclude: none.",
        "--as-human",
      ],
      { env: { MERU_MIND_HOME: localHome } },
    );
    await runCli(
      [
        "realm",
        "create",
        "--parent",
        "/ops/infra",
        "--slug",
        "k8s",
        "--name",
        "K8s",
        "--scope",
        "Include: k8s. Exclude: none.",
        "--as-human",
      ],
      { env: { MERU_MIND_HOME: localHome } },
    );

    await runCli(
      ["import", "md", corpusDir, "--map", mapFile, "--in", "/ops", "--json"],
      { env: { MERU_MIND_HOME: localHome } },
    );
    const localVerifyOut = await runCli(
      [
        "import",
        "verify",
        "--source",
        corpusDir,
        "--map",
        mapFile,
        "--in",
        "/ops",
        "--check-realm",
        "/ops/infra",
        "--check-realm",
        "/ops/infra/k8s",
        "--json",
      ],
      { env: { MERU_MIND_HOME: localHome } },
    );
    const localVerify = JSON.parse(localVerifyOut.stdout);

    // Store B: Remote CLI (tree mode + subtree token!)
    const { srv } = await setupTreeServer();
    const subTok = srv.createToken({
      actorId: "parity-bot",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });

    await runCli(
      ["import", "md", corpusDir, "--map", mapFile, "--in", "/ops", "--json"],
      { env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: subTok.token } },
    );
    const remoteVerifyOut = await runCli(
      [
        "import",
        "verify",
        "--source",
        corpusDir,
        "--map",
        mapFile,
        "--in",
        "/ops",
        "--check-realm",
        "/ops/infra",
        "--check-realm",
        "/ops/infra/k8s",
        "--json",
      ],
      { env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: subTok.token } },
    );
    const remoteVerify = JSON.parse(remoteVerifyOut.stdout);

    expect(localVerify.passed).toBe(true);
    expect(remoteVerify.passed).toBe(true);
    expect(remoteVerify.totalSourceFiles).toBe(localVerify.totalSourceFiles);
    expect(remoteVerify.expectedCount).toBe(localVerify.expectedCount);
    expect(remoteVerify.foundCount).toBe(localVerify.foundCount);
    expect(remoteVerify.missingCount).toBe(0);
    expect(remoteVerify.contentMismatchCount).toBe(0);
    expect(remoteVerify.realmMismatchCount).toBe(0);
    expect(remoteVerify.layerMismatchCount).toBe(0);
    expect(remoteVerify.unexpectedCount).toBe(0);
  });

  it("7. Verify mutation / T1 falsification (all 8 cases) & Chinese phrase after char 2,200 searchable via FTS5", async () => {
    const { srv, opsInfraId, opsK8sId } = await setupTreeServer();
    const subTok = srv.createToken({
      actorId: "verify-bot",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const surf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subTok.token,
    });

    const docsDir = makeTempDir("meru-v065-t1-docs-");
    const longPrefix = "架构设计与变更记录。".repeat(300); // > 2,700 Chinese chars
    const tailNeedle = "星际漫游零截断验证短语";
    const longDocPath = path.join(docsDir, "long-cn.md");
    fs.writeFileSync(
      longDocPath,
      `---\ntitle: 超长中文架构文档\ndate: 2026-11-20\n---\n${longPrefix}\n\n尾段核心结论：${tailNeedle}。\n`,
      "utf8",
    );

    // Ingest cleanly into /ops/infra (record) AND /ops/infra/k8s (seabed)
    const recPlan = planMarkdownImport({
      inputPath: docsDir,
      target: "record",
      targetRealmRef: "/ops/infra",
    });
    const recIngest = await surf.importBatch({
      items: recPlan.items,
      defaultRealmRef: "/ops/infra",
    });
    expect(recIngest.created).toBe(1);
    const recId = recIngest.items[0]!.entryId!;

    // (7h) Chinese phrase after char 2,200 MUST be searchable via FTS5!
    const ftsHit = await surf.search({ query: tailNeedle, in: "/ops/infra" });
    expect(ftsHit.items.some((i) => i.id === recId)).toBe(true);

    // Baseline verify passes
    const baseVerifyPlan = planSourceVerification({
      sourcePath: docsDir,
      target: "record",
      targetRealmRef: "/ops/infra",
    });
    const baseVerify = await surf.verifyImport({
      items: baseVerifyPlan.items,
      checkUnexpectedInRealmRefs: ["/ops/infra"],
      allExpectedSourceRefs: baseVerifyPlan.allExpectedSourceRefs,
    });
    expect(baseVerify.passed).toBe(true);

    // (7f) Client lying about contentSha256 on ingest MUST be rejected with 0 writes
    await expect(
      surf.importBatch({
        items: [
          {
            target: "record",
            sourceRef: "lying-client.md",
            realmRef: "/ops/infra",
            title: "Lying client",
            body: "Truncated body",
            contentSha256: sha256("Original full body that client did not send"),
          },
        ],
      }),
    ).rejects.toThrow(/SHA-256 mismatch/i);

    // (7c) Wrong layer: verifying record corpus as --target seabed MUST fail with layerMismatchCount > 0
    const wrongLayerPlan = planSourceVerification({
      sourcePath: docsDir,
      target: "seabed",
      targetRealmRef: "/ops/infra",
    });
    const wrongLayerRes = await surf.verifyImport({
      items: wrongLayerPlan.items,
    });
    expect(wrongLayerRes.passed).toBe(false);
    expect(wrongLayerRes.layerMismatchCount).toBe(1);

    // (7a) Truncated body tail in SQLite even while payload.contentSha256 LIES as original hash!
    const rawConn = new DatabaseSync(path.join(srv.homeDir, "mind.sqlite"));
    const originalPayloadRow = rawConn
      .prepare("SELECT payload_json FROM records WHERE id = ?")
      .get(recId) as { payload_json: string };
    try {
      const parsedPayload = JSON.parse(originalPayloadRow.payload_json) as Record<
        string,
        unknown
      >;
      const tamperedPayload = {
        ...parsedPayload,
        body: String(parsedPayload.body).slice(0, 120),
        // Intentionally KEEP original contentSha256 to prove verify recomputes from actual body!
      };
      rawConn
        .prepare("UPDATE records SET payload_json = ? WHERE id = ?")
        .run(JSON.stringify(tamperedPayload), recId);

      const truncRes = await surf.verifyImport({
        items: baseVerifyPlan.items,
      });
      expect(truncRes.passed).toBe(false);
      expect(truncRes.contentMismatchCount).toBe(1);

      // Restore original payload
      rawConn
        .prepare("UPDATE records SET payload_json = ? WHERE id = ?")
        .run(originalPayloadRow.payload_json, recId);

      // (7b) Wrong realm: move record in SQLite to /ops/infra/k8s while manifest expects /ops/infra
      rawConn
        .prepare("UPDATE records SET realm_id = ? WHERE id = ?")
        .run(opsK8sId, recId);
      const wrongRealmRes = await surf.verifyImport({
        items: baseVerifyPlan.items,
      });
      expect(wrongRealmRes.passed).toBe(false);
      expect(wrongRealmRes.realmMismatchCount).toBe(1);

      // Restore realm
      rawConn
        .prepare("UPDATE records SET realm_id = ? WHERE id = ?")
        .run(opsInfraId, recId);
    } finally {
      rawConn.close();
    }

    // Also test seabed truncation falsification (metadata.contentSha256 lies, sea.text truncated)
    const seaPlan = planMarkdownImport({
      inputPath: docsDir,
      target: "seabed",
      targetRealmRef: "/ops/infra/k8s",
    });
    const seaIngest = await surf.importBatch({
      items: seaPlan.items,
      defaultRealmRef: "/ops/infra/k8s",
    });
    expect(seaIngest.created).toBe(1);
    const seaId = seaIngest.items[0]!.entryId!;
    const seaVerifyPlan = planSourceVerification({
      sourcePath: docsDir,
      target: "seabed",
      targetRealmRef: "/ops/infra/k8s",
    });
    expect(
      (await surf.verifyImport({ items: seaVerifyPlan.items })).passed,
    ).toBe(true);

    const rawConn2 = new DatabaseSync(path.join(srv.homeDir, "mind.sqlite"));
    try {
      rawConn2
        .prepare("UPDATE seabed_entries SET text = substr(text, 1, 60) WHERE id = ?")
        .run(seaId);
      const seaTruncRes = await surf.verifyImport({
        items: seaVerifyPlan.items,
      });
      expect(seaTruncRes.passed).toBe(false);
      expect(seaTruncRes.contentMismatchCount).toBe(1);
    } finally {
      rawConn2.close();
    }

    // (7e) Leftover unexpected imported entry in /ops/infra -> unexpectedCount > 0, passed: false
    await surf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "stale-leftover.md",
          realmRef: "/ops/infra",
          title: "Stale doc",
          body: "Should be flagged as unexpected",
          contentSha256: sha256("Should be flagged as unexpected"),
        },
      ],
    });
    const unexpectedRes = await surf.verifyImport({
      items: baseVerifyPlan.items,
      checkUnexpectedInRealmRefs: ["/ops/infra"],
      allExpectedSourceRefs: baseVerifyPlan.allExpectedSourceRefs,
    });
    expect(unexpectedRes.passed).toBe(false);
    expect(unexpectedRes.unexpectedCount).toBe(1);

    // (7d) Missing 1 source file -> missingCount > 0, CLI exits with code 1
    fs.writeFileSync(
      path.join(docsDir, "missing-doc.md"),
      "# Missing\nNever imported.",
      "utf8",
    );
    const cliMiss = await runCli(
      ["import", "verify", "--source", docsDir, "--in", "/ops/infra", "--json"],
      {
        env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: subTok.token },
        expectFail: true,
      },
    );
    expect(cliMiss.status).toBe(1);
    expect(JSON.parse(cliMiss.stdout).missingCount).toBe(1);
    fs.unlinkSync(path.join(docsDir, "missing-doc.md"));

    // (7g) Secret skip without --allow-skips fails; passes ONLY with --allow-skips 1
    const secDir = makeTempDir("meru-v065-sec-docs-");
    fs.writeFileSync(path.join(secDir, "ok.md"), "# OK\nClean doc.\n", "utf8");
    const fakeKey = ["sk", "proj", "ABCDEF1234567890abcdef1234567890"].join("-");
    fs.writeFileSync(
      path.join(secDir, "leaked.md"),
      `# Leaked\nToken: ${fakeKey}\n`,
      "utf8",
    );
    await runCli(["import", "md", secDir, "--in", "/ops", "--json"], {
      env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: subTok.token },
    });
    const verifyNoAllow = await runCli(
      ["import", "verify", "--source", secDir, "--in", "/ops", "--json"],
      {
        env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: subTok.token },
        expectFail: true,
      },
    );
    expect(verifyNoAllow.status).toBe(1);
    const vNo = JSON.parse(verifyNoAllow.stdout);
    expect(vNo.passed).toBe(false);
    expect(vNo.skippedSecretCount).toBe(1);

    const verifyAllow1 = await runCli(
      [
        "import",
        "verify",
        "--source",
        secDir,
        "--in",
        "/ops",
        "--allow-skips",
        "1",
        "--json",
      ],
      { env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: subTok.token } },
    );
    expect(verifyAllow1.status).toBe(0);
    expect(JSON.parse(verifyAllow1.stdout).passed).toBe(true);
  });

  it("8. Positive control replay of flat-parent truncated subset failure mode -> import verify MUST fail (exit 1)", async () => {
    const { srv } = await setupTreeServer();
    const subTok = srv.createToken({
      actorId: "replay-bot",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const surf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subTok.token,
    });

    // Source corpus has 5 docs intended for /ops/infra & /ops/infra/k8s
    const srcDir = makeTempDir("meru-v065-pos-ctrl-");
    const mapFile = path.join(makeTempDir("meru-v065-pos-map-"), "map.json");
    fs.writeFileSync(
      mapFile,
      JSON.stringify({
        realmPath: "area",
        realmMap: { infra: "/ops/infra", k8s: "/ops/infra/k8s" },
      }),
      "utf8",
    );
    for (let i = 1; i <= 5; i += 1) {
      const area = i <= 3 ? "infra" : "k8s";
      fs.writeFileSync(
        path.join(srcDir, `doc-${i}.md`),
        `---\ntitle: Doc ${i}\narea: ${area}\n---\n` +
          `Full document ${i} body. `.repeat(40) +
          "\n",
        "utf8",
      );
    }

    // Simulate broken ingestion: only 2 of 5 docs imported, truncated to 40 chars, dumped flat into /ops!
    for (let i = 1; i <= 2; i += 1) {
      const trunc = `Full document ${i} body. `.slice(0, 40);
      await surf.importBatch({
        items: [
          {
            target: "record",
            sourceRef: `doc-${i}.md`,
            realmRef: "/ops",
            title: `Doc ${i}`,
            body: trunc,
            contentSha256: sha256(trunc),
          },
        ],
      });
    }

    const cliRes = await runCli(
      [
        "import",
        "verify",
        "--source",
        srcDir,
        "--map",
        mapFile,
        "--in",
        "/ops",
        "--check-realm",
        "/ops",
        "--json",
      ],
      {
        env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: subTok.token },
        expectFail: true,
      },
    );
    expect(cliRes.status).toBe(1);
    const verdict = JSON.parse(cliRes.stdout);
    expect(verdict.passed).toBe(false);
    expect(verdict.missingCount).toBe(3);
    expect(verdict.realmMismatchCount).toBe(2);
    expect(verdict.contentMismatchCount).toBe(2);
  });

  it("9. Reliability & edge cases: rollback, >1.2MB reject, invalid UTF-8, NFD->NFC, cross-chunk supersedes & cycles, concurrent lock, ReDoS latency, dry-run zero WakeBus", async () => {
    const { srv, opsInfraId } = await setupTreeServer();
    const subTok = srv.createToken({
      actorId: "edge-bot",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const surf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subTok.token,
    });

    // 9a. Dry-run executes exact same path inside rolled-back txn with ZERO WakeBus / DB commit events!
    let commitEvents = 0;
    const unsubCommit = srv.engine.db.onChangeCommitted((evts) => {
      commitEvents += evts.length;
    });
    const dryBody = "Dry run test body";
    const dryRes = await surf.importBatch({
      dryRun: true,
      items: [
        {
          target: "record",
          sourceRef: "dry-note.md",
          realmRef: "/ops/infra",
          title: "Dry Note",
          body: dryBody,
          contentSha256: sha256(dryBody),
        },
      ],
    });
    unsubCommit();
    expect(dryRes.dryRun).toBe(true);
    expect(dryRes.created).toBe(1);
    expect(dryRes.realmProjections).toHaveLength(1);
    expect(dryRes.realmProjections![0]!.realmPath).toBe("/ops/infra");
    expect(dryRes.realmProjections![0]!.projectedDelta).toBe(1);
    expect(commitEvents).toBe(0);
    expect(
      srv.engine.db.listRecords({ realmIds: [opsInfraId] }).items,
    ).toHaveLength(0);

    // 9b. Partial chunk failure rolls back atomically (item #0 must NOT commit if item #1 fails!)
    const okBody = "Should roll back";
    await expect(
      surf.importBatch({
        items: [
          {
            target: "record",
            sourceRef: "tx-ok.md",
            realmRef: "/ops/infra",
            title: "OK item",
            body: okBody,
            contentSha256: sha256(okBody),
          },
          {
            target: "record",
            sourceRef: "tx-bad.md",
            realmRef: "/", // forbidden ancestor!
            title: "Bad item",
            body: okBody,
            contentSha256: sha256(okBody),
          },
        ],
      }),
    ).rejects.toThrow();
    expect(
      srv.engine.db.listRecords({ realmIds: [opsInfraId] }).items,
    ).toHaveLength(0);

    // 9c. Oversized > 1.2 MB rejected (client planner AND server ingestBatch)
    const edgeDir = makeTempDir("meru-v065-edge-");
    const bigFile = path.join(edgeDir, "too-big.md");
    fs.writeFileSync(bigFile, "X".repeat(MAX_IMPORT_ITEM_BYTES + 100), "utf8");
    expect(() => planMarkdownImport({ inputPath: bigFile })).toThrow(
      /import limit/i,
    );
    fs.unlinkSync(bigFile);

    // 9d. Invalid UTF-8 rejected with fatal TextDecoder (zero U+FFFD replacement!)
    const badUtf8File = path.join(edgeDir, "bad-utf8.md");
    fs.writeFileSync(badUtf8File, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x80]));
    expect(() => planMarkdownImport({ inputPath: badUtf8File })).toThrow(
      /Invalid UTF-8/i,
    );
    const badVerifyPlan = planSourceVerification({ sourcePath: edgeDir });
    expect(badVerifyPlan.unaccountedPaths.some((p) => p.includes("invalid_utf8"))).toBe(true);
    fs.unlinkSync(badUtf8File);

    // 9e. macOS NFD filename normalized to NFC + idempotent retries
    const nfdName = "caf\u0065\u0301.md";
    const nfcName = nfdName.normalize("NFC");
    const cafeBody = "Espresso notes";
    const nfdRes1 = await surf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: nfdName,
          realmRef: "/ops/infra",
          title: "Cafe",
          body: cafeBody,
          contentSha256: sha256(cafeBody),
        },
      ],
    });
    expect(nfdRes1.created).toBe(1);
    expect(nfdRes1.items[0]!.sourceRef).toBe(nfcName);

    const nfcRetry = await surf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: nfcName,
          realmRef: "/ops/infra",
          title: "Cafe",
          body: cafeBody,
          contentSha256: sha256(cafeBody),
        },
      ],
    });
    expect(nfcRetry.skippedUnchanged).toBe(1);
    expect(nfcRetry.created).toBe(0);

    // 9f. Cross-chunk supersedesSourceRefs + cycle rejection
    const v1Body = "Policy v1";
    const v2Body = "Policy v2 supersedes v1";
    const chunk1 = await surf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "policy-v1.md",
          realmRef: "/ops/infra",
          kind: "decision",
          title: "Policy v1",
          body: v1Body,
          contentSha256: sha256(v1Body),
        },
      ],
    });
    const chunk2 = await surf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "policy-v2.md",
          realmRef: "/ops/infra",
          kind: "decision",
          title: "Policy v2",
          body: v2Body,
          contentSha256: sha256(v2Body),
          supersedesSourceRefs: ["policy-v1.md"],
        },
      ],
    });
    expect(chunk2.superseded).toBe(1);
    expect(chunk2.items[0]!.supersedesId).toBe(chunk1.items[0]!.entryId);

    // Cycle rejection in client planner when mapping.supersedes is configured;
    // unmapped frontmatter.supersedes does NOT auto-trigger supersedes (P1-1)
    const cycDir = makeTempDir("meru-v065-cyc-");
    fs.writeFileSync(
      path.join(cycDir, "a.md"),
      "---\ntitle: A\nsupersedes: b.md\n---\nBody A\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(cycDir, "b.md"),
      "---\ntitle: B\nsupersedes: a.md\n---\nBody B\n",
      "utf8",
    );
    const unmappedPlan = planMarkdownImport({ inputPath: cycDir });
    expect(unmappedPlan.items).toHaveLength(2);
    expect(unmappedPlan.items[0]!.supersedesSourceRefs).toBeUndefined();
    expect(() =>
      planMarkdownImport({
        inputPath: cycDir,
        mapping: { supersedes: "supersedes" },
      }),
    ).toThrow(/cycle/i);

    // 9g. Per-token concurrent import guard (409 CONFLICT while first request is streaming!)
    const u = new URL(`${srv.url}/v1/import/batch`);
    const slowBody = JSON.stringify({ items: [] });
    const req1Result = new Promise<number>((resolve, reject) => {
      const req1 = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: "POST",
          headers: {
            Authorization: `Bearer ${subTok.token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(slowBody),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req1.on("error", reject);
      // Send only first byte so server holds inFlightImportTokens lock while awaiting stream end
      req1.write(slowBody.slice(0, 1));
      setTimeout(() => {
        req1.end(slowBody.slice(1));
      }, 150);
    });

    await new Promise((r) => setTimeout(r, 40));
    const concurrentRes = await fetch(`${srv.url}/v1/import/batch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${subTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: [] }),
    });
    expect(concurrentRes.status).toBe(409);
    expect(await req1Result).toBe(200);

    // After first request finishes, lock is released and next request succeeds
    const afterLockRes = await fetch(`${srv.url}/v1/import/batch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${subTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: [] }),
    });
    expect(afterLockRes.status).toBe(200);

    // 9h. Secret Guard 1.2 MB non-ReDoS latency check (< 200ms)
    const adv1 = "sk-" + "a".repeat(1_199_990) + "!";
    const adv2 = "-----BEGIN " + "A".repeat(1_199_900);
    const t0 = performance.now();
    detectPlaintextSecret(adv1);
    detectPlaintextSecret(adv2);
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(200);
  });

  it("10. Differential policy matrix: resolveWriteAccess(self) === legacy resolveAccess(write) + unified getWritableRealmIds", async () => {
    const { srv, opsId, opsInfraId, opsK8sId, opsArchivedId, opsXId, secId } =
      await setupTreeServer();
    const root = srv.engine.db.getRealmByPath(srv.orgId, "/")!;
    const realms = srv.engine.db.listRealms();
    const mounts = srv.engine.db.listMounts();
    const actors: Actor[] = [
      { id: "h", kind: "human" },
      { id: "a", kind: "agent" },
    ];
    const policies: OrgPolicy[] = ["tree", "open"];
    const assets: AssetKind[] = ["ledger", "rule", "seabed", "drive"];
    const viewerIds = [root.id, opsId, opsInfraId, opsXId, secId];
    const targetIds = [
      root.id,
      opsId,
      opsInfraId,
      opsK8sId,
      opsArchivedId,
      opsXId,
      secId,
    ];

    let cellsChecked = 0;
    for (const orgPolicy of policies) {
      for (const actor of actors) {
        for (const viewerRealmId of viewerIds) {
          for (const targetRealmId of targetIds) {
            const archived = isRealmEffectivelyArchived(realms, targetRealmId);
            for (const assetKind of assets) {
              const legacyWrite =
                resolveAccess({
                  realms,
                  mounts,
                  actor,
                  viewerRealmId,
                  targetRealmId,
                  assetKind,
                  orgPolicy,
                }) === "write";
              const newWrite =
                resolveWriteAccess({
                  realms,
                  mounts,
                  actor,
                  viewerRealmId,
                  targetRealmId,
                  assetKind,
                  orgPolicy,
                  writeScope: "self",
                  category: assetKind === "rule" ? "admin" : "content",
                }) === "write";

              if (archived) {
                expect(() =>
                  assertWriteAccess({
                    realms,
                    mounts,
                    actor,
                    viewerRealmId,
                    targetRealmId,
                    assetKind,
                    orgPolicy,
                    writeScope: "self",
                    category: assetKind === "rule" ? "admin" : "content",
                  }),
                ).toThrow();
              }
              expect(newWrite).toBe(legacyWrite);
              cellsChecked += 1;
            }
          }

          // Verify getWritableRealmIds(scopeCeiling, excludeArchived: true) matches assertWriteAccess cell-for-cell!
          for (const ws of ["self", "subtree"] as const) {
            for (const assetKind of ["ledger", "seabed"] as const) {
              const scopeCeiling = resolveAccessScope({
                realms,
                mounts,
                viewerRealmId,
                orgPolicy,
                includeDescendantSeabed: ws === "subtree",
              });
              const writableSet = new Set(
                getWritableRealmIds({
                  realms,
                  orgPolicy,
                  viewerRealmId,
                  writeScope: ws,
                  scopeCeiling,
                  assetKind,
                  excludeArchived: true,
                }),
              );
              for (const targetRealmId of targetIds) {
                let assertAllows = true;
                try {
                  assertWriteAccess({
                    realms,
                    mounts,
                    actor,
                    viewerRealmId,
                    targetRealmId,
                    assetKind,
                    orgPolicy,
                    writeScope: ws,
                    category: "content",
                  });
                } catch {
                  assertAllows = false;
                }
                expect(writableSet.has(targetRealmId)).toBe(assertAllows);
              }
            }
          }
        }
      }
    }
    expect(cellsChecked).toBeGreaterThanOrEqual(500);
  });

  it("11. Round-2 P0 security attacks: extraPayload overwrite (P0-1), realm-unscoped/arbitrary idempotency (P0-2), secret verify oracle & self seabed dive (P0-4)", async () => {
    const { srv, opsInfraId, secId } = await setupTreeServer();
    const rootAdmin: Actor = { id: "alice-admin", kind: "human" };
    const opsSub = srv.createToken({
      actorId: "ops-sec-bot",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const opsSelf = srv.createToken({
      actorId: "ops-self-bot",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "self",
    });
    const secSelf = srv.createToken({
      actorId: "sec-bot",
      actorKind: "agent",
      boundRealmId: "/sec",
      writeScope: "self",
    });
    const opsSubSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: opsSub.token,
    });
    const opsSelfSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: opsSelf.token,
    });
    const secSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: secSelf.token,
    });

    // P0-1: extraPayload containing reserved keys MUST be rejected with 400 INVALID_INPUT and 0 rows written
    const fakeLeak = ["ghp", "1234567890abcdef1234567890abcdef1234"].join("_");
    for (const reservedKey of [
      "body",
      "contentSha256",
      "sourceRef",
      "summary",
      "frontmatter",
      "sourceId",
      "rawContentSha256",
    ]) {
      await expect(
        opsSubSurf.importBatch({
          items: [
            {
              target: "record",
              sourceRef: `p01-${reservedKey}.md`,
              realmRef: "/ops/infra",
              title: "Clean Title",
              body: "Clean body",
              contentSha256: sha256("Clean body"),
              extraPayload: { [reservedKey]: fakeLeak },
            },
          ],
        }),
      ).rejects.toThrow(/Reserved key/i);
    }
    expect(
      srv.engine.db.listRecords({ realmIds: [opsInfraId] }).items,
    ).toHaveLength(0);

    // P0-2: Two sibling realms importing identical JSONL items MUST NOT collide or leak across realms
    const rowBody = "Shared incident schema event";
    const rowSha = sha256(rowBody);
    const rawSha = sha256('{"id":"evt-42","body":"Shared incident schema event"}');
    const secCreate = await secSurf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "shared:evt-42",
          sourceId: "evt-42",
          idempotencyPrefix: "import-jsonl",
          realmRef: "/sec",
          title: "Event 42",
          body: rowBody,
          contentSha256: rowSha,
          rawContentSha256: rawSha,
        },
      ],
    });
    expect(secCreate.created).toBe(1);

    // Probing from /ops via dryRun:true MUST NOT see /sec's idempotency key!
    const opsDryProbe = await opsSubSurf.importBatch({
      dryRun: true,
      items: [
        {
          target: "record",
          sourceRef: "shared:evt-42",
          sourceId: "evt-42",
          idempotencyPrefix: "import-jsonl",
          realmRef: "/ops",
          title: "Event 42",
          body: rowBody,
          contentSha256: rowSha,
          rawContentSha256: rawSha,
        },
      ],
    });
    expect(opsDryProbe.created).toBe(1);
    expect(opsDryProbe.skippedUnchanged).toBe(0);

    // Real import in /ops MUST create its own independent record in /ops!
    const opsCreate = await opsSubSurf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "shared:evt-42",
          sourceId: "evt-42",
          idempotencyPrefix: "import-jsonl",
          realmRef: "/ops",
          title: "Event 42",
          body: rowBody,
          contentSha256: rowSha,
          rawContentSha256: rawSha,
        },
      ],
    });
    expect(opsCreate.created).toBe(1);
    expect(opsCreate.items[0]!.entryId).not.toBe(secCreate.items[0]!.entryId);
    expect(opsCreate.items[0]!.realmPath).toBe("/ops");

    // Re-running in /ops is idempotent
    const opsRetry = await opsSubSurf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "shared:evt-42",
          sourceId: "evt-42",
          idempotencyPrefix: "import-jsonl",
          realmRef: "/ops",
          title: "Event 42",
          body: rowBody,
          contentSha256: rowSha,
          rawContentSha256: rawSha,
        },
      ],
    });
    expect(opsRetry.skippedUnchanged).toBe(1);

    // Arbitrary client-controlled idempotencyPrefix MUST be rejected with 400
    await expect(
      opsSubSurf.importBatch({
        items: [
          {
            target: "record",
            sourceRef: "evil-idemp.md",
            realmRef: "/ops",
            title: "Probe",
            body: rowBody,
            contentSha256: rowSha,
            idempotencyPrefix: "evil-cross-realm-probe",
          },
        ],
      }),
    ).rejects.toThrow(/Invalid idempotencyPrefix/i);

    // P0-4: sensitivity:"secret" entries MUST NEVER have hashes/byte-lengths leaked by verifyImport
    const secretPayloadBody = "Ultra-confidential launch code 999";
    const secretRealSha = sha256(secretPayloadBody);
    await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: opsInfraId,
      targetRealmId: opsInfraId,
      kind: "claim",
      title: "Secret Note",
      payload: { body: secretPayloadBody, contentSha256: secretRealSha },
      sourceRef: "top-secret-rec.md",
      sensitivity: "secret",
    });
    await srv.engine.ledger.captureSeabed({
      actor: rootAdmin,
      viewerRealmId: opsInfraId,
      targetRealmId: opsInfraId,
      kind: "artifact",
      text: secretPayloadBody,
      preserveExactText: true,
      sourceRef: "top-secret-sea.md",
      sensitivity: "secret",
    });

    const secVerifyOracle = await opsSubSurf.verifyImport({
      items: [
        {
          target: "record",
          sourceRef: "top-secret-rec.md",
          expectedRealmRef: "/ops/infra",
          contentSha256: sha256("wrong guess"),
          byteLength: 11,
          expectedOccurredAt: null,
        },
        {
          target: "seabed",
          sourceRef: "top-secret-sea.md",
          expectedRealmRef: "/ops/infra",
          contentSha256: sha256("wrong guess"),
          byteLength: 11,
          expectedOccurredAt: null,
        },
      ],
      checkUnexpectedInRealmRefs: ["/ops/infra"],
    });
    expect(secVerifyOracle.missingCount).toBe(2);
    expect(secVerifyOracle.contentMismatchCount).toBe(0);
    expect(secVerifyOracle.unexpectedCount).toBe(0);
    // Secret real SHA MUST NOT appear anywhere in verify response!
    expect(JSON.stringify(secVerifyOracle)).not.toContain(secretRealSha);

    // P0-4: self-scoped caller MUST NOT implicitly dive into descendant seabed via linkObject / unlinkObject
    const childSea = await srv.engine.ledger.captureSeabed({
      actor: rootAdmin,
      viewerRealmId: opsInfraId,
      targetRealmId: opsInfraId,
      kind: "evidence",
      text: "Descendant seabed evidence",
    });
    const opsObj = await opsSelfSurf.createObject({
      in: "/ops",
      kind: "service",
      name: "self-svc",
    });
    await expect(
      opsSelfSurf.linkObject({
        entryId: childSea.id,
        objectRef: opsObj.object.id,
      }),
    ).rejects.toThrow(/not found|access/i);
    // Subtree caller CAN link descendant seabed
    const subLink = await opsSubSurf.linkObject({
      entryId: childSea.id,
      objectRef: opsObj.object.id,
    });
    expect(subLink.entryId).toBe(childSea.id);

    // P0-4: Ledger-only mounted realm (both direct /sec AND hidden-ancestor @mounted/vault) MUST NOT expose seabed via verify --check-realm
    const secVault = srv.engine.ledger.createRealm({
      orgId: srv.orgId,
      parentId: secId,
      slug: "vault",
      name: "Sec Vault",
      scope: "Include: vault. Exclude: public.",
      actor: rootAdmin,
    });
    const opsRealmId = srv.engine.db.getRealmByPath(srv.orgId, "/ops")!.id;
    srv.engine.ledger.unmountRealm({
      actor: rootAdmin,
      viewerRealmId: opsRealmId,
      targetRealmId: secId,
    });
    srv.engine.ledger.mountRealm({
      actor: rootAdmin,
      viewerRealmId: opsRealmId,
      targetRealmId: secVault.id,
      scope: "ledger",
    });
    await srv.engine.ledger.captureSeabed({
      actor: rootAdmin,
      viewerRealmId: secVault.id,
      targetRealmId: secVault.id,
      kind: "artifact",
      text: "Hidden seabed in ledger-only mounted realm",
      preserveExactText: true,
      sourceRef: "mounted-sec-seabed.md",
    });
    const mountCheck = await opsSubSurf.verifyImport({
      items: [],
      checkUnexpectedInRealmRefs: ["@mounted/vault"],
    });
    expect(
      mountCheck.unexpectedEntries.some(
        (e) => e.sourceRef === "mounted-sec-seabed.md",
      ),
    ).toBe(false);
  });

  it("12. Round-2 P1 & P2 regressions: idempotent MD supersedes (P1-1), cross-chunk sourceId supersedes (P1-2), verify 250 cap (P1-4), composite check-realm & title verify (P1-5), frontmatter/extraPayload secret guard & sensitivity enum (P1-6), v14 NFC migration (P1-9), HTTP 400 validation on all 9 routes (P1-10), empty/BOM seabed, deep Kahn sort & stripped filePath (P2)", async () => {
    const { srv, opsInfraId } = await setupTreeServer();
    const subHuman = srv.createToken({
      actorId: "p1-human",
      actorKind: "human",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const surf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subHuman.token,
    });

    // P1-1: Markdown with mapping.supersedes re-imported twice -> 2nd run is idempotent (skippedUnchanged: 1)
    const mdSupDir = makeTempDir("meru-v065-p11-");
    fs.writeFileSync(
      path.join(mdSupDir, "v1.md"),
      "---\ntitle: Spec v1\n---\nInitial spec body\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(mdSupDir, "v2.md"),
      "---\ntitle: Spec v2\nsupersedes: v1.md\n---\nUpdated spec body\n",
      "utf8",
    );
    const mdSupPlan = planMarkdownImport({
      inputPath: mdSupDir,
      targetRealmRef: "/ops/infra",
      mapping: { supersedes: "supersedes" },
    });
    const mdRun1 = await surf.importBatch({
      items: mdSupPlan.items,
      defaultRealmRef: "/ops/infra",
    });
    expect(mdRun1.created).toBe(1);
    expect(mdRun1.superseded).toBe(1);

    const mdRun2 = await surf.importBatch({
      items: mdSupPlan.items,
      defaultRealmRef: "/ops/infra",
    });
    expect(mdRun2.skippedUnchanged).toBe(2);
    expect(mdRun2.created).toBe(0);
    expect(mdRun2.superseded).toBe(0);

    // P1-2: Cross-chunk JSONL where mapping.sourceRef differs from mapping.id (sourceId)
    const jsonlFile = path.join(makeTempDir("meru-v065-p12-"), "events.jsonl");
    fs.writeFileSync(
      jsonlFile,
      [
        JSON.stringify({
          id: "rec-id-1",
          customRef: "docs/custom-ref-1",
          title: "First Version",
          body: "Body v1",
        }),
        JSON.stringify({
          id: "rec-id-2",
          customRef: "docs/custom-ref-2",
          title: "Second Version",
          body: "Body v2",
          prev: "rec-id-1",
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    const jsonlPlan = planJsonlImport({
      jsonlPath: jsonlFile,
      mapping: {
        id: "id",
        sourceRef: "customRef",
        title: "title",
        body: "body",
        supersedes: "prev",
      },
      targetRealmRef: "/ops/infra",
    });
    expect(jsonlPlan.items).toHaveLength(2);
    // Send in 2 SEPARATE chunks! Chunk 2 must resolve "rec-id-1" via payload.sourceId in /ops/infra!
    const jChunk1 = await surf.importBatch({
      items: [jsonlPlan.items[0]!],
      defaultRealmRef: "/ops/infra",
    });
    expect(jChunk1.created).toBe(1);
    const jChunk2 = await surf.importBatch({
      items: [jsonlPlan.items[1]!],
      defaultRealmRef: "/ops/infra",
    });
    expect(jChunk2.superseded).toBe(1);
    expect(jChunk2.items[0]!.supersedesId).toBe(jChunk1.items[0]!.entryId);
    const oldRow = srv.engine.db.getRecord(jChunk1.items[0]!.entryId!);
    expect(oldRow?.status).toBe("superseded");

    // P1-4: /v1/import/verify with > 250 items MUST return HTTP 400
    const tooManyVerifyItems = Array.from(
      { length: MAX_VERIFY_MANIFEST_ITEMS + 1 },
      (_, idx) => ({
        target: "record" as const,
        sourceRef: `item-${idx}.md`,
        expectedRealmRef: "/ops/infra",
        contentSha256: sha256("x"),
        byteLength: 1,
        expectedOccurredAt: null,
      }),
    );
    const capRes = await fetch(`${srv.url}/v1/import/verify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${subHuman.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: tooManyVerifyItems }),
    });
    expect(capRes.status).toBe(400);

    // P1-5: Composite (realmId, layer, sourceRef) unexpected check + stored title tamper check
    const p15Dir = makeTempDir("meru-v065-p15-");
    fs.writeFileSync(
      path.join(p15Dir, "note.md"),
      "---\ntitle: Original Title\n---\nStable body content\n",
      "utf8",
    );
    const p15Plan = planMarkdownImport({
      inputPath: p15Dir,
      target: "record",
      targetRealmRef: "/ops",
    });
    const p15Ingest = await surf.importBatch({
      items: p15Plan.items,
      defaultRealmRef: "/ops",
    });
    const p15RecId = p15Ingest.items[0]!.entryId!;
    // Plant a stale SEABED entry with the EXACT same sourceRef "note.md" in /ops (self seabed readable!)
    await surf.importBatch({
      items: [
        {
          target: "seabed",
          sourceRef: "note.md",
          realmRef: "/ops",
          text: "Stale seabed duplicate of note.md",
          contentSha256: sha256("Stale seabed duplicate of note.md"),
        },
      ],
    });
    const p15VerifyPlan = planSourceVerification({
      sourcePath: p15Dir,
      target: "record",
      targetRealmRef: "/ops",
    });
    const p15LayerDup = await surf.verifyImport({
      items: p15VerifyPlan.items,
      checkUnexpectedInRealmRefs: ["/ops"],
      allExpectedEntries: p15VerifyPlan.allExpectedEntries,
    });
    expect(p15LayerDup.passed).toBe(false);
    expect(p15LayerDup.unexpectedCount).toBe(1);
    expect(p15LayerDup.unexpectedEntries[0]!.layer).toBe("seabed");

    // Also verify cross-realm stale record duplicate in /ops/infra when expected in /ops
    await surf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "other-realm-dup.md",
          realmRef: "/ops/infra",
          title: "Cross-realm dup",
          body: "Should be flagged in /ops/infra",
          contentSha256: sha256("Should be flagged in /ops/infra"),
        },
      ],
    });
    const p15CrossRealm = await surf.verifyImport({
      items: p15VerifyPlan.items,
      checkUnexpectedInRealmRefs: ["/ops/infra"],
      allExpectedEntries: p15VerifyPlan.allExpectedEntries,
    });
    expect(p15CrossRealm.passed).toBe(false);
    expect(
      p15CrossRealm.unexpectedEntries.some(
        (e) => e.sourceRef === "other-realm-dup.md" && e.realmPath === "/ops/infra",
      ),
    ).toBe(true);

    // Tamper ONLY title in SQLite while keeping payload.body 100% intact -> verify MUST catch it!
    const rawDb = new DatabaseSync(path.join(srv.homeDir, "mind.sqlite"));
    try {
      rawDb
        .prepare("UPDATE records SET title = 'Corrupted Title' WHERE id = ?")
        .run(p15RecId);
      const titleTamper = await surf.verifyImport({
        items: p15VerifyPlan.items,
      });
      expect(titleTamper.passed).toBe(false);
      expect(titleTamper.contentMismatchCount).toBe(1);
    } finally {
      rawDb.close();
    }

    // P1-6: Frontmatter & extraPayload Secret Guard + strict sensitivity enum validation
    const fakeOpenAi = ["sk", "proj", "ZZZZ1234567890abcdef1234567890"].join("-");
    const fmSecretSkip = await surf.importBatch({
      skipSecret: true,
      items: [
        {
          target: "record",
          sourceRef: "fm-secret.md",
          realmRef: "/ops",
          title: "Clean Title",
          body: "Clean Body",
          contentSha256: sha256("Clean Body"),
          frontmatter: { api_key: fakeOpenAi },
        },
        {
          target: "record",
          sourceRef: "extra-secret.md",
          realmRef: "/ops",
          title: "Clean Title 2",
          body: "Clean Body 2",
          contentSha256: sha256("Clean Body 2"),
          extraPayload: { notes: `token=${fakeOpenAi}` },
        },
      ],
    });
    expect(fmSecretSkip.skippedSecret).toBe(2);
    expect(fmSecretSkip.created).toBe(0);

    await expect(
      surf.importBatch({
        skipSecret: false,
        items: [
          {
            target: "record",
            sourceRef: "fm-secret-strict.md",
            realmRef: "/ops",
            title: "Clean Title",
            body: "Clean Body",
            contentSha256: sha256("Clean Body"),
            frontmatter: { api_key: fakeOpenAi },
          },
        ],
      }),
    ).rejects.toThrow(/secret|credential/i);

    await expect(
      surf.importBatch({
        items: [
          {
            target: "record",
            sourceRef: "bad-sens.md",
            realmRef: "/ops",
            title: "Bad Sens",
            body: "Body",
            contentSha256: sha256("Body"),
            sensitivity: "topsecret" as never,
          },
        ],
      }),
    ).rejects.toThrow(/Invalid sensitivity/i);

    // P1-9: Schema Migration v14 NFC-normalizes pre-existing NFD source_ref rows!
    const migDir = makeTempDir("meru-v065-mig14-");
    const migDbPath = path.join(migDir, "mind.sqlite");
    const initDb = new SqliteDb({ dbPath: migDbPath });
    const migNow = new Date().toISOString();
    const migOrg = {
      id: "org_mig14",
      name: "MigOrg",
      policy: "tree" as const,
      createdAt: migNow,
    };
    initDb.insertOrg(migOrg);
    const migRoot = {
      id: "realm_mig14_root",
      orgId: migOrg.id,
      parentId: null,
      slug: "root",
      path: "/",
      name: "Root",
      scope: "Include: all. Exclude: none.",
      archivedAt: null,
      createdAt: migNow,
    };
    initDb.insertRealm(migRoot);
    initDb.close();

    // Simulate pre-v14 DB containing NFD source_ref rows in records, seabed_entries, redacted_blocklist
    const nfdRef = "docs/caf\u0065\u0301-re\u0301sume\u0301.md";
    const nfcRef = nfdRef.normalize("NFC");
    expect(nfdRef).not.toBe(nfcRef);
    const migRaw = new DatabaseSync(migDbPath);
    try {
      const now = new Date().toISOString();
      migRaw
        .prepare(
          `INSERT INTO records (id, org_id, realm_id, kind, status, author_id, author_kind, title, payload_json, refs_json, source_ref, occurred_at, created_at, sensitivity)
           VALUES ('rec_nfd1', ?, ?, 'claim', 'active', 'alice', 'human', 'NFD Rec', '{}', '[]', ?, NULL, ?, 'internal')`,
        )
        .run(migOrg.id, migRoot.id, nfdRef, now);
      migRaw
        .prepare(
          `INSERT INTO seabed_entries (id, org_id, realm_id, kind, author_id, author_kind, text, source_ref, metadata_json, occurred_at, created_at, sensitivity)
           VALUES ('sea_nfd1', ?, ?, 'artifact', 'alice', 'human', 'NFD Sea', ?, '{}', NULL, ?, 'internal')`,
        )
        .run(migOrg.id, migRoot.id, nfdRef, now);
      migRaw
        .prepare(
          `INSERT INTO redacted_blocklist (org_id, source_ref, content_sha256, reason, redacted_at)
           VALUES (?, ?, ?, 'test', ?)`,
        )
        .run(migOrg.id, nfdRef, sha256("x"), now);
      migRaw.exec("DELETE FROM schema_migrations WHERE version >= 14");
    } finally {
      migRaw.close();
    }

    const reopenedDb = new SqliteDb({ dbPath: migDbPath });
    try {
      const recAfter = reopenedDb.getRecord("rec_nfd1");
      const seaAfter = reopenedDb.getSeabedEntry("sea_nfd1");
      expect(recAfter?.sourceRef).toBe(nfcRef);
      expect(seaAfter?.sourceRef).toBe(nfcRef);
      expect(reopenedDb.isRedactedBlocked(migOrg.id, nfcRef, sha256("x"))).toBe(
        true,
      );
    } finally {
      reopenedDb.close();
    }

    // P1-10: Malformed {} bodies sent to ALL 9 new HTTP routes MUST return 400 invalid_input (NEVER 500!)
    const nineRoutes: Array<{ path: string; body: Record<string, unknown> }> = [
      { path: "/v1/objects", body: {} },
      { path: "/v1/objects/move", body: {} },
      { path: "/v1/objects/delete", body: {} },
      { path: "/v1/objects/link", body: {} },
      { path: "/v1/objects/unlink", body: {} },
      { path: "/v1/objects/state", body: {} },
      { path: "/v1/objects/aliases", body: {} },
      { path: "/v1/import/batch", body: { items: "not-an-array" } },
      { path: "/v1/import/verify", body: { items: "not-an-array" } },
    ];
    for (const route of nineRoutes) {
      const res = await fetch(`${srv.url}${route.path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${subHuman.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(route.body),
      });
      expect(res.status, `Route ${route.path} must return 400`).toBe(400);
      const errJson = (await res.json()) as { error?: string };
      expect(errJson.error).toBe("invalid_input");
    }

    // P2: Empty .md & UTF-8 BOM-prefixed .md imported to seabed preserve exact bytes & pass verify
    const p2Dir = makeTempDir("meru-v065-p2-seabed-");
    fs.writeFileSync(path.join(p2Dir, "empty.md"), "", "utf8");
    fs.writeFileSync(
      path.join(p2Dir, "bom.md"),
      "\uFEFF# BOM Document\nExact BOM preserved.\n",
      "utf8",
    );
    const p2Import = await runCli(
      ["import", "md", p2Dir, "--target", "seabed", "--in", "/ops", "--json"],
      { env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: subHuman.token } },
    );
    // P2: Remote CLI MUST strip local absolute filePath before HTTP transmission
    expect(p2Import.stdout).not.toContain(p2Dir);
    const p2Verify = await runCli(
      [
        "import",
        "verify",
        "--source",
        p2Dir,
        "--target",
        "seabed",
        "--in",
        "/ops",
        "--json",
      ],
      { env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: subHuman.token } },
    );
    expect(JSON.parse(p2Verify.stdout).passed).toBe(true);

    // P2: Deep 400-node reverse-ordered chain passes iterative Kahn topological sort without stack overflow
    const deepDir = makeTempDir("meru-v065-deep-chain-");
    const chainJsonl = path.join(deepDir, "chain.jsonl");
    const chainLines: string[] = [];
    for (let i = 400; i >= 1; i -= 1) {
      chainLines.push(
        JSON.stringify({
          id: `n-${i}`,
          title: `Node ${i}`,
          body: `Body ${i}`,
          ...(i > 1 ? { prev: `n-${i - 1}` } : {}),
        }),
      );
    }
    fs.writeFileSync(chainJsonl, chainLines.join("\n") + "\n", "utf8");
    const deepPlan = planJsonlImport({
      jsonlPath: chainJsonl,
      mapping: {
        id: "id",
        title: "title",
        body: "body",
        supersedes: "prev",
      },
    });
    expect(deepPlan.items).toHaveLength(400);
    expect(deepPlan.items[0]!.sourceId).toBe("n-1");
    expect(deepPlan.items[399]!.sourceId).toBe("n-400");

    // P2: Self-supersedes rejected with clear error
    const selfSupJsonl = path.join(deepDir, "self-sup.jsonl");
    fs.writeFileSync(
      selfSupJsonl,
      JSON.stringify({
        id: "self-1",
        title: "Self",
        body: "Self",
        prev: "self-1",
      }) + "\n",
      "utf8",
    );
    expect(() =>
      planJsonlImport({
        jsonlPath: selfSupJsonl,
        mapping: {
          id: "id",
          title: "title",
          body: "body",
          supersedes: "prev",
        },
      }),
    ).toThrow(/self-supersedes/i);

    // Suppress unused check
    expect(opsInfraId).toBeTruthy();
  });

  it("13. Round-3 audit hardening: strict verify descendant-seabed gating (P0 Option A) + differential visibility subset, secret ingest/dryRun isolation (P1-2), tree move_out protection (P1-3), legacy JSONL head idempotency (P1-4), array caps & sourceId index EXPLAIN QUERY PLAN (P1-5), relocate rule-smuggling block (P1-6), per-item runtime type validation & /v1/redact {} -> 400 (P1-7), and symlink .md alignment (P2)", async () => {
    const { srv, opsId, opsInfraId, secId } = await setupTreeServer();
    const rootAdmin: Actor = { id: "alice-admin", kind: "human" };

    // Remove /sec mount so /sec is hidden sibling
    srv.engine.ledger.unmountRealm({
      actor: rootAdmin,
      viewerRealmId: opsId,
      targetRealmId: secId,
    });

    const selfAgent = srv.createToken({
      actorId: "r3-self-agent",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "self",
    });
    const subAgent = srv.createToken({
      actorId: "r3-sub-agent",
      actorKind: "agent",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });
    const subHuman = srv.createToken({
      actorId: "r3-sub-human",
      actorKind: "human",
      boundRealmId: "/ops",
      writeScope: "subtree",
    });

    const selfSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: selfAgent.token,
    });
    const subSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subAgent.token,
    });
    const subHumanSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: subHuman.token,
    });

    // ---- 1. P0 Option A + Structural Differential Test (verify/dryRun distinguishable entries ⊆ ls) ----
    const descRec = await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: opsInfraId,
      targetRealmId: opsInfraId,
      kind: "claim",
      title: "Infra Public Claim",
      payload: { body: "Infra claim body", contentSha256: sha256("Infra claim body") },
      sourceRef: "infra-rec.md",
    });
    const descSea = await srv.engine.ledger.captureSeabed({
      actor: rootAdmin,
      viewerRealmId: opsInfraId,
      targetRealmId: opsInfraId,
      kind: "artifact",
      text: "Descendant seabed raw artifact",
      preserveExactText: true,
      sourceRef: "infra-sea.md",
    });
    const descSecretRec = await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: opsInfraId,
      targetRealmId: opsInfraId,
      kind: "claim",
      title: "Infra Secret Record",
      payload: {
        body: "top-secret-body-42",
        contentSha256: sha256("top-secret-body-42"),
      },
      sourceRef: "infra-secret.md",
      sensitivity: "secret",
    });
    await srv.engine.ledger.captureSeabed({
      actor: rootAdmin,
      viewerRealmId: opsId,
      targetRealmId: opsId,
      kind: "artifact",
      text: "Self seabed raw artifact",
      preserveExactText: true,
      sourceRef: "ops-sea.md",
    });
    await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: secId,
      targetRealmId: secId,
      kind: "claim",
      title: "Hidden Sec Claim",
      payload: { body: "hidden", contentSha256: sha256("hidden") },
      sourceRef: "hidden-sec.md",
    });

    // (1a) `self` agent sending items: [] + checkUnexpectedInRealmRefs: ["/ops/infra"] MUST NOT see descendant seabed!
    const selfCheckInfra = await selfSurf.verifyImport({
      items: [],
      checkUnexpectedInRealmRefs: ["/ops/infra"],
    });
    const selfCheckIds = new Set(
      selfCheckInfra.unexpectedEntries.map((e) => e.entryId),
    );
    expect(selfCheckIds.has(descRec.id)).toBe(true);
    expect(selfCheckIds.has(descSea.id)).toBe(false);
    expect(selfCheckIds.has(descSecretRec.id)).toBe(false);

    // (1b) `self` agent probing descendant seabed by sending a seabed manifest item MUST get missing (0 hash/byte leak!)
    const selfSeaProbe = await selfSurf.verifyImport({
      items: [
        {
          target: "seabed",
          sourceRef: "infra-sea.md",
          expectedRealmRef: "/ops/infra",
          contentSha256: sha256("wrong"),
          byteLength: 5,
          expectedOccurredAt: null,
        },
      ],
    });
    expect(selfSeaProbe.missingCount).toBe(1);
    expect(selfSeaProbe.contentMismatchCount).toBe(0);
    expect(JSON.stringify(selfSeaProbe)).not.toContain(
      sha256("Descendant seabed raw artifact"),
    );

    // (1c) Structural differential check: entries returned by verifyImport for `self` are a strict subset of default `ls`!
    const selfLsOps = await selfSurf.ls({ ref: "/ops" });
    const selfLsInfra = await selfSurf.ls({ ref: "/ops/infra" });
    const selfLsVisibleIds = new Set([
      ...selfLsOps.items.map((i) => i.id),
      ...selfLsInfra.items.map((i) => i.id),
    ]);
    const selfCheckAll = await selfSurf.verifyImport({
      items: [],
      checkUnexpectedInRealmRefs: ["/ops", "/ops/infra"],
    });
    for (const u of selfCheckAll.unexpectedEntries) {
      expect(selfLsVisibleIds.has(u.entryId)).toBe(true);
    }

    // (1d) For `subtree` agent: record-only verify sees NO descendant seabed; seabed verify sees strictly subset of ls(includeDescendantSeabed: true)!
    const subRecordCheck = await subSurf.verifyImport({
      items: [],
      checkUnexpectedInRealmRefs: ["/ops/infra"],
    });
    expect(
      subRecordCheck.unexpectedEntries.some((e) => e.entryId === descSea.id),
    ).toBe(false);

    const subLsInfraDive = await subSurf.ls({
      ref: "/ops/infra",
      includeDescendantSeabed: true,
    });
    const subDiveVisibleIds = new Set(subLsInfraDive.items.map((i) => i.id));
    const subSeaVerify = await subSurf.verifyImport({
      items: [
        {
          target: "seabed",
          sourceRef: "infra-sea.md",
          expectedRealmRef: "/ops/infra",
          contentSha256: sha256("Descendant seabed raw artifact"),
          byteLength: Buffer.byteLength("Descendant seabed raw artifact", "utf8"),
          expectedOccurredAt: null,
        },
      ],
      checkUnexpectedInRealmRefs: ["/ops/infra"],
    });
    expect(subSeaVerify.foundCount).toBe(1);
    for (const u of subSeaVerify.unexpectedEntries) {
      expect(subDiveVisibleIds.has(u.entryId)).toBe(true);
    }
    expect(
      subSeaVerify.unexpectedEntries.some(
        (e) => e.entryId === descSecretRec.id,
      ),
    ).toBe(false);

    // ---- 2. P1 #2: ingestBatch secret isolation & dryRun zero-oracle ----
    const drySecretProbe = await subSurf.importBatch({
      dryRun: true,
      items: [
        {
          target: "record",
          sourceRef: "infra-secret.md",
          realmRef: "/ops/infra",
          title: "Infra Secret Record",
          body: "top-secret-body-42",
          contentSha256: sha256("top-secret-body-42"),
        },
      ],
    });
    expect(drySecretProbe.created).toBe(1);
    expect(drySecretProbe.skippedUnchanged).toBe(0);
    expect(drySecretProbe.superseded).toBe(0);
    expect(drySecretProbe.items[0]!.supersedesId).toBeNull();

    // Non-dryRun agent CANNOT supersede an unreadable secret record by sourceRef or id!
    const supSecretAttempt = await subSurf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "overwrite-secret-attempt.md",
          realmRef: "/ops/infra",
          title: "Attempt",
          body: "Non-secret body",
          contentSha256: sha256("Non-secret body"),
          supersedesIds: [descSecretRec.id],
          supersedesSourceRefs: ["infra-secret.md"],
        },
      ],
    });
    expect(supSecretAttempt.created).toBe(1);
    expect(supSecretAttempt.superseded).toBe(0);
    expect(supSecretAttempt.items[0]!.supersedesId).toBeNull();
    expect(srv.engine.db.getRecord(descSecretRec.id)?.status).toBe("active");

    // ---- 3. P1 #3: Tree-mode human `entry move` protection via targetRealm's own change_log ----
    const triagedBody = "Triaged note moved to /ops/infra";
    const triagedHiddenBody = "Triaged note moved to hidden /sec";
    const triageSeed = await subHumanSurf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "triaged-visible.md",
          realmRef: "/ops",
          title: "Triaged Visible",
          body: triagedBody,
          contentSha256: sha256(triagedBody),
        },
        {
          target: "record",
          sourceRef: "triaged-hidden.md",
          realmRef: "/ops",
          title: "Triaged Hidden",
          body: triagedHiddenBody,
          contentSha256: sha256(triagedHiddenBody),
        },
      ],
    });
    const recVisId = triageSeed.items[0]!.entryId!;
    const recHidId = triageSeed.items[1]!.entryId!;
    // Human moves one into writable /ops/infra and admin moves the other into hidden /sec
    srv.engine.ledger.moveEntries({
      actor: rootAdmin,
      orgId: srv.orgId,
      entryIds: [recVisId],
      targetRealmId: opsInfraId,
    });
    srv.engine.ledger.moveEntries({
      actor: rootAdmin,
      orgId: srv.orgId,
      entryIds: [recHidId],
      targetRealmId: secId,
    });

    // Re-importing into /ops WITHOUT --relocate skips BOTH cleanly (zero duplicate, zero CONFLICT, zero NOT_FOUND!)
    const reimportAfterMove = await subSurf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "triaged-visible.md",
          realmRef: "/ops",
          title: "Triaged Visible",
          body: triagedBody,
          contentSha256: sha256(triagedBody),
        },
        {
          target: "record",
          sourceRef: "triaged-hidden.md",
          realmRef: "/ops",
          title: "Triaged Hidden",
          body: triagedHiddenBody,
          contentSha256: sha256(triagedHiddenBody),
        },
      ],
    });
    expect(reimportAfterMove.skippedUnchanged).toBe(2);
    expect(reimportAfterMove.created).toBe(0);
    expect(reimportAfterMove.items[0]!.entryId).toBeNull();
    expect(reimportAfterMove.items[1]!.entryId).toBeNull();
    // No duplicate created in /ops
    expect(
      srv.engine.db.findActiveRecordsBySourceRefInRealms(
        srv.orgId,
        "triaged-visible.md",
        [opsId],
      ),
    ).toHaveLength(0);

    // Explicit human `--relocate` overrides move_out skip for writable destination
    const humanRelocBack = await subHumanSurf.importBatch({
      relocate: true,
      items: [
        {
          target: "record",
          sourceRef: "triaged-visible.md",
          realmRef: "/ops",
          title: "Triaged Visible",
          body: triagedBody,
          contentSha256: sha256(triagedBody),
        },
      ],
    });
    expect(humanRelocBack.relocated).toBe(1);
    expect(humanRelocBack.items[0]!.realmPath).toBe("/ops");

    // ---- 4. P1 #4: Upgrade-safe JSONL idempotency with pre-v0.6.5 legacy realm-less idempotency key ----
    const legacyRowBody = "Legacy JSONL row body";
    const legacyRowRawSha = sha256('{"id":"legacy-99","body":"Legacy JSONL row body"}');
    await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: opsInfraId,
      targetRealmId: opsInfraId,
      kind: "claim",
      title: "Legacy Event 99",
      payload: {
        body: legacyRowBody,
        contentSha256: legacyRowRawSha, // pre-v0.6.5 JSONL stored row hash here
        sourceRef: "legacy:legacy-99",
      },
      sourceRef: "legacy:legacy-99",
      idempotencyKey: `legacy:legacy-99:${legacyRowRawSha}`, // legacy realm-less key!
    });
    const upgradeJsonlRetry = await subSurf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "legacy:legacy-99",
          sourceId: "legacy-99",
          idempotencyPrefix: "import-jsonl",
          realmRef: "/ops/infra",
          title: "Legacy Event 99",
          body: legacyRowBody,
          contentSha256: sha256(legacyRowBody),
          rawContentSha256: legacyRowRawSha,
        },
      ],
    });
    expect(upgradeJsonlRetry.skippedUnchanged).toBe(1);
    expect(upgradeJsonlRetry.created).toBe(0);
    expect(
      srv.engine.db.findActiveRecordsBySourceRefInRealms(
        srv.orgId,
        "legacy:legacy-99",
        [opsInfraId],
      ),
    ).toHaveLength(1);

    // ---- 5. P1 #5: Hard array caps + EXPLAIN QUERY PLAN verifying idx_records_org_realm_source_id ----
    const capCases: Array<Partial<Record<string, unknown>>> = [
      { supersedesSourceRefs: Array.from({ length: 33 }, (_, i) => `r-${i}`) },
      { supersedesIds: Array.from({ length: 33 }, (_, i) => `rec_${i}`) },
      { refs: Array.from({ length: 33 }, (_, i) => `ref_${i}`) },
      { objectRefs: Array.from({ length: 65 }, (_, i) => `service:s-${i}`) },
      { resourceTags: Array.from({ length: 65 }, (_, i) => `tag:t-${i}`) },
    ];
    for (const extra of capCases) {
      const res = await fetch(`${srv.url}/v1/import/batch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${subAgent.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          items: [
            {
              target: "record",
              sourceRef: "cap-test.md",
              realmRef: "/ops",
              title: "Cap",
              body: "x",
              contentSha256: sha256("x"),
              ...extra,
            },
          ],
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe(
        "invalid_input",
      );
    }

    const planConn = new DatabaseSync(path.join(srv.homeDir, "mind.sqlite"));
    try {
      const planRows = planConn
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT * FROM records
           WHERE org_id = ? AND redacted_at IS NULL AND status != 'retracted' AND sensitivity != 'secret'
             AND realm_id IN (?)
             AND json_extract(payload_json, '$.sourceId') IS NOT NULL
             AND json_extract(payload_json, '$.sourceId') = ?
           ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END ASC, created_at DESC, rowid DESC
           LIMIT 1`,
        )
        .all(srv.orgId, opsInfraId, "some-id") as Array<{ detail: string }>;
      const planText = planRows.map((r) => r.detail).join(" | ");
      expect(planText).toContain("idx_records_org_realm_source_id");
    } finally {
      planConn.close();
    }

    // ---- 6. P1 #6: `--relocate` rule-chain smuggling into descendant MUST be rejected ----
    const ruleBody = "Never deploy on Fridays.";
    const opsRule = await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: opsId,
      targetRealmId: opsId,
      kind: "rule",
      title: "Ops Governance Rule",
      payload: { body: ruleBody, contentSha256: sha256(ruleBody) },
      sourceRef: "ops-rule.md",
    });
    await expect(
      subHumanSurf.importBatch({
        relocate: true,
        items: [
          {
            target: "record",
            kind: "claim", // attacker tries to disguise kind as claim!
            sourceRef: "ops-rule.md",
            realmRef: "/ops/infra",
            title: "Ops Governance Rule",
            body: ruleBody,
            contentSha256: sha256(ruleBody),
          },
        ],
      }),
    ).rejects.toThrow(/denied|rule|write/i);
    // Rule remains strictly in /ops
    expect(srv.engine.db.getRecord(opsRule.id)?.realmId).toBe(opsId);

    // ---- 7. P1 #7: Per-item runtime type validation on /v1/import/batch, /v1/import/verify, and POST /v1/redact {} -> 400 ----
    const badBatchItems: Array<Record<string, unknown>> = [
      { target: "record", sourceRef: "t1.md", realmRef: 123, body: "a", contentSha256: sha256("a") },
      { target: "record", sourceRef: "t2.md", realmRef: "", body: "a", contentSha256: sha256("a") },
      { target: "record", sourceRef: "t3.md", realmRef: "/ops", title: { bad: true }, body: "a", contentSha256: sha256("a") },
      { target: "record", sourceRef: "t4.md", realmRef: "/ops", body: 42, contentSha256: sha256("42") },
      { target: "record", sourceRef: "t5.md", realmRef: "/ops", body: "a", contentSha256: sha256("a"), occurredAt: "not-a-date" },
      { target: "record", sourceRef: "t6.md", realmRef: "/ops", body: "a", contentSha256: sha256("a"), occurredAt: 1700000000 },
      { target: "record", sourceRef: "t7.md", realmRef: "/ops", body: "a", contentSha256: sha256("a"), supersedesSourceRefs: [123] },
      { target: "record", sourceRef: "t8.md", realmRef: "/ops", body: "a", contentSha256: sha256("a"), frontmatter: "not-an-object" },
      { target: "record", sourceRef: "t9.md", realmRef: "/ops", body: "a", contentSha256: sha256("a"), sourceId: 999 },
    ];
    for (const badItem of badBatchItems) {
      const r = await fetch(`${srv.url}/v1/import/batch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${subHuman.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ items: [badItem] }),
      });
      expect(r.status, `Malformed batch item must return 400`).toBe(400);
      expect(((await r.json()) as { error?: string }).error).toBe("invalid_input");
    }

    const badVerifyRes = await fetch(`${srv.url}/v1/import/verify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${subHuman.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: [{ target: "record", sourceRef: 123 }] }),
    });
    expect(badVerifyRes.status).toBe(400);
    expect(((await badVerifyRes.json()) as { error?: string }).error).toBe(
      "invalid_input",
    );

    const badRedactRes = await fetch(`${srv.url}/v1/redact`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${subHuman.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(badRedactRes.status).toBe(400);
    expect(((await badRedactRes.json()) as { error?: string }).error).toBe(
      "invalid_input",
    );

    // ---- 8. P2: Symlinked .md alignment between planMarkdownImport & planSourceVerification ----
    const symDir = makeTempDir("meru-v065-symlink-");
    const outsideFile = path.join(makeTempDir("meru-v065-outside-"), "ext.md");
    fs.writeFileSync(outsideFile, "# External\nOutside corpus.\n", "utf8");
    fs.writeFileSync(path.join(symDir, "real.md"), "# Real\nInside corpus.\n", "utf8");
    fs.symlinkSync(outsideFile, path.join(symDir, "linked.md"));

    const symImportPlan = planMarkdownImport({ inputPath: symDir });
    expect(symImportPlan.items.map((i) => i.sourceRef)).toEqual(["real.md"]);

    const symVerifyPlan = planSourceVerification({ sourcePath: symDir });
    expect(symVerifyPlan.items.map((i) => i.sourceRef)).toEqual(["real.md"]);
    expect(
      symVerifyPlan.unaccountedPaths.some((p) =>
        p.includes("linked.md (symlink_file)"),
      ),
    ).toBe(true);

    // Excluding the symlink clears unaccountedPaths cleanly
    const symVerifyExcluded = planSourceVerification({
      sourcePath: symDir,
      exclude: ["linked.md"],
    });
    expect(symVerifyExcluded.unaccountedPaths).toHaveLength(0);
    expect(symVerifyExcluded.excludedCount).toBe(1);

    // ---- 9. Round-3 final lock: unconditional secret exclusion (no allowSecret bypass!) + duplicate verify item rejection ----
    // Fable's exact Test #1: `agent`, `tree`, `self` — realm `/ops` contains a `sensitivity: "secret"` record
    // the agent cannot `show` (test BOTH ledger-seeded AND importBatch-seeded secret records!).
    const opsSecretBody = "Ultra-secret ops launch sequence 777";
    const opsSecretLedgerRec = await srv.engine.ledger.appendRecord({
      actor: rootAdmin,
      viewerRealmId: opsId,
      targetRealmId: opsId,
      kind: "claim",
      title: "Ops Secret Ledger",
      payload: { body: opsSecretBody, contentSha256: sha256(opsSecretBody) },
      sourceRef: "ops-secret-ledger.md",
      sensitivity: "secret",
    });
    // Also seed a secret record via importBatch itself to prove idempotency_keys never creates an oracle either!
    const opsSecretImported = await subHumanSurf.importBatch({
      skipSecret: false,
      items: [
        {
          target: "record",
          sourceRef: "ops-secret-imported.md",
          realmRef: "/ops",
          title: "Ops Secret Imported",
          body: opsSecretBody,
          contentSha256: sha256(opsSecretBody),
          sensitivity: "secret",
        },
      ],
    });
    const opsSecretImportedId = opsSecretImported.items[0]!.entryId!;

    // Confirm agent CANNOT discover either secret record's ID via ls, search, or changes!
    const selfLsSecrets = await selfSurf.ls({ ref: "/ops" });
    expect(selfLsSecrets.items.some((i) => i.id === opsSecretLedgerRec.id)).toBe(false);
    expect(selfLsSecrets.items.some((i) => i.id === opsSecretImportedId)).toBe(false);
    const selfSearchSecrets = await selfSurf.search({ query: "launch sequence 777" });
    expect(selfSearchSecrets.items.some((i) => i.id === opsSecretLedgerRec.id)).toBe(false);
    expect(selfSearchSecrets.items.some((i) => i.id === opsSecretImportedId)).toBe(false);
    const selfChangesSecrets = await selfSurf.changes({ sinceSeq: 0 });
    expect(JSON.stringify(selfChangesSecrets)).not.toContain(
      opsSecretLedgerRec.id,
    );
    expect(JSON.stringify(selfChangesSecrets)).not.toContain(
      opsSecretImportedId,
    );

    // Agent calls ingestBatch with dryRun: true, skipSecret: false, sensitivity: "secret", SAME sourceRef & SAME body!
    const secretBypassProbe = await selfSurf.importBatch({
      dryRun: true,
      skipSecret: false,
      items: [
        {
          target: "record",
          sourceRef: "ops-secret-ledger.md",
          realmRef: "/ops",
          title: "Ops Secret Ledger",
          body: opsSecretBody,
          contentSha256: sha256(opsSecretBody),
          sensitivity: "secret",
        },
        {
          target: "record",
          sourceRef: "ops-secret-imported.md",
          realmRef: "/ops",
          title: "Ops Secret Imported",
          body: opsSecretBody,
          contentSha256: sha256(opsSecretBody),
          sensitivity: "secret",
        },
      ],
    });
    expect(secretBypassProbe.created).toBe(2);
    expect(secretBypassProbe.skippedUnchanged).toBe(0);
    expect(secretBypassProbe.superseded).toBe(0);
    expect(secretBypassProbe.items[0]!.action).toBe("created");
    expect(secretBypassProbe.items[0]!.supersedesId).toBeNull();
    expect(secretBypassProbe.items[0]!.entryId).not.toBe(opsSecretLedgerRec.id);
    expect(secretBypassProbe.items[1]!.action).toBe("created");
    expect(secretBypassProbe.items[1]!.supersedesId).toBeNull();
    expect(secretBypassProbe.items[1]!.entryId).not.toBe(opsSecretImportedId);
    expect(JSON.stringify(secretBypassProbe)).not.toContain(opsSecretLedgerRec.id);
    expect(JSON.stringify(secretBypassProbe)).not.toContain(opsSecretImportedId);

    // Fable R4 Test B: Live (dryRun: false) execution of both secret probes MUST return created
    // (no error, no supersede, no skip), leaving both sealed secret records intact!
    const liveSecretReimport = await selfSurf.importBatch({
      dryRun: false,
      skipSecret: false,
      items: [
        {
          target: "record",
          sourceRef: "ops-secret-ledger.md",
          realmRef: "/ops",
          title: "Ops Secret Ledger",
          body: opsSecretBody,
          contentSha256: sha256(opsSecretBody),
          sensitivity: "secret",
        },
        {
          target: "record",
          sourceRef: "ops-secret-imported.md",
          realmRef: "/ops",
          title: "Ops Secret Imported",
          body: opsSecretBody,
          contentSha256: sha256(opsSecretBody),
          sensitivity: "secret",
        },
      ],
    });
    expect(liveSecretReimport.created).toBe(2);
    expect(liveSecretReimport.skippedUnchanged).toBe(0);
    expect(liveSecretReimport.superseded).toBe(0);
    expect(liveSecretReimport.items[0]!.action).toBe("created");
    expect(liveSecretReimport.items[0]!.supersedesId).toBeNull();
    expect(liveSecretReimport.items[1]!.action).toBe("created");
    expect(liveSecretReimport.items[1]!.supersedesId).toBeNull();
    expect(JSON.stringify(liveSecretReimport)).not.toContain(opsSecretLedgerRec.id);
    expect(JSON.stringify(liveSecretReimport)).not.toContain(opsSecretImportedId);
    const sealed1After = srv.engine.db.getRecord(opsSecretLedgerRec.id);
    const sealed2After = srv.engine.db.getRecord(opsSecretImportedId);
    expect(sealed1After?.status).toBe("active");
    expect(sealed1After?.payload.body).toBe(opsSecretBody);
    expect(sealed2After?.status).toBe("active");
    expect(sealed2After?.payload.body).toBe(opsSecretBody);

    // Fable R4 Test A: Simulate a legacy idempotency_keys row pointing to the sealed secret record
    // under the exact non-secret key derivation, then probe with sensitivity="internal" + dryRun=true!
    const legacyCollidingKey = `import-batch:${opsId}:ops-secret-ledger.md:init:${sha256(opsSecretBody)}:active:internal`;
    const seedLegacyKeyConn = new DatabaseSync(path.join(srv.homeDir, "mind.sqlite"));
    try {
      seedLegacyKeyConn
        .prepare(
          `INSERT INTO idempotency_keys (org_id, key, target_table, target_id, realm_id, payload_hash, created_at)
           VALUES (?, ?, 'records', ?, ?, ?, ?)`,
        )
        .run(
          srv.orgId,
          legacyCollidingKey,
          opsSecretLedgerRec.id,
          opsId,
          sha256("legacy-secret-payload"),
          new Date().toISOString(),
        );
    } finally {
      seedLegacyKeyConn.close();
    }
    const legacyKeyProbe = await selfSurf.importBatch({
      dryRun: true,
      items: [
        {
          target: "record",
          sourceRef: "ops-secret-ledger.md",
          realmRef: "/ops",
          title: "Ops Secret Ledger",
          body: opsSecretBody,
          contentSha256: sha256(opsSecretBody),
          sensitivity: "internal",
        },
      ],
    });
    expect(legacyKeyProbe.created).toBe(1);
    expect(legacyKeyProbe.skippedUnchanged).toBe(0);
    expect(legacyKeyProbe.superseded).toBe(0);
    expect(legacyKeyProbe.items[0]!.action).toBe("created");
    expect(legacyKeyProbe.items[0]!.supersedesId).toBeNull();
    expect(JSON.stringify(legacyKeyProbe)).not.toContain(opsSecretLedgerRec.id);

    // Live (dryRun: false) with the legacy colliding key + sensitivity="internal" MUST create a fresh
    // non-secret record (never return/leak secret ID or fail), leave the sealed secret record intact,
    // and re-importing that same non-secret record a second time MUST skip via head match!
    const legacyKeyLive = await selfSurf.importBatch({
      dryRun: false,
      items: [
        {
          target: "record",
          sourceRef: "ops-secret-ledger.md",
          realmRef: "/ops",
          title: "Ops Secret Ledger",
          body: opsSecretBody,
          contentSha256: sha256(opsSecretBody),
          sensitivity: "internal",
        },
      ],
    });
    expect(legacyKeyLive.created).toBe(1);
    expect(legacyKeyLive.items[0]!.action).toBe("created");
    expect(legacyKeyLive.items[0]!.entryId).not.toBe(opsSecretLedgerRec.id);
    expect(JSON.stringify(legacyKeyLive)).not.toContain(opsSecretLedgerRec.id);
    expect(srv.engine.db.getRecord(opsSecretLedgerRec.id)?.status).toBe("active");
    expect(srv.engine.db.getRecord(opsSecretLedgerRec.id)?.payload.body).toBe(
      opsSecretBody,
    );

    const legacyKeyLiveRetry = await selfSurf.importBatch({
      dryRun: false,
      items: [
        {
          target: "record",
          sourceRef: "ops-secret-ledger.md",
          realmRef: "/ops",
          title: "Ops Secret Ledger",
          body: opsSecretBody,
          contentSha256: sha256(opsSecretBody),
          sensitivity: "internal",
        },
      ],
    });
    expect(legacyKeyLiveRetry.skippedUnchanged).toBe(1);
    expect(legacyKeyLiveRetry.created).toBe(0);
    expect(legacyKeyLiveRetry.items[0]!.entryId).toBe(legacyKeyLive.items[0]!.entryId);

    // Same legacy idempotency_keys secret gate on SEABED (dryRun: true & dryRun: false)
    const opsSecretSeaBody = "Ultra-secret seabed log 999";
    const opsSecretSea = await srv.engine.ledger.captureSeabed({
      actor: rootAdmin,
      viewerRealmId: opsId,
      targetRealmId: opsId,
      kind: "artifact",
      text: opsSecretSeaBody,
      preserveExactText: true,
      sourceRef: "ops-secret-sea.md",
      sensitivity: "secret",
    });
    const legacySeaKey = `import-batch:${opsId}:seabed:ops-secret-sea.md:${sha256(opsSecretSeaBody)}:internal`;
    const seedSeaKeyConn = new DatabaseSync(path.join(srv.homeDir, "mind.sqlite"));
    try {
      seedSeaKeyConn
        .prepare(
          `INSERT INTO idempotency_keys (org_id, key, target_table, target_id, realm_id, payload_hash, created_at)
           VALUES (?, ?, 'seabed_entries', ?, ?, ?, ?)`,
        )
        .run(
          srv.orgId,
          legacySeaKey,
          opsSecretSea.id,
          opsId,
          sha256("legacy-secret-sea"),
          new Date().toISOString(),
        );
    } finally {
      seedSeaKeyConn.close();
    }
    const legacySeaDry = await selfSurf.importBatch({
      dryRun: true,
      items: [
        {
          target: "seabed",
          sourceRef: "ops-secret-sea.md",
          realmRef: "/ops",
          text: opsSecretSeaBody,
          contentSha256: sha256(opsSecretSeaBody),
          sensitivity: "internal",
        },
      ],
    });
    expect(legacySeaDry.created).toBe(1);
    expect(JSON.stringify(legacySeaDry)).not.toContain(opsSecretSea.id);
    const legacySeaLive = await selfSurf.importBatch({
      dryRun: false,
      items: [
        {
          target: "seabed",
          sourceRef: "ops-secret-sea.md",
          realmRef: "/ops",
          text: opsSecretSeaBody,
          contentSha256: sha256(opsSecretSeaBody),
          sensitivity: "internal",
        },
      ],
    });
    expect(legacySeaLive.created).toBe(1);
    expect(legacySeaLive.items[0]!.entryId).not.toBe(opsSecretSea.id);
    expect(srv.engine.db.getSeabedEntry(opsSecretSea.id)?.text).toBe(opsSecretSeaBody);

    // Redacted entry MUST NEVER be resurrected by preExistingPointsToHidden!
    const toRedactBody = "Must stay redacted forever 12345";
    const toRedactRes = await selfSurf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "stay-redacted.md",
          realmRef: "/ops",
          title: "Stay Redacted",
          body: toRedactBody,
          contentSha256: sha256(toRedactBody),
        },
      ],
    });
    await subHumanSurf.redact({
      entryId: toRedactRes.items[0]!.entryId!,
      reason: "compliance test",
    });
    const reimportRedacted = await selfSurf.importBatch({
      items: [
        {
          target: "record",
          sourceRef: "stay-redacted.md",
          realmRef: "/ops",
          title: "Stay Redacted",
          body: toRedactBody,
          contentSha256: sha256(toRedactBody),
        },
      ],
    });
    expect(reimportRedacted.skippedRedacted).toBe(1);
    expect(reimportRedacted.created).toBe(0);

    // Structural invariant: moveEntryRealm MUST throw if called outside an active SQLite transaction!
    expect(() =>
      srv.engine.db.moveEntryRealm({
        orgId: srv.orgId,
        targetTable: "records",
        entryId: legacyKeyLive.items[0]!.entryId!,
        newRealmId: opsInfraId,
      }),
    ).toThrow(/inside an active SQLite transaction/);

    // Duplicate (target, realmId, sourceRef) in a single /v1/import/verify request MUST be rejected with 400!
    const dupVerifyRes = await fetch(`${srv.url}/v1/import/verify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${subAgent.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        items: [
          {
            target: "record",
            sourceRef: "caf\u0065\u0301.md", // NFD
            expectedRealmRef: "/ops/infra",
            contentSha256: sha256("x"),
            byteLength: 1,
            expectedOccurredAt: null,
          },
          {
            target: "record",
            sourceRef: "caf\u00e9.md", // NFC duplicate of same sourceRef!
            expectedRealmRef: opsInfraId, // realm ID alias for same realm!
            contentSha256: sha256("x"),
            byteLength: 1,
            expectedOccurredAt: null,
          },
        ],
      }),
    });
    expect(dupVerifyRes.status).toBe(400);
    const dupVerifyJson = (await dupVerifyRes.json()) as {
      error?: string;
      message?: string;
    };
    expect(dupVerifyJson.error).toBe("invalid_input");
    expect(dupVerifyJson.message).toMatch(/Duplicate verify manifest item/i);
  });
});
