import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCanonicalEntryContent,
  createMindEngine,
  formatSearchMarkdown,
  formatShowMarkdown,
  normalizeForFts,
  parseSearchQuery,
  windowText,
  type Actor,
  type EmbedderPort,
  type MindEngine,
} from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliBin = path.join(repoRoot, "dist", "cli.js");
const mcpBin = path.join(repoRoot, "dist", "mcp.js");

const tempDirs: string[] = [];
const engines: MindEngine[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const humanAlice: Actor = { id: "alice", kind: "human" };
const agentWorker: Actor = { id: "worker-1", kind: "agent", family: "claude" };

function runCli(
  homeDir: string,
  args: string[],
  envExtra?: Record<string, string>,
): string {
  return execFileSync(process.execPath, [cliBin, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      MERU_MIND_HOME: homeDir,
      ...envExtra,
    },
  });
}

function runCliFail(
  homeDir: string,
  args: string[],
  envExtra?: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  try {
    const out = runCli(homeDir, args, envExtra);
    throw new Error(`Expected CLI failure, but succeeded with: ${out}`);
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: Number(e.status ?? 1),
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

afterEach(async () => {
  while (engines.length > 0) {
    const eng = engines.pop()!;
    try {
      await eng.close();
    } catch {
      // already closed
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("V0.2a-Perf & Show-Window: Migration v6, Covering Indexes, CJK Bigrams, Unified FTS, Bounded Show & Compact MCP", () => {
  it("1. EXPLAIN QUERY PLAN: covering indexes + zero temp B-tree on counts & direct ls (both secret and secret+confidential) + disjoint UNION ALL ls", async () => {
    const homeDir = makeTempDir("meru-mind-v6-eqp-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "EqpOrg",
      policy: "open",
    });
    const realmB = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "beta",
      name: "Beta",
    });
    const objInRoot = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "service",
      name: "gateway",
    });

    const directRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Root direct decision",
      objectIds: [objInRoot.id],
    });
    const linkedFromBeta = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmB.id,
      kind: "finding",
      title: "Beta linked to root object",
      objectIds: [objInRoot.id],
    });
    const directSea = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "Root raw message",
      objectIds: [objInRoot.id],
    });
    const linkedSeaFromBeta = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: realmB.id,
      kind: "message",
      text: "Beta raw linked to root object",
      objectIds: [objInRoot.id],
    });

    // Disjoint UNION ALL must return all 4 entries with ZERO duplicates and exact total=4
    const lsRoot = engine.db.lsRealmEntriesUnified({
      orgId: org.id,
      targetRealmId: rootRealm.id,
      includePhysicalLedger: true,
      includePhysicalSeabed: true,
      includeObjectLinkedOpenMode: true,
      includeSuperseded: false,
      limit: 20,
      offset: 0,
    });
    expect(lsRoot.total).toBe(4);
    expect(new Set(lsRoot.rows.map((r) => r.id))).toEqual(
      new Set([
        directRec.id,
        linkedFromBeta.id,
        directSea.id,
        linkedSeaFromBeta.id,
      ]),
    );

    // Populate enough rows so SQLite's planner exercises real index selection under ANALYZE
    for (let i = 0; i < 60; i += 1) {
      const targetR = i % 2 === 0 ? rootRealm.id : realmB.id;
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: targetR,
        kind: "decision",
        title: `Filler rec ${i}`,
        objectIds: i % 10 === 0 ? [objInRoot.id] : [],
      });
      await engine.ledger.captureSeabed({
        actor: agentWorker,
        viewerRealmId: targetR,
        kind: "message",
        text: `Filler msg ${i}`,
        objectIds: i % 10 === 0 ? [objInRoot.id] : [],
      });
    }

    // Hook rawDb.prepare to EXPLAIN QUERY PLAN the ACTUAL SQL statements emitted by SqliteDb
    const rawDb = (engine.db as unknown as { rawDb: DatabaseSync }).rawDb;
    rawDb.exec("ANALYZE");
    const origPrepare = rawDb.prepare.bind(rawDb);
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    (rawDb as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const st = origPrepare(sql);
      const origAll = st.all.bind(st);
      const origGet = st.get.bind(st);
      st.all = ((...a: unknown[]) => {
        captured.push({ sql, params: a });
        return origAll(...(a as never[]));
      }) as typeof st.all;
      st.get = ((...a: unknown[]) => {
        captured.push({ sql, params: a });
        return origGet(...(a as never[]));
      }) as typeof st.get;
      return st;
    };
    const explainEmitted = (fn: () => void): string[][] => {
      captured.length = 0;
      fn();
      return captured.map((c) =>
        (
          origPrepare(`EXPLAIN QUERY PLAN ${c.sql}`).all(
            ...(c.params as never[]),
          ) as Array<{ detail: string }>
        ).map((r) => String(r.detail)),
      );
    };

    try {
      for (const sens of [
        ["secret"] as const,
        ["secret", "confidential"] as const,
      ]) {
        const excludeSensitivities = [...sens];
        const [pCountActive] = explainEmitted(() =>
          engine.db.countActiveRecordsByRealm({
            realmIds: [rootRealm.id, realmB.id],
            excludeSensitivities,
          }),
        );
        expect(
          pCountActive!.some((d) =>
            /USING COVERING INDEX idx_records_live_(counts|ls)/.test(d),
          ),
        ).toBe(true);
        expect(pCountActive!.some((d) => /TEMP B-TREE/.test(d))).toBe(false);

        const [pCountKind] = explainEmitted(() =>
          engine.db.countRecordsByKind({
            realmIds: [rootRealm.id],
            excludeSensitivities,
          }),
        );
        expect(
          pCountKind!.some((d) =>
            /USING COVERING INDEX idx_records_live_(counts|ls)/.test(d),
          ),
        ).toBe(true);

        const [pCountSea] = explainEmitted(() =>
          engine.db.countSeabedByRealm({
            realmIds: [rootRealm.id, realmB.id],
            excludeSensitivities,
          }),
        );
        expect(
          pCountSea!.some((d) =>
            /USING COVERING INDEX idx_seabed_live_ls/.test(d),
          ),
        ).toBe(true);

        const lsPlans = explainEmitted(() =>
          engine.db.lsRealmEntriesUnified({
            orgId: org.id,
            targetRealmId: rootRealm.id,
            includePhysicalLedger: true,
            includePhysicalSeabed: true,
            includeObjectLinkedOpenMode: true,
            includeSuperseded: false,
            excludeSensitivities,
            limit: 20,
            offset: 0,
          }),
        );
        expect(lsPlans).toHaveLength(2);
        for (const p of lsPlans) {
          expect(
            p.some((d) => /SEARCH r USING COVERING INDEX idx_records_live_ls/.test(d)),
          ).toBe(true);
          expect(
            p.some((d) => /SEARCH s USING COVERING INDEX idx_seabed_live_ls/.test(d)),
          ).toBe(true);
          expect(
            p.some((d) => /SEARCH r USING INDEX sqlite_autoindex_records_1/.test(d)),
          ).toBe(true);
          expect(
            p.some((d) =>
              /SEARCH s USING INDEX sqlite_autoindex_seabed_entries_1/.test(d),
            ),
          ).toBe(true);
          expect(
            p.some(
              (d) =>
                /^SCAN (r|s)\b/.test(d) ||
                /idx_records_org_external_ref/.test(d),
            ),
          ).toBe(false);
        }
      }
    } finally {
      (rawDb as unknown as { prepare: unknown }).prepare = origPrepare;
    }
  });

  it("2. Byte-level redaction sweep on CJK bigrams + English canary (zero residual bytes in .sqlite/-wal/-shm)", async () => {
    const homeDir = makeTempDir("meru-mind-v6-redact-cjk-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    engines.push(engine);
    const { rootRealm } = engine.ledger.createOrg({
      name: "RedactCjkOrg",
      policy: "open",
    });

    // Populate surrounding benign records so FTS5 has multiple segments
    for (let i = 0; i < 15; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "finding",
        title: `常规监控记录 ${i}`,
        payload: { body: `系统正常运转编号 ${i} healthy status` },
      });
    }

    const secretRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "机密令牌测试词",
      payload: { body: "CANARY_V6_REDACT_998877 机密令牌测试词 必须彻底清除" },
    });

    // Verify searchable before redaction
    const before = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "机密令牌",
    });
    expect(before.items.some((i) => i.id === secretRec.id)).toBe(true);

    // Human redact
    const redactRes = engine.ledger.redact({
      actor: humanAlice,
      entryId: secretRec.id,
      reason: "pii-canary-purge",
    });
    expect(redactRes.blocklistRecorded).toBe(true);

    // Verify busy_timeout stayed 30000 after redact()
    const rawDb = (engine.db as unknown as { rawDb: DatabaseSync }).rawDb;
    const btRow = rawDb.prepare("PRAGMA busy_timeout").get() as {
      timeout: number;
    };
    expect(Number(btRow.timeout)).toBe(30000);

    // Close all handles and sweep raw bytes of mind.sqlite, -wal, -shm
    await engine.close();
    engines.pop();

    const needles = [
      "CANARY_V6_REDACT_998877",
      "canary_v6_redact_998877",
      "机密令牌测试词",
      "机密",
      "密令",
      "令牌",
      "牌测",
      "试词",
    ];
    for (const fileName of [
      "mind.sqlite",
      "mind.sqlite-wal",
      "mind.sqlite-shm",
    ]) {
      const fullPath = path.join(homeDir, fileName);
      if (!fs.existsSync(fullPath)) continue;
      const buf = fs.readFileSync(fullPath);
      for (const needle of needles) {
        expect(
          buf.indexOf(Buffer.from(needle, "utf8")),
          `Residual byte hit for "${needle}" in ${fileName}`,
        ).toBe(-1);
      }
    }
  });

  it("3. Contentless updateFtsStatus + settle + streaming rebuild integrity", async () => {
    const homeDir = makeTempDir("meru-mind-v6-fts-lifecycle-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    engines.push(engine);
    const { rootRealm } = engine.ledger.createOrg({
      name: "LifecycleOrg",
      policy: "open",
    });

    const v1 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "旧版路由方案 ALPHA_OLD_ROUTE",
      payload: { body: "旧版路由采用静态轮询策略" },
      occurredAt: "2026-10-01T00:00:00.000Z",
    });
    const v2 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "新版路由方案 BETA_NEW_ROUTE",
      payload: { body: "新版路由采用动态权重策略" },
      supersedesId: v1.id,
      occurredAt: "2026-11-01T00:00:00.000Z",
    });

    // updateFtsStatus MUST hide v1 when history=false and STILL match v1 when history=true!
    const defaultHit = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "ALPHA_OLD_ROUTE",
    });
    expect(defaultHit.items).toHaveLength(0);

    const historyHit = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "ALPHA_OLD_ROUTE",
      history: true,
    });
    expect(historyHit.items.map((i) => i.id)).toEqual([v1.id]);
    expect(historyHit.items[0]!.currentHeadId).toBe(v2.id);

    // settle() distillation populates org_id, kind=layer, occurred_at=created_at
    const dist = await engine.sea.settle({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      layer: "card_realm",
      periodKey: "2026-11",
      narrativeMd: "阶段总结 DISTILL_UNIQUE_MARKER 路由升级完成",
      sourceIds: [v2.id],
    });
    const distHit = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "DISTILL_UNIQUE_MARKER",
      since: "2020-01-01T00:00:00.000Z",
    });
    expect(distHit.items.map((i) => i.id)).toEqual([dist.id]);

    // Future --since excludes distillation
    const distFutureMiss = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "DISTILL_UNIQUE_MARKER",
      since: "2099-01-01T00:00:00.000Z",
    });
    expect(distFutureMiss.items).toHaveLength(0);

    // Streaming keyset rebuild() preserves 100% identical search & distillation verification
    const rebuilt = await engine.sea.rebuild({ restoreDrive: false });
    expect(rebuilt.ftsIndexed).toBe(3); // v1, v2, dist
    expect(rebuilt.distillationsVerified).toBe(1);
    expect(rebuilt.distillationMismatches).toEqual([]);

    const afterRebuildHistory = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "ALPHA_OLD_ROUTE",
      history: true,
    });
    expect(afterRebuildHistory.items.map((i) => i.id)).toEqual([v1.id]);

    const afterRebuildDist = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "DISTILL_UNIQUE_MARKER",
    });
    expect(afterRebuildDist.items.map((i) => i.id)).toEqual([dist.id]);
  });

  it("4. Migration v5 -> v6 upgrade: keyset backfill skips secrets/redacted/retracted and sets busy_timeout=30000", async () => {
    const homeDir = makeTempDir("meru-mind-v5-to-v6-");
    const seed = await createMindEngine({ homeDir, enableVector: false });
    engines.push(seed);
    const { rootRealm } = seed.ledger.createOrg({
      name: "UpgradeOrg",
      policy: "open",
    });

    const activeRec = await seed.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "生产部署规范",
      payload: { body: "先灰度再全量发布" },
    });
    await seed.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "绝密凭据",
      payload: { body: "SECRET_SHOULD_SKIP_V6" },
      sensitivity: "secret",
    });
    const toRedact = await seed.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "已撤回内容",
      payload: { body: "REDACTED_SHOULD_SKIP_V6" },
    });
    seed.ledger.redact({ actor: humanAlice, entryId: toRedact.id });
    const sea = await seed.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "海底原始消息日志",
    });
    const dist = await seed.sea.settle({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      layer: "slice_day",
      periodKey: "2026-11-23",
      narrativeMd: "日切摘要内容",
      sourceIds: [activeRec.id],
    });
    await seed.close();
    engines.pop();

    // Downgrade DB on disk to exact v5 state (legacy fts_index, no fts_docs, no partial indexes)
    const raw = new DatabaseSync(path.join(homeDir, "mind.sqlite"));
    raw.exec(`
      DROP TABLE IF EXISTS fts_docs;
      DROP TABLE IF EXISTS fts_index;
      DROP INDEX IF EXISTS idx_records_live_ls;
      DROP INDEX IF EXISTS idx_records_live_counts;
      DROP INDEX IF EXISTS idx_seabed_live_ls;
      DELETE FROM schema_migrations WHERE version >= 6;
      CREATE VIRTUAL TABLE fts_index USING fts5(
        item_id UNINDEXED, source_type UNINDEXED, realm_id UNINDEXED, status UNINDEXED,
        title, body, tokenize = 'unicode61'
      );
    `);
    raw.close();

    // Reopen -> automatically executes Migration v6
    const upgraded = await createMindEngine({ homeDir, enableVector: false });
    engines.push(upgraded);

    expect(upgraded.db.listSchemaMigrations().map((m) => m.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    const internalRaw = (upgraded.db as unknown as { rawDb: DatabaseSync }).rawDb;
    const bt = internalRaw.prepare("PRAGMA busy_timeout").get() as {
      timeout: number;
    };
    expect(Number(bt.timeout)).toBe(30000);

    const ftsDocsRows = internalRaw
      .prepare("SELECT item_id, source_type, kind FROM fts_docs ORDER BY item_id")
      .all() as Array<{ item_id: string; source_type: string; kind: string }>;
    expect(ftsDocsRows.map((r) => r.item_id).sort()).toEqual(
      [activeRec.id, sea.id, dist.id].sort(),
    );

    const hit = await upgraded.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "灰度全量发布",
    });
    expect(hit.items.map((i) => i.id)).toEqual([activeRec.id]);
    const secretMiss = await upgraded.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "SECRET_SHOULD_SKIP_V6",
    });
    expect(secretMiss.items).toHaveLength(0);
  });

  it("5. CJK 1-char prefix ('锁'), Hangul ('배포'), cross-punctuation precision ('开发，布局' != '发布'), and CJK/Latin boundary spacing", async () => {
    const homeDir = makeTempDir("meru-mind-v6-cjk-precision-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    engines.push(engine);
    const { rootRealm } = engine.ledger.createOrg({
      name: "CjkPrecOrg",
      policy: "open",
    });

    // Unit-check normalizeForFts & parseSearchQuery directly
    expect(normalizeForFts("发布平台")).toBe("发布 布平 平台 台");
    expect(normalizeForFts("开发，布局")).toBe("开发 发 ， 布局 局");
    expect(normalizeForFts("API网关v2")).toBe("API 网关 关 v2");
    expect(normalizeForFts("배포서버")).toBe("배포 포서 서버 버");
    expect(parseSearchQuery("锁").ftsAndExpression).toBe('"锁"*');
    expect(parseSearchQuery("上线").ftsAndExpression).toBe('"上线"');

    const lockStart = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "锁定资源配额",
    });
    const lockMiddle = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "分布式锁机制",
    });
    const lockEnd = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "数据库锁",
    });
    const crossPunct = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "前端开发，布局调整",
    });
    const realRelease = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "发布平台上线",
    });
    const hangulDoc = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "배포서버 점검 완료",
    });
    const mixedDoc = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "API网关v2升级",
    });

    // 1-char CJK matches start, middle, AND end
    const lockRes = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "锁",
    });
    expect(new Set(lockRes.items.map((i) => i.id))).toEqual(
      new Set([lockStart.id, lockMiddle.id, lockEnd.id]),
    );

    // Cross-punctuation precision: "发布" MUST NOT match "开发，布局"
    const pubRes = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "发布",
    });
    expect(pubRes.items.map((i) => i.id)).toEqual([realRelease.id]);
    expect(pubRes.items.some((i) => i.id === crossPunct.id)).toBe(false);

    // Hangul match
    const koRes = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "배포서버",
    });
    expect(koRes.items.map((i) => i.id)).toEqual([hangulDoc.id]);

    // CJK/Latin boundary match
    const mixedRes = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "API 网关 v2",
    });
    expect(mixedRes.items.map((i) => i.id)).toEqual([mixedDoc.id]);
  });

  it("6. Unified FTS strict scope isolation (tree descendant seabed), about=[] short-circuit (FTS+vector), --kind SQL+vector parity, and exact totalMatched > 200", async () => {
    const homeDir = makeTempDir("meru-mind-v6-unified-fts-");
    let embedCalls = 0;
    const mockEmbedder: EmbedderPort = {
      dimensions: 4,
      configured: true,
      async embed(_text: string) {
        embedCalls += 1;
        return new Float32Array([1, 0, 0, 0]);
      },
      async embedBatch(texts: string[]) {
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    };
    const engine = await createMindEngine({
      homeDir,
      vectorDimensions: 4,
      embedder: mockEmbedder,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "TreeScopeOrg",
      policy: "tree",
    });
    const childRealm = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "child",
      name: "Child",
    });

    // A) Tree-mode descendant seabed NEVER leaks into items OR totalMatched
    const childRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: childRealm.id,
      kind: "decision",
      title: "SCOPE_ISOLATION_TOKEN child decision",
    });
    const childSea = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: childRealm.id,
      kind: "message",
      text: "SCOPE_ISOLATION_TOKEN child raw seabed",
    });
    const rootSea = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "SCOPE_ISOLATION_TOKEN root raw seabed",
    });
    await engine.sea.syncEmbeddings();

    const treeSearch = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "SCOPE_ISOLATION_TOKEN",
    });
    expect(new Set(treeSearch.items.map((i) => i.id))).toEqual(
      new Set([childRec.id, rootSea.id]),
    );
    expect(treeSearch.items.some((i) => i.id === childSea.id)).toBe(false);
    expect(treeSearch.totalMatched).toBe(2);

    // B) --about matching an object with 0 entries short-circuits BEFORE both FTS and vector
    engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "service",
      name: "empty-svc",
    });
    const embedBeforeEmptyAbout = embedCalls;
    const emptyAboutRes = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "SCOPE_ISOLATION_TOKEN",
      about: "service:empty-svc",
    });
    expect(emptyAboutRes.items).toHaveLength(0);
    expect(emptyAboutRes.totalMatched).toBe(0);
    expect(emptyAboutRes.vectorUsed).toBe(false);
    expect(embedCalls).toBe(embedBeforeEmptyAbout);

    // C) --kind parity across SQL AND vector embedder
    const dist = await engine.sea.settle({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      layer: "card_realm",
      periodKey: "2026-11",
      narrativeMd: "SCOPE_ISOLATION_TOKEN card summary",
      sourceIds: [rootSea.id],
    });
    await engine.sea.syncEmbeddings();

    const onlyMessages = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "SCOPE_ISOLATION_TOKEN",
      kind: "message",
    });
    expect(onlyMessages.items.map((i) => i.id)).toEqual([rootSea.id]);
    expect(onlyMessages.items.every((i) => i.sourceType === "seabed")).toBe(
      true,
    );

    const onlyDecisions = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "SCOPE_ISOLATION_TOKEN",
      kind: "decision",
    });
    expect(onlyDecisions.items.map((i) => i.id)).toEqual([childRec.id]);
    expect(onlyDecisions.items.some((i) => i.id === rootSea.id)).toBe(false);
    expect(onlyDecisions.items.some((i) => i.id === dist.id)).toBe(false);

    // D) Exact totalMatched > 200 with --kind, --since, --until, --about
    const tagObj = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "service",
      name: "bulk-svc",
    });
    for (let i = 0; i < 215; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "finding",
        title: `BULK_COUNT_TOKEN item ${i}`,
        objectIds: [tagObj.id],
        occurredAt: "2026-11-15T12:00:00.000Z",
      });
    }
    // Add 5 out-of-range findings that should NOT count
    for (let i = 0; i < 5; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "finding",
        title: `BULK_COUNT_TOKEN old ${i}`,
        objectIds: [tagObj.id],
        occurredAt: "2025-01-01T00:00:00.000Z",
      });
    }
    const bulkRes = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "BULK_COUNT_TOKEN",
      kind: "finding",
      about: "service:bulk-svc",
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-11-30T23:59:59.000Z",
      limit: 10,
    });
    expect(bulkRes.items).toHaveLength(10);
    expect(bulkRes.totalMatched).toBe(215);
    expect(bulkRes.omittedCount).toBe(205);
  });

  it("7. Engine-level bounded show window (all 4 types, JSON/MCP boundedness, history/context payload strip, surrogate/mega-line lossless stitching, file version conflict, validation, search [shown/total chars])", async () => {
    const homeDir = makeTempDir("meru-mind-v6-show-window-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    engines.push(engine);
    const { rootRealm } = engine.ledger.createOrg({
      name: "ShowWinOrg",
      policy: "open",
    });
    engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "service",
      name: "api",
    });

    // A) Record with 20 KB body + prose `summary` key + internal metadata `contentSha256`
    const fillerLine = "Line of operational telemetry data for gateway latency monitoring.\n";
    const bigBody =
      fillerLine.repeat(120) +
      "TARGET_NEEDLE_ALERT: circuit-breaker tripped at 99.9th percentile!\n" +
      fillerLine.repeat(180);
    const bigRecV1 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Giant Superseded V1",
      payload: {
        body: "OLD_V1_BODY ".repeat(4000),
        summary: "v1 summary preserved",
      },
    });
    const bigRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Giant Active Decision",
      supersedesId: bigRecV1.id,
      payload: {
        body: bigBody,
        summary: "KEEP_THIS_SUMMARY_PROSE",
        owner: "team-core",
        contentSha256: "should_not_appear_in_canonical",
      },
    });

    // Default show bounds BOTH Markdown AND JSON (payload stripped on truncated record, summary preserved in canonical text)
    const canonicalRec = buildCanonicalEntryContent({
      kind: "record",
      payload: bigRec.payload,
    });
    expect(canonicalRec).toContain("KEEP_THIS_SUMMARY_PROSE");
    expect(canonicalRec).toContain("team-core");
    expect(canonicalRec).not.toContain("should_not_appear_in_canonical");

    const showDefault = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: bigRec.id,
      history: true,
      context: 2,
    });
    expect(showDefault.refType).toBe("entry");
    if (showDefault.refType !== "entry") throw new Error("unreachable");
    expect(showDefault.window.truncated).toBe(true);
    expect(showDefault.window.shownChars).toBeLessThanOrEqual(3500);
    expect(showDefault.window.total).toBe(canonicalRec.length);
    expect(showDefault.window.nextCursor).not.toBeNull();
    // Bounded JSON: record.payload cleared when truncated; history.nodes & context.supersedeChain have NO payload!
    expect(JSON.stringify(showDefault).length).toBeLessThan(8000);
    if (showDefault.entry.kind === "record") {
      expect(showDefault.entry.record.payload).toEqual({});
    }
    expect(showDefault.history?.nodes).toHaveLength(2);
    expect("payload" in (showDefault.history!.nodes[0] as unknown as Record<string, unknown>)).toBe(false);
    expect(showDefault.context?.supersedeChain).toHaveLength(2);
    expect("payload" in (showDefault.context!.supersedeChain[0] as unknown as Record<string, unknown>)).toBe(false);

    // Continuation page omits repeated --history / --context and emits compact 1-line header
    const showPage2 = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: bigRec.id,
      cursor: showDefault.window.nextCursor!,
      history: true,
      context: 2,
    });
    if (showPage2.refType !== "entry") throw new Error("unreachable");
    expect(showPage2.history).toBeUndefined();
    expect(showPage2.context).toBeUndefined();
    const mdPage2 = formatShowMarkdown(showPage2);
    expect(mdPage2.split("\n")[0]).toContain("(continuation · chars");
    expect(mdPage2).not.toContain("## History");

    // --around centers on TARGET_NEEDLE_ALERT; miss falls back cleanly with aroundMatched: false
    const showAroundHit = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: bigRec.id,
      around: "TARGET_NEEDLE_ALERT",
    });
    if (showAroundHit.refType !== "entry") throw new Error("unreachable");
    expect(showAroundHit.window.aroundMatched).toBe(true);
    expect(showAroundHit.content).toContain("TARGET_NEEDLE_ALERT");

    const showAroundMiss = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: bigRec.id,
      around: "NONEXISTENT_PHRASE_ZZZ",
    });
    if (showAroundMiss.refType !== "entry") throw new Error("unreachable");
    expect(showAroundMiss.window.aroundMatched).toBe(false);
    expect(showAroundMiss.window.start).toBe(0);
    expect(formatShowMarkdown(showAroundMiss)).toContain(
      'Note: no match for "NONEXISTENT_PHRASE_ZZZ"',
    );

    // --full returns complete text + preserves record.payload intact
    const showFull = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: bigRec.id,
      full: true,
    });
    if (showFull.refType !== "entry") throw new Error("unreachable");
    expect(showFull.window.truncated).toBe(false);
    expect(showFull.content).toBe(canonicalRec);
    if (showFull.entry.kind === "record") {
      expect(showFull.entry.record.payload.summary).toBe(
        "KEEP_THIS_SUMMARY_PROSE",
      );
    }

    // B) Lossless pagination stitching: CJK + surrogate-pair emojis (🚀) + 10,000-char newline-free mega-line
    const trickyText =
      "🚀".repeat(1500) +
      "中文超长无换行段落".repeat(900) +
      "A".repeat(10000);
    const chunks: string[] = [];
    let nextOff: number | null = 0;
    let guard = 0;
    while (nextOff !== null) {
      guard += 1;
      expect(guard).toBeLessThan(100); // zero infinite-loop guard
      const w = windowText({
        text: trickyText,
        cursorOffset: nextOff,
        limit: 1001, // odd limit intentionally collides with 2-code-unit surrogate pairs!
      });
      // Assert no lone surrogates at slice boundaries
      if (w.slice.length > 0) {
        const firstCode = w.slice.charCodeAt(0);
        const lastCode = w.slice.charCodeAt(w.slice.length - 1);
        expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false);
        expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
      }
      chunks.push(w.slice);
      nextOff = w.nextOffset;
    }
    expect(chunks.join("")).toBe(trickyText);

    // C) Seabed & Distillation bounded in JSON + show /realm brief caps raw seabed at 500 chars
    const bigSeabed = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "RAW_SEABED_LOG ".repeat(600),
    });
    const showSea = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: bigSeabed.id,
    });
    if (showSea.refType !== "entry" || showSea.entry.kind !== "seabed") {
      throw new Error("expected seabed");
    }
    expect(showSea.window.truncated).toBe(true);
    expect(showSea.entry.seabed.text.length).toBeLessThanOrEqual(3500);

    const showRealm = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: "/",
    });
    const briefMd = formatShowMarkdown(showRealm);
    // L1 brief folds raw seabed messages out of main view with explicit drill-down count (keeps brief bounded)
    expect(briefMd).toContain("1 raw message(s)");
    expect(briefMd).not.toContain("RAW_SEABED_LOG RAW_SEABED_LOG");

    const bigDist = await engine.sea.settle({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      layer: "card_realm",
      periodKey: "2026-11",
      narrativeMd: "DISTILLATION_CONTENT ".repeat(500),
      sourceIds: [bigRec.id],
    });
    const showDist = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: bigDist.id,
    });
    if (showDist.refType !== "entry" || showDist.entry.kind !== "distillation") {
      throw new Error("expected distillation");
    }
    expect(showDist.window.truncated).toBe(true);
    expect(showDist.entry.distillation.narrativeMd.length).toBeLessThanOrEqual(
      3500,
    );

    // D) File windowing + version-pinned cursor + CONFLICT when file updates mid-pagination
    await engine.ledger.writeDriveFile({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      relPath: "docs/handbook.md",
      content: "Handbook section text.\n".repeat(400),
    });
    const filePage1 = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: "file:/docs/handbook.md",
      chars: 1200,
    });
    if (filePage1.refType !== "file") throw new Error("expected file");
    expect(filePage1.window.truncated).toBe(true);
    expect(filePage1.window.nextCursor).toMatch(/^v1:\d+$/);

    // Update file to v2 -> stale v1 cursor MUST throw CONFLICT with `try` hint
    await engine.ledger.writeDriveFile({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      relPath: "docs/handbook.md",
      content: "Updated handbook v2.\n".repeat(400),
      expectedVersion: 1,
    });
    await expect(
      engine.sea.show({
        actor: agentWorker,
        viewerRealmId: rootRealm.id,
        ref: "file:/docs/handbook.md",
        cursor: filePage1.window.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // E) Validation: window flags rejected on realm/object; around+cursor rejected; out-of-bounds cursor clean empty slice
    await expect(
      engine.sea.show({
        actor: agentWorker,
        viewerRealmId: rootRealm.id,
        ref: "/",
        chars: 1000,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      engine.sea.show({
        actor: agentWorker,
        viewerRealmId: rootRealm.id,
        ref: "service:api",
        full: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      engine.sea.show({
        actor: agentWorker,
        viewerRealmId: rootRealm.id,
        ref: bigRec.id,
        around: "alert",
        cursor: "100",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const oob = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: bigRec.id,
      cursor: "999999",
    });
    if (oob.refType !== "entry") throw new Error("expected entry");
    expect(oob.content).toBe("");
    expect(oob.window).toEqual({
      start: canonicalRec.length,
      end: canonicalRec.length,
      total: canonicalRec.length,
      shownChars: 0,
      truncated: false,
      nextCursor: null,
    });
    // Out-of-bounds cursor MUST still strip large record payload in JSON/MCP (no unbounded leak!)
    expect(oob.entry.kind === "record" ? oob.entry.record.payload : null).toEqual({});
    expect(JSON.stringify(oob).length).toBeLessThan(2000);

    // Record with short body + huge ignored metadata key (60 KB frontmatter) MUST stay bounded in default show JSON
    const hugeMetaRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "Short body huge metadata",
      payload: {
        body: "Short visible body.",
        frontmatter: { blob: "M".repeat(60000) },
      },
    });
    const showHugeMeta = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: hugeMetaRec.id,
    });
    expect(showHugeMeta.refType).toBe("entry");
    if (showHugeMeta.refType !== "entry") throw new Error("expected entry");
    expect(JSON.stringify(showHugeMeta).length).toBeLessThan(2000);
    expect(
      showHugeMeta.entry.kind === "record" ? showHugeMeta.entry.record.payload : null,
    ).toEqual({});
    const showHugeMetaFull = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: hugeMetaRec.id,
      full: true,
    });
    expect(
      showHugeMetaFull.refType === "entry" &&
        showHugeMetaFull.entry.kind === "record"
        ? (showHugeMetaFull.entry.record.payload.frontmatter as { blob: string }).blob.length
        : 0,
    ).toBe(60000);

    // F) Search [shown/total chars] appears IFF item.truncated === true (zero contradiction on short record with summary+body)
    const shortRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "TRUNC_SIGNAL_TEST short",
      payload: {
        summary: "UNIQUE_SHORT_ONLY_PHRASE concise overview",
        body: "Short body for TRUNC_SIGNAL_TEST.",
      },
    });
    const longRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "TRUNC_SIGNAL_TEST long",
      payload: {
        body: `TRUNC_SIGNAL_TEST ${"Detailed long paragraph content. ".repeat(40)}`,
      },
    });
    const searchRes = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "TRUNC_SIGNAL_TEST",
    });
    const shortHit = searchRes.items.find((i) => i.id === shortRec.id)!;
    const longHit = searchRes.items.find((i) => i.id === longRec.id)!;
    expect(shortHit.truncated).toBe(false);
    expect(longHit.truncated).toBe(true);
    expect(longHit.contentChars).toBeGreaterThan(longHit.shownChars);

    const searchMd = formatSearchMarkdown(searchRes);
    const shortLine = searchMd
      .split("\n")
      .find((l) => l.includes(shortRec.id))!;
    const longLine = searchMd
      .split("\n")
      .find((l) => l.includes(longRec.id))!;
    expect(shortLine).not.toMatch(/\[\d+\/\d+ chars\]/);
    expect(longLine).toContain(
      `[${longHit.shownChars}/${longHit.contentChars} chars]`,
    );
    expect(searchMd).toContain("Hits marked [shown/total chars] are excerpts.");

    // Short-only search MUST NOT show legend
    const shortOnlyRes = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "UNIQUE_SHORT_ONLY_PHRASE",
    });
    expect(shortOnlyRes.items.map((i) => i.id)).toEqual([shortRec.id]);
    expect(shortOnlyRes.items.every((i) => i.truncated === false)).toBe(true);
    expect(formatSearchMarkdown(shortOnlyRes)).not.toContain(
      "Hits marked [shown/total chars]",
    );

    // Explicit cursor on a small record also strips payload in JSON/MCP (consistent continuation contract)
    const shortCursorShow = await engine.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: shortRec.id,
      cursor: "0",
    });
    expect(
      shortCursorShow.refType === "entry" &&
        shortCursorShow.entry.kind === "record"
        ? shortCursorShow.entry.record.payload
        : null,
    ).toEqual({});

    // G) CLI & Live MCP E2E: compact JSON, bounded mind_show, wire budget <= 6000
    await engine.close();
    engines.pop();

    const cliShowMd = runCli(homeDir, ["show", bigRec.id, "--chars", "1000"]);
    expect(cliShowMd).toContain("--- chars 0–");
    expect(cliShowMd).toContain("--cursor");

    const cliRejectRealm = runCliFail(homeDir, ["show", "/", "--full"]);
    expect(cliRejectRealm.status).not.toBe(0);
    expect(cliRejectRealm.stderr).toContain("invalid_input");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpBin],
      env: { ...process.env, MERU_MIND_HOME: homeDir },
    });
    const client = new Client({ name: "v6-mcp-test", version: "0.2.0" });
    await client.connect(transport);
    try {
      const toolsList = await client.listTools();
      expect(toolsList.tools).toHaveLength(7);
      const wireLen = JSON.stringify(toolsList).length;
      expect(wireLen).toBeLessThanOrEqual(6000);
      for (const t of toolsList.tools) {
        expect((t.description ?? "").length).toBeLessThanOrEqual(220);
      }

      const mcpShow = await client.callTool({
        name: "mind_show",
        arguments: { ref: bigRec.id, chars: 1200, history: true },
      });
      const rawText = (mcpShow.content as Array<{ text: string }>)[0]!.text;
      // Compact JSON: no pretty-printed 2-space indentation
      expect(rawText).not.toContain('\n  "');
      expect(rawText.length).toBeLessThan(3500);
      const parsed = JSON.parse(rawText) as {
        window: { truncated: boolean; nextCursor: string | null };
        entry: { record: { payload: Record<string, unknown> } };
      };
      expect(parsed.window.truncated).toBe(true);
      expect(parsed.window.nextCursor).not.toBeNull();
      expect(parsed.entry.record.payload).toEqual({});

      const mcpErr = await client.callTool({
        name: "mind_show",
        arguments: { ref: "/", chars: 500 },
      });
      expect(mcpErr.isError).toBe(true);
      const errText = (mcpErr.content as Array<{ text: string }>)[0]!.text;
      expect(errText).not.toContain('\n  "');
      expect(JSON.parse(errText).error).toBe("invalid_input");
    } finally {
      await client.close();
    }
  });

  it("8. SQL-layer searchFtsUnified scope/kind/status/about isolation (directly observable without JS post-filter & above per-bucket cap)", async () => {
    const homeDir = makeTempDir("meru-mind-v6-sql-iso-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "TreeIso",
      policy: "tree",
    });
    const child = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "child",
      name: "Child",
    });
    const cRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: child.id,
      kind: "decision",
      title: "ISOTOK child decision",
    });
    const rSea = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "ISOTOK root seabed",
    });
    // Exceed 100-row per-bucket cap with descendant seabed rows
    for (let i = 0; i < 150; i += 1) {
      await engine.ledger.captureSeabed({
        actor: agentWorker,
        viewerRealmId: child.id,
        kind: "message",
        text: `ISOTOK child raw seabed ${i}`,
      });
    }
    const oldRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "ISOTOK superseded v1",
    });
    const headRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "ISOTOK head v2",
      supersedesId: oldRec.id,
    });

    const base = {
      ftsExpression: '"ISOTOK"',
      includeSuperseded: false,
      perBucketLimit: 100,
      ledgerRealmIds: [rootRealm.id, child.id],
      seabedRealmIds: [rootRealm.id],
    };

    // Direct SQL assertions: catches realm union leak, updateFtsStatus no-op, kind/about SQL pushdown bypasses
    const strict = engine.db.searchFtsUnified(base);
    expect(new Set(strict.rows.map((r) => r.itemId))).toEqual(
      new Set([cRec.id, headRec.id, rSea.id]),
    );
    expect(strict.total).toBe(3);

    expect(
      engine.db
        .searchFtsUnified({ ...base, seabedKinds: ["message"] })
        .rows.map((r) => r.itemId),
    ).toEqual([rSea.id]);
    expect(
      engine.db.searchFtsUnified({ ...base, recordKinds: ["finding"] }).total,
    ).toBe(0);
    expect(
      engine.db.searchFtsUnified({ ...base, allowedEntryIds: [] }).total,
    ).toBe(0);
    expect(
      engine.db
        .searchFtsUnified({ ...base, allowedEntryIds: [cRec.id] })
        .rows.map((r) => r.itemId),
    ).toEqual([cRec.id]);
    // Mixed recordKinds + seabedKinds branch AND single-sided scope branches
    expect(
      new Set(
        engine.db
          .searchFtsUnified({
            ...base,
            recordKinds: ["decision"],
            seabedKinds: ["message"],
          })
          .rows.map((r) => r.itemId),
      ),
    ).toEqual(new Set([cRec.id, headRec.id, rSea.id]));
    expect(
      engine.db
        .searchFtsUnified({ ...base, ledgerRealmIds: [], seabedRealmIds: [rootRealm.id] })
        .rows.map((r) => r.itemId),
    ).toEqual([rSea.id]);
    expect(
      new Set(
        engine.db
          .searchFtsUnified({ ...base, ledgerRealmIds: [rootRealm.id, child.id], seabedRealmIds: [] })
          .rows.map((r) => r.itemId),
      ),
    ).toEqual(new Set([cRec.id, headRec.id]));

    // Engine level above per-bucket cap: descendant seabed must NOT inflate totalMatched
    const res = await engine.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "ISOTOK",
      limit: 10,
    });
    expect(res.totalMatched).toBe(3);
    expect(res.omittedCount).toBe(0);
  });
});
