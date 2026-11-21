import type {
  ChangeLogEntry,
  Distillation,
  DistillationLayer,
  DriveFileContent,
  DriveFileMeta,
  EntryObjectLink,
  IdempotencyRecord,
  LedgerRecord,
  MindObject,
  Organization,
  OrgPolicy,
  Realm,
  RealmMount,
  RecordKind,
  RedactedBlocklistEntry,
  ResourceTag,
  ResourceTagSummary,
  SchemaMigrationRecord,
  SeabedEntry,
  SeabedKind,
  Sensitivity,
  WalCheckpointResult,
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
export interface RealmRecordCountRow {
  rules: number;
  conclusions: number;
  things: number;
  decisions: number;
}

export interface UnifiedEntryRef {
  id: string;
  sourceType: "record" | "seabed";
  occurredAt: string | null;
  createdAt: string;
}

export interface DbPort {
  readonly vecEnabled: boolean;
  readonly vectorDimensions: number;

  close(): void;
  transaction<T>(fn: () => T): T;
  getQueryCount(): number;
  resetQueryCount(): void;

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
  getSeabedEntriesByIds(ids: string[]): SeabedEntry[];
  listSeabedEntries(filter: {
    realmIds: string[];
    kinds?: SeabedKind[];
    authorId?: string;
    topicId?: string;
    since?: string;
    until?: string;
    /** Defaults to ["secret"] so secret entries are excluded from all list/timeline paths */
    excludeSensitivities?: Sensitivity[];
    limit?: number;
    offset?: number;
  }): { items: SeabedEntry[]; total: number };
  listAllSeabedEntries(): SeabedEntry[];

  // Records (truth source 2: append-only ledger with supersede chains)
  insertRecord(record: LedgerRecord): void;
  /** Atomic CAS supersede: returns true iff the target row was active and unsuperseded (changes === 1). */
  markRecordSuperseded(oldId: string, newId: string, orgId?: string): boolean;
  getRecord(id: string): LedgerRecord | null;
  getRecordsByIds(ids: string[]): LedgerRecord[];
  findActiveRecordBySourceRef(
    orgId: string,
    sourceRef: string,
    realmId?: string,
  ): LedgerRecord | null;
  findLatestRecordBySourceRef(
    orgId: string,
    sourceRef: string,
    realmId?: string,
  ): LedgerRecord | null;
  findRecordsByExternalRef(
    orgId: string,
    externalRef: string,
    realmIds?: string[],
    excludeSensitivities?: Sensitivity[],
  ): LedgerRecord[];
  listRecords(filter: {
    realmIds: string[];
    thingId?: string;
    kinds?: RecordKind[];
    authorId?: string;
    externalRef?: string;
    includeSuperseded?: boolean;
    since?: string;
    until?: string;
    /** Defaults to ["secret"] so secret entries are excluded from all list/timeline paths */
    excludeSensitivities?: Sensitivity[];
    limit?: number;
    offset?: number;
  }): { items: LedgerRecord[]; total: number };
  listRecordsWindow(params: {
    realmIds: string[];
    anchorTime: string;
    anchorId: string;
    direction: "before" | "after";
    timeBasis?: "occurred_at" | "created_at";
    limit: number;
    excludeSensitivities?: Sensitivity[];
  }): LedgerRecord[];
  listSeabedWindow(params: {
    realmIds: string[];
    anchorTime: string;
    anchorId: string;
    direction: "before" | "after";
    timeBasis?: "occurred_at" | "created_at";
    limit: number;
    excludeSensitivities?: Sensitivity[];
  }): SeabedEntry[];
  listPendingHumanQuestions(filter: {
    realmIds: string[];
    excludeSensitivities?: Sensitivity[];
    limit?: number;
  }): { items: LedgerRecord[]; total: number };
  countRecordsByKind(filter: {
    realmIds: string[];
    includeSuperseded?: boolean;
    excludeSensitivities?: Sensitivity[];
  }): Record<string, number>;
  countActiveRecordsByRealm(filter: {
    realmIds: string[];
    excludeSensitivities?: Sensitivity[];
  }): Map<string, RealmRecordCountRow>;
  countSeabedByRealm(filter: {
    realmIds: string[];
    excludeSensitivities?: Sensitivity[];
  }): Map<string, number>;
  countPendingQuestionsByRealm(filter: {
    realmIds: string[];
    excludeSensitivities?: Sensitivity[];
  }): Map<string, number>;
  countObjectsByRealm(filter: {
    orgId: string;
    realmIds: string[];
  }): Map<string, number>;
  countLinkedEntriesByObjectRealm(filter: {
    orgId: string;
    realmIds: string[];
    excludeSensitivities?: Sensitivity[];
  }): Map<string, number>;
  lsRealmEntriesUnified(params: {
    orgId: string;
    targetRealmId: string;
    includePhysicalLedger: boolean;
    includePhysicalSeabed: boolean;
    includeObjectLinkedOpenMode: boolean;
    includeSuperseded: boolean;
    kind?: string;
    kinds?: string[];
    tag?: string;
    since?: string;
    until?: string;
    entryIdsFilter?: string[];
    excludeSensitivities?: Sensitivity[];
    limit: number;
    offset: number;
  }): { rows: UnifiedEntryRef[]; total: number };
  lsEntriesByIdsUnified(params: {
    orgId: string;
    entryIds: string[];
    ledgerRealmIds: string[];
    seabedRealmIds: string[];
    includeSuperseded: boolean;
    kind?: string;
    kinds?: string[];
    tag?: string;
    since?: string;
    until?: string;
    excludeSensitivities?: Sensitivity[];
    limit: number;
    offset: number;
  }): { rows: UnifiedEntryRef[]; total: number };
  listAllRecords(): LedgerRecord[];

  // Objects, Entry-Object Links & Resource Tags (Migration v3)
  insertObject(obj: MindObject): void;
  getObject(id: string): MindObject | null;
  getObjectsByIds(ids: string[]): MindObject[];
  listObjects(filter: {
    orgId: string;
    realmIds?: string[];
    parentObjectId?: string | null;
    kind?: string;
  }): MindObject[];
  updateObjectParent(id: string, parentObjectId: string | null): boolean;
  countChildObjects(parentObjectId: string): number;
  deleteObject(id: string): boolean;

  insertEntryObject(link: EntryObjectLink): void;
  deleteEntryObject(entryId: string, objectId: string): boolean;
  deleteEntryObjectsByEntry(entryId: string): number;
  listObjectIdsForEntry(entryId: string, orgId?: string): string[];
  listObjectIdsByEntryIds(orgId: string, entryIds: string[]): Map<string, string[]>;
  listObjectRealmIdsForEntry(entryId: string, orgId: string): string[];
  listObjectRealmIdsByEntryIds(
    orgId: string,
    entryIds: string[],
  ): Map<string, string[]>;
  listEntryIdsForObjects(orgId: string, objectIds: string[]): string[];
  listEntryIdsByObjectRealm(orgId: string, realmId: string): string[];

  insertResourceTag(tag: ResourceTag): void;
  deleteResourceTag(entryId: string, tag: string): boolean;
  deleteResourceTagsByEntry(entryId: string): number;
  listResourceTagsForEntry(entryId: string, orgId?: string): string[];
  listResourceTagsByEntryIds(
    orgId: string,
    entryIds: string[],
  ): Map<string, string[]>;
  listEntryIdsByResourceTag(orgId: string, tag: string): string[];
  listVisibleResourceTags(params: {
    orgId: string;
    ledgerRealmIds: string[];
    seabedRealmIds: string[];
    prefix?: string;
  }): ResourceTagSummary[];

  // Redaction & Blocklist
  redactRecordRow(params: {
    id: string;
    redactedAt: string;
    redactedBy: string;
    redactedReason: string | null;
  }): boolean;
  redactSeabedRow(params: {
    id: string;
    redactedAt: string;
    redactedBy: string;
    redactedReason: string | null;
  }): boolean;
  redactChangeLogForEntry(entryId: string): number;
  findDistillationsBySourceId(sourceId: string): Distillation[];
  redactDistillationRow(params: {
    id: string;
    hardFacts: Record<string, unknown>;
  }): boolean;
  countBlobReferences(sha256: string): {
    seabedCount: number;
    driveFiles: DriveFileMeta[];
  };
  insertRedactedBlocklist(entry: RedactedBlocklistEntry): void;
  isRedactedBlocked(
    orgId: string,
    sourceRef: string,
    contentSha256: string,
  ): boolean;
  /** O(1) indexed global content-hash blocklist check across an organization regardless of source_ref */
  isContentShaBlocked(orgId: string, contentSha256: string): boolean;
  listRedactedBlocklist(orgId: string): RedactedBlocklistEntry[];
  optimizeFtsAndCheckpoint(): WalCheckpointResult;

  // Distillations (rebuildable event slices & cognitive cards)
  insertDistillation(distillation: Distillation): void;
  supersedeActiveDistillations(
    realmId: string,
    layer: DistillationLayer,
    periodKey: string,
    exceptId: string,
  ): void;
  getDistillation(id: string): Distillation | null;
  getDistillationsByIds(ids: string[]): Distillation[];
  getLatestDistillation(
    realmId: string,
    layer: DistillationLayer,
  ): Distillation | null;
  getLatestDistillationsByRealms(
    realmIds: string[],
    layer: DistillationLayer,
  ): Map<string, Distillation>;
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
  getLatestChangeLogSeq(orgId?: string): number;
  getLatestVisibleChangeLogSeq(params: {
    orgId: string;
    ledgerRealmIds: string[];
    seabedRealmIds: string[];
    includeSecret?: boolean;
  }): number;
  getChangeLogSeqForEntity(entityType: string, entityId: string): number | null;
  countChangeLogSince(params: {
    orgId: string;
    realmIds: string[];
    sinceSeq: number;
    generation: number;
    includeSecret?: boolean;
  }): number;
  appendChangeLog(
    entry: Omit<ChangeLogEntry, "seq" | "generation">,
  ): ChangeLogEntry;
  listChangeLog(params?: {
    orgId?: string;
    realmIds?: string[];
    sinceSeq?: number;
    limit?: number;
    includeSecret?: boolean;
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
    query?: string;
    ftsExpression?: string;
    realmIds: string[];
    sourceTypes?: Array<"record" | "seabed" | "distillation">;
    includeSuperseded: boolean;
    limit: number;
  }): FtsMatch[];
  countFts(params: {
    query?: string;
    ftsExpression?: string;
    realmIds: string[];
    sourceTypes?: Array<"record" | "seabed" | "distillation">;
    includeSuperseded: boolean;
  }): number;
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
  delete(sha256: string): boolean;
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
