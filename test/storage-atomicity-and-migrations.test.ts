import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import {
  computePayloadHash,
  createMindEngine,
  SqliteDb,
  type Actor,
  type EmbedderPort,
  type MindEngine,
} from "../src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const distIndexUrl = new URL("../dist/index.js", import.meta.url).href;
const cliBin = path.join(repoRoot, "dist", "cli.js");

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
const agentWorker: Actor = { id: "worker-1", kind: "agent", family: "gemini" };

/**
 * Constructs an authentic V0.1 SQLite database on disk (no schema_migrations, no meta,
 * no orgs.policy, no org_id/occurred_at/confirmed_by_human/ext_kind, old 5-column vec_pending).
 */
function createV01FixtureDb(dbPath: string, vectorDim = 4): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath, { allowExtension: true });
  try {
    sqliteVec.load(raw);
    raw.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE orgs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_personal_root INTEGER NOT NULL DEFAULT 0,
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
        created_at TEXT NOT NULL
      );

      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        realm_id TEXT NOT NULL REFERENCES realms(id),
        thing_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        supersedes_id TEXT REFERENCES records(id),
        superseded_by_id TEXT REFERENCES records(id),
        author_id TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_family TEXT,
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        refs_json TEXT NOT NULL,
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
        realm_id TEXT NOT NULL,
        status TEXT NOT NULL,
        text TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE vec_items USING vec0(
        item_id TEXT PRIMARY KEY,
        realm_id TEXT PARTITION KEY,
        status TEXT,
        source_type TEXT,
        embedding FLOAT[${vectorDim}]
      );
    `);

    const t0 = "2026-10-01T08:00:00.000Z";
    const t1 = "2026-10-01T09:00:00.000Z";
    const t2 = "2026-10-01T10:00:00.000Z";

    raw
      .prepare(
        `INSERT INTO orgs (id, name, is_personal_root, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run("org_v01", "LegacyOrg", 0, t0);

    raw
      .prepare(
        `INSERT INTO realms (id, org_id, parent_id, slug, path, name, archived_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run("realm_v01_root", "org_v01", null, "root", "/", "Legacy Root", t0);

    raw
      .prepare(
        `INSERT INTO realms (id, org_id, parent_id, slug, path, name, archived_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        "realm_v01_eng",
        "org_v01",
        "realm_v01_root",
        "eng",
        "/eng",
        "Engineering",
        t0,
      );

    // 1. Human record that ALREADY has a vector in vec_items
    raw
      .prepare(
        `INSERT INTO records (id, realm_id, thing_id, kind, status, supersedes_id, superseded_by_id, author_id, author_kind, author_family, title, payload_json, refs_json, created_at)
         VALUES (?, ?, NULL, ?, 'active', NULL, NULL, ?, 'human', NULL, ?, ?, '[]', ?)`,
      )
      .run(
        "rec_v01_embedded",
        "realm_v01_root",
        "decision",
        "alice",
        "Already embedded legacy decision",
        JSON.stringify({ note: "embedded" }),
        t1,
      );

    const vec = new Float32Array([1, 0, 0, 0]);
    raw
      .prepare(
        `INSERT INTO vec_items (item_id, realm_id, status, source_type, embedding)
         VALUES (?, ?, 'active', 'record', ?)`,
      )
      .run(
        "rec_v01_embedded",
        "realm_v01_root",
        new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength),
      );

    // 2. Agent record WITHOUT vector in vec_items (was queued in old V0.1 vec_pending)
    raw
      .prepare(
        `INSERT INTO records (id, realm_id, thing_id, kind, status, supersedes_id, superseded_by_id, author_id, author_kind, author_family, title, payload_json, refs_json, created_at)
         VALUES (?, ?, NULL, ?, 'active', NULL, NULL, ?, 'agent', 'gemini', ?, ?, '[]', ?)`,
      )
      .run(
        "rec_v01_pending",
        "realm_v01_eng",
        "finding",
        "bot-1",
        "Pending legacy finding",
        JSON.stringify({ detail: "needs embedding" }),
        t2,
      );

    raw
      .prepare(
        `INSERT INTO vec_pending (item_id, source_type, realm_id, status, text)
         VALUES (?, 'record', ?, 'active', ?)`,
      )
      .run("rec_v01_pending", "realm_v01_eng", "Pending legacy finding");

    // 3. Seabed entry WITHOUT vector in vec_items
    raw
      .prepare(
        `INSERT INTO seabed_entries (id, realm_id, topic_id, kind, author_id, author_kind, author_family, text, blob_sha256, source_ref, metadata_json, created_at)
         VALUES (?, ?, 't1', 'message', 'alice', 'human', NULL, ?, NULL, NULL, '{}', ?)`,
      )
      .run("sea_v01_pending", "realm_v01_eng", "Legacy seabed note", t2);

    // 4. Distillation WITHOUT vector in vec_items
    raw
      .prepare(
        `INSERT INTO distillations (id, realm_id, layer, period_key, status, hard_facts_json, narrative_md, source_ids_json, created_at)
         VALUES (?, ?, 'card_realm', '2026-10-01', 'active', '{}', ?, '["rec_v01_pending"]', ?)`,
      )
      .run("dist_v01_pending", "realm_v01_eng", "Legacy realm card narrative", t2);
  } finally {
    raw.close();
  }
}

describe("Storage migrations, org policy backfill, atomic CAS, idempotency, change_log & async embeddings", () => {
  it("C1-1 & C2: migrates real V0.1 fixture cleanly with zero data loss, tree backfill, secure_delete=ON, and re-enqueued vec_pending", async () => {
    const homeDir = makeTempDir("meru-mind-v01-mig-");
    const dbPath = path.join(homeDir, "mind.sqlite");
    createV01FixtureDb(dbPath, 4);

    const engine = await createMindEngine({ homeDir, vectorDimensions: 4 });
    engines.push(engine);

    // Connection-level PRAGMA secure_delete = ON is active on SqliteDb
    const internalDb = (engine.db as unknown as { db: DatabaseSync }).db;
    const sdRow = internalDb.prepare("PRAGMA secure_delete").get() as {
      secure_delete: number;
    };
    expect(Number(sdRow.secure_delete)).toBe(1);

    // Schema migrations recorded [1..11] and meta.change_log_generation = '1'
    const migrations = engine.db.listSchemaMigrations();
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(engine.db.getMeta("change_log_generation")).toBe("1");

    // Existing V0.1 org MUST be backfilled to 'tree' (never silently opened) — check BOTH raw SQL column & mapOrg
    const rawOrgPolicy = internalDb
      .prepare("SELECT policy FROM orgs WHERE id = ?")
      .get("org_v01") as { policy: string | null } | undefined;
    expect(rawOrgPolicy?.policy).toBe("tree");
    const legacyOrg = engine.db.getOrg("org_v01");
    expect(legacyOrg?.policy).toBe("tree");

    // Newly created org defaults to 'open' and supports explicit 'tree'
    const { org: defaultNewOrg } = engine.ledger.createOrg({ name: "OpenOrg" });
    expect(defaultNewOrg.policy).toBe("open");
    const { org: explicitTreeOrg } = engine.ledger.createOrg({
      name: "TreeOrg",
      policy: "tree",
    });
    expect(explicitTreeOrg.policy).toBe("tree");

    // setOrgPolicy: rejects non-human, allows human and logs org_policy_change
    expect(() =>
      engine.ledger.setOrgPolicy({
        orgId: legacyOrg!.id,
        policy: "open",
        actor: agentWorker,
      }),
    ).toThrow(/Only human actors/);

    const updatedOrg = engine.ledger.setOrgPolicy({
      orgId: legacyOrg!.id,
      policy: "open",
      actor: humanAlice,
    });
    expect(updatedOrg.policy).toBe("open");
    expect(engine.db.getOrg(legacyOrg!.id)?.policy).toBe("open");
    const policyChanges = engine.sea.listChangeLog({ orgId: legacyOrg!.id });
    expect(
      policyChanges.entries.some(
        (e) => e.op === "org_policy_change" && e.entityId === legacyOrg!.id,
      ),
    ).toBe(true);

    // Verify all V0.1 rows read back with backfilled org_id, occurred_at, confirmed_by_human
    const recEmbedded = engine.db.getRecord("rec_v01_embedded");
    expect(recEmbedded).not.toBeNull();
    expect(recEmbedded!.orgId).toBe("org_v01");
    expect(recEmbedded!.occurredAt).toBe(recEmbedded!.createdAt);
    expect(recEmbedded!.confirmedByHuman).toBe(true);
    expect(recEmbedded!.sensitivity).toBe("internal");

    const recPending = engine.db.getRecord("rec_v01_pending");
    expect(recPending).not.toBeNull();
    expect(recPending!.orgId).toBe("org_v01");
    expect(recPending!.occurredAt).toBe(recPending!.createdAt);
    expect(recPending!.confirmedByHuman).toBe(false);

    const seaPending = engine.db.getSeabedEntry("sea_v01_pending");
    expect(seaPending).not.toBeNull();
    expect(seaPending!.orgId).toBe("org_v01");
    expect(seaPending!.occurredAt).toBe(seaPending!.createdAt);
    expect(seaPending!.sensitivity).toBe("internal");

    // Verify new tables exist (redacted_blocklist, idempotency_keys, change_log, vec_pending 7 cols)
    const pendingCols = (
      internalDb.prepare("PRAGMA table_info(vec_pending)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(pendingCols).toEqual([
      "item_id",
      "source_type",
      "org_id",
      "realm_id",
      "status",
      "text",
      "queued_at",
    ]);
    const blocklistCols = (
      internalDb
        .prepare("PRAGMA table_info(redacted_blocklist)")
        .all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(blocklistCols).toEqual([
      "org_id",
      "source_ref",
      "content_sha256",
      "reason",
      "redacted_at",
    ]);

    // C2 check: missing vectors were re-enqueued into rebuilt vec_pending, already-embedded item was NOT
    const pendingItems = engine.db.listPendingVectors(100);
    const pendingIds = pendingItems.map((p) => p.itemId).sort();
    expect(pendingIds).toEqual([
      "dist_v01_pending",
      "rec_v01_pending",
      "sea_v01_pending",
    ]);
    expect(pendingIds).not.toContain("rec_v01_embedded");
    for (const p of pendingItems) {
      expect(p.orgId).toBe("org_v01");
      expect(p.queuedAt).toBeTruthy();
    }
  });

  it("C1-2: barrier-synchronized 4-process concurrent open across 12 rounds migrates V0.1 cleanly with zero race errors", async () => {
    const rounds = 12;
    const workerCount = 4;

    // Warm worker script: imports dist/index.js once, emits READY, then for each line
    // `{ dbPath, goAt }` busy-waits until `Date.now() >= goAt` so all 4 OS processes
    // hit SqliteDb constructor + migration within the same millisecond.
    const workerCode = `
      import readline from "node:readline";
      import { SqliteDb } from ${JSON.stringify(distIndexUrl)};

      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      process.stdout.write("READY\\n");

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const { dbPath, goAt } = JSON.parse(trimmed);
        while (Date.now() < goAt) {
          // intentional tight barrier busy-wait to maximize concurrent lock collision
        }
        let db;
        try {
          db = new SqliteDb({ dbPath, vectorDimensions: 4 });
          const org = db.getOrg("org_v01");
          const migrations = db.listSchemaMigrations().map((m) => m.version);
          const rec = db.getRecord("rec_v01_pending");
          if (org?.policy !== "tree") {
            throw new Error("expected tree policy, got " + String(org?.policy));
          }
          if (migrations.join(",") !== "1,2,3,4,5,6,7,8,9,10,11,12,13") {
            throw new Error("bad migrations: " + migrations.join(","));
          }
          if (!rec || rec.orgId !== "org_v01") {
            throw new Error("bad backfilled record");
          }
          process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\\n");
        } finally {
          try {
            db?.close();
          } catch {}
        }
      }
    `;

    interface WarmWorker {
      ready: Promise<void>;
      runRound: (
        dbPath: string,
        goAt: number,
      ) => Promise<{ ok: boolean; error?: string }>;
      kill: () => void;
    }

    const spawnWarmWorker = (): WarmWorker => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", workerCode],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let buf = "";
      let readyResolve!: () => void;
      const ready = new Promise<void>((res) => {
        readyResolve = res;
      });
      let isReady = false;
      let pendingResolve:
        | ((val: { ok: boolean; error?: string }) => void)
        | null = null;
      let stderrAcc = "";

      child.stderr.on("data", (d) => {
        stderrAcc += String(d);
      });

      child.stdout.on("data", (d) => {
        buf += String(d);
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!isReady && line === "READY") {
            isReady = true;
            readyResolve();
          } else if (pendingResolve && line) {
            const resolve = pendingResolve;
            pendingResolve = null;
            resolve(JSON.parse(line) as { ok: boolean; error?: string });
          }
          nl = buf.indexOf("\n");
        }
      });

      child.on("exit", (code) => {
        if (pendingResolve) {
          const resolve = pendingResolve;
          pendingResolve = null;
          resolve({
            ok: false,
            error: `worker exited unexpectedly (code=${String(code)}): ${stderrAcc}`,
          });
        }
      });

      return {
        ready,
        runRound(dbPath: string, goAt: number) {
          return new Promise((resolve) => {
            pendingResolve = resolve;
            child.stdin.write(`${JSON.stringify({ dbPath, goAt })}\n`);
          });
        },
        kill() {
          try {
            child.stdin.end();
            child.kill();
          } catch {
            // ignore
          }
        },
      };
    };

    const workers = Array.from({ length: workerCount }, () =>
      spawnWarmWorker(),
    );
    try {
      await Promise.all(workers.map((w) => w.ready));

      for (let round = 0; round < rounds; round += 1) {
        const roundDir = makeTempDir(`meru-mind-mig-race-r${round}-`);
        const dbPath = path.join(roundDir, "mind.sqlite");
        createV01FixtureDb(dbPath, 4);

        const goAt = Date.now() + 25;
        const results = await Promise.all(
          workers.map((w) => w.runRound(dbPath, goAt)),
        );

        for (const res of results) {
          expect(res.error ?? "").not.toMatch(/duplicate column/i);
          expect(res).toEqual({ ok: true });
        }
      }
    } finally {
      for (const w of workers) {
        w.kill();
      }
    }
  }, 20_000);

  it("F3-CAS: DbPort markRecordSuperseded enforces atomic CAS directly (1st returns true, 2nd returns false)", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-db-cas-"),
    });
    engines.push(engine);

    const { rootRealm } = engine.ledger.createOrg({ name: "CasUnitOrg" });
    const r1 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Original active head",
    });
    const r2 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Contender A",
    });
    const r3 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Contender B",
    });

    // Directly invoke DB-level CAS twice on the same row
    const first = engine.db.markRecordSuperseded(r1.id, r2.id);
    const second = engine.db.markRecordSuperseded(r1.id, r3.id);

    expect(first).toBe(true);
    expect(second).toBe(false);

    const persisted = engine.db.getRecord(r1.id)!;
    expect(persisted.status).toBe("superseded");
    expect(persisted.supersededById).toBe(r2.id);
  });

  it("C1-3: concurrent multi-process supersede CAS on same active chain head has strictly 1 winner and zero forks", async () => {
    const homeDir = makeTempDir("meru-mind-cas-race-");
    const runCli = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(
            process.execPath,
            [cliBin, "--home", homeDir, "--json", ...args],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => (stdout += String(d)));
          child.stderr.on("data", (d) => (stderr += String(d)));
          child.on("close", (code) =>
            resolve({ code: code ?? 1, stdout, stderr }),
          );
        },
      );

    const init = await runCli(["admin", "init", "--org", "CasOrg"]);
    expect(init.code).toBe(0);
    const rootId = (JSON.parse(init.stdout) as { rootRealm: { id: string } })
      .rootRealm.id;

    const base = await runCli([
      "write",
      "--in",
      "/",
      "--kind",
      "decision",
      "--title",
      "Base chain head v1",
      "--body",
      "Initial decision body",
    ]);
    expect(base.code).toBe(0);
    const baseId = (JSON.parse(base.stdout) as { id: string }).id;

    // Fire 6 concurrent OS processes trying to supersede baseId simultaneously
    const racers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        runCli([
          "write",
          "--in",
          "/",
          "--kind",
          "decision",
          "--title",
          `Supersede contender ${i}`,
          "--body",
          `Contender body ${i}`,
          "--supersedes",
          baseId,
        ]),
      ),
    );

    const winners = racers.filter((r) => r.code === 0);
    const conflicts = racers.filter(
      (r) => r.code !== 0 && r.stderr.includes('"conflict"'),
    );

    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(5);

    // Inspect DB: strictly 2 records (base + 1 winner), no fork, no dirty loser rows
    const winnerRecord = JSON.parse(winners[0]!.stdout) as { id: string };
    const db = new SqliteDb({ dbPath: path.join(homeDir, "mind.sqlite") });
    try {
      const allRecords = db.listAllRecords();
      expect(allRecords).toHaveLength(2);
      const oldRec = db.getRecord(baseId)!;
      expect(oldRec.status).toBe("superseded");
      expect(oldRec.supersededById).toBe(winnerRecord.id);
      const winRec = db.getRecord(winnerRecord.id)!;
      expect(winRec.status).toBe("active");
      expect(winRec.supersedesId).toBe(baseId);
      // change_log should contain exactly 2 entries (base create + 1 winning supersede)
      const log = db.listChangeLog();
      expect(log.entries).toHaveLength(2);
      expect(log.entries.map((e) => e.seq)).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });

  it("C1-4: enforces all 4 idempotency key scenarios (canonical JSON order, mismatch, cross-table, opaque NOT_FOUND on hidden realm)", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-idem-"),
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "IdemOrg",
      policy: "tree",
    });
    const sibA = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "sib-a",
      name: "Sib A",
    });
    const sibB = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "sib-b",
      name: "Sib B",
    });

    // Verify canonical JSON hash helper ignores key ordering recursively
    expect(
      computePayloadHash({ b: 2, a: 1, nested: { z: "last", a: "first" } }),
    ).toBe(
      computePayloadHash({ nested: { a: "first", z: "last" }, a: 1, b: 2 }),
    );

    const logCountBeforeRec1 = engine.sea.listChangeLog().entries.length;
    // 1. Same key + same content with DIFFERENT JSON key order returns original record (no duplicate)
    const rec1 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "decision",
      title: "Canonical idempotency test",
      payload: { b: 2, a: 1, nested: { y: true, x: false } },
      idempotencyKey: "idem-rec-1",
    });
    const rec1Retry = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "decision",
      title: "Canonical idempotency test",
      payload: { nested: { x: false, y: true }, a: 1, b: 2 },
      idempotencyKey: "idem-rec-1",
    });
    expect(rec1Retry.id).toBe(rec1.id);
    expect(engine.db.listAllRecords()).toHaveLength(1);
    expect(engine.sea.listChangeLog().entries).toHaveLength(
      logCountBeforeRec1 + 1,
    );

    // Retrying a supersede call with same idempotencyKey returns the winner (never spurious CONFLICT)
    const rec2 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "decision",
      title: "Updated decision v2",
      supersedesId: rec1.id,
      idempotencyKey: "idem-sup-2",
    });
    const rec2Retry = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "decision",
      title: "Updated decision v2",
      supersedesId: rec1.id,
      idempotencyKey: "idem-sup-2",
    });
    expect(rec2Retry.id).toBe(rec2.id);

    // 2. Same key + different payload throws IDEMPOTENCY_MISMATCH
    await expect(
      engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: sibA.id,
        kind: "decision",
        title: "Different title for same key",
        payload: { a: 1, b: 2 },
        idempotencyKey: "idem-rec-1",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });

    // 3. Cross-table conflict: captureSeabed reusing record's key throws IDEMPOTENCY_MISMATCH
    await expect(
      engine.ledger.captureSeabed({
        actor: humanAlice,
        viewerRealmId: sibA.id,
        kind: "message",
        text: "Reusing record key on seabed",
        idempotencyKey: "idem-rec-1",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });

    // And vice versa: seabed key reused by appendRecord throws IDEMPOTENCY_MISMATCH
    const sea1 = await engine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "message",
      text: "Idempotent seabed message",
      metadata: { k2: "b", k1: "a" },
      idempotencyKey: "idem-sea-1",
    });
    const sea1Retry = await engine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "message",
      text: "Idempotent seabed message",
      metadata: { k1: "a", k2: "b" },
      idempotencyKey: "idem-sea-1",
    });
    expect(sea1Retry.id).toBe(sea1.id);

    await expect(
      engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: sibA.id,
        kind: "finding",
        title: "Reusing seabed key on records",
        idempotencyKey: "idem-sea-1",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });

    // 4. Hidden sibling hitting existing key returns opaque NOT_FOUND (zero blind oracle)
    await expect(
      engine.ledger.appendRecord({
        actor: agentWorker,
        viewerRealmId: sibB.id,
        targetRealmId: sibA.id,
        kind: "decision",
        title: "Canonical idempotency test",
        payload: { a: 1, b: 2, nested: { x: false, y: true } },
        idempotencyKey: "idem-rec-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      engine.ledger.appendRecord({
        actor: agentWorker,
        viewerRealmId: sibB.id,
        kind: "decision",
        title: "Different title probing sibA key",
        idempotencyKey: "idem-rec-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("C1-5: keeps change_log.seq gap-free across rollbacks and preserves change_log + generation across rebuild()", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-changelog-"),
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({ name: "LogOrg" });

    const r1 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "First decision",
    });
    await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "Second entry",
    });

    // Trigger failed writes that roll back (invalid ref, non-human rule, explicit rollback after appendChangeLog)
    await expect(
      engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "finding",
        title: "Bad ref",
        refs: ["rec_missing_id"],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      engine.ledger.appendRecord({
        actor: agentWorker,
        viewerRealmId: rootRealm.id,
        kind: "rule",
        title: "Forbidden rule",
      }),
    ).rejects.toMatchObject({ code: "RULE_REQUIRES_HUMAN" });

    // Simulate mid-transaction failure AFTER appending to change_log -> sqlite_sequence rolls back cleanly
    expect(() =>
      engine.db.transaction(() => {
        engine.db.appendChangeLog({
          orgId: org.id,
          realmId: rootRealm.id,
          entityType: "record",
          entityId: "rec_rolled_back",
          op: "create",
          actorId: humanAlice.id,
          createdAt: new Date().toISOString(),
        });
        throw new Error("Simulated mid-tx abort");
      }),
    ).toThrow("Simulated mid-tx abort");

    // Subsequent valid write gets next contiguous seq (3) with zero gaps
    await engine.sea.settle({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      layer: "card_realm",
      periodKey: "2026-11-21",
      sourceIds: [r1.id],
    });

    const beforeRebuild = engine.sea.listChangeLog({ orgId: org.id });
    expect(beforeRebuild.generation).toBe(1);
    expect(beforeRebuild.entries.map((e) => e.seq)).toEqual([1, 2, 3]);

    // rebuild() MUST NOT clear change_log or bump generation
    await engine.sea.rebuild();
    const afterRebuild = engine.sea.listChangeLog({ orgId: org.id });
    expect(afterRebuild.generation).toBe(1);
    expect(afterRebuild.entries.map((e) => e.seq)).toEqual([1, 2, 3]);

    // Explicit resetChangeLog() clears entries and increments generation
    const resetRes = engine.sea.resetChangeLog();
    expect(resetRes.generation).toBe(2);
    expect(resetRes.clearedCount).toBe(3);

    await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "finding",
      title: "Post-reset entry",
    });
    const afterReset = engine.sea.listChangeLog({ orgId: org.id });
    expect(afterReset.generation).toBe(2);
    expect(afterReset.entries).toHaveLength(1);
    expect(afterReset.entries[0]!.generation).toBe(2);
    expect(afterReset.entries[0]!.seq).toBeGreaterThan(3);
  });

  it("C1-6: never calls embed() on write paths (appendRecord/captureSeabed/settle) and syncEmbeddings() rechecks live state safely", async () => {
    // Part A: Never-resolving embedder proves write paths return immediately without touching embedder
    let neverEmbedCalls = 0;
    const neverResolvingEmbedder: EmbedderPort = {
      dimensions: 4,
      configured: true,
      embed(_text: string) {
        neverEmbedCalls += 1;
        return new Promise<Float32Array | null>(() => {
          // intentionally never resolves
        });
      },
      embedBatch(_texts: string[]) {
        neverEmbedCalls += 1;
        return new Promise<Array<Float32Array | null>>(() => {
          // intentionally never resolves
        });
      },
    };

    const homeA = makeTempDir("meru-mind-noblock-");
    const engineA = await createMindEngine({
      homeDir: homeA,
      embedder: neverResolvingEmbedder,
      vectorDimensions: 4,
    });
    engines.push(engineA);

    const { rootRealm: rootA } = engineA.ledger.createOrg({ name: "FastOrg" });

    const rNormal = await engineA.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootA.id,
      kind: "decision",
      title: "Normal fast write",
    });
    const rSecret = await engineA.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootA.id,
      kind: "decision",
      title: "TOP_SECRET_SKIP_INDEX",
      sensitivity: "secret",
    });
    const sNormal = await engineA.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootA.id,
      kind: "message",
      text: "Normal seabed message",
    });
    const sSecret = await engineA.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootA.id,
      kind: "message",
      text: "SECRET_SEABED_SKIP_INDEX",
      sensitivity: "secret",
    });
    const dNormal = await engineA.sea.settle({
      actor: humanAlice,
      viewerRealmId: rootA.id,
      layer: "card_realm",
      periodKey: "2026-11-21",
      narrativeMd: "Fast settled distillation",
      sourceIds: [rNormal.id],
    });

    expect(neverEmbedCalls).toBe(0);

    // Secret entries MUST skip FTS5 and vec_pending; normal entries MUST be queued
    const pendingA = engineA.db.listPendingVectors(100).map((p) => p.itemId).sort();
    expect(pendingA).toEqual([dNormal.id, rNormal.id, sNormal.id].sort());
    expect(pendingA).not.toContain(rSecret.id);
    expect(pendingA).not.toContain(sSecret.id);

    const secretFts = engineA.db.searchFts({
      query: "TOP_SECRET_SKIP_INDEX",
      realmIds: [rootA.id],
      includeSuperseded: true,
      limit: 10,
    });
    expect(secretFts).toHaveLength(0);

    // Part B: syncEmbeddings() batches via embedBatch() and rechecks live status / deletion / redaction inside tx
    let batchCalls = 0;
    let resolveBatch!: (vecs: Array<Float32Array | null>) => void;
    let notifyBatchStarted!: () => void;
    const batchStarted = new Promise<void>((res) => {
      notifyBatchStarted = res;
    });

    const deferredBatchEmbedder: EmbedderPort = {
      dimensions: 4,
      configured: true,
      async embed(_text: string) {
        throw new Error("syncEmbeddings should use embedBatch when available");
      },
      embedBatch(texts: string[]) {
        batchCalls += 1;
        notifyBatchStarted();
        return new Promise<Array<Float32Array | null>>((resolve) => {
          resolveBatch = resolve;
        });
      },
    };

    const homeB = makeTempDir("meru-mind-syncvec-");
    const engineB = await createMindEngine({
      homeDir: homeB,
      embedder: deferredBatchEmbedder,
      vectorDimensions: 4,
    });
    engines.push(engineB);

    const { rootRealm: rootB } = engineB.ledger.createOrg({ name: "SyncOrg" });
    const recToSupersede = await engineB.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootB.id,
      kind: "decision",
      title: "Will be superseded mid-flight",
    });
    const recToRedact = await engineB.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootB.id,
      kind: "decision",
      title: "Will be redacted mid-flight",
    });
    const recToUnqueue = await engineB.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootB.id,
      kind: "decision",
      title: "Will lose vec_pending mid-flight",
    });
    const seaLive = await engineB.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootB.id,
      kind: "message",
      text: "Remains live during sync",
    });

    // Start single-batch sync (4 queued items)
    const syncPromise = engineB.sea.syncEmbeddings({ batchSize: 10, maxItems: 4 });
    await batchStarted;
    expect(batchCalls).toBe(1);

    // Mutate state while embedBatch() is in-flight!
    // 1) Supersede recToSupersede -> live status becomes 'superseded'
    const recSuperseder = await engineB.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootB.id,
      kind: "decision",
      title: "New active head",
      supersedesId: recToSupersede.id,
    });
    // 2) Simulate concurrent redaction of recToRedact
    const rawDbB = (engineB.db as unknown as { db: DatabaseSync }).db;
    rawDbB
      .prepare(
        `UPDATE records SET redacted_at = ?, status = 'retracted', title = '[REDACTED]' WHERE id = ?`,
      )
      .run(new Date().toISOString(), recToRedact.id);
    // 3) Delete vec_pending row for recToUnqueue before writeback
    engineB.db.deletePendingVector(recToUnqueue.id);

    // Now resolve the in-flight batch
    resolveBatch([
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([0, 1, 0, 0]),
      new Float32Array([0, 0, 1, 0]),
      new Float32Array([0, 0, 0, 1]),
    ]);

    const syncRes = await syncPromise;
    expect(syncRes.processed).toBe(4);
    expect(syncRes.indexed).toBe(2); // recToSupersede (with live 'superseded' status) + seaLive
    expect(syncRes.skipped).toBe(2); // recToRedact + recToUnqueue
    expect(syncRes.failed).toBe(0);
    expect(syncRes.remaining).toBe(1); // recSuperseder still queued for next batch

    // Verify vec_items contents:
    // - recToRedact and recToUnqueue MUST NOT be in vec_items
    // - recToSupersede MUST have live status 'superseded' (not stale 'active')
    // - seaLive MUST be present with status 'evidence'
    const activeVecHits = engineB.db.searchVectors({
      embedding: new Float32Array([1, 0, 0, 0]),
      realmIds: [rootB.id],
      includeSuperseded: false,
      limit: 10,
    });
    expect(activeVecHits.some((h) => h.itemId === recToSupersede.id)).toBe(false);
    expect(activeVecHits.some((h) => h.itemId === recToRedact.id)).toBe(false);
    expect(activeVecHits.some((h) => h.itemId === recToUnqueue.id)).toBe(false);

    const allVecHits = engineB.db.searchVectors({
      embedding: new Float32Array([1, 0, 0, 0]),
      realmIds: [rootB.id],
      includeSuperseded: true,
      limit: 10,
    });
    const supersededVec = allVecHits.find(
      (h) => h.itemId === recToSupersede.id,
    );
    expect(supersededVec?.status).toBe("superseded");
    expect(allVecHits.some((h) => h.itemId === recToRedact.id)).toBe(false);
    expect(allVecHits.some((h) => h.itemId === recToUnqueue.id)).toBe(false);
    expect(allVecHits.some((h) => h.itemId === seaLive.id)).toBe(true);

    // recToRedact's vec_pending entry was also cleaned up; only recSuperseder remains
    expect(engineB.db.listPendingVectors(10).map((p) => p.itemId)).toEqual([
      recSuperseder.id,
    ]);
  });

  it("F2 & P2: syncEmbeddings() rejects mid-flight seabed redacted_at, record redacted_at-only, and stale queuedAt re-queues", async () => {
    let resolveBatch!: (vecs: Array<Float32Array | null>) => void;
    let notifyBatchStarted!: () => void;
    const resetDeferred = () =>
      new Promise<void>((res) => {
        notifyBatchStarted = res;
      });
    let batchStarted = resetDeferred();
    const seenBatches: string[][] = [];

    const controlledEmbedder: EmbedderPort = {
      dimensions: 4,
      configured: true,
      async embed(_text: string) {
        throw new Error("should use embedBatch");
      },
      embedBatch(texts: string[]) {
        seenBatches.push([...texts]);
        notifyBatchStarted();
        return new Promise<Array<Float32Array | null>>((resolve) => {
          resolveBatch = resolve;
        });
      },
    };

    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-sync-f2-"),
      embedder: controlledEmbedder,
      vectorDimensions: 4,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({ name: "RecheckOrg" });

    // 1. Seabed entry that will have ONLY redacted_at set mid-flight (kills M3b)
    const seaRedacted = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "Seabed secret redacted mid-flight",
    });

    // 2. Record that will have ONLY redacted_at set mid-flight (status stays 'active', sensitivity stays 'internal')
    const recRedactedAtOnly = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: "Record redacted_at-only mid-flight",
    });

    // 3. Seabed entry that will be re-queued with newer queuedAt & text mid-flight (P2 queuedAt check)
    const seaRequeued = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "Original text before requeue",
    });

    // 4. Control seabed entry that stays untouched and must be indexed
    const seaHealthy = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      kind: "message",
      text: "Healthy control seabed entry",
    });

    const syncPromise = engine.sea.syncEmbeddings({ batchSize: 10, maxItems: 4 });
    await batchStarted;

    // Mutate while embedBatch() is in-flight:
    const rawDb = (engine.db as unknown as { db: DatabaseSync }).db;
    const redactedTs = new Date().toISOString();

    // Only set redacted_at on seabed_entries (no other column changed, vec_pending untouched)
    rawDb
      .prepare(`UPDATE seabed_entries SET redacted_at = ? WHERE id = ?`)
      .run(redactedTs, seaRedacted.id);

    // Only set redacted_at on records (status stays 'active', sensitivity stays 'internal')
    rawDb
      .prepare(`UPDATE records SET redacted_at = ? WHERE id = ?`)
      .run(redactedTs, recRedactedAtOnly.id);

    // Re-queue seaRequeued with newer queuedAt and updated text while old embedding is in-flight
    const laterQueuedAt = new Date(Date.now() + 5000).toISOString();
    engine.db.markVectorPending({
      itemId: seaRequeued.id,
      sourceType: "seabed",
      orgId: org.id,
      realmId: rootRealm.id,
      status: "evidence",
      text: "message:updated text after requeue",
      queuedAt: laterQueuedAt,
    });

    // Resolve batch 1 with distinct vectors
    resolveBatch([
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([0, 1, 0, 0]),
      new Float32Array([0, 0, 1, 0]),
      new Float32Array([0, 0, 0, 1]),
    ]);

    const res1 = await syncPromise;
    expect(res1.processed).toBe(4);
    expect(res1.indexed).toBe(1); // ONLY seaHealthy
    expect(res1.skipped).toBe(3); // seaRedacted, recRedactedAtOnly, seaRequeued
    expect(res1.remaining).toBe(1); // seaRequeued kept in vec_pending for fresh embedding

    // Verify seaRedacted and recRedactedAtOnly are NOT in vec_items AND NOT in vec_pending
    const hitsAfterBatch1 = engine.db.searchVectors({
      embedding: new Float32Array([0.5, 0.5, 0.5, 0.5]),
      realmIds: [rootRealm.id],
      includeSuperseded: true,
      limit: 10,
    });
    expect(hitsAfterBatch1.map((h) => h.itemId)).toEqual([seaHealthy.id]);
    expect(engine.db.getPendingVector(seaRedacted.id)).toBeNull();
    expect(engine.db.getPendingVector(recRedactedAtOnly.id)).toBeNull();

    // seaRequeued is still queued with its newer queuedAt/text; next syncEmbeddings() embeds the fresh text
    const queuedAfterBatch1 = engine.db.getPendingVector(seaRequeued.id);
    expect(queuedAfterBatch1?.queuedAt).toBe(laterQueuedAt);
    expect(queuedAfterBatch1?.text).toBe("message:updated text after requeue");

    batchStarted = resetDeferred();
    const sync2Promise = engine.sea.syncEmbeddings({ batchSize: 10 });
    await batchStarted;
    expect(seenBatches[1]).toEqual(["message:updated text after requeue"]);
    resolveBatch([new Float32Array([0, 0, 1, 0])]);
    const res2 = await sync2Promise;
    expect(res2.indexed).toBe(1);
    expect(res2.remaining).toBe(0);
  });
});
