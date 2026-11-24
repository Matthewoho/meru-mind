import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  exportRecordsAsMarkdown,
  MAX_IMPORT_MD_BYTES,
  runRealmDoctor,
  type EmbedderPort,
} from "../src/index.js";

const CLI_PATH = path.resolve("dist/cli.js");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runCli(
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; expectFail?: boolean } = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const status = code ?? 1;
      if (status !== 0 && !opts.expectFail) {
        reject(new Error(`CLI failed (${status}): ${args.join(" ")}\n${stdout}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr, status });
    });
    child.stdin.end();
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v0.5.5 Storage Hygiene Guardrails — Thin vec_pending, 2MB Import Guard & One-Way export-md", () => {
  it("1. vec_pending stores ZERO duplicated body bytes when vectors are off, hydrates canonical text on demand when syncing, and migration v11 clears legacy bloat", async () => {
    const homeDir = makeTempDir("meru-v055-vec-thin-");
    const docsDir = makeTempDir("meru-v055-docs-");

    fs.writeFileSync(
      path.join(docsDir, "guide.md"),
      "---\ntitle: Production Runbook\n---\n" + "Detailed paragraph content.\n".repeat(400),
      "utf8",
    );

    const eng = await createMindEngine({ homeDir, enableVector: false });
    const { rootRealm } = eng.ledger.createOrg({ name: "ThinOrg", policy: "open" });

    await eng.importer.importMd({
      viewerRealmId: rootRealm.id,
      targetRealmRef: "/",
      inputPath: docsDir,
      baseDir: docsDir,
    });
    await eng.ledger.appendRecord({
      actor: { id: "alice", kind: "human" },
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "decision",
      title: "Use pointer-only vec_pending",
      payload: { body: "Never duplicate body bytes inside vec_pending." },
    });

    // Regression assertion: vec_pending holds rows, but total text bytes === 0!
    const stats = eng.db.getStorageBloatStats();
    expect(stats.vecPendingCount).toBeGreaterThanOrEqual(2);
    expect(stats.vecPendingTextBytes).toBe(0);
    expect(stats.recordsPayloadBytes).toBeGreaterThan(10_000);

    // Doctor bloat check triggers ONLY if secondary queue holds > 1 MB of duplicated text
    const tree = eng.sea.tree({
      actor: { id: "alice", kind: "human" },
      viewerRealmId: rootRealm.id,
      depth: "all",
      includeObjects: true,
    });
    expect(
      runRealmDoctor(tree, stats).findings.some((f) => f.code === "storage_duplicate_body"),
    ).toBe(false);
    expect(
      runRealmDoctor(tree, { ...stats, vecPendingTextBytes: 2 * 1_048_576 }).findings.some(
        (f) => f.code === "storage_duplicate_body" && f.severity === "warn",
      ),
    ).toBe(true);

    // Verify syncEmbeddings hydrates live text on demand from canonical rows when embedder is configured
    const seenTexts: string[] = [];
    const fakeEmbedder: EmbedderPort = {
      configured: true,
      dimensions: 4,
      async embed(text: string) {
        seenTexts.push(text);
        return new Float32Array([0.1, 0.2, 0.3, 0.4]);
      },
      async embedBatch(texts: string[]) {
        seenTexts.push(...texts);
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]));
      },
    };
    await eng.close();

    // Simulate legacy v10 DB with bloated vec_pending.text, then re-open -> migration v11 clears it!
    const rawDb = new DatabaseSync(path.join(homeDir, "mind.sqlite"));
    rawDb.exec(`DELETE FROM schema_migrations WHERE version = 11;`);
    rawDb
      .prepare(`UPDATE vec_pending SET text = ?`)
      .run("DUPLICATED_LEGACY_BODY_".repeat(5000));
    const beforeBytes = Number(
      (
        rawDb
          .prepare(`SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) AS b FROM vec_pending`)
          .get() as { b: number }
      ).b,
    );
    expect(beforeBytes).toBeGreaterThan(100_000);
    rawDb.close();

    const migratedEng = await createMindEngine({
      homeDir,
      enableVector: true,
      embedder: fakeEmbedder,
    });
    const afterStats = migratedEng.db.getStorageBloatStats();
    expect(afterStats.vecPendingTextBytes).toBe(0);

    // Sync embeddings on pointer-only rows -> hydrates real canonical titles & bodies!
    if (migratedEng.db.vecEnabled) {
      const synced = await migratedEng.sea.syncEmbeddings({ batchSize: 10 });
      expect(synced.indexed).toBeGreaterThanOrEqual(2);
      expect(seenTexts.some((t) => t.includes("Production Runbook"))).toBe(true);
      expect(seenTexts.some((t) => t.includes("Never duplicate body bytes"))).toBe(true);
    }
    await migratedEng.close();
  });

  it("2. import md enforces unified 2 MB file size limit and --dry-run lists oversized files cleanly", async () => {
    expect(MAX_IMPORT_MD_BYTES).toBe(2 * 1024 * 1024);

    const homeDir = makeTempDir("meru-v055-size-home-");
    const docsDir = makeTempDir("meru-v055-size-docs-");

    fs.writeFileSync(path.join(docsDir, "small.md"), "# Small Note\nOk.", "utf8");
    fs.writeFileSync(
      path.join(docsDir, "giant.md"),
      "# Giant Dump\n" + "A".repeat(2 * 1024 * 1024 + 512),
      "utf8",
    );

    const eng = await createMindEngine({ homeDir, enableVector: false });
    const { rootRealm } = eng.ledger.createOrg({ name: "SizeOrg", policy: "open" });

    // Dry-run flags oversized file and marks valid=false without throwing or writing
    const preview = eng.importer.previewImport({
      viewerRealmId: rootRealm.id,
      targetRealmRef: "/",
      sourcePath: docsDir,
      baseDir: docsDir,
    });
    expect(preview.valid).toBe(false);
    expect(preview.oversizedFiles).toHaveLength(1);
    expect(preview.oversizedFiles[0]!.path).toBe("giant.md");
    expect(preview.oversizedFiles[0]!.sizeBytes).toBeGreaterThan(MAX_IMPORT_MD_BYTES);

    // Real import fails fast BEFORE writing any record!
    await expect(
      eng.importer.importMd({
        viewerRealmId: rootRealm.id,
        targetRealmRef: "/",
        inputPath: docsDir,
        baseDir: docsDir,
      }),
    ).rejects.toThrow(/import limit/i);

    const checkRecords = eng.db.listRecords({
      realmIds: [rootRealm.id],
      includeSuperseded: true,
    });
    expect(checkRecords.items).toHaveLength(0);
    await eng.close();
  });

  it("3. One-way admin export-md restores active records with frontmatter, excludes secret & default confidential, and sanitizes paths", async () => {
    const homeDir = makeTempDir("meru-v055-export-home-");
    const outDir = makeTempDir("meru-v055-export-out-");

    const eng = await createMindEngine({ homeDir, enableVector: false });
    const { org, rootRealm } = eng.ledger.createOrg({ name: "ExportOrg", policy: "open" });
    const opsRealm = eng.ledger.createRealm({
      actor: { id: "admin", kind: "human" },
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "ops",
      name: "Operations",
      scope: "Include: ops. Exclude: product.",
    });

    const oldRec = await eng.ledger.appendRecord({
      actor: { id: "admin", kind: "human" },
      viewerRealmId: opsRealm.id,
      targetRealmId: opsRealm.id,
      kind: "decision",
      title: "Old Deploy Policy",
      payload: { body: "Superseded content should NOT be exported." },
      sourceRef: "ops/deploy.md",
    });
    await eng.ledger.appendRecord({
      actor: { id: "admin", kind: "human" },
      viewerRealmId: opsRealm.id,
      targetRealmId: opsRealm.id,
      kind: "decision",
      title: "Current Deploy Policy",
      payload: { body: "Always smoke test staging first." },
      supersedesIds: [oldRec.id],
      sourceRef: "ops/deploy.md",
      resourceTags: ["service:api"],
    });
    await eng.ledger.appendRecord({
      actor: { id: "admin", kind: "human" },
      viewerRealmId: opsRealm.id,
      targetRealmId: opsRealm.id,
      kind: "finding",
      title: "Traversal Attempt Ref",
      payload: { body: "Must stay safely inside outDir." },
      sourceRef: "../../etc/passwd",
    });
    await eng.ledger.appendRecord({
      actor: { id: "admin", kind: "human" },
      viewerRealmId: opsRealm.id,
      targetRealmId: opsRealm.id,
      kind: "finding",
      title: "Confidential Budget",
      payload: { body: "Confidential Q4 budget." },
      sensitivity: "confidential",
    });
    await eng.ledger.appendRecord({
      actor: { id: "admin", kind: "human" },
      viewerRealmId: opsRealm.id,
      targetRealmId: opsRealm.id,
      kind: "finding",
      title: "Top Secret Key",
      payload: { body: "Never export secrets." },
      sensitivity: "secret",
    });

    // Direct engine export (default excludes secret & confidential)
    const exp = exportRecordsAsMarkdown({
      db: eng.db,
      viewerRealmId: rootRealm.id,
      outDir,
    });
    expect(exp.oneWayProjection).toBe(true);
    expect(exp.exportedCount).toBe(2);
    expect(exp.skippedSecret).toBe(1);
    expect(exp.skippedConfidential).toBe(1);
    expect(exp.manifestPath).toBe(path.join(outDir, "MANIFEST.json"));
    expect(fs.existsSync(exp.manifestPath!)).toBe(true);

    const deployMd = fs.readFileSync(path.join(outDir, "ops/deploy.md"), "utf8");
    expect(deployMd).toContain("realm: /ops");
    expect(deployMd).toContain("Always smoke test staging first.");
    expect(deployMd).not.toContain("Superseded content");

    // Traversal ref was safely placed under ops/<slug>-<id>.md, never escaping outDir
    const traversalItem = exp.items.find((i) => i.relativePath.includes("traversal-attempt-ref"));
    expect(traversalItem).toBeDefined();
    expect(traversalItem!.relativePath.startsWith("ops/")).toBe(true);
    expect(fs.existsSync(path.join(outDir, traversalItem!.relativePath))).toBe(true);

    await eng.close();

    // Verify CLI `admin export-md --dry-run --json` works cleanly too
    const cliDryOut = makeTempDir("meru-v055-export-cli-");
    const cliRes = await runCli(
      ["admin", "export-md", cliDryOut, "--include-confidential", "--dry-run", "--json"],
      { env: { MERU_MIND_HOME: homeDir } },
    );
    const parsed = JSON.parse(cliRes.stdout) as {
      dryRun: boolean;
      exportedCount: number;
      skippedSecret: number;
      skippedConfidential: number;
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.exportedCount).toBe(3); // 2 internal + 1 confidential; secret STILL excluded!
    expect(parsed.skippedSecret).toBe(1);
    expect(parsed.skippedConfidential).toBe(0);
    expect(fs.readdirSync(cliDryOut)).toHaveLength(0);
  });
});
