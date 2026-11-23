import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSnippet,
  createMindEngine,
  formatBriefMarkdown,
  formatCatMarkdown,
  formatChangesMarkdown,
  formatLsMarkdown,
  formatObjectsMarkdown,
  formatRecallMarkdown,
  formatReplayMarkdown,
  formatTagsMarkdown,
  formatThingsMarkdown,
  formatTreeMarkdown,
  parseSearchQuery,
  restoreWritablePermissions,
  type Actor,
  type EmbedderPort,
  type MindEngine,
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
const agentWorker: Actor = { id: "worker-1", kind: "agent", family: "gemini" };

function runCliJson(
  homeDir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): unknown {
  const out = execFileSync(
    process.execPath,
    [cliBin, "--home", homeDir, "--json", ...args],
    {
      encoding: "utf8",
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    },
  );
  return JSON.parse(out.trim()) as unknown;
}

function runCliText(
  homeDir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): string {
  return execFileSync(process.execPath, [cliBin, "--home", homeDir, ...args], {
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

function runCliFail(
  homeDir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): { status: number; stderr: string } {
  try {
    execFileSync(
      process.execPath,
      [cliBin, "--home", homeDir, "--json", ...args],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      },
    );
    throw new Error("Expected CLI command to fail");
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string | Buffer };
    return { status: e.status ?? 1, stderr: String(e.stderr ?? "") };
  }
}

describe("V0.2a-Polish: P0-1 zero-leak, O(1) queries, CJK bigrams, lexicographic ranking, nullable occurred_at, multi-supersedes DAG, importers & CLI/MCP", () => {
  it("1. P0-1 multi-branch zero-leak audit (JSON + Markdown): hidden ancestor paths, slugs, parentId, collision disambiguation, parentObjectId & opaque NOT_FOUND", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-p01-"),
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "HardWallOrg",
      policy: "tree",
    });

    // Hidden branch 1: /secret-branch-b1/shared-c1
    const B1 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "secret-branch-b1",
      name: "Secret Branch B1",
    });
    const C1 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: B1.id,
      slug: "shared-c1",
      name: "Shared C1 Primary",
    });
    // Hidden child under C1 (not visible to C2 via mount unless mounted directly)
    const D1 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: C1.id,
      slug: "deep-hidden-d1",
      name: "Deep Hidden D1",
    });

    // Second hidden branch with COLLIDING mounted leaf slug: /hidden-branch-b1b/shared-c1
    const B1b = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "hidden-branch-b1b",
      name: "Hidden Branch B1b",
    });
    const C1b = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: B1b.id,
      slug: "shared-c1",
      name: "Shared C1 Collision",
    });

    // Viewer branch: /classified-b2/viewer-c2 (Note: B2 IS ancestor of C2 so visible, B3 is hidden sibling)
    const B2 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "viewer-parent-b2",
      name: "Viewer Parent B2",
    });
    const C2 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: B2.id,
      slug: "viewer-c2",
      name: "Viewer C2",
    });
    const B3 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "classified-sibling-b3",
      name: "Classified Sibling B3",
    });

    // Mount both colliding leaves onto C2
    engine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: C2.id,
      targetRealmId: C1.id,
      scope: "all",
    });
    engine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: C2.id,
      targetRealmId: C1b.id,
      scope: "ledger",
    });

    // Hidden parent object in B1 referenced by child object in mounted C1
    const hiddenParentObj = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: B1.id,
      kind: "service",
      name: "B1HiddenParentObj",
    });
    const c1Obj = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: C1.id,
      parentObjectId: hiddenParentObj.id,
      kind: "service",
      name: "C1MountedObj",
    });

    const b1SecretRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: B1.id,
      kind: "decision",
      title: "B1_ANCESTOR_SECRET_REC",
    });
    const b3Rec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: B3.id,
      kind: "decision",
      title: "B3_SIBLING_SECRET_REC",
    });
    const c1Secret = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: C1.id,
      kind: "decision",
      title: "TOPSECRET_TOKEN_C1_999",
      sensitivity: "secret",
    });
    // C1 (whose ancestor is B1) cites both its own secret record and B1's record;
    // when C2 reads c1Rec via mount, BOTH hidden/secret refs MUST be sanitized away!
    const c1Rec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: C1.id,
      kind: "decision",
      title: "MOUNTED_C1_PUBLIC_DECISION",
      objectIds: [c1Obj.id],
      resourceTags: ["svc:shared-c1"],
      refs: [b1SecretRec.id, c1Secret.id],
      occurredAt: "2026-11-20T10:00:00.000Z",
    });
    const c1Thing = await engine.ledger.createThing({
      actor: humanAlice,
      viewerRealmId: C1.id,
      title: "C1 Thing Anchor",
      externalRef: "ticket:c1-101",
    });
    const c1bRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: C1b.id,
      kind: "decision",
      title: "MOUNTED_C1B_COLLISION_DECISION",
    });
    const c2Rec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: C2.id,
      kind: "decision",
      title: "C2_OWN_DECISION",
      refs: [c1Rec.id],
      occurredAt: "2026-11-20T11:00:00.000Z",
    });
    const c2Redacted = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: C2.id,
      kind: "decision",
      title: "REDACTED_CANARY_TOKEN_777",
    });
    engine.ledger.redact({
      actor: humanAlice,
      entryId: c2Redacted.id,
      reason: "test zero leak",
    });
    await engine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: C1.id,
      kind: "message",
      text: "C1 raw message should not be readable by C2",
    });
    await engine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: D1.id,
      kind: "message",
      text: "D1 hidden child raw",
    });

    // Collect EVERY read surface from C2 in BOTH JSON and Markdown
    const realms = engine.ledger.listRealms({
      orgId: org.id,
      viewerRealmId: C2.id,
    });
    const mountedC1 = realms.find((r) => r.id === C1.id)!;
    const mountedC1b = realms.find((r) => r.id === C1b.id)!;
    expect(mountedC1).toBeDefined();
    expect(mountedC1b).toBeDefined();
    expect(mountedC1.parentId).toBeNull();
    expect(mountedC1b.parentId).toBeNull();
    expect(mountedC1.path).toMatch(/^@mounted\/shared-c1/);
    expect(mountedC1b.path).toMatch(/^@mounted\/shared-c1/);
    expect(mountedC1.path).not.toBe(mountedC1b.path);

    const treeRes = engine.sea.tree({
      actor: agentWorker,
      viewerRealmId: C2.id,
      depth: "all",
    });
    const lsMounted = await engine.sea.ls({
      actor: agentWorker,
      viewerRealmId: C2.id,
      target: mountedC1.path,
    });
    const lsC2 = await engine.sea.ls({
      actor: agentWorker,
      viewerRealmId: C2.id,
      target: C2.path,
    });
    const briefC1 = engine.sea.brief({
      actor: agentWorker,
      viewerRealmId: C2.id,
      target: mountedC1.path,
    });
    const briefC2 = engine.sea.brief({
      actor: agentWorker,
      viewerRealmId: C2.id,
    });
    const recallAll = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: C2.id,
      query: "DECISION",
    });
    const catC1 = await engine.sea.cat({
      actor: agentWorker,
      viewerRealmId: C2.id,
      target: c1Rec.id,
    });
    const catC2 = await engine.sea.cat({
      actor: agentWorker,
      viewerRealmId: C2.id,
      target: c2Rec.id,
    });
    const replayC1 = engine.sea.replay({
      actor: agentWorker,
      viewerRealmId: C2.id,
      entryId: c1Rec.id,
    });
    const changesRes = engine.sea.changes({
      actor: agentWorker,
      viewerRealmId: C2.id,
      sinceSeq: 0,
    });
    const objectsRes = engine.objects.listObjects({
      viewerRealmId: C2.id,
    });
    const tagsRes = engine.objects.listResourceTags({
      viewerRealmId: C2.id,
    });
    const thingsRes = engine.ledger.listThings({
      actor: agentWorker,
      viewerRealmId: C2.id,
    });

    // Verify mounted object parent sanitized to null
    const visibleC1Obj = objectsRes.find((o) => o.id === c1Obj.id)!;
    expect(visibleC1Obj).toBeDefined();
    expect(visibleC1Obj.parentObjectId).toBeNull();
    expect(catC1.realmPath).toBe(mountedC1.path);
    expect(c1bRec.id).toBeTruthy();
    expect(c1Thing.id).toBeTruthy();

    // Forbidden strings MUST NEVER appear in ANY JSON or Markdown output
    const forbiddenTokens = [
      B1.id,
      B1b.id,
      B3.id,
      D1.id,
      "secret-branch-b1",
      "hidden-branch-b1b",
      "classified-sibling-b3",
      "deep-hidden-d1",
      hiddenParentObj.id,
      "B1HiddenParentObj",
      "TOPSECRET_TOKEN_C1_999",
      "B1_ANCESTOR_SECRET_REC",
      "B3_SIBLING_SECRET_REC",
      "REDACTED_CANARY_TOKEN_777",
      b1SecretRec.id,
      b3Rec.id,
      c1Secret.id,
    ];

    const surfaces = [
      JSON.stringify(realms),
      JSON.stringify(treeRes),
      formatTreeMarkdown(treeRes),
      JSON.stringify(lsMounted),
      formatLsMarkdown(lsMounted),
      JSON.stringify(lsC2),
      formatLsMarkdown(lsC2),
      JSON.stringify(briefC1),
      formatBriefMarkdown(briefC1),
      JSON.stringify(briefC2),
      formatBriefMarkdown(briefC2),
      JSON.stringify(recallAll),
      formatRecallMarkdown(recallAll),
      JSON.stringify(catC1),
      formatCatMarkdown(catC1),
      JSON.stringify(catC2),
      formatCatMarkdown(catC2),
      JSON.stringify(replayC1),
      formatReplayMarkdown(replayC1),
      JSON.stringify(changesRes),
      formatChangesMarkdown(changesRes),
      JSON.stringify(objectsRes),
      formatObjectsMarkdown(objectsRes),
      JSON.stringify(tagsRes),
      formatTagsMarkdown(tagsRes),
      JSON.stringify(thingsRes),
      formatThingsMarkdown(thingsRes.items, thingsRes.total),
    ];

    const combined = surfaces.join("\n");
    for (const secret of forbiddenTokens) {
      expect(combined).not.toContain(secret);
    }

    // Negative path-oracle test: real hidden-ancestor path MUST return opaque NOT_FOUND
    expect(() =>
      engine.sea.tree({
        actor: agentWorker,
        viewerRealmId: C2.id,
        target: "/secret-branch-b1/shared-c1",
      }),
    ).toThrow(/not found|not visible/i);
    await expect(
      engine.sea.ls({
        actor: agentWorker,
        viewerRealmId: C2.id,
        target: "/secret-branch-b1/shared-c1",
      }),
    ).rejects.toThrow(/not found|not visible/i);
    expect(() =>
      engine.sea.brief({
        actor: agentWorker,
        viewerRealmId: C2.id,
        target: "/secret-branch-b1/shared-c1",
      }),
    ).toThrow(/not found|not visible/i);
  });

  it("2. Constant O(1) SQL query count structural assertion across Small DB vs Large DB (50x scale) and limit=5 vs limit=50", async () => {
    const buildDb = async (
      prefix: string,
      realmCount: number,
      recordsPerRealm: number,
      objectsPerRealm: number,
    ) => {
      const engine = await createMindEngine({ homeDir: makeTempDir(prefix) });
      engines.push(engine);
      const { org, rootRealm } = engine.ledger.createOrg({
        name: `ScaleOrg-${prefix}`,
        policy: "open",
      });
      const realms = [rootRealm];
      const objects: string[] = [];
      for (let i = 0; i < realmCount; i += 1) {
        const r = engine.ledger.createRealm({
          actor: humanAlice,
          orgId: org.id,
          parentId: rootRealm.id,
          slug: `r-${i}`,
          name: `Realm ${i}`,
        });
        realms.push(r);
        for (let o = 0; o < objectsPerRealm; o += 1) {
          const obj = engine.objects.createObject({
            actor: humanAlice,
            viewerRealmId: r.id,
            kind: "service",
            name: `svc-${i}-${o}`,
          });
          objects.push(obj.id);
        }
        for (let k = 0; k < recordsPerRealm; k += 1) {
          await engine.ledger.appendRecord({
            actor: agentWorker,
            viewerRealmId: r.id,
            kind: k % 3 === 0 ? "finding" : "decision",
            title: `Scale benchmark gateway latency policy item ${i}-${k}`,
            objectIds: objects.length > 0 ? [objects[objects.length - 1]!] : [],
            resourceTags: [`svc:tier-${i % 5}`],
            occurredAt: `2026-11-${String((k % 20) + 1).padStart(2, "0")}T10:00:00.000Z`,
          });
        }
      }
      return { engine, org, rootRealm, sampleRealm: realms[1]!, sampleObj: objects[0]! };
    };

    const small = await buildDb("meru-scale-small-", 4, 5, 2); // 20 records, 8 objects
    const large = await buildDb("meru-scale-large-", 30, 30, 4); // 900 records, 120 objects

    const measure = async (
      ctx: Awaited<ReturnType<typeof buildDb>>,
      limit: number,
    ) => {
      const counts: Record<string, number> = {};

      ctx.engine.db.resetQueryCount();
      ctx.engine.sea.tree({
        actor: agentWorker,
        viewerRealmId: ctx.rootRealm.id,
        depth: 1,
      });
      counts.tree = ctx.engine.db.getQueryCount();

      ctx.engine.db.resetQueryCount();
      ctx.engine.sea.brief({
        actor: agentWorker,
        viewerRealmId: ctx.rootRealm.id,
      });
      counts.brief = ctx.engine.db.getQueryCount();

      ctx.engine.db.resetQueryCount();
      await ctx.engine.sea.ls({
        actor: agentWorker,
        viewerRealmId: ctx.rootRealm.id,
        target: ctx.sampleRealm.path,
        limit,
      });
      counts.lsRealm = ctx.engine.db.getQueryCount();

      ctx.engine.db.resetQueryCount();
      await ctx.engine.sea.ls({
        actor: agentWorker,
        viewerRealmId: ctx.rootRealm.id,
        target: `obj:${ctx.sampleObj}`,
        limit,
      });
      counts.lsObj = ctx.engine.db.getQueryCount();

      ctx.engine.db.resetQueryCount();
      await ctx.engine.sea.ls({
        actor: agentWorker,
        viewerRealmId: ctx.rootRealm.id,
        target: "tag:svc:tier-0",
        limit,
      });
      counts.lsTag = ctx.engine.db.getQueryCount();

      ctx.engine.db.resetQueryCount();
      await ctx.engine.sea.recall({
        actor: agentWorker,
        viewerRealmId: ctx.rootRealm.id,
        query: "gateway latency policy",
        limit,
      });
      counts.recall = ctx.engine.db.getQueryCount();

      return counts;
    };

    const smallQ5 = await measure(small, 5);
    const largeQ5 = await measure(large, 5);
    const largeQ50 = await measure(large, 50);

    // Every operation MUST execute in O(1) SQL queries regardless of 45x DB growth OR 10x limit!
    for (const op of [
      "tree",
      "brief",
      "lsRealm",
      "lsObj",
      "lsTag",
      "recall",
    ] as const) {
      expect(largeQ5[op]!).toBeLessThanOrEqual(35);
      expect(Math.abs(largeQ5[op]! - smallQ5[op]!)).toBeLessThanOrEqual(5);
      expect(Math.abs(largeQ50[op]! - largeQ5[op]!)).toBeLessThanOrEqual(5);
    }
  });

  it("3. CJK intact bigrams (上线/下线/在线), 1-char 锁, natural Chinese question, 0.75 threshold & explicit Pass 1 -> JS Tier 4 vs Tier 3 assignment", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-cjk-"),
    });
    engines.push(engine);
    const { rootRealm } = engine.ledger.createOrg({
      name: "CjkOrg",
      policy: "open",
    });

    // A) Intra-word CJK chars MUST NEVER be deleted: 上线 / 下线 / 在线
    const pOnline = parseSearchQuery("现在上线东京生产了吗");
    const onlineTerms = pOnline.concepts.flatMap((c) => c.terms);
    expect(onlineTerms).toContain("上线");
    expect(onlineTerms).toContain("东京");
    expect(onlineTerms).toContain("生产");

    const pOffline = parseSearchQuery("下线旧网关");
    expect(pOffline.concepts.flatMap((c) => c.terms)).toContain("下线");

    const pActiveUsers = parseSearchQuery("在线人数统计");
    expect(pActiveUsers.concepts.flatMap((c) => c.terms)).toContain("在线");

    const pSingleChar = parseSearchQuery("锁");
    expect(pSingleChar.concepts.length).toBe(1);
    expect(pSingleChar.concepts[0]!.terms).toEqual(["锁"]);

    const tokyoLaunch = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "东京生产集群已正式上线",
      payload: { detail: "东京生产区域完成上线验证" },
    });
    const offlineGateway = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "完成下线旧网关节点",
    });
    const onlineCount = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "峰值在线人数达到五万",
    });
    const lockDoc = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "分布式锁超时排查",
    });

    const rTokyo = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "现在上线东京生产了吗",
    });
    expect(rTokyo.items[0]?.id).toBe(tokyoLaunch.id);

    const rOffline = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "下线旧网关",
    });
    expect(rOffline.items[0]?.id).toBe(offlineGateway.id);

    const rOnlineCount = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "在线人数",
    });
    expect(rOnlineCount.items[0]?.id).toBe(onlineCount.id);

    const rLock = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "锁",
    });
    expect(rLock.items.some((i) => i.id === lockDoc.id)).toBe(true);

    // B) Natural mixed CJK+English question ranks exact target #1 over distractors
    const targetDeletion = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "从主仓移除 openspec 临时目录的原因",
      payload: {
        body: "上次决定把 openspec 历史草稿从主仓删掉，因为规格已经迁移到独立目录。",
      },
    });
    await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "主仓 CI 构建优化",
      payload: { body: "主仓日常维护记录" },
    });
    await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "openspec 校验工具安装",
      payload: { body: "安装 openspec CLI" },
    });

    const rNatural = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "上次为什么把 openspec 从主仓删掉了",
    });
    expect(rNatural.items[0]?.id).toBe(targetDeletion.id);

    // C) Opus Note 2: Explicit Pass 1 -> JS Tier 4 (title >= 0.75) vs Tier 3 (body >= 0.75)
    // Both docs match Pass 1 (AND of concepts), and bodyDoc has MUCH higher body TF!
    const titleTier4 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "canary-alpha canary-beta rollout",
      payload: { body: "brief note" },
      occurredAt: "2026-11-10T10:00:00.000Z",
    });
    const bodyTier3 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "weekly deployment summary",
      payload: {
        body: "canary-alpha canary-beta canary-alpha canary-beta canary-alpha canary-beta",
      },
      occurredAt: "2026-11-20T10:00:00.000Z",
    });
    const tierCheck = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "canary-alpha canary-beta",
    });
    expect(tierCheck.items[0]?.id).toBe(titleTier4.id);
    expect(tierCheck.items[1]?.id).toBe(bodyTier3.id);

    // D) CJK 0.75 coverage threshold: 3/4 bigrams (0.75 -> full coverage Tier 4) beats 2/4 (0.50 -> partial Tier 1)
    // 5-char CJK segment "风控策略库" -> 4 bigrams: ["风控", "控策", "策略", "略库"]
    const fullCjk75 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "风控策略与略库升级", // matches 风控, 控策, 策略, 略库 (actually 4/4 or 3/4)
      occurredAt: "2026-11-01T00:00:00.000Z",
    });
    const halfCjk50 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "风控与策略介绍", // matches only 2/4: 风控, 策略 (0.50 < 0.75)
      occurredAt: "2026-11-21T00:00:00.000Z",
    });
    const thresholdRes = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "风控策略库",
    });
    expect(thresholdRes.items[0]?.id).toBe(fullCjk75.id);
    expect(thresholdRes.items[1]?.id).toBe(halfCjk50.id);
  });

  it("4. Opus Note 1 BM25 sign-direction pin, strict lexicographic ranking, vector Tier 2 > weak lexical Tier 1, isOlderSameObjectSibling transitivity & shared snippet", async () => {
    const dim = 8;
    const mkVec = (vals: number[]): Float32Array => {
      const arr = new Float32Array(dim);
      let norm = 0;
      for (let i = 0; i < vals.length; i += 1) {
        arr[i] = vals[i]!;
        norm += vals[i]! * vals[i]!;
      }
      const s = Math.sqrt(norm) || 1;
      for (let i = 0; i < dim; i += 1) arr[i] = arr[i]! / s;
      return arr;
    };
    const fakeEmbedder: EmbedderPort = {
      configured: true,
      dimensions: dim,
      async embed(text: string): Promise<Float32Array | null> {
        if (
          text.includes("SEMANTIC_ONLY_CANARY") ||
          text === "lextoken nonexistentalpha nonexistentbeta"
        ) {
          return mkVec([1, 0, 0, 0, 0, 0, 0, 0]);
        }
        if (text.includes("SIBLING_TRANSITIVITY_CANARY")) {
          return mkVec([0, 0, 1, 0, 0, 0, 0, 0]);
        }
        return mkVec([0, 1, 0, 0, 0, 0, 0, 0]);
      },
    };

    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-rank-"),
      embedder: fakeEmbedder,
    });
    engines.push(engine);
    const { org, rootRealm } = engine.ledger.createOrg({
      name: "RankOrg",
      policy: "open",
    });
    const realmA = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "alpha",
      name: "Alpha",
    });
    const realmB = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "beta",
      name: "Beta",
    });

    // A) Explicit BM25 sign-direction unit test (SQLite bm25() is NEGATIVE; score = -bm25!)
    // Create 10 docs in the same tier so 15% top band vs tail band is cleanly separated.
    // Strongest doc is in non-focus realmB; weakest doc is in focus realmA.
    const filler = Array.from({ length: 60 }, (_, i) => `fillerword${i}`).join(" ");
    const weakFocus = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmA.id,
      kind: "decision",
      title: "BM25SIGN_TOKEN once",
      payload: { body: `${filler} ${filler}` },
      occurredAt: "2026-11-21T10:00:00.000Z",
    });
    for (let i = 0; i < 8; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: realmA.id,
        kind: "decision",
        title: `BM25SIGN_TOKEN mid-${i}`,
        payload: { body: `${filler} BM25SIGN_TOKEN` },
        occurredAt: "2026-11-15T10:00:00.000Z",
      });
    }
    const strongOther = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmB.id,
      kind: "decision",
      title: "BM25SIGN_TOKEN BM25SIGN_TOKEN BM25SIGN_TOKEN",
      payload: {
        body: "BM25SIGN_TOKEN BM25SIGN_TOKEN BM25SIGN_TOKEN BM25SIGN_TOKEN",
      },
      occurredAt: "2026-11-01T10:00:00.000Z",
    });

    const bm25Check = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmA.id,
      query: "BM25SIGN_TOKEN",
      focusBoost: true, // Even WITH focusBoost ON, top BM25 band in realmB MUST beat tail band in realmA!
      limit: 20,
    });
    expect(bm25Check.items[0]?.id).toBe(strongOther.id);
    expect(
      bm25Check.items.findIndex((i) => i.id === strongOther.id),
    ).toBeLessThan(bm25Check.items.findIndex((i) => i.id === weakFocus.id));

    // B) Pure vector Tier 2 (cosine >= 0.75) beats weak 1-of-3 lexical partial hit (Tier 1)
    if (engine.db.vecEnabled) {
      const vecDoc = await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: realmA.id,
        kind: "decision",
        title: "SEMANTIC_ONLY_CANARY architecture rationale",
        occurredAt: "2026-11-10T00:00:00.000Z",
      });
      const weakLex = await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: realmA.id,
        kind: "decision",
        title: "lextoken partial mention only",
        occurredAt: "2026-11-21T00:00:00.000Z",
      });
      await engine.sea.syncEmbeddings();
      const hybridRes = await engine.sea.recall({
        actor: agentWorker,
        viewerRealmId: realmA.id,
        query: "lextoken nonexistentalpha nonexistentbeta",
      });
      expect(hybridRes.items[0]?.id).toBe(vecDoc.id);
      expect(
        hybridRes.items.findIndex((i) => i.id === vecDoc.id),
      ).toBeLessThan(hybridRes.items.findIndex((i) => i.id === weakLex.id));
    }

    // C) isOlderSameObjectSibling strict total-order transitivity across overlapping objectIds
    const obj1 = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: realmA.id,
      kind: "service",
      name: "SiblingObj1",
    });
    const obj2 = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: realmA.id,
      kind: "service",
      name: "SiblingObj2",
    });
    // All 4 share identical text so exact same tier/band/status -> tests unary isOlderSameObjectSibling!
    const s1 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmA.id,
      kind: "decision",
      title: "SIBLING_TRANSITIVITY_CANARY",
      objectIds: [obj1.id],
      occurredAt: "2026-11-01T00:00:00.000Z", // older sibling of obj1 (isOlder=1)
    });
    const s2 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmA.id,
      kind: "decision",
      title: "SIBLING_TRANSITIVITY_CANARY",
      objectIds: [obj1.id, obj2.id],
      occurredAt: "2026-11-05T00:00:00.000Z", // newest of obj1, older of obj2 (isOlder=1 because obj2 has newer s3!)
    });
    const s3 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmA.id,
      kind: "decision",
      title: "SIBLING_TRANSITIVITY_CANARY",
      objectIds: [obj2.id],
      occurredAt: "2026-11-10T00:00:00.000Z", // newest of obj2 (isOlder=0)
    });
    const s4NoObj = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmA.id,
      kind: "decision",
      title: "SIBLING_TRANSITIVITY_CANARY",
      occurredAt: "2026-11-03T00:00:00.000Z", // no object (isOlder=0), deliberately OLDER than s2 (Nov 05) to kill Z3 mutation!
    });

    const sibRes = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmA.id,
      query: "SIBLING_TRANSITIVITY_CANARY",
    });
    // Expected strict order:
    // isOlder=0 group first by occurredAt DESC: s3 (Nov 10), s4NoObj (Nov 03)
    // isOlder=1 group second by occurredAt DESC: s2 (Nov 05), s1 (Nov 01)
    // Note: without isOlderSameObjectSibling, pure time sort would give [s3, s2, s4NoObj, s1]!
    expect(sibRes.items.map((i) => i.id)).toEqual([
      s3.id,
      s4NoObj.id,
      s2.id,
      s1.id,
    ]);

    // D) Shared snippet extractor: centers on matched concept & strips internal metadata keys
    const longPrefix = "Introductory background section. ".repeat(15);
    const snippet = buildSnippet({
      payload: {
        contentSha256: "deadbeef1234567890abcdef",
        frontmatter: { internalKey: "should_never_leak" },
        body: `${longPrefix}The payment-router circuit breaker trips at 500ms latency.${longPrefix}`,
      },
      concepts: [{ raw: "payment-router" }],
      maxLen: 140,
    });
    expect(snippet).toContain("payment-router");
    expect(snippet).not.toContain("contentSha256");
    expect(snippet).not.toContain("deadbeef");
  });

  it("5. Nullable occurred_at (P1-6), multi-predecessor supersedes DAG atomic CAS (P1-2), and orphan superseded ingestion (P1-3)", async () => {
    const homeDir = makeTempDir("meru-mind-dag-");
    const engine = await createMindEngine({ homeDir });
    engines.push(engine);
    const { org, rootRealm } = engine.ledger.createOrg({
      name: "DagOrg",
      policy: "open",
    });

    // A) Nullable occurred_at preserved across Ledger, Seabed, filtering, sorting, replay
    const dated = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "UNDATED_TEST_TOKEN dated",
      occurredAt: "2026-11-10T10:00:00.000Z",
    });
    const undated = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "UNDATED_TEST_TOKEN undated",
      occurredAt: null,
    });
    const undatedRaw = await engine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "UNDATED_TEST_TOKEN raw null",
      occurredAt: null,
    });
    expect(undated.occurredAt).toBeNull();
    expect(undatedRaw.occurredAt).toBeNull();

    // since/until MUST exclude NULL occurred_at rows across ALL paths:
    // 1) FTS recall (Stage 3)
    const rangeFiltered = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "UNDATED_TEST_TOKEN",
      since: "2026-01-01T00:00:00.000Z",
      until: "2027-01-01T00:00:00.000Z",
    });
    expect(rangeFiltered.items.map((i) => i.id)).toEqual([dated.id]);

    // 2) Structured recall with NO query (Stage 2 SQL path) on since-only and until-only
    const structuredSinceOnly = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(structuredSinceOnly.items.some((i) => i.id === dated.id)).toBe(true);
    expect(structuredSinceOnly.items.some((i) => i.id === undated.id)).toBe(false);
    expect(structuredSinceOnly.items.some((i) => i.id === undatedRaw.id)).toBe(false);

    const structuredUntilOnly = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      until: "2027-01-01T00:00:00.000Z",
    });
    expect(structuredUntilOnly.items.some((i) => i.id === dated.id)).toBe(true);
    expect(structuredUntilOnly.items.some((i) => i.id === undated.id)).toBe(false);
    expect(structuredUntilOnly.items.some((i) => i.id === undatedRaw.id)).toBe(false);

    // 3) Direct SqliteDb listRecords & listSeabedEntries SQL guards on BOTH since and until
    const datedRaw = await engine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "UNDATED_TEST_TOKEN raw dated",
      occurredAt: "2026-11-11T10:00:00.000Z",
    });
    const recSince = engine.db.listRecords({
      realmIds: [rootRealm.id],
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(recSince.items.map((r) => r.id)).toEqual([dated.id]);
    expect(recSince.total).toBe(1);
    const recUntil = engine.db.listRecords({
      realmIds: [rootRealm.id],
      until: "2027-01-01T00:00:00.000Z",
    });
    expect(recUntil.items.map((r) => r.id)).toEqual([dated.id]);
    expect(recUntil.total).toBe(1);

    const seaSince = engine.db.listSeabedEntries({
      realmIds: [rootRealm.id],
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(seaSince.items.map((s) => s.id)).toEqual([datedRaw.id]);
    expect(seaSince.total).toBe(1);
    const seaUntil = engine.db.listSeabedEntries({
      realmIds: [rootRealm.id],
      until: "2027-01-01T00:00:00.000Z",
    });
    expect(seaUntil.items.map((s) => s.id)).toEqual([datedRaw.id]);
    expect(seaUntil.total).toBe(1);

    // Unfiltered recency MUST sort dated strictly before undated
    const unfiltered = await engine.sea.ls({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      target: rootRealm.path,
    });
    const idxDated = unfiltered.items.findIndex((i) => i.id === dated.id);
    const idxUndated = unfiltered.items.findIndex((i) => i.id === undated.id);
    expect(idxDated).toBeGreaterThanOrEqual(0);
    expect(idxUndated).toBeGreaterThan(idxDated);

    // replay on undated anchor falls back to created_at
    const replayUndated = engine.sea.replay({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      entryId: undated.id,
    });
    expect(replayUndated.timeBasis).toBe("created_at");
    const replayDated = engine.sea.replay({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      entryId: dated.id,
    });
    expect(replayDated.timeBasis).toBe("occurred_at");

    // B) Multi-predecessor supersedesIds atomic CAS + all-or-nothing rollback
    const predA = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Pred A",
      occurredAt: "2026-11-01T00:00:00.000Z",
    });
    const predB = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Pred B",
      occurredAt: "2026-11-02T00:00:00.000Z",
    });
    const merged = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Merged A+B",
      supersedesIds: [predA.id, predB.id, predA.id], // duplicates deduplicated
      occurredAt: "2026-11-03T00:00:00.000Z",
    });
    expect(merged.supersedesIds).toEqual([predA.id, predB.id]);
    expect(merged.supersedesId).toBe(predA.id);
    expect(engine.db.getRecord(predA.id)?.status).toBe("superseded");
    expect(engine.db.getRecord(predB.id)?.status).toBe("superseded");

    const dagChain = engine.ledger.getSupersedeChain({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      recordId: predB.id,
    });
    expect(dagChain.nodes.map((n) => n.id)).toEqual([
      predA.id,
      predB.id,
      merged.id,
    ]);
    expect(dagChain.currentHeadId).toBe(merged.id);
    expect(dagChain.orphanSuperseded).toBe(false);

    // Atomic all-or-nothing rollback when second predecessor is already superseded
    const predC = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Pred C still active",
    });
    await expect(
      engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "decision",
        title: "Should rollback",
        supersedesIds: [predC.id, predA.id], // predA already superseded!
      }),
    ).rejects.toThrow(/superseded|CONFLICT/i);
    expect(engine.db.getRecord(predC.id)?.status).toBe("active");

    // C) Orphan superseded ingestion (initialStatus: "superseded") & rejection of "retracted"
    await expect(
      engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "decision",
        title: "Invalid retracted status",
        initialStatus: "retracted" as unknown as "superseded",
      }),
    ).rejects.toThrow(/INVALID_INPUT|active.*superseded/i);

    const orphan = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "ORPHAN_HISTORICAL_TOKEN",
      initialStatus: "superseded",
      occurredAt: "2026-10-01T00:00:00.000Z",
    });
    expect(orphan.status).toBe("superseded");
    expect(orphan.supersededById).toBeNull();

    // Un-supersedable via CAS
    await expect(
      engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "decision",
        title: "Cannot supersede orphan",
        supersedesId: orphan.id,
      }),
    ).rejects.toThrow(/already superseded|CONFLICT/i);

    const orphanChain = engine.ledger.getSupersedeChain({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      recordId: orphan.id,
    });
    expect(orphanChain.currentHeadId).toBeNull();
    expect(orphanChain.orphanSuperseded).toBe(true);

    const orphanCat = await engine.sea.cat({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      target: orphan.id,
    });
    expect(orphanCat.kind === "record" && orphanCat.orphanSuperseded).toBe(true);

    const orphanRecall = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "ORPHAN_HISTORICAL_TOKEN",
      includeSuperseded: true,
    });
    expect(orphanRecall.items[0]?.id).toBe(orphan.id);
    expect(orphanRecall.items[0]?.orphanSuperseded).toBe(true);
    expect(orphanRecall.items[0]?.currentHeadId).toBeNull();

    // CLI --occurred-at none & MCP occurred_at: null
    const cliNull = runCliJson(homeDir, [
      "write",
      "--in",
      rootRealm.path,
      "--kind",
      "decision",
      "--title",
      "CLI Undated Entry",
      "--body",
      "CLI undated decision body.",
      "--occurred-at",
      "none",
    ]) as { occurredAt: string | null };
    expect(cliNull.occurredAt).toBeNull();

    const mcpTransport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpBin],
      env: {
        ...process.env,
        MERU_MIND_HOME: homeDir,
        MERU_MIND_ORG_ID: org.id,
        MERU_MIND_ACTOR_ID: "mcp-null-bot",
      },
    });
    const mcpClient = new Client({ name: "null-client", version: "0.2.0" });
    await mcpClient.connect(mcpTransport);
    try {
      const mcpRes = await mcpClient.callTool({
        name: "mind_write",
        arguments: {
          in: rootRealm.path,
          kind: "decision",
          title: "MCP Undated Entry",
          body: "MCP undated decision body.",
          occurred_at: null,
        },
      });
      const parsed = JSON.parse(
        (mcpRes.content as Array<{ text?: string }>)[0]?.text ?? "{}",
      ) as { occurredAt: string | null };
      expect(parsed.occurredAt).toBeNull();
    } finally {
      await mcpClient.close();
    }
  });

  it("6. Unified importers (import-md & import-jsonl), verifyImportConsistency / import-verify & change_log P2-4 tag entity_id", async () => {
    const homeDir = makeTempDir("meru-mind-imp-");
    const srcDir = makeTempDir("meru-mind-imp-src-");
    const engine = await createMindEngine({ homeDir });
    engines.push(engine);
    const { rootRealm } = engine.ledger.createOrg({
      name: "ImportOrg",
      policy: "open",
    });

    // Markdown files: dated by filename pattern, expired valid_until, undated
    fs.writeFileSync(
      path.join(srcDir, "2026-10-15-active-note.md"),
      "---\ntitle: Active Note\nstatus: current\n---\nActive content here.\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(srcDir, "expired-note.md"),
      "---\ntitle: Expired Note\nvalid_until: 2020-01-01T00:00:00.000Z\n---\nExpired content.\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(srcDir, "undated-note.md"),
      "# Undated Guide\nNo date anywhere.\n",
      "utf8",
    );

    const mapping = {
      filenameDatePattern: "^(\\d{4}-\\d{2}-\\d{2})",
      statusMap: { current: "active", archived: "superseded" } as Record<
        string,
        "active" | "superseded"
      >,
      validUntil: "valid_until",
    };
    const mapFile = path.join(srcDir, "map.json");
    fs.writeFileSync(mapFile, JSON.stringify(mapping), "utf8");

    const mdRes = await engine.importer.importMd({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      targetRealmRef: rootRealm.path,
      inputPath: srcDir,
      mapping,
    });
    expect(mdRes.created).toBe(3);
    expect(mdRes.undatedCount).toBe(2); // expired-note.md + undated-note.md have no occurred_at
    expect(mdRes.defaultRealmCount).toBe(3);

    // Reject mapping to "retracted"
    fs.writeFileSync(
      path.join(srcDir, "bad-status.md"),
      "---\ntitle: Bad\nstatus: deleted\n---\nBody\n",
      "utf8",
    );
    await expect(
      engine.importer.importMd({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        targetRealmRef: rootRealm.path,
        inputPath: path.join(srcDir, "bad-status.md"),
        mapping: {
          statusMap: { deleted: "retracted" as unknown as "superseded" },
        },
      }),
    ).rejects.toThrow(/INVALID_INPUT|retracted|active.*superseded/i);
    fs.unlinkSync(path.join(srcDir, "bad-status.md"));

    // Clean verifyImportConsistency passes (via API & CLI)
    const verifyClean = engine.importer.verifyImportConsistency({
      viewerRealmId: rootRealm.id,
      sourcePath: srcDir,
      mapping,
    });
    expect(verifyClean.passed).toBe(true);
    expect(verifyClean.activeSupersededMismatches).toHaveLength(0);
    expect(verifyClean.timestampMismatches).toHaveLength(0);

    const cliVerifyClean = runCliJson(homeDir, [
      "import",
      "verify",
      "--source",
      srcDir,
      "--map",
      mapFile,
    ]) as { passed: boolean };
    expect(cliVerifyClean.passed).toBe(true);

    // Corrupt a DB row status to prove verifyImportConsistency catches drift!
    const activeItem = mdRes.items.find((i) =>
      i.sourceRef.includes("2026-10-15-active-note.md"),
    )!;
    const rawConn = new DatabaseSync(path.join(homeDir, "mind.sqlite"));
    try {
      rawConn
        .prepare("UPDATE records SET status = 'superseded' WHERE id = ?")
        .run(activeItem.recordId!);

      const verifyDrift = engine.importer.verifyImportConsistency({
        viewerRealmId: rootRealm.id,
        sourcePath: srcDir,
        mapping,
      });
      expect(verifyDrift.passed).toBe(false);
      expect(verifyDrift.activeSupersededMismatches.length).toBe(1);

      // JSONL with array supersedes + orphan superseded
      const jsonlFile = path.join(srcDir, "events.jsonl");
      const rows = [
        { id: "j1", title: "J1", occurred_at: "2026-11-01T00:00:00Z" },
        { id: "j2", title: "J2", occurred_at: "2026-11-02T00:00:00Z" },
        {
          id: "j3",
          title: "J3 merged",
          occurred_at: "2026-11-03T00:00:00Z",
          supersedes: ["j1", "j2"],
        },
        { id: "j4", title: "J4 orphan", status: "superseded" },
      ];
      fs.writeFileSync(
        jsonlFile,
        rows.map((r) => JSON.stringify(r)).join("\n"),
        "utf8",
      );
      const jsonlRes = await engine.importer.importJsonl({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        targetRealmRef: rootRealm.path,
        jsonlPath: jsonlFile,
        mapping: {
          id: "id",
          sourceRef: "id",
          title: "title",
          occurredAt: "occurred_at",
          supersedes: "supersedes",
          status: "status",
        },
      });
      expect(jsonlRes.imported).toBe(4);
      expect(jsonlRes.superseded).toBe(1);
      expect(jsonlRes.undatedCount).toBe(1);

      // P2-4: tagEntryResource writes ONLY entryId in change_log.entity_id (no tag text, no colon)
      engine.objects.tagEntryResource({
        actor: agentWorker,
        viewerRealmId: rootRealm.id,
        entryId: activeItem.recordId!,
        tag: "svc:sensitive-internal-tag",
      });
      const tagLogRow = rawConn
        .prepare(
          "SELECT entity_id FROM change_log WHERE entity_type = 'resource_tag' ORDER BY seq DESC LIMIT 1",
        )
        .get() as { entity_id: string };
      expect(tagLogRow.entity_id).toBe(activeItem.recordId);
      expect(tagLogRow.entity_id).not.toContain("sensitive-internal-tag");
      expect(tagLogRow.entity_id).not.toContain(":");
    } finally {
      rawConn.close();
    }
  });

  it("7. CLI/MCP unification: --realm removal, tree MERU_MIND_VIEWER_REALM_ID & --as-human whitelist, typed ls refs, tree count semantics (null/—), truncation hints & EPIPE", async () => {
    const homeDir = makeTempDir("meru-mind-cli-polish-");
    const init = runCliJson(homeDir, [
      "admin",
      "init",
      "--org",
      "CliPolishTree",
      "--policy",
      "tree",
    ]) as { org: { id: string }; rootRealm: { id: string } };

    // 1) --realm removed everywhere with self-correcting unknown_flag message
    const realmFlagErr = runCliFail(homeDir, [
      "tree",
      "--realm",
      init.rootRealm.id,
    ]);
    expect(realmFlagErr.status).not.toBe(0);
    expect(realmFlagErr.stderr).toContain('"unknown_flag"');
    expect(realmFlagErr.stderr).toContain("--realm");
    expect(realmFlagErr.stderr).toContain("--in");

    // 2) Missing MERU_MIND_VIEWER_REALM_ID in tree org fails on normal commands with non-root self-correcting hint
    const missingEnvErr = runCliFail(homeDir, ["tree"]);
    expect(missingEnvErr.status).not.toBe(0);
    expect(missingEnvErr.stderr).toContain('"not_bound"');
    expect(missingEnvErr.stderr).toContain("MERU_MIND_VIEWER_REALM_ID");
    expect(missingEnvErr.stderr).not.toContain("MERU_MIND_VIEWER_REALM_ID=/ ");
    expect(missingEnvErr.stderr).toContain("/team/project");

    // 3) --as-human org-admin whitelist works WITHOUT MERU_MIND_VIEWER_REALM_ID
    const child = runCliJson(homeDir, [
      "--as-human",
      "realm",
      "create",
      "--org",
      init.org.id,
      "--parent",
      init.rootRealm.id,
      "--slug",
      "ops",
      "--name",
      "Ops",
      "--scope",
      "Ops work",
    ]) as { id: string; path: string };
    expect(child.path).toBe("/ops");

    // 4) Bare unknown ls target rejected with invalid_ref hint
    const bareLsErr = runCliFail(homeDir, ["ls", "ambiguous-bare-name"], {
      MERU_MIND_VIEWER_REALM_ID: child.id,
    });
    expect(bareLsErr.status).not.toBe(0);
    expect(bareLsErr.stderr).toContain('"invalid_ref"');

    // 4b) Removed legacy `cat` command returns unknown_command with exact show replacement
    const catLegacyErr = runCliFail(homeDir, ["cat", "rec_nonexistent"], {
      MERU_MIND_VIEWER_REALM_ID: child.id,
    });
    expect(catLegacyErr.status).not.toBe(0);
    expect(catLegacyErr.stderr).toContain('"unknown_command"');
    expect(catLegacyErr.stderr).toContain("meru-mind show");

    // 5) tree count semantics:
    // - Viewing from child `/ops`: ancestor `/` is direct-only (subtreeConclusions === null), self `/ops` has directRaw === 1 & subtreeConclusions === 0
    // - Viewing from parent `/`: descendant `/ops` seabed is unreadable so directRaw === null in JSON & `raw=—` in Markdown (NEVER 0 or 1!)
    runCliJson(
      homeDir,
      [
        "raw",
        "add",
        "--in",
        child.path,
        "--kind",
        "message",
        "--text",
        "ops raw msg",
      ],
      { MERU_MIND_VIEWER_REALM_ID: child.id },
    );
    type TreeNodeShape = {
      realm: { id: string; path: string };
      counts: {
        directRaw: number | null;
        subtreeConclusions: number | null;
      };
      children: TreeNodeShape[];
    };

    const treeFromChild = runCliJson(homeDir, ["tree", "-L", "all"], {
      MERU_MIND_VIEWER_REALM_ID: child.id,
    }) as { realmTree: TreeNodeShape[] };
    const ancestorRoot = treeFromChild.realmTree.find(
      (n) => n.realm.id === init.rootRealm.id,
    )!;
    expect(ancestorRoot.counts.subtreeConclusions).toBeNull(); // direct-only on ancestor!
    const selfOps = ancestorRoot.children.find((n) => n.realm.id === child.id)!;
    expect(selfOps.counts.directRaw).toBe(1);
    expect(selfOps.counts.subtreeConclusions).toBe(0); // rollup allowed on self!

    const treeFromRoot = runCliJson(homeDir, ["tree", "-L", "all"], {
      MERU_MIND_VIEWER_REALM_ID: init.rootRealm.id,
    }) as { realmTree: TreeNodeShape[] };
    const selfRoot = treeFromRoot.realmTree.find(
      (n) => n.realm.id === init.rootRealm.id,
    )!;
    const descendantOps = selfRoot.children.find((n) => n.realm.id === child.id)!;
    expect(descendantOps.counts.directRaw).toBeNull(); // unreadable descendant raw MUST be null, NEVER 0!

    const treeMdFromRoot = runCliText(homeDir, ["tree", "-L", "all"], {
      MERU_MIND_VIEWER_REALM_ID: init.rootRealm.id,
    });
    expect(treeMdFromRoot).toContain("raw=—");
    const treeMdFromChild = runCliText(homeDir, ["tree", "-L", "all"], {
      MERU_MIND_VIEWER_REALM_ID: child.id,
    });
    expect(treeMdFromChild).toContain("raw=1");

    // 6) Line cap truncation prints next-hop drill-down hint
    const cappedMd = runCliText(homeDir, ["tree", "-L", "all", "--limit", "3"], {
      MERU_MIND_VIEWER_REALM_ID: child.id,
    });
    expect(cappedMd).toContain("... and");
    expect(cappedMd).toContain("meru-mind tree");

    // 7) EPIPE graceful exit(0) when downstream pipe closes early
    const epipeResult = await new Promise<{ code: number | null; stderr: string }>(
      (resolve, reject) => {
        const childProc = spawn(
          process.execPath,
          [cliBin, "--home", homeDir, "--help"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        childProc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        childProc.stdout.once("data", () => {
          childProc.stdout.destroy();
        });
        childProc.on("error", reject);
        childProc.on("close", (code) => resolve({ code, stderr }));
      },
    );
    expect(epipeResult.code).toBe(0);
    // Node 22 emits an ExperimentalWarning for built-in node:sqlite on stderr;
    // strip only that runtime banner so any EPIPE/stack-trace output still fails.
    const cleanedStderr = epipeResult.stderr
      .split("\n")
      .filter(
        (line) =>
          !/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/.test(
            line,
          ) && !/^\(Use `node --trace-warnings/.test(line),
      )
      .join("\n")
      .trim();
    expect(cleanedStderr).toBe("");
  });
});
