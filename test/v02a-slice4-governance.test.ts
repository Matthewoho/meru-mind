import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  discoverWorkspaceRealmMarker,
  formatBriefMarkdown,
  formatSearchMarkdown,
  formatTreeMarkdown,
  formatWhoamiMarkdown,
  MindError,
  resolveAccessScope,
  resolveWriteTargetRealm,
  type Actor,
  type EmbedderPort,
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

    // Both co-located entries (concise fact AND deep offset-42k SOP) MUST reach tier 3 (>=3000),
    // while the scattered mega-doc MUST drop to tier 2 (<3000)! (Kills M01)
    expect(idxFact).toBeLessThan(idxScattered);
    expect(idxDeep).toBeLessThan(idxScattered);
    expect(Math.floor(res.items[idxFact]!.score / 1000)).toBe(3);
    expect(Math.floor(res.items[idxDeep]!.score / 1000)).toBe(3);
    expect(Math.floor(res.items[idxScattered]!.score / 1000)).toBe(2);

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

describe("V0.2a Slice 4 — Pillar 2: Human-Only Realm Topology, Round-Trip Object Ref Validation & Ref-Safe Fallback", () => {
  it("validates object kind & round-trip ref syntax (allowing repo:org/name, host:redis:6379, person:a@b.com, CJK) and falls back to obj_id on legacy space names", async () => {
    const homeDir = makeTempHome();
    const eng = await createMindEngine({ homeDir });
    const { org, rootRealm } = eng.ledger.createOrg({
      name: "RefCheckOrg",
      policy: "open",
      actor: humanAdmin,
    });

    // Valid real-world object names MUST succeed and round-trip
    for (const [kind, name] of [
      ["repo", "org/service-api"],
      ["host", "redis:6379"],
      ["person", "alice@example.com"],
      ["service", "api/v2"],
      ["release", "v1.2.3"],
      ["person", "李明"],
    ] as const) {
      const obj = eng.objects.createObject({
        actor: agentWorker,
        viewerRealmId: rootRealm.id,
        kind,
        name,
      });
      const card = await eng.sea.show({
        actor: agentWorker,
        viewerRealmId: rootRealm.id,
        ref: `${kind}:${name}`,
      });
      expect(card.refType).toBe("object");
      if (card.refType === "object") {
        expect(card.card.object?.id).toBe(obj.id);
        expect(card.card.try).toBe(`meru-mind ls ${kind}:${name}`);
      }
    }

    // Invalid kinds or non-round-trippable names MUST fail with INVALID_INPUT
    for (const [badKind, badName] of [
      ["2fa", "token"],
      ["服务", "gateway"],
      ["file", "readme"],
      ["person", "Alex Smith"],
      ["service", "api//v2"],
      ["service", "api/"],
      ["service", "bad\tname"],
    ] as const) {
      expect(() =>
        eng.objects.createObject({
          actor: agentWorker,
          viewerRealmId: rootRealm.id,
          kind: badKind,
          name: badName,
        }),
      ).toThrow(/Invalid object|reserved/i);
    }

    // Simulate pre-existing legacy object with whitespace in name (inserted directly in DB)
    const legacyId = "obj_legacy_space_01";
    eng.db.insertObject({
      id: legacyId,
      orgId: org.id,
      parentObjectId: null,
      realmId: rootRealm.id,
      kind: "person",
      name: "Legacy Space Name",
      createdAt: new Date().toISOString(),
    });

    const legacyShow = await eng.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: legacyId,
    });
    expect(legacyShow.refType).toBe("object");
    if (legacyShow.refType === "object") {
      // Centralized formatCanonicalObjectRef falls back to obj_... so Next: is directly pasteable!
      expect(legacyShow.card.ref).toBe(legacyId);
      expect(legacyShow.card.try).toBe(`meru-mind ls ${legacyId}`);
    }

    const lsLegacy = await eng.sea.ls({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: legacyId,
    });
    expect(lsLegacy.resolvedId).toBe(legacyId);
    eng.close();
  });
});

describe("V0.2a Slice 4 — Pillar 3: Migration v8 realms.scope, realm set & archive/unarchive write freeze", () => {
  it("supports realm scope/set, ancestor-computed archive freeze across all write paths, searchable archived entries with [archived], and redact exemption", async () => {
    const homeDir = makeTempHome();
    const eng = await createMindEngine({ homeDir });
    expect(eng.db.listSchemaMigrations().map((m) => m.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);

    const { org, rootRealm } = eng.ledger.createOrg({
      name: "GovOrg",
      policy: "open",
      actor: humanAdmin,
    });
    const parent = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "legacy",
      name: "Legacy Ops",
      scope: "Include: legacy migrations. Exclude: active product work.",
    });
    const child = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: parent.id,
      slug: "v1",
      name: "Legacy v1",
      scope: "Include: v1 sunset notes. Exclude: v2.",
    });

    // Seed an entry in child before archiving parent
    const childRec = await eng.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: child.id,
      realmId: child.id,
      kind: "decision",
      title: "ArchiveSearchToken771 sunset plan",
      payload: { body: "Sunset v1 endpoints by Q4." },
      occurredAt: "2026-10-01T00:00:00Z",
    });

    // Root "/" cannot be archived
    expect(() =>
      eng.ledger.archiveRealm({
        actor: humanAdmin,
        orgId: org.id,
        realmId: rootRealm.id,
      }),
    ).toThrow(/Root realm/);

    // Agents cannot update or archive realms
    expect(() =>
      eng.ledger.updateRealm({
        actor: agentWorker,
        orgId: org.id,
        realmId: parent.id,
        scope: "Hijack",
      }),
    ).toThrow(/Only human actors/);
    expect(() =>
      eng.ledger.archiveRealm({
        actor: agentWorker,
        orgId: org.id,
        realmId: parent.id,
      }),
    ).toThrow(/Only human actors/);

    // Archive parent -> both parent and descendant child become effectively archived
    const arch1 = eng.ledger.archiveRealm({
      actor: humanAdmin,
      orgId: org.id,
      realmId: parent.id,
    });
    expect(arch1.alreadyArchived).toBe(false);
    expect(arch1.effectivelyArchived).toBe(true);
    // Idempotent second archive
    const arch2 = eng.ledger.archiveRealm({
      actor: humanAdmin,
      orgId: org.id,
      realmId: parent.id,
    });
    expect(arch2.alreadyArchived).toBe(true);

    // realm set IS allowed on archived realm (slug/path remain immutable!)
    const updated = eng.ledger.updateRealm({
      actor: humanAdmin,
      orgId: org.id,
      realmId: parent.id,
      name: "Legacy Ops (Sunset)",
      scope: "Archived after v1 sunset; read-only history.",
    });
    expect(updated.name).toBe("Legacy Ops (Sunset)");
    expect(updated.slug).toBe("legacy");
    expect(updated.path).toBe("/legacy");
    expect(updated.scope).toContain("Archived after v1 sunset");

    // Single choke-point write freeze blocks ALL write paths on child (inherited archive) with CONFLICT
    const assertConflictArchived = async (fn: () => unknown | Promise<unknown>) => {
      let caught: unknown;
      try {
        await fn();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MindError);
      expect((caught as MindError).code).toBe("CONFLICT");
      expect((caught as MindError).details?.reason).toBe("realm_archived");
    };

    await assertConflictArchived(() =>
      eng.ledger.appendRecord({
        actor: agentWorker,
        viewerRealmId: child.id,
        realmId: child.id,
        kind: "finding",
        title: "Blocked write",
        payload: { body: "Nope" },
      }),
    );
    await assertConflictArchived(() =>
      eng.ledger.captureSeabed({
        actor: agentWorker,
        viewerRealmId: child.id,
        realmId: child.id,
        kind: "message",
        text: "Blocked raw",
      }),
    );
    await assertConflictArchived(() =>
      eng.ledger.writeDriveFile({
        actor: agentWorker,
        viewerRealmId: child.id,
        realmId: child.id,
        relPath: "frozen.md",
        content: "Must never hit disk",
      }),
    );
    // Verify writeDriveFile did NOT leave a partial file on disk!
    expect(await eng.drive.listFiles(child.id)).toEqual([]);

    await assertConflictArchived(() =>
      eng.objects.createObject({
        actor: agentWorker,
        viewerRealmId: child.id,
        kind: "service",
        name: "frozen-svc",
      }),
    );
    await assertConflictArchived(() =>
      eng.sea.settle({
        actor: agentWorker,
        viewerRealmId: child.id,
        realmId: child.id,
        layer: "card_realm",
        periodKey: "2026-11-23",
      }),
    );
    await assertConflictArchived(() =>
      eng.ledger.createRealm({
        actor: humanAdmin,
        orgId: org.id,
        parentId: child.id,
        slug: "sub",
        name: "Sub",
      }),
    );

    // Default tree hides archived realms & shows visible hidden count; --all shows them with [archived] + scope
    const defaultTree = eng.sea.tree({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      depth: "all",
    });
    expect(defaultTree.hiddenArchivedCount).toBe(2);
    expect(defaultTree.realms.map((r) => r.path)).toEqual(["/"]);
    expect(formatTreeMarkdown(defaultTree)).toContain(
      "2 archived realm(s) hidden; pass --all to show",
    );

    const fullTree = eng.sea.tree({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      depth: "all",
      includeArchived: true,
    });
    expect(fullTree.hiddenArchivedCount).toBeUndefined();
    const fullTreeMd = formatTreeMarkdown(fullTree);
    expect(fullTreeMd).toContain("[archived]");
    expect(fullTreeMd).toContain("Archived after v1 sunset");

    // Default search STILL returns entries in archived realms with [archived] badge (Matthew decision 2a!)
    const searchRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "ArchiveSearchToken771",
    });
    expect(searchRes.items[0]?.id).toBe(childRec.id);
    expect(searchRes.items[0]?.realmArchived).toBe(true);
    expect(formatSearchMarkdown(searchRes)).toContain("`/legacy/v1` [archived]");

    // Brief on archived realm shows [archived] and Scope
    const brief = eng.sea.brief({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      target: parent.path,
    });
    expect(brief.realmArchived).toBe(true);
    expect(formatBriefMarkdown(brief)).toContain("[archived]");
    expect(formatBriefMarkdown(brief)).toContain("Scope: Archived after v1 sunset");

    // Unarchive child while parent is STILL archived reports effectivelyArchived=true + archivedAncestorPath
    const childUnarch = eng.ledger.unarchiveRealm({
      actor: humanAdmin,
      orgId: org.id,
      realmId: child.id,
    });
    expect(childUnarch.effectivelyArchived).toBe(true);
    expect(childUnarch.archivedAncestorPath).toBe("/legacy");

    // Compliance redact() is STILL allowed on archived realm!
    const red = await eng.ledger.redact({
      actor: humanAdmin,
      orgId: org.id,
      entryId: childRec.id,
      reason: "compliance cleanup",
    });
    expect(red.entryId).toBe(childRec.id);
    expect(red.redactedAt).toBeTruthy();

    // Unarchive parent restores writes on child
    const parentUnarch = eng.ledger.unarchiveRealm({
      actor: humanAdmin,
      orgId: org.id,
      realmId: parent.id,
    });
    expect(parentUnarch.effectivelyArchived).toBe(false);
    const afterRec = await eng.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: child.id,
      realmId: child.id,
      kind: "finding",
      title: "Restored write",
      payload: { body: "Writes work again." },
    });
    expect(afterRec.status).toBe("active");
    eng.close();
  });

  it("never leaks hidden archived ancestor paths or counts in tree mode", async () => {
    const homeDir = makeTempHome();
    const eng = await createMindEngine({ homeDir });
    const { org, rootRealm } = eng.ledger.createOrg({
      name: "TreeArchiveOrg",
      policy: "tree",
      actor: humanAdmin,
    });
    const secretBranch = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "secret-branch",
      name: "Secret Branch",
    });
    const mountedLeaf = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: secretBranch.id,
      slug: "leaf",
      name: "Leaf",
    });
    const viewer = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "viewer",
      name: "Viewer",
    });

    eng.ledger.mountRealm({
      actor: humanAdmin,
      viewerRealmId: viewer.id,
      targetRealmId: mountedLeaf.id,
      scope: "ledger",
    });
    // Archive hidden ancestor secret-branch
    eng.ledger.archiveRealm({
      actor: humanAdmin,
      orgId: org.id,
      realmId: secretBranch.id,
    });

    // Tree from /viewer: sees ONLY 1 hidden archived realm (mountedLeaf), NEVER secret-branch!
    const treeDefault = eng.sea.tree({
      actor: agentWorker,
      viewerRealmId: viewer.id,
      depth: "all",
    });
    expect(treeDefault.hiddenArchivedCount).toBe(1);
    expect(JSON.stringify(treeDefault)).not.toContain("secret-branch");

    const treeAll = eng.sea.tree({
      actor: agentWorker,
      viewerRealmId: viewer.id,
      depth: "all",
      includeArchived: true,
    });
    const mountedNode = treeAll.realmTree.find(
      (n) => n.realm.id === mountedLeaf.id,
    );
    expect(mountedNode?.realm.path).toBe("@mounted/leaf");
    expect(mountedNode?.effectivelyArchived).toBe(true);
    expect(JSON.stringify(treeAll)).not.toContain("secret-branch");
    eng.close();
  });
});

describe("V0.2a Slice 4 — Pillar 4: Atomic entry move & Importer P0-2 preservation", () => {
  it("moves records and seabed atomically across realms, updates FTS/idempotency/change_log, expands supersede chains in tree mode, allows archive evacuation, and rejects drive artifacts", async () => {
    const homeDir = makeTempHome();
    const eng = await createMindEngine({ homeDir });
    const { org, rootRealm } = eng.ledger.createOrg({
      name: "MoveOrg",
      policy: "open",
      actor: humanAdmin,
    });
    const src = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "src",
      name: "Source",
      scope: "Temporary holding",
    });
    const dst = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "dst",
      name: "Destination",
      scope: "Permanent home",
    });

    const rec = await eng.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: src.id,
      realmId: src.id,
      kind: "finding",
      title: "MoveableToken882 finding",
      payload: { body: "Payload stays intact across realm move." },
      occurredAt: "2026-10-15T10:00:00Z",
      idempotencyKey: "move-key-882",
    });
    const rawMsg = await eng.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: src.id,
      realmId: src.id,
      kind: "message",
      text: "MoveableRawToken882 message",
    });
    const driveRes = await eng.ledger.writeDriveFile({
      actor: agentWorker,
      viewerRealmId: src.id,
      realmId: src.id,
      relPath: "pinned.md",
      content: "# Pinned file",
    });

    // Agents are forbidden from moving entries
    expect(() =>
      eng.ledger.moveEntries({
        actor: agentWorker,
        orgId: org.id,
        entryIds: [rec.id],
        targetRealmId: dst.id,
      }),
    ).toThrow(/Only human actors/);

    // Drive-backed seabed artifact CANNOT be moved
    expect(() =>
      eng.ledger.moveEntries({
        actor: humanAdmin,
        orgId: org.id,
        entryIds: [driveRes.artifactId],
        targetRealmId: dst.id,
      }),
    ).toThrow(/drive-backed seabed/);

    // Dry run returns plan without mutating DB
    const dry = eng.ledger.moveEntries({
      actor: humanAdmin,
      orgId: org.id,
      entryIds: [rec.id, rawMsg.id],
      targetRealmId: dst.id,
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.moved.length).toBe(2);
    expect(eng.db.getRecord(rec.id)?.realmId).toBe(src.id);

    // Archive src FIRST -> evacuation OUT of archived src to active dst MUST SUCCEED!
    eng.ledger.archiveRealm({
      actor: humanAdmin,
      orgId: org.id,
      realmId: src.id,
    });
    const moved = eng.ledger.moveEntries({
      actor: humanAdmin,
      orgId: org.id,
      entryIds: [rec.id, rawMsg.id],
      targetRealmId: dst.id,
    });
    expect(moved.moved.map((m) => m.id).sort()).toEqual(
      [rec.id, rawMsg.id].sort(),
    );
    expect(eng.db.getRecord(rec.id)?.realmId).toBe(dst.id);
    expect(eng.db.getRecord(rec.id)?.authorId).toBe(agentWorker.id);
    expect(eng.db.getRecord(rec.id)?.occurredAt).toBe("2026-10-15T10:00:00Z");
    expect(eng.db.getSeabedEntry(rawMsg.id)?.realmId).toBe(dst.id);
    expect(eng.db.getIdempotencyKey(org.id, "move-key-882")?.realmId).toBe(
      dst.id,
    );

    // FTS updated atomically: found in /dst, absent in /src!
    const inDst = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      in: "/dst",
      query: "MoveableToken882",
    });
    expect(inDst.items.map((i) => i.id)).toEqual([rec.id]);
    const inSrc = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      in: "/src",
      query: "MoveableToken882",
    });
    expect(inSrc.items.length).toBe(0);

    // Dual move_out / move_in change_log entries written
    const logs = eng.sea.listChangeLog({ orgId: org.id }).entries;
    expect(
      logs.some(
        (e) =>
          e.op === "move_out" && e.entityId === rec.id && e.realmId === src.id,
      ),
    ).toBe(true);
    expect(
      logs.some(
        (e) =>
          e.op === "move_in" && e.entityId === rec.id && e.realmId === dst.id,
      ),
    ).toBe(true);

    // Moving INTO archived realm fails with CONFLICT (realm_archived)
    let conflictErr: unknown;
    try {
      eng.ledger.moveEntries({
        actor: humanAdmin,
        orgId: org.id,
        entryIds: [rec.id],
        targetRealmId: src.id,
      });
    } catch (e) {
      conflictErr = e;
    }
    expect(conflictErr).toBeInstanceOf(MindError);
    expect((conflictErr as MindError).code).toBe("CONFLICT");
    expect((conflictErr as MindError).details?.reason).toBe("realm_archived");

    // Re-moving already-in-target entry is idempotent no-op
    const noop = eng.ledger.moveEntries({
      actor: humanAdmin,
      orgId: org.id,
      entryIds: [rec.id],
      targetRealmId: dst.id,
    });
    expect(noop.moved.length).toBe(0);
    expect(noop.skippedAlreadyInTargetIds).toEqual([rec.id]);
    eng.close();

    // Tree-mode supersede chain closure: moving B automatically expands to A -> B
    const treeHome = makeTempHome();
    const tEng = await createMindEngine({ homeDir: treeHome });
    const { org: tOrg, rootRealm: tRoot } = tEng.ledger.createOrg({
      name: "TreeMoveOrg",
      policy: "tree",
      actor: humanAdmin,
    });
    const tA = tEng.ledger.createRealm({
      actor: humanAdmin,
      orgId: tOrg.id,
      parentId: tRoot.id,
      slug: "a",
      name: "A",
    });
    const tB = tEng.ledger.createRealm({
      actor: humanAdmin,
      orgId: tOrg.id,
      parentId: tRoot.id,
      slug: "b",
      name: "B",
    });
    const recV1 = await tEng.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: tA.id,
      realmId: tA.id,
      kind: "decision",
      title: "Policy v1",
      payload: { body: "Old policy" },
    });
    const recV2 = await tEng.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: tA.id,
      realmId: tA.id,
      kind: "decision",
      title: "Policy v2",
      payload: { body: "New policy" },
      supersedesId: recV1.id,
    });

    const treeMove = tEng.ledger.moveEntries({
      actor: humanAdmin,
      orgId: tOrg.id,
      entryIds: [recV2.id],
      targetRealmId: tB.id,
    });
    expect(treeMove.moved.map((m) => m.id).sort()).toEqual(
      [recV1.id, recV2.id].sort(),
    );
    expect(treeMove.moved.find((m) => m.id === recV1.id)?.chainExpanded).toBe(
      true,
    );
    expect(tEng.db.getRecord(recV1.id)?.realmId).toBe(tB.id);
    expect(tEng.db.getRecord(recV2.id)?.realmId).toBe(tB.id);
    tEng.close();
  });

  it("importer P0-2: re-importing default-realm markdown after human entry move preserves moved realm instead of reverting or crashing", async () => {
    const homeDir = makeTempHome();
    const eng = await createMindEngine({ homeDir });
    const { org, rootRealm } = eng.ledger.createOrg({
      name: "ImpMoveOrg",
      policy: "open",
      actor: humanAdmin,
    });
    const ops = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "ops",
      name: "Ops",
    });

    const docsDir = makeTempHome();
    const mdFile = path.join(docsDir, "deploy-guide.md");
    fs.writeFileSync(mdFile, "# Deploy Guide\n\nVersion 1 steps.\n", "utf8");

    // 1. Initial import lands in default target "/"
    const imp1 = await eng.importer.importMd({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      targetRealmRef: "/",
      inputPath: docsDir,
      syncEmbeddings: false,
    });
    expect(imp1.created).toBe(1);
    const recId = imp1.items[0]!.recordId!;
    expect(eng.db.getRecord(recId)?.realmId).toBe(rootRealm.id);

    // 2. Human triages it to /ops via entry move
    eng.ledger.moveEntries({
      actor: humanAdmin,
      orgId: org.id,
      entryIds: [recId],
      targetRealmId: ops.id,
    });
    expect(eng.db.getRecord(recId)?.realmId).toBe(ops.id);

    // 3. Re-running importMd with default target "/" MUST keep it unchanged in /ops!
    const imp2 = await eng.importer.importMd({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      targetRealmRef: "/",
      inputPath: docsDir,
      syncEmbeddings: false,
    });
    expect(imp2.skippedUnchanged).toBe(1);
    expect(imp2.superseded).toBe(0);
    expect(eng.db.getRecord(recId)?.realmId).toBe(ops.id);

    // 4. Editing the markdown file and re-importing keeps the new revision in /ops!
    fs.writeFileSync(mdFile, "# Deploy Guide\n\nVersion 2 steps.\n", "utf8");
    const imp3 = await eng.importer.importMd({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      targetRealmRef: "/",
      inputPath: docsDir,
      syncEmbeddings: false,
    });
    expect(imp3.superseded).toBe(1);
    expect(imp3.items[0]!.realmId).toBe(ops.id);
    eng.close();
  });
});

describe("V0.2a Slice 4 — Pillar 5: 4-Tier Write Routing, Lazy /inbox, Hardened .meru-mind-realm & Optional --in", () => {
  it("routes writes deterministically across all 4 tiers, lazily creates /inbox without dumping to /, surfaces inbox count in whoami, and hardens .meru-mind-realm", async () => {
    const homeDir = makeTempHome();
    const eng = await createMindEngine({ homeDir });
    const { org, rootRealm } = eng.ledger.createOrg({
      name: "RouteOrg",
      policy: "open",
      actor: humanAdmin,
    });
    const ops = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "ops",
      name: "Operations",
      scope: "Include: prod ops. Exclude: product.",
    });
    const engRealm = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "eng",
      name: "Engineering",
      scope: "Include: code architecture. Exclude: ops.",
    });
    const oldRealm = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "old",
      name: "Old",
      scope: "Sunset realm",
    });

    const opsObj = eng.objects.createObject({
      actor: agentWorker,
      viewerRealmId: ops.id,
      targetRealmRef: "/ops",
      kind: "service",
      name: "ops-gateway",
    });
    const engObj = eng.objects.createObject({
      actor: agentWorker,
      viewerRealmId: engRealm.id,
      targetRealmRef: "/eng",
      kind: "service",
      name: "eng-compiler",
    });
    const rootObj = eng.objects.createObject({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      targetRealmRef: "/",
      kind: "concept",
      name: "org-wide-tag",
    });
    const oldObj = eng.objects.createObject({
      actor: agentWorker,
      viewerRealmId: oldRealm.id,
      targetRealmRef: "/old",
      kind: "service",
      name: "old-svc",
    });
    eng.ledger.archiveRealm({
      actor: humanAdmin,
      orgId: org.id,
      realmId: oldRealm.id,
    });

    const runRoute = (opts: {
      explicitIn?: string;
      isExplicitlyBound?: boolean;
      viewerRealmId?: string;
      workspaceMarkerRef?: string | null;
      about?: string[];
    }) => {
      const realms = eng.db.listRealms();
      const mounts = eng.db.listMounts();
      const viewerRealmId = opts.viewerRealmId ?? rootRealm.id;
      const scope = resolveAccessScope({
        realms,
        mounts,
        viewerRealmId,
        orgPolicy: "open",
        includeDescendantSeabed: false,
      });
      return resolveWriteTargetRealm({
        db: eng.db,
        ledger: eng.ledger,
        realms,
        mounts,
        scope,
        orgId: org.id,
        orgPolicy: "open",
        actor: agentWorker,
        viewerRealmId,
        isExplicitlyBound: opts.isExplicitlyBound ?? false,
        explicitIn: opts.explicitIn,
        workspaceMarkerRef: opts.workspaceMarkerRef ?? null,
        about: opts.about,
      });
    };

    // Tier 1: Explicit --in wins over everything
    const t1 = runRoute({
      explicitIn: "/ops",
      isExplicitlyBound: true,
      viewerRealmId: engRealm.id,
      about: ["service:eng-compiler"],
    });
    expect(t1.routedBy).toBe("explicit");
    expect(t1.realm.id).toBe(ops.id);

    // Tier 2a: Explicit binding beats workspace marker and --about
    const t2a = runRoute({
      isExplicitlyBound: true,
      viewerRealmId: engRealm.id,
      workspaceMarkerRef: "/ops",
      about: ["service:ops-gateway"],
    });
    expect(t2a.routedBy).toBe("bound");
    expect(t2a.realm.id).toBe(engRealm.id);

    // Tier 2b: Workspace marker beats --about when unbound
    const t2b = runRoute({
      workspaceMarkerRef: "/ops",
      about: ["service:eng-compiler"],
    });
    expect(t2b.routedBy).toBe("workspace_marker");
    expect(t2b.realm.id).toBe(ops.id);

    // Tier 2b archived marker fails loudly with CONFLICT (realm_archived)
    expect(() => runRoute({ workspaceMarkerRef: "/old" })).toThrow(/archived/i);

    // Tier 3: Unanimous non-root, non-archived --about object owner wins
    const t3 = runRoute({
      about: [`service:${opsObj.name}`, `concept:${rootObj.name}`, `service:${oldObj.name}`],
    });
    expect(t3.routedBy).toBe("about");
    expect(t3.realm.id).toBe(ops.id);

    // Tier 3 conflict (2 distinct non-root realms) abstains -> Tier 4 lazy /inbox!
    expect(eng.db.getRealmByPath(org.id, "/inbox")).toBeNull();
    const t4Conflict = runRoute({
      about: [`service:${opsObj.name}`, `service:${engObj.name}`],
    });
    expect(t4Conflict.routedBy).toBe("inbox");
    expect(t4Conflict.realm.path).toBe("/inbox");

    // Tier 4 also catches bare unbound writes (NEVER dumping into "/"!)
    const t4Bare = runRoute({});
    expect(t4Bare.routedBy).toBe("inbox");
    expect(t4Bare.realm.path).toBe("/inbox");

    // /inbox cannot be archived in open mode
    expect(() =>
      eng.ledger.archiveRealm({
        actor: humanAdmin,
        orgId: org.id,
        realmId: t4Bare.realm.id,
      }),
    ).toThrow(/Inbox realm/);

    // Hardened workspace marker discovery tests
    const fakeHome = makeTempHome();
    const gitRepo = path.join(fakeHome, "work", "repo");
    const subDir = path.join(gitRepo, "packages", "core");
    fs.mkdirSync(path.join(gitRepo, ".git"), { recursive: true });
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".meru-mind-realm"), "/eng\n", "utf8");
    // Stops at .git boundary (does NOT walk past .git to fakeHome!)
    expect(discoverWorkspaceRealmMarker(subDir, fakeHome)).toBeNull();

    // Marker inside repo root IS found when walking up from subDir
    fs.writeFileSync(path.join(gitRepo, ".meru-mind-realm"), "/ops\n", "utf8");
    expect(discoverWorkspaceRealmMarker(subDir, fakeHome)?.ref).toBe("/ops");

    // Symlink marker MUST be rejected without echoing target file content!
    const secretFile = path.join(fakeHome, "secret-token.txt");
    fs.writeFileSync(secretFile, "SUPER_SECRET_CANARY_999\n", "utf8");
    const symDir = makeTempHome();
    fs.symlinkSync(secretFile, path.join(symDir, ".meru-mind-realm"));
    let symErr = "";
    try {
      discoverWorkspaceRealmMarker(symDir, fakeHome);
    } catch (e) {
      symErr = (e as Error).message;
    }
    expect(symErr).toMatch(/symlink|non-regular/i);
    expect(symErr).not.toContain("SUPER_SECRET_CANARY_999");

    // Oversized > 512 bytes marker rejected without echoing content
    const bigDir = makeTempHome();
    fs.writeFileSync(
      path.join(bigDir, ".meru-mind-realm"),
      "x".repeat(600),
      "utf8",
    );
    expect(() => discoverWorkspaceRealmMarker(bigDir, fakeHome)).toThrow(
      /exceeds maximum size/,
    );

    // Invalid syntax marker rejected without echoing content
    const badSyntaxDir = makeTempHome();
    fs.writeFileSync(
      path.join(badSyntaxDir, ".meru-mind-realm"),
      "SECRET_PASSWORD_LINE\n",
      "utf8",
    );
    let badErr = "";
    try {
      discoverWorkspaceRealmMarker(badSyntaxDir, fakeHome);
    } catch (e) {
      badErr = (e as Error).message;
    }
    expect(badErr).toMatch(/syntax/i);
    expect(badErr).not.toContain("SECRET_PASSWORD_LINE");

    // Outside fakeHome: NEVER walks upward (prevents /tmp/.meru-mind-realm planting!)
    const outsideParent = makeTempHome();
    const outsideChild = path.join(outsideParent, "nested");
    fs.mkdirSync(outsideChild, { recursive: true });
    fs.writeFileSync(path.join(outsideParent, ".meru-mind-realm"), "/ops\n");
    expect(discoverWorkspaceRealmMarker(outsideChild, fakeHome)).toBeNull();
    eng.close();

    // CLI E2E: write WITHOUT --in routes to /inbox, echoes realmPath+routedBy, and shows up in whoami!
    const cliHome = makeTempHome();
    const cliBin = path.resolve("dist/cli.js");
    const runCli = (args: string[], cwd?: string) =>
      JSON.parse(
        execFileSync(process.execPath, [cliBin, ...args, "--json"], {
          env: { ...process.env, MERU_MIND_HOME: cliHome, MERU_MIND_VIEWER_REALM_ID: "" },
          cwd: cwd ?? cliHome,
          encoding: "utf8",
        }),
      );
    runCli(["admin", "init", "--org", "CliRouteOrg"]);
    const written = runCli([
      "write",
      "--title",
      "Unrouted CLI note",
      "--body",
      "Should land cleanly in /inbox, not root.",
    ]) as { id: string; realmPath: string; routedBy: string };
    expect(written.realmPath).toBe("/inbox");
    expect(written.routedBy).toBe("inbox");

    const who = runCli(["whoami"]) as {
      inbox?: { path: string; activeEntries: number };
    };
    expect(who.inbox?.path).toBe("/inbox");
    expect(who.inbox?.activeEntries).toBe(1);
    expect(formatWhoamiMarkdown(who as never)).toContain("`/inbox` (1 active pending triage)");
  });
});

describe("V0.2a Slice 4 — Post-Build Regression & T1 Mutation-Killer Suite (N1-N4, P2-1/2/6)", () => {
  it("kills M03/M04/M05/N3/P2-1/P2-2: overlapping stride, bucket saturation, partial-title CJK, word boundary & date seam", async () => {
    const homeDir = makeTempHome();
    const eng = await createMindEngine({ homeDir });
    const { rootRealm } = eng.ledger.createOrg({
      name: "WindowMathOrg",
      policy: "open",
      actor: humanAdmin,
    });

    // 1. M05 (overlapping stride=1000 vs 2000): concepts 100 chars apart straddling index 2000
    const straddleDoc = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "claim",
      title: "Straddle doc",
      payload: {
        body: `${"x".repeat(1940)} straddleAlpha ${"y".repeat(70)} straddleBeta ${"z".repeat(2500)}`,
      },
    });
    const straddleRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "straddleAlpha straddleBeta",
    });
    expect(straddleRes.items[0]?.id).toBe(straddleDoc.id);
    expect(Math.floor(straddleRes.items[0]!.score / 1000)).toBe(3);

    // 2. M03 (bucket early-exit): window 0 has partial CJK (1/3 bigrams), window 5 has full CJK (3/3)
    const bucketDoc = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "claim",
      title: "Long ops manual",
      payload: {
        body: `前期讨论系统集群架构。${"a".repeat(5200)} 最终确认：集群容灾演练通过 MarkerWin5。${"b".repeat(1500)}`,
      },
    });
    const bucketRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "集群容灾",
    });
    expect(bucketRes.items[0]?.id).toBe(bucketDoc.id);
    expect(Math.floor(bucketRes.items[0]!.score / 1000)).toBe(3);
    expect(bucketRes.items[0]!.snippet).toContain("MarkerWin5");

    // 3. N3 + M37 (partial-title CJK > 5000 chars): window 0 has "库迁" (which under broken B&B
    //    would saturate bucket h=1 via title union and prune window 5 containing "rollback").
    const partialTitleDoc = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "claim",
      title: "数据库 迁移手册",
      payload: {
        body: `前期讨论库迁方案细节。${"普通日志记录。".repeat(900)} 应急章节：执行 rollback 回退步骤。${"尾部填充。".repeat(300)}`,
      },
    });
    const partialRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "数据库迁移 rollback",
    });
    expect(partialRes.items[0]?.id).toBe(partialTitleDoc.id);
    expect(Math.floor(partialRes.items[0]!.score / 1000)).toBe(3);

    // 4. M04 & P2-2 & R2-2: ALL 5 CJK year-prefix cut points across index 1000
    //    ("body: " is 6 chars, so pad=989..993 places index 1000 at:
    //     2025年|10月10日, 2025|年10月10日, 202|5年10月10日, 20|25年10月10日, 2|025年10月10日).
    //    Each doc includes a far-away real "2026年10月10日" so activeBodyDates is non-empty!
    for (const pad of [989, 990, 991, 992, 993]) {
      const tag = `seamCut${pad}XYZ`;
      const dateSeamDoc = await eng.ledger.appendRecord({
        actor: humanAdmin,
        viewerRealmId: rootRealm.id,
        realmId: rootRealm.id,
        kind: "claim",
        title: `Archive seam ${pad}`,
        payload: {
          body: `${"p".repeat(pad)}2025年10月10日 ${tag} 处理完毕。${"q".repeat(3200)} 另附2026年10月10日无关远端记录。`,
        },
        occurredAt: "2024-01-01T00:00:00Z",
      });
      const seamRes = await eng.sea.search({
        actor: agentWorker,
        viewerRealmId: rootRealm.id,
        query: `2026年10月10日 ${tag}`,
      });
      const seamHit = seamRes.items.find((i) => i.id === dateSeamDoc.id);
      expect(seamHit).toBeDefined();
      expect(Math.floor(seamHit!.score / 1000)).toBe(2);
    }

    // P2-2: real 2026 date 3000 chars away from topic+2025 date must stay tier 2
    const farDateDoc = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "claim",
      title: "Far date log",
      payload: {
        body: `${"k".repeat(985)}2026年10月10日 远端段落。${"m".repeat(3100)} farTopicABC 发生在 2025年10月10日。${"n".repeat(1200)}`,
      },
      occurredAt: "2024-01-01T00:00:00Z",
    });
    const farRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "2026年10月10日 farTopicABC",
    });
    const farHit = farRes.items.find((i) => i.id === farDateDoc.id);
    expect(farHit).toBeDefined();
    expect(Math.floor(farHit!.score / 1000)).toBe(2);

    // 5. P2-1 + R2-4: window cut mid-word ("config|uration") MUST NOT fabricate a false word boundary,
    //    AND window cut at word end ("magix| probeTarget") MUST NOT fabricate standalone "x"!
    const cutWordDoc = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "claim",
      title: "Word boundary cut",
      payload: {
        body: `cutZebraOnly ${"w".repeat(1975)}configuration ${"v".repeat(2500)}`,
      },
    });
    const cutRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "cutZebraOnly config",
    });
    const cutHit = cutRes.items.find((i) => i.id === cutWordDoc.id);
    expect(cutHit).toBeDefined();
    expect(Math.floor(cutHit!.score / 1000)).toBe(2);

    const endWordDoc = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "claim",
      title: "Word end cut",
      payload: {
        body: `${"p".repeat(989)}magix probeTargetOnly ${"v".repeat(2500)}`,
      },
    });
    const endWordRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "x probeTargetOnly",
    });
    const endWordHit = endWordRes.items.find((i) => i.id === endWordDoc.id);
    expect(endWordHit).toBeDefined();
    expect(Math.floor(endWordHit!.score / 1000)).toBe(2);
    eng.close();
  });

  it("kills N1, M08, M16, N2/M19 & P2-6: real CLI --all/--dry-run, check order, vec_items move, importer tree/open moves & dangling symlink", async () => {
    // 1. N1: real CLI --all and --dry-run in ALL flag positions
    const cliHome = makeTempHome();
    const cliBin = path.resolve("dist/cli.js");
    const runCli = (args: string[]) =>
      JSON.parse(
        execFileSync(process.execPath, [cliBin, ...args, "--json"], {
          env: { ...process.env, MERU_MIND_HOME: cliHome, MERU_MIND_VIEWER_REALM_ID: "" },
          cwd: cliHome,
          encoding: "utf8",
        }),
      );
    runCli(["admin", "init", "--org", "CliBoolOrg"]);
    runCli(["realm", "create", "--parent", "/", "--slug", "eng", "--name", "Eng", "--scope", "Engineering", "--as-human"]);
    runCli(["realm", "create", "--parent", "/", "--slug", "old", "--name", "Old", "--scope", "Old work", "--as-human"]);
    const recA = runCli(["write", "--in", "/old", "--title", "A", "--body", "Body A"]) as { id: string };
    const recB = runCli(["write", "--in", "/old", "--title", "B", "--body", "Body B"]) as { id: string };
    runCli(["realm", "archive", "/old", "--as-human"]);

    // tree --all and realm list --all MUST work on real CLI!
    const treeAll = runCli(["tree", "--all"]) as { realms: Array<{ path: string }> };
    expect(treeAll.realms.map((r) => r.path)).toContain("/old");
    const listAll = runCli(["realm", "list", "--all"]) as Array<{ path: string }>;
    expect(listAll.map((r) => r.path)).toContain("/old");

    // entry move --dry-run in BOTH argument orders MUST NOT move A or B!
    const dry1 = runCli([
      "entry",
      "move",
      "--dry-run",
      recA.id,
      recB.id,
      "--to",
      "/eng",
      "--as-human",
    ]) as { dryRun: boolean; moved: Array<{ id: string }> };
    expect(dry1.dryRun).toBe(true);
    expect(dry1.moved.length).toBe(2);

    const dry2 = runCli([
      "entry",
      "move",
      recA.id,
      recB.id,
      "--to",
      "/eng",
      "--dry-run",
      "--as-human",
    ]) as { dryRun: boolean; moved: Array<{ id: string }> };
    expect(dry2.dryRun).toBe(true);
    expect(dry2.moved.length).toBe(2);

    // Verify neither A nor B actually moved!
    const showA = runCli(["show", recA.id]) as { entry: { realmPath: string } };
    const showB = runCli(["show", recB.id]) as { entry: { realmPath: string } };
    expect(showA.entry.realmPath).toBe("/old");
    expect(showB.entry.realmPath).toBe("/old");

    // 2. M08: in tree mode, writing to an invisible archived sibling throws ACCESS_DENIED (NOT CONFLICT) without leaking path
    const treeHome = makeTempHome();
    const tEng = await createMindEngine({ homeDir: treeHome });
    const { org: tOrg, rootRealm: tRoot } = tEng.ledger.createOrg({
      name: "OrderOrg",
      policy: "tree",
      actor: humanAdmin,
    });
    const secretArchived = tEng.ledger.createRealm({
      actor: humanAdmin,
      orgId: tOrg.id,
      parentId: tRoot.id,
      slug: "hidden-archived-xyz",
      name: "Hidden Archived",
    });
    const viewer = tEng.ledger.createRealm({
      actor: humanAdmin,
      orgId: tOrg.id,
      parentId: tRoot.id,
      slug: "viewer",
      name: "Viewer",
    });
    tEng.ledger.archiveRealm({
      actor: humanAdmin,
      orgId: tOrg.id,
      realmId: secretArchived.id,
    });
    let m08Err: unknown;
    try {
      await tEng.ledger.appendRecord({
        actor: agentWorker,
        viewerRealmId: viewer.id,
        targetRealmId: secretArchived.id,
        kind: "finding",
        title: "Probe",
        payload: { body: "Probe" },
      });
    } catch (e) {
      m08Err = e;
    }
    expect(m08Err).toBeInstanceOf(MindError);
    expect((m08Err as MindError).code).toBe("ACCESS_DENIED");
    expect((m08Err as MindError).message).not.toContain("hidden-archived-xyz");
    expect((m08Err as MindError).message).not.toMatch(/archived/i);

    // 3. N2 / M19: tree-mode 2-revision moved record + open-mode --in /beta moved record
    const tBeta = tEng.ledger.createRealm({
      actor: humanAdmin,
      orgId: tOrg.id,
      parentId: tRoot.id,
      slug: "beta",
      name: "Beta",
    });
    const tOps = tEng.ledger.createRealm({
      actor: humanAdmin,
      orgId: tOrg.id,
      parentId: tRoot.id,
      slug: "ops",
      name: "Ops",
    });
    const treeDocs = makeTempHome();
    const treeFile = path.join(treeDocs, "sop.md");
    fs.writeFileSync(treeFile, "# SOP\n\nRev 1\n", "utf8");
    const ti1 = await tEng.importer.importMd({
      actor: agentWorker,
      viewerRealmId: tBeta.id,
      inputPath: treeDocs,
      syncEmbeddings: false,
    });
    fs.writeFileSync(treeFile, "# SOP\n\nRev 2\n", "utf8");
    const ti2 = await tEng.importer.importMd({
      actor: agentWorker,
      viewerRealmId: tBeta.id,
      inputPath: treeDocs,
      syncEmbeddings: false,
    });
    const rev2Id = ti2.items[0]!.recordId!;
    expect(ti1.created).toBe(1);
    expect(ti2.superseded).toBe(1);
    // Human moves 2-rev chain from /beta to /ops
    tEng.ledger.moveEntries({
      actor: humanAdmin,
      orgId: tOrg.id,
      entryIds: [rev2Id],
      targetRealmId: tOps.id,
    });
    // Re-importing in /beta (both without --in and with explicit --in /beta) MUST skip cleanly (0 duplicates, 0 crash)!
    const ti3 = await tEng.importer.importMd({
      actor: agentWorker,
      viewerRealmId: tBeta.id,
      inputPath: treeDocs,
      syncEmbeddings: false,
    });
    expect(ti3.skippedUnchanged).toBe(1);
    expect(ti3.created).toBe(0);
    const ti4 = await tEng.importer.importMd({
      actor: agentWorker,
      viewerRealmId: tBeta.id,
      targetRealmRef: "/beta",
      inputPath: treeDocs,
      syncEmbeddings: false,
    });
    expect(ti4.skippedUnchanged).toBe(1);
    expect(ti4.created).toBe(0);
    tEng.close();

    // N2 open mode: explicit --in /beta after human entry move to /ops MUST stay in /ops!
    const openImpHome = makeTempHome();
    const oEng = await createMindEngine({ homeDir: openImpHome });
    const { org: oOrg, rootRealm: oRoot } = oEng.ledger.createOrg({
      name: "OpenN2Org",
      policy: "open",
      actor: humanAdmin,
    });
    const oBeta = oEng.ledger.createRealm({
      actor: humanAdmin,
      orgId: oOrg.id,
      parentId: oRoot.id,
      slug: "beta",
      name: "Beta",
    });
    const oOps = oEng.ledger.createRealm({
      actor: humanAdmin,
      orgId: oOrg.id,
      parentId: oRoot.id,
      slug: "ops",
      name: "Ops",
    });
    const oDocs = makeTempHome();
    fs.writeFileSync(path.join(oDocs, "guide.md"), "# Guide\n\nBody\n", "utf8");
    const oi1 = await oEng.importer.importMd({
      actor: agentWorker,
      viewerRealmId: oRoot.id,
      targetRealmRef: "/beta",
      inputPath: oDocs,
      syncEmbeddings: false,
    });
    const movedId = oi1.items[0]!.recordId!;
    oEng.ledger.moveEntries({
      actor: humanAdmin,
      orgId: oOrg.id,
      entryIds: [movedId],
      targetRealmId: oOps.id,
    });
    const oi2 = await oEng.importer.importMd({
      actor: agentWorker,
      viewerRealmId: oRoot.id,
      targetRealmRef: "/beta",
      inputPath: oDocs,
      syncEmbeddings: false,
    });
    expect(oi2.skippedUnchanged).toBe(1);
    expect(oi2.superseded).toBe(0);
    expect(oEng.db.getRecord(movedId)?.realmId).toBe(oOps.id);

    // R2-1: edit file to v2, re-import with --in /beta (stays in /ops as rec2),
    // then re-import UNCHANGED with --in /beta -> MUST still stay in /ops (never revert to /beta)!
    fs.writeFileSync(path.join(oDocs, "guide.md"), "# Guide\n\nBody v2\n", "utf8");
    const oi3 = await oEng.importer.importMd({
      actor: agentWorker,
      viewerRealmId: oRoot.id,
      targetRealmRef: "/beta",
      inputPath: oDocs,
      syncEmbeddings: false,
    });
    expect(oi3.superseded).toBe(1);
    const v2Id = oi3.items[0]!.recordId!;
    expect(oEng.db.getRecord(v2Id)?.realmId).toBe(oOps.id);

    const oi4 = await oEng.importer.importMd({
      actor: agentWorker,
      viewerRealmId: oRoot.id,
      targetRealmRef: "/beta",
      inputPath: oDocs,
      syncEmbeddings: false,
    });
    expect(oi4.skippedUnchanged).toBe(1);
    expect(oi4.superseded).toBe(0);
    expect(oEng.db.getRecord(v2Id)?.realmId).toBe(oOps.id);
    oEng.close();

    // 4. M16: vec_items partition key updated on entry move!
    const vecHome = makeTempHome();
    const stubEmbedder: EmbedderPort = {
      configured: true,
      model: "stub-4d",
      dimensions: 4,
      embed: async () => new Float32Array([0.5, 0.5, 0.5, 0.5]),
    };
    const vEng = await createMindEngine({ homeDir: vecHome, embedder: stubEmbedder });
    if (vEng.db.vecEnabled) {
      const { org: vOrg, rootRealm: vRoot } = vEng.ledger.createOrg({
        name: "VecMoveOrg",
        policy: "open",
        actor: humanAdmin,
      });
      const vSrc = vEng.ledger.createRealm({
        actor: humanAdmin,
        orgId: vOrg.id,
        parentId: vRoot.id,
        slug: "src",
        name: "Src",
      });
      const vDst = vEng.ledger.createRealm({
        actor: humanAdmin,
        orgId: vOrg.id,
        parentId: vRoot.id,
        slug: "dst",
        name: "Dst",
      });
      const vRec = await vEng.ledger.appendRecord({
        actor: agentWorker,
        viewerRealmId: vSrc.id,
        targetRealmId: vSrc.id,
        kind: "finding",
        title: "Vector entry",
        payload: { body: "Vectorized body" },
      });
      await vEng.sea.syncEmbeddings();
      const qVec = new Float32Array([0.5, 0.5, 0.5, 0.5]);
      expect(
        vEng.db.searchVectors({ embedding: qVec, realmIds: [vSrc.id], limit: 5 }).map((m) => m.itemId),
      ).toContain(vRec.id);
      vEng.ledger.moveEntries({
        actor: humanAdmin,
        orgId: vOrg.id,
        entryIds: [vRec.id],
        targetRealmId: vDst.id,
      });
      expect(
        vEng.db.searchVectors({ embedding: qVec, realmIds: [vSrc.id], limit: 5 }).map((m) => m.itemId),
      ).not.toContain(vRec.id);
      expect(
        vEng.db.searchVectors({ embedding: qVec, realmIds: [vDst.id], limit: 5 }).map((m) => m.itemId),
      ).toContain(vRec.id);
    }
    vEng.close();

    // 5. P2-6: dangling symlink marker MUST throw (not be silently ignored!)
    const dangDir = makeTempHome();
    fs.symlinkSync("/nonexistent/dangling/target/xyz", path.join(dangDir, ".meru-mind-realm"));
    expect(() => discoverWorkspaceRealmMarker(dangDir, dangDir)).toThrow(
      /symlink|non-regular/i,
    );
  });

  it("kills M29/M30/M31: real dist/mcp.js stdio mind_write with omitted in routes to /inbox and echoes realmPath + routedBy", async () => {
    const mcpHome = makeTempHome();
    const eng = await createMindEngine({ homeDir: mcpHome });
    const { org, rootRealm } = eng.ledger.createOrg({
      name: "McpRouteOrg",
      policy: "open",
      actor: humanAdmin,
    });
    const ops = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "ops",
      name: "Ops",
      scope: "Operations",
    });
    eng.objects.createObject({
      actor: agentWorker,
      viewerRealmId: ops.id,
      targetRealmRef: "/ops",
      kind: "service",
      name: "ops-edge",
    });
    eng.close();

    const child = spawn(process.execPath, [path.resolve("dist/mcp.js")], {
      env: { ...process.env, MERU_MIND_HOME: mcpHome, MERU_MIND_VIEWER_REALM_ID: "" },
      cwd: mcpHome,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses = new Map<number, unknown>();
    let buf = "";
    const waitForId = (id: number): Promise<any> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for MCP id=${id}`)), 8000);
        const check = () => {
          if (responses.has(id)) {
            clearTimeout(timer);
            resolve(responses.get(id));
          }
        };
        child.stdout.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) {
              try {
                const msg = JSON.parse(line) as { id?: number };
                if (typeof msg.id === "number") {
                  responses.set(msg.id, msg);
                  check();
                }
              } catch {
                // ignore
              }
            }
            nl = buf.indexOf("\n");
          }
        });
        check();
      });

    const send = (msg: unknown) => {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    };

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      await waitForId(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      // 1. mind_write WITHOUT `in` and WITHOUT `about` -> routes to /inbox (kills M29, M30, M31!)
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "mind_write",
          arguments: {
            title: "MCP inbox note",
            body: "No in specified; must land in /inbox.",
          },
        },
      });
      const r2 = await waitForId(2);
      expect(r2.result?.isError).not.toBe(true);
      const parsed2 = JSON.parse(r2.result.content[0].text) as {
        id: string;
        realmPath: string;
        routedBy: string;
      };
      expect(parsed2.realmPath).toBe("/inbox");
      expect(parsed2.routedBy).toBe("inbox");

      // 2. mind_write WITHOUT `in` and WITH `about: ["service:ops-edge"]` -> routes to /ops!
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "mind_write",
          arguments: {
            title: "MCP about-routed note",
            body: "Edge latency alert.",
            about: ["service:ops-edge"],
          },
        },
      });
      const r3 = await waitForId(3);
      expect(r3.result?.isError).not.toBe(true);
      const parsed3 = JSON.parse(r3.result.content[0].text) as {
        realmPath: string;
        routedBy: string;
      };
      expect(parsed3.realmPath).toBe("/ops");
      expect(parsed3.routedBy).toBe("about");
    } finally {
      child.kill();
    }
  });
});
