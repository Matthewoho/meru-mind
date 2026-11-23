import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWriteRecordPayload,
  createMindEngine,
  restoreWritablePermissions,
  resolveAccessScope,
  writeEverydayConclusion,
  type Actor,
  type MindEngine,
} from "../src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliBin = path.join(repoRoot, "dist", "cli.js");
const mcpBin = path.join(repoRoot, "dist", "mcp.js");

const tempDirs: string[] = [];
const engines: MindEngine[] = [];

const humanAlice: Actor = { id: "alice", kind: "human" };
const agentBot: Actor = { id: "bot", kind: "agent", family: "claude" };

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (engines.length > 0) {
    await engines.pop()!.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    restoreWritablePermissions(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCliJson(
  homeDir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): unknown {
  const out = execFileSync(
    process.execPath,
    [cliBin, "--home", homeDir, "--json", ...args],
    { encoding: "utf8", env: { ...process.env, ...extraEnv } },
  );
  return JSON.parse(out.trim()) as unknown;
}

function runCliText(
  homeDir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): string {
  return execFileSync(
    process.execPath,
    [cliBin, "--home", homeDir, ...args],
    { encoding: "utf8", env: { ...process.env, ...extraEnv } },
  );
}

function runCliFail(
  homeDir: string,
  args: string[],
  options?: { json?: boolean; env?: Record<string, string> },
): { status: number; stderr: string } {
  const fullArgs = [
    cliBin,
    "--home",
    homeDir,
    ...(options?.json ? ["--json"] : []),
    ...args,
  ];
  try {
    execFileSync(process.execPath, fullArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options?.env },
    });
    throw new Error(`Expected CLI command to fail: ${args.join(" ")}`);
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string | Buffer };
    return {
      status: e.status ?? 1,
      stderr: String(e.stderr ?? ""),
    };
  }
}

describe("V0.2a-Surface Contract: 7-Tool MCP Budget, Typed Refs, Unified Objects, Global Blocklist & 11 Wire Errors", () => {
  it("1. MCP wire tools/list gate: strictly 7 tools, wire JSON <= 6000 chars, every description <= 220 chars starting with [read]/[write]", async () => {
    const homeDir = makeTempDir("meru-mind-surf-mcp-budget-");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpBin],
      env: { ...process.env, MERU_MIND_HOME: homeDir },
    });
    const client = new Client({ name: "budget-gate", version: "0.2.0" });
    await client.connect(transport);
    try {
      const toolsResult = await client.listTools();
      expect(toolsResult.tools).toHaveLength(7);
      expect(toolsResult.tools.map((t) => t.name).sort()).toEqual([
        "mind_changes",
        "mind_ls",
        "mind_search",
        "mind_show",
        "mind_tree",
        "mind_whoami",
        "mind_write",
      ]);

      const wireJson = JSON.stringify(toolsResult);
      expect(wireJson.length).toBeLessThanOrEqual(6000);

      for (const tool of toolsResult.tools) {
        const desc = tool.description ?? "";
        expect(desc.length).toBeLessThanOrEqual(220);
        expect(desc.startsWith("[read]") || desc.startsWith("[write]")).toBe(
          true,
        );
        const props = (tool.inputSchema?.properties ?? {}) as Record<
          string,
          unknown
        >;
        expect(props).not.toHaveProperty("actorKind");
        expect(props).not.toHaveProperty("allowRedactedReingest");
        expect(props).not.toHaveProperty("focusBoost");
      }

      const writeTool = toolsResult.tools.find((t) => t.name === "mind_write")!;
      const writeProps = writeTool.inputSchema.properties as Record<
        string,
        { type?: string; enum?: string[] }
      >;
      expect(writeProps.kind?.type).toBe("string");
      expect(writeProps.kind?.enum).toBeUndefined();
      expect(writeProps.sensitivity?.enum).toEqual([
        "public",
        "internal",
        "confidential",
        "secret",
      ]);

      // F3: Live stdio MCP mind_write({ kind: "rule" }) returns 4-field { error: "forbidden", message, try }
      const ruleCall = await client.callTool({
        name: "mind_write",
        arguments: {
          in: "/",
          kind: "rule",
          title: "Attempted MCP rule",
          body: "Must be rejected with wire forbidden",
        },
      });
      expect(ruleCall.isError).toBe(true);
      const rulePayload = JSON.parse(
        (ruleCall.content as Array<{ text: string }>)[0]!.text,
      ) as { error: string; message: string; try?: string };
      expect(rulePayload.error).toBe("forbidden");
      expect(rulePayload.message.length).toBeGreaterThan(0);
      expect(rulePayload.try).toBeTruthy();

      // F3 + P2: Unsupported kind returns 4-field invalid_input with MCP-native try hint
      const badKindCall = await client.callTool({
        name: "mind_write",
        arguments: {
          in: "/",
          kind: "unknown-kind",
          title: "Bad kind",
          body: "Must return invalid_input",
        },
      });
      expect(badKindCall.isError).toBe(true);
      const badKindPayload = JSON.parse(
        (badKindCall.content as Array<{ text: string }>)[0]!.text,
      ) as { error: string; message: string; try?: string };
      expect(badKindPayload.error).toBe("invalid_input");
      expect(badKindPayload.try).toContain("mind_write(");
      expect(badKindPayload.try).not.toContain("meru-mind ");

      // P2: invalid_ref over MCP returns MCP-native try hint (never CLI `meru-mind ...`)
      const badRefCall = await client.callTool({
        name: "mind_show",
        arguments: { ref: "bare-invalid-token" },
      });
      expect(badRefCall.isError).toBe(true);
      const badRefPayload = JSON.parse(
        (badRefCall.content as Array<{ text: string }>)[0]!.text,
      ) as { error: string; try?: string };
      expect(badRefPayload.error).toBe("invalid_ref");
      expect(badRefPayload.try).toContain("mind_tree(");
      expect(badRefPayload.try).not.toContain("meru-mind ");
    } finally {
      await client.close();
    }
  });

  it("2. Ref round-trip (tree/ls/search/changes -> show) across open & tree orgs including @mounted/<alias> and file:", async () => {
    const homeDir = makeTempDir("meru-mind-surf-rt-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "TreeRoundTripOrg",
      policy: "tree",
    });
    const b1 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "hidden-branch-b1",
      name: "Hidden Branch B1",
    });
    const c1 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: b1.id,
      slug: "shared-c1",
      name: "Shared C1",
    });
    const b2 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "team-b2",
      name: "Team B2",
    });
    const c2 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: b2.id,
      slug: "app-c2",
      name: "App C2",
    });

    engine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: c2.id,
      targetRealmId: c1.id,
      scope: "all",
    });

    // Populate C1 (mounted) and C2 (self) with objects, records, seabed, and drive files
    const objC1 = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: c1.id,
      kind: "service",
      name: "billing-core",
    });
    const recC1 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: c1.id,
      kind: "decision",
      title: "Billing idempotency policy",
      payload: buildWriteRecordPayload("Always enforce idempotency keys."),
      objectIds: [objC1.id],
    });
    await engine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: c1.id,
      relPath: "runbooks/billing.md",
      content: "# Billing Runbook\nStep 1: Verify ledger.",
    });
    const recC2 = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: c2.id,
      kind: "finding",
      title: "App C2 uses billing-core",
      payload: buildWriteRecordPayload("Integration verified."),
    });
    await engine.ledger.writeDriveFile({
      actor: agentBot,
      viewerRealmId: c2.id,
      relPath: "README.md",
      content: "# App C2 Readme",
    });

    // Also plant hidden sibling data in B1 that MUST NEVER appear in C2's whoami/tree/ls/search/changes
    await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: b1.id,
      kind: "decision",
      title: "HIDDEN_B1_SECRET_DECISION",
      payload: buildWriteRecordPayload("TOP_SECRET_B1_PAYLOAD"),
    });
    engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: b1.id,
      kind: "service",
      name: "hidden-b1-svc",
    });
    await engine.close();
    engines.pop();

    const c2Env = { MERU_MIND_VIEWER_REALM_ID: c2.id };

    // F2: whoami zero-leak check BEFORE and AFTER mutating hidden branch B1
    // (realms, objects, entries, raw, files, and latestSeq must stay strictly unchanged)
    const whoamiBefore = runCliJson(homeDir, ["whoami"], c2Env) as {
      bound: { realmPath: string };
      corpus: {
        realms: number;
        objects: number;
        conclusions: number;
        raw: number;
        files: number;
      };
      latestSeq: number;
      schemaVersion: number;
      next: string;
    };
    expect(whoamiBefore.bound.realmPath).toBe("/team-b2/app-c2");
    expect(whoamiBefore.schemaVersion).toBe(8);
    expect(whoamiBefore.next).toBe("meru-mind tree /team-b2/app-c2");
    // Visible realms for C2: root `/`, `/team-b2`, `/team-b2/app-c2`, `@mounted/shared-c1` = 4 (excludes hidden B1!)
    expect(whoamiBefore.corpus.realms).toBe(4);
    expect(whoamiBefore.corpus.objects).toBe(1); // ONLY billing-core, NOT hidden-b1-svc!
    expect(whoamiBefore.corpus.conclusions).toBe(2); // ONLY recC1 + recC2, NOT B1!
    expect(JSON.stringify(whoamiBefore)).not.toContain("hidden-branch-b1");
    expect(JSON.stringify(whoamiBefore)).not.toContain(b1.id);

    // Mutate hidden sibling branch B1: add hidden sub-realm, hidden object, hidden records, hidden seabed
    const mutEng = await createMindEngine({ homeDir, enableVector: false });
    engines.push(mutEng);
    const b1HiddenChild = mutEng.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: b1.id,
      slug: "hidden-sub-b1a",
      name: "Hidden Sub B1A",
    });
    mutEng.objects.createObject({
      actor: humanAlice,
      viewerRealmId: b1HiddenChild.id,
      kind: "service",
      name: "hidden-sub-svc",
    });
    await mutEng.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: b1HiddenChild.id,
      kind: "finding",
      title: "HIDDEN_SUB_RECORD_1",
      payload: buildWriteRecordPayload("Invisible to C2"),
    });
    await mutEng.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: b1.id,
      kind: "message",
      text: "HIDDEN_B1_RAW_NOTE",
    });
    const orgMaxSeq = mutEng.db.getLatestChangeLogSeq(org.id);
    await mutEng.close();
    engines.pop();

    const whoamiAfter = runCliJson(homeDir, ["whoami"], c2Env) as typeof whoamiBefore;
    expect(whoamiAfter.corpus).toEqual(whoamiBefore.corpus);
    expect(whoamiAfter.corpus.realms).toBe(4); // Strictly visible realms (total org realms is now 6!)
    expect(whoamiAfter.latestSeq).toBe(whoamiBefore.latestSeq);
    expect(whoamiAfter.latestSeq).toBeLessThan(orgMaxSeq);
    expect(JSON.stringify(whoamiAfter)).not.toContain("hidden-branch-b1");
    expect(JSON.stringify(whoamiAfter)).not.toContain("hidden-sub-b1a");
    expect(JSON.stringify(whoamiAfter)).not.toContain(b1.id);
    expect(JSON.stringify(whoamiAfter)).not.toContain(b1HiddenChild.id);

    // P2: Tree-org live MCP invalid_ref suggests bound realm path (NEVER "/" and NEVER CLI `meru-mind`)
    const treeMcpTransport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpBin],
      env: {
        ...process.env,
        MERU_MIND_HOME: homeDir,
        MERU_MIND_ORG_ID: org.id,
        MERU_MIND_VIEWER_REALM_ID: c2.id,
      },
    });
    const treeMcpClient = new Client({ name: "tree-p2-check", version: "0.2.0" });
    await treeMcpClient.connect(treeMcpTransport);
    try {
      const treeBadRef = await treeMcpClient.callTool({
        name: "mind_show",
        arguments: { ref: "bare-invalid-token" },
      });
      expect(treeBadRef.isError).toBe(true);
      const treeBadRefPayload = JSON.parse(
        (treeBadRef.content as Array<{ text: string }>)[0]!.text,
      ) as { error: string; try?: string };
      expect(treeBadRefPayload.error).toBe("invalid_ref");
      expect(treeBadRefPayload.try).toBe('mind_tree({ ref: "/team-b2/app-c2" })');
      expect(treeBadRefPayload.try).not.toContain("meru-mind ");
      expect(treeBadRefPayload.try).not.toContain('ref: "/"');
    } finally {
      await treeMcpClient.close();
    }

    // tree -> every emitted realm path & object ref works verbatim in show and ls
    const treeJson = runCliJson(homeDir, ["tree", "-L", "all"], c2Env) as {
      realms: Array<{ path: string }>;
    };
    expect(JSON.stringify(treeJson)).not.toContain("hidden-branch-b1");
    expect(JSON.stringify(treeJson)).not.toContain(b1.id);
    const mountedPath = treeJson.realms.find((r) =>
      r.path.startsWith("@mounted/"),
    )?.path;
    expect(mountedPath).toBe("@mounted/shared-c1");

    // Round-trip mounted realm into show & ls
    const showMounted = runCliJson(homeDir, ["show", mountedPath!], c2Env) as {
      refType: string;
      ref: string;
    };
    expect(showMounted.refType).toBe("realm");
    expect(showMounted.ref).toBe("@mounted/shared-c1");

    const lsMounted = runCliJson(homeDir, ["ls", mountedPath!], c2Env) as {
      objects: Array<{ ref: string }>;
      items: Array<{ id: string }>;
      driveFiles: Array<{ ref: string }>;
    };
    expect(lsMounted.objects[0]?.ref).toBe("service:billing-core");
    expect(lsMounted.driveFiles[0]?.ref).toBe(
      "file:@mounted/shared-c1/runbooks/billing.md",
    );

    // Round-trip mounted file: ref into show
    const showMountedFile = runCliJson(
      homeDir,
      ["show", lsMounted.driveFiles[0]!.ref],
      c2Env,
    ) as { refType: string; ref: string; file: { content: string } };
    expect(showMountedFile.refType).toBe("file");
    expect(showMountedFile.ref).toBe(
      "file:@mounted/shared-c1/runbooks/billing.md",
    );
    expect(showMountedFile.file.content).toContain("Billing Runbook");

    // Round-trip object ref into show & ls
    const showObj = runCliJson(
      homeDir,
      ["show", lsMounted.objects[0]!.ref],
      c2Env,
    ) as { refType: string; card: { counts: { total: number } } };
    expect(showObj.refType).toBe("object");
    expect(showObj.card.counts.total).toBe(1);

    // Round-trip search & changes entry IDs into show
    const searchRes = runCliJson(homeDir, ["search", "idempotency"], c2Env) as {
      items: Array<{ id: string; realmPath: string }>;
    };
    expect(searchRes.items[0]?.id).toBe(recC1.id);
    expect(searchRes.items[0]?.realmPath).toBe("@mounted/shared-c1");

    const showRec = runCliJson(homeDir, ["show", searchRes.items[0]!.id], c2Env) as {
      refType: string;
      entry: { record: { id: string } };
    };
    expect(showRec.refType).toBe("entry");
    expect(showRec.entry.record.id).toBe(recC1.id);

    // Round-trip self file: ref via ls --only files -> show
    const lsSelfFiles = runCliJson(
      homeDir,
      ["ls", "/team-b2/app-c2", "--only", "files"],
      c2Env,
    ) as { driveFiles: Array<{ ref: string }> };
    expect(lsSelfFiles.driveFiles[0]?.ref).toBe(
      "file:/team-b2/app-c2/README.md",
    );
    const showSelfFile = runCliJson(
      homeDir,
      ["show", lsSelfFiles.driveFiles[0]!.ref],
      c2Env,
    ) as { refType: string; file: { content: string } };
    expect(showSelfFile.file.content).toBe("# App C2 Readme");

    // ls on entry or file throws not_listable with `try: meru-mind show <ref>`
    const lsOnEntry = runCliFail(homeDir, ["ls", recC2.id], {
      json: true,
      env: c2Env,
    });
    const lsOnEntryErr = JSON.parse(lsOnEntry.stderr) as {
      error: string;
      try: string;
    };
    expect(lsOnEntryErr.error).toBe("not_listable");
    expect(lsOnEntryErr.try).toBe(`meru-mind show ${recC2.id}`);

    const lsOnFile = runCliFail(
      homeDir,
      ["ls", "file:/team-b2/app-c2/README.md"],
      { json: true, env: c2Env },
    );
    const lsOnFileErr = JSON.parse(lsOnFile.stderr) as {
      error: string;
      try: string;
    };
    expect(lsOnFileErr.error).toBe("not_listable");
    expect(lsOnFileErr.try).toBe("meru-mind show file:/team-b2/app-c2/README.md");
  });

  it("3. Unified object read (objects ∪ tags ∪ things), realm-qualified scoping & zero-leak ambiguous_ref disambiguation", async () => {
    const homeDir = makeTempDir("meru-mind-surf-obj-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    engines.push(engine);

    // Part A: Open org — unified union + realm-qualified scoping + 2-realm ambiguity
    const { org: openOrg, rootRealm: openRoot } = engine.ledger.createOrg({
      name: "ObjOpenOrg",
      policy: "open",
    });
    const ops = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: openOrg.id,
      parentId: openRoot.id,
      slug: "ops",
      name: "Ops",
    });
    const eng = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: openOrg.id,
      parentId: openRoot.id,
      slug: "eng",
      name: "Eng",
    });

    // Unique object `service:payments` in /ops + tag-linked entry + thing anchor
    const objPay = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: ops.id,
      kind: "service",
      name: "payments",
    });
    const recViaObj = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: ops.id,
      kind: "decision",
      title: "Payments retry policy",
      payload: buildWriteRecordPayload("3 retries with exponential backoff."),
      objectIds: [objPay.id],
    });
    const recViaTag = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: eng.id,
      kind: "finding",
      title: "Payments webhook latency",
      payload: buildWriteRecordPayload("p99 is 180ms."),
      resourceTags: ["service:payments"],
    });
    const thingPay = await engine.ledger.createThing({
      actor: agentBot,
      viewerRealmId: ops.id,
      title: "Payments Gateway Anchor",
      externalRef: "service:payments",
    });

    // Unqualified `ls service:payments` returns deduplicated union of all 3 (object + tag + thing)
    const unionLs = await engine.sea.ls({
      actor: agentBot,
      viewerRealmId: openRoot.id,
      ref: "service:payments",
    });
    expect(unionLs.items.map((i) => i.id).sort()).toEqual(
      [recViaObj.id, recViaTag.id, thingPay.id].sort(),
    );

    // Realm-qualified `/ops/service:payments` scopes tag & thing strictly to /ops (excludes /eng's tag-only entry!)
    const qualifiedOpsLs = await engine.sea.ls({
      actor: agentBot,
      viewerRealmId: openRoot.id,
      ref: "/ops/service:payments",
    });
    const qIds = qualifiedOpsLs.items.map((i) => i.id);
    expect(qIds).toContain(recViaObj.id);
    expect(qIds).toContain(thingPay.id);
    expect(qIds).not.toContain(recViaTag.id);

    // Duplicate `service:api` in TWO visible realms (/ops and /eng) triggers AMBIGUOUS_REF
    engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: ops.id,
      kind: "service",
      name: "api",
    });
    engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: eng.id,
      kind: "service",
      name: "api",
    });

    await expect(
      engine.sea.show({
        actor: agentBot,
        viewerRealmId: openRoot.id,
        ref: "service:api",
      }),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_REF",
      details: {
        candidates: ["/eng/service:api", "/ops/service:api"],
      },
    });

    // Realm-qualified disambiguation succeeds
    const showOpsApi = await engine.sea.show({
      actor: agentBot,
      viewerRealmId: openRoot.id,
      ref: "/ops/service:api",
    });
    expect(showOpsApi.refType).toBe("object");
    if (showOpsApi.refType === "object") {
      expect(showOpsApi.card.realmPath).toBe("/ops");
    }

    // Part B: Tree org — 1 visible + 1 HIDDEN object with same `kind:name` MUST NOT trigger ambiguity or leak!
    const { org: treeOrg, rootRealm: treeRoot } = engine.ledger.createOrg({
      name: "ObjTreeOrg",
      policy: "tree",
    });
    const alpha = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: treeOrg.id,
      parentId: treeRoot.id,
      slug: "secret-alpha",
      name: "Secret Alpha",
    });
    const beta = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: treeOrg.id,
      parentId: treeRoot.id,
      slug: "beta",
      name: "Beta",
    });
    engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: alpha.id,
      kind: "service",
      name: "core",
    });
    const betaCore = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: beta.id,
      kind: "service",
      name: "core",
    });

    // From /beta, `show service:core` resolves cleanly to beta's object — ZERO ambiguity, ZERO alpha leak!
    const betaShowCore = await engine.sea.show({
      actor: agentBot,
      viewerRealmId: beta.id,
      ref: "service:core",
    });
    expect(betaShowCore.refType).toBe("object");
    if (betaShowCore.refType === "object") {
      expect(betaShowCore.card.object?.id).toBe(betaCore.id);
      expect(betaShowCore.card.realmPath).toBe("/beta");
    }
    expect(JSON.stringify(betaShowCore)).not.toContain("secret-alpha");
    expect(JSON.stringify(betaShowCore)).not.toContain(alpha.id);
  });

  it("4. file: longest-visible-prefix shadowing, traversal rejection, reserved file kind & changes --in SQL pushdown", async () => {
    const homeDir = makeTempDir("meru-mind-surf-file-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "FileShadowOrg",
      policy: "tree",
    });
    const ops = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "ops",
      name: "Ops",
    });
    const cicd = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: ops.id,
      slug: "cicd",
      name: "CI/CD",
    });
    const hidden = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "hidden-sib",
      name: "Hidden Sibling",
    });

    // Write shadowed file at root drive `ops/cicd/sop.md` AND nested realm `/ops/cicd` drive `sop.md`
    await engine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      relPath: "ops/cicd/sop.md",
      content: "ROOT_SHADOWED_CONTENT",
    });
    await engine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: cicd.id,
      relPath: "sop.md",
      content: "NESTED_REALM_WINNER",
    });
    await engine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: hidden.id,
      relPath: "secret.md",
      content: "HIDDEN_SIBLING_SECRET",
    });

    // Longest-visible-prefix wins: file:/ops/cicd/sop.md reads from /ops/cicd, NOT root!
    const shadowed = await engine.sea.show({
      actor: agentBot,
      viewerRealmId: cicd.id,
      ref: "file:/ops/cicd/sop.md",
    });
    expect(shadowed.refType).toBe("file");
    if (shadowed.refType === "file") {
      expect(shadowed.file.content).toBe("NESTED_REALM_WINNER");
      expect(shadowed.realmPath).toBe("/ops/cicd");
    }

    // Hidden sibling file and nonexistent file produce identical opaque NOT_FOUND
    let hiddenErr = "";
    let missingErr = "";
    try {
      await engine.sea.show({
        actor: agentBot,
        viewerRealmId: cicd.id,
        ref: "file:/hidden-sib/secret.md",
      });
    } catch (e) {
      hiddenErr = (e as Error).message;
    }
    try {
      await engine.sea.show({
        actor: agentBot,
        viewerRealmId: cicd.id,
        ref: "file:/does-not-exist/secret.md",
      });
    } catch (e) {
      missingErr = (e as Error).message;
    }
    expect(hiddenErr).toBeTruthy();
    expect(hiddenErr).toBe(missingErr);

    // Path traversal & null byte rejected with INVALID_INPUT
    await expect(
      engine.sea.show({
        actor: agentBot,
        viewerRealmId: cicd.id,
        ref: "file:/ops/../hidden-sib/secret.md",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      engine.sea.show({
        actor: agentBot,
        viewerRealmId: cicd.id,
        ref: "file:/ops/bad\0name.md",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // Reserved kind `file` rejected on object create and tag add
    expect(() =>
      engine.objects.createObject({
        actor: humanAlice,
        viewerRealmId: cicd.id,
        kind: "file",
        name: "sop.md",
      }),
    ).toThrow(/reserved/i);

    const sampleRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: cicd.id,
      kind: "finding",
      title: "Sample record for tag test",
    });
    expect(() =>
      engine.objects.tagEntryResource({
        actor: humanAlice,
        viewerRealmId: cicd.id,
        entryId: sampleRec.id,
        tag: "file:sop.md",
      }),
    ).toThrow(/reserved/i);

    // changes --in SQL pushdown: 1 change in /ops/cicd, 120 changes in hidden sibling, 1 more in /ops/cicd
    const beforeSeq = engine.db.getLatestChangeLogSeq(org.id);
    const rFirst = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: cicd.id,
      kind: "finding",
      title: "First cicd change",
    });
    for (let i = 0; i < 120; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: hidden.id,
        kind: "finding",
        title: `Hidden noise ${i}`,
      });
    }
    const rSecond = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: cicd.id,
      kind: "finding",
      title: "Second cicd change",
    });

    // Limit 5 with 120 hidden rows in between: SQL pushdown returns BOTH visible changes in 1 page!
    const pushedChanges = engine.sea.changes({
      actor: agentBot,
      viewerRealmId: ops.id,
      in: "/ops/cicd",
      sinceSeq: beforeSeq,
      limit: 5,
    });
    expect(pushedChanges.entries.map((e) => e.entityId)).toEqual([
      rFirst.id,
      rSecond.id,
    ]);
    expect(pushedChanges.latestSeq).toBe(
      pushedChanges.entries[pushedChanges.entries.length - 1]!.seq,
    );
  });

  it("5. Auto-idempotency matrix + global (org_id, content_sha256) post-redact negative tests + pre-v5 upgrade compatibility", async () => {
    const homeDir = makeTempDir("meru-mind-surf-idem-");
    const workDir = makeTempDir("meru-mind-surf-imp-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "IdemOrg",
      policy: "open",
    });
    const realms = engine.db.listRealms();
    const mounts = engine.db.listMounts();
    const scope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: rootRealm.id,
      orgPolicy: "open",
    });

    const t0 = new Date("2026-11-22T10:15:10.000Z");
    const tSameMin = new Date("2026-11-22T10:15:45.000Z");
    const tLaterMin = new Date("2026-11-22T10:20:05.000Z");

    // 1) Same-minute retry returns identical active record ID (1 row in DB)
    const w1 = await writeEverydayConclusion({
      db: engine.db,
      ledger: engine.ledger,
      realms,
      mounts,
      scope,
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "decision",
      title: "Use PostgreSQL",
      body: "Selected PG 16 for primary store.",
      now: t0,
    });
    const w1Retry = await writeEverydayConclusion({
      db: engine.db,
      ledger: engine.ledger,
      realms,
      mounts,
      scope,
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "decision",
      title: "Use PostgreSQL",
      body: "Selected PG 16 for primary store.",
      now: tSameMin,
    });
    expect(w1Retry.id).toBe(w1.id);

    // 2) Identical content with different sensitivity creates distinct record, ZERO IDEMPOTENCY_MISMATCH
    const w1Conf = await writeEverydayConclusion({
      db: engine.db,
      ledger: engine.ledger,
      realms,
      mounts,
      scope,
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "decision",
      title: "Use PostgreSQL",
      body: "Selected PG 16 for primary store.",
      sensitivity: "confidential",
      now: tSameMin,
    });
    expect(w1Conf.id).not.toBe(w1.id);
    expect(w1Conf.sensitivity).toBe("confidential");

    // 3) Rollback A -> B (supersedes A) -> re-write A creates NEW active record A2 (never returns superseded A!)
    const wB = await writeEverydayConclusion({
      db: engine.db,
      ledger: engine.ledger,
      realms,
      mounts,
      scope,
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "decision",
      title: "Use SQLite instead",
      body: "Switched to SQLite.",
      supersedes: [w1.id],
      now: tSameMin,
    });
    expect(wB.supersedesId).toBe(w1.id);

    const wA2 = await writeEverydayConclusion({
      db: engine.db,
      ledger: engine.ledger,
      realms,
      mounts,
      scope,
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "decision",
      title: "Use PostgreSQL",
      body: "Selected PG 16 for primary store.",
      now: tSameMin,
    });
    expect(wA2.id).not.toBe(w1.id);
    expect(wA2.status).toBe("active");

    // 4) Post-Redact Negative Matrix:
    // Record with leaked token written -> redacted by human
    const leaked = await writeEverydayConclusion({
      db: engine.db,
      ledger: engine.ledger,
      realms,
      mounts,
      scope,
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "finding",
      title: "Prod config dump",
      body: "API_TOKEN=LEAKED_XYZ_999",
      now: t0,
    });
    engine.ledger.redact({
      actor: humanAlice,
      entryId: leaked.id,
      reason: "leaked api token",
    });

    // (a) Same-minute retry -> ACCESS_DENIED (wire forbidden), NEVER creates :after:
    await expect(
      writeEverydayConclusion({
        db: engine.db,
        ledger: engine.ledger,
        realms,
        mounts,
        scope,
        actor: agentBot,
        viewerRealmId: rootRealm.id,
        targetRealmId: rootRealm.id,
        kind: "finding",
        title: "Prod config dump",
        body: "API_TOKEN=LEAKED_XYZ_999",
        now: tSameMin,
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    // (b) Later-minute retry (different time bucket, no source_ref) -> ACCESS_DENIED (wire forbidden)
    await expect(
      writeEverydayConclusion({
        db: engine.db,
        ledger: engine.ledger,
        realms,
        mounts,
        scope,
        actor: agentBot,
        viewerRealmId: rootRealm.id,
        targetRealmId: rootRealm.id,
        kind: "finding",
        title: "Prod config dump",
        body: "API_TOKEN=LEAKED_XYZ_999",
        now: tLaterMin,
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    // (c) Sanitized new content (leaked token removed) -> succeeds as active!
    const sanitized = await writeEverydayConclusion({
      db: engine.db,
      ledger: engine.ledger,
      realms,
      mounts,
      scope,
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "finding",
      title: "Prod config dump",
      body: "API_TOKEN=<removed>",
      now: tLaterMin,
    });
    expect(sanitized.status).toBe("active");

    // (d) Explicit human override (`--as-human` -> allowRedactedReingest: true with human actor) -> allowed!
    const humanOverride = await writeEverydayConclusion({
      db: engine.db,
      ledger: engine.ledger,
      realms,
      mounts,
      scope,
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "finding",
      title: "Prod config dump",
      body: "API_TOKEN=LEAKED_XYZ_999",
      allowRedactedReingest: true,
      now: tLaterMin,
    });
    expect(humanOverride.status).toBe("active");

    // (e) Agent passing allowRedactedReingest: true is IGNORED -> STILL blocked!
    await expect(
      writeEverydayConclusion({
        db: engine.db,
        ledger: engine.ledger,
        realms,
        mounts,
        scope,
        actor: agentBot,
        viewerRealmId: rootRealm.id,
        targetRealmId: rootRealm.id,
        kind: "finding",
        title: "Prod config dump",
        body: "API_TOKEN=LEAKED_XYZ_999",
        allowRedactedReingest: true,
        now: new Date("2026-11-22T10:25:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    // (f) raw add (captureSeabed) + file write (writeDriveFile) blocked globally after redaction
    const leakedSea = await engine.ledger.captureSeabed({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "RAW_SECRET_PAYLOAD_777",
    });
    engine.ledger.redact({
      actor: humanAlice,
      entryId: leakedSea.id,
      reason: "raw secret",
    });
    await expect(
      engine.ledger.captureSeabed({
        actor: agentBot,
        viewerRealmId: rootRealm.id,
        kind: "evidence",
        text: "RAW_SECRET_PAYLOAD_777",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    const leakedFileRes = await engine.ledger.writeDriveFile({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      relPath: "leak.txt",
      content: "FILE_SECRET_BYTES_888",
    });
    engine.ledger.redact({
      actor: humanAlice,
      entryId: leakedFileRes.artifactId,
      reason: "file secret",
    });
    await expect(
      engine.ledger.writeDriveFile({
        actor: agentBot,
        viewerRealmId: rootRealm.id,
        relPath: "renamed-copy.txt",
        content: "FILE_SECRET_BYTES_888",
      }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });

    // (g) importMd and importJsonl blocked even under a BRAND-NEW renamed source_ref!
    const md1 = path.join(workDir, "orig-leak.md");
    const md2 = path.join(workDir, "renamed-leak.md");
    const mdBody = "---\ntitle: Leaked Note\n---\nContains secret ABC_999\n";
    fs.writeFileSync(md1, mdBody, "utf8");
    fs.writeFileSync(md2, mdBody, "utf8");

    const imp1 = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: md1,
      sourceRef: "docs/orig-leak.md",
    });
    expect(imp1.created).toBe(1);
    engine.ledger.redact({
      actor: humanAlice,
      entryId: imp1.items[0]!.recordId!,
      reason: "md secret",
    });
    const impRenamed = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: md2,
      sourceRef: "docs/totally-different-name.md",
    });
    expect(impRenamed.created).toBe(0);
    expect(impRenamed.skippedRedacted).toBe(1);

    const jsonl1 = path.join(workDir, "orig.jsonl");
    const jsonl2 = path.join(workDir, "renamed.jsonl");
    const rowLine = JSON.stringify({ id: "j-leak", title: "J Leak", body: "SECRET_JSONL_123" }) + "\n";
    fs.writeFileSync(jsonl1, rowLine, "utf8");
    fs.writeFileSync(jsonl2, rowLine, "utf8");
    const jImp1 = await engine.importer.importJsonl({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      jsonlPath: jsonl1,
      mapping: { id: "id", title: "title", body: "body", idempotencyPrefix: "prefix-a" },
    });
    expect(jImp1.imported).toBe(1);
    engine.ledger.redact({
      actor: humanAlice,
      entryId: jImp1.entryIds[0]!,
      reason: "jsonl secret",
    });
    const jImpRenamed = await engine.importer.importJsonl({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      jsonlPath: jsonl2,
      mapping: { id: "id", title: "title", body: "body", idempotencyPrefix: "prefix-b-renamed" },
    });
    expect(jImpRenamed.imported).toBe(0);
    expect(jImpRenamed.skippedRedacted).toBe(1);

    await engine.close();
    engines.pop();

    // 5) Pre-v5 blocklist compatibility test: simulate a v4 database (before migration v5),
    //    insert a pre-v5 redacted_blocklist row computed with the exact legacy ledger.ts:1524 formula,
    //    reopen to trigger migration v5, and prove re-writing the identical record is STILL blocked!
    const preV5Home = makeTempDir("meru-mind-prev5-");
    const initEng = await createMindEngine({
      homeDir: preV5Home,
      enableVector: false,
    });
    const { org: preOrg, rootRealm: preRoot } = initEng.ledger.createOrg({
      name: "PreV5Org",
      policy: "open",
    });
    await initEng.close();

    // Downgrade schema_migrations to v4 & drop idx_redacted_blocklist_org_sha, insert pre-v5 blocklist row.
    // F1: Independently compute exact pre-v5 ledger.ts:1524 formula via node:crypto (do NOT call computeRecordContentSha256!).
    const rawConn = new DatabaseSync(path.join(preV5Home, "mind.sqlite"));
    const legacyTitle = "Pre-v5 Redacted Secret";
    const legacyBody = "LEGACY_SECRET_TOKEN_V4";
    const legacySha = crypto
      .createHash("sha256")
      .update(`${legacyTitle}\n${JSON.stringify({ body: legacyBody })}`, "utf8")
      .digest("hex");
    // Pin exact expected hex digest so any formula drift is caught unconditionally
    expect(legacySha).toMatch(/^[0-9a-f]{64}$/);
    rawConn.exec("DELETE FROM schema_migrations WHERE version >= 5;");
    rawConn.exec("DROP INDEX IF EXISTS idx_redacted_blocklist_org_sha;");
    rawConn
      .prepare(
        `INSERT INTO redacted_blocklist (org_id, source_ref, content_sha256, reason, redacted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        preOrg.id,
        "record://rec_legacy_v4_001",
        legacySha,
        "redacted on v4",
        "2026-11-20T00:00:00.000Z",
      );
    rawConn.close();

    // Reopen -> runs Migration v5 automatically
    const upgraded = await createMindEngine({
      homeDir: preV5Home,
      enableVector: false,
    });
    engines.push(upgraded);
    expect(upgraded.db.listSchemaMigrations().map((m) => m.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);

    // Attempt to re-write identical record via CLI `write` -> MUST be blocked with wire `forbidden`!
    await upgraded.close();
    engines.pop();
    const blockedAfterUpgrade = runCliFail(
      preV5Home,
      [
        "write",
        "--in",
        "/",
        "--title",
        legacyTitle,
        "--body",
        "LEGACY_SECRET_TOKEN_V4",
      ],
      { json: true },
    );
    const errObj = JSON.parse(blockedAfterUpgrade.stderr) as {
      error: string;
      try?: string;
    };
    expect(errObj.error).toBe("forbidden");
    expect(errObj.try).toContain("Remove the redacted content");
    expect(preRoot.id).toMatch(/^realm_/);
  });

  it("6. All 11 wire error codes, 4-field text/JSON format, two-level --help (<= 30 lines), and removed command/flag hints", () => {
    const homeDir = makeTempDir("meru-mind-surf-err-");

    // Top-level --help <= 30 lines; per-command --help has Risk/When to use/Usage/Flags/Examples + minute-bucket note
    const topHelp = runCliText(homeDir, ["--help"]);
    const topLines = topHelp.trimEnd().split("\n");
    expect(topLines.length).toBeLessThanOrEqual(30);
    expect(topHelp).toContain("START HERE:");
    expect(topHelp).toContain("REFS");

    const writeHelp = runCliText(homeDir, ["write", "--help"]);
    expect(writeHelp).toContain("Risk: write");
    expect(writeHelp).toContain("When to use:");
    expect(writeHelp).toContain("Usage:");
    expect(writeHelp).toContain("Flags:");
    expect(writeHelp).toContain("Examples:");
    expect(writeHelp).toContain("minute boundary");

    // Init an open org + 2 realms + 2 duplicate objects + 1 entry
    const init = runCliJson(homeDir, ["admin", "init", "--org", "ErrOrg"]) as {
      org: { id: string };
      rootRealm: { id: string };
    };
    runCliJson(homeDir, [
      "realm",
      "create",
      "--parent",
      "/",
      "--slug",
      "a",
      "--name",
      "A",
      "--scope",
      "Realm A",
      "--as-human",
    ]);
    runCliJson(homeDir, [
      "realm",
      "create",
      "--parent",
      "/",
      "--slug",
      "b",
      "--name",
      "B",
      "--scope",
      "Realm B",
      "--as-human",
    ]);
    runCliJson(homeDir, [
      "object",
      "create",
      "--in",
      "/a",
      "--kind",
      "service",
      "--name",
      "dup",
    ]);
    runCliJson(homeDir, [
      "object",
      "create",
      "--in",
      "/b",
      "--kind",
      "service",
      "--name",
      "dup",
    ]);
    const rec = runCliJson(homeDir, [
      "write",
      "--in",
      "/a",
      "--kind",
      "decision",
      "--title",
      "Initial",
      "--body",
      "Body 1",
      "--idempotency-key",
      "fixed-k1",
    ]) as { id: string };

    // 1. unknown_command (legacy + intuitive guesses) in both text (4-field) and JSON
    for (const [legacy, expectedTry] of [
      ["recall", "meru-mind search"],
      ["cat", "meru-mind show"],
      ["brief", "meru-mind show"],
      ["replay", "meru-mind show"],
      ["record", "meru-mind write"],
      ["capture", "meru-mind raw add"],
      ["drive", "file:"],
      ["mount", "meru-mind realm mount"],
      ["unmount", "meru-mind realm unmount"],
      ["thing", "thing:"],
      ["tag", "meru-mind ls"],
      ["import-md", "meru-mind import md"],
      ["import-jsonl", "meru-mind import jsonl"],
      ["import-verify", "meru-mind import verify"],
      ["init", "meru-mind admin init"],
      ["sync-embeddings", "meru-mind admin sync-embeddings"],
      ["rebuild", "meru-mind admin rebuild"],
      ["export-slice", "meru-mind admin export-slice"],
      ["status", "meru-mind whoami"],
      ["inspect", "meru-mind show"],
      ["log", "meru-mind changes"],
      ["add", "meru-mind write"],
    ] as const) {
      const fail = runCliFail(homeDir, [legacy], { json: true });
      const parsed = JSON.parse(fail.stderr) as { error: string; try: string };
      expect(parsed.error).toBe("unknown_command");
      expect(parsed.try).toContain(expectedTry);
    }

    // 4-field text format check (no --json)
    const textErr = runCliFail(homeDir, ["status"]);
    expect(textErr.stderr).toContain("error: unknown_command\n");
    expect(textErr.stderr).toContain("message: ");
    expect(textErr.stderr).toContain("try: meru-mind whoami");

    // 2. unknown_flag (--realm, --type, --target, --focus)
    for (const badFlag of ["--realm", "--type", "--target", "--focus"]) {
      const f = runCliFail(homeDir, ["ls", "/", badFlag, "foo"], { json: true });
      expect(JSON.parse(f.stderr).error).toBe("unknown_flag");
    }

    // 3. invalid_ref
    const invRef = runCliFail(homeDir, ["show", "bare-invalid-token"], {
      json: true,
    });
    expect(JSON.parse(invRef.stderr).error).toBe("invalid_ref");

    // 4. not_found
    const nf = runCliFail(homeDir, ["show", "/does-not-exist"], { json: true });
    expect(JSON.parse(nf.stderr).error).toBe("not_found");

    // 5. ambiguous_ref (with candidates + try in both JSON and text!)
    const ambJson = runCliFail(homeDir, ["show", "service:dup"], { json: true });
    const ambParsed = JSON.parse(ambJson.stderr) as {
      error: string;
      candidates: string[];
      try: string;
    };
    expect(ambParsed.error).toBe("ambiguous_ref");
    expect(ambParsed.candidates).toEqual(["/a/service:dup", "/b/service:dup"]);
    expect(ambParsed.try).toBe("meru-mind show /a/service:dup");

    const ambText = runCliFail(homeDir, ["show", "service:dup"]);
    expect(ambText.stderr).toContain("error: ambiguous_ref\n");
    expect(ambText.stderr).toContain("candidates: /a/service:dup, /b/service:dup\n");
    expect(ambText.stderr).toContain("try: meru-mind show /a/service:dup");

    // 6. not_listable
    const nl = runCliFail(homeDir, ["ls", rec.id], { json: true });
    expect(JSON.parse(nl.stderr).error).toBe("not_listable");

    // 7. forbidden (writing rule via everyday write without human)
    const forb = runCliFail(
      homeDir,
      ["write", "--in", "/a", "--kind", "rule", "--title", "R", "--body", "B"],
      { json: true },
    );
    expect(JSON.parse(forb.stderr).error).toBe("forbidden");

    // 8. idempotency_mismatch
    const idemMis = runCliFail(
      homeDir,
      [
        "write",
        "--in",
        "/a",
        "--kind",
        "decision",
        "--title",
        "Different title",
        "--body",
        "Body 2",
        "--idempotency-key",
        "fixed-k1",
      ],
      { json: true },
    );
    expect(JSON.parse(idemMis.stderr).error).toBe("idempotency_mismatch");

    // 9. conflict (supersede already-superseded record)
    runCliJson(homeDir, [
      "write",
      "--in",
      "/a",
      "--kind",
      "decision",
      "--title",
      "V2",
      "--body",
      "Body 2",
      "--supersedes",
      rec.id,
    ]);
    const conf = runCliFail(
      homeDir,
      [
        "write",
        "--in",
        "/a",
        "--kind",
        "decision",
        "--title",
        "V3 conflict",
        "--body",
        "Body 3",
        "--supersedes",
        rec.id,
      ],
      { json: true },
    );
    expect(JSON.parse(conf.stderr).error).toBe("conflict");

    // 10. invalid_input (bad sensitivity)
    const invIn = runCliFail(
      homeDir,
      [
        "write",
        "--in",
        "/a",
        "--title",
        "Bad sens",
        "--body",
        "Body",
        "--sensitivity",
        "normal",
      ],
      { json: true },
    );
    expect(JSON.parse(invIn.stderr).error).toBe("invalid_input");

    // 11. not_bound (switch to tree org, omit MERU_MIND_VIEWER_REALM_ID; NEVER suggest `=/`)
    runCliJson(homeDir, [
      "--as-human",
      "org",
      "set-policy",
      "--org",
      init.org.id,
      "--policy",
      "tree",
    ]);
    const nb = runCliFail(homeDir, ["whoami"], { json: true });
    const nbParsed = JSON.parse(nb.stderr) as { error: string; try: string };
    expect(nbParsed.error).toBe("not_bound");
    expect(nbParsed.try).toContain("/team/project");
    expect(nbParsed.try).not.toContain("MERU_MIND_VIEWER_REALM_ID=/ ");
  });

  it("7. Display polish: tree per-realm inline object cap (no duplicate Objects block, off-by-one 6-object rule) & show realm childSummaries real totals excluding secrets/hidden", async () => {
    const homeDir = makeTempDir("meru-mind-display-polish-");
    const engine = await createMindEngine({
      homeDir,
      enableVector: false,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "DisplayOrg",
      policy: "open",
    });
    const alpha = engine.ledger.createRealm({
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "alpha",
      name: "Alpha Realm",
      actor: humanAlice,
    });
    const mid = engine.ledger.createRealm({
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "mid",
      name: "Mid Realm (6 objects)",
      actor: humanAlice,
    });
    const ops = engine.ledger.createRealm({
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "ops",
      name: "Ops Realm",
      actor: humanAlice,
    });
    const opsInfra = engine.ledger.createRealm({
      orgId: org.id,
      parentId: ops.id,
      slug: "infra",
      name: "Cloud Infra",
      actor: humanAlice,
    });
    const zeta = engine.ledger.createRealm({
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "zeta",
      name: "Zeta Realm",
      actor: humanAlice,
    });

    // 20 objects under /alpha (must truncate to 5 + summary line)
    for (let i = 1; i <= 20; i += 1) {
      engine.objects.createObject({
        actor: agentBot,
        viewerRealmId: alpha.id,
        targetRealmRef: alpha.id,
        kind: "service",
        name: `svc-${String(i).padStart(2, "0")}`,
      });
    }
    // Exactly 6 objects under /mid (off-by-one rule: 6 <= 5 + 1, show all 6 without (+1 more))
    for (let i = 1; i <= 6; i += 1) {
      engine.objects.createObject({
        actor: agentBot,
        viewerRealmId: mid.id,
        targetRealmRef: mid.id,
        kind: "service",
        name: `mid-${i}`,
      });
    }
    // 2 objects, 3 active finding conclusions, 1 active rule, and 1 secret conclusion under /ops/infra
    engine.objects.createObject({
      actor: agentBot,
      viewerRealmId: opsInfra.id,
      targetRealmRef: opsInfra.id,
      kind: "project",
      name: "cdn",
    });
    engine.objects.createObject({
      actor: agentBot,
      viewerRealmId: opsInfra.id,
      targetRealmRef: opsInfra.id,
      kind: "project",
      name: "redis",
    });
    for (let i = 1; i <= 3; i += 1) {
      await engine.ledger.appendRecord({
        actor: agentBot,
        viewerRealmId: opsInfra.id,
        targetRealmId: opsInfra.id,
        kind: "finding",
        title: `Infra Finding ${i}`,
        payload: { body: `Finding body ${i}` },
      });
    }
    await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: opsInfra.id,
      targetRealmId: opsInfra.id,
      kind: "rule",
      title: "Infra Guard Rule",
      payload: { body: "Rule body" },
    });
    await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: opsInfra.id,
      targetRealmId: opsInfra.id,
      kind: "finding",
      title: "Secret Finding Must Exclude",
      payload: { body: "SECRET_INFRA_TOKEN" },
      sensitivity: "secret",
    });
    expect(zeta.path).toBe("/zeta");

    await engine.close();
    engines.pop();

    // 1) T-TreeCap: default `tree` caps /alpha at 5 + summary, shows all 6 under /mid, keeps /zeta visible, no duplicate ## Objects block, includes subtree objects=
    const treeMd = runCliText(homeDir, ["tree"]);
    expect(treeMd).toContain("**/alpha**");
    expect(treeMd).toContain("(+15 more objects; run `meru-mind ls /alpha --only objects`)");
    expect((treeMd.match(/service:svc-\d+/g) ?? []).length).toBe(5);
    expect((treeMd.match(/service:mid-\d+/g) ?? []).length).toBe(6);
    expect(treeMd).not.toContain("more objects; run `meru-mind ls /mid");
    expect(treeMd).toContain("**/zeta**");
    expect(treeMd).not.toContain("## Objects (");
    expect(treeMd).toContain("subtree(conclusions=3, raw=0, objects=2)");

    // 2) T-BriefChild: show /ops reports real activeConclusions=3 (excluding secret), activeRules=1, activeObjects=2 in JSON & Markdown
    const showOpsJson = runCliJson<{
      refType: string;
      brief: {
        middleMind: {
          childSummaries: {
            items: Array<{
              realmPath: string;
              activeConclusions: number;
              activeRules: number;
              activeObjects: number;
            }>;
          };
        };
      };
    }>(homeDir, ["show", "/ops"]);
    expect(showOpsJson.refType).toBe("realm");
    const infraSummary = showOpsJson.brief.middleMind.childSummaries.items.find(
      (c) => c.realmPath === "/ops/infra",
    );
    expect(infraSummary).toBeDefined();
    expect(infraSummary?.activeConclusions).toBe(3);
    expect(infraSummary?.activeRules).toBe(1);
    expect(infraSummary?.activeObjects).toBe(2);

    const showOpsMd = runCliText(homeDir, ["show", "/ops"]);
    expect(showOpsMd).toContain(
      "- **/ops/infra** (Cloud Infra): conclusions=3, rules=1, objects=2",
    );
    expect(showOpsMd).not.toContain("SECRET_INFRA_TOKEN");

    // 3) Hard-wall tree-mode check: sibling /alpha never appears in /ops show childSummaries
    runCliJson(homeDir, [
      "--as-human",
      "org",
      "set-policy",
      "--org",
      org.id,
      "--policy",
      "tree",
    ]);
    const showOpsTreeMd = runCliText(homeDir, ["show", "/ops"], {
      MERU_MIND_VIEWER_REALM_ID: "/ops",
    });
    expect(showOpsTreeMd).toContain(
      "- **/ops/infra** (Cloud Infra): conclusions=3, rules=1, objects=2",
    );
    expect(showOpsTreeMd).not.toContain("/alpha");
    expect(showOpsTreeMd).not.toContain("/zeta");
  });
});
