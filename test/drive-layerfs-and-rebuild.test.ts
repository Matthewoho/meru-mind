import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  LayerFSDriveAdapter,
  restoreWritablePermissions,
  type Actor,
  type EmbedderPort,
  type LayerFSClientLike,
  type LayerFSWorkspaceHandle,
  type MindEngine,
} from "../src/index.js";

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
const agentWorker: Actor = { id: "worker-1", kind: "agent", family: "gemini" };

class SimpleEmbedder implements EmbedderPort {
  readonly dimensions = 4;
  readonly configured = true;
  async embed(text: string): Promise<Float32Array | null> {
    const lower = text.toLowerCase();
    return new Float32Array([
      lower.includes("database") ? 1 : 0,
      lower.includes("frontend") ? 1 : 0,
      lower.includes("rebuild") ? 1 : 0,
      0.1,
    ]);
  }
}

/**
 * In-memory LayerFS client harness simulating real workspace.exec / workspace.commit
 * including native LayerFS `{ kind: "Conflict" }` responses and volume wipes.
 */
function createFakeLayerFSClient() {
  const workDir = makeTempDir("meru-mind-fake-lfs-");
  let nextCommitConflict = false;
  let commitCounter = 0;

  const client: LayerFSClientLike = {
    projectName: "meru-mind-test",
    branch: {
      async fork() {
        return {};
      },
    },
    sandbox: {
      async create() {
        return { sandbox: "sb_1" };
      },
      async close() {
        return {};
      },
    },
    workspace: {
      async mount(sandbox: string): Promise<LayerFSWorkspaceHandle> {
        return { sandbox, path: workDir };
      },
      async exec(_ws, command) {
        const { execFileSync } = await import("node:child_process");
        try {
          const stdout = execFileSync("sh", ["-c", command], {
            cwd: workDir,
            encoding: "utf8",
          });
          return { exitCode: 0, stdout, stderr: "" };
        } catch (err: unknown) {
          const e = err as { status?: number; stdout?: string; stderr?: string };
          return {
            exitCode: e.status ?? 1,
            stdout: String(e.stdout ?? ""),
            stderr: String(e.stderr ?? ""),
          };
        }
      },
      async commit(_ws, _message, force) {
        if (nextCommitConflict && !force) {
          nextCommitConflict = false;
          return { kind: "Conflict" };
        }
        commitCounter += 1;
        return { kind: "Committed", commitId: `lfs_c_${commitCounter}` };
      },
      async unmount() {
        return {};
      },
    },
    async close() {
      return;
    },
  };

  return {
    client,
    workDir,
    triggerNextConflict() {
      nextCommitConflict = true;
    },
    wipeVolume() {
      fs.rmSync(path.join(workDir, "realms"), { recursive: true, force: true });
    },
  };
}

describe("Drive concurrency (Local & LayerFS), crash rebuild, slice tamper & home guard", () => {
  it("detects optimistic concurrency conflicts on LocalFsDriveAdapter without overwriting winner", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-local-drive-"),
    });
    engines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });

    const w1 = await engine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      relPath: "docs/STATE.md",
      content: "version 1",
      expectedVersion: 0,
    });
    expect(w1.meta.version).toBe(1);

    const w2 = await engine.ledger.writeDriveFile({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      relPath: "docs/STATE.md",
      content: "version 2 winner",
      expectedVersion: 1,
    });
    expect(w2.meta.version).toBe(2);

    // Stale writer expecting version 1 is rejected with CONFLICT
    await expect(
      engine.ledger.writeDriveFile({
        actor: agentWorker,
        viewerRealmId: rootRealm.id,
        relPath: "docs/STATE.md",
        content: "stale overwrite",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const after = await engine.ledger.readDriveFile({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      relPath: "docs/STATE.md",
    });
    expect(after?.content).toBe("version 2 winner");
  });

  it("handles LayerFSDriveAdapter native Conflict and recovers full drive + FTS5 + sqlite-vec via rebuild()", async () => {
    const fakeLfs = createFakeLayerFSClient();
    const homeDir = makeTempDir("meru-mind-lfs-rebuild-");
    const engine = await createMindEngine({
      homeDir,
      driveMode: "layerfs",
      layerfsClient: fakeLfs.client,
      embedder: new SimpleEmbedder(),
      vectorDimensions: 4,
    });
    engines.push(engine);

    expect(engine.drive).toBeInstanceOf(LayerFSDriveAdapter);
    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });

    const dec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Migrate database schema before release",
    });
    await engine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "Verified rebuild durability checklist",
    });
    const settled = await engine.sea.settle({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      layer: "card_realm",
      periodKey: "2026-11-20",
      narrativeMd: `Core decision [${dec.id}] covers database schema migration.`,
      sourceIds: [dec.id],
    });
    expect(settled.hardFacts.activeRecordCount).toBe(1);

    // Successful LayerFS write mirrors into immutable BlobPort
    const written = await engine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      relPath: "specs/design.md",
      content: "# Architecture Spec v1",
      expectedVersion: 0,
    });
    expect(written.commitId).toBe("lfs_c_1");
    expect(engine.blobs.has(written.meta.sha256)).toBe(true);

    // Native LayerFS Conflict response throws CONFLICT
    fakeLfs.triggerNextConflict();
    await expect(
      engine.ledger.writeDriveFile({
        actor: agentWorker,
        viewerRealmId: rootRealm.id,
        relPath: "specs/design.md",
        content: "# Conflicting edit",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Simulate catastrophic loss of all derived indexes + disposable LayerFS volume
    engine.db.clearFtsIndex();
    engine.db.clearVectorIndex();
    fakeLfs.wipeVolume();

    // Before rebuild: search and LayerFS read are empty
    const beforeRebuildSearch = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      query: "database",
    });
    expect(beforeRebuildSearch.items).toHaveLength(0);
    expect(
      await engine.ledger.readDriveFile({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        relPath: "specs/design.md",
      }),
    ).toBeNull();

    // Run rebuild(): reconstructs FTS5, sqlite-vec, and LayerFS volume from SQLite + blobs
    const rebuilt = await engine.sea.rebuild();
    expect(rebuilt.ftsIndexed).toBeGreaterThanOrEqual(3);
    expect(rebuilt.vectorsIndexed).toBeGreaterThanOrEqual(3);
    expect(rebuilt.driveFilesRestored).toBe(1);
    expect(rebuilt.distillationMismatches).toEqual([]);

    // After rebuild: hybrid recall AND LayerFS drive file are 100% restored
    const afterRebuildSearch = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      query: "database",
    });
    expect(afterRebuildSearch.vectorUsed).toBe(true);
    expect(afterRebuildSearch.items.some((i) => i.id === dec.id)).toBe(true);

    const restoredFile = await engine.ledger.readDriveFile({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      relPath: "specs/design.md",
    });
    expect(restoredFile?.content).toBe("# Architecture Spec v1");
  });

  it("detects sandbox tampering of read-only exported slice and records a finding", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-tamper-"),
    });
    engines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });
    await engine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      relPath: "STATE.md",
      content: "clean state",
    });

    const sliceDir = makeTempDir("meru-mind-ro-slice-");
    const exported = await engine.slice.exportSlice({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      outDir: sliceDir,
    });

    // Clean check passes
    const clean = await engine.slice.verifySlice({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      outDir: sliceDir,
      expectedManifest: exported.manifest,
    });
    expect(clean.intact).toBe(true);

    // Force-chmod and tamper with read-only slice file
    const targetFile = path.join(sliceDir, "self", "drive", "STATE.md");
    fs.chmodSync(path.dirname(targetFile), 0o755);
    fs.chmodSync(targetFile, 0o644);
    fs.writeFileSync(targetFile, "tampered by rogue sandbox", "utf8");

    const tampered = await engine.slice.verifySlice({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      outDir: sliceDir,
      expectedManifest: exported.manifest,
    });
    expect(tampered.intact).toBe(false);
    expect(tampered.modifiedPaths).toContain("self/drive/STATE.md");
    expect(tampered.findingId).toBeTruthy();

    // Confirm finding was persisted to ledger
    const finding = engine.db.getRecord(tampered.findingId!);
    expect(finding?.kind).toBe("finding");
  });

  it("refuses to initialize runtime data inside the open-source repository directory", async () => {
    const repoPath = path.resolve(import.meta.dirname, "..", ".illegal-runtime");
    await expect(createMindEngine({ homeDir: repoPath })).rejects.toMatchObject({
      code: "FORBIDDEN_HOME_PATH",
    });
  });
});
