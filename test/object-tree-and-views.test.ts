import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  restoreWritablePermissions,
  type Actor,
  type MindEngine,
} from "../src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const distIndexUrl = new URL("../dist/index.js", import.meta.url).href;
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
const agentBot: Actor = { id: "bot-1", kind: "agent", family: "gemini" };

function runCliRaw(homeDir: string, args: string[]): string {
  return execFileSync(process.execPath, [cliBin, "--home", homeDir, ...args], {
    encoding: "utf8",
  });
}

function runCliJson(homeDir: string, args: string[]): unknown {
  const out = runCliRaw(homeDir, ["--json", ...args]);
  return JSON.parse(out.trim()) as unknown;
}

/**
 * Constructs a pre-v3 (post-v2) SQLite database fixture containing existing records
 * with payload.sourceRef and payload.externalRef, so Migration v3 backfill and
 * concurrent barrier upgrades are tested directly against a real v2 database.
 */
function createV02FixtureDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('change_log_generation', '1');
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'v0.1_baseline', '2026-10-01T00:00:00.000Z');
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'v0.2a_slice1a', '2026-10-02T00:00:00.000Z');

      CREATE TABLE orgs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_personal_root INTEGER NOT NULL DEFAULT 0,
        policy TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE realms (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id),
        parent_id TEXT REFERENCES realms(id),
        slug TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(org_id, path)
      );
      CREATE TABLE realm_mounts (
        id TEXT PRIMARY KEY,
        viewer_realm_id TEXT NOT NULL REFERENCES realms(id),
        target_realm_id TEXT NOT NULL REFERENCES realms(id),
        scope TEXT NOT NULL,
        mounted_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(viewer_realm_id, target_realm_id)
      );
      CREATE TABLE seabed_entries (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        realm_id TEXT NOT NULL REFERENCES realms(id),
        topic_id TEXT,
        kind TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_family TEXT,
        text TEXT NOT NULL,
        blob_sha256 TEXT,
        source_ref TEXT,
        metadata_json TEXT NOT NULL,
        occurred_at TEXT,
        origin_session_id TEXT,
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        redacted_at TEXT,
        redacted_by TEXT,
        redacted_reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        realm_id TEXT NOT NULL REFERENCES realms(id),
        thing_id TEXT,
        kind TEXT NOT NULL,
        ext_kind TEXT,
        status TEXT NOT NULL,
        supersedes_id TEXT REFERENCES records(id),
        superseded_by_id TEXT REFERENCES records(id),
        author_id TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_family TEXT,
        confirmed_by_human INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        refs_json TEXT NOT NULL,
        occurred_at TEXT,
        origin_session_id TEXT,
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        redacted_at TEXT,
        redacted_by TEXT,
        redacted_reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE distillations (
        id TEXT PRIMARY KEY,
        realm_id TEXT NOT NULL REFERENCES realms(id),
        layer TEXT NOT NULL,
        period_key TEXT NOT NULL,
        status TEXT NOT NULL,
        hard_facts_json TEXT NOT NULL,
        narrative_md TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE drive_files (
        realm_id TEXT NOT NULL REFERENCES realms(id),
        rel_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (realm_id, rel_path)
      );
      CREATE TABLE idempotency_keys (
        org_id TEXT NOT NULL,
        key TEXT NOT NULL,
        target_table TEXT NOT NULL,
        target_id TEXT NOT NULL,
        realm_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (org_id, key)
      );
      CREATE TABLE change_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        generation INTEGER NOT NULL,
        org_id TEXT NOT NULL,
        realm_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        op TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE redacted_blocklist (
        org_id TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        reason TEXT,
        redacted_at TEXT NOT NULL,
        PRIMARY KEY (org_id, source_ref, content_sha256)
      );
      CREATE VIRTUAL TABLE fts_index USING fts5(
        item_id UNINDEXED,
        source_type UNINDEXED,
        realm_id UNINDEXED,
        status UNINDEXED,
        title,
        body,
        tokenize = 'unicode61'
      );
      CREATE TABLE vec_pending (
        item_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        org_id TEXT NOT NULL,
        realm_id TEXT NOT NULL,
        status TEXT NOT NULL,
        text TEXT NOT NULL,
        queued_at TEXT NOT NULL
      );
    `);

    const t0 = "2026-10-01T00:00:00.000Z";
    raw
      .prepare(
        `INSERT INTO orgs (id, name, is_personal_root, policy, created_at) VALUES (?, ?, 0, 'open', ?)`,
      )
      .run("org_v2", "V2Org", t0);
    raw
      .prepare(
        `INSERT INTO realms (id, org_id, parent_id, slug, path, name, archived_at, created_at)
         VALUES ('realm_v2_root', 'org_v2', NULL, 'root', '/', 'Root', NULL, ?)`,
      )
      .run(t0);
    raw
      .prepare(
        `INSERT INTO records
         (id, org_id, realm_id, thing_id, kind, ext_kind, status, supersedes_id, superseded_by_id, author_id, author_kind, author_family, confirmed_by_human, title, payload_json, refs_json, occurred_at, origin_session_id, sensitivity, redacted_at, redacted_by, redacted_reason, created_at)
         VALUES ('rec_v2_legacy', 'org_v2', 'realm_v2_root', 'rec_v2_legacy', 'thing', NULL, 'active', NULL, NULL, 'alice', 'human', NULL, 1, 'Legacy Tracked Item', ?, '[]', ?, NULL, 'internal', NULL, NULL, NULL, ?)`,
      )
      .run(
        JSON.stringify({
          sourceRef: "docs/legacy-note.md",
          externalRef: "tracker:LEG-99",
        }),
        t0,
        t0,
      );
  } finally {
    raw.close();
  }
}

describe("Slice 2a: Migration v3, object single-parent tree, multi-valued realms, thing anchors, cross-realm supersedes, views & MCP", () => {
  it("1. Migration v3 barrier-synchronized 4-process concurrent upgrade backfills source_ref & external_ref without creating a things table", async () => {
    const rounds = 8;
    const workerCount = 4;

    const workerCode = `
      import readline from "node:readline";
      import { SqliteDb } from ${JSON.stringify(distIndexUrl)};

      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      process.stdout.write("READY\\n");

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const { dbPath, goAt } = JSON.parse(trimmed);
        while (Date.now() < goAt) {}
        let db;
        try {
          db = new SqliteDb({ dbPath, enableVector: false });
          const migrations = db.listSchemaMigrations().map((m) => m.version);
          const rec = db.getRecord("rec_v2_legacy");
          const bySource = db.findActiveRecordBySourceRef("org_v2", "docs/legacy-note.md");
          const byExt = db.findRecordsByExternalRef("org_v2", "tracker:LEG-99");
          if (migrations.join(",") !== "1,2,3,4") {
            throw new Error("unexpected migrations: " + migrations.join(","));
          }
          if (!rec || rec.sourceRef !== "docs/legacy-note.md" || rec.externalRef !== "tracker:LEG-99") {
            throw new Error("bad backfill on legacy record");
          }
          if (!bySource || bySource.id !== "rec_v2_legacy" || byExt.length !== 1) {
            throw new Error("indexed lookup failed");
          }
          process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\\n");
        } finally {
          try { db?.close(); } catch {}
        }
      }
    `;

    const spawnWorker = () => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", workerCode],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let buf = "";
      let readyResolve!: () => void;
      const ready = new Promise<void>((r) => {
        readyResolve = r;
      });
      let isReady = false;
      let pending: ((val: { ok: boolean; error?: string }) => void) | null =
        null;
      child.stdout.on("data", (d) => {
        buf += String(d);
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!isReady && line === "READY") {
            isReady = true;
            readyResolve();
          } else if (pending && line) {
            const res = pending;
            pending = null;
            res(JSON.parse(line) as { ok: boolean; error?: string });
          }
          nl = buf.indexOf("\n");
        }
      });
      return {
        ready,
        run(dbPath: string, goAt: number) {
          return new Promise<{ ok: boolean; error?: string }>((resolve) => {
            pending = resolve;
            child.stdin.write(`${JSON.stringify({ dbPath, goAt })}\n`);
          });
        },
        kill() {
          try {
            child.stdin.end();
            child.kill();
          } catch {}
        },
      };
    };

    const workers = Array.from({ length: workerCount }, () => spawnWorker());
    try {
      await Promise.all(workers.map((w) => w.ready));
      let lastDbPath = "";
      for (let round = 0; round < rounds; round += 1) {
        const dir = makeTempDir(`meru-mind-v3-race-r${round}-`);
        const dbPath = path.join(dir, "mind.sqlite");
        createV02FixtureDb(dbPath);
        lastDbPath = dbPath;

        const goAt = Date.now() + 20;
        const results = await Promise.all(
          workers.map((w) => w.run(dbPath, goAt)),
        );
        for (const r of results) {
          expect(r.error ?? "").not.toMatch(/duplicate column/i);
          expect(r).toEqual({ ok: true });
        }
      }

      // Inspect raw SQLite schema: objects, entry_objects, resource_tags exist; NO things table
      const inspect = new DatabaseSync(lastDbPath);
      inspect.exec("PRAGMA busy_timeout = 5000;");
      try {
        const tables = (
          inspect
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
            .all() as Array<{ name: string }>
        ).map((t) => t.name);
        expect(tables).toContain("objects");
        expect(tables).toContain("entry_objects");
        expect(tables).toContain("resource_tags");
        expect(tables).not.toContain("things");

        const indexes = (
          inspect
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
            .all() as Array<{ name: string }>
        ).map((i) => i.name);
        expect(indexes).toContain("idx_objects_org_realm");
        expect(indexes).toContain("idx_objects_org_parent");
        expect(indexes).toContain("idx_entry_objects_org_object");
        expect(indexes).toContain("idx_resource_tags_org_tag");
        expect(indexes).toContain("idx_records_org_external_ref");
        expect(indexes).toContain("idx_records_org_source_ref_status");
      } finally {
        inspect.close();
      }
    } finally {
      for (const w of workers) w.kill();
    }
  }, 20_000);

  it("2. Object single-parent tree, cycle prevention, tree-mode zero amplification, and opaque NOT_FOUND for hidden objects & realm paths", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-obj-tree-"),
      enableVector: false,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "StrictTreeOrg",
      policy: "tree",
    });
    const alpha = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "alpha",
      name: "Alpha",
    });
    const alphaSub = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: alpha.id,
      slug: "cicd",
      name: "Alpha CI/CD",
    });
    const beta = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "beta",
      name: "Beta",
    });

    // Single-parent object tree + cycle guard + child delete guard
    const objInfra = engine.objects.createObject({
      actor: agentBot,
      viewerRealmId: alpha.id,
      kind: "system",
      name: "Infra",
    });
    const objPipeline = engine.objects.createObject({
      actor: agentBot,
      viewerRealmId: alpha.id,
      parentObjectId: objInfra.id,
      kind: "service",
      name: "Deployer",
    });

    expect(() =>
      engine.objects.moveObject({
        actor: agentBot,
        viewerRealmId: alpha.id,
        objectId: objInfra.id,
        parentObjectId: objPipeline.id,
      }),
    ).toThrow(/Cycle detected/);

    expect(() =>
      engine.objects.deleteObject({
        actor: agentBot,
        viewerRealmId: alpha.id,
        objectId: objInfra.id,
      }),
    ).toThrow(/child objects still exist/);

    // Path addressing works for visible realms
    expect(
      engine.objects.resolveRealmRef({
        viewerRealmId: alpha.id,
        ref: "/alpha/cicd",
      }).id,
    ).toBe(alphaSub.id);

    // Opaque NOT_FOUND: hidden realm path vs nonexistent path MUST throw identical error code & message
    let hiddenPathErr: { code?: string; message?: string } = {};
    let missingPathErr: { code?: string; message?: string } = {};
    try {
      engine.objects.resolveRealmRef({
        viewerRealmId: beta.id,
        ref: "/alpha/cicd",
      });
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      hiddenPathErr = { code: err.code, message: err.message };
    }
    try {
      engine.objects.resolveRealmRef({
        viewerRealmId: beta.id,
        ref: "/does/not/exist",
      });
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      missingPathErr = { code: err.code, message: err.message };
    }
    expect(hiddenPathErr.code).toBe("NOT_FOUND");
    expect(hiddenPathErr).toEqual(missingPathErr);

    // Opaque NOT_FOUND: hidden sibling object vs nonexistent object on getObject, linkEntryObject, appendRecord(objectIds), ls
    const betaRec = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: beta.id,
      kind: "decision",
      title: "Beta decision",
    });

    const captureErr = async (fn: () => unknown) => {
      try {
        await fn();
        throw new Error("Expected throw");
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string };
        return { code: err.code, message: err.message };
      }
    };

    const hiddenObjGet = await captureErr(() =>
      engine.objects.getObject({
        viewerRealmId: beta.id,
        objectId: objInfra.id,
      }),
    );
    const missingObjGet = await captureErr(() =>
      engine.objects.getObject({
        viewerRealmId: beta.id,
        objectId: "obj_nonexistent_999",
      }),
    );
    expect(hiddenObjGet.code).toBe("NOT_FOUND");
    expect(hiddenObjGet).toEqual(missingObjGet);

    const hiddenObjLink = await captureErr(() =>
      engine.objects.linkEntryObject({
        actor: agentBot,
        viewerRealmId: beta.id,
        entryId: betaRec.id,
        objectId: objInfra.id,
      }),
    );
    const missingObjLink = await captureErr(() =>
      engine.objects.linkEntryObject({
        actor: agentBot,
        viewerRealmId: beta.id,
        entryId: betaRec.id,
        objectId: "obj_nonexistent_999",
      }),
    );
    expect(hiddenObjLink.code).toBe("NOT_FOUND");
    expect(hiddenObjLink).toEqual(missingObjLink);

    const hiddenWriteObj = await captureErr(() =>
      engine.ledger.appendRecord({
        actor: agentBot,
        viewerRealmId: beta.id,
        kind: "claim",
        title: "Attempt to attach hidden object",
        objectIds: [objInfra.id],
      }),
    );
    expect(hiddenWriteObj).toEqual(missingObjLink);

    // Zero amplification even after open -> tree policy transition!
    engine.ledger.setOrgPolicy({
      orgId: org.id,
      policy: "open",
      actor: humanAlice,
    });
    const objBeta = engine.objects.createObject({
      actor: agentBot,
      viewerRealmId: beta.id,
      kind: "service",
      name: "BetaService",
    });
    const alphaCrossLinked = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: alpha.id,
      kind: "decision",
      title: "Alpha secret-branch decision linked to BetaService",
      objectIds: [objBeta.id],
      resourceTags: ["svc:beta-shared"],
    });

    // In open mode, beta ls sees alphaCrossLinked via objBeta
    const openLsBeta = await engine.sea.ls({
      actor: agentBot,
      viewerRealmId: beta.id,
      target: "/beta",
    });
    expect(openLsBeta.items.some((i) => i.id === alphaCrossLinked.id)).toBe(
      true,
    );

    // Switch back to tree mode: beta MUST see zero items from alpha in ls(beta), ls(objBeta), ls(resource)
    engine.ledger.setOrgPolicy({
      orgId: org.id,
      policy: "tree",
      actor: humanAlice,
    });
    const treeLsBeta = await engine.sea.ls({
      actor: agentBot,
      viewerRealmId: beta.id,
      target: "/beta",
    });
    expect(treeLsBeta.items.some((i) => i.id === alphaCrossLinked.id)).toBe(
      false,
    );
    const treeLsObj = await engine.sea.ls({
      actor: agentBot,
      viewerRealmId: beta.id,
      target: objBeta.id,
    });
    expect(treeLsObj.items.some((i) => i.id === alphaCrossLinked.id)).toBe(
      false,
    );
    const treeLsTag = await engine.sea.ls({
      actor: agentBot,
      viewerRealmId: beta.id,
      target: "tag:svc:beta-shared",
    });
    expect(treeLsTag.items).toHaveLength(0);
    expect(
      engine.objects.listResourceTags({ viewerRealmId: beta.id }),
    ).toHaveLength(0);
  });

  it("3. Open-mode multi-valued realm focus boost, redact cleanup of resource_tags & entry_objects, thing anchors & cross-realm supersedes", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-open-multi-"),
      enableVector: false,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "OpenOrg",
      policy: "open",
    });
    const alpha = engine.ledger.createRealm({
      actor: agentBot,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "alpha",
      name: "Alpha",
    });
    const beta = engine.ledger.createRealm({
      actor: agentBot,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "beta",
      name: "Beta",
    });
    const gamma = engine.ledger.createRealm({
      actor: agentBot,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "gamma",
      name: "Gamma",
    });

    const objBeta = engine.objects.createObject({
      actor: agentBot,
      viewerRealmId: beta.id,
      kind: "service",
      name: "Payments",
    });

    // Multi-realm entry physically in alpha, linked to objBeta (in beta)
    const multiRec = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: alpha.id,
      kind: "decision",
      title: "Gateway timeout budget policy",
      payload: { detail: "Configure gateway timeout budget cleanly" },
      objectIds: [objBeta.id],
      resourceTags: ["svc:payments", "env:staging"],
    });
    const controlGamma = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: gamma.id,
      kind: "decision",
      title: "Gateway timeout budget policy",
      payload: { detail: "Configure gateway timeout budget cleanly" },
    });

    // Query from beta with explicit opt-in focusBoost=true: multiRec gets intra-band focus tie-breaker via objBeta
    const recallFromBeta = await engine.sea.recall({
      actor: agentBot,
      viewerRealmId: beta.id,
      query: "Gateway timeout budget",
      focusBoost: true,
    });
    const multiHit = recallFromBeta.items.find((i) => i.id === multiRec.id);
    const gammaHit = recallFromBeta.items.find((i) => i.id === controlGamma.id);
    expect(multiHit).toBeDefined();
    expect(gammaHit).toBeDefined();
    expect(recallFromBeta.items[0]!.id).toBe(multiRec.id);
    expect(multiHit!.score).toBeGreaterThan(gammaHit!.score);

    // Open-mode cross-realm supersede: v2 in beta supersedes v1 in alpha atomically (zero dual-active)
    const v2InBeta = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: beta.id,
      kind: "decision",
      title: "Gateway timeout budget policy v2",
      supersedesId: multiRec.id,
    });
    const oldAfter = engine.db.getRecord(multiRec.id)!;
    expect(oldAfter.status).toBe("superseded");
    expect(oldAfter.supersededById).toBe(v2InBeta.id);
    expect(v2InBeta.status).toBe("active");

    // Cross-org supersede is strictly forbidden even in open mode
    const { rootRealm: otherOrgRoot } = engine.ledger.createOrg({
      name: "OtherOpenOrg",
      policy: "open",
    });
    await expect(
      engine.ledger.appendRecord({
        actor: agentBot,
        viewerRealmId: otherOrgRoot.id,
        kind: "decision",
        title: "Cross-org hijack",
        supersedesId: v2InBeta.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Thing identity anchors reuse records.kind='thing' + external_ref with dedupe & sensitivity protection
    const thing1 = await engine.ledger.createThing({
      actor: agentBot,
      viewerRealmId: alpha.id,
      title: "Checkout Latency Workstream",
      externalRef: "tracker:CHK-101",
    });
    expect(thing1.kind).toBe("thing");
    expect(thing1.externalRef).toBe("tracker:CHK-101");

    const dedupedThing = await engine.ledger.createThing({
      actor: agentBot,
      viewerRealmId: beta.id,
      title: "Duplicate Checkout Latency",
      externalRef: "tracker:CHK-101",
      dedupeByExternalRef: true,
    });
    expect(dedupedThing.id).toBe(thing1.id);

    const secretThing = await engine.ledger.createThing({
      actor: agentBot,
      viewerRealmId: alpha.id,
      title: "Secret Rotation Anchor",
      externalRef: "tracker:SEC-999",
      sensitivity: "secret",
    });
    expect(
      engine.ledger.findThingByExternalRef({
        actor: agentBot,
        viewerRealmId: alpha.id,
        externalRef: "tracker:SEC-999",
      }),
    ).toBeNull();
    expect(
      engine.ledger
        .listThings({ actor: agentBot, viewerRealmId: alpha.id })
        .items.some((t) => t.id === secretThing.id),
    ).toBe(false);

    // Redact deletes entry_objects and resource_tags atomically inside the transaction
    const sensitiveTag = "cred:leak-token-8842";
    const taggedRec = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: alpha.id,
      kind: "finding",
      title: "Sensitive tag test",
      objectIds: [objBeta.id],
      resourceTags: [sensitiveTag],
    });
    expect(
      engine.objects
        .listResourceTags({ viewerRealmId: alpha.id })
        .some((t) => t.tag === sensitiveTag),
    ).toBe(true);
    expect(engine.db.listObjectIdsForEntry(taggedRec.id, org.id)).toEqual([
      objBeta.id,
    ]);

    engine.ledger.redact({
      actor: humanAlice,
      entryId: taggedRec.id,
      reason: "remove sensitive tag and link",
    });
    expect(engine.db.listObjectIdsForEntry(taggedRec.id, org.id)).toEqual([]);
    expect(engine.db.listResourceTagsForEntry(taggedRec.id, org.id)).toEqual(
      [],
    );
    expect(
      engine.objects
        .listResourceTags({ viewerRealmId: alpha.id })
        .some((t) => t.tag === sensitiveTag),
    ).toBe(false);
  });

  it("4. MCP new read tools enforce scopeCeiling & visibility.ts sanitization, and MCP write tools pass boundViewerRealmId (killing K14)", async () => {
    const homeDir = makeTempDir("meru-mind-mcp-2a-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    const { org, rootRealm } = engine.ledger.createOrg({
      name: "McpTreeOrg",
      policy: "tree",
    });
    const b1 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "b1",
      name: "B1",
    });
    const c1 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: b1.id,
      slug: "c1",
      name: "C1",
    });
    const b2 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "b2",
      name: "B2",
    });
    const c2 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: b2.id,
      slug: "c2",
      name: "C2",
    });

    // C2 mounts sibling C1 (scope: all), but parent B2 does NOT mount C1
    engine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: c2.id,
      targetRealmId: c1.id,
      scope: "all",
    });

    const objC1 = engine.objects.createObject({
      actor: agentBot,
      viewerRealmId: c1.id,
      kind: "service",
      name: "HiddenC1Svc",
    });
    const recC1 = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: c1.id,
      kind: "decision",
      title: "Hidden C1 secret-mount decision",
      objectIds: [objC1.id],
      resourceTags: ["svc:hidden-c1"],
    });
    const seaC2 = await engine.ledger.captureSeabed({
      actor: agentBot,
      viewerRealmId: c2.id,
      kind: "message",
      text: "C2 raw descendant seabed note",
      occurredAt: "2026-11-10T10:00:00.000Z",
      resourceTags: ["topic:c2-raw"],
    });
    const recC2 = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: c2.id,
      kind: "decision",
      title: "C2 visible decision citing C1",
      refs: [recC1.id],
      occurredAt: "2026-11-10T10:05:00.000Z",
      resourceTags: ["svc:c2-ledger"],
    });
    const secretB2 = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: b2.id,
      kind: "finding",
      title: "B2 SECRET CANARY",
      sensitivity: "secret",
      occurredAt: "2026-11-10T10:02:00.000Z",
      resourceTags: ["secret:b2-only"],
    });
    const normalB2Before = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: b2.id,
      kind: "claim",
      title: "B2 context before",
      occurredAt: "2026-11-10T10:01:00.000Z",
    });
    const normalB2Anchor = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: b2.id,
      kind: "claim",
      title: "B2 anchor claim",
      occurredAt: "2026-11-10T10:03:00.000Z",
    });
    await engine.close();

    // Start real MCP stdio server bound to parent B2
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpBin],
      env: {
        ...process.env,
        MERU_MIND_HOME: homeDir,
        MERU_MIND_ORG_ID: org.id,
        MERU_MIND_VIEWER_REALM_ID: b2.id,
        MERU_MIND_ACTOR_ID: "mcp-b2-bot",
        MERU_MIND_ACTOR_FAMILY: "claude",
      },
    });
    const client = new Client({ name: "slice2a-mcp-test", version: "0.2.0" });
    await client.connect(transport);

    const parseText = (res: Awaited<ReturnType<typeof client.callTool>>) => {
      const content = res.content as Array<{ type: string; text?: string }>;
      return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
    };

    try {
      const toolsRes = await client.listTools();
      const toolMap = new Map(toolsRes.tools.map((t) => [t.name, t]));
      for (const expected of [
        "mind_tree",
        "mind_ls",
        "mind_cat",
        "mind_replay",
        "mind_changes",
        "mind_list_objects",
        "mind_list_tags",
        "mind_list_things",
        "mind_write_conclusion",
        "mind_write_raw",
      ]) {
        expect(toolMap.has(expected)).toBe(true);
      }
      // Deprecated aliases clearly mention v0.3.0 removal
      expect(toolMap.get("mind_append_record")?.description).toContain(
        "v0.3.0",
      );
      expect(toolMap.get("mind_capture_seabed")?.description).toContain(
        "v0.3.0",
      );
      // Zero tools expose actorKind
      for (const tool of toolsRes.tools) {
        const props = (tool.inputSchema?.properties ?? {}) as Record<
          string,
          unknown
        >;
        expect(props).not.toHaveProperty("actorKind");
      }

      // Narrowing focus to child C2 MUST NOT expose C1's mounted items, C2's seabed (without flag), or secretB2
      const lsC2 = parseText(
        await client.callTool({
          name: "mind_ls",
          arguments: { focus: c2.id, target: c2.id },
        }),
      ) as { items: Array<{ id: string; refs: string[] }> };
      const c2Item = lsC2.items.find((i) => i.id === recC2.id);
      expect(c2Item).toBeDefined();
      // visibility.ts sanitizer MUST strip hidden C1 ref from C2's record!
      expect(c2Item!.refs).not.toContain(recC1.id);
      // C2 seabed is blocked by bound B2 ceiling without includeDescendantSeabed
      expect(lsC2.items.some((i) => i.id === seaC2.id)).toBe(false);

      // mind_cat on C1's record via narrowed focus C2 MUST fail with NOT_FOUND
      const catC1 = await client.callTool({
        name: "mind_cat",
        arguments: { focus: c2.id, target: recC1.id },
      });
      expect(catC1.isError).toBe(true);
      expect(parseText(catC1).error).toBe("NOT_FOUND");

      // mind_list_objects & mind_list_tags via narrowed focus C2 MUST exclude C1 and secretB2
      const objsC2 = parseText(
        await client.callTool({
          name: "mind_list_objects",
          arguments: { focus: c2.id },
        }),
      ) as unknown as Array<{ id: string }>;
      expect(objsC2.some((o) => o.id === objC1.id)).toBe(false);

      const tagsB2 = parseText(
        await client.callTool({
          name: "mind_list_tags",
          arguments: { focus: c2.id },
        }),
      ) as unknown as Array<{ tag: string }>;
      expect(tagsB2.some((t) => t.tag === "svc:hidden-c1")).toBe(false);
      expect(tagsB2.some((t) => t.tag === "secret:b2-only")).toBe(false);

      // mind_replay on B2 anchor includes normalB2Before, excludes secretB2
      const replayB2 = parseText(
        await client.callTool({
          name: "mind_replay",
          arguments: { entryId: normalB2Anchor.id, window: 5 },
        }),
      ) as { before: Array<{ id: string }>; anchor: { id: string } };
      expect(replayB2.anchor.id).toBe(normalB2Anchor.id);
      expect(replayB2.before.some((i) => i.id === normalB2Before.id)).toBe(
        true,
      );
      expect(replayB2.before.some((i) => i.id === secretB2.id)).toBe(false);

      // mind_changes excludes C1, C2 seabed (no dive), and secretB2
      const changesB2 = parseText(
        await client.callTool({
          name: "mind_changes",
          arguments: { focus: c2.id, sinceSeq: 0 },
        }),
      ) as { entries: Array<{ entityId: string }> };
      const changeIds = changesB2.entries.map((e) => e.entityId);
      expect(changeIds).not.toContain(recC1.id);
      expect(changeIds).not.toContain(seaC2.id);
      expect(changeIds).not.toContain(secretB2.id);

      // ---- K14 REGRESSION KILLER ----
      // Bound viewer is B2. Write tools NEVER accept focus/viewer overrides and always bind writes
      // to boundViewerRealmId (B2), accepting target as path OR ID!
      const k14Append = await client.callTool({
        name: "mind_append_record",
        arguments: {
          target: b2.id,
          kind: "decision",
          title: "K14 guard append_record",
        },
      });
      expect(k14Append.isError).toBeFalsy();
      expect(parseText(k14Append).realmId).toBe(b2.id);

      const k14WriteConc = await client.callTool({
        name: "mind_write_conclusion",
        arguments: {
          target: "/b2",
          kind: "claim",
          title: "K14 guard write_conclusion",
        },
      });
      expect(k14WriteConc.isError).toBeFalsy();

      const k14Capture = await client.callTool({
        name: "mind_capture_seabed",
        arguments: {
          target: b2.id,
          kind: "message",
          text: "K14 guard capture_seabed",
        },
      });
      expect(k14Capture.isError).toBeFalsy();

      const k14WriteRaw = await client.callTool({
        name: "mind_write_raw",
        arguments: {
          target: "/b2",
          kind: "signal",
          text: "K14 guard write_raw",
        },
      });
      expect(k14WriteRaw.isError).toBeFalsy();

      const k14Drive = await client.callTool({
        name: "mind_drive_write",
        arguments: {
          target: b2.id,
          relPath: "k14.md",
          content: "ok",
        },
      });
      expect(k14Drive.isError).toBeFalsy();

      const k14Settle = await client.callTool({
        name: "mind_settle",
        arguments: {
          target: "/b2",
          layer: "card_realm",
          periodKey: "2026-11-21",
        },
      });
      expect(k14Settle.isError).toBeFalsy();

      // AND trying to smuggle C2's private mount (recC1) via refs while writing to B2 MUST be rejected
      const smuggleRef = await client.callTool({
        name: "mind_append_record",
        arguments: {
          target: b2.id,
          kind: "decision",
          title: "Attempt to smuggle C1 ref into B2",
          refs: [recC1.id],
        },
      });
      expect(smuggleRef.isError).toBe(true);
      expect(parseText(smuggleRef).error).toBe("NOT_FOUND");
    } finally {
      await client.close();
    }
  });

  it("5. CLI defaults to compact Markdown for tree/ls/cat/brief/replay/changes and preserves stable JSON with --json", () => {
    const homeDir = makeTempDir("meru-mind-cli-md-");

    const init = runCliJson(homeDir, ["init", "--org", "DemoOrg"]) as {
      org: { id: string };
      rootRealm: { id: string };
    };
    const ops = runCliJson(homeDir, [
      "realm",
      "create",
      "--org",
      init.org.id,
      "--parent",
      init.rootRealm.id,
      "--slug",
      "ops",
      "--name",
      "Operations",
    ]) as { id: string; path: string };

    // Create object, thing, rule, conclusion, raw, and settle card via CLI (positional <targetRealm>, zero --realm)
    const obj = runCliJson(homeDir, [
      "object",
      "create",
      "/ops",
      "--kind",
      "service",
      "--name",
      "Gateway",
    ]) as { id: string };

    runCliJson(homeDir, [
      "--as-human",
      "write",
      "/ops",
      "--class",
      "rule",
      "--title",
      "Never skip healthchecks",
    ]);

    const thing = runCliJson(homeDir, [
      "thing",
      "create",
      "/ops",
      "--title",
      "Gateway Rollout",
      "--external-ref",
      "tracker:OPS-7",
      "--objects",
      obj.id,
      "--tags",
      "svc:gateway",
    ]) as { id: string };

    const dec1 = runCliJson(homeDir, [
      "write",
      "/ops",
      "--class",
      "conclusion",
      "--kind",
      "decision",
      "--title",
      "Enable canary rollout",
      "--occurred-at",
      "2026-11-15T09:00:00.000Z",
      "--objects",
      obj.id,
      "--tags",
      "svc:gateway",
    ]) as { id: string };

    runCliJson(homeDir, [
      "write",
      "/ops",
      "--class",
      "raw",
      "--kind",
      "message",
      "--text",
      "Canary traffic at 10 percent",
      "--occurred-at",
      "2026-11-15T08:55:00.000Z",
    ]);

    // Settle a narrative card, then write 1 more entry so changesSinceCard >= 1
    runCliJson(homeDir, [
      "settle",
      "/ops",
      "--layer",
      "card_realm",
      "--period",
      "2026-11-15",
      "--narrative",
      "Operations gateway rollout narrative",
    ]);

    const dec2 = runCliJson(homeDir, [
      "write",
      "/ops",
      "--class",
      "conclusion",
      "--kind",
      "decision",
      "--title",
      "Promote canary to 100 percent",
      "--supersedes",
      dec1.id,
      "--occurred-at",
      "2026-11-15T09:30:00.000Z",
    ]) as { id: string };

    // Default CLI output (NO --json) is compact Markdown
    const treeMd = runCliRaw(homeDir, ["tree"]);
    expect(treeMd).toContain("# Tree: DemoOrg");
    expect(treeMd).toContain("/ops");
    expect(treeMd).toContain("Gateway");

    const lsMd = runCliRaw(homeDir, ["ls", "/ops"]);
    expect(lsMd).toContain("# ls realm:");
    expect(lsMd).toContain("[rule]");
    expect(lsMd).toContain("[conclusion/decision]");
    expect(lsMd).toContain("[raw/message]");

    const catMd = runCliRaw(homeDir, ["cat", dec2.id]);
    expect(catMd).toContain("# [conclusion/decision] Promote canary to 100 percent");
    expect(catMd).toContain(dec1.id);

    const briefMd = runCliRaw(homeDir, ["brief", "/ops"]);
    expect(briefMd).toContain("# Brief: Operations");
    expect(briefMd).toContain("Buckets:");
    expect(briefMd).toContain("## Narrative Card (seq:");
    expect(briefMd).toContain("changes since card:");

    const briefJson = runCliJson(homeDir, ["brief", "/ops"]) as {
      buckets: { rules: number; conclusions: number; raw: number };
      middleMind: {
        realmCardMeta: { cardSeq: number; changesSinceCard: number };
      };
    };
    expect(briefJson.buckets.rules).toBe(1);
    expect(briefJson.buckets.conclusions).toBeGreaterThanOrEqual(2);
    expect(briefJson.buckets.raw).toBe(1);
    expect(briefJson.middleMind.realmCardMeta.cardSeq).toBeGreaterThan(0);
    expect(briefJson.middleMind.realmCardMeta.changesSinceCard).toBeGreaterThanOrEqual(
      1,
    );

    const replayMd = runCliRaw(homeDir, [
      "replay",
      dec2.id,
      "--window",
      "5",
    ]);
    expect(replayMd).toContain("# Replay:");
    expect(replayMd).toContain("## Supersede Chain (2)");

    const changesMd = runCliRaw(homeDir, [
      "changes",
      "/ops",
      "--since",
      "0",
    ]);
    expect(changesMd).toContain("# Changes (generation: 1");

    const tagsMd = runCliRaw(homeDir, ["tag", "list", "/ops"]);
    expect(tagsMd).toContain("svc:gateway");

    const thingsMd = runCliRaw(homeDir, ["thing", "list", "/ops"]);
    expect(thingsMd).toContain(thing.id);
    expect(thingsMd).toContain("tracker:OPS-7");
  });

  it("6. B2 & N3 regressions: changes() pagination never skips visible changes past >2*limit invisible rows, and tree-mode recall never grants entry_objects focus boost", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-b2-n3-"),
      enableVector: false,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "TreeCursorAndFocusOrg",
      policy: "tree",
    });
    const realmB = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "b",
      name: "B",
    });
    const realmC = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: realmB.id,
      slug: "c",
      name: "C",
    });

    // ---- B2: 6 invisible descendant seabed entries in C (> 2 * limit=2), followed by 1 visible record in B ----
    const startSeq = engine.db.getLatestChangeLogSeq(org.id);
    const invisibleSeabedIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const s = await engine.ledger.captureSeabed({
        actor: agentBot,
        viewerRealmId: realmC.id,
        kind: "message",
        text: `Descendant raw note #${i}`,
      });
      invisibleSeabedIds.push(s.id);
    }
    const visibleAfterGap = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: realmB.id,
      kind: "decision",
      title: "Visible B decision after 6 invisible C seabed rows",
    });

    // Paginate from B with limit=2 (raw scan batch = 4 < 6 invisible rows!)
    const collectedEntityIds: string[] = [];
    let cursor = startSeq;
    let pages = 0;
    while (pages < 10) {
      pages += 1;
      const page = engine.sea.changes({
        actor: agentBot,
        viewerRealmId: realmB.id,
        sinceSeq: cursor,
        limit: 2,
      });
      for (const e of page.entries) {
        collectedEntityIds.push(e.entityId);
      }
      if (page.latestSeq === cursor) {
        break;
      }
      expect(page.latestSeq).toBeGreaterThan(cursor);
      cursor = page.latestSeq;
    }

    expect(collectedEntityIds).toContain(visibleAfterGap.id);
    for (const hid of invisibleSeabedIds) {
      expect(collectedEntityIds).not.toContain(hid);
    }

    // Also verify empty tail returns sinceSeq unchanged (never leaks hidden sibling seq growth)
    const hiddenSibling = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "hidden-sib",
      name: "Hidden Sibling",
    });
    await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: hiddenSibling.id,
      kind: "claim",
      title: "Hidden sibling activity",
    });
    const tailPage = engine.sea.changes({
      actor: agentBot,
      viewerRealmId: realmB.id,
      sinceSeq: cursor,
      limit: 2,
    });
    expect(tailPage.entries).toHaveLength(0);
    expect(tailPage.latestSeq).toBe(cursor);

    // ---- N3: In tree mode, linking a record to an object in viewer realm MUST NOT add focus/self boost ----
    const objInB = engine.objects.createObject({
      actor: agentBot,
      viewerRealmId: realmB.id,
      kind: "service",
      name: "CoreSvc",
    });
    const childUnlinked = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: realmC.id,
      kind: "decision",
      title: "Quartz telemetry sampling rule",
      payload: { detail: "Keep quartz telemetry sampling deterministic" },
      occurredAt: "2026-11-18T10:00:00.000Z",
    });
    const childLinkedToB = await engine.ledger.appendRecord({
      actor: agentBot,
      viewerRealmId: realmC.id,
      kind: "decision",
      title: "Quartz telemetry sampling rule",
      payload: { detail: "Keep quartz telemetry sampling deterministic" },
      objectIds: [objInB.id],
      occurredAt: "2026-11-18T09:00:00.000Z",
    });

    const treeRecall = await engine.sea.recall({
      actor: agentBot,
      viewerRealmId: realmB.id,
      query: "Quartz telemetry sampling",
      focusBoost: true,
    });
    const unlinkedHit = treeRecall.items.find((i) => i.id === childUnlinked.id);
    const linkedHit = treeRecall.items.find((i) => i.id === childLinkedToB.id);
    expect(unlinkedHit).toBeDefined();
    expect(linkedHit).toBeDefined();
    // Both records are in realmC (same tier, status, relevance band); tree mode MUST NOT amplify
    // via entry_objects into realmB, so newer childUnlinked ranks strictly before older childLinkedToB.
    expect(treeRecall.items[0]!.id).toBe(childUnlinked.id);
    expect(linkedHit!.score).toBe(unlinkedHit!.score);
  });
});
