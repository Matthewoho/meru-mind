import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  formatSearchMarkdown,
  type Actor,
} from "../src/index.js";

const tmpDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meru-mind-slice4-"));
  tmpDirs.push(dir);
  return dir;
}

const humanAdmin: Actor = { id: "human:alice", kind: "human" };
const agentWorker: Actor = { id: "agent:bot", kind: "agent", family: "test" };

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("V0.2a Slice 4 — Pillar 1: Local-Passage Windowed Coverage & Search extKind", () => {
  it("demotes mega-doc with distant scattered concepts below concise local hit while preserving deep co-located SOP passages", async () => {
    const homeDir = makeTempHome();
    const eng = await createMindEngine({ homeDir });
    const { rootRealm } = eng.ledger.createOrg({
      name: "SearchLab",
      policy: "open",
      actor: humanAdmin,
    });

    // 1. Mega-doc (50k chars) with "aurora" near offset 50 and "quasar" near offset 45,000 (scattered!)
    const padA = "Neutral filler prose about unrelated architecture logs. ".repeat(
      400,
    );
    const padB = "Routine operational changelog entry without target keywords. ".repeat(
      400,
    );
    const scatteredMegaDoc = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "claim",
      extKind: "reference_doc",
      title: "Giant Annual Archive",
      payload: {
        body: `Chapter 1 mentions aurora configuration.\n${padA}\n${padB}\nChapter 99 mentions quasar migration.`,
      },
      occurredAt: "2026-10-10T00:00:00Z",
    });

    // 2. Concise atomic conclusion (both concepts in same sentence!)
    const conciseFact = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "decision",
      extKind: "verified_fact",
      title: "Routing decision",
      payload: {
        body: "Confirmed: aurora connects directly to quasar with zero proxy hops.",
      },
      occurredAt: "2026-10-10T00:00:00Z",
    });

    // 3. Genuine deep SOP (50k chars) where BOTH concepts co-occur near offset 42,000 (tests zero front-bias!)
    const deepSop = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "claim",
      extKind: "runbook",
      title: "Deep Operations Manual",
      payload: {
        body: `${padA}\n${padB}\nSection 88 Deep Runbook: aurora failover to quasar completes in 4 seconds.\n${"Trailing notes. ".repeat(100)}`,
      },
      occurredAt: "2026-10-10T00:00:00Z",
    });

    const res = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "aurora quasar",
      limit: 10,
    });

    const ids = res.items.map((i) => i.id);
    const idxFact = ids.indexOf(conciseFact.id);
    const idxDeep = ids.indexOf(deepSop.id);
    const idxScattered = ids.indexOf(scatteredMegaDoc.id);

    expect(idxFact).toBeGreaterThanOrEqual(0);
    expect(idxDeep).toBeGreaterThanOrEqual(0);
    expect(idxScattered).toBeGreaterThanOrEqual(0);

    // Both co-located entries (concise fact AND deep offset-42k SOP) MUST beat the scattered mega-doc!
    expect(idxFact).toBeLessThan(idxScattered);
    expect(idxDeep).toBeLessThan(idxScattered);

    // Deep SOP snippet MUST come from the winning offset-42k passage (not the beginning filler!)
    const deepItem = res.items[idxDeep]!;
    expect(deepItem.snippet).toContain("aurora failover to quasar");
    expect(deepItem.truncated).toBe(true);
    expect(deepItem.contentChars).toBeGreaterThan(20000);

    // extKind surfaced on RecallItem JSON and rendered in Markdown badge
    const factItem = res.items[idxFact]!;
    expect(factItem.extKind).toBe("verified_fact");
    const md = formatSearchMarkdown(res);
    expect(md).toContain("[conclusion/verified_fact]");
    expect(md).toContain("[conclusion/reference_doc]");

    // Native record without extKind omits extKind property cleanly
    const plainRec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Plain finding",
      payload: { body: "UniqueTokenPluto991 observed." },
    });
    const plainRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "UniqueTokenPluto991",
    });
    expect(plainRes.items[0]?.id).toBe(plainRec.id);
    expect("extKind" in (plainRes.items[0] ?? {})).toBe(false);
    eng.close();
  });

  it("protects Chinese year prefix across overlapping window boundaries (2025年10月10日 never false-matches 2026年10月10日)", async () => {
    const homeDir = makeTempHome();
    const eng = await createMindEngine({ homeDir });
    const { rootRealm } = eng.ledger.createOrg({
      name: "DateSeamOrg",
      policy: "open",
      actor: humanAdmin,
    });

    // Place "2025年" immediately before index 1000 so "10月10日" starts right at index 1000 (window 1 boundary!)
    const prefix = "a".repeat(995);
    const wrongYearDoc = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "claim",
      title: "Historical seam note",
      payload: {
        body: `${prefix}2025年10月10日 发布检查记录。${"x".repeat(1500)}`,
      },
      occurredAt: "2025-10-10T00:00:00Z",
    });

    const rightYearDoc = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "claim",
      title: "Current seam note",
      payload: {
        body: `${prefix}2026年10月10日 发布检查记录。${"x".repeat(1500)}`,
      },
      occurredAt: "2026-10-10T00:00:00Z",
    });

    const res = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "2026年10月10日 发布检查",
      limit: 10,
    });

    const rightIdx = res.items.findIndex((i) => i.id === rightYearDoc.id);
    const wrongIdx = res.items.findIndex((i) => i.id === wrongYearDoc.id);
    expect(rightIdx).toBe(0);
    if (wrongIdx !== -1) {
      expect(res.items[rightIdx]!.score).toBeGreaterThan(
        res.items[wrongIdx]!.score,
      );
    }
    eng.close();
  });
});
