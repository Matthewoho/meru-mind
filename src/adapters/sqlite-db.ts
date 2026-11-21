import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import type {
  DbPort,
  FtsMatch,
  PendingVectorItem,
  VectorMatch,
} from "../ports.js";
import {
  MindError,
  type ChangeLogEntry,
  type Distillation,
  type DistillationLayer,
  type DriveFileMeta,
  type IdempotencyRecord,
  type LedgerRecord,
  type Organization,
  type OrgPolicy,
  type Realm,
  type RealmMount,
  type RecordKind,
  type SchemaMigrationRecord,
  type SeabedEntry,
  type SeabedKind,
  type Sensitivity,
} from "../types.js";

export interface SqliteDbOptions {
  dbPath: string;
  vectorDimensions?: number;
  enableVector?: boolean;
}

const DEFAULT_VECTOR_DIM = 1536;

/**
 * Normalizes mixed CJK + Latin text for SQLite FTS5 unicode61:
 * preserves Latin/numeric words while spacing individual CJK ideographs
 * so Chinese/Japanese/Korean phrases match reliably without external tokenizers.
 */
export function normalizeForFts(text: string): string {
  return text
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFtsMatchExpression(rawQuery: string): string | null {
  const normalized = normalizeForFts(rawQuery);
  const tokens = normalized
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function normalizeL2(embedding: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < embedding.length; i += 1) {
    const v = embedding[i]!;
    sumSq += v * v;
  }
  if (sumSq === 0) return embedding;
  const invNorm = 1 / Math.sqrt(sumSq);
  const out = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i += 1) {
    out[i] = embedding[i]! * invNorm;
  }
  return out;
}

function toVecBlob(embedding: Float32Array): Uint8Array {
  const unit = normalizeL2(embedding);
  return new Uint8Array(unit.buffer, unit.byteOffset, unit.byteLength);
}

function sleepSyncMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function isSqliteBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY/i.test(msg);
}

export class SqliteDb implements DbPort {
  private readonly db: DatabaseSync;
  readonly vecEnabled: boolean;
  readonly vectorDimensions: number;
  private inTransaction = false;

  constructor(options: SqliteDbOptions) {
    this.vectorDimensions = options.vectorDimensions ?? DEFAULT_VECTOR_DIM;
    if (
      !Number.isInteger(this.vectorDimensions) ||
      this.vectorDimensions <= 0
    ) {
      throw new MindError(
        "INVALID_INPUT",
        `vectorDimensions must be a positive integer, got ${this.vectorDimensions}`,
      );
    }

    if (options.dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    }

    const wantVec = options.enableVector ?? true;
    this.db = new DatabaseSync(options.dbPath, {
      allowExtension: wantVec,
    });

    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.execPragmaWithBusyRetry("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA secure_delete = ON;");

    let loadedVec = false;
    if (wantVec) {
      try {
        sqliteVec.load(this.db);
        loadedVec = true;
      } catch {
        loadedVec = false;
      }
    }
    this.vecEnabled = loadedVec;
    this.initSchema();
  }

  private execPragmaWithBusyRetry(sql: string, maxAttempts = 25): void {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        this.db.exec(sql);
        return;
      } catch (err) {
        if (!isSqliteBusyError(err) || attempt === maxAttempts) {
          throw err;
        }
        sleepSyncMs(5 + Math.floor(Math.random() * 20));
      }
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    return rows.some((r) => String(r.name) === column);
  }

  private ensureColumn(
    table: string,
    column: string,
    definition: string,
  ): void {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE name = ? LIMIT 1`)
      .get(name) as { ok: number } | undefined;
    return Boolean(row);
  }

  private createVecItemsTable(): void {
    if (!this.vecEnabled) return;
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
        item_id TEXT PRIMARY KEY,
        realm_id TEXT PARTITION KEY,
        status TEXT,
        source_type TEXT,
        embedding FLOAT[${this.vectorDimensions}]
      );
    `);
  }

  private initSchema(): void {
    this.transaction(() => {
      const now = new Date().toISOString();

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO meta (key, value) VALUES ('change_log_generation', '1')`,
        )
        .run();

      const applied = new Set<number>(
        (
          this.db
            .prepare(`SELECT version FROM schema_migrations`)
            .all() as Array<{ version: number }>
        ).map((r) => Number(r.version)),
      );

      // Migration v1: V0.1 baseline schema
      if (!applied.has(1)) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS orgs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_personal_root INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS realms (
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
          CREATE INDEX IF NOT EXISTS idx_realms_org_parent ON realms(org_id, parent_id);

          CREATE TABLE IF NOT EXISTS realm_mounts (
            id TEXT PRIMARY KEY,
            viewer_realm_id TEXT NOT NULL REFERENCES realms(id),
            target_realm_id TEXT NOT NULL REFERENCES realms(id),
            scope TEXT NOT NULL,
            mounted_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(viewer_realm_id, target_realm_id)
          );
          CREATE INDEX IF NOT EXISTS idx_mounts_viewer ON realm_mounts(viewer_realm_id);

          CREATE TABLE IF NOT EXISTS seabed_entries (
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
          CREATE INDEX IF NOT EXISTS idx_seabed_realm_time ON seabed_entries(realm_id, created_at DESC);

          CREATE TABLE IF NOT EXISTS records (
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
          CREATE INDEX IF NOT EXISTS idx_records_realm_kind_status ON records(realm_id, kind, status, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_records_thing ON records(thing_id, created_at ASC);

          CREATE TABLE IF NOT EXISTS distillations (
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
          CREATE INDEX IF NOT EXISTS idx_distill_realm_layer ON distillations(realm_id, layer, status, created_at DESC);

          CREATE TABLE IF NOT EXISTS drive_files (
            realm_id TEXT NOT NULL REFERENCES realms(id),
            rel_path TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            version INTEGER NOT NULL,
            updated_by TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (realm_id, rel_path)
          );

          CREATE VIRTUAL TABLE IF NOT EXISTS fts_index USING fts5(
            item_id UNINDEXED,
            source_type UNINDEXED,
            realm_id UNINDEXED,
            status UNINDEXED,
            title,
            body,
            tokenize = 'unicode61'
          );

          CREATE TABLE IF NOT EXISTS vec_pending (
            item_id TEXT PRIMARY KEY,
            source_type TEXT NOT NULL,
            realm_id TEXT NOT NULL,
            status TEXT NOT NULL,
            text TEXT NOT NULL
          );
        `);

        this.createVecItemsTable();

        this.db
          .prepare(
            `INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'v0.1_baseline', ?)`,
          )
          .run(now);
      }

      // Migration v2: V0.2a Slice 1a (org policy, provenance/sensitivity/redaction columns,
      // idempotency_keys, change_log, redacted_blocklist, vec_pending rebuild + re-enqueue)
      if (!applied.has(2)) {
        // 1. orgs.policy: nullable column, existing V0.1 orgs backfilled to 'tree'
        this.ensureColumn("orgs", "policy", "TEXT");
        this.db.exec(`UPDATE orgs SET policy = 'tree' WHERE policy IS NULL;`);

        // 2. seabed_entries incremental columns + backfills + indexes
        this.ensureColumn("seabed_entries", "org_id", "TEXT");
        this.ensureColumn("seabed_entries", "occurred_at", "TEXT");
        this.ensureColumn("seabed_entries", "origin_session_id", "TEXT");
        this.ensureColumn(
          "seabed_entries",
          "sensitivity",
          "TEXT NOT NULL DEFAULT 'internal'",
        );
        this.ensureColumn("seabed_entries", "redacted_at", "TEXT");
        this.ensureColumn("seabed_entries", "redacted_by", "TEXT");
        this.ensureColumn("seabed_entries", "redacted_reason", "TEXT");

        this.db.exec(`
          UPDATE seabed_entries
          SET org_id = (SELECT realms.org_id FROM realms WHERE realms.id = seabed_entries.realm_id)
          WHERE org_id IS NULL;
          UPDATE seabed_entries
          SET occurred_at = created_at
          WHERE occurred_at IS NULL;
          CREATE INDEX IF NOT EXISTS idx_seabed_org ON seabed_entries(org_id, occurred_at DESC);
          CREATE INDEX IF NOT EXISTS idx_seabed_realm_occurred ON seabed_entries(realm_id, occurred_at DESC);
        `);

        // 3. records incremental columns + backfills + indexes
        this.ensureColumn("records", "org_id", "TEXT");
        this.ensureColumn("records", "occurred_at", "TEXT");
        this.ensureColumn("records", "origin_session_id", "TEXT");
        this.ensureColumn(
          "records",
          "sensitivity",
          "TEXT NOT NULL DEFAULT 'internal'",
        );
        this.ensureColumn("records", "redacted_at", "TEXT");
        this.ensureColumn("records", "redacted_by", "TEXT");
        this.ensureColumn("records", "redacted_reason", "TEXT");
        this.ensureColumn(
          "records",
          "confirmed_by_human",
          "INTEGER NOT NULL DEFAULT 0",
        );
        this.ensureColumn("records", "ext_kind", "TEXT");

        this.db.exec(`
          UPDATE records
          SET org_id = (SELECT realms.org_id FROM realms WHERE realms.id = records.realm_id)
          WHERE org_id IS NULL;
          UPDATE records
          SET occurred_at = created_at
          WHERE occurred_at IS NULL;
          UPDATE records
          SET confirmed_by_human = 1
          WHERE author_kind = 'human' AND confirmed_by_human = 0;
          CREATE INDEX IF NOT EXISTS idx_records_org ON records(org_id, occurred_at DESC);
          CREATE INDEX IF NOT EXISTS idx_records_realm_occurred ON records(realm_id, occurred_at DESC);
        `);

        // 4. idempotency_keys, change_log, redacted_blocklist
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS idempotency_keys (
            org_id TEXT NOT NULL,
            key TEXT NOT NULL,
            target_table TEXT NOT NULL,
            target_id TEXT NOT NULL,
            realm_id TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (org_id, key)
          );

          CREATE TABLE IF NOT EXISTS change_log (
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
          CREATE INDEX IF NOT EXISTS idx_change_log_org_seq ON change_log(org_id, seq ASC);

          CREATE TABLE IF NOT EXISTS redacted_blocklist (
            org_id TEXT NOT NULL,
            source_ref TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            reason TEXT,
            redacted_at TEXT NOT NULL,
            PRIMARY KEY (org_id, source_ref, content_sha256)
          );
        `);

        // 5. Explicit vec_pending rebuild + C2 re-enqueue all non-secret, non-redacted entries missing from vec_items
        this.db.exec(`
          DROP TABLE IF EXISTS vec_pending;
          CREATE TABLE vec_pending (
            item_id TEXT PRIMARY KEY,
            source_type TEXT NOT NULL,
            org_id TEXT NOT NULL,
            realm_id TEXT NOT NULL,
            status TEXT NOT NULL,
            text TEXT NOT NULL,
            queued_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_vec_pending_queued ON vec_pending(queued_at ASC, item_id ASC);
        `);

        const existingVecIds = new Set<string>();
        if (this.vecEnabled && this.tableExists("vec_items")) {
          const vecRows = this.db
            .prepare(`SELECT item_id FROM vec_items`)
            .all() as Array<{ item_id: string }>;
          for (const vr of vecRows) {
            existingVecIds.add(String(vr.item_id));
          }
        }

        const insertPendingStmt = this.db.prepare(
          `INSERT OR REPLACE INTO vec_pending
           (item_id, source_type, org_id, realm_id, status, text, queued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );

        const recRows = this.db
          .prepare(
            `SELECT id, org_id, realm_id, status, title, payload_json
             FROM records
             WHERE redacted_at IS NULL AND sensitivity != 'secret' AND status != 'retracted'`,
          )
          .all() as Array<{
          id: string;
          org_id: string;
          realm_id: string;
          status: string;
          title: string;
          payload_json: string;
        }>;
        for (const r of recRows) {
          if (existingVecIds.has(r.id)) continue;
          let payloadText = "";
          try {
            const parsed = JSON.parse(String(r.payload_json)) as Record<
              string,
              unknown
            >;
            payloadText = Object.entries(parsed)
              .map(
                ([k, v]) =>
                  `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
              )
              .join("\n");
          } catch {
            payloadText = "";
          }
          const embedText = `${r.title}\n${payloadText}`.trim();
          if (!embedText) continue;
          insertPendingStmt.run(
            r.id,
            "record",
            r.org_id,
            r.realm_id,
            r.status,
            embedText,
            now,
          );
        }

        const seaRows = this.db
          .prepare(
            `SELECT id, org_id, realm_id, topic_id, kind, text
             FROM seabed_entries
             WHERE redacted_at IS NULL AND sensitivity != 'secret'`,
          )
          .all() as Array<{
          id: string;
          org_id: string;
          realm_id: string;
          topic_id: string | null;
          kind: string;
          text: string;
        }>;
        for (const s of seaRows) {
          if (existingVecIds.has(s.id)) continue;
          const title = `${s.kind}:${s.topic_id ?? s.realm_id}`;
          const embedText = `${title}\n${s.text}`.trim();
          if (!embedText) continue;
          insertPendingStmt.run(
            s.id,
            "seabed",
            s.org_id,
            s.realm_id,
            "evidence",
            embedText,
            now,
          );
        }

        const distRows = this.db
          .prepare(
            `SELECT d.id, r.org_id, d.realm_id, d.layer, d.period_key, d.status, d.narrative_md
             FROM distillations d
             JOIN realms r ON r.id = d.realm_id
             WHERE d.status != 'retracted'`,
          )
          .all() as Array<{
          id: string;
          org_id: string;
          realm_id: string;
          layer: string;
          period_key: string;
          status: string;
          narrative_md: string;
        }>;
        for (const d of distRows) {
          if (existingVecIds.has(d.id)) continue;
          const embedText =
            `${d.layer}:${d.period_key}\n${d.narrative_md}`.trim();
          if (!embedText) continue;
          insertPendingStmt.run(
            d.id,
            "distillation",
            d.org_id,
            d.realm_id,
            d.status,
            embedText,
            now,
          );
        }

        this.db
          .prepare(
            `INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'v0.2a_slice1a', ?)`,
          )
          .run(now);
      }

      if (this.vecEnabled && !this.tableExists("vec_items")) {
        this.createVecItemsTable();
      }
    });
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.inTransaction = true;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // ignore rollback error
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  // ---- Schema & Meta ----

  listSchemaMigrations(): SchemaMigrationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      version: Number(r.version),
      name: String(r.name),
      appliedAt: String(r.applied_at),
    }));
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // ---- Organizations ----

  insertOrg(org: Organization): void {
    this.db
      .prepare(
        `INSERT INTO orgs (id, name, is_personal_root, policy, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        org.id,
        org.name,
        org.isPersonalRoot ? 1 : 0,
        org.policy,
        org.createdAt,
      );
  }

  getOrg(id: string): Organization | null {
    const row = this.db
      .prepare(`SELECT * FROM orgs WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapOrg(row) : null;
  }

  listOrgs(): Organization[] {
    const rows = this.db
      .prepare(`SELECT * FROM orgs ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapOrg(r));
  }

  updateOrgPolicy(orgId: string, policy: OrgPolicy): boolean {
    const res = this.db
      .prepare(`UPDATE orgs SET policy = ? WHERE id = ?`)
      .run(policy, orgId);
    return Number(res.changes) > 0;
  }

  private mapOrg(row: Record<string, unknown>): Organization {
    return {
      id: String(row.id),
      name: String(row.name),
      isPersonalRoot: Number(row.is_personal_root) === 1,
      policy: (row.policy === "open" || row.policy === "tree"
        ? row.policy
        : "tree") as OrgPolicy,
      createdAt: String(row.created_at),
    };
  }

  // ---- Realms ----

  insertRealm(realm: Realm): void {
    this.db
      .prepare(
        `INSERT INTO realms (id, org_id, parent_id, slug, path, name, archived_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        realm.id,
        realm.orgId,
        realm.parentId,
        realm.slug,
        realm.path,
        realm.name,
        realm.archivedAt,
        realm.createdAt,
      );
  }

  getRealm(id: string): Realm | null {
    const row = this.db
      .prepare(`SELECT * FROM realms WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRealm(row) : null;
  }

  getRealmByPath(orgId: string, realmPath: string): Realm | null {
    const row = this.db
      .prepare(`SELECT * FROM realms WHERE org_id = ? AND path = ?`)
      .get(orgId, realmPath) as Record<string, unknown> | undefined;
    return row ? this.mapRealm(row) : null;
  }

  listRealms(orgId?: string): Realm[] {
    const rows = orgId
      ? (this.db
          .prepare(
            `SELECT * FROM realms WHERE org_id = ? ORDER BY path ASC, created_at ASC`,
          )
          .all(orgId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM realms ORDER BY org_id ASC, path ASC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapRealm(r));
  }

  private mapRealm(row: Record<string, unknown>): Realm {
    return {
      id: String(row.id),
      orgId: String(row.org_id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      slug: String(row.slug),
      path: String(row.path),
      name: String(row.name),
      archivedAt: row.archived_at ? String(row.archived_at) : null,
      createdAt: String(row.created_at),
    };
  }

  // ---- Mounts ----

  insertMount(mount: RealmMount): void {
    this.db
      .prepare(
        `INSERT INTO realm_mounts (id, viewer_realm_id, target_realm_id, scope, mounted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(viewer_realm_id, target_realm_id) DO UPDATE SET
           scope = excluded.scope,
           mounted_by = excluded.mounted_by,
           created_at = excluded.created_at`,
      )
      .run(
        mount.id,
        mount.viewerRealmId,
        mount.targetRealmId,
        mount.scope,
        mount.mountedBy,
        mount.createdAt,
      );
  }

  deleteMount(viewerRealmId: string, targetRealmId: string): boolean {
    const res = this.db
      .prepare(
        `DELETE FROM realm_mounts WHERE viewer_realm_id = ? AND target_realm_id = ?`,
      )
      .run(viewerRealmId, targetRealmId);
    return Number(res.changes) > 0;
  }

  listMounts(viewerRealmId?: string): RealmMount[] {
    const rows = viewerRealmId
      ? (this.db
          .prepare(
            `SELECT * FROM realm_mounts WHERE viewer_realm_id = ? ORDER BY created_at ASC`,
          )
          .all(viewerRealmId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM realm_mounts ORDER BY created_at ASC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => ({
      id: String(r.id),
      viewerRealmId: String(r.viewer_realm_id),
      targetRealmId: String(r.target_realm_id),
      scope: String(r.scope) as RealmMount["scope"],
      mountedBy: String(r.mounted_by),
      createdAt: String(r.created_at),
    }));
  }

  // ---- Seabed ----

  insertSeabedEntry(entry: SeabedEntry): void {
    this.db
      .prepare(
        `INSERT INTO seabed_entries
         (id, org_id, realm_id, topic_id, kind, author_id, author_kind, author_family, text, blob_sha256, source_ref, metadata_json, occurred_at, origin_session_id, sensitivity, redacted_at, redacted_by, redacted_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.orgId,
        entry.realmId,
        entry.topicId,
        entry.kind,
        entry.authorId,
        entry.authorKind,
        entry.authorFamily,
        entry.text,
        entry.blobSha256,
        entry.sourceRef,
        JSON.stringify(entry.metadata),
        entry.occurredAt,
        entry.originSessionId,
        entry.sensitivity,
        entry.redactedAt,
        entry.redactedBy,
        entry.redactedReason,
        entry.createdAt,
      );
  }

  getSeabedEntry(id: string): SeabedEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM seabed_entries WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapSeabed(row) : null;
  }

  listSeabedEntries(filter: {
    realmIds: string[];
    kinds?: SeabedKind[];
    authorId?: string;
    topicId?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): { items: SeabedEntry[]; total: number } {
    if (filter.realmIds.length === 0) {
      return { items: [], total: 0 };
    }
    const where: string[] = [
      `realm_id IN (${placeholders(filter.realmIds.length)})`,
    ];
    const params: SQLInputValue[] = [...filter.realmIds];

    if (filter.kinds && filter.kinds.length > 0) {
      where.push(`kind IN (${placeholders(filter.kinds.length)})`);
      params.push(...filter.kinds);
    }
    if (filter.authorId) {
      where.push(`author_id = ?`);
      params.push(filter.authorId);
    }
    if (filter.topicId) {
      where.push(`topic_id = ?`);
      params.push(filter.topicId);
    }
    if (filter.since) {
      where.push(`created_at >= ?`);
      params.push(filter.since);
    }
    if (filter.until) {
      where.push(`created_at <= ?`);
      params.push(filter.until);
    }

    const whereSql = where.join(" AND ");
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as c FROM seabed_entries WHERE ${whereSql}`)
      .get(...params) as { c: number };

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM seabed_entries WHERE ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      items: rows.map((r) => this.mapSeabed(r)),
      total: Number(totalRow.c),
    };
  }

  listAllSeabedEntries(): SeabedEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM seabed_entries ORDER BY created_at ASC, rowid ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSeabed(r));
  }

  private mapSeabed(row: Record<string, unknown>): SeabedEntry {
    return {
      id: String(row.id),
      orgId: String(row.org_id ?? ""),
      realmId: String(row.realm_id),
      topicId: row.topic_id ? String(row.topic_id) : null,
      kind: String(row.kind) as SeabedKind,
      authorId: String(row.author_id),
      authorKind: String(row.author_kind) as SeabedEntry["authorKind"],
      authorFamily: row.author_family ? String(row.author_family) : null,
      text: String(row.text),
      blobSha256: row.blob_sha256 ? String(row.blob_sha256) : null,
      sourceRef: row.source_ref ? String(row.source_ref) : null,
      metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
      occurredAt: String(row.occurred_at ?? row.created_at),
      originSessionId: row.origin_session_id
        ? String(row.origin_session_id)
        : null,
      sensitivity: (row.sensitivity
        ? String(row.sensitivity)
        : "internal") as Sensitivity,
      redactedAt: row.redacted_at ? String(row.redacted_at) : null,
      redactedBy: row.redacted_by ? String(row.redacted_by) : null,
      redactedReason: row.redacted_reason ? String(row.redacted_reason) : null,
      createdAt: String(row.created_at),
    };
  }

  // ---- Ledger Records ----

  insertRecord(record: LedgerRecord): void {
    this.db
      .prepare(
        `INSERT INTO records
         (id, org_id, realm_id, thing_id, kind, ext_kind, status, supersedes_id, superseded_by_id, author_id, author_kind, author_family, confirmed_by_human, title, payload_json, refs_json, occurred_at, origin_session_id, sensitivity, redacted_at, redacted_by, redacted_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.orgId,
        record.realmId,
        record.thingId,
        record.kind,
        record.extKind,
        record.status,
        record.supersedesId,
        record.supersededById,
        record.authorId,
        record.authorKind,
        record.authorFamily,
        record.confirmedByHuman ? 1 : 0,
        record.title,
        JSON.stringify(record.payload),
        JSON.stringify(record.refs),
        record.occurredAt,
        record.originSessionId,
        record.sensitivity,
        record.redactedAt,
        record.redactedBy,
        record.redactedReason,
        record.createdAt,
      );
  }

  markRecordSuperseded(oldId: string, newId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE records
         SET superseded_by_id = ?, status = 'superseded'
         WHERE id = ? AND status = 'active' AND superseded_by_id IS NULL`,
      )
      .run(newId, oldId);
    return Number(res.changes) === 1;
  }

  getRecord(id: string): LedgerRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM records WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRecord(row) : null;
  }

  listRecords(filter: {
    realmIds: string[];
    thingId?: string;
    kinds?: RecordKind[];
    authorId?: string;
    includeSuperseded?: boolean;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): { items: LedgerRecord[]; total: number } {
    if (filter.realmIds.length === 0) {
      return { items: [], total: 0 };
    }
    const where: string[] = [
      `realm_id IN (${placeholders(filter.realmIds.length)})`,
    ];
    const params: SQLInputValue[] = [...filter.realmIds];

    if (!filter.includeSuperseded) {
      where.push(`status = 'active'`);
    }
    if (filter.thingId) {
      where.push(`thing_id = ?`);
      params.push(filter.thingId);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      where.push(`kind IN (${placeholders(filter.kinds.length)})`);
      params.push(...filter.kinds);
    }
    if (filter.authorId) {
      where.push(`author_id = ?`);
      params.push(filter.authorId);
    }
    if (filter.since) {
      where.push(`created_at >= ?`);
      params.push(filter.since);
    }
    if (filter.until) {
      where.push(`created_at <= ?`);
      params.push(filter.until);
    }

    const whereSql = where.join(" AND ");
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as c FROM records WHERE ${whereSql}`)
      .get(...params) as { c: number };

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM records WHERE ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      items: rows.map((r) => this.mapRecord(r)),
      total: Number(totalRow.c),
    };
  }

  listAllRecords(): LedgerRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM records ORDER BY created_at ASC, rowid ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRecord(r));
  }

  private mapRecord(row: Record<string, unknown>): LedgerRecord {
    return {
      id: String(row.id),
      orgId: String(row.org_id ?? ""),
      realmId: String(row.realm_id),
      thingId: row.thing_id ? String(row.thing_id) : null,
      kind: String(row.kind) as RecordKind,
      extKind: row.ext_kind ? String(row.ext_kind) : null,
      status: String(row.status) as LedgerRecord["status"],
      supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
      supersededById: row.superseded_by_id
        ? String(row.superseded_by_id)
        : null,
      authorId: String(row.author_id),
      authorKind: String(row.author_kind) as LedgerRecord["authorKind"],
      authorFamily: row.author_family ? String(row.author_family) : null,
      confirmedByHuman: Number(row.confirmed_by_human ?? 0) === 1,
      title: String(row.title),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      refs: JSON.parse(String(row.refs_json)) as string[],
      occurredAt: String(row.occurred_at ?? row.created_at),
      originSessionId: row.origin_session_id
        ? String(row.origin_session_id)
        : null,
      sensitivity: (row.sensitivity
        ? String(row.sensitivity)
        : "internal") as Sensitivity,
      redactedAt: row.redacted_at ? String(row.redacted_at) : null,
      redactedBy: row.redacted_by ? String(row.redacted_by) : null,
      redactedReason: row.redacted_reason ? String(row.redacted_reason) : null,
      createdAt: String(row.created_at),
    };
  }

  // ---- Distillations ----

  insertDistillation(distillation: Distillation): void {
    this.db
      .prepare(
        `INSERT INTO distillations
         (id, realm_id, layer, period_key, status, hard_facts_json, narrative_md, source_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        distillation.id,
        distillation.realmId,
        distillation.layer,
        distillation.periodKey,
        distillation.status,
        JSON.stringify(distillation.hardFacts),
        distillation.narrativeMd,
        JSON.stringify(distillation.sourceIds),
        distillation.createdAt,
      );
  }

  supersedeActiveDistillations(
    realmId: string,
    layer: DistillationLayer,
    periodKey: string,
    exceptId: string,
  ): void {
    const rows = this.db
      .prepare(
        `SELECT id FROM distillations
         WHERE realm_id = ? AND layer = ? AND period_key = ? AND status = 'active' AND id != ?`,
      )
      .all(realmId, layer, periodKey, exceptId) as Array<{ id: string }>;

    this.db
      .prepare(
        `UPDATE distillations SET status = 'superseded'
         WHERE realm_id = ? AND layer = ? AND period_key = ? AND status = 'active' AND id != ?`,
      )
      .run(realmId, layer, periodKey, exceptId);

    for (const row of rows) {
      this.updateFtsStatus(row.id, "superseded");
      this.updateVectorStatus(row.id, "superseded");
    }
  }

  getDistillation(id: string): Distillation | null {
    const row = this.db
      .prepare(`SELECT * FROM distillations WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapDistillation(row) : null;
  }

  getLatestDistillation(
    realmId: string,
    layer: DistillationLayer,
  ): Distillation | null {
    const row = this.db
      .prepare(
        `SELECT * FROM distillations
         WHERE realm_id = ? AND layer = ? AND status = 'active'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(realmId, layer) as Record<string, unknown> | undefined;
    return row ? this.mapDistillation(row) : null;
  }

  listDistillations(filter: {
    realmIds: string[];
    layers?: DistillationLayer[];
    includeSuperseded?: boolean;
    limit?: number;
    offset?: number;
  }): { items: Distillation[]; total: number } {
    if (filter.realmIds.length === 0) {
      return { items: [], total: 0 };
    }
    const where: string[] = [
      `realm_id IN (${placeholders(filter.realmIds.length)})`,
    ];
    const params: SQLInputValue[] = [...filter.realmIds];

    if (!filter.includeSuperseded) {
      where.push(`status = 'active'`);
    }
    if (filter.layers && filter.layers.length > 0) {
      where.push(`layer IN (${placeholders(filter.layers.length)})`);
      params.push(...filter.layers);
    }

    const whereSql = where.join(" AND ");
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as c FROM distillations WHERE ${whereSql}`)
      .get(...params) as { c: number };

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM distillations WHERE ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      items: rows.map((r) => this.mapDistillation(r)),
      total: Number(totalRow.c),
    };
  }

  listAllDistillations(): Distillation[] {
    const rows = this.db
      .prepare(`SELECT * FROM distillations ORDER BY created_at ASC, rowid ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapDistillation(r));
  }

  private mapDistillation(row: Record<string, unknown>): Distillation {
    return {
      id: String(row.id),
      realmId: String(row.realm_id),
      layer: String(row.layer) as DistillationLayer,
      periodKey: String(row.period_key),
      status: String(row.status) as Distillation["status"],
      hardFacts: JSON.parse(String(row.hard_facts_json)) as Record<
        string,
        unknown
      >,
      narrativeMd: String(row.narrative_md),
      sourceIds: JSON.parse(String(row.source_ids_json)) as string[],
      createdAt: String(row.created_at),
    };
  }

  // ---- Drive File Meta ----

  upsertDriveFileMeta(meta: DriveFileMeta): void {
    this.db
      .prepare(
        `INSERT INTO drive_files (realm_id, rel_path, sha256, version, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(realm_id, rel_path) DO UPDATE SET
           sha256 = excluded.sha256,
           version = excluded.version,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        meta.realmId,
        meta.relPath,
        meta.sha256,
        meta.version,
        meta.updatedBy,
        meta.updatedAt,
      );
  }

  getDriveFileMeta(realmId: string, relPath: string): DriveFileMeta | null {
    const row = this.db
      .prepare(
        `SELECT * FROM drive_files WHERE realm_id = ? AND rel_path = ?`,
      )
      .get(realmId, relPath) as Record<string, unknown> | undefined;
    return row ? this.mapDriveMeta(row) : null;
  }

  listDriveFilesMeta(realmIds: string[]): DriveFileMeta[] {
    if (realmIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM drive_files WHERE realm_id IN (${placeholders(realmIds.length)}) ORDER BY realm_id ASC, rel_path ASC`,
      )
      .all(...realmIds) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapDriveMeta(r));
  }

  private mapDriveMeta(row: Record<string, unknown>): DriveFileMeta {
    return {
      realmId: String(row.realm_id),
      relPath: String(row.rel_path),
      sha256: String(row.sha256),
      version: Number(row.version),
      updatedBy: String(row.updated_by),
      updatedAt: String(row.updated_at),
    };
  }

  // ---- Idempotency Keys ----

  getIdempotencyKey(orgId: string, key: string): IdempotencyRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM idempotency_keys WHERE org_id = ? AND key = ?`,
      )
      .get(orgId, key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      orgId: String(row.org_id),
      key: String(row.key),
      targetTable: String(row.target_table) as IdempotencyRecord["targetTable"],
      targetId: String(row.target_id),
      realmId: String(row.realm_id),
      payloadHash: String(row.payload_hash),
      createdAt: String(row.created_at),
    };
  }

  insertIdempotencyKey(record: IdempotencyRecord): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_keys
         (org_id, key, target_table, target_id, realm_id, payload_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.orgId,
        record.key,
        record.targetTable,
        record.targetId,
        record.realmId,
        record.payloadHash,
        record.createdAt,
      );
  }

  // ---- Change Log ----

  getChangeLogGeneration(): number {
    const raw = this.getMeta("change_log_generation");
    const parsed = raw ? Number.parseInt(raw, 10) : 1;
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  }

  appendChangeLog(
    entry: Omit<ChangeLogEntry, "seq" | "generation">,
  ): ChangeLogEntry {
    const generation = this.getChangeLogGeneration();
    const res = this.db
      .prepare(
        `INSERT INTO change_log
         (generation, org_id, realm_id, entity_type, entity_id, op, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        generation,
        entry.orgId,
        entry.realmId,
        entry.entityType,
        entry.entityId,
        entry.op,
        entry.actorId,
        entry.createdAt,
      );
    return {
      seq: Number(res.lastInsertRowid),
      generation,
      ...entry,
    };
  }

  listChangeLog(params?: {
    orgId?: string;
    sinceSeq?: number;
    limit?: number;
  }): { generation: number; entries: ChangeLogEntry[] } {
    const generation = this.getChangeLogGeneration();
    const where: string[] = [];
    const sqlParams: SQLInputValue[] = [];
    if (params?.orgId) {
      where.push(`org_id = ?`);
      sqlParams.push(params.orgId);
    }
    if (params?.sinceSeq !== undefined) {
      where.push(`seq > ?`);
      sqlParams.push(params.sinceSeq);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = params?.limit ?? 200;
    const rows = this.db
      .prepare(
        `SELECT * FROM change_log ${whereSql} ORDER BY seq ASC LIMIT ?`,
      )
      .all(...sqlParams, limit) as Array<Record<string, unknown>>;

    return {
      generation,
      entries: rows.map((r) => ({
        seq: Number(r.seq),
        generation: Number(r.generation),
        orgId: String(r.org_id),
        realmId: String(r.realm_id),
        entityType: String(r.entity_type),
        entityId: String(r.entity_id),
        op: String(r.op),
        actorId: String(r.actor_id),
        createdAt: String(r.created_at),
      })),
    };
  }

  resetChangeLog(): { generation: number; clearedCount: number } {
    return this.transaction(() => {
      const countRow = this.db
        .prepare(`SELECT COUNT(*) AS c FROM change_log`)
        .get() as { c: number };
      this.db.exec(`DELETE FROM change_log;`);
      const nextGen = this.getChangeLogGeneration() + 1;
      this.setMeta("change_log_generation", String(nextGen));
      return {
        generation: nextGen,
        clearedCount: Number(countRow.c),
      };
    });
  }

  // ---- Rebuildable FTS5 Index ----

  upsertFtsItem(item: {
    itemId: string;
    sourceType: "record" | "seabed" | "distillation";
    realmId: string;
    status: string;
    title: string;
    body: string;
  }): void {
    this.db.prepare(`DELETE FROM fts_index WHERE item_id = ?`).run(item.itemId);
    this.db
      .prepare(
        `INSERT INTO fts_index (item_id, source_type, realm_id, status, title, body)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.itemId,
        item.sourceType,
        item.realmId,
        item.status,
        normalizeForFts(item.title),
        normalizeForFts(item.body),
      );
  }

  updateFtsStatus(itemId: string, status: string): void {
    const row = this.db
      .prepare(
        `SELECT source_type, realm_id, title, body FROM fts_index WHERE item_id = ?`,
      )
      .get(itemId) as
      | { source_type: string; realm_id: string; title: string; body: string }
      | undefined;
    if (!row) return;
    this.db.prepare(`DELETE FROM fts_index WHERE item_id = ?`).run(itemId);
    this.db
      .prepare(
        `INSERT INTO fts_index (item_id, source_type, realm_id, status, title, body)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(itemId, row.source_type, row.realm_id, status, row.title, row.body);
  }

  deleteFtsItem(itemId: string): void {
    this.db.prepare(`DELETE FROM fts_index WHERE item_id = ?`).run(itemId);
  }

  searchFts(params: {
    query: string;
    realmIds: string[];
    sourceTypes?: Array<"record" | "seabed" | "distillation">;
    includeSuperseded: boolean;
    limit: number;
  }): FtsMatch[] {
    if (params.realmIds.length === 0) return [];
    const expr = buildFtsMatchExpression(params.query);
    if (!expr) return [];

    const where: string[] = [
      `fts_index MATCH ?`,
      `realm_id IN (${placeholders(params.realmIds.length)})`,
    ];
    const sqlParams: SQLInputValue[] = [expr, ...params.realmIds];
    if (params.sourceTypes && params.sourceTypes.length > 0) {
      where.push(`source_type IN (${placeholders(params.sourceTypes.length)})`);
      sqlParams.push(...params.sourceTypes);
    }
    if (!params.includeSuperseded) {
      where.push(`status IN ('active', 'evidence')`);
    }

    const rows = this.db
      .prepare(
        `SELECT item_id, source_type, realm_id, status, bm25(fts_index) AS rank
         FROM fts_index
         WHERE ${where.join(" AND ")}
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(...sqlParams, params.limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      itemId: String(r.item_id),
      sourceType: String(r.source_type) as FtsMatch["sourceType"],
      realmId: String(r.realm_id),
      status: String(r.status),
      rank: Number(r.rank),
    }));
  }

  clearFtsIndex(): void {
    this.db.exec(`DELETE FROM fts_index;`);
  }

  // ---- Rebuildable sqlite-vec Index ----

  upsertVectorItem(item: {
    itemId: string;
    sourceType: "record" | "seabed" | "distillation";
    realmId: string;
    status: string;
    embedding: Float32Array;
  }): void {
    if (!this.vecEnabled) return;
    if (item.embedding.length !== this.vectorDimensions) {
      throw new MindError(
        "INVALID_INPUT",
        `Embedding dimension mismatch: expected ${this.vectorDimensions}, got ${item.embedding.length}`,
      );
    }
    this.db.prepare(`DELETE FROM vec_items WHERE item_id = ?`).run(item.itemId);
    this.db
      .prepare(
        `INSERT INTO vec_items (item_id, realm_id, status, source_type, embedding)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        item.itemId,
        item.realmId,
        item.status,
        item.sourceType,
        toVecBlob(item.embedding),
      );
    this.db
      .prepare(`DELETE FROM vec_pending WHERE item_id = ?`)
      .run(item.itemId);
  }

  markVectorPending(item: PendingVectorItem): void {
    const queuedAt = item.queuedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO vec_pending (item_id, source_type, org_id, realm_id, status, text, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           source_type = excluded.source_type,
           org_id = excluded.org_id,
           realm_id = excluded.realm_id,
           status = excluded.status,
           text = excluded.text,
           queued_at = excluded.queued_at`,
      )
      .run(
        item.itemId,
        item.sourceType,
        item.orgId,
        item.realmId,
        item.status,
        item.text,
        queuedAt,
      );
  }

  getPendingVector(itemId: string): PendingVectorItem | null {
    const row = this.db
      .prepare(`SELECT * FROM vec_pending WHERE item_id = ?`)
      .get(itemId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      itemId: String(row.item_id),
      sourceType: String(row.source_type) as PendingVectorItem["sourceType"],
      orgId: String(row.org_id),
      realmId: String(row.realm_id),
      status: String(row.status),
      text: String(row.text),
      queuedAt: String(row.queued_at),
    };
  }

  deletePendingVector(itemId: string): void {
    this.db.prepare(`DELETE FROM vec_pending WHERE item_id = ?`).run(itemId);
  }

  countPendingVectors(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM vec_pending`)
      .get() as { c: number };
    return Number(row.c);
  }

  updateVectorStatus(itemId: string, status: string): void {
    this.db
      .prepare(`UPDATE vec_pending SET status = ? WHERE item_id = ?`)
      .run(status, itemId);

    if (!this.vecEnabled) return;
    const row = this.db
      .prepare(
        `SELECT realm_id, source_type, embedding FROM vec_items WHERE item_id = ?`,
      )
      .get(itemId) as
      | { realm_id: string; source_type: string; embedding: Uint8Array }
      | undefined;
    if (!row) return;

    this.db.prepare(`DELETE FROM vec_items WHERE item_id = ?`).run(itemId);
    this.db
      .prepare(
        `INSERT INTO vec_items (item_id, realm_id, status, source_type, embedding)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(itemId, row.realm_id, status, row.source_type, row.embedding);
  }

  deleteVectorItem(itemId: string): void {
    this.db.prepare(`DELETE FROM vec_pending WHERE item_id = ?`).run(itemId);
    if (this.vecEnabled) {
      this.db.prepare(`DELETE FROM vec_items WHERE item_id = ?`).run(itemId);
    }
  }

  listPendingVectors(limit = 200, offset = 0): PendingVectorItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM vec_pending ORDER BY queued_at ASC, item_id ASC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      itemId: String(r.item_id),
      sourceType: String(r.source_type) as PendingVectorItem["sourceType"],
      orgId: String(r.org_id),
      realmId: String(r.realm_id),
      status: String(r.status),
      text: String(r.text),
      queuedAt: String(r.queued_at),
    }));
  }

  searchVectors(params: {
    embedding: Float32Array;
    realmIds: string[];
    sourceTypes?: Array<"record" | "seabed" | "distillation">;
    includeSuperseded: boolean;
    limit: number;
  }): VectorMatch[] {
    if (!this.vecEnabled || params.realmIds.length === 0) return [];
    if (params.embedding.length !== this.vectorDimensions) {
      throw new MindError(
        "INVALID_INPUT",
        `Query embedding dimension mismatch: expected ${this.vectorDimensions}, got ${params.embedding.length}`,
      );
    }

    // Partition-key + status + source_type pre-filter ensures hidden siblings,
    // hidden descendant seabed, and superseded records are excluded at the vec0
    // index scan level before Top-K selection.
    const where: string[] = [
      `embedding MATCH ?`,
      `k = ?`,
      `realm_id IN (${placeholders(params.realmIds.length)})`,
    ];
    const sqlParams: SQLInputValue[] = [
      toVecBlob(params.embedding),
      params.limit,
      ...params.realmIds,
    ];
    if (params.sourceTypes && params.sourceTypes.length > 0) {
      where.push(`source_type IN (${placeholders(params.sourceTypes.length)})`);
      sqlParams.push(...params.sourceTypes);
    }
    if (!params.includeSuperseded) {
      where.push(`status IN ('active', 'evidence')`);
    }

    const rows = this.db
      .prepare(
        `SELECT item_id, source_type, realm_id, status, distance
         FROM vec_items
         WHERE ${where.join(" AND ")}`,
      )
      .all(...sqlParams) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      itemId: String(r.item_id),
      sourceType: String(r.source_type) as VectorMatch["sourceType"],
      realmId: String(r.realm_id),
      status: String(r.status),
      distance: Number(r.distance),
    }));
  }

  clearVectorIndex(): void {
    this.db.exec(`DELETE FROM vec_pending;`);
    if (this.vecEnabled) {
      this.db.exec(`DELETE FROM vec_items;`);
    }
  }
}
