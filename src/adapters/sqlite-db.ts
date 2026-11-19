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
  type Distillation,
  type DistillationLayer,
  type DriveFileMeta,
  type LedgerRecord,
  type Organization,
  type Realm,
  type RealmMount,
  type RecordKind,
  type SeabedEntry,
  type SeabedKind,
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

    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");

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

  private initSchema(): void {
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

    if (this.vecEnabled) {
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

  // ---- Organizations ----

  insertOrg(org: Organization): void {
    this.db
      .prepare(
        `INSERT INTO orgs (id, name, is_personal_root, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(org.id, org.name, org.isPersonalRoot ? 1 : 0, org.createdAt);
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

  private mapOrg(row: Record<string, unknown>): Organization {
    return {
      id: String(row.id),
      name: String(row.name),
      isPersonalRoot: Number(row.is_personal_root) === 1,
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
         (id, realm_id, topic_id, kind, author_id, author_kind, author_family, text, blob_sha256, source_ref, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
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
      createdAt: String(row.created_at),
    };
  }

  // ---- Ledger Records ----

  insertRecord(record: LedgerRecord): void {
    this.db
      .prepare(
        `INSERT INTO records
         (id, realm_id, thing_id, kind, status, supersedes_id, superseded_by_id, author_id, author_kind, author_family, title, payload_json, refs_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.realmId,
        record.thingId,
        record.kind,
        record.status,
        record.supersedesId,
        record.supersededById,
        record.authorId,
        record.authorKind,
        record.authorFamily,
        record.title,
        JSON.stringify(record.payload),
        JSON.stringify(record.refs),
        record.createdAt,
      );
  }

  markRecordSuperseded(oldId: string, newId: string): void {
    this.db
      .prepare(
        `UPDATE records SET status = 'superseded', superseded_by_id = ? WHERE id = ?`,
      )
      .run(newId, oldId);
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
      realmId: String(row.realm_id),
      thingId: row.thing_id ? String(row.thing_id) : null,
      kind: String(row.kind) as RecordKind,
      status: String(row.status) as LedgerRecord["status"],
      supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
      supersededById: row.superseded_by_id
        ? String(row.superseded_by_id)
        : null,
      authorId: String(row.author_id),
      authorKind: String(row.author_kind) as LedgerRecord["authorKind"],
      authorFamily: row.author_family ? String(row.author_family) : null,
      title: String(row.title),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      refs: JSON.parse(String(row.refs_json)) as string[],
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
    this.db
      .prepare(
        `INSERT INTO vec_pending (item_id, source_type, realm_id, status, text)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           status = excluded.status,
           text = excluded.text`,
      )
      .run(item.itemId, item.sourceType, item.realmId, item.status, item.text);
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

  listPendingVectors(limit = 200): PendingVectorItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM vec_pending LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      itemId: String(r.item_id),
      sourceType: String(r.source_type) as PendingVectorItem["sourceType"],
      realmId: String(r.realm_id),
      status: String(r.status),
      text: String(r.text),
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
