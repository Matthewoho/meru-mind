import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  MindError,
  restoreWritablePermissions,
  type Actor,
  type EmbedderPort,
  type MindEngine,
} from "../src/index.js";

/**
 * Deterministic 8-dim semantic test embedder mapping known concept groups to orthogonal unit vectors.
 * Allows testing true sqlite-vec KNN recall with zero keyword overlap AND verifying partition isolation.
 */
class ConceptVectorEmbedder implements EmbedderPort {
  readonly dimensions = 8;
  readonly configured = true;

  async embed(text: string): Promise<Float32Array | null> {
    const lower = text.toLowerCase();
    const vec = new Float32Array(this.dimensions);
    if (
      lower.includes("latency") ||
      lower.includes("slow response") ||
      lower.includes("p99")
    ) {
      vec[0] = 1;
    } else if (
      lower.includes("billing") ||
      lower.includes("invoice") ||
      lower.includes("pricing")
    ) {
      vec[1] = 1;
    } else if (
      lower.includes("canary-secret-sibling") ||
      lower.includes("hidden-topic") ||
      lower.includes("canary_sibling_992")
    ) {
      vec[2] = 1;
    } else if (lower.includes("canary_ancestor_771")) {
      vec[3] = 1;
    } else if (lower.includes("child_chat_only_881")) {
      vec[4] = 1;
    } else {
      vec[7] = 1;
    }
    return vec;
  }
}

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

describe("MindRealm visibility & MindSea 4-stage hybrid recall", () => {
  it("enforces zero sibling leakage across brief, ID recall, FTS5, sqlite-vec, drive, and slice export", async () => {
    const homeDir = makeTempDir("meru-mind-vis-");
    const engine = await createMindEngine({
      homeDir,
      embedder: new ConceptVectorEmbedder(),
      vectorDimensions: 8,
    });
    engines.push(engine);

    expect(engine.db.vecEnabled).toBe(true);

    // Build tree: A (root) -> B1 -> C1, A -> B2 -> C2
    const { org, rootRealm: A } = engine.ledger.createOrg({ name: "Acme" });
    const B1 = engine.ledger.createRealm({
      orgId: org.id,
      parentId: A.id,
      slug: "finance",
      name: "Finance",
    });
    const C1 = engine.ledger.createRealm({
      orgId: org.id,
      parentId: B1.id,
      slug: "payroll",
      name: "Payroll",
    });
    const B2 = engine.ledger.createRealm({
      orgId: org.id,
      parentId: A.id,
      slug: "engineering",
      name: "Engineering",
    });
    const C2 = engine.ledger.createRealm({
      orgId: org.id,
      parentId: B2.id,
      slug: "backend",
      name: "Backend",
    });

    // Separate organization (cross-org must also be completely invisible)
    const { rootRealm: otherOrgRoot } = engine.ledger.createOrg({
      name: "OtherCorp",
    });

    const ancestorCanary = "CANARY_ANCESTOR_771";
    const siblingCanary = "CANARY_SIBLING_992";
    const selfCanary = "CANARY_SELF_334";
    const otherOrgCanary = "CANARY_OTHER_ORG_556";

    // Plant rules, decisions, seabed, and drive files across A, C1 (sibling), C2 (self), OtherCorp
    const rootRule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: A.id,
      kind: "rule",
      title: `Global policy ${ancestorCanary}`,
    });
    const c1Dec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: C1.id,
      kind: "decision",
      title: `Secret payroll formula ${siblingCanary} slow response latency`,
    });
    const c1Sea = await engine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: C1.id,
      kind: "message",
      text: `Confidential chat ${siblingCanary} canary-secret-sibling`,
    });
    await engine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: C1.id,
      relPath: "secrets.md",
      content: `Top secret ${siblingCanary}`,
    });

    const c2Dec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: C2.id,
      kind: "decision",
      title: `Reduce p99 tail delay in API gateway ${selfCanary}`,
    });
    await engine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: C2.id,
      relPath: "STATE.md",
      content: `Backend status ${selfCanary}`,
    });
    await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: otherOrgRoot.id,
      kind: "decision",
      title: `Other org decision ${otherOrgCanary}`,
    });

    // 1. Brief from C2 sees A (inherited rule) and C2, NEVER C1 or OtherCorp
    const briefC2 = engine.sea.brief({ actor: agentWorker, viewerRealmId: C2.id });
    const briefStr = JSON.stringify(briefC2);
    expect(briefStr).toContain(ancestorCanary);
    expect(briefStr).toContain(selfCanary);
    expect(briefStr).not.toContain(siblingCanary);
    expect(briefStr).not.toContain(otherOrgCanary);
    expect(briefC2.middleMind.rules.items.some((r) => r.id === rootRule.id && r.inherited)).toBe(true);

    // 2. Direct ID recall from C2 on hidden sibling IDs returns 0 items
    const idCheckRec = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: C2.id,
      id: c1Dec.id,
    });
    expect(idCheckRec.items).toHaveLength(0);
    expect(idCheckRec.message).toContain("No matching entries");

    const idCheckSea = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: C2.id,
      id: c1Sea.id,
    });
    expect(idCheckSea.items).toHaveLength(0);

    // 3. FTS5 keyword search from C2 for sibling canary returns 0; for self/ancestor returns 100%
    const ftsSibling = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: C2.id,
      query: siblingCanary,
    });
    expect(ftsSibling.items).toHaveLength(0);

    const ftsSelf = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: C2.id,
      query: selfCanary,
    });
    expect(ftsSelf.items.some((i) => i.id === c2Dec.id)).toBe(true);

    // 4. Semantic sqlite-vec recall: query "slow response" shares NO keyword with c2Dec ("p99"),
    //    matches c2Dec via ConceptVectorEmbedder[0], and MUST NOT leak c1Dec (which ALSO has vec[0] + exact words!)
    const vecSearch = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: C2.id,
      query: "slow response",
    });
    expect(vecSearch.vectorUsed).toBe(true);
    expect(vecSearch.items.some((i) => i.id === c2Dec.id && i.matchedBy.includes("vector"))).toBe(true);
    expect(vecSearch.items.some((i) => i.realmId === C1.id)).toBe(false);

    // 5. Semantic sqlite-vec query targeting ONLY C1's vector bucket ("hidden-topic" -> vec[2]) leaks 0 items
    const vecHiddenOnly = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: C2.id,
      query: "hidden-topic",
    });
    expect(vecHiddenOnly.items.some((i) => i.realmId === C1.id)).toBe(false);

    // 6. Drive read/list from C2 on C1 throws ACCESS_DENIED
    await expect(
      engine.ledger.readDriveFile({
        actor: agentWorker,
        viewerRealmId: C2.id,
        targetRealmId: C1.id,
        relPath: "secrets.md",
      }),
    ).rejects.toThrow(MindError);

    // 7. Exported slice for C2 contains A and C2, zero bytes of C1 or OtherCorp
    const sliceDir = makeTempDir("meru-mind-slice-");
    await engine.slice.exportSlice({
      actor: agentWorker,
      viewerRealmId: C2.id,
      outDir: sliceDir,
    });
    const collectAllText = (dir: string): string => {
      let acc = "";
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        acc += e.isDirectory() ? collectAllText(p) : fs.readFileSync(p, "utf8");
      }
      return acc;
    };
    const sliceDump = collectAllText(sliceDir);
    expect(sliceDump).toContain(ancestorCanary);
    expect(sliceDump).toContain(selfCanary);
    expect(sliceDump).not.toContain(siblingCanary);
    expect(sliceDump).not.toContain(otherOrgCanary);
    expect(sliceDump).not.toContain(C1.id);

    // 8. Explicit @mount grants read-only access to C1 from C2, while write stays denied
    engine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: C2.id,
      targetRealmId: C1.id,
      scope: "all",
    });
    const mountedRead = await engine.ledger.readDriveFile({
      actor: agentWorker,
      viewerRealmId: C2.id,
      targetRealmId: C1.id,
      relPath: "secrets.md",
    });
    expect(mountedRead?.content).toContain(siblingCanary);

    await expect(
      engine.ledger.writeDriveFile({
        actor: agentWorker,
        viewerRealmId: C2.id,
        targetRealmId: C1.id,
        relPath: "secrets.md",
        content: "tampered",
      }),
    ).rejects.toThrow(MindError);

    // 9. Parent B2 sees C2 ledger by default, NOT C2 seabed until explicit includeDescendantSeabed=true
    const c2Chat = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: C2.id,
      kind: "message",
      text: "Verbose child debug trace CHILD_CHAT_ONLY_881",
    });

    const b2Default = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: B2.id,
      query: "CHILD_CHAT_ONLY_881",
    });
    expect(b2Default.items).toHaveLength(0);

    const b2Dive = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: B2.id,
      query: "CHILD_CHAT_ONLY_881",
      includeDescendantSeabed: true,
    });
    expect(b2Dive.items.some((i) => i.id === c2Chat.id)).toBe(true);

    // Parent B2 sees C2 ledger summary automatically in brief
    const briefB2 = engine.sea.brief({ actor: humanAlice, viewerRealmId: B2.id });
    expect(briefB2.middleMind.childSummaries.items.some((c) => c.realmId === C2.id && c.activeDecisions >= 1)).toBe(true);
  });

  it("supports mixed CJK + English FTS5 recall and mandatory omitted counts in brief", async () => {
    const homeDir = makeTempDir("meru-mind-cjk-");
    const engine = await createMindEngine({ homeDir });
    engines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });
    for (let i = 1; i <= 7; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "decision",
        title: `决策 ${i}: 接入 PostgreSQL 数据库连接池`,
      });
    }

    const brief = engine.sea.brief({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      budget: { maxDecisions: 3 },
    });
    expect(brief.upperLedger.activeDecisions.items).toHaveLength(3);
    expect(brief.upperLedger.activeDecisions.totalCount).toBe(7);
    expect(brief.upperLedger.activeDecisions.omittedCount).toBe(4);

    const cjkSearch = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      query: "连接池",
    });
    expect(cjkSearch.items.length).toBeGreaterThan(0);
  });
});
