import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  MindError,
  type Actor,
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
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const humanAlice: Actor = { id: "alice", kind: "human" };
const agentGemini: Actor = { id: "coder-1", kind: "agent", family: "gemini" };
const agentGeminiOther: Actor = { id: "reviewer-same", kind: "agent", family: "gemini" };
const agentDeepseek: Actor = { id: "verifier-1", kind: "agent", family: "deepseek" };

describe("Ledger invariants: supersede chains, human-only rules, verdicts & blind-ID protection", () => {
  it("tracks decision supersede chains and returns only active version by default", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-sup-"),
    });
    engines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });

    const v1 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Cache TTL set to 60 seconds (token: TTL_CHAIN_TEST)",
      payload: { ttlSeconds: 60 },
    });
    const v2 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Cache TTL updated to 300 seconds (token: TTL_CHAIN_TEST)",
      payload: { ttlSeconds: 300 },
      supersedesId: v1.id,
    });

    // Default recall returns ONLY active v2
    const activeOnly = await engine.sea.recall({
      actor: agentGemini,
      viewerRealmId: rootRealm.id,
      query: "TTL_CHAIN_TEST",
    });
    expect(activeOnly.items).toHaveLength(1);
    expect(activeOnly.items[0]!.id).toBe(v2.id);
    expect(activeOnly.items[0]!.status).toBe("active");

    // History recall returns both v1 (superseded) and v2 (active)
    const withHistory = await engine.sea.recall({
      actor: agentGemini,
      viewerRealmId: rootRealm.id,
      query: "TTL_CHAIN_TEST",
      includeSuperseded: true,
    });
    expect(withHistory.items.map((i) => i.id).sort()).toEqual([v1.id, v2.id].sort());
    expect(withHistory.items.find((i) => i.id === v1.id)?.status).toBe("superseded");

    // Chain traversal returns chronological [v1, v2]
    const chain = engine.ledger.getSupersedeChain({
      actor: agentGemini,
      viewerRealmId: rootRealm.id,
      recordId: v2.id,
    });
    expect(chain.map((r) => r.id)).toEqual([v1.id, v2.id]);

    // Double-superseding v1 is rejected with CONFLICT
    await expect(
      engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "decision",
        title: "Duplicate supersede",
        supersedesId: v1.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects non-human rule writes with zero dirty rows", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-rule-"),
    });
    engines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });

    await expect(
      engine.ledger.appendRecord({
        actor: agentGemini,
        viewerRealmId: rootRealm.id,
        kind: "rule",
        title: "Agent trying to relax verification gate",
      }),
    ).rejects.toMatchObject({ code: "RULE_REQUIRES_HUMAN" });

    // Confirm 0 rules were written
    const rules = engine.db.listRecords({
      realmIds: [rootRealm.id],
      kinds: ["rule"],
    });
    expect(rules.total).toBe(0);

    // Human succeeds
    const rule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "rule",
      title: "Production deploys require human sign-off",
    });
    expect(rule.kind).toBe("rule");
  });

  it("treats verdicts as generic ledger records (no hardcoded cross-family rules) while preserving extKind and refs visibility", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-verdict-"),
    });
    engines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });

    const dec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "API responses must be under 200ms",
    });

    const proposal = await engine.ledger.appendRecord({
      actor: agentGemini,
      viewerRealmId: rootRealm.id,
      kind: "proposal",
      extKind: "perf_proposal",
      title: "Delivered optimized endpoint",
      refs: [dec.id],
    });
    expect(proposal.extKind).toBe("perf_proposal");
    expect(proposal.confirmedByHuman).toBe(false);
    expect(dec.confirmedByHuman).toBe(true);

    // Same model family verdict is allowed in core engine (policy delegated to host)
    const sameFamilyVerdict = await engine.ledger.appendRecord({
      actor: agentGeminiOther,
      viewerRealmId: rootRealm.id,
      kind: "verdict",
      extKind: "qa_review",
      title: "Same-family review note",
      payload: { proposalId: proposal.id, outcome: "pass" },
      refs: [proposal.id],
    });
    expect(sameFamilyVerdict.kind).toBe("verdict");
    expect(sameFamilyVerdict.extKind).toBe("qa_review");

    // Reject verdict without citing a rule/decision is also accepted in core engine
    const uncitedReject = await engine.ledger.appendRecord({
      actor: agentDeepseek,
      viewerRealmId: rootRealm.id,
      kind: "verdict",
      title: "Measured 450ms p99",
      payload: { proposalId: proposal.id, outcome: "reject" },
      refs: [proposal.id],
    });
    expect(uncitedReject.kind).toBe("verdict");
  });

  it("prevents blind-ID probing of hidden sibling records via refs", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-probe-"),
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "Acme",
      policy: "tree",
    });
    const sibA = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "alpha",
      name: "Alpha",
    });
    const sibB = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "beta",
      name: "Beta",
    });

    const secretRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "decision",
      title: "Alpha internal strategy",
    });

    await expect(
      engine.ledger.appendRecord({
        actor: agentGemini,
        viewerRealmId: sibB.id,
        kind: "finding",
        title: "Attempting to reference Alpha record",
        refs: [secretRec.id],
      }),
    ).rejects.toThrow(MindError);
  });
});
