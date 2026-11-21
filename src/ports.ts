import type {
  ChangeLogEntry,
  Distillation,
  DistillationLayer,
  DriveFileContent,
  DriveFileMeta,
  IdempotencyRecord,
  LedgerRecord,
  Organization,
  OrgPolicy,
  Realm,
  RealmMount,
  RecordKind,
  SchemaMigrationRecord,
  SeabedEntry,
  SeabedKind,
} from "./types.js";

export interface FtsMatch {
  itemId: string;
  sourceType: "record" | "seabed" | "distillation";
  realmId: string;
  status: string;
  rank: number;
}

export interface VectorMatch {
  itemId: string;
  sourceType: "record" | "seabed" | "distillation";
  realmId: string;
  status: string;
  distance: number;
}

export interface PendingVectorItem {
  itemId: string;
  sourceType: "record" | "seabed" | "distillation";
  orgId: string;
  realmId: string;
  status: string;
  text: string;
  queuedAt?: string;
}

/**
 * Thin persistence port. Local implementation uses Node 22 node:sqlite (WAL + FTS5 + sqlite-vec);
 * cloud implementations can swap in D1/Postgres+pgvector without changing core logic.
 *
 * NOTE on `change_log.seq` monotonicity:
 * Gap-free, strictly monotonic `change_log.seq` relies on SQLite single-writer
 * `BEGIN IMMEDIATE` transactions (serialized writers and transactional rollback of
 * `sqlite_sequence`). Multi-writer cloud backends swapping in Postgres/D1 must either
 * serialize `change_log` appends or explicitly tolerate sequence gaps when polling cursors.
 */
export interface DbPort {
  readonly vecEnabled: boolean;
  readonly vectorDimensions: number;

  close(): void;
  transaction<T>(fn: () => T): T;

  // Schema & Meta
  listSchemaMigrations(): SchemaMigrationRecord[];
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  // Organizations & Realms
  insertOrg(org: Organization): void;
  getOrg(id: string): Organization | null;
  listOrgs(): Organization[];
  updateOrgPolicy(orgId: string, policy: OrgPolicy): boolean;

  insertRealm(realm: Realm): void;
  getRealm(id: string): Realm | null;
  getRealmByPath(orgId: string, realmPath: string): Realm | null;
  listRealms(orgId?: string): Realm[];

  insertMount(mount: RealmMount): void;
  deleteMount(viewerRealmId: string, targetRealmId: string): boolean;
  listMounts(viewerRealmId?: string): RealmMount[];

  // Seabed (truth source 1: append-only raw messages, artifacts, evidence, signals)
  insertSeabedEntry(entry: SeabedEntry): void;
  getSeabedEntry(id: string): SeabedEntry | null;
  listSeabedEntries(filter: {
    realmIds: string[];
    kinds?: SeabedKind[];
    authorId?: string;
    topicId?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): { items: SeabedEntry[]; total: number };
  listAllSeabedEntries(): SeabedEntry[];

  // Records (truth source 2: append-only ledger with supersede chains)
  insertRecord(record: LedgerRecord): void;
  /** Atomic CAS supersede: returns true iff the target row was active and unsuperseded (changes === 1). */
  markRecordSuperseded(oldId: string, newId: string): boolean;
  getRecord(id: string): LedgerRecord | null;
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
  }): { items: LedgerRecord[]; total: number };
  listAllRecords(): LedgerRecord[];

  // Distillations (rebuildable event slices & cognitive cards)
  insertDistillation(distillation: Distillation): void;
  supersedeActiveDistillations(
    realmId: string,
    layer: DistillationLayer,
    periodKey: string,
    exceptId: string,
  ): void;
  getDistillation(id: string): Distillation | null;
  getLatestDistillation(
    realmId: string,
    layer: DistillationLayer,
  ): Distillation | null;
  listDistillations(filter: {
    realmIds: string[];
    layers?: DistillationLayer[];
    includeSuperseded?: boolean;
    limit?: number;
    offset?: number;
  }): { items: Distillation[]; total: number };
  listAllDistillations(): Distillation[];

  // Drive file metadata index (tracks latest canonical blob sha256 per realm+path)
  upsertDriveFileMeta(meta: DriveFileMeta): void;
  getDriveFileMeta(realmId: string, relPath: string): DriveFileMeta | null;
  listDriveFilesMeta(realmIds: string[]): DriveFileMeta[];

  // Idempotency keys (org-scoped, shared across records & seabed_entries)
  getIdempotencyKey(orgId: string, key: string): IdempotencyRecord | null;
  insertIdempotencyKey(record: IdempotencyRecord): void;

  // Change log (append-only operational event log; never cleared by rebuild())
  getChangeLogGeneration(): number;
  appendChangeLog(
    entry: Omit<ChangeLogEntry, "seq" | "generation">,
  ): ChangeLogEntry;
  listChangeLog(params?: {
    orgId?: string;
    sinceSeq?: number;
    limit?: number;
  }): { generation: number; entries: ChangeLogEntry[] };
  resetChangeLog(): { generation: number; clearedCount: number };

  // Rebuildable FTS5 index
  upsertFtsItem(item: {
    itemId: string;
    sourceType: "record" | "seabed" | "distillation";
    realmId: string;
    status: string;
    title: string;
    body: string;
  }): void;
  updateFtsStatus(itemId: string, status: string): void;
  deleteFtsItem(itemId: string): void;
  searchFts(params: {
    query: string;
    realmIds: string[];
    sourceTypes?: Array<"record" | "seabed" | "distillation">;
    includeSuperseded: boolean;
    limit: number;
  }): FtsMatch[];
  clearFtsIndex(): void;

  // Rebuildable sqlite-vec index
  upsertVectorItem(item: {
    itemId: string;
    sourceType: "record" | "seabed" | "distillation";
    realmId: string;
    status: string;
    embedding: Float32Array;
  }): void;
  markVectorPending(item: PendingVectorItem): void;
  getPendingVector(itemId: string): PendingVectorItem | null;
  deletePendingVector(itemId: string): void;
  countPendingVectors(): number;
  updateVectorStatus(itemId: string, status: string): void;
  deleteVectorItem(itemId: string): void;
  listPendingVectors(limit?: number, offset?: number): PendingVectorItem[];
  searchVectors(params: {
    embedding: Float32Array;
    realmIds: string[];
    sourceTypes?: Array<"record" | "seabed" | "distillation">;
    includeSuperseded: boolean;
    limit: number;
  }): VectorMatch[];
  clearVectorIndex(): void;
}

/**
 * Immutable content-addressed blob storage for seabed attachments, evidence, and drive snapshots.
 * Survives LayerFS crash/loss so the entire drive can be rebuilt from SQLite + blobs.
 */
export interface BlobPort {
  put(content: Buffer | string): { sha256: string; bytes: number };
  get(sha256: string): Buffer | null;
  getText(sha256: string): string | null;
  has(sha256: string): boolean;
}

export interface DriveWriteResult {
  meta: DriveFileMeta;
  commitId?: string;
}

/**
 * Concurrent MindRealm shared file drive port.
 * Primary concurrent adapter: LayerFSDriveAdapter (branch-per-write + native Conflict detection).
 * Local fallback adapter: LocalFsDriveAdapter (optimistic version check on local disk).
 */
export interface DrivePort {
  readonly kind: "layerfs" | "local";
  init(): Promise<void>;
  readFile(realmId: string, relPath: string): Promise<DriveFileContent | null>;
  listFiles(realmId: string): Promise<DriveFileMeta[]>;
  /**
   * Optimistic concurrent write:
   * - If expectedVersion is provided and does not match the current version (or LayerFS reports Conflict),
   *   MUST throw MindError("CONFLICT", ...) without overwriting the winning version.
   */
  writeFile(params: {
    realmId: string;
    relPath: string;
    content: string;
    authorId: string;
    expectedVersion?: number;
    message?: string;
  }): Promise<DriveWriteResult>;
  /**
   * Rebuilds the drive working tree from canonical SQLite + BlobPort snapshots after crash/reset.
   */
  restoreFromSnapshots(
    snapshots: Array<{ meta: DriveFileMeta; content: string }>,
  ): Promise<number>;
  close(): Promise<void>;
}

/**
 * Pluggable embedding provider for sqlite-vec semantic recall.
 * When unconfigured or offline, returns null so writes/reads degrade gracefully to FTS5.
 */
export interface EmbedderPort {
  readonly dimensions: number;
  readonly configured: boolean;
  embed(text: string): Promise<Float32Array | null>;
  embedBatch?(texts: string[]): Promise<Array<Float32Array | null>>;
}
