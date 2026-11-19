export type MindErrorCode =
  | "ACCESS_DENIED"
  | "RULE_REQUIRES_HUMAN"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VERDICT_INVARIANT"
  | "FORBIDDEN_HOME_PATH"
  | "SLICE_VIOLATION"
  | "DRIVE_ERROR";

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

export interface Actor {
  id: string;
  kind: ActorKind;
  /** Model family for agents (e.g., "claude", "gemini", "deepseek", "openai") */
  family?: string;
}

export interface Organization {
  id: string;
  name: string;
  isPersonalRoot: boolean;
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
  archivedAt: string | null;
  createdAt: string;
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

export type SeabedKind = "message" | "artifact" | "evidence" | "signal";

export interface SeabedEntry {
  id: string;
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

export interface LedgerRecord {
  id: string;
  realmId: string;
  thingId: string | null;
  kind: RecordKind;
  status: RecordStatus;
  supersedesId: string | null;
  supersededById: string | null;
  authorId: string;
  authorKind: ActorKind;
  authorFamily: string | null;
  title: string;
  payload: Record<string, unknown>;
  refs: string[];
  createdAt: string;
}

export type DistillationLayer =
  | "slice_shift"
  | "slice_day"
  | "slice_week"
  | "slice_month"
  | "card_realm"
  | "card_person"
  | "card_progress";

export interface Distillation {
  id: string;
  realmId: string;
  layer: DistillationLayer;
  periodKey: string;
  status: "active" | "superseded";
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

export interface BriefBudget {
  recentMessages?: number;
  maxQuestions?: number;
  maxActiveThings?: number;
  maxDecisions?: number;
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
  activeThings: number;
  pendingQuestions: number;
  activeDecisions: number;
  latestCardSummary: string | null;
}

export interface BriefOutput {
  realm: Realm;
  generatedAt: string;
  surface: {
    recentMessages: BriefSection<SeabedEntry>;
  };
  upperLedger: {
    pendingQuestions: BriefSection<LedgerRecord>;
    activeThings: BriefSection<LedgerRecord>;
    activeDecisions: BriefSection<LedgerRecord>;
  };
  middleMind: {
    realmCard: Distillation | null;
    rules: BriefSection<{
      id: string;
      realmId: string;
      inherited: boolean;
      title: string;
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
  recordKinds?: RecordKind[];
  seabedKinds?: SeabedKind[];
  authorId?: string;
  since?: string;
  until?: string;
  includeSuperseded?: boolean;
  /** Parent diving explicitly into descendant raw seabed */
  includeDescendantSeabed?: boolean;
  /** Stage 3 & 4: Keyword (FTS5) + Semantic (sqlite-vec) query */
  query?: string;
  limit?: number;
  offset?: number;
}

export type RecallItemStatus = "active" | "superseded" | "retracted" | "evidence";

export interface RecallItem {
  id: string;
  sourceType: "record" | "seabed" | "distillation";
  kind: string;
  realmId: string;
  status: RecallItemStatus;
  title: string;
  snippet: string;
  authorId: string;
  createdAt: string;
  sourceRefs: string[];
  supersedesId?: string | null;
  supersededById?: string | null;
  matchedBy: Array<"id" | "filter" | "fts" | "vector">;
  score: number;
}

export interface RecallResult {
  viewerRealmId: string;
  items: RecallItem[];
  totalMatched: number;
  omittedCount: number;
  vectorUsed: boolean;
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
