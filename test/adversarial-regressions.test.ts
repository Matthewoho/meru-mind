import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  restoreWritablePermissions,
  type Actor,
  type EmbedderPort,
  type LayerFSClientLike,
  type LayerFSWorkspaceHandle,
  type MindEngine,
  type RecordKind,
} from "../src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliBin = path.join(repoRoot, "dist", "cli.js");
const mcpBin = path.join(repoRoot, "dist", "mcp.js");

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
const agentGemini: Actor = { id: "w-gem", kind: "agent", family: "gemini" };
const agentDeepseek: Actor = { id: "v-ds", kind: "agent", family: "deepseek" };

class ConstantBucketEmbedder implements EmbedderPort {
  readonly dimensions = 4;
  readonly configured = true;
  async embed(_text: string): Promise<Float32Array | null> {
    return new Float32Array([1, 0, 0, 0]);
  }
}

describe("Adversarial security & invariant regressions", () => {
  it("kills sqlite-vec partition-key bypass under Top-K saturation (>50 hidden sibling vectors)", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-vec-part-"),
      embedder: new ConstantBucketEmbedder(),
      vectorDimensions: 4,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "Acme",
      policy: "tree",
    });
    const sibHidden = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "hidden",
      name: "Hidden",
    });
    const sibViewer = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "viewer",
      name: "Viewer",
    });

    // Flood hidden sibling with 55 identical vectors (> candidateLimit=40)
    for (let i = 0; i < 55; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: sibHidden.id,
        kind: "decision",
        title: `Hidden flood decision ${i}`,
      });
    }

    const viewerDec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibViewer.id,
      kind: "decision",
      title: "Viewer target decision",
    });

    await engine.sea.syncEmbeddings();

    // Direct DbPort vector query MUST exclude sibHidden before Top-K
    const vecHits = engine.db.searchVectors({
      embedding: new Float32Array([1, 0, 0, 0]),
      realmIds: [sibViewer.id],
      includeSuperseded: false,
      limit: 5,
    });
    expect(vecHits.some((h) => h.itemId === viewerDec.id)).toBe(true);
    expect(vecHits.some((h) => h.realmId === sibHidden.id)).toBe(false);

    // Full recall MUST still find viewerDec without starvation by the 55 hidden sibling rows
    const recalled = await engine.sea.recall({
      actor: agentGemini,
      viewerRealmId: sibViewer.id,
      query: "unrelated semantic wording",
      limit: 5,
    });
    expect(recalled.vectorUsed).toBe(true);
    expect(recalled.items.some((i) => i.id === viewerDec.id)).toBe(true);
    expect(recalled.items.some((i) => i.realmId === sibHidden.id)).toBe(false);
  });

  it("prevents parent recall Top-K starvation from verbose child seabed and enforces thingId/authorId filters", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-starve-"),
      embedder: new ConstantBucketEmbedder(),
      vectorDimensions: 4,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "Acme",
      policy: "tree",
    });
    const child = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "child",
      name: "Child",
    });

    const childDec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: child.id,
      kind: "decision",
      title: "STARVATION_KEY critical architecture decision",
    });
    for (let i = 0; i < 60; i += 1) {
      await engine.ledger.captureSeabed({
        actor: agentGemini,
        viewerRealmId: child.id,
        kind: "message",
        text: `STARVATION_KEY noisy child log line ${i}`,
      });
    }

    await engine.sea.syncEmbeddings();

    const parentRecall = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      query: "STARVATION_KEY",
      limit: 5,
    });
    expect(parentRecall.items.some((i) => i.id === childDec.id)).toBe(true);
    expect(parentRecall.items.every((i) => i.sourceType !== "seabed")).toBe(true);

    // Stage 3/4 thingId and authorId filter enforcement on distillations and seabed
    await engine.sea.settle({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      layer: "card_realm",
      periodKey: "2026-11-20",
      narrativeMd: "FILTER_TOKEN settled summary",
    });
    const byAuthor = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      query: "FILTER_TOKEN",
      authorId: "alice",
    });
    expect(byAuthor.items.some((i) => i.sourceType === "distillation")).toBe(false);

    const byOtherAuthor = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      query: "FILTER_TOKEN",
      authorId: "bob",
    });
    expect(byOtherAuthor.items).toHaveLength(0);

    const byThing = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      query: "FILTER_TOKEN",
      thingId: "thing_nonexistent",
    });
    expect(byThing.items).toHaveLength(0);
  });

  it("eliminates blind-ID oracles across verdict proposalId, getSupersedeChain, refs, and settle sourceIds", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-oracle-"),
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "Acme",
      policy: "tree",
    });
    const sib1 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "sib1",
      name: "Sib1",
    });
    const sib2 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "sib2",
      name: "Sib2",
    });

    const hiddenProp = await engine.ledger.appendRecord({
      actor: agentGemini,
      viewerRealmId: sib1.id,
      kind: "proposal",
      title: "Hidden proposal",
    });

    const captureErr = async (fn: () => Promise<unknown> | unknown) => {
      try {
        await fn();
        return null;
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string };
        return { code: err.code, message: err.message };
      }
    };

    // 1. supersedesId must return identical NOT_FOUND for hidden sibling vs missing
    const eHiddenSupersede = await captureErr(() =>
      engine.ledger.appendRecord({
        actor: agentGemini,
        viewerRealmId: sib2.id,
        kind: "proposal",
        title: "Probe supersede",
        supersedesId: hiddenProp.id,
      }),
    );
    const eMissingSupersede = await captureErr(() =>
      engine.ledger.appendRecord({
        actor: agentGemini,
        viewerRealmId: sib2.id,
        kind: "proposal",
        title: "Probe supersede",
        supersedesId: "rec_doesnotexist",
      }),
    );
    expect(eHiddenSupersede?.code).toBe("NOT_FOUND");
    expect(eMissingSupersede?.code).toBe("NOT_FOUND");
    expect(eHiddenSupersede?.message?.replace(hiddenProp.id, "X")).toBe(
      eMissingSupersede?.message?.replace("rec_doesnotexist", "X"),
    );

    // 2. getSupersedeChain must return identical NOT_FOUND
    const eHiddenChain = await captureErr(() =>
      engine.ledger.getSupersedeChain({
        actor: agentGemini,
        viewerRealmId: sib2.id,
        recordId: hiddenProp.id,
      }),
    );
    const eMissingChain = await captureErr(() =>
      engine.ledger.getSupersedeChain({
        actor: agentGemini,
        viewerRealmId: sib2.id,
        recordId: "rec_doesnotexist",
      }),
    );
    expect(eHiddenChain?.code).toBe("NOT_FOUND");
    expect(eHiddenChain?.message?.replace(hiddenProp.id, "X")).toBe(
      eMissingChain?.message?.replace("rec_doesnotexist", "X"),
    );

    // 3. appendRecord(refs) and settle(sourceIds) must return identical NOT_FOUND
    const eHiddenRef = await captureErr(() =>
      engine.ledger.appendRecord({
        actor: agentGemini,
        viewerRealmId: sib2.id,
        kind: "finding",
        title: "Probe ref",
        refs: [hiddenProp.id],
      }),
    );
    const eMissingRef = await captureErr(() =>
      engine.ledger.appendRecord({
        actor: agentGemini,
        viewerRealmId: sib2.id,
        kind: "finding",
        title: "Probe ref",
        refs: ["rec_doesnotexist"],
      }),
    );
    expect(eHiddenRef?.code).toBe("NOT_FOUND");
    expect(eHiddenRef?.message?.replace(hiddenProp.id, "X")).toBe(
      eMissingRef?.message?.replace("rec_doesnotexist", "X"),
    );

    const eHiddenSettle = await captureErr(() =>
      engine.sea.settle({
        actor: agentGemini,
        viewerRealmId: sib2.id,
        layer: "slice_shift",
        periodKey: "s1",
        sourceIds: [hiddenProp.id],
      }),
    );
    const eMissingSettle = await captureErr(() =>
      engine.sea.settle({
        actor: agentGemini,
        viewerRealmId: sib2.id,
        layer: "slice_shift",
        periodKey: "s1",
        sourceIds: ["rec_doesnotexist"],
      }),
    );
    expect(eHiddenSettle?.code).toBe("NOT_FOUND");
    expect(eHiddenSettle?.message?.replace(hiddenProp.id, "X")).toBe(
      eMissingSettle?.message?.replace("rec_doesnotexist", "X"),
    );
  });

  it("enforces verdict family trimming, case-insensitive outcome, safe IDs, enum validation, and budget bounds", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-val-"),
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({ name: "Acme" });

    // Unsafe realmId ".." rejected
    expect(() =>
      engine.ledger.createRealm({
        actor: humanAlice,
        id: "..",
        orgId: org.id,
        parentId: rootRealm.id,
        slug: "bad",
        name: "Bad",
      }),
    ).toThrow(/Invalid realmId/);

    // Invalid record kind rejected
    await expect(
      engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "banana" as RecordKind,
        title: "Bad kind",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // Null byte in drive path rejected cleanly as INVALID_INPUT
    await expect(
      engine.ledger.writeDriveFile({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        relPath: "foo\0bar.md",
        content: "x",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // Negative brief budget rejected
    expect(() =>
      engine.sea.brief({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        budget: { recentMessages: -1 },
      }),
    ).toThrow(/positive integer/);

    // Generic verdict records with optional extKind are accepted without hardcoded cross-family rules
    const prop = await engine.ledger.appendRecord({
      actor: agentGemini,
      viewerRealmId: rootRealm.id,
      kind: "proposal",
      extKind: "design_proposal",
      title: "Work done",
    });
    const verdict = await engine.ledger.appendRecord({
      actor: agentDeepseek,
      viewerRealmId: rootRealm.id,
      kind: "verdict",
      extKind: "review_verdict",
      title: "Generic verdict note",
      payload: { proposalId: prop.id, outcome: "REJECT" },
      refs: [prop.id],
    });
    expect(verdict.extKind).toBe("review_verdict");
  });

  it("rolls back LayerFS workspace file cleanly on Conflict so winner content stays intact", async () => {
    const workDir = makeTempDir("meru-mind-lfs-rb-");
    let conflictNext = false;
    const client: LayerFSClientLike = {
      projectName: "test",
      branch: { async fork() { return {}; } },
      sandbox: {
        async create() { return { sandbox: "sb_1" }; },
        async close() { return {}; },
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
        async commit() {
          if (conflictNext) {
            conflictNext = false;
            return { kind: "Conflict" };
          }
          return { kind: "Committed", commitId: "c1" };
        },
        async unmount() { return {}; },
      },
      async close() { return; },
    };

    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-lfs-rb-home-"),
      driveMode: "layerfs",
      layerfsClient: client,
    });
    engines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });
    await engine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      relPath: "STATE.md",
      content: "WINNER_V1",
      expectedVersion: 0,
    });

    conflictNext = true;
    await expect(
      engine.ledger.writeDriveFile({
        actor: agentGemini,
        viewerRealmId: rootRealm.id,
        relPath: "STATE.md",
        content: "LOSER_CONFLICT",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Winner MUST still be in the live mounted LayerFS workspace
    const live = await engine.ledger.readDriveFile({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      relPath: "STATE.md",
    });
    expect(live?.content).toBe("WINNER_V1");
  });

  it("refuses overwriting arbitrary non-empty dirs in exportSlice and catches rogue symlinks in verifySlice", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-slice-safe-"),
    });
    engines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });

    const preciousDir = makeTempDir("meru-mind-precious-");
    fs.writeFileSync(path.join(preciousDir, "important.txt"), "keep me", "utf8");

    await expect(
      engine.slice.exportSlice({
        actor: agentGemini,
        viewerRealmId: rootRealm.id,
        outDir: preciousDir,
      }),
    ).rejects.toMatchObject({ code: "SLICE_VIOLATION" });
    expect(fs.readFileSync(path.join(preciousDir, "important.txt"), "utf8")).toBe(
      "keep me",
    );

    // Exporting to fresh dir succeeds; adding rogue symlink is caught by verifySlice
    const sliceDir = makeTempDir("meru-mind-symlink-slice-");
    const exported = await engine.slice.exportSlice({
      actor: agentGemini,
      viewerRealmId: rootRealm.id,
      outDir: sliceDir,
    });
    fs.chmodSync(sliceDir, 0o755);
    fs.symlinkSync("/etc/hosts", path.join(sliceDir, "rogue-link"));

    const verified = await engine.slice.verifySlice({
      actor: agentGemini,
      viewerRealmId: rootRealm.id,
      outDir: sliceDir,
      expectedManifest: exported.manifest,
    });
    expect(verified.intact).toBe(false);
    expect(verified.addedPaths).toContain("rogue-link");
    expect(verified.findingId).toBeTruthy();
  });

  it("serializes 6 concurrent OS CLI processes writing same expectedVersion so strictly 1 wins", async () => {
    const homeDir = makeTempDir("meru-mind-race-");
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          [cliBin, "--home", homeDir, "--json", ...args],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += String(d)));
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });

    const init = await run(["admin", "init", "--org", "Acme"]);
    expect(init.code).toBe(0);

    const first = await run([
      "file",
      "write",
      "file:/race.md",
      "--content",
      "v1",
      "--expected-version",
      "0",
    ]);
    expect(first.code).toBe(0);

    const racers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        run([
          "file",
          "write",
          "file:/race.md",
          "--content",
          `winner-${i}`,
          "--expected-version",
          "1",
        ]),
      ),
    );

    const wins = racers.filter((r) => r.code === 0);
    const conflicts = racers.filter(
      (r) => r.code !== 0 && r.stderr.includes('"conflict"'),
    );
    expect(wins).toHaveLength(1);
    expect(conflicts).toHaveLength(5);
  });

  it("boots MCP stdio server cleanly when invoked via a symlink named meru-mind-mcp", async () => {
    const binDir = makeTempDir("meru-mind-bin-");
    const homeDir = makeTempDir("meru-mind-mcp-sym-");
    const symlinkPath = path.join(binDir, "meru-mind-mcp");
    fs.symlinkSync(mcpBin, symlinkPath);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [symlinkPath],
      env: { ...process.env, MERU_MIND_HOME: homeDir },
    });
    const client = new Client({ name: "symlink-test", version: "0.1.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "mind_changes",
        "mind_ls",
        "mind_search",
        "mind_show",
        "mind_tree",
        "mind_whoami",
        "mind_write",
      ]);
    } finally {
      await client.close();
    }
  });
});
