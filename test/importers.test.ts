import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  restoreWritablePermissions,
  type Actor,
  type EmbedderPort,
  type JsonlMappingConfig,
  type MindEngine,
} from "../src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliBin = path.join(repoRoot, "dist", "cli.js");

const tempDirs: string[] = [];
const engines: MindEngine[] = [];

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

const humanAlice: Actor = { id: "alice", kind: "human" };
const agentBot: Actor = { id: "importer-bot", kind: "agent", family: "gemini" };

function runCliRaw(
  homeDir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): string {
  return execFileSync(process.execPath, [cliBin, "--home", homeDir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

function runCliJson(
  homeDir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): unknown {
  const out = runCliRaw(homeDir, ["--json", ...args], extraEnv);
  return JSON.parse(out.trim()) as unknown;
}

describe("Slice 2a: Generic Markdown (import-md) and JSONL (import-jsonl) importers", () => {
  it("1. import-md defaults to confirmedByHuman=false and sets confirmedByHuman=true ONLY with CLI --as-human", () => {
    const homeDir = makeTempDir("meru-mind-imp-human-");
    const docsDir = makeTempDir("meru-mind-imp-docs-");

    const init = runCliJson(homeDir, ["admin", "init", "--org", "ImportOrg"]) as {
      rootRealm: { id: string };
    };

    const docA = path.join(docsDir, "agent-note.md");
    fs.writeFileSync(
      docA,
      `---\ntitle: Agent Imported Spec\nupdated_at: 2026-08-01T10:00:00Z\n---\n\n## Summary\nAutomated import note.\n`,
      "utf8",
    );

    const docB = path.join(docsDir, "human-note.md");
    fs.writeFileSync(
      docB,
      `---\ntitle: Human Verified Spec\nupdated_at: 2026-08-02T10:00:00Z\n---\n\n## Summary\nHuman verified import.\n`,
      "utf8",
    );

    // Default CLI import md -> agent, confirmedByHuman=false
    const resAgent = runCliJson(homeDir, [
      "import",
      "md",
      docA,
      "--in",
      "/",
      "--source-ref",
      "docs/agent-note.md",
    ]) as { created: number; items: Array<{ recordId: string }> };
    expect(resAgent.created).toBe(1);
    const recAgent = runCliJson(homeDir, [
      "show",
      resAgent.items[0]!.recordId,
    ]) as { entry: { record: { authorKind: string; confirmedByHuman: boolean } } };
    expect(recAgent.entry.record.authorKind).toBe("agent");
    expect(recAgent.entry.record.confirmedByHuman).toBe(false);

    // Explicit --as-human -> human, confirmedByHuman=true
    const resHuman = runCliJson(homeDir, [
      "--as-human",
      "import",
      "md",
      docB,
      "--in",
      "/",
      "--source-ref",
      "docs/human-note.md",
    ]) as { created: number; items: Array<{ recordId: string }> };
    expect(resHuman.created).toBe(1);
    const recHuman = runCliJson(homeDir, [
      "show",
      resHuman.items[0]!.recordId,
    ]) as { entry: { record: { authorKind: string; confirmedByHuman: boolean } } };
    expect(recHuman.entry.record.authorKind).toBe("human");
    expect(recHuman.entry.record.confirmedByHuman).toBe(true);

    // Default Markdown output (without --json) is readable
    const mdOut = runCliRaw(homeDir, [
      "import",
      "md",
      docA,
      "--in",
      "/",
      "--source-ref",
      "docs/agent-note.md",
    ]);
    expect(mdOut).toContain("# import-md Summary");
    expect(mdOut).toContain("Skipped (unchanged): 1");
  });

  it("2. import-md unchanged re-run writes nothing, v1->v2 supersedes, and v1->v2->v1 rollback succeeds without IDEMPOTENCY_MISMATCH", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-imp-rollback-"),
      enableVector: false,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "RollbackOrg",
      policy: "open",
    });

    const docsDir = makeTempDir("meru-mind-imp-md-");
    const file = path.join(docsDir, "policy.md");

    const v1Content = `---\ntitle: Cache Policy\nupdated_at: 2026-09-01T00:00:00Z\n---\n\n## Summary\nUse TTL 60s.\n`;
    const v2Content = `---\ntitle: Cache Policy\nupdated_at: 2026-09-02T00:00:00Z\n---\n\n## Summary\nUse TTL 300s.\n`;

    // Step 1: initial import v1
    fs.writeFileSync(file, v1Content, "utf8");
    const r1 = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: file,
      sourceRef: "docs/policy.md",
    });
    expect(r1.created).toBe(1);
    const v1Id = r1.items[0]!.recordId!;
    const seqAfterV1 = engine.db.getLatestChangeLogSeq(org.id);

    // Step 2: unchanged re-run -> zero writes, zero change_log appends
    const r1Repeat = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: file,
      sourceRef: "docs/policy.md",
    });
    expect(r1Repeat.created).toBe(0);
    expect(r1Repeat.superseded).toBe(0);
    expect(r1Repeat.skippedUnchanged).toBe(1);
    expect(engine.db.getLatestChangeLogSeq(org.id)).toBe(seqAfterV1);

    // Step 3: edit to v2 -> supersedes v1
    fs.writeFileSync(file, v2Content, "utf8");
    const r2 = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: file,
      sourceRef: "docs/policy.md",
    });
    expect(r2.superseded).toBe(1);
    const v2Id = r2.items[0]!.recordId!;
    expect(r2.items[0]!.supersedesId).toBe(v1Id);
    expect(engine.db.getRecord(v1Id)!.status).toBe("superseded");
    expect(engine.db.getRecord(v2Id)!.status).toBe("active");

    // Step 4: rollback file back to EXACT v1 content -> MUST create new v3 superseding v2, NO IDEMPOTENCY_MISMATCH
    fs.writeFileSync(file, v1Content, "utf8");
    const r3 = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: file,
      sourceRef: "docs/policy.md",
    });
    expect(r3.superseded).toBe(1);
    expect(r3.created).toBe(0);
    const v3Id = r3.items[0]!.recordId!;
    expect(v3Id).not.toBe(v1Id);
    expect(v3Id).not.toBe(v2Id);
    expect(r3.items[0]!.supersedesId).toBe(v2Id);

    // Strictly ONE active head (v3) and intact 3-node supersede chain v1 -> v2 -> v3
    const activeRecords = engine.db.listRecords({
      realmIds: [rootRealm.id],
      includeSuperseded: false,
    });
    expect(activeRecords.items.map((r) => r.id)).toEqual([v3Id]);

    const chain = engine.ledger.getSupersedeChain({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      recordId: v3Id,
    });
    expect(chain.nodes.map((c) => c.id)).toEqual([v1Id, v2Id, v3Id]);
  });

  it("3. import-md in open mode reassigning a file to another realm supersedes old realm head (#21 P2)", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-imp-move-"),
      enableVector: false,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "MoveOrg",
      policy: "open",
    });
    const alpha = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "alpha",
      name: "Alpha",
    });
    const beta = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "beta",
      name: "Beta",
    });

    const docsDir = makeTempDir("meru-mind-imp-move-docs-");
    const file = path.join(docsDir, "runbook.md");
    fs.writeFileSync(
      file,
      `# Deployment Runbook\n\n## Summary\nStandard deployment checklist.\n`,
      "utf8",
    );

    // Import into /alpha first
    const rAlpha = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: alpha.id,
      targetRealmRef: "/alpha",
      inputPath: file,
      sourceRef: "runbooks/deploy.md",
    });
    expect(rAlpha.created).toBe(1);
    const idAlpha = rAlpha.items[0]!.recordId!;
    expect(engine.db.getRecord(idAlpha)!.realmId).toBe(alpha.id);

    // Re-import SAME file (even unchanged content) reassigned to /beta in open mode
    const rBeta = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: beta.id,
      targetRealmRef: "/beta",
      inputPath: file,
      sourceRef: "runbooks/deploy.md",
    });
    expect(rBeta.superseded).toBe(1);
    const idBeta = rBeta.items[0]!.recordId!;
    expect(rBeta.items[0]!.supersedesId).toBe(idAlpha);

    // Old realm head is superseded; strictly ONE active record in org (now in /beta)
    expect(engine.db.getRecord(idAlpha)!.status).toBe("superseded");
    expect(engine.db.getRecord(idAlpha)!.supersededById).toBe(idBeta);
    expect(engine.db.getRecord(idBeta)!.status).toBe("active");
    expect(engine.db.getRecord(idBeta)!.realmId).toBe(beta.id);

    const allActive = engine.db.listRecords({
      realmIds: [rootRealm.id, alpha.id, beta.id],
      includeSuperseded: false,
    });
    expect(allActive.items.map((r) => r.id)).toEqual([idBeta]);
  });

  it("4. import-md enforces redacted_blocklist on old SHA-256 while allowing sanitized new SHA-256, and NEVER uses filesystem mtime", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-imp-block-"),
      enableVector: false,
    });
    engines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({
      name: "BlockOrg",
      policy: "open",
    });

    const docsDir = makeTempDir("meru-mind-imp-block-docs-");
    const leakFile = path.join(docsDir, "credentials.md");
    const dirtyMd = `# Service Config\n\nTemporary token: DEMO_LEAK_TOKEN_777\n`;
    const cleanMd = `# Service Config\n\nUse runtime secret vault injection.\n`;

    // Set mtime to year 2010 to prove filesystem mtime is strictly ignored
    fs.writeFileSync(leakFile, dirtyMd, "utf8");
    const ancientDate = new Date("2010-01-01T00:00:00.000Z");
    fs.utimesSync(leakFile, ancientDate, ancientDate);

    const r1 = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: leakFile,
      sourceRef: "docs/credentials.md",
    });
    expect(r1.created).toBe(1);
    const dirtyId = r1.items[0]!.recordId!;
    const dirtyRec = engine.db.getRecord(dirtyId)!;
    // Undated Markdown file MUST persist occurredAt === null (NEVER mtime and NEVER fabricated import time!)
    expect(dirtyRec.occurredAt).toBeNull();
    expect(r1.undatedCount).toBe(1);

    // Human redacts the dirty imported record -> populates redacted_blocklist with (org, source_ref, contentSha256)
    engine.ledger.redact({
      actor: humanAlice,
      entryId: dirtyId,
      reason: "token leak",
    });

    // Re-importing the exact dirty file MUST be blocked
    const rBlocked = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: leakFile,
      sourceRef: "docs/credentials.md",
    });
    expect(rBlocked.skippedRedacted).toBe(1);
    expect(rBlocked.created).toBe(0);

    // Sanitizing the file changes SHA-256 -> re-import succeeds cleanly!
    fs.writeFileSync(leakFile, cleanMd, "utf8");
    const rClean = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: leakFile,
      sourceRef: "docs/credentials.md",
    });
    expect(rClean.created).toBe(1);
    expect(rClean.skippedRedacted).toBe(0);

    // Declared frontmatter timestamp IS honored
    const datedFile = path.join(docsDir, "dated.md");
    fs.writeFileSync(
      datedFile,
      `---\ntitle: Dated Architecture Note\nvalid_from: 2025-04-12\n---\n\n## Summary\nExplicit valid_from date.\n`,
      "utf8",
    );
    fs.utimesSync(datedFile, ancientDate, ancientDate);
    const rDated = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: datedFile,
      sourceRef: "docs/dated.md",
    });
    expect(rDated.created).toBe(1);
    expect(engine.db.getRecord(rDated.items[0]!.recordId!)!.occurredAt).toBe(
      "2025-04-12T00:00:00.000Z",
    );
  });

  it("5. import-jsonl sorts out-of-order rows by occurred_at, handles open cross-realm supersedes vs tree degradation count, extractFields, skipSecret, blocklist & syncEmbeddings", async () => {
    const mockEmbedder: EmbedderPort = {
      dimensions: 4,
      configured: true,
      async embed() {
        return new Float32Array([1, 0, 0, 0]);
      },
      async embedBatch(texts) {
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    };

    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-imp-jsonl-open-"),
      embedder: mockEmbedder,
      vectorDimensions: 4,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "JsonlOpenOrg",
      policy: "open",
    });
    const alpha = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "alpha",
      name: "Alpha",
    });
    const beta = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "beta",
      name: "Beta",
    });

    const objApi = engine.objects.createObject({
      actor: agentBot,
      viewerRealmId: alpha.id,
      kind: "service",
      name: "api",
    });

    const workDir = makeTempDir("meru-mind-imp-jsonl-files-");
    const jsonlPath = path.join(workDir, "events.jsonl");

    // Deliberately OUT OF ORDER: ev-2 (later, supersedes ev-1 across realms) comes BEFORE ev-1!
    const rows = [
      {
        uid: "ev-2",
        type: "dec",
        headline: "Move queue to partition v2",
        summary: "Updated partition strategy",
        ts: "2026-07-02T10:00:00Z",
        area: "beta_team",
        replaces: "ev-1",
        objects: ["service:api"],
        tags: ["svc:queue"],
        priority: "high",
        noisyRawDump: "SHOULD_BE_DROPPED_BY_EXTRACT_FIELDS",
      },
      {
        uid: "ev-1",
        type: "dec",
        headline: "Use queue partition v1",
        summary: "Initial partition strategy",
        ts: "2026-07-01T10:00:00Z",
        area: "alpha_team",
        objects: ["service:api"],
        tags: ["svc:queue"],
        priority: "medium",
        noisyRawDump: "SHOULD_BE_DROPPED_BY_EXTRACT_FIELDS",
      },
      {
        uid: "ev-secret",
        type: "note",
        headline: "Top secret token",
        summary: "Do not import",
        ts: "2026-07-03T10:00:00Z",
        area: "alpha_team",
        level: "secret",
      },
    ];
    fs.writeFileSync(
      jsonlPath,
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const mapping: JsonlMappingConfig = {
      id: "uid",
      kind: "type",
      kindMap: { dec: "decision", note: "claim" },
      defaultKind: "claim",
      title: "headline",
      body: "summary",
      occurredAt: "ts",
      realmPath: "area",
      realmMap: {
        alpha_team: "/alpha",
        beta_team: "/beta",
      },
      objectRefs: "objects",
      resourceTags: "tags",
      supersedes: "replaces",
      sensitivity: "level",
      skipSecret: true,
      extractFields: ["priority"],
    };

    const res = await engine.importer.importJsonl({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      jsonlPath,
      mapping,
      syncEmbeddings: true,
    });

    expect(res.totalRows).toBe(3);
    expect(res.imported).toBe(2);
    expect(res.superseded).toBe(1);
    expect(res.skippedSecret).toBe(1);
    expect(res.skippedRedacted).toBe(0);
    expect(res.treeDegradedCrossRealmSupersedes).toBe(0);
    expect(res.embeddingsSynced?.indexed).toBe(2);

    const rec1 = engine.db.getRecord(res.idMap["ev-1"]!)!;
    const rec2 = engine.db.getRecord(res.idMap["ev-2"]!)!;
    expect(rec1.realmId).toBe(alpha.id);
    expect(rec2.realmId).toBe(beta.id);
    // Open mode cross-realm supersede succeeded atomically (no dual-active!)
    expect(rec1.status).toBe("superseded");
    expect(rec1.supersededById).toBe(rec2.id);
    expect(rec2.status).toBe("active");
    expect(rec2.supersedesId).toBe(rec1.id);
    // extractFields kept `priority` and dropped `noisyRawDump`
    expect(rec2.payload.priority).toBe("high");
    expect(rec2.payload.noisyRawDump).toBeUndefined();
    expect(engine.db.listObjectIdsForEntry(rec2.id, org.id)).toEqual([
      objApi.id,
    ]);
    expect(engine.db.listResourceTagsForEntry(rec2.id, org.id)).toEqual([
      "svc:queue",
    ]);

    // Re-running exact same JSONL is cleanly idempotent (zero errors, same IDs)
    const rerun = await engine.importer.importJsonl({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      jsonlPath,
      mapping,
    });
    expect(rerun.idMap["ev-1"]).toBe(rec1.id);
    expect(rerun.idMap["ev-2"]).toBe(rec2.id);

    // Redacting rec2 blocks its exact row on next import
    engine.ledger.redact({
      actor: humanAlice,
      entryId: rec2.id,
      reason: "withdraw ev-2",
    });
    const afterRedact = await engine.importer.importJsonl({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      jsonlPath,
      mapping,
    });
    expect(afterRedact.skippedRedacted).toBe(1);

    // ---- Tree mode cross-realm supersede degradation + CLI --map test ----
    const treeHome = makeTempDir("meru-mind-imp-jsonl-tree-");
    const treeEngine = await createMindEngine({
      homeDir: treeHome,
      enableVector: false,
    });
    const { org: treeOrg, rootRealm: treeRoot } = treeEngine.ledger.createOrg({
      name: "JsonlTreeOrg",
      policy: "tree",
    });
    const treeChild = treeEngine.ledger.createRealm({
      actor: humanAlice,
      orgId: treeOrg.id,
      parentId: treeRoot.id,
      slug: "child",
      name: "Child",
    });
    // Existing visible ancestor record in root `/`
    const rootDecision = await treeEngine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: treeRoot.id,
      kind: "decision",
      title: "Root baseline decision",
      occurredAt: "2026-07-01T00:00:00.000Z",
    });
    await treeEngine.close();

    // JSONL imports a decision into /child superseding rootDecision (cross-realm in tree mode!)
    const treeJsonlPath = path.join(workDir, "tree-events.jsonl");
    fs.writeFileSync(
      treeJsonlPath,
      JSON.stringify({
        uid: "child-override",
        type: "decision",
        headline: "Child local override",
        summary: "Degraded cross-realm supersede in tree mode",
        ts: "2026-07-05T00:00:00Z",
        replaces: rootDecision.id,
      }) + "\n",
      "utf8",
    );
    const mapPath = path.join(workDir, "mapping.json");
    fs.writeFileSync(
      mapPath,
      JSON.stringify({
        id: "uid",
        kind: "type",
        title: "headline",
        body: "summary",
        occurredAt: "ts",
        supersedes: "replaces",
      }),
      "utf8",
    );

    const treeCliRes = runCliJson(
      treeHome,
      ["import", "jsonl", treeJsonlPath, "--map", mapPath],
      { MERU_MIND_VIEWER_REALM_ID: treeChild.id },
    ) as {
      imported: number;
      superseded: number;
      treeDegradedCrossRealmSupersedes: number;
      entryIds: string[];
    };
    expect(treeCliRes.imported).toBe(1);
    expect(treeCliRes.superseded).toBe(0);
    expect(treeCliRes.treeDegradedCrossRealmSupersedes).toBe(1);

    // Verify degraded record kept rootDecision in refs & payload.crossRealmSupersedes without modifying rootDecision
    const verifyTree = await createMindEngine({
      homeDir: treeHome,
      enableVector: false,
    });
    engines.push(verifyTree);
    const childRec = verifyTree.db.getRecord(treeCliRes.entryIds[0]!)!;
    expect(childRec.supersedesId).toBeNull();
    expect(childRec.refs).toContain(rootDecision.id);
    expect(childRec.payload.crossRealmSupersedes).toBe(rootDecision.id);
    expect(verifyTree.db.getRecord(rootDecision.id)!.status).toBe("active");
  });

  it("6. import-md single-file baseDir & default parent/file sourceRef avoid basename collisions across directories", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-imp-basedir-"),
      enableVector: false,
    });
    engines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({
      name: "BaseDirOrg",
      policy: "open",
    });

    const docsRoot = makeTempDir("meru-mind-docs-root-");
    const teamA = path.join(docsRoot, "team-a");
    const teamB = path.join(docsRoot, "team-b");
    fs.mkdirSync(teamA, { recursive: true });
    fs.mkdirSync(teamB, { recursive: true });

    const fileA = path.join(teamA, "README.md");
    const fileB = path.join(teamB, "README.md");
    fs.writeFileSync(fileA, "# Team A Guide\n\nContent for team A.\n", "utf8");
    fs.writeFileSync(fileB, "# Team B Guide\n\nContent for team B.\n", "utf8");

    // 1. Single-file imports WITHOUT explicit sourceRef or baseDir still produce distinct sourceRefs
    const rA = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: fileA,
    });
    const rB = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: fileB,
    });
    expect(rA.created).toBe(1);
    expect(rB.created).toBe(1);
    expect(rA.items[0]!.sourceRef).toBe("team-a/README.md");
    expect(rB.items[0]!.sourceRef).toBe("team-b/README.md");
    expect(rA.items[0]!.recordId).not.toBe(rB.items[0]!.recordId);

    // 2. Subsequent directory import from docsRoot (or single-file import with baseDir=docsRoot) matches the exact same sourceRefs (zero duplicates!)
    const rDir = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: docsRoot,
    });
    expect(rDir.skippedUnchanged).toBe(2);
    expect(rDir.created).toBe(0);

    const rWithBase = await engine.importer.importMd({
      actor: agentBot,
      viewerRealmId: rootRealm.id,
      inputPath: fileA,
      baseDir: docsRoot,
    });
    expect(rWithBase.skippedUnchanged).toBe(1);
    expect(rWithBase.created).toBe(0);
  });
});
