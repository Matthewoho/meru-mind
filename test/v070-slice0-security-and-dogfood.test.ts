import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  formatImportVerifyMarkdown,
  LocalMindSurface,
  MindError,
  RemoteMindSurface,
  startMindServer,
  toSurfaceError,
  type Actor,
  type MindEngine,
  type RunningMindServer,
} from "../src/index.js";
import { createMindMcpServer } from "../src/mcp.js";
import { createSurfaceMcpServer } from "../src/server/mcp-http.js";

const tempDirs: string[] = [];
const openEngines: MindEngine[] = [];
const openServers: RunningMindServer[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const cliBin = path.resolve(import.meta.dirname, "../dist/cli.js");

function runCliJson(
  homeDir: string,
  args: string[],
  envExtra?: Record<string, string>,
): unknown {
  const stdout = execFileSync(
    process.execPath,
    [cliBin, "--home", homeDir, ...args, "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, ...envExtra },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(stdout);
}

function runCliRaw(
  homeDir: string,
  args: string[],
  envExtra?: Record<string, string>,
): string {
  return execFileSync(process.execPath, [cliBin, "--home", homeDir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...envExtra },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runRemoteCliJson(
  url: string,
  token: string,
  args: string[],
): Promise<unknown> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [cliBin, "--url", url, "--token", token, ...args, "--json"],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout);
}

const humanAlice: Actor = { id: "alice", kind: "human" };
const agentB1: Actor = { id: "agent-b1", kind: "agent" };
const agentB2: Actor = { id: "agent-b2", kind: "agent" };
const agentParent: Actor = { id: "agent-parent", kind: "agent" };
const agentChild: Actor = { id: "agent-child", kind: "agent" };

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.close();
  }
  while (openEngines.length > 0) {
    await openEngines.pop()!.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v0.7.0 Commit 1: Slice 0 security fixes (L1/L2), remote rule --about, dogfood (a)(b), and contract alignment", () => {
  it("T1 #1 (L1 / I2): refs.ts countsBySource & entryIds NEVER leak hidden-realm or secret entry counts via viaObject/viaTag/viaThing/total", async () => {
    const homeDir = makeTempDir("meru-v070-l1-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "IsolationOrg",
      policy: "tree",
    });
    const b1 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "b1",
      name: "Branch B1",
    });
    const b2 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "b2",
      name: "Branch B2",
    });

    // B2 creates service:api and attaches both normal entries, tagged entries, and a secret entry
    const objB2 = engine.objects.createObject({
      actor: agentB2,
      viewerRealmId: b2.id,
      kind: "service",
      name: "api",
    });
    await engine.ledger.appendRecord({
      actor: agentB2,
      viewerRealmId: b2.id,
      targetRealmId: b2.id,
      kind: "finding",
      title: "B2 private finding linked to object",
      payload: { body: "secret b2 detail" },
      objectIds: [objB2.id],
      resourceTags: ["service:api"],
    });
    await engine.ledger.appendRecord({
      actor: agentB2,
      viewerRealmId: b2.id,
      targetRealmId: b2.id,
      kind: "finding",
      title: "B2 tag-only finding",
      payload: { body: "tag-only b2 detail" },
      resourceTags: ["service:api"],
    });
    await engine.ledger.appendRecord({
      actor: agentB2,
      viewerRealmId: b2.id,
      targetRealmId: b2.id,
      kind: "finding",
      title: "B2 secret finding",
      payload: { body: "top secret b2" },
      sensitivity: "secret",
      objectIds: [objB2.id],
      resourceTags: ["service:api"],
    });

    // B1 creates its OWN same-named service:api and attaches a secret entry in B1 plus 1 normal entry in B1
    const objB1 = engine.objects.createObject({
      actor: agentB1,
      viewerRealmId: b1.id,
      kind: "service",
      name: "api",
    });
    const b1Secret = await engine.ledger.appendRecord({
      actor: agentB1,
      viewerRealmId: b1.id,
      targetRealmId: b1.id,
      kind: "finding",
      title: "B1 secret credential note",
      payload: { body: "secret note in B1" },
      sensitivity: "secret",
      objectIds: [objB1.id],
      resourceTags: ["service:api"],
    });
    // One-way mount: B2 mounts B1 (so B2 can legitimately link a B2 entry to B1's object),
    // while B1 still CANNOT see B2 -> B1 MUST NOT observe B2's linked entry via viaObject!
    engine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: b2.id,
      targetRealmId: b1.id,
      scope: "ledger",
    });
    const b2LinkedToObjB1 = await engine.ledger.appendRecord({
      actor: agentB2,
      viewerRealmId: b2.id,
      targetRealmId: b2.id,
      kind: "finding",
      title: "B2 entry linked to B1 object",
      payload: { body: "cross-linked hidden entry" },
      objectIds: [objB1.id],
    });
    expect(b1Secret.sensitivity).toBe("secret");
    expect(b2LinkedToObjB1.realmId).toBe(b2.id);

    // Before adding any visible B1 entry: ALL counts for B1 MUST be 0 (both unscoped, obj_ ID, and realm-qualified)!
    for (const ref of ["service:api", objB1.id, "/b1/service:api"]) {
      const shown = await engine.sea.show({
        actor: agentB1,
        viewerRealmId: b1.id,
        ref,
      });
      expect(shown.refType).toBe("object");
      if (shown.refType === "object") {
        expect(shown.card.counts).toEqual({
          total: 0,
          viaObject: 0,
          viaTag: 0,
          viaThing: 0,
        });
      }
    }

    // Add 1 visible B1 entry linked to objB1 -> counts become exactly 1 viaObject, 0 viaTag, 1 total
    await engine.ledger.appendRecord({
      actor: agentB1,
      viewerRealmId: b1.id,
      targetRealmId: b1.id,
      kind: "finding",
      title: "B1 visible finding",
      payload: { body: "visible" },
      objectIds: [objB1.id],
    });
    const shownAfter = await engine.sea.show({
      actor: agentB1,
      viewerRealmId: b1.id,
      ref: "service:api",
    });
    expect(shownAfter.refType).toBe("object");
    if (shownAfter.refType === "object") {
      expect(shownAfter.card.counts).toEqual({
        total: 1,
        viaObject: 1,
        viaTag: 0,
        viaThing: 0,
      });
    }
  });

  it("T1 #2 & #3 (L2): remote pump AND local changes filter secret entry_object/resource_tag, descendant seabed associations without dive, and hidden-realm objects", async () => {
    const homeDir = makeTempDir("meru-v070-l2-");
    const srv = await startMindServer({
      homeDir,
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const adminTok = srv.createToken({
      actorId: "admin",
      actorKind: "human",
    });
    const admin = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: adminTok.token,
    });
    await admin.setOrgPolicy({ policy: "tree" });
    const ops = await admin.createRealm({
      parentRef: "/",
      slug: "ops",
      name: "Ops",
      scope: "Operations",
    });
    const child = await admin.createRealm({
      parentRef: "/ops",
      slug: "child",
      name: "Ops Child",
      scope: "Ops child",
    });
    const hidden = await admin.createRealm({
      parentRef: "/",
      slug: "hidden",
      name: "Hidden Sibling",
      scope: "Hidden sibling",
    });

    const opsTok = await admin.createToken({
      actorId: "ops-agent",
      actorKind: "agent",
      boundRealmRef: "/ops",
    });
    const childTok = await admin.createToken({
      actorId: "child-agent",
      actorKind: "agent",
      boundRealmRef: "/ops/child",
    });
    const hiddenTok = await admin.createToken({
      actorId: "hidden-agent",
      actorKind: "agent",
      boundRealmRef: "/hidden",
    });

    const opsSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: opsTok.token,
    });
    const childSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: childTok.token,
    });
    const hiddenSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: hiddenTok.token,
    });

    const opsObj = (
      await opsSurf.createObject({
        in: "/ops",
        kind: "service",
        name: "gateway",
      })
    ).object;
    const hiddenObj = (
      await hiddenSurf.createObject({
        in: "/hidden",
        kind: "service",
        name: "secret-svc",
      })
    ).object;

    const baselineOps = await opsSurf.changes({ sinceSeq: 0 });
    const baselineSeq = baselineOps.latestSeq;

    // 1. Secret record in /ops with object link + resource tag
    const secretRec = (
      await opsSurf.write({
        in: "/ops",
        kind: "finding",
        title: "Secret credential record",
        body: "secret body",
        sensitivity: "secret",
        about: ["service:gateway", "env:prod"],
      })
    ).record;

    // 2. Descendant seabed entry in /ops/child linked to /ops object and tagged
    const childSea = await childSurf.rawAdd({
      in: "/ops/child",
      kind: "message",
      text: "Child private seabed chat",
    });
    await childSurf.linkObject({
      entryId: childSea.id,
      objectRef: opsObj.id,
    });
    // Also simulate a legacy pre-v0.7.0 DB row where asset_class on seabed entry_object was stored as 'ledger'
    const rawDb = new DatabaseSync(path.join(homeDir, "mind.sqlite"));
    rawDb
      .prepare(
        `UPDATE change_log SET asset_class = 'ledger' WHERE entity_type = 'entry_object' AND entity_id LIKE ?`,
      )
      .run(`${childSea.id}:%`);
    rawDb.close();

    // 3. Root admin links a root record to hiddenObj in /hidden
    const rootRec = (
      await admin.write({
        in: "/",
        kind: "finding",
        title: "Root note",
        body: "Root visible note",
      })
    ).record;
    await admin.linkObject({
      entryId: rootRec.id,
      objectRef: hiddenObj.id,
    });

    // Check remote pump `changes` from /ops WITHOUT dive:
    const opsRemoteChanges = await opsSurf.changes({ sinceSeq: baselineSeq });
    const remoteEntityIds = opsRemoteChanges.entries.map((e) => e.entityId);
    // Must see rootRec itself (root is ancestor of /ops),
    expect(remoteEntityIds).toContain(rootRec.id);
    // MUST NOT see secretRec, secret entry_object, or secret resource_tag
    expect(
      remoteEntityIds.some((id) => id.includes(secretRec.id)),
    ).toBe(false);
    // MUST NOT see childSea or childSea:opsObj (even with legacy asset_class='ledger'!)
    expect(
      remoteEntityIds.some((id) => id.includes(childSea.id)),
    ).toBe(false);
    // MUST NOT see hiddenObj or rootRec:hiddenObj
    expect(
      remoteEntityIds.some((id) => id.includes(hiddenObj.id)),
    ).toBe(false);

    // Check local `sea.changes` returns the exact same filtered frame set!
    const localChanges = srv.engine.sea.changes({
      actor: { id: "ops-agent", kind: "agent" },
      viewerRealmId: ops.id,
      sinceSeq: baselineSeq,
    });
    expect(localChanges.entries.map((e) => e.entityId)).toEqual(remoteEntityIds);

    // With explicit dive, /ops DOES see childSea and its entry_object link, while STILL hiding secretRec & hiddenObj!
    const opsDiveChanges = await opsSurf.changes({
      sinceSeq: baselineSeq,
      includeDescendantSeabed: true,
    });
    const diveIds = opsDiveChanges.entries.map((e) => e.entityId);
    expect(diveIds).toContain(childSea.id);
    expect(diveIds).toContain(`${childSea.id}:${opsObj.id}`);
    expect(diveIds.some((id) => id.includes(secretRec.id))).toBe(false);
    expect(diveIds.some((id) => id.includes(hiddenObj.id))).toBe(false);

    // Also verify whoami.latestSeq does NOT leak a trailing secret entry_object write!
    const whoBefore = await opsSurf.whoami();
    const secretRec2 = (
      await opsSurf.write({
        in: "/ops",
        kind: "finding",
        title: "Trailing secret",
        body: "secret body 2",
        sensitivity: "secret",
        about: ["service:gateway"],
      })
    ).record;
    expect(secretRec2.sensitivity).toBe("secret");
    const whoAfter = await opsSurf.whoami();
    expect(whoAfter.latestSeq).toBe(whoBefore.latestSeq);
    expect(child.id).toBeTruthy();
    expect(hidden.id).toBeTruthy();
  });

  it("T1 #13: rule add --about persists entry_objects rows identically across local CLI, HTTP POST /v1/rules, and remote CLI", async () => {
    const homeDir = makeTempDir("meru-v070-rule-about-");
    const srv = await startMindServer({
      homeDir,
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const adminTok = srv.createToken({
      actorId: "admin",
      actorKind: "human",
    });
    const admin = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: adminTok.token,
    });
    await admin.createRealm({
      parentRef: "/",
      slug: "ops",
      name: "Ops",
      scope: "Operations",
    });
    const apiObj = (
      await admin.createObject({
        in: "/ops",
        kind: "service",
        name: "api",
      })
    ).object;

    // 1. Remote surface / HTTP POST /v1/rules with about
    const remoteRule = await admin.addRule({
      in: "/ops",
      title: "HTTP Scoped Rule",
      body: "Always run canary before prod cutover.",
      about: ["service:api"],
    });
    expect(
      srv.engine.db.listObjectIdsForEntry(remoteRule.id, srv.orgId),
    ).toContain(apiObj.id);

    // 2. Remote CLI `rule add --about`
    const remoteCliRule = (await runRemoteCliJson(srv.url, adminTok.token, [
      "rule",
      "add",
      "--in",
      "/ops",
      "--title",
      "Remote CLI Scoped Rule",
      "--body",
      "Never force push main.",
      "--about",
      "service:api",
    ])) as { id: string };
    expect(
      srv.engine.db.listObjectIdsForEntry(remoteCliRule.id, srv.orgId),
    ).toContain(apiObj.id);

    // 3. Close server and verify local CLI `rule add --about` routes through surface-local cleanly
    await srv.close();
    openServers.pop();

    const localCliRule = runCliJson(homeDir, [
      "rule",
      "add",
      "--in",
      "/ops",
      "--title",
      "Local CLI Scoped Rule",
      "--body",
      "Use readback after deploy.",
      "--about",
      "service:api",
      "--as-human",
    ]) as { id: string };

    const checkEngine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(checkEngine);
    expect(
      checkEngine.db.listObjectIdsForEntry(localCliRule.id),
    ).toContain(apiObj.id);
  });

  it("T1 #15a (Dogfood a): import verify --check-realm respects explicit --target layer without inferring from items and prints checkedLayers", async () => {
    const homeDir = makeTempDir("meru-v070-dogfood-a-");
    const docsDir = makeTempDir("meru-v070-docs-");
    const rawDir = makeTempDir("meru-v070-raw-");
    fs.writeFileSync(
      path.join(docsDir, "guide.md"),
      "# Deploy Guide\n\nAlways verify health checks.\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(rawDir, "log.md"),
      "# Raw Ops Log\n\n2026-11-28 incident notes.\n",
      "utf8",
    );

    const engine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(engine);
    const { org, rootRealm } = engine.ledger.createOrg({
      name: "DogfoodAOrg",
      policy: "open",
    });
    const ops = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "ops",
      name: "Ops",
    });

    // Import one record AND one seabed entry into the same realm /ops
    await engine.importer.importMd({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      targetRealmRef: "/ops",
      inputPath: docsDir,
      target: "record",
    });
    await engine.importer.importMd({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      targetRealmRef: "/ops",
      inputPath: rawDir,
      target: "seabed",
    });

    // Verify record source with explicit target: "record" -> passes, seabed NOT flagged as unexpected!
    const recordVerify = engine.importer.verifyImportConsistency({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      sourcePath: docsDir,
      target: "record",
      targetRealmRef: "/ops",
      checkUnexpectedInRealmRefs: ["/ops"],
    });
    expect(recordVerify.passed).toBe(true);
    expect(recordVerify.unexpectedCount).toBe(0);
    expect(recordVerify.checkedLayers).toEqual(["record"]);
    expect(formatImportVerifyMarkdown(recordVerify)).toContain(
      "Checked layers: record",
    );

    // Verify seabed source with explicit target: "seabed" -> passes, record NOT flagged as unexpected!
    const seabedVerify = engine.importer.verifyImportConsistency({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      sourcePath: rawDir,
      target: "seabed",
      targetRealmRef: "/ops",
      checkUnexpectedInRealmRefs: ["/ops"],
    });
    expect(seabedVerify.passed).toBe(true);
    expect(seabedVerify.unexpectedCount).toBe(0);
    expect(seabedVerify.checkedLayers).toEqual(["seabed"]);
    expect(formatImportVerifyMarkdown(seabedVerify)).toContain(
      "Checked layers: seabed",
    );

    // Verify WITHOUT explicit target -> checks BOTH layers (does NOT infer from items!) -> flags seabed as unexpected!
    const bothVerify = engine.importer.verifyImportConsistency({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      sourcePath: docsDir,
      targetRealmRef: "/ops",
      checkUnexpectedInRealmRefs: ["/ops"],
    });
    expect(bothVerify.passed).toBe(false);
    expect(bothVerify.checkedLayers).toEqual(["record", "seabed"]);
    expect(bothVerify.unexpectedEntries.some((u) => u.layer === "seabed")).toBe(
      true,
    );
    expect(ops.id).toBeTruthy();
  });

  it("T1 #15b (Dogfood b): show sea_<id> emits dive hint ONLY for ledger-readable & dive-seabed-readable non-secret non-redacted entries", async () => {
    const homeDir = makeTempDir("meru-v070-dogfood-b-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "DogfoodBOrg",
      policy: "tree",
    });
    const ops = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "ops",
      name: "Ops",
    });
    const child = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: ops.id,
      slug: "child",
      name: "Ops Child",
    });
    const sib = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "sib",
      name: "Sibling",
    });
    const mountedLedgerSib = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "mounted-ledger",
      name: "Mounted Ledger Only",
    });
    engine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: ops.id,
      targetRealmId: mountedLedgerSib.id,
      scope: "ledger",
    });

    const childSea = await engine.ledger.captureSeabed({
      actor: agentChild,
      viewerRealmId: child.id,
      kind: "message",
      text: "Normal descendant seabed entry",
    });
    const childSecretSea = await engine.ledger.captureSeabed({
      actor: agentChild,
      viewerRealmId: child.id,
      kind: "message",
      text: "Secret descendant seabed entry",
      sensitivity: "secret",
    });
    const childRedactedSea = await engine.ledger.captureSeabed({
      actor: agentChild,
      viewerRealmId: child.id,
      kind: "message",
      text: "Will be redacted",
    });
    engine.ledger.redact({
      actor: humanAlice,
      entryId: childRedactedSea.id,
      reason: "test redact",
    });
    const sibSea = await engine.ledger.captureSeabed({
      actor: agentB2,
      viewerRealmId: sib.id,
      kind: "message",
      text: "Hidden sibling seabed entry",
    });
    const mountedLedgerSea = await engine.ledger.captureSeabed({
      actor: agentB2,
      viewerRealmId: mountedLedgerSib.id,
      kind: "message",
      text: "Ledger-only mounted sibling seabed entry",
    });

    // Using LocalMindSurface (which passes non-dive scopeCeiling!) to test Fable's exact scopeCeiling trap!
    const opsSurface = new LocalMindSurface({
      engine,
      principal: {
        tokenId: null,
        orgId: org.id,
        actor: agentParent,
        boundRealmId: ops.id,
        boundSource: "test",
        authKind: "local",
      },
      ownsEngine: false,
    });

    // 1. Descendant normal seabed without dive -> NOT_FOUND WITH dive hint!
    let caughtChildErr: unknown;
    try {
      await opsSurface.show({ ref: childSea.id });
    } catch (err) {
      caughtChildErr = err;
    }
    expect(caughtChildErr).toBeInstanceOf(MindError);
    expect((caughtChildErr as MindError).code).toBe("NOT_FOUND");
    expect((caughtChildErr as MindError).details?.try).toBe(
      `meru-mind show ${childSea.id} --include-descendant-seabed`,
    );
    // MCP error formatter adapts the hint cleanly to mind_show with include_descendant_seabed: true
    const mcpErr = toSurfaceError(caughtChildErr, { surface: "mcp" });
    expect(mcpErr.error).toBe("not_found");
    expect(mcpErr.try).toBe(
      `mind_show({ ref: "${childSea.id}", include_descendant_seabed: true })`,
    );

    // 2. Sibling, ledger-only mount, secret descendant, redacted descendant, nonexistent -> ZERO try hint!
    for (const deniedId of [
      sibSea.id,
      mountedLedgerSea.id,
      childSecretSea.id,
      childRedactedSea.id,
      "sea_0000000000000000",
    ]) {
      let errCaught: unknown;
      try {
        await opsSurface.show({ ref: deniedId });
      } catch (err) {
        errCaught = err;
      }
      expect(errCaught).toBeInstanceOf(MindError);
      const me = errCaught as MindError;
      expect(me.code).toBe("NOT_FOUND");
      expect(me.details?.try).toBeUndefined();
    }

    await opsSurface.close();
  });

  it("T1 #16 (Contract alignment): user_version === 14, schema snapshot unchanged, --help <= 30 lines, and both MCP servers expose strictly 7 aligned tools", async () => {
    const homeDir = makeTempDir("meru-v070-contract-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(engine);
    const { org, rootRealm } = engine.ledger.createOrg({
      name: "ContractOrg",
      policy: "open",
    });

    // 1. Verify SQLite schema version === 14 (zero new tables/columns/indexes)
    const rawDb = new DatabaseSync(path.join(homeDir, "mind.sqlite"), {
      readOnly: true,
    });
    const maxV = rawDb
      .prepare("SELECT MAX(version) AS v FROM schema_migrations")
      .get() as { v: number };
    expect(maxV.v).toBe(14);
    const tables = (
      rawDb
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    rawDb.close();
    const who = engine.sea.whoami({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      boundSource: "test",
      storePath: homeDir,
    });
    expect(who.schemaVersion).toBe(14);
    expect(tables).not.toContain("card_objects");
    expect(tables).toContain("distillations");
    expect(tables).toContain("objects");
    expect(tables).toContain("entry_objects");

    // 2. Verify CLI top-level --help <= 30 lines
    const helpOut = runCliRaw(homeDir, ["--help"]);
    const helpLines = helpOut.trimEnd().split("\n");
    expect(helpLines.length).toBeLessThanOrEqual(30);

    // 3. Verify local stdio MCP and remote HTTP MCP expose strictly 7 tools with aligned budgets
    const localMcp = await createMindMcpServer({
      homeDir,
      orgId: org.id,
      viewerRealmId: rootRealm.id,
      actorId: "contract-agent",
    });
    const [lt1, lt2] = InMemoryTransport.createLinkedPair();
    await localMcp.server.connect(lt1);
    const localClient = new Client({ name: "test-local", version: "1.0.0" });
    await localClient.connect(lt2);
    const localTools = (await localClient.listTools()).tools;
    await localClient.close();
    await localMcp.server.close();
    await localMcp.engine.close();

    const surface = new LocalMindSurface({
      engine,
      principal: {
        tokenId: null,
        orgId: org.id,
        actor: { id: "contract-agent", kind: "agent" },
        boundRealmId: rootRealm.id,
        boundSource: "test",
        authKind: "local",
      },
      ownsEngine: false,
    });
    const httpMcp = createSurfaceMcpServer(surface);
    const [rt1, rt2] = InMemoryTransport.createLinkedPair();
    await httpMcp.connect(rt1);
    const httpClient = new Client({ name: "test-http", version: "1.0.0" });
    await httpClient.connect(rt2);
    const httpTools = (await httpClient.listTools()).tools;
    await httpClient.close();
    await httpMcp.close();
    await surface.close();

    expect(localTools).toHaveLength(7);
    expect(httpTools).toHaveLength(7);
    expect(localTools.map((t) => t.name)).toEqual(httpTools.map((t) => t.name));
    expect(JSON.stringify(localTools).length).toBeLessThanOrEqual(6000);
    expect(JSON.stringify(httpTools).length).toBeLessThanOrEqual(6000);
    for (const tool of [...localTools, ...httpTools]) {
      const desc = tool.description ?? "";
      expect(desc.length).toBeLessThanOrEqual(220);
      expect(desc.startsWith("[read]") || desc.startsWith("[write]")).toBe(true);
    }
    // Verify v0.7.0 input schema parity across local stdio MCP and remote HTTP MCP
    for (const toolList of [localTools, httpTools]) {
      const showTool = toolList.find((t) => t.name === "mind_show")!;
      const changesTool = toolList.find((t) => t.name === "mind_changes")!;
      expect(
        (showTool.inputSchema?.properties ?? {}) as Record<string, unknown>,
      ).toHaveProperty("with");
      expect(
        (changesTool.inputSchema?.properties ?? {}) as Record<string, unknown>,
      ).toHaveProperty("about");
    }
  });
});
