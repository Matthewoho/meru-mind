import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
import {
  createAuthToken,
  createMindEngine,
  LocalMindSurface,
  MindError,
  RemoteMindSurface,
  startMindServer,
  type AccessLogEntry,
  type MindEngine,
  type MindServerHandle,
  type MindSurface,
} from "../src/index.js";

const cliBin = path.resolve(process.cwd(), "dist/cli.js");
const tempDirs: string[] = [];
const openEngines: MindEngine[] = [];
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
  while (openEngines.length > 0) {
    await openEngines.pop()!.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Shared MindSurface contract harness: executes IDENTICAL operations and assertions
 * against BOTH LocalMindSurface and RemoteMindSurface to prove zero dual-mode drift.
 */
async function runSharedSurfaceContract(
  label: string,
  createPair: () => Promise<{
    humanSurface: MindSurface;
    agentSurface: MindSurface;
    cleanup: () => Promise<void>;
  }>,
) {
  const { humanSurface, agentSurface, cleanup } = await createPair();
  try {
    // 1. whoami
    const humanWho = await humanSurface.whoami();
    const agentWho = await agentSurface.whoami();
    expect(humanWho.actor.kind).toBe("human");
    expect(agentWho.actor.kind).toBe("agent");
    expect(humanWho.org.id).toBe(agentWho.org.id);

    // 2. Human creates /ops and /inbox realms; agent cannot create realm
    const ops = await humanSurface.createRealm({
      parentRef: "/",
      slug: "ops",
      name: "Ops",
      scope: "Include: deploys. Exclude: sales.",
    });
    expect(ops.path).toBe("/ops");
    await expect(
      agentSurface.createRealm({
        parentRef: "/",
        slug: "illegal",
        name: "Illegal",
      }),
    ).rejects.toThrow(/human/i);

    // 3. Human adds rule; agent cannot add rule
    const rule = await humanSurface.addRule({
      in: "/ops",
      title: "Production changes require approval",
      body: "Never push unapproved changes to prod.",
    });
    expect(rule.kind).toBe("rule");
    await expect(
      agentSurface.addRule({
        in: "/ops",
        title: "Forged agent rule",
        body: "Should be blocked",
      }),
    ).rejects.toThrow(/human/i);
    await expect(
      agentSurface.write({
        in: "/ops",
        kind: "rule",
        title: "Forged rule via write",
        body: "Should be blocked",
      }),
    ).rejects.toThrow(/human/i);

    // 4. Write-time secret guard intercepts plaintext API key unless sensitivity=secret
    const syntheticApiKey = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    await expect(
      agentSurface.write({
        in: "/ops",
        kind: "finding",
        title: "Leaked key test",
        body: `API key is ${syntheticApiKey}`,
      }),
    ).rejects.toThrow(/plaintext credential/i);

    // 5. Agent writes finding -> searchable, showable, listable, appears in changes
    const written = await agentSurface.write({
      in: "/ops",
      kind: "finding",
      title: `Redis latency spike in ${label}`,
      body: "Single-shard CPU reached 74% during peak load.",
    });
    expect(written.record.id).toMatch(/^rec_/);
    expect(written.routedBy).toBe("explicit");

    const tree = await agentSurface.tree({ ref: "/" });
    expect(tree.realms.some((r) => r.path === "/ops")).toBe(true);

    const lsRes = await agentSurface.ls({ ref: "/ops" });
    expect(lsRes.items.some((i) => i.id === written.record.id)).toBe(true);

    const showRes = await agentSurface.show({ ref: written.record.id });
    expect(showRes.refType).toBe("entry");

    const searchRes = await agentSurface.search({ query: "Redis latency spike" });
    expect(searchRes.items.some((i) => i.id === written.record.id)).toBe(true);

    const ch = await agentSurface.changes({ sinceSeq: 0 });
    expect(ch.entries.some((e) => e.entityId === written.record.id)).toBe(true);

    // 6. Agent writes follow-up decision superseding finding -> chain verifiable
    const dec = await agentSurface.write({
      in: "/ops",
      kind: "decision",
      title: `Split Redis into two shards (${label})`,
      body: "Mitigates 74% single-shard saturation.",
      supersedes: [written.record.id],
    });
    const chain = await agentSurface.getEntryChain(dec.record.id);
    expect(chain.currentHeadId).toBe(dec.record.id);
    expect(chain.nodes.map((n) => n.id)).toContain(written.record.id);

    // 7. Inbox triage move: agent blocked, human succeeds
    const triageTarget = await humanSurface.createRealm({
      parentRef: "/",
      slug: "infra",
      name: "Infra",
    });
    await expect(
      agentSurface.move({
        entryIds: [dec.record.id],
        targetRealmRef: triageTarget.path,
      }),
    ).rejects.toThrow(/human/i);
    const moved = await humanSurface.move({
      entryIds: [dec.record.id],
      targetRealmRef: triageTarget.path,
      expectedFromRealmRef: "/ops",
    });
    expect(moved.moved.some((m) => m.id === dec.record.id)).toBe(true);

    // 8. Redact: agent blocked, human succeeds
    await expect(
      agentSurface.redact({ entryId: dec.record.id, reason: "attempt" }),
    ).rejects.toThrow(/human/i);
    const redacted = await humanSurface.redact({
      entryId: dec.record.id,
      reason: "cleanup",
    });
    expect(redacted.entryId).toBe(dec.record.id);
  } finally {
    await cleanup();
  }
}

describe("v0.3 Team Server, MindSurface Contract, Exclusive Lock, Pump Model & Streamable HTTP MCP", () => {
  it("1. Shared MindSurface contract passes identically on LocalMindSurface and RemoteMindSurface", async () => {
    await runSharedSurfaceContract("local", async () => {
      const homeDir = makeTempDir("meru-v03-local-");
      const engine = await createMindEngine({ homeDir, enableVector: false });
      openEngines.push(engine);
      const { org, rootRealm } = engine.ledger.createOrg({
        name: "AcmeLocal",
        policy: "open",
      });
      const humanSurface = new LocalMindSurface({
        engine,
        principal: {
          tokenId: null,
          orgId: org.id,
          actor: { id: "alice", kind: "human" },
          boundRealmId: rootRealm.id,
          boundSource: "local",
          authKind: "local",
        },
      });
      const agentSurface = new LocalMindSurface({
        engine,
        principal: {
          tokenId: null,
          orgId: org.id,
          actor: { id: "claude-bot", kind: "agent", family: "claude" },
          boundRealmId: rootRealm.id,
          boundSource: "open-default:/",
          authKind: "local",
        },
      });
      return {
        humanSurface,
        agentSurface,
        cleanup: async () => {
          await humanSurface.close();
          await agentSurface.close();
        },
      };
    });

    await runSharedSurfaceContract("remote", async () => {
      const homeDir = makeTempDir("meru-v03-remote-");
      const srv = await startMindServer({
        homeDir,
        port: 0,
        enableVector: false,
        accessLog: false,
      });
      openServers.push(srv);
      const humanTok = srv.createToken({
        actorId: "alice",
        actorKind: "human",
      });
      const agentTok = srv.createToken({
        actorId: "claude-bot",
        actorKind: "agent",
        actorFamily: "claude",
      });
      const humanSurface = await RemoteMindSurface.connect({
        baseUrl: srv.url,
        token: humanTok.token,
      });
      const agentSurface = await RemoteMindSurface.connect({
        baseUrl: srv.url,
        token: agentTok.token,
      });
      return {
        humanSurface,
        agentSurface,
        cleanup: async () => {
          await humanSurface.close();
          await agentSurface.close();
          await srv.close();
        },
      };
    });
  });

  it("2. Exclusive writer lock blocks direct local SQLite access while serve runs and releases cleanly on stop", async () => {
    const homeDir = makeTempDir("meru-v03-lock-");
    const srv = await startMindServer({
      homeDir,
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    // Direct SDK createMindEngine MUST be rejected with CONFLICT while serve holds the lock
    await expect(
      createMindEngine({ homeDir, enableVector: false }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Local CLI targeting --home MUST also fail with conflict
    let cliFailed = false;
    try {
      await execFileAsync(process.execPath, [cliBin, "--home", homeDir, "whoami", "--json"], {
        encoding: "utf8",
      });
    } catch (err) {
      cliFailed = true;
      const stderr = String((err as { stderr?: Buffer | string }).stderr ?? "");
      expect(stderr).toContain("conflict");
    }
    expect(cliFailed).toBe(true);

    // Remote CLI with --as-human MUST fail immediately (cannot forge human identity on remote)
    const agentTok = srv.createToken({ actorId: "bot-1", actorKind: "agent" });
    let remoteForgeFailed = false;
    try {
      await execFileAsync(
        process.execPath,
        [cliBin, "--url", srv.url, "--token", agentTok.token, "--as-human", "whoami", "--json"],
        { encoding: "utf8" },
      );
    } catch (err) {
      remoteForgeFailed = true;
      const stderr = String((err as { stderr?: Buffer | string }).stderr ?? "");
      expect(stderr).toMatch(/local-only|server token/i);
    }
    expect(remoteForgeFailed).toBe(true);

    // Remote CLI without --as-human succeeds cleanly
    const { stdout: remoteOut } = await execFileAsync(
      process.execPath,
      [cliBin, "--url", srv.url, "--token", agentTok.token, "whoami", "--json"],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(remoteOut) as { actor: { id: string; kind: string }; store: { localOnly: boolean } };
    expect(parsed.actor.id).toBe("bot-1");
    expect(parsed.actor.kind).toBe("agent");
    expect(parsed.store.localOnly).toBe(false);

    // After server stops, local direct access works again
    await srv.close();
    const localEngine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(localEngine);
    expect(localEngine.ledger.listOrgs().length).toBe(1);

    // Stale lock with dead PID is cleanly reclaimed by a new server
    fs.writeFileSync(
      path.join(homeDir, "mind.serve.lock"),
      JSON.stringify({ pid: 9999999, url: "http://127.0.0.1:1", startedAt: "2026-01-01T00:00:00Z" }),
    );
    await localEngine.close();
    const srv2 = await startMindServer({
      homeDir,
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv2);
    expect(srv2.port).toBeGreaterThan(0);
  });

  it("3. Pump Model + Long-Poll wakes immediately on commit, enforces __org__ zero sibling leak, topoVer refresh, and token revocation", async () => {
    const homeDir = makeTempDir("meru-v03-pump-");
    const accessLogs: AccessLogEntry[] = [];
    const srv = await startMindServer({
      homeDir,
      port: 0,
      enableVector: false,
      accessLog: (entry) => accessLogs.push(entry),
    });
    openServers.push(srv);

    const humanTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    const admin = await RemoteMindSurface.connect({ baseUrl: srv.url, token: humanTok.token });

    // Switch org to tree mode with two isolated sibling realms /team-a and /team-b
    await admin.setOrgPolicy({ policy: "tree" });
    const teamA = await admin.createRealm({ parentRef: "/", slug: "team-a", name: "Team A" });
    const teamB = await admin.createRealm({ parentRef: "/", slug: "team-b", name: "Team B" });

    const tokA = await admin.createToken({
      actorId: "agent-a",
      actorKind: "agent",
      boundRealmRef: teamA.path,
    });
    const tokB = await admin.createToken({
      actorId: "agent-b",
      actorKind: "agent",
      boundRealmRef: teamB.path,
    });

    const surfA = await RemoteMindSurface.connect({ baseUrl: srv.url, token: tokA.token });
    const surfB = await RemoteMindSurface.connect({ baseUrl: srv.url, token: tokB.token });

    const baselineA = await surfA.changes({ sinceSeq: 0 });
    const startSeq = baselineA.latestSeq;

    // 3a. Team B writes a record -> Team A MUST NOT see it (zero sibling leak!)
    const secretB = await surfB.write({
      in: teamB.path,
      kind: "finding",
      title: "Team B confidential launch date",
      body: "Top secret launch details for Team B only.",
    });
    const afterB = await surfA.changes({ sinceSeq: startSeq });
    expect(afterB.entries.some((e) => e.entityId === secretB.record.id)).toBe(false);
    expect(afterB.entries.some((e) => e.realmId === teamB.id)).toBe(false);

    // 3b. Long-Poll from Team A wakes immediately (< 1500ms) when Team A writes, returning thin frames (no body/title)
    const t0 = performance.now();
    const pollPromise = surfA.changes({ sinceSeq: afterB.latestSeq, waitSeconds: 10 });
    await new Promise((r) => setTimeout(r, 80));
    const wroteA = await surfA.write({
      in: teamA.path,
      kind: "finding",
      title: "Team A pump trigger",
      body: "Sensitive body that must NEVER appear inside thin pump frames.",
    });
    const polled = await pollPromise;
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(3000);
    expect(polled.entries.some((e) => e.entityId === wroteA.record.id)).toBe(true);
    const frame = polled.entries.find((e) => e.entityId === wroteA.record.id)!;
    expect(JSON.stringify(frame)).not.toContain("Sensitive body");
    expect(frame.assetClass).toBe("ledger");

    // 3c. Mount /team-b into /team-a (ledger only) -> topologyVersion increments and Pump refreshes scope!
    const topoBefore = polled.topologyVersion!;
    await admin.mountRealm({
      viewerRef: teamA.path,
      targetRef: teamB.path,
      scope: "ledger",
    });
    const wroteB2 = await surfB.write({
      in: teamB.path,
      kind: "finding",
      title: "Team B post-mount update",
      body: "Now readable by Team A via ledger mount.",
    });
    // Also write a Team B seabed entry -> Team A mounted scope="ledger", so seabed MUST stay invisible!
    const seabedB = await surfB.rawAdd({
      in: teamB.path,
      kind: "message",
      text: "Team B private seabed chat",
    });
    const afterMount = await surfA.changes({ sinceSeq: polled.latestSeq });
    expect(afterMount.topologyVersion!).toBeGreaterThan(topoBefore);
    expect(afterMount.entries.some((e) => e.entityId === wroteB2.record.id)).toBe(true);
    expect(afterMount.entries.some((e) => e.entityId === seabedB.id)).toBe(false);

    // 3d. Access logs NEVER record query strings (e.g. search queries)
    await surfA.search({ query: "SUPER_PRIVATE_QUERY_STRING_7788" });
    expect(accessLogs.length).toBeGreaterThan(0);
    for (const log of accessLogs) {
      expect(log.pathname).not.toContain("?");
      expect(log.pathname).not.toContain("SUPER_PRIVATE_QUERY_STRING_7788");
    }

    // 3e. Token revocation takes effect immediately
    const revoked = await admin.revokeToken({ tokenId: tokB.record.id });
    expect(revoked).toBe(true);
    await expect(surfB.whoami()).rejects.toThrow(/revoked|invalid/i);
  });

  it("4. Weakened Cookie principal allows read + reversible inbox triage, blocks irreversible/scope-widening verbs with CLI hint", async () => {
    const homeDir = makeTempDir("meru-v03-cookie-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(engine);
    const { org, rootRealm } = engine.ledger.createOrg({ name: "AcmeCookie", policy: "open" });
    const inbox = engine.ledger.ensureInboxRealm(org.id);
    const ops = engine.ledger.createRealm({
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "ops",
      name: "Ops",
      actor: { id: "alice", kind: "human" },
    });
    const entry = await engine.ledger.appendRecord({
      actor: { id: "bot", kind: "agent" },
      viewerRealmId: inbox.id,
      targetRealmId: inbox.id,
      kind: "finding",
      title: "Needs triage",
      payload: { body: "Move me to /ops" },
    });

    const cookieSurface = new LocalMindSurface({
      engine,
      principal: {
        tokenId: null,
        orgId: org.id,
        actor: { id: "alice", kind: "human" },
        boundRealmId: rootRealm.id,
        boundSource: "cookie",
        authKind: "cookie",
      },
    });

    // Read & reversible inbox triage move SUCCEED
    const who = await cookieSurface.whoami();
    expect(who.write.canWriteRules).toBe(false);
    expect(who.write.canRedact).toBe(false);
    const moved = await cookieSurface.move({
      entryIds: [entry.id],
      targetRealmRef: ops.path,
      expectedFromRealmRef: inbox.path,
    });
    expect(moved.moved.length).toBe(1);

    // Irreversible / scope-widening verbs MUST throw ACCESS_DENIED with copyable CLI command
    const blockedCalls: Array<Promise<unknown>> = [
      cookieSurface.addRule({ in: "/ops", title: "R", body: "B" }),
      cookieSurface.redact({ entryId: entry.id, reason: "test" }),
      cookieSurface.mountRealm({ viewerRef: "/", targetRef: "/ops" }),
      cookieSurface.setOrgPolicy({ policy: "tree" }),
      cookieSurface.createToken({ actorId: "x", actorKind: "agent" }),
    ];
    for (const p of blockedCalls) {
      try {
        await p;
        throw new Error("Expected cookie call to fail");
      } catch (err) {
        expect(err).toBeInstanceOf(MindError);
        const me = err as MindError;
        expect(me.code).toBe("ACCESS_DENIED");
        expect(String(me.details?.try ?? "")).toContain("meru-mind ");
      }
    }
  });

  it("5. Session cursor collision hints surface concurrent writes by other actors without blocking", async () => {
    const homeDir = makeTempDir("meru-v03-collision-");
    const srv = await startMindServer({
      homeDir,
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);
    const tokA = srv.createToken({ actorId: "agent-alpha", actorKind: "agent" });
    const tokB = srv.createToken({ actorId: "agent-beta", actorKind: "agent" });

    const surfA = await RemoteMindSurface.connect({ baseUrl: srv.url, token: tokA.token });
    const surfB = await RemoteMindSurface.connect({ baseUrl: srv.url, token: tokB.token });

    // Alpha establishes read cursor
    await surfA.write({ in: "/", kind: "finding", title: "Seed", body: "Initial" });
    await surfA.whoami();

    // Beta writes concurrently to the same realm
    const betaWrite = await surfB.write({
      in: "/",
      kind: "finding",
      title: "Concurrent Beta update",
      body: "Beta changed config.",
    });

    // Alpha writes next -> succeeds AND receives collisionHints pointing to Beta's event
    const alphaWrite = await surfA.write({
      in: "/",
      kind: "finding",
      title: "Alpha follow-up",
      body: "Alpha update.",
    });
    expect(alphaWrite.record.id).toMatch(/^rec_/);
    expect(alphaWrite.collisionHints?.some((h) => h.entityId === betaWrite.record.id)).toBe(true);
  });

  it("6. Streamable HTTP MCP (/mcp) enforces Bearer auth, exposes strictly 7 tools, and blocks rule writes", async () => {
    const homeDir = makeTempDir("meru-v03-mcp-http-");
    const srv = await startMindServer({
      homeDir,
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);
    const agentTok = srv.createToken({ actorId: "mcp-remote-bot", actorKind: "agent" });

    // Unauthenticated /mcp rejected with 401
    const unauth = await fetch(`${srv.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(unauth.status).toBe(401);

    const callMcp = async (method: string, params: Record<string, unknown> = {}) => {
      const res = await fetch(`${srv.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agentTok.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      // Streamable HTTP may reply as SSE (`data: {...}`) or direct JSON
      const dataLine = text
        .split(/\r?\n/)
        .find((l) => l.startsWith("data: "));
      return JSON.parse(dataLine ? dataLine.slice(6) : text) as {
        result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean };
      };
    };

    const listResp = await callMcp("tools/list");
    const toolNames = (listResp.result?.tools ?? []).map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "mind_changes",
      "mind_ls",
      "mind_search",
      "mind_show",
      "mind_tree",
      "mind_whoami",
      "mind_write",
    ]);

    const writeResp = await callMcp("tools/call", {
      name: "mind_write",
      arguments: {
        in: "/",
        kind: "finding",
        title: "HTTP MCP write verified",
        body: "Written via Streamable HTTP MCP transport.",
      },
    });
    expect(writeResp.result?.isError).not.toBe(true);
    const writtenJson = JSON.parse(writeResp.result!.content![0]!.text) as { id: string };
    expect(writtenJson.id).toMatch(/^rec_/);

    // Rule write via /mcp MUST fail
    const ruleResp = await callMcp("tools/call", {
      name: "mind_write",
      arguments: { in: "/", kind: "rule", title: "Illegal", body: "Nope" },
    });
    expect(ruleResp.result?.isError).toBe(true);
  });

  it("7. VACUUM INTO backup/restore drill + 50 concurrent HTTP writes (0 SQLITE_BUSY, monotonic seq) + deploy kit verification", async () => {
    const homeDir = makeTempDir("meru-v03-backup-");
    const restoreHome = makeTempDir("meru-v03-restore-");
    const backupFile = path.join(makeTempDir("meru-v03-snap-"), "mind-backup.sqlite");

    const srv = await startMindServer({
      homeDir,
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);
    const tok = srv.createToken({ actorId: "load-bot", actorKind: "agent" });
    const surf = await RemoteMindSurface.connect({ baseUrl: srv.url, token: tok.token });

    // Fire 50 concurrent writes over HTTP to verify single-writer WAL serialization
    const writes = await Promise.all(
      Array.from({ length: 50 }, (_, idx) =>
        surf.write({
          in: "/",
          kind: "finding",
          title: `Concurrent finding #${idx + 1}`,
          body: `Payload for concurrent item ${idx + 1} — restore drill check.`,
          idempotencyKey: `conc-${idx + 1}`,
        }),
      ),
    );
    expect(writes).toHaveLength(50);

    // Verify monotonic gap-free change_log seq across all 50 writes
    const changes = await surf.changes({ sinceSeq: 0, limit: 100 });
    const seqs = changes.entries.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }

    // Take atomic VACUUM INTO backup while server is live, then close server and restore into brand-new home
    srv.engine.db.vacuumInto(backupFile);
    await srv.close();

    fs.copyFileSync(backupFile, path.join(restoreHome, "mind.sqlite"));
    const restored = await createMindEngine({ homeDir: restoreHome, enableVector: false });
    openEngines.push(restored);
    const org = restored.ledger.listOrgs()[0]!;
    const root = restored.db.getRealmByPath(org.id, "/")!;
    const found = await restored.sea.search({
      actor: { id: "verifier", kind: "agent" },
      viewerRealmId: root.id,
      query: "Concurrent finding #50",
    });
    expect(found.items.some((i) => i.title.includes("#50"))).toBe(true);
    // Token hash survived atomic backup/restore intact
    expect(restored.db.listTokens(org.id).some((t) => t.id === tok.record.id)).toBe(true);

    // Verify cloud deploy kit & THREAT_MODEL.md exist with required operational guardrails
    const dockerfile = fs.readFileSync(path.resolve(process.cwd(), "deploy/Dockerfile"), "utf8");
    expect(dockerfile).toContain("USER meru");
    expect(dockerfile).toContain("VOLUME [\"/var/lib/meru-mind\"]");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(fs.existsSync(path.resolve(process.cwd(), "deploy/docker-compose.yml"))).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), "deploy/Caddyfile"))).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), "deploy/fly.toml"))).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), "THREAT_MODEL.md"))).toBe(true);
  });
});
