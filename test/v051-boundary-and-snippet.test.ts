import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSnippetWithMeta,
  createMindEngine,
  normalizeForFts,
  parseSearchQuery,
  type MindEngine,
} from "../src/index.js";

const tempDirs: string[] = [];
const openEngines: MindEngine[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (openEngines.length > 0) {
    await openEngines.pop()!.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v0.5.1: Option X Underscore/Delimiter Boundary Alignment & Coverage-First Snippets", () => {
  it("1. Two-direction differential invariant: FTS5 unicode61 MATCH => JS scoreText > 0 (100% non-[-/:]), and reverse on pure ASCII", () => {
    const corpus = [
      "service:conversation-service — upstream_cutover_to_go_gateway_completed",
      "Updated MODEL_MANAGER_SERVER_ADDRESS to model-manager-gateway.internal:443",
      "Deployed model-manager-server-address config in staging",
      "REAPER_DRY_RUN=true and error_rate_p95 under threshold",
      "Go网关切换到v1版本，不含v10和foobar",
      "Deploy agent-worker with 4 replicas and agent-worker_bridge helper",
      "Deploy agent-worker-bridge proxy on revision conversation-service-00087-ram",
      "Route api/v2/auth and api/v2/auth-proxy separately",
    ];

    const mem = new DatabaseSync(":memory:");
    mem.exec("CREATE VIRTUAL TABLE docs USING fts5(body, tokenize='unicode61');");
    const ins = mem.prepare("INSERT INTO docs(rowid, body) VALUES (?, ?)");
    corpus.forEach((doc, idx) => {
      ins.run(idx + 1, normalizeForFts(doc));
    });

    const nonDelimQueries = [
      "upstream",
      "go",
      "gateway",
      "address",
      "MODEL_MANAGER_SERVER_ADDRESS",
      "REAPER_DRY_RUN",
      "error_rate_p95",
      "v1",
      "foo",
      "staging",
    ];

    const stmt = mem.prepare("SELECT rowid FROM docs WHERE docs MATCH ?");
    for (const q of nonDelimQueries) {
      const parsed = parseSearchQuery(q);
      expect(parsed.concepts).toHaveLength(1);
      const concept = parsed.concepts[0]!;
      expect(concept.isIdentifier).toBe(false);

      const ftsRowIds = new Set(
        (stmt.all(concept.ftsGroupExpr) as Array<{ rowid: number }>).map(
          (r) => r.rowid,
        ),
      );

      for (let i = 0; i < corpus.length; i += 1) {
        const doc = corpus[i]!;
        const ftsHit = ftsRowIds.has(i + 1);
        const jsHit = concept.scoreText(doc) > 0;

        // Direction 1 (100% invariant across ALL corpus docs including mixed CJK): FTS5 MATCH => JS > 0
        if (ftsHit) {
          expect(jsHit, `FTS5 matched "${q}" on doc[${i}] ("${doc}"), JS MUST NOT zero it out`).toBe(true);
        }

        // Direction 2 (pure ASCII docs): JS > 0 => FTS5 MATCH
        const isPureAscii = /^[\x20-\x7e]+$/.test(doc);
        if (isPureAscii && jsHit) {
          expect(ftsHit, `JS matched "${q}" on pure ASCII doc[${i}] ("${doc}"), FTS5 MUST also match`).toBe(true);
        }
      }
    }
    mem.close();
  });

  it("2. Pinned Option X boundary contracts: underscore-separated words, snake_case asymmetry, agent-worker_bridge, and revision suffix isolation", async () => {
    const homeDir = makeTempDir("meru-v051-bound-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({ name: "BoundOrg", policy: "open" });
    const human = { id: "lead", kind: "human" as const };
    const agent = { id: "bot", kind: "agent" as const };

    const recSnakeTitle = await engine.ledger.appendRecord({
      actor: human,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "service:conversation-service — upstream_cutover_to_go_gateway_completed",
      payload: {
        body: "Stage conversation-service updated MODEL_MANAGER_SERVER_ADDRESS to model-manager-gateway.internal:443 on conversation-service-00087-ram.",
      },
    });
    const recHyphenEnv = await engine.ledger.appendRecord({
      actor: human,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "Long doc with hyphenated env key",
      payload: {
        body: `${"Background context padding. ".repeat(110)}Target key model-manager-server-address set to 443.`,
      },
    });
    const recWorkerUnderscore = await engine.ledger.appendRecord({
      actor: human,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "Deploy agent-worker_bridge helper",
    });
    const recWorkerHyphen = await engine.ledger.appendRecord({
      actor: human,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "Deploy agent-worker-bridge sibling service",
    });
    const recV10 = await engine.ledger.appendRecord({
      actor: human,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "Upgrade pipeline to v10 and foobar",
    });

    // (a) Plain words match inside snake_case title & env vars
    const q08Like = await engine.sea.recall({
      actor: agent,
      viewerRealmId: rootRealm.id,
      query: "conversation-service stage Go gateway upstream",
      limit: 10,
    });
    expect(q08Like.items[0]?.id).toBe(recSnakeTitle.id);

    const addrRes = await engine.sea.recall({
      actor: agent,
      viewerRealmId: rootRealm.id,
      query: "address",
      limit: 10,
    });
    expect(addrRes.items.map((i) => i.id)).toContain(recSnakeTitle.id);

    // (b) Intentional asymmetry: snake_case query matches hyphenated form (even in >2000-char doc via prefilterTerms),
    // while hyphenated identifier query does NOT match snake_case form!
    const snakeQuery = await engine.sea.recall({
      actor: agent,
      viewerRealmId: rootRealm.id,
      query: "MODEL_MANAGER_SERVER_ADDRESS",
      limit: 10,
    });
    expect(snakeQuery.items.map((i) => i.id)).toContain(recSnakeTitle.id);
    expect(snakeQuery.items.map((i) => i.id)).toContain(recHyphenEnv.id);

    const hyphenQuery = await engine.sea.recall({
      actor: agent,
      viewerRealmId: rootRealm.id,
      query: "model-manager-server-address",
      limit: 10,
    });
    expect(hyphenQuery.items.map((i) => i.id)).toContain(recHyphenEnv.id);
    expect(hyphenQuery.items.map((i) => i.id)).not.toContain(recSnakeTitle.id);

    // (c) agent-worker matches agent-worker_bridge (underscore left boundary class),
    // while still strictly rejecting agent-worker-bridge!
    const workerRes = await engine.sea.recall({
      actor: agent,
      viewerRealmId: rootRealm.id,
      query: "agent-worker",
      limit: 10,
    });
    expect(workerRes.items.map((i) => i.id)).toContain(recWorkerUnderscore.id);
    expect(workerRes.items.map((i) => i.id)).not.toContain(recWorkerHyphen.id);

    // (d) Bare revision suffix 00087-ram still does NOT match conversation-service-00087-ram
    const revRes = await engine.sea.recall({
      actor: agent,
      viewerRealmId: rootRealm.id,
      query: "00087-ram",
      limit: 10,
    });
    expect(revRes.items.map((i) => i.id)).not.toContain(recSnakeTitle.id);

    // (e) v1 != v10, foo != foobar
    const v1Res = await engine.sea.recall({
      actor: agent,
      viewerRealmId: rootRealm.id,
      query: "v1",
      limit: 10,
    });
    expect(v1Res.items.map((i) => i.id)).not.toContain(recV10.id);
    const fooRes = await engine.sea.recall({
      actor: agent,
      viewerRealmId: rootRealm.id,
      query: "foo",
      limit: 10,
    });
    expect(fooRes.items.map((i) => i.id)).not.toContain(recV10.id);
  });

  it("3. Coverage-first snippet synthesis: byte-identical fast path, strict <= 240 cap on 2-segment split, tail fallback for >=3 hits, and --limit invariance", async () => {
    const parsed = parseSearchQuery("feature 先合 test 分支 铁律");

    // (a) Scattered rare concept: Window 1 hits 4 common words at char 0, rare "铁律" sits at char ~580
    const q02Body =
      "2026-08-25，Alex 提出异化 trunk-based：feature 先合入共享 test 分支（部 test 环境人工测），测过后 feature 分支本体再合入 main 进入 tag→staging→生产链。" +
      "分析定性说明与五个失败模式详细展开。".repeat(25) +
      "三条铁律：test 永不合入任何分支；test 是耗材定期重组（agent 干）；晋级=update 到 main HEAD+CI 重跑+staging 完整验收。其余远期规划略。";

    const multi = buildSnippetWithMeta({
      title: "Acme 发布分支模型 — proposed_test_branch_variant",
      text: q02Body,
      concepts: parsed.concepts,
      maxLen: 240,
    });
    expect(multi.truncated).toBe(true);
    expect(multi.snippet.length).toBeLessThanOrEqual(240);
    expect(multi.snippet).toContain(" … ");
    expect(multi.snippet).toContain("铁律");
    expect(multi.snippet).toContain("feature");

    // (b) When all non-title body matches already fit in Window 1, NO split occurs
    const singleBody =
      "feature 先合 test 分支的三条铁律都在开头说清了。" +
      "补充说明文字。".repeat(60);
    const single = buildSnippetWithMeta({
      title: "分支规范",
      text: singleBody,
      concepts: parsed.concepts,
      maxLen: 240,
    });
    expect(single.snippet).not.toContain(" … ");
    expect(single.snippet).toContain("铁律");

    // (c) Title binary check: if the distant term is already in the title, do NOT split unnecessarily
    const titleCovered = buildSnippetWithMeta({
      title: "分支模型三条铁律汇总",
      text: q02Body,
      concepts: parsed.concepts,
      maxLen: 240,
    });
    expect(titleCovered.snippet).not.toContain(" … ");

    // (d) >=3 widely scattered non-title concepts: picks rarest by conceptDf for segment 2 + tail fallback tag, strictly <= 240
    const scatteredQuery = parseSearchQuery("alpha beta gamma delta");
    const scatteredBody =
      "alpha beta intro context " +
      "filler padding text ".repeat(22) +
      "gamma appears in the middle section " +
      "more filler text ".repeat(22) +
      "delta sits far at the tail end of the record.";
    // Make `delta` (idx 3) rarer than `gamma` (idx 2): df = [50, 50, 20, 2]
    const scattered = buildSnippetWithMeta({
      title: "Architecture notes",
      text: scatteredBody,
      concepts: scatteredQuery.concepts,
      conceptDf: [50, 50, 20, 2],
      maxLen: 240,
    });
    expect(scattered.snippet.length).toBeLessThanOrEqual(240);
    expect(scattered.snippet).toContain(" … ");
    expect(scattered.snippet).toContain("delta");
    expect(scattered.snippet).toContain("[+gamma]");

    // (e) End-to-end --limit invariance: Rank #1 snippet MUST be identical for limit=1 vs limit=10
    const homeDir = makeTempDir("meru-v051-df-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(engine);
    const { rootRealm } = engine.ledger.createOrg({ name: "DfOrg", policy: "open" });
    const human = { id: "lead", kind: "human" as const };
    const agent = { id: "bot", kind: "agent" as const };

    await engine.ledger.appendRecord({
      actor: human,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Architecture notes",
      payload: { body: scatteredBody },
    });
    for (let i = 0; i < 6; i += 1) {
      await engine.ledger.appendRecord({
        actor: human,
        viewerRealmId: rootRealm.id,
        kind: "finding",
        title: `Common gamma note ${i}`,
        payload: { body: `alpha beta gamma routine update ${i}` },
      });
    }

    const rLimit1 = await engine.sea.recall({
      actor: agent,
      viewerRealmId: rootRealm.id,
      query: "alpha beta gamma delta",
      limit: 1,
    });
    const rLimit10 = await engine.sea.recall({
      actor: agent,
      viewerRealmId: rootRealm.id,
      query: "alpha beta gamma delta",
      limit: 10,
    });
    expect(rLimit1.items[0]?.id).toBe(rLimit10.items[0]?.id);
    expect(rLimit1.items[0]?.snippet).toBe(rLimit10.items[0]?.snippet);
    expect(rLimit1.items[0]!.snippet.length).toBeLessThanOrEqual(240);
    expect(rLimit1.items[0]?.snippet).toContain("delta");
  });
});
