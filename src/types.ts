export type MindErrorCode =
  | "ACCESS_DENIED"
  | "RULE_REQUIRES_HUMAN"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_MISMATCH"
  | "VERDICT_INVARIANT"
  | "FORBIDDEN_HOME_PATH"
  | "SLICE_VIOLATION"
  | "DRIVE_ERROR"
  | "UNKNOWN_COMMAND"
  | "UNKNOWN_FLAG"
  | "INVALID_REF"
  | "AMBIGUOUS_REF"
  | "NOT_LISTABLE"
  | "NOT_BOUND";

export type WireErrorCode =
  | "unknown_command"
  | "unknown_flag"
  | "invalid_ref"
  | "not_found"
  | "ambiguous_ref"
  | "not_listable"
  | "not_bound"
  | "forbidden"
  | "conflict"
  | "idempotency_mismatch"
  | "invalid_input";

export interface SurfaceErrorPayload {
  error: WireErrorCode;
  message: string;
  candidates?: string[];
  try?: string;
}

export class MindError extends Error {
  readonly code: MindErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: MindErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MindError";
    this.code = code;
    this.details = details;
  }
}

export type ActorKind = "human" | "agent" | "system";

export type ActorRole = "admin" | "member";

export interface Actor {
  id: string;
  kind: ActorKind;
  /** Model family for agents (e.g., "claude", "gemini", "deepseek", "openai") */
  family?: string;
  /** Organization role ("admin" | "member") */
  role?: ActorRole;
  /** Optional user-editable display name (does not change actorId) */
  displayName?: string | null;
}

export interface ActorRecord {
  orgId: string;
  actorId: string;
  role: ActorRole;
  displayName: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OrgPolicy = "open" | "tree";

export type Sensitivity = "public" | "internal" | "confidential" | "secret";

export interface Organization {
  id: string;
  name: string;
  isPersonalRoot: boolean;
  policy: OrgPolicy;
  createdAt: string;
}

export interface Realm {
  id: string;
  orgId: string;
  parentId: string | null;
  slug: string;
  /** Hierarchical slash path, e.g. "/" or "/engineering/backend" */
  path: string;
  name: string;
  /** Optional single-line ownership boundary (what belongs here and what does not) */
  scope?: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface RealmArchiveResult {
  realm: Realm;
  alreadyArchived: boolean;
  effectivelyArchived: boolean;
}

export interface RealmUnarchiveResult {
  realm: Realm;
  alreadyActive: boolean;
  effectivelyArchived: boolean;
  archivedAncestorPath?: string | null;
}

export interface MovedEntryItem {
  id: string;
  entityType: "record" | "seabed";
  fromRealmId: string;
  fromRealmPath: string;
  toRealmId: string;
  toRealmPath: string;
  chainExpanded?: boolean;
}

export interface MoveEntriesResult {
  targetRealmId: string;
  targetRealmPath: string;
  dryRun: boolean;
  moved: MovedEntryItem[];
  skippedAlreadyInTargetIds: string[];
}

export type MountScope = "all" | "ledger" | "drive";

export interface RealmMount {
  id: string;
  viewerRealmId: string;
  targetRealmId: string;
  scope: MountScope;
  mountedBy: string;
  createdAt: string;
}

export type AssetKind = "rule" | "ledger" | "drive" | "seabed";
export type AccessLevel = "none" | "read" | "write";
export type TokenWriteScope = "self" | "subtree";
export type WriteCategory = "content" | "admin";

export interface VisibleScope {
  orgId: string;
  viewerRealmId: string;
  ancestorIds: string[];
  descendantIds: string[];
  mountedLedgerIds: string[];
  mountedDriveIds: string[];
  mountedSeabedIds: string[];
  /** All realms whose ledger/rules/cards are readable from viewer */
  readableLedgerIds: string[];
  /** All realms whose drive files are readable from viewer */
  readableDriveIds: string[];
  /** Realms whose seabed entries are readable (descendants included only when explicit) */
  readableSeabedIds: string[];
}

export interface AccessScope extends VisibleScope {
  policy: OrgPolicy;
  /** Tree-scoped focus realms (viewer + ancestors + descendants + mounts) used for open-mode focus boost */
  focusRealmIds: string[];
}

export type SeabedKind = "message" | "artifact" | "evidence" | "signal";

export interface SeabedEntry {
  id: string;
  orgId: string;
  realmId: string;
  topicId: string | null;
  kind: SeabedKind;
  authorId: string;
  authorKind: ActorKind;
  authorFamily: string | null;
  text: string;
  blobSha256: string | null;
  sourceRef: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string | null;
  originSessionId: string | null;
  sensitivity: Sensitivity;
  redactedAt: string | null;
  redactedBy: string | null;
  redactedReason: string | null;
  createdAt: string;
}

export type RecordKind =
  | "thing"
  | "claim"
  | "proposal"
  | "verdict"
  | "finding"
  | "decision"
  | "rule";

export type RecordStatus = "active" | "superseded" | "retracted";

export type BehaviorClass = "rule" | "conclusion" | "raw";

export type ObjectState = "active" | "inactive";

export interface MindObject {
  id: string;
  orgId: string;
  parentObjectId: string | null;
  realmId: string;
  kind: string;
  name: string;
  createdAt: string;
  /** Omitted when active (byte-identical JSON when 0 inactive objects exist) */
  state?: ObjectState;
  stateLabel?: string | null;
  stateSince?: string | null;
  stateEvidenceId?: string | null;
}

export interface ObjectAlias {
  orgId: string;
  objectId: string;
  alias: string;
  aliasNorm: string;
  /** True when seeded from objects.name (cannot be deleted via --remove) */
  isName: boolean;
  /** True when explicitly added via object alias --add (also true when single-token name is opted in) */
  isExplicit: boolean;
}

export interface ObjectStateSetResult {
  object: MindObject;
  affected: {
    linked: number;
    mentions: number;
    mentionsApproximate?: boolean;
  };
  aliasHits: Record<string, number>;
}

export interface ObjectAliasUpdateResult {
  object: MindObject;
  aliases: string[];
  added: string[];
  removed: string[];
}

export interface ObjectCreateDrift {
  parentObjectId?: {
    existing: string | null;
    requested: string | null;
  };
}

export interface CreateObjectResult {
  object: MindObject;
  created: boolean;
  drift?: ObjectCreateDrift;
}

export interface EntryObjectLink {
  entryId: string;
  orgId: string;
  objectId: string;
}

export interface ResourceTag {
  entryId: string;
  orgId: string;
  tag: string;
}

export interface ResourceTagSummary {
  tag: string;
  count: number;
}

export interface LedgerRecord {
  id: string;
  orgId: string;
  realmId: string;
  thingId: string | null;
  kind: RecordKind;
  extKind: string | null;
  status: RecordStatus;
  supersedesId: string | null;
  supersedesIds: string[];
  supersededById: string | null;
  authorId: string;
  authorKind: ActorKind;
  authorFamily: string | null;
  confirmedByHuman: boolean;
  title: string;
  payload: Record<string, unknown>;
  refs: string[];
  externalRef: string | null;
  sourceRef: string | null;
  occurredAt: string | null;
  originSessionId: string | null;
  sensitivity: Sensitivity;
  redactedAt: string | null;
  redactedBy: string | null;
  redactedReason: string | null;
  createdAt: string;
}

export type DistillationLayer =
  | "slice_shift"
  | "slice_day"
  | "slice_week"
  | "slice_month"
  | "card_realm"
  | "card_person"
  | "card_progress"
  | "card_object";

export interface Distillation {
  id: string;
  realmId: string;
  layer: DistillationLayer;
  periodKey: string;
  status: "active" | "superseded" | "retracted";
  /** Deterministic facts computed exclusively by system code */
  hardFacts: Record<string, unknown>;
  /** Narrative markdown with cited [id] references */
  narrativeMd: string;
  sourceIds: string[];
  createdAt: string;
}

export interface DriveFileMeta {
  realmId: string;
  relPath: string;
  sha256: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface DriveFileContent extends DriveFileMeta {
  content: string;
}

export interface LedgerRecordSummary {
  id: string;
  realmId: string;
  kind: RecordKind;
  status: RecordStatus;
  title: string;
  occurredAt: string | null;
  createdAt: string;
  authorId: string;
  authorKind: ActorKind;
  sensitivity: Sensitivity;
  supersedesId: string | null;
  supersedesIds: string[];
  supersededById: string | null;
}

export interface SupersedeChainResult {
  nodes: LedgerRecord[];
  currentHeadId: string | null;
  orphanSuperseded: boolean;
}

export interface ShowSupersedeChainResult {
  nodes: LedgerRecordSummary[];
  currentHeadId: string | null;
  orphanSuperseded: boolean;
}

export interface ShowWindow {
  start: number;
  end: number;
  total: number;
  shownChars: number;
  truncated: boolean;
  nextCursor: string | null;
  around?: string;
  aroundMatched?: boolean;
}

export interface BriefBudget {
  recentMessages?: number;
  maxQuestions?: number;
  maxActiveThings?: number;
  maxDecisions?: number;
  maxRecentConclusions?: number;
  maxRules?: number;
  maxChildSummaries?: number;
}

export interface BriefSection<T> {
  items: T[];
  totalCount: number;
  omittedCount: number;
}

export interface ChildRealmSummary {
  realmId: string;
  realmPath: string;
  realmName: string;
  activeRules: number;
  activeConclusions: number;
  activeObjects: number;
  activeThings: number;
  pendingQuestions: number;
  activeDecisions: number;
  latestCardSummary: string | null;
}

export interface BriefOutput {
  realm: Realm;
  realmArchived?: boolean;
  generatedAt: string;
  kindHistogram: Record<string, number>;
  buckets?: {
    rules: number;
    conclusions: number;
    raw: number;
  };
  recentConclusions: BriefSection<LedgerRecord>;
  omittedChildRealmsCount: number;
  surface: {
    recentMessages: BriefSection<SeabedEntry>;
  };
  upperLedger: {
    pendingQuestions: BriefSection<LedgerRecord>;
    activeThings: BriefSection<LedgerRecord>;
    activeDecisions: BriefSection<LedgerRecord>;
    /** Count of active decisions in visible ancestor realms (folded out of default L1; only rules bind downward) */
    inheritedDecisionsCount?: number;
    /** Recent findings in the target realm (L1 clean signal, excluding bulk claims) */
    recentFindings?: BriefSection<LedgerRecord>;
  };
  middleMind: {
    realmCard: Distillation | null;
    realmCardMeta?: {
      cardSeq: number | null;
      changesSinceCard: number;
      currentSeq: number;
      generation: number;
    };
    rules: BriefSection<{
      id: string;
      realmId: string;
      inherited: boolean;
      title: string;
      scopedObjectRefs?: string[];
    }>;
    realmRules?: Array<{
      id: string;
      realmId: string;
      realmPath: string;
      inherited: boolean;
      title: string;
    }>;
    scopedObjectRules?: Array<{
      id: string;
      realmId: string;
      realmPath: string;
      inherited: boolean;
      title: string;
      objectRefs: string[];
    }>;
    ancestorSummaries: Array<{
      realmId: string;
      realmPath: string;
      summary: string;
    }>;
    childSummaries: BriefSection<ChildRealmSummary>;
  };
  drilldownHint: string;
}

export interface RecallQuery {
  viewerRealmId: string;
  actor: Actor;
  /** Stage 1: Direct lookup by ID or thingId */
  id?: string;
  thingId?: string;
  /** Stage 2: Structured filters */
  targetRealmId?: string;
  /** Optional narrowed realm IDs (e.g. search --in subtree intersected with scope) */
  realmIdsFilter?: string[];
  /** Optional narrowed entry IDs (e.g. search --about unified object) */
  allowedEntryIds?: string[];
  recordKinds?: RecordKind[];
  seabedKinds?: SeabedKind[];
  authorId?: string;
  since?: string;
  until?: string;
  includeSuperseded?: boolean;
  /** Alias for includeSuperseded */
  includeHistory?: boolean;
  /** Parent diving explicitly into descendant raw seabed */
  includeDescendantSeabed?: boolean;
  /** Optional process-level ceiling scope (e.g. MCP bound viewer intersection) */
  scopeCeiling?: AccessScope;
  /** Optional opt-in intra-band focus tie-breaker (default: false) */
  focusBoost?: boolean;
  /** Stage 3 & 4: Keyword (FTS5) + Semantic (sqlite-vec) query */
  query?: string;
  limit?: number;
  offset?: number;
}

export type RecallItemStatus = "active" | "superseded" | "retracted" | "evidence";

export interface RecallItem {
  id: string;
  behaviorClass?: BehaviorClass;
  /** @deprecated Will be removed in v0.3.0; prefer behaviorClass */
  sourceType: "record" | "seabed" | "distillation";
  kind: string;
  extKind?: string | null;
  realmId: string;
  realmPath?: string;
  status: RecallItemStatus;
  title: string;
  snippet: string;
  contentChars: number;
  shownChars: number;
  truncated: boolean;
  authorId: string;
  createdAt: string;
  occurredAt: string | null;
  sourceRefs: string[];
  supersedesId?: string | null;
  supersedesIds?: string[];
  supersededById?: string | null;
  /** When item is superseded, 1-hop pointer to the visible active chain head (null if retracted, invisible, or orphan) */
  currentHeadId?: string | null;
  /** True when status === "superseded" and supersededById === null (orphan superseded record) */
  orphanSuperseded?: boolean;
  matchedBy: Array<"id" | "filter" | "fts" | "vector">;
  score: number;
  inactive?: string[];
  /** True when the entry's realm (or an ancestor realm) is archived; omitted when active */
  realmArchived?: boolean;
}

export interface RecallResult {
  viewerRealmId: string;
  items: RecallItem[];
  totalMatched: number;
  omittedCount: number;
  vectorUsed: boolean;
  interpretedDates?: string[];
  message: string;
}

export interface SliceExportResult {
  realmId: string;
  outDir: string;
  exportedAt: string;
  fileCount: number;
  /** relPath -> sha256 manifest for post-run tamper verification */
  manifest: Record<string, string>;
}

export interface SliceVerificationResult {
  intact: boolean;
  modifiedPaths: string[];
  deletedPaths: string[];
  addedPaths: string[];
  findingId?: string;
}

export interface RebuildResult {
  ftsIndexed: number;
  vectorsIndexed: number;
  vectorsPending: number;
  driveFilesRestored: number;
  distillationsVerified: number;
  distillationMismatches: string[];
}

export interface SchemaMigrationRecord {
  version: number;
  name: string;
  appliedAt: string;
}

export interface IdempotencyRecord {
  orgId: string;
  key: string;
  targetTable: "records" | "seabed_entries";
  targetId: string;
  realmId: string;
  payloadHash: string;
  createdAt: string;
}

export type ChangeAssetClass = "rule" | "ledger" | "seabed" | "drive" | "org";

export interface ChangeLogEntry {
  seq: number;
  generation: number;
  orgId: string;
  realmId: string;
  entityType: string;
  entityId: string;
  op: string;
  assetClass?: ChangeAssetClass;
  actorId: string;
  createdAt: string;
}

export type AuthKind = "local" | "bearer" | "cookie";

export interface AuthTokenRecord {
  id: string;
  orgId: string;
  tokenHash: string;
  actorId: string;
  actorKind: "human" | "agent";
  actorFamily: string | null;
  boundRealmId: string | null;
  writeScope?: TokenWriteScope;
  label: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface AuthTokenPublic {
  id: string;
  orgId: string;
  actorId: string;
  actorKind: "human" | "agent";
  actorFamily: string | null;
  boundRealmId: string | null;
  writeScope: TokenWriteScope;
  label: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface OidcIdentityRecord {
  id: string;
  orgId: string;
  issuer: string;
  subject: string;
  actorId: string;
  actorKind: "human" | "agent";
  boundRealmId: string | null;
  email: string | null;
  displayName: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InviteRecord {
  id: string;
  orgId: string;
  codeHash: string;
  actorId: string;
  actorKind: "human" | "agent";
  actorRole?: ActorRole;
  boundRealmId: string | null;
  createdBy: string;
  expiresAt: string;
  usedAt: string | null;
  usedByIssuer: string | null;
  usedBySubject: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface InvitePublic {
  id: string;
  orgId: string;
  actorId: string;
  actorKind: "human" | "agent";
  actorRole?: ActorRole;
  boundRealmId: string | null;
  createdBy: string;
  expiresAt: string;
  usedAt: string | null;
  usedByIssuer: string | null;
  usedBySubject: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface DisabledActorRecord {
  orgId: string;
  actorId: string;
  reason: string | null;
  disabledBy: string;
  disabledAt: string;
}

export interface OidcConfig {
  /** Standard OIDC Issuer URL (e.g. https://id.example.com) */
  issuer: string;
  /** OIDC Client ID */
  clientId: string;
  /** Optional OIDC Client Secret (confidential clients); omit for public PKCE clients */
  clientSecret?: string | null;
  /** Optional public external base URL for redirect_uri (e.g. https://mind.example.com) */
  publicUrl?: string | null;
  /**
   * When true, users authenticated by this dedicated IdP can auto-provision on first login
   * without an invite code (still strictly keyed by (iss, sub) and rejecting actorId collisions).
   * Defaults to false (invite-only).
   */
  trustIssuer?: boolean;
  /** Default TTL in days for tokens minted via OIDC device-code login (default: 90) */
  tokenTtlDays?: number;
}

export interface Principal {
  tokenId: string | null;
  orgId: string;
  actor: Actor;
  boundRealmId: string;
  boundSource: string;
  authKind: AuthKind;
  writeScope?: TokenWriteScope;
}

export interface ConsumerCursor {
  consumer: string;
  generation: number;
  seq: number;
  updatedAt: string;
}

export type DeliveryState =
  | "pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "dead";

export interface DeliveryRecord {
  consumer: string;
  seq: number;
  state: DeliveryState;
  attempts: number;
  dueAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PumpChangeFrame {
  seq: number;
  generation: number;
  realmId: string;
  entityType: string;
  entityId: string;
  op: string;
  assetClass: ChangeAssetClass;
  actorId: string;
  createdAt: string;
}

export interface ChangeCommittedEvent {
  orgId: string;
  realmId: string;
  seq?: number;
}

export interface SyncEmbeddingsResult {
  processed: number;
  indexed: number;
  skipped: number;
  failed: number;
  remaining: number;
}

export interface WalCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

export interface RedactedBlocklistEntry {
  orgId: string;
  sourceRef: string;
  contentSha256: string;
  reason: string | null;
  redactedAt: string;
}

export interface RedactResult {
  entryId: string;
  entityType: "record" | "seabed";
  orgId: string;
  realmId: string;
  redactedAt: string;
  redactedBy: string;
  reason: string | null;
  retractedDistillationIds: string[];
  clearedObjectIds: string[];
  deletedBlobSha256: string | null;
  blocklistRecorded: boolean;
  walCheckpoint: WalCheckpointResult;
  residualLocations: string[];
}

export interface ObjectTreeNode {
  object: MindObject;
  children: ObjectTreeNode[];
}

export interface RealmTreeCounts {
  directRules: number;
  directConclusions: number;
  directRaw: number | null;
  directObjects: number;
  subtreeRules: number | null;
  subtreeConclusions: number | null;
  subtreeRaw: number | null;
  subtreeObjects: number | null;
  linkedViaObjects: number | null;
  childRealmsCount: number;
}

export interface RealmTreeNode {
  realm: Realm;
  counts: RealmTreeCounts;
  objects: ObjectTreeNode[];
  children: RealmTreeNode[];
  effectivelyArchived?: boolean;
}

export interface TreeResult {
  org: Organization;
  viewerRealmId: string;
  targetRealmId: string;
  depth: number | "all";
  includeObjects: boolean;
  lineLimit: number;
  realms: Realm[];
  objects: MindObject[];
  realmTree: RealmTreeNode[];
  objectTree: ObjectTreeNode[];
  hiddenArchivedCount?: number;
}

export type LsTargetType = "realm" | "object" | "thing" | "resource";

export interface EntryLinkedObjectRef {
  id: string;
  ref: string;
  kind: string;
  name: string;
  realmPath: string;
}

export interface LsEntry {
  id: string;
  behaviorClass: BehaviorClass;
  /** @deprecated Will be removed in v0.3.0; prefer behaviorClass */
  sourceType: "record" | "seabed";
  kind: string;
  extKind: string | null;
  realmId: string;
  realmPath: string;
  status: string;
  title: string;
  snippet: string;
  authorId: string;
  confirmedByHuman: boolean;
  occurredAt: string | null;
  createdAt: string;
  externalRef: string | null;
  sourceRef: string | null;
  refs: string[];
  supersedesId: string | null;
  supersedesIds?: string[];
  supersededById: string | null;
  objectIds: string[];
  objectRefs?: EntryLinkedObjectRef[];
  resourceTags: string[];
  inactive?: string[];
}

export type LsOnlyFilter = "realms" | "objects" | "entries" | "files";

export interface LsObjectSummary {
  id: string;
  ref: string;
  kind: string;
  name: string;
  realmId: string;
  realmPath: string;
  parentObjectId: string | null;
  state?: ObjectState;
  stateLabel?: string | null;
  stateSince?: string | null;
}

export interface LsDriveFileItem extends DriveFileMeta {
  ref: string;
  realmPath: string;
}

export interface LsResult {
  targetType: LsTargetType;
  target: string;
  resolvedId: string;
  viewerRealmId: string;
  realmArchived?: boolean;
  only?: LsOnlyFilter;
  items: LsEntry[];
  totalMatched: number;
  omittedCount: number;
  nextCursor?: string | null;
  subRealms?: Array<{ id: string; path: string; name: string; slug: string }>;
  objects?: LsObjectSummary[];
  driveFiles?: LsDriveFileItem[];
}

export type WriteRouteSource =
  | "explicit"
  | "bound"
  | "workspace_marker"
  | "about"
  | "inbox";

export interface WhoamiResult {
  org: {
    id: string;
    name: string;
    policy: OrgPolicy;
  };
  actor: Actor;
  bound: {
    realmId: string;
    realmPath: string;
    realmName: string;
    source: string;
  };
  read: {
    policy: OrgPolicy;
    ledgerRealms: number;
    driveRealms: number;
    seabedRealms: number;
  };
  write: {
    scope?: TokenWriteScope;
    allowed: string;
    canWriteRules: boolean;
    canRedact: boolean;
  };
  store: {
    path: string;
    localOnly: boolean;
  };
  corpus: {
    realms: number;
    objects: number;
    rules: number;
    conclusions: number;
    raw: number;
    files: number;
  };
  latestSeq: number;
  version: string;
  schemaVersion: number;
  inbox?: {
    realmId: string;
    path: string;
    activeEntries: number;
  };
  next: string;
}

export type ScopedRuleSource = "realm" | "object" | "with";

export interface ObjectBriefRule {
  id: string;
  realmId: string;
  realmPath: string;
  title: string;
  body: string;
  scopeSource: ScopedRuleSource;
  sourceRef: string;
  occurredAt: string | null;
  createdAt: string;
}

export interface ObjectBriefEntrySummary {
  id: string;
  kind: RecordKind;
  title: string;
  snippet: string;
  realmId: string;
  realmPath: string;
  authorId: string;
  occurredAt: string | null;
  createdAt: string;
  status: RecordStatus;
}

export interface ObjectBriefSection<T> {
  items: T[];
  totalCount: number;
}

export interface ObjectBriefChild {
  id: string;
  ref: string;
  kind: string;
  name: string;
  realmId: string;
  realmPath: string;
  state?: ObjectState;
  stateLabel?: string | null;
}

export interface ObjectBriefCoOccurring {
  id: string;
  ref: string;
  kind: string;
  name: string;
  realmPath: string;
  sharedCount: number;
  ruleCount: number;
  tryCommand: string;
}

export type CardFreshnessStatus = "fresh" | "soft_stale" | "hard_stale";

export interface CardStaleReason {
  kind:
    | "missing_basis"
    | "decision_superseded"
    | "decision_removed"
    | "decision_added"
    | "rule_added"
    | "rule_removed";
  entryId?: string;
  replacedById?: string | null;
  count?: number;
  message: string;
}

export interface ObjectCardFreshness {
  status: CardFreshnessStatus;
  reasons: CardStaleReason[];
  /** Concise single-line summary when soft_stale or hard_stale; null when fresh */
  summaryLine: string | null;
  addedDecisionIds: string[];
  removedDecisionIds: string[];
  addedRuleIds: string[];
  removedRuleIds: string[];
}

export interface ObjectCardNarrative {
  id: string;
  realmId: string;
  periodKey: string;
  createdAt: string;
  settledBy: string | null;
  sourceIds: string[];
  freshness: ObjectCardFreshness;
  /** Raw narrative markdown when fresh/soft_stale; strictly null on hard_stale */
  narrativeMd: string | null;
  /** Heading-demoted, blockquoted narrative markdown safe for agent rendering; null on hard_stale */
  safeNarrativeMd: string | null;
  /**
   * Populated ONLY when a human caller explicitly opts into historic stale preview
   * (`include_stale_narrative=1` in Studio UI); NEVER populated for agents or CLI/MCP output.
   */
  historicNarrativeMd?: string | null;
}

export interface ObjectCard {
  ref: string;
  kind: string;
  name: string;
  object: MindObject | null;
  parentRef?: string | null;
  aliases?: string[];
  realmPath: string | null;
  withRefs?: string[];
  counts: {
    total: number;
    viaObject: number;
    viaTag: number;
    viaThing: number;
  };
  rules: ObjectBriefRule[];
  pendingDecisions: ObjectBriefSection<ObjectBriefEntrySummary>;
  activeDecisions: ObjectBriefSection<ObjectBriefEntrySummary>;
  recentFindings: ObjectBriefSection<ObjectBriefEntrySummary>;
  children: ObjectBriefChild[];
  coOccurring: ObjectBriefCoOccurring[];
  narrativeCard?: ObjectCardNarrative;
  cardFreshness?: ObjectCardFreshness;
  latestSeq: number;
  recentEntries: LsEntry[];
  try: string;
}

export type PulseMode = "observing" | "working";
export type PulseSource = "observed" | "hook" | "host" | "declared";
export type PulseEventKind = "turn_start" | "heartbeat" | "turn_end" | "session_end";
export type PulseSessionState = "working" | "turn_ended" | "silent" | "active" | "quiet";

export interface ActivePeerSummary {
  sessionId: string;
  /** Optional sanitized explicit session tag for host routing (e.g. orchestrator peer routing), never contains tokens */
  sessionTag?: string | null;
  /** Same-principal parent external sessionId, if spawned as a sub-session */
  parentSessionId?: string | null;
  /** Root session ID of the collaborator tree (same root = collaborator, distinct root = potential collision) */
  rootSessionId?: string;
  actorId: string;
  actorKind: "human" | "agent" | "system";
  /** Self-reported client label (e.g. "claude-code", "codex"); never used for auth or identity */
  clientHint: string | null;
  realmPath: string;
  focus: string[];
  /** Deterministic normalized work/target keys (`work:linear:ENG-42`, `service:auth`, `branch:repo@fix/x`, `file:a.ts`) */
  keys?: string[];
  /** Keys matched against the caller's query/handshake */
  matchedKeys?: string[];
  note: string | null;
  /** Server-observed latest safe action in this realm (e.g. `wrote decision: "..."`, `inspecting service:auth`) */
  activity?: string | null;
  mode?: PulseMode;
  state?: PulseSessionState;
  source?: PulseSource;
  lastSeenAt: string;
  ageSeconds: number;
  heartbeat: boolean;
  online: boolean;
}

export type ShowResult =
  | {
      refType: "realm";
      ref: string;
      brief: BriefOutput;
      activePeers?: ActivePeerSummary[];
    }
  | {
      refType: "object";
      ref: string;
      card: ObjectCard;
      activePeers?: ActivePeerSummary[];
    }
  | {
      refType: "entry";
      ref: string;
      entry: CatResult;
      content: string;
      window: ShowWindow;
      history?: ShowSupersedeChainResult;
      context?: ShowContextResult;
      inactive?: string[];
    }
  | {
      refType: "file";
      ref: string;
      realmPath: string;
      file: DriveFileContent;
      window: ShowWindow;
    };

export interface SearchResult extends RecallResult {
  query: string;
  in?: string;
  about?: string;
  nextCursor: string | null;
}

export type CatResult =
  | {
      kind: "record";
      behaviorClass: "rule" | "conclusion";
      record: LedgerRecord;
      realmPath: string;
      objectIds: string[];
      objectRefs?: EntryLinkedObjectRef[];
      resourceTags: string[];
      currentHeadId: string | null;
      orphanSuperseded: boolean;
    }
  | {
      kind: "seabed";
      behaviorClass: "raw";
      seabed: SeabedEntry;
      realmPath: string;
      objectIds: string[];
      objectRefs?: EntryLinkedObjectRef[];
      resourceTags: string[];
    }
  | {
      kind: "distillation";
      behaviorClass: "conclusion";
      distillation: Distillation;
      realmPath: string;
      freshness?: ObjectCardFreshness;
    }
  | {
      kind: "drive";
      behaviorClass: "raw";
      file: DriveFileContent;
      realmPath: string;
    };

export interface ReplayResult {
  anchorId: string;
  anchorBehaviorClass: BehaviorClass;
  anchorRealmId: string;
  anchorOccurredAt: string | null;
  timeBasis: "occurred_at" | "created_at";
  window: number;
  supersedeChain: LedgerRecord[];
  before: LsEntry[];
  anchor: LsEntry;
  after: LsEntry[];
}

export interface ShowContextResult {
  anchorId: string;
  anchorBehaviorClass: BehaviorClass;
  anchorRealmId: string;
  anchorOccurredAt: string | null;
  timeBasis: "occurred_at" | "created_at";
  window: number;
  supersedeChain: LedgerRecordSummary[];
  before: LsEntry[];
  anchor: LsEntry;
  after: LsEntry[];
}

export interface ChangesResult {
  generation: number;
  sinceSeq: number;
  latestSeq: number;
  topologyVersion?: number;
  resetRequired?: boolean;
  entries: ChangeLogEntry[];
}

export interface ImportMdItemResult {
  filePath: string;
  sourceRef: string;
  contentSha256: string;
  action:
    | "created"
    | "superseded"
    | "skipped_unchanged"
    | "skipped_redacted"
    | "skipped_secret";
  recordId: string | null;
  supersedesId: string | null;
  realmId: string;
  occurredAt: string | null;
}

export interface ImportMdResult {
  totalFiles: number;
  created: number;
  superseded: number;
  skippedUnchanged: number;
  skippedRedacted: number;
  skippedSecret: number;
  undatedCount: number;
  defaultRealmCount: number;
  items: ImportMdItemResult[];
  embeddingsSynced?: SyncEmbeddingsResult;
}

export interface ImportMappingConfig {
  /** Destination table: "record" (default) or "seabed" */
  target?: "record" | "seabed";
  /** Dot-path for source item ID */
  id?: string;
  /** Dot-path for kind + optional lookup map + default */
  kind?: string;
  kindMap?: Record<string, string>;
  defaultKind?: string;
  /** Dot-path for extKind */
  extKind?: string;
  /** Dot-path(s) for title */
  title?: string | string[];
  /** Dot-path(s) for body/text */
  body?: string | string[];
  /** Dot-path(s) or frontmatter field names for occurredAt timestamp */
  occurredAt?: string | string[];
  /** Optional explicit opt-in regex pattern (with 1st capture group) to extract a declared date from filenames */
  filenameDatePattern?: string;
  /** Dot-path or frontmatter field for lifecycle status + map strictly targeting "active" | "superseded" */
  status?: string;
  statusMap?: Record<string, string>;
  /** Dot-path(s) or frontmatter field for expiry ISO timestamp; values < now become initialStatus="superseded" */
  validUntil?: string | string[];
  /** Dot-path for realm path or key + optional lookup map + default */
  realmPath?: string;
  realmMap?: Record<string, string>;
  defaultRealm?: string;
  /** Dot-path for object references + optional lookup map */
  objectRefs?: string;
  objectMap?: Record<string, string>;
  /** Dot-path for resource tags + optional default tag type prefix */
  resourceTags?: string;
  defaultTagType?: string;
  /** Dot-path for thing reference (source ID, record ID, or external_ref) */
  thingRef?: string;
  /** Dot-path for external_ref on thing records */
  externalRef?: string;
  /** Dot-path for supersedes reference (supports scalar string or string[]) */
  supersedes?: string;
  /** Dot-path for refs array */
  refs?: string;
  /** Dot-path for sensitivity + default + skipSecret (default: true) */
  sensitivity?: string;
  defaultSensitivity?: Sensitivity;
  skipSecret?: boolean;
  /** Dot-path for sourceRef */
  sourceRef?: string;
  /** Optional allowlist of dot-paths to extract into payload */
  extractFields?: string[];
  /** Optional idempotency key prefix (default: "import-jsonl") */
  idempotencyPrefix?: string;
}

/** Backward-compatible alias for unified ImportMappingConfig */
export type JsonlMappingConfig = ImportMappingConfig;

export interface ImportJsonlResult {
  totalRows: number;
  imported: number;
  superseded: number;
  skippedSecret: number;
  skippedRedacted: number;
  treeDegradedCrossRealmSupersedes: number;
  undatedCount: number;
  defaultRealmCount: number;
  idMap: Record<string, string>;
  entryIds: string[];
  embeddingsSynced?: SyncEmbeddingsResult;
}

export type ImportTargetLayer = "record" | "seabed";

export interface ImportBatchItemInput {
  target: ImportTargetLayer;
  sourceRef: string;
  realmRef?: string;
  kind?: string;
  extKind?: string | null;
  title?: string;
  summary?: string;
  body?: string;
  text?: string;
  rawContentSha256?: string;
  contentSha256: string;
  frontmatter?: Record<string, unknown>;
  extraPayload?: Record<string, unknown>;
  externalRef?: string | null;
  sourceId?: string | null;
  thingRef?: string | null;
  objectRefs?: string[];
  resourceTags?: string[];
  refs?: string[];
  supersedesSourceRefs?: string[];
  supersedesIds?: string[];
  initialStatus?: "active" | "superseded";
  occurredAt?: string | null;
  sensitivity?: Sensitivity;
  filePath?: string;
  idempotencyPrefix?: string;
}

export interface ImportBatchInput {
  items: ImportBatchItemInput[];
  defaultRealmRef?: string;
  skipSecret?: boolean;
  dryRun?: boolean;
  relocate?: boolean;
}

export type ImportBatchItemAction =
  | "created"
  | "superseded"
  | "relocated"
  | "skipped_unchanged"
  | "skipped_redacted"
  | "skipped_secret";

export interface ImportBatchItemResult {
  index: number;
  sourceRef: string;
  target: ImportTargetLayer;
  contentSha256: string;
  action: ImportBatchItemAction;
  entryId: string | null;
  supersedesId: string | null;
  realmId: string;
  realmPath: string;
  occurredAt: string | null;
  filePath?: string;
  sourceId?: string | null;
}

export interface ImportBatchRealmProjection {
  realmId: string;
  realmPath: string;
  isLeaf: boolean;
  existingDirectCount: number;
  projectedDelta: number;
  projectedDirectCount: number;
  doctorThreshold: number;
  exceedsDoctorThreshold: boolean;
}

export interface ImportBatchResult {
  dryRun: boolean;
  totalItems: number;
  created: number;
  superseded: number;
  relocated: number;
  skippedUnchanged: number;
  skippedRedacted: number;
  skippedSecret: number;
  treeDegradedCrossRealmSupersedes: number;
  undatedCount: number;
  defaultRealmCount: number;
  items: ImportBatchItemResult[];
  realmProjections?: ImportBatchRealmProjection[];
}

export interface VerifyImportManifestItem {
  sourceRef: string;
  target: ImportTargetLayer;
  expectedRealmRef: string;
  contentSha256: string;
  rawContentSha256?: string;
  byteLength: number;
  expectedTitle?: string;
  expectedStatus: "active" | "superseded";
  expectedOccurredAt: string | null;
  secretSkipped?: boolean;
  filePath?: string;
}

export interface VerifyImportExpectedKey {
  realmRef: string;
  target: ImportTargetLayer;
  sourceRef: string;
}

export interface VerifyImportInput {
  items: VerifyImportManifestItem[];
  target?: ImportTargetLayer;
  checkUnexpectedInRealmRefs?: string[];
  allExpectedSourceRefs?: string[];
  allExpectedEntries?: VerifyImportExpectedKey[];
  allowSkips?: number;
  totalSourceFiles?: number;
  excludedCount?: number;
  unaccountedPaths?: string[];
}

export interface VerifyImportUnexpectedEntry {
  sourceRef: string;
  entryId: string;
  realmPath: string;
  layer: ImportTargetLayer;
}

export interface ImportConsistencyMismatch {
  sourceRef: string;
  recordId: string | null;
  expected: string | null;
  actual: string | null;
  reason: string;
}

export interface VerifyImportResult {
  passed: boolean;
  totalSourceFiles: number;
  expectedCount: number;
  excludedCount: number;
  unaccountedCount: number;
  unaccountedPaths: string[];
  foundCount: number;
  missingCount: number;
  contentMismatchCount: number;
  realmMismatchCount: number;
  layerMismatchCount: number;
  statusMismatchCount: number;
  timestampMismatchCount: number;
  unexpectedCount: number;
  skippedSecretCount: number;
  skippedRedactedCount: number;
  allowSkips: number;
  checkedLayers?: ImportTargetLayer[];
  mismatches: ImportConsistencyMismatch[];
  unexpectedEntries: VerifyImportUnexpectedEntry[];
  // Backward-compatible summary fields
  totalChecked: number;
  undatedCount: number;
  defaultRealmFallbackCount: number;
  activeSupersededMismatches: ImportConsistencyMismatch[];
  timestampMismatches: ImportConsistencyMismatch[];
}

export type ImportConsistencyResult = VerifyImportResult;

export interface ImportDryRunUnresolvedRealm {
  rawValue: string;
  targetRef: string;
  count: number;
}

export interface ImportDryRunOversizedFile {
  path: string;
  sizeBytes: number;
  limitBytes: number;
}

export interface ImportDryRunResult {
  dryRun: true;
  sourceType: "md" | "jsonl";
  totalItems: number;
  plannedDefaultRealm: string;
  defaultRealmCount: number;
  undatedCount: number;
  skippedSecret: number;
  skippedRedacted: number;
  realmDistribution: Record<string, number>;
  unmatchedRealmValues: Record<string, number>;
  unresolvedRealms: ImportDryRunUnresolvedRealm[];
  oversizedFiles: ImportDryRunOversizedFile[];
  valid: boolean;
}

export interface StorageBloatStats {
  recordsCount: number;
  recordsPayloadBytes: number;
  vecPendingCount: number;
  vecPendingTextBytes: number;
}

export interface ExportMdItemResult {
  recordId: string;
  realmPath: string;
  relativePath: string;
  bytes: number;
}

export interface ExportMdResult {
  oneWayProjection: true;
  dryRun: boolean;
  outDir: string;
  orgId: string;
  orgName: string;
  exportedCount: number;
  skippedSecret: number;
  skippedConfidential: number;
  skippedRedacted: number;
  includeConfidential: boolean;
  manifestPath: string | null;
  items: ExportMdItemResult[];
}
