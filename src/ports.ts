import type { WorkBindingRecord } from "./work/provider.js";
import type {
  ActorRecord,
  ActorRole,
  AuthTokenRecord,
  ChangeAssetClass,
  ChangeCommittedEvent,
  ChangeLogEntry,
  ConsumerCursor,
  DeliveryRecord,
  DeliveryState,
  DisabledActorRecord,
  Distillation,
  DistillationLayer,
  DriveFileContent,
  DriveFileMeta,
  EntryObjectLink,
  IdempotencyRecord,
  InviteRecord,
  LedgerRecord,
  MindObject,
  ObjectAlias,
  ObjectState,
  OidcIdentityRecord,
  Organization,
  OrgPolicy,
  PumpChangeFrame,
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

export interface DateWindowSpec {
  /** Inclusive UTC YYYY-MM-DD bounds (d-1..d+1) when year is specified */
  startDate?: string;
  endDate?: string;
  /** Inclusive MM-DD values (with leap-day & year rollover) when year is omitted */
  monthDays?: string[];
}

export interface UnifiedFtsSearchParams {
  ftsExpression: string;
  ledgerRealmIds: string[];
  seabedRealmIds: string[];
  includeSuperseded: boolean;
  recordKinds?: RecordKind[];
  seabedKinds?: SeabedKind[];
  since?: string;
  until?: string;
  dateWindows?: DateWindowSpec[];
  allowedEntryIds?: string[];
  perBucketLimit: number;
}

export interface UnifiedFtsSearchResult {
  rows: FtsMatch[];
  total: number;
  ledgerCount: number;
  seabedCount: number;
}

export interface DateWindowQueryParams {
  dateWindows: DateWindowSpec[];
  ledgerRealmIds: string[];
  seabedRealmIds: string[];
  includeSuperseded: boolean;
  recordKinds?: RecordKind[];
  seabedKinds?: SeabedKind[];
  since?: string;
  until?: string;
  allowedEntryIds?: string[];
  perBucketLimit: number;
}

export interface DateWindowMatch {
  itemId: string;
  sourceType: "record" | "seabed" | "distillation";
  realmId: string;
  status: string;
  occurredAt: string | null;
}

export interface DateWindowQueryResult {
  rows: DateWindowMatch[];
  total: number;
  ledgerCount: number;
  seabedCount: number;
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

export interface ChangeLogAboutFilter {
  /** Target object ID + visible `within` descendant object IDs */
  objectIds: string[];
  /** Normalized `<kind>:<name>` resource tag if valid, else null */
  resourceTag: string | null;
  /** Optional realm restriction when `--about` was realm-qualified (`/<realm>/<kind>:<name>`) */
  scopedRealmId?: string | null;
  /** Optional explicit record IDs resolved via `thing` records */
  thingEntryIds?: string[];
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
  /** Runs `fn` inside a BEGIN IMMEDIATE transaction and ALWAYS rolls back (emitting zero committed change events). */
  dryRunTransaction<T>(fn: () => T): T;
  getQueryCount(): number;
  resetQueryCount(): void;

  // Schema & Meta
  listSchemaMigrations(): SchemaMigrationRecord[];
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  getTopologyVersion(): number;
  bumpTopologyVersion(orgId?: string): number;
  vacuumInto(destPath: string): void;
  onChangeCommitted(listener: (events: ChangeCommittedEvent[]) => void): () => void;

  // Organizations & Realms
  insertOrg(org: Organization): void;
  getOrg(id: string): Organization | null;
  listOrgs(): Organization[];
  updateOrgPolicy(orgId: string, policy: OrgPolicy): boolean;

  insertRealm(realm: Realm): void;
  getRealm(id: string): Realm | null;
  getRealmByPath(orgId: string, realmPath: string): Realm | null;
  listRealms(orgId?: string): Realm[];
  updateRealmMetadata(
    id: string,
    fields: { name?: string; scope?: string | null },
  ): void;
  setRealmArchivedAt(id: string, archivedAt: string | null): void;

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
  listSeabedEntriesBatch(afterId: string, limit: number): SeabedEntry[];

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
  findActiveRecordsBySourceRefInRealms(
    orgId: string,
    sourceRef: string,
    realmIds: string[],
    options?: { excludeSecret?: boolean },
  ): LedgerRecord[];
  hasRealmSourceRefMoveOut(
    orgId: string,
    realmId: string,
    sourceRef: string,
    options?: { excludeSecret?: boolean },
  ): boolean;
  findLatestRecordsBySourceRefInRealms(
    orgId: string,
    sourceRef: string,
    realmIds: string[],
    options?: { excludeSecret?: boolean },
  ): LedgerRecord[];
  findLatestRecordByPayloadSourceIdInRealms(
    orgId: string,
    sourceId: string,
    realmIds: string[],
    options?: { excludeSecret?: boolean },
  ): LedgerRecord | null;
  findSeabedBySourceRefInRealms(
    orgId: string,
    sourceRef: string,
    realmIds: string[],
    options?: { excludeSecret?: boolean; limitPerRealm?: number },
  ): SeabedEntry[];
  listImportedSourceRefsInRealms(
    orgId: string,
    ledgerRealmIds: string[],
    seabedRealmIds: string[],
    options?: { excludeSecret?: boolean },
  ): Array<{
    sourceRef: string;
    realmId: string;
    layer: "record" | "seabed";
    entryId: string;
    status: string;
  }>;
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
  listRecordsBatch(afterId: string, limit: number): LedgerRecord[];

  // Objects, Entry-Object Links & Resource Tags (Migration v3)
  insertObject(obj: MindObject): void;
  getObject(id: string): MindObject | null;
  getObjectsByIds(ids: string[]): MindObject[];
  findObjectsByKindName(
    orgId: string,
    kind: string,
    name: string,
    realmIds?: string[],
  ): MindObject[];
  listObjects(filter: {
    orgId: string;
    realmIds?: string[];
    parentObjectId?: string | null;
    kind?: string;
  }): MindObject[];
  updateObjectParent(id: string, parentObjectId: string | null): boolean;
  updateObjectState(params: {
    id: string;
    state: ObjectState;
    stateLabel: string | null;
    stateSince: string | null;
    stateEvidenceId: string | null;
  }): boolean;
  listInactiveObjects(orgId: string, realmIds: string[]): MindObject[];
  listObjectAliases(objectIds: string[]): ObjectAlias[];
  upsertObjectAlias(alias: ObjectAlias): void;
  deleteObjectAlias(objectId: string, aliasNorm: string): boolean;
  countVisibleAliasOwners(params: {
    orgId: string;
    realmIds: string[];
    aliasNorms: string[];
  }): Map<string, number>;
  clearObjectStateEvidenceByEntry(
    entryId: string,
  ): Array<{ id: string; orgId: string; realmId: string }>;
  countVisibleLinkedEntriesForObject(params: {
    orgId: string;
    objectId: string;
    ledgerRealmIds: string[];
    seabedRealmIds: string[];
    excludeEntryId?: string | null;
  }): number;
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
  getLatestDistillationByPeriodKey(
    realmId: string,
    layer: DistillationLayer,
    periodKey: string,
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
  listDistillationsBatch(afterId: string, limit: number): Distillation[];
  listAllCanonicalIds(): Set<string>;

  // Drive file metadata index (tracks latest canonical blob sha256 per realm+path)
  upsertDriveFileMeta(meta: DriveFileMeta): void;
  getDriveFileMeta(realmId: string, relPath: string): DriveFileMeta | null;
  listDriveFilesMeta(realmIds: string[]): DriveFileMeta[];

  // Idempotency keys (org-scoped, shared across records & seabed_entries)
  getIdempotencyKey(orgId: string, key: string): IdempotencyRecord | null;
  insertIdempotencyKey(record: IdempotencyRecord): void;
  moveEntryRealm(params: {
    orgId: string;
    targetTable: "records" | "seabed_entries";
    entryId: string;
    newRealmId: string;
  }): void;
  listRecordSupersedeNeighborIds(orgId: string, recordId: string): string[];

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
  hasRecordLineageChangeLogOp(
    orgId: string,
    recordId: string,
    op: string,
    realmId?: string,
  ): boolean;
  countChangeLogSince(params: {
    orgId: string;
    realmIds: string[];
    sinceSeq: number;
    generation: number;
    includeSecret?: boolean;
  }): number;
  appendChangeLog(
    entry: Omit<ChangeLogEntry, "seq" | "generation"> & {
      assetClass?: ChangeAssetClass;
    },
  ): ChangeLogEntry;
  listChangeLog(params?: {
    orgId?: string;
    realmIds?: string[];
    sinceSeq?: number;
    sinceCreatedAt?: string;
    combineSinceWithOr?: boolean;
    order?: "asc" | "desc";
    limit?: number;
    includeSecret?: boolean;
  }): { generation: number; entries: ChangeLogEntry[] };
  listChangeLogForPump(params: {
    orgId: string;
    ledgerRealmIds: string[];
    seabedRealmIds: string[];
    driveRealmIds: string[];
    sinceSeq: number;
    limit: number;
    includeSecret?: boolean;
    filterRealmIds?: string[];
    aboutFilter?: ChangeLogAboutFilter;
  }): { generation: number; topologyVersion: number; frames: PumpChangeFrame[] };
  resetChangeLog(): { generation: number; clearedCount: number };

  // Auth Tokens (Migration v9 + v12 expires_at)
  insertToken(token: AuthTokenRecord): void;
  getToken(id: string): AuthTokenRecord | null;
  getTokenByHash(tokenHash: string): AuthTokenRecord | null;
  listTokens(orgId: string, includeRevoked?: boolean): AuthTokenRecord[];
  revokeToken(orgId: string, id: string, revokedAt: string): boolean;
  revokeTokensForActor(orgId: string, actorId: string, revokedAt: string): number;
  touchTokenLastUsed(id: string, usedAt: string): void;

  // OIDC Identities, Invitations & Actor Disable (Migration v12)
  insertIdentity(identity: OidcIdentityRecord): void;
  updateIdentityProfile(params: {
    id: string;
    email: string | null;
    displayName: string | null;
    updatedAt: string;
  }): void;
  getIdentityBySubject(
    orgId: string,
    issuer: string,
    subject: string,
  ): OidcIdentityRecord | null;
  listIdentities(orgId: string): OidcIdentityRecord[];
  listIdentitiesByActor(orgId: string, actorId: string): OidcIdentityRecord[];
  insertInvite(invite: InviteRecord): void;
  getInvite(orgId: string, id: string): InviteRecord | null;
  getInviteByHash(orgId: string, codeHash: string): InviteRecord | null;
  listInvites(orgId: string): InviteRecord[];
  consumeInviteAndBindIdentity(params: {
    orgId: string;
    codeHash: string;
    nowIso: string;
    identityId: string;
    issuer: string;
    subject: string;
    email: string | null;
    displayName: string | null;
  }): OidcIdentityRecord | null;
  revokeInvite(orgId: string, id: string, revokedAt: string): boolean;
  disableActor(params: {
    orgId: string;
    actorId: string;
    reason: string | null;
    disabledBy: string;
    disabledAt: string;
  }): {
    revokedTokens: number;
    revokedAgentTokens: number;
    revokedInvites: number;
    disabledIdentities: number;
  };
  enableActor(orgId: string, actorId: string): boolean;
  isActorDisabled(orgId: string, actorId: string): boolean;
  isActorIdClaimedInOrg(orgId: string, actorId: string): boolean;
  listDisabledActors(orgId: string): DisabledActorRecord[];

  // Actors & Org Roles (Migration v13)
  getActor(orgId: string, actorId: string): ActorRecord | null;
  upsertActor(params: {
    orgId: string;
    actorId: string;
    role: ActorRole;
    displayName?: string | null;
    createdBy?: string | null;
    nowIso?: string;
    overwriteRole?: boolean;
  }): ActorRecord;
  setActorRole(
    orgId: string,
    actorId: string,
    role: ActorRole,
    updatedAt?: string,
  ): ActorRecord;
  setActorDisplayName(
    orgId: string,
    actorId: string,
    displayName: string | null,
    updatedAt?: string,
  ): ActorRecord;
  listActors(orgId: string): ActorRecord[];
  countActiveAdmins(orgId: string): number;

  // Outbox Consumer Cursors & Deliveries (Migration v9)
  upsertConsumerCursor(cursor: ConsumerCursor): void;
  getConsumerCursor(consumer: string): ConsumerCursor | null;
  enqueueDelivery(delivery: {
    consumer: string;
    seq: number;
    dueAt: string;
    createdAt: string;
  }): boolean;
  listDueDeliveries(params: {
    consumer?: string;
    nowIso: string;
    limit: number;
  }): DeliveryRecord[];
  updateDeliveryState(params: {
    consumer: string;
    seq: number;
    state: DeliveryState;
    attempts: number;
    dueAt: string;
    lastError: string | null;
    updatedAt: string;
  }): boolean;

  // External Work Bindings (Migration v10; config_json stores env:VAR refs ONLY)
  upsertWorkBinding(binding: WorkBindingRecord): void;
  getWorkBinding(orgId: string, realmId: string): WorkBindingRecord | null;
  listWorkBindings(orgId: string): WorkBindingRecord[];
  deleteWorkBinding(orgId: string, realmId: string): boolean;

  // Rebuildable FTS5 index
  upsertFtsItem(item: {
    itemId: string;
    orgId: string;
    sourceType: "record" | "seabed" | "distillation";
    realmId: string;
    status: string;
    kind: string;
    occurredAt: string | null;
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
  searchFtsUnified(params: UnifiedFtsSearchParams): UnifiedFtsSearchResult;
  listEntriesByDateWindow(params: DateWindowQueryParams): DateWindowQueryResult;
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

  // Storage hygiene diagnostics (v0.5.5)
  getStorageBloatStats(): import("./types.js").StorageBloatStats;
}

/**
 * Immutable content-addressed blob storage for seabed attachments, evidence, and drive snapshots.
 * Enables rebuilding the local shared drive working tree from SQLite + blobs after crash/reset.
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
 * MindRealm shared file drive port (experimental).
 * Default zero-Docker adapter: LocalFsDriveAdapter (optimistic version check on local disk).
 */
export interface DrivePort {
  readonly kind: "local";
  init(): Promise<void>;
  readFile(realmId: string, relPath: string): Promise<DriveFileContent | null>;
  listFiles(realmId: string): Promise<DriveFileMeta[]>;
  /**
   * Optimistic concurrent write:
   * - If expectedVersion is provided and does not match the current version,
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
