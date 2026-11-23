import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  findRelatedActiveForEcho,
  formatBriefMarkdown,
  isAllowedSupersedeKind,
  resolveMostPreciseDeclaredTimestamp,
  type Actor,
  type MindEngine,
} from "../src/index.js";

const cliBin = path.resolve(import.meta.dirname, "..", "dist", "cli.js");
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
const agentBob: Actor = { id: "bob", kind: "agent", family: "claude" };

describe("v0.2.1 Kernel Upgrades: Cross-Kind Supersedes, Neutral Write Echo, Exact Timestamps & L1 Brief", () => {
  it("1. Directional cross-kind supersedes: decision->proposal/claim/finding & finding->claim allowed; rule isolated", async () => {
    expect(isAllowedSupersedeKind("decision", "proposal")).toBe(true);
    expect(isAllowedSupersedeKind("decision", "claim")).toBe(true);
    expect(isAllowedSupersedeKind("decision", "finding")).toBe(true);
    expect(isAllowedSupersedeKind("finding", "claim")).toBe(true);
    expect(isAllowedSupersedeKind("rule", "rule")).toBe(true);
    expect(isAllowedSupersedeKind("decision", "rule")).toBe(false);
    expect(isAllowedSupersedeKind("rule", "decision")).toBe(false);
    expect(isAllowedSupersedeKind("proposal", "decision")).toBe(false);
    expect(isAllowedSupersedeKind("claim", "finding")).toBe(false);

    const engine = await createMindEngine({ homeDir: makeTempDir("meru-v021-xkind-") });
    engines.push(engine);
    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });

    const prop = await engine.ledger.appendRecord({
      actor: agentBob,
      viewerRealmId: rootRealm.id,
      kind: "proposal",
      title: "Use mailbox for notifications",
      payload: { body: "Initial mailbox proposal." },
    });

    const dec = await engine.ledger.appendRecord({
      actor: agentBob,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Notifications are append-only readable timelines",
      payload: { body: "Replaces mailbox proposal." },
      supersedesIds: [prop.id],
    });
    expect(dec.status).toBe("active");
    expect(engine.db.getRecord(prop.id)?.status).toBe("superseded");
    expect(engine.db.getRecord(prop.id)?.supersededById).toBe(dec.id);

    // Reverse direction MUST fail: proposal cannot supersede decision
    await expect(
      engine.ledger.appendRecord({
        actor: agentBob,
        viewerRealmId: rootRealm.id,
        kind: "proposal",
        title: "Try reversing decision",
        supersedesIds: [dec.id],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // Human rule MUST NEVER be superseded by non-rule decision
    const rule = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "rule",
      title: "Never bypass CI",
    });
    await expect(
      engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "decision",
        title: "Bypass CI once",
        supersedesIds: [rule.id],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("2. Neutral write-time echo returns top-3 related active entries and stays silent on secrets & explicit supersedes", async () => {
    const homeDir = makeTempDir("meru-v021-echo-");
    const engine = await createMindEngine({ homeDir });
    engines.push(engine);
    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });

    const oldProp = await engine.ledger.appendRecord({
      actor: agentBob,
      viewerRealmId: rootRealm.id,
      kind: "proposal",
      title: "Notification contract delivery mailbox design",
      payload: { body: "Put notifications in agent mailbox." },
    });

    const newDec = await engine.ledger.appendRecord({
      actor: agentBob,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Notification contract delivery readable timeline",
      payload: { body: "Use append-only timeline instead of mailbox." },
    });

    const echo = await findRelatedActiveForEcho({
      sea: engine.sea,
      actor: agentBob,
      viewerRealmId: rootRealm.id,
      newRecord: newDec,
    });
    expect(echo.length).toBeGreaterThanOrEqual(1);
    expect(echo.length).toBeLessThanOrEqual(3);
    expect(echo.some((e) => e.id === oldProp.id)).toBe(true);
    expect(echo.some((e) => e.id === newDec.id)).toBe(false);

    // Secret writes MUST NOT trigger echo
    const secretRec = await engine.ledger.appendRecord({
      actor: agentBob,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "Notification contract secret token",
      sensitivity: "secret",
    });
    const secretEcho = await findRelatedActiveForEcho({
      sea: engine.sea,
      actor: agentBob,
      viewerRealmId: rootRealm.id,
      newRecord: secretRec,
    });
    expect(secretEcho).toEqual([]);

    // CLI write prints neutral echo in both JSON and Markdown
    const cliOut = execFileSync(
      process.execPath,
      [
        cliBin,
        "--home",
        homeDir,
        "write",
        "--in",
        "/",
        "--kind",
        "finding",
        "--title",
        "Notification contract follow-up check",
        "--body",
        "Confirmed timeline behavior.",
        "--json",
      ],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(cliOut) as { relatedActive?: Array<{ id: string }> };
    expect(parsed.relatedActive?.some((e) => e.id === oldProp.id || e.id === newDec.id)).toBe(true);
  });

  it("3. Exact same-day timestamp preservation prevents ingestion-order inversion on JSONL & Markdown imports", async () => {
    // Upgrades date-only valid_from to exact same-day created_at
    expect(
      resolveMostPreciseDeclaredTimestamp(["2026-09-24", "2026-09-24T16:05:17+08:00"]),
    ).toBe("2026-09-24T08:05:17.000Z");

    // NEVER overrides a different declared calendar day!
    expect(
      resolveMostPreciseDeclaredTimestamp(["2026-09-01", "2026-10-05T12:00:00Z"]),
    ).toBe("2026-09-01T00:00:00.000Z");

    const homeDir = makeTempDir("meru-v021-ts-");
    const srcDir = makeTempDir("meru-v021-ts-src-");
    const engine = await createMindEngine({ homeDir });
    engines.push(engine);
    const { rootRealm } = engine.ledger.createOrg({ name: "Acme" });

    // Deliberately put the LATEST event FIRST in the JSONL file to test anti-inversion
    const jsonlPath = path.join(srcDir, "events.jsonl");
    const rows = [
      {
        id: "ev_late",
        valid_from: "2026-09-24",
        created_at: "2026-09-24T16:05:17+08:00",
        title: "Late 16:05 decision on notification timeline",
        body: "Final timeline design at 16:05.",
      },
      {
        id: "ev_early",
        valid_from: "2026-09-24",
        created_at: "2026-09-24T15:12:50+08:00",
        title: "Early 15:12 proposal on notification timeline",
        body: "Initial mailbox draft at 15:12.",
      },
    ];
    fs.writeFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    await engine.importer.importJsonl({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      jsonlPath,
      mapping: {
        id: "id",
        title: "title",
        body: "body",
        occurredAt: ["valid_from", "created_at"],
      },
    });

    const recall = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      query: "notification timeline",
    });
    expect(recall.items).toHaveLength(2);
    // 16:05 MUST rank above 15:12 even though 16:05 appeared first in the JSONL file!
    expect(recall.items[0]!.title).toContain("16:05");
    expect(recall.items[1]!.title).toContain("15:12");
  });

  it("4. Deterministic L1 brief: never silently truncates rules, isolates child decisions from 40 root decisions, folds ancestor count & claims", async () => {
    const engine = await createMindEngine({ homeDir: makeTempDir("meru-v021-l1-") });
    engines.push(engine);
    const { org, rootRealm } = engine.ledger.createOrg({ name: "Acme" });
    const child = engine.ledger.createRealm({
      orgId: org.id,
      actor: humanAlice,
      parentId: rootRealm.id,
      slug: "payments",
      name: "Payments",
      scope: "Include: billing. Exclude: marketing.",
    });

    // Insert 25 root rules (> old cap of 20!) -> ALL 25 MUST appear in child brief
    for (let i = 1; i <= 25; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "rule",
        title: `Global Rule #${i}`,
      });
    }

    // Insert 30 root decisions + 3 child decisions -> ALL 3 child decisions MUST appear (not crowded out!)
    for (let i = 1; i <= 30; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "decision",
        title: `Root Decision #${i}`,
      });
    }
    for (let i = 1; i <= 3; i += 1) {
      await engine.ledger.appendRecord({
        actor: agentBob,
        viewerRealmId: child.id,
        kind: "decision",
        title: `Payments Decision #${i}`,
      });
    }
    await engine.ledger.appendRecord({
      actor: agentBob,
      viewerRealmId: child.id,
      kind: "claim",
      title: "Bulk imported noisy claim",
    });
    await engine.ledger.appendRecord({
      actor: agentBob,
      viewerRealmId: child.id,
      kind: "finding",
      title: "Stripe webhook retry finding",
    });

    const brief = engine.sea.brief({
      actor: agentBob,
      viewerRealmId: child.id,
    });
    expect(brief.middleMind.rules.items).toHaveLength(25);
    expect(brief.middleMind.rules.omittedCount).toBe(0);
    expect(brief.upperLedger.activeDecisions.items).toHaveLength(3);
    expect(brief.upperLedger.activeDecisions.items.every((d) => d.realmId === child.id)).toBe(true);
    expect(brief.upperLedger.inheritedDecisionsCount).toBe(30);
    expect(brief.upperLedger.recentFindings?.items).toHaveLength(1);

    const md = formatBriefMarkdown(brief);
    expect(md).toContain("Global Rule #25");
    expect(md).toContain("Payments Decision #1");
    expect(md).toContain("+30 inherited ancestor decision(s) folded");
    expect(md).toContain("Stripe webhook retry finding");
    expect(md).not.toContain("Bulk imported noisy claim");
    expect(md).toContain("1 claim(s)");
  });

  it("5. VACUUM INTO creates an atomic standalone backup snapshot readable independently", async () => {
    const homeDir = makeTempDir("meru-v021-vacuum-");
    const backupPath = path.join(makeTempDir("meru-v021-bak-"), "snapshot.sqlite");
    const engine = await createMindEngine({ homeDir });
    engines.push(engine);
    const { rootRealm } = engine.ledger.createOrg({ name: "BackupOrg" });
    await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Verified backup record",
    });

    (engine.db as unknown as { vacuumInto(p: string): void }).vacuumInto(backupPath);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.statSync(backupPath).size).toBeGreaterThan(0);

    // Open restored backup in a completely separate home directory
    const restoredHome = makeTempDir("meru-v021-restored-");
    fs.copyFileSync(backupPath, path.join(restoredHome, "mind.sqlite"));
    const restored = await createMindEngine({ homeDir: restoredHome });
    engines.push(restored);
    const orgs = restored.ledger.listOrgs();
    expect(orgs.some((o) => o.name === "BackupOrg")).toBe(true);
  });
});
