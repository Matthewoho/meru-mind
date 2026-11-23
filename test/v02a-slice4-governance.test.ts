import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  formatBriefMarkdown,
  formatSearchMarkdown,
  formatTreeMarkdown,
  MindError,
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
      1, 2, 3, 4, 5, 6, 7, 8,
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
