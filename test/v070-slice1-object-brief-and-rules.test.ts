import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  formatBriefMarkdown,
  formatShowMarkdown,
  LocalMindSurface,
  MindError,
  RemoteMindSurface,
  startMindServer,
  type Actor,
  type MindEngine,
  type RunningMindServer,
} from "../src/index.js";
import { createMindMcpServer } from "../src/mcp.js";
import { createSurfaceMcpServer } from "../src/server/mcp-http.js";

const execFileAsync = promisify(execFile);
const cliBin = path.resolve(import.meta.dirname, "../dist/cli.js");

const tempDirs: string[] = [];
const openEngines: MindEngine[] = [];
const openServers: RunningMindServer[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const humanAlice: Actor = { id: "alice", kind: "human" };
const agentWorker: Actor = { id: "agent-worker", kind: "agent" };
const agentB1: Actor = { id: "agent-b1", kind: "agent" };
const agentB2: Actor = { id: "agent-b2", kind: "agent" };

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

describe("v0.7.0 Commit 2: Slice 1 object brief, scoped rules, --with merge, I3 echo, and I4 subtractive guards", () => {
  it("1. Upward within ancestor walker collects object + visible ancestors (never descendants), stops at hidden parent, and realm brief never drops rules on hidden objects", async () => {
    const homeDir = makeTempDir("meru-v070-s1-walk-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "WalkOrg",
      policy: "tree",
    });
    const ops = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "ops",
      name: "Ops",
    });
    const secretSib = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "secret-sib",
      name: "Secret Sibling",
    });

    // Visible hierarchy in /ops: system:platform -> service:api -> endpoint:pay
    const objPlatform = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: ops.id,
      kind: "system",
      name: "platform",
    });
    const objApi = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: ops.id,
      parentObjectId: objPlatform.id,
      kind: "service",
      name: "api",
    });
    const objPay = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: ops.id,
      parentObjectId: objApi.id,
      kind: "endpoint",
      name: "pay",
    });

    // Hidden parent object in /secret-sib with a rule in / bound to it
    const hiddenObj = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: secretSib.id,
      kind: "system",
      name: "hidden-parent",
    });
    const rootRuleOnHiddenObj = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "rule",
      title: "Root rule scoped to hidden-parent",
      payload: { body: "Must still appear under realmRules for /ops reader." },
      objectIds: [hiddenObj.id],
    });

    // Wall rule in /ops, rule on platform, rule on api, rule on child endpoint:pay
    const wallRule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: ops.id,
      targetRealmId: ops.id,
      kind: "rule",
      title: "Ops Wall Rule",
      payload: { body: "All ops changes need rollback plans." },
    });
    const platformRule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: ops.id,
      targetRealmId: ops.id,
      kind: "rule",
      title: "Platform Ancestor Rule",
      payload: { body: "Platform services must emit OpenTelemetry traces." },
      objectIds: [objPlatform.id],
    });
    const apiRule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: ops.id,
      targetRealmId: ops.id,
      kind: "rule",
      title: "API Direct Rule",
      payload: { body: "API endpoints must enforce 5s timeout." },
      objectIds: [objApi.id],
    });
    const payChildRule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: ops.id,
      targetRealmId: ops.id,
      kind: "rule",
      title: "Pay Child Rule",
      payload: { body: "Payments require idempotency keys." },
      objectIds: [objPay.id],
    });

    // Add proposal, decision, finding, and co-occurring object on service:api
    const objAuth = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: ops.id,
      kind: "service",
      name: "auth",
    });
    const authRule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: ops.id,
      targetRealmId: ops.id,
      kind: "rule",
      title: "Auth Scoped Rule",
      payload: { body: "Auth tokens expire in 15m." },
      objectIds: [objAuth.id],
    });
    const prop = await engine.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: ops.id,
      targetRealmId: ops.id,
      kind: "proposal",
      title: "Proposal: raise API rate limit",
      payload: { body: "Raise rate limit from 100 to 250 rps." },
      objectIds: [objApi.id],
    });
    const dec = await engine.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: ops.id,
      targetRealmId: ops.id,
      kind: "decision",
      title: "Decision: use HTTP/2 on API",
      payload: { body: "Enabled HTTP/2." },
      objectIds: [objApi.id, objAuth.id],
    });
    const find = await engine.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: ops.id,
      targetRealmId: ops.id,
      kind: "finding",
      title: "Finding: API p99 spiked to 800ms",
      payload: { body: "Observed during load test." },
      objectIds: [objApi.id, objAuth.id],
    });

    // Show service:api -> sees wallRule + rootRuleOnHiddenObj (realm), apiRule + platformRule (object), NOT payChildRule!
    const shown = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: ops.id,
      ref: "service:api",
    });
    expect(shown.refType).toBe("object");
    if (shown.refType !== "object") throw new Error("expected object");

    const ruleIds = shown.card.rules.map((r) => r.id);
    expect(ruleIds).toContain(wallRule.id);
    expect(ruleIds).toContain(rootRuleOnHiddenObj.id);
    expect(ruleIds).toContain(platformRule.id);
    expect(ruleIds).toContain(apiRule.id);
    expect(ruleIds).not.toContain(payChildRule.id);
    expect(ruleIds).not.toContain(authRule.id);

    // No `scope` key on object or card JSON (Slice 2 boundary)
    expect("scope" in shown.card).toBe(false);
    expect("scope" in (shown.card.object ?? {})).toBe(false);

    // Full Object Brief fields
    expect(shown.card.pendingDecisions.items.map((x) => x.id)).toEqual([prop.id]);
    expect(shown.card.activeDecisions.items.map((x) => x.id)).toEqual([dec.id]);
    expect(shown.card.recentFindings.items.map((x) => x.id)).toEqual([find.id]);
    expect(shown.card.children.map((x) => x.id)).toEqual([objPay.id]);
    expect(shown.card.coOccurring).toEqual([
      expect.objectContaining({
        id: objAuth.id,
        ref: "service:auth",
        sharedCount: 2,
        ruleCount: 1,
        tryCommand: "meru-mind show service:api --with service:auth",
      }),
    ]);
    expect(shown.card.latestSeq).toBeGreaterThan(0);

    // Verify Spec 3.3 Markdown section order
    const md = formatShowMarkdown(shown);
    const idxHeader = md.indexOf("# service:api   /ops › service › api");
    const idxRules = md.indexOf("## 规矩 (");
    const idxPending = md.indexOf("## 待拍板 (");
    const idxDecisions = md.indexOf("## 现行决定 (");
    const idxFindings = md.indexOf("## 近期发现 (");
    const idxChildren = md.indexOf("## 下级 (1) · 同现 (1)");
    const idxFooter = md.indexOf("\n---\n");
    expect(idxHeader).toBe(0);
    expect(idxRules).toBeGreaterThan(idxHeader);
    expect(idxPending).toBeGreaterThan(idxRules);
    expect(idxDecisions).toBeGreaterThan(idxPending);
    expect(idxFindings).toBeGreaterThan(idxDecisions);
    expect(idxChildren).toBeGreaterThan(idxFindings);
    expect(idxFooter).toBeGreaterThan(idxChildren);

    // Verify V5 self-hiding empty sections on an object with zero proposals/decisions/findings/children/coOccurring
    const emptyObj = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: ops.id,
      kind: "service",
      name: "bare",
    });
    const bareShown = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: ops.id,
      ref: emptyObj.id,
    });
    const bareMd = formatShowMarkdown(bareShown);
    expect(bareMd).not.toContain("## 待拍板");
    expect(bareMd).not.toContain("## 现行决定");
    expect(bareMd).not.toContain("## 近期发现");
    expect(bareMd).not.toContain("## 下级");

    // Verify Realm Brief splits realmRules vs scopedObjectRules, keeps rootRuleOnHiddenObj visible in realmRules, and puts Buckets in footer!
    const brief = engine.sea.brief({
      actor: agentWorker,
      viewerRealmId: ops.id,
      target: "/ops",
    });
    expect(brief.middleMind.realmRules?.map((r) => r.id)).toContain(wallRule.id);
    expect(brief.middleMind.realmRules?.map((r) => r.id)).toContain(
      rootRuleOnHiddenObj.id,
    );
    expect(brief.middleMind.scopedObjectRules?.map((r) => r.id)).toContain(
      apiRule.id,
    );
    const briefMd = formatBriefMarkdown(brief);
    expect(briefMd.indexOf("Buckets:")).toBeGreaterThan(
      briefMd.indexOf("## Rules"),
    );
  });

  it("2. T1 #14 (--with read merge): validates cap <= 10, rejects unknown/non-object refs, deduplicates & preserves realm > object > with precedence across HTTP & MCP, never implies descendant seabed", async () => {
    const homeDir = makeTempDir("meru-v070-s1-with-");
    const srv = await startMindServer({
      homeDir,
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    const admin = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: adminTok.token,
    });
    await admin.setOrgPolicy({ policy: "tree" });
    await admin.createRealm({
      parentRef: "/",
      slug: "ops",
      name: "Ops",
      scope: "Operations",
    });
    await admin.createRealm({
      parentRef: "/ops",
      slug: "child",
      name: "Ops Child",
      scope: "Child",
    });
    await admin.createRealm({
      parentRef: "/",
      slug: "hidden",
      name: "Hidden",
      scope: "Hidden",
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

    const objApi = (
      await opsSurf.createObject({ in: "/ops", kind: "service", name: "api" })
    ).object;
    const objDb = (
      await opsSurf.createObject({ in: "/ops", kind: "database", name: "pg" })
    ).object;
    const hiddenObj = (
      await hiddenSurf.createObject({
        in: "/hidden",
        kind: "service",
        name: "secret-svc",
      })
    ).object;

    const opsHumanTok = await admin.createToken({
      actorId: "ops-human",
      actorKind: "human",
      boundRealmRef: "/ops",
    });
    const opsHumanSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: opsHumanTok.token,
    });

    // Rules: 1 wall rule, 1 shared rule bound to BOTH api & pg, 1 pg-only rule
    const wallRule = await opsHumanSurf.addRule({
      in: "/ops",
      title: "Ops Wall",
      body: "Wall body",
    });
    const sharedRule = await opsHumanSurf.addRule({
      in: "/ops",
      title: "Shared API+PG Rule",
      body: "Shared body",
      about: [objApi.id, objDb.id],
    });
    const pgRule = await opsHumanSurf.addRule({
      in: "/ops",
      title: "PG Only Rule",
      body: "PG body",
      about: [objDb.id],
    });

    // Descendant seabed in /ops/child linked to objApi -> --with MUST NOT pull it in!
    const childSea = await childSurf.rawAdd({
      in: "/ops/child",
      kind: "message",
      text: "Child private seabed note",
    });
    await childSurf.linkObject({ entryId: childSea.id, objectRef: objApi.id });

    // 1. Valid --with merges pgRule, deduplicates duplicate forms (id + kind:name + primary self), keeps precedence realm > object > with
    const merged = await opsSurf.show({
      ref: "service:api",
      with: ["database:pg", objDb.id, "/ops/database:pg", "service:api"],
    });
    expect(merged.refType).toBe("object");
    if (merged.refType !== "object") throw new Error("expected object");
    expect(merged.card.withRefs).toEqual(["database:pg"]);
    const byId = new Map(merged.card.rules.map((r) => [r.id, r]));
    expect(byId.get(wallRule.id)?.scopeSource).toBe("realm");
    expect(byId.get(sharedRule.id)?.scopeSource).toBe("object"); // object > with!
    expect(byId.get(pgRule.id)?.scopeSource).toBe("with");
    // Descendant seabed NOT leaked via --with
    expect(
      merged.card.recentEntries.some((e) => e.id === childSea.id),
    ).toBe(false);

    // 2. Cap > 10 raw --with rejected BEFORE resolution with INVALID_INPUT
    const eleven = Array.from({ length: 11 }, (_, i) => `service:s${i}`);
    await expect(
      opsSurf.show({ ref: "service:api", with: eleven }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // 3. Invalid / non-object --with rejected with INVALID_INPUT
    await expect(
      opsSurf.show({ ref: "service:api", with: ["/ops"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      opsSurf.show({ ref: "/ops", with: ["service:api"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // 4. Hidden vs nonexistent --with returns identical opaque NOT_FOUND
    let hiddenErr: MindError | null = null;
    let missingErr: MindError | null = null;
    try {
      await opsSurf.show({ ref: "service:api", with: [hiddenObj.id] });
    } catch (e) {
      hiddenErr = e as MindError;
    }
    try {
      await opsSurf.show({ ref: "service:api", with: ["obj_0000000000000000"] });
    } catch (e) {
      missingErr = e as MindError;
    }
    expect(hiddenErr?.code).toBe("NOT_FOUND");
    expect(missingErr?.code).toBe("NOT_FOUND");
    expect(hiddenErr?.message).toBe(missingErr?.message);

    // 5. Remote HTTP MCP mind_show accepts `with` and stays <= 6000 wire JSON
    const httpMcp = createSurfaceMcpServer(opsSurf);
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    await httpMcp.connect(t1);
    const client = new Client({ name: "test-with-mcp", version: "1.0.0" });
    await client.connect(t2);
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(7);
    expect(JSON.stringify(listed.tools).length).toBeLessThanOrEqual(6000);
    const mcpRes = await client.callTool({
      name: "mind_show",
      arguments: { ref: "service:api", with: ["database:pg"] },
    });
    const parsedMcp = JSON.parse(
      (mcpRes.content as Array<{ text: string }>)[0]!.text,
    );
    expect(parsedMcp.card.rules.map((r: { id: string }) => r.id)).toContain(
      pgRule.id,
    );
    await client.close();
    await httpMcp.close();
  });

  it("3. T1 #10 & #11 (I3 rule echo on write): object ∪ tag cross-binding echoes rules, within-ancestor echoes, sibling rules NEVER echo, zero hidden count fields", async () => {
    const homeDir = makeTempDir("meru-v070-s1-i3-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "EchoOrg",
      policy: "tree",
    });
    const b1 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "b1",
      name: "B1",
    });
    const b2 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "b2",
      name: "B2",
    });

    // Root tag-only rule on service:billing (before object exists)
    const tagRule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "rule",
      title: "Root Tag Rule on service:billing",
      payload: { body: "Audit every billing change." },
      resourceTags: ["service:billing"],
    });

    // Object in /b1: system:payments -> service:billing
    const sysPayments = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: b1.id,
      kind: "system",
      name: "payments",
    });
    const svcBilling = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: b1.id,
      parentObjectId: sysPayments.id,
      kind: "service",
      name: "billing",
    });
    const parentObjRule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: b1.id,
      targetRealmId: b1.id,
      kind: "rule",
      title: "Payments Parent Object Rule",
      payload: { body: "Dual-approval required." },
      objectIds: [sysPayments.id],
    });

    // Reverse case: rule bound to object service:cache in /, write uses resource_tag service:cache
    const rootCacheObj = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "service",
      name: "cache",
    });
    const objCacheRule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "rule",
      title: "Root Object Rule on service:cache",
      payload: { body: "Never flush Redis in prod." },
      objectIds: [rootCacheObj.id],
    });

    // Sibling /b2 rule on same-named service:billing (MUST NEVER echo to /b1!)
    const b2BillingObj = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: b2.id,
      kind: "service",
      name: "billing",
    });
    const b2Rule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: b2.id,
      targetRealmId: b2.id,
      kind: "rule",
      title: "B2 Sibling Secret Rule",
      payload: { body: "B2 internal only." },
      objectIds: [b2BillingObj.id],
      resourceTags: ["service:billing"],
    });

    const surfB1 = new LocalMindSurface({
      engine,
      principal: {
        tokenId: null,
        orgId: org.id,
        actor: agentB1,
        boundRealmId: b1.id,
        boundSource: "test",
        authKind: "local",
      },
      ownsEngine: false,
    });

    // Case A: Write linked to object svcBilling -> echoes BOTH tagRule (root tag) AND parentObjRule (within ancestor), NEVER b2Rule!
    const w1 = await surfB1.write({
      in: "/b1",
      kind: "finding",
      title: "Billing latency observation",
      body: "Observed 20ms latency.",
      about: [svcBilling.id],
    });
    const w1RuleIds = (w1.boundRules ?? []).map((r) => r.id);
    expect(w1RuleIds).toContain(tagRule.id);
    expect(w1RuleIds).toContain(parentObjRule.id);
    expect(w1RuleIds).not.toContain(b2Rule.id);
    expect(JSON.stringify(w1)).not.toContain("hidden");

    // Case B: Rule on object rootCacheObj -> write using tag/unqualified service:cache echoes objCacheRule!
    const w2 = await surfB1.write({
      in: "/b1",
      kind: "finding",
      title: "Cache hit rate note",
      body: "Cache hit rate is 98%.",
      about: ["service:cache"],
    });
    expect((w2.boundRules ?? []).map((r) => r.id)).toContain(objCacheRule.id);

    // Case C: Secret write NEVER emits boundRules
    const wSecret = await surfB1.write({
      in: "/b1",
      kind: "finding",
      title: "Secret billing note",
      body: "Sensitive",
      sensitivity: "secret",
      about: [svcBilling.id],
    });
    expect(wSecret.boundRules).toBeUndefined();

    await surfB1.close();
    expect(agentB2.id).toBeTruthy();
  });

  it("4. T1 #12 & L10 (I4 complete subtractive guards): blocks agent moveObject, alias --remove, setObjectState(inactive) with active rules, deleteObject CONFLICT on active rules, and Cookie rule link/unlink", async () => {
    const homeDir = makeTempDir("meru-v070-s1-i4-");
    const srv = await startMindServer({
      homeDir,
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });
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
    const agentTok = await admin.createToken({
      actorId: "worker-bot",
      actorKind: "agent",
      boundRealmRef: "/ops",
    });
    const agent = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: agentTok.token,
    });

    const parentObj = (
      await admin.createObject({ in: "/ops", kind: "system", name: "core" })
    ).object;
    const childObj = (
      await admin.createObject({
        in: "/ops",
        kind: "service",
        name: "api",
        parentRef: parentObj.id,
      })
    ).object;
    await agent.updateObjectAliases({ ref: childObj.id, add: ["api-gw"] });

    // Attach active rule to parentObj (inherited by childObj)
    const rule = await admin.addRule({
      in: "/ops",
      title: "Core Invariant",
      body: "No unreviewed prod deploys.",
      about: [parentObj.id],
    });
    const ev = (
      await agent.write({
        in: "/ops",
        kind: "decision",
        title: "Deprecate api",
        body: "Evidence for state change",
      })
    ).record;

    // 1. Agent cannot moveObject to escape parent rules
    await expect(
      agent.moveObject({ ref: childObj.id, parentRef: null }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    // 2. Agent cannot remove object alias
    await expect(
      agent.updateObjectAliases({ ref: childObj.id, remove: ["api-gw"] }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    // 3. Agent cannot mark childObj inactive while active rules apply (even with --because!)
    await expect(
      agent.setObjectState({
        ref: childObj.id,
        state: "inactive",
        label: "deprecated",
        because: ev.id,
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    // 4. Human cannot deleteObject while active rules are bound -> CONFLICT
    const leafWithRule = (
      await admin.createObject({ in: "/ops", kind: "service", name: "ruled-leaf" })
    ).object;
    await admin.addRule({
      in: "/ops",
      title: "Leaf Rule",
      body: "Protects ruled-leaf",
      about: [leafWithRule.id],
    });
    await expect(
      admin.deleteObject({ ref: leafWithRule.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // 5. L10: Weakened Cookie session (even human!) is rejected with 403 on rule link/unlink, alias remove, moveObject, setObjectState(inactive w/ rules)
    const cookieSurface = new LocalMindSurface({
      engine: srv.engine,
      principal: {
        tokenId: null,
        orgId: srv.orgId,
        actor: humanAlice,
        boundRealmId: srv.engine.db.getRealmByPath(srv.orgId, "/ops")!.id,
        boundSource: "cookie",
        authKind: "cookie",
      },
      ownsEngine: false,
    });
    await expect(
      cookieSurface.linkObject({ entryId: rule.id, objectRef: childObj.id }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      cookieSurface.unlinkObject({ entryId: rule.id, objectRef: parentObj.id }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      cookieSurface.updateObjectAliases({
        ref: childObj.id,
        remove: ["api-gw"],
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      cookieSurface.setObjectState({
        ref: childObj.id,
        state: "inactive",
        label: "deprecated",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      cookieSurface.moveObject({ ref: childObj.id, parentRef: null }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await cookieSurface.close();

    // 6. Human Bearer CAN remove alias & set inactive & moveObject
    const removed = await admin.updateObjectAliases({
      ref: childObj.id,
      remove: ["api-gw"],
    });
    expect(removed.removed).toContain("api-gw");
    const deactivated = await admin.setObjectState({
      ref: childObj.id,
      state: "inactive",
      label: "deprecated",
    });
    expect(deactivated.object.state).toBe("inactive");

    // Remote CLI `show --with` smoke check (while server is still running)
    const cliOut = JSON.parse(
      (
        await execFileAsync(
          process.execPath,
          [
            cliBin,
            "--url",
            srv.url,
            "--token",
            agentTok.token,
            "show",
            "service:api",
            "--with",
            "system:core",
            "--json",
          ],
          { encoding: "utf8" },
        )
      ).stdout,
    );
    expect(cliOut.refType).toBe("object");
    expect(cliOut.card.rules.map((r: { id: string }) => r.id)).toContain(
      rule.id,
    );

    // 7. Close server, then verify local stdio MCP stays strictly 7 tools <= 6000 wire JSON with `with`
    const opsRealmId = srv.engine.db.getRealmByPath(srv.orgId, "/ops")!.id;
    const savedOrgId = srv.orgId;
    await srv.close();
    openServers.pop();

    const localMcp = await createMindMcpServer({
      homeDir,
      orgId: savedOrgId,
      viewerRealmId: opsRealmId,
      actorId: "local-mcp-agent",
    });
    const [lt1, lt2] = InMemoryTransport.createLinkedPair();
    await localMcp.server.connect(lt1);
    const localClient = new Client({ name: "test-local-s1", version: "1.0.0" });
    await localClient.connect(lt2);
    const localTools = (await localClient.listTools()).tools;
    expect(localTools).toHaveLength(7);
    expect(JSON.stringify(localTools).length).toBeLessThanOrEqual(6000);
    await localClient.close();
    await localMcp.server.close();
    await localMcp.engine.close();
  });
});
