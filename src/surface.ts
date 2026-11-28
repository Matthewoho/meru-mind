import type { RelatedActiveEcho } from "./engine/surface-write.js";
import type { WorkBindingRecord } from "./work/provider.js";
import type { SafeListReadyResult, SafeResolveResult } from "./work/registry.js";
import type {
  ActorRole,
  AuthTokenPublic,
  ChangeLogEntry,
  ChangesResult,
  CreateObjectResult,
  EntryObjectLink,
  ImportBatchInput,
  ImportBatchResult,
  LedgerRecord,
  LsOnlyFilter,
  LsResult,
  MindObject,
  MountScope,
  MoveEntriesResult,
  ObjectAliasUpdateResult,
  ObjectState,
  ObjectStateSetResult,
  OrgPolicy,
  Organization,
  Principal,
  Realm,
  RealmArchiveResult,
  RealmMount,
  RealmUnarchiveResult,
  RedactResult,
  SeabedEntry,
  SeabedKind,
  SearchResult,
  Sensitivity,
  ShowResult,
  ShowSupersedeChainResult,
  TokenWriteScope,
  TreeResult,
  VerifyImportInput,
  VerifyImportResult,
  WhoamiResult,
  WriteRouteSource,
} from "./types.js";

export interface SurfaceTreeParams {
  ref?: string;
  depth?: number | "all";
  includeObjects?: boolean;
  limit?: number;
}

export interface SurfaceLsParams {
  ref?: string;
  only?: LsOnlyFilter;
  kind?: string;
  about?: string;
  since?: string;
  until?: string;
  history?: boolean;
  includeDescendantSeabed?: boolean;
  limit?: number;
  cursor?: string;
}

export interface SurfaceShowParams {
  ref: string;
  around?: string;
  cursor?: string;
  chars?: number;
  full?: boolean;
  history?: boolean;
  context?: number;
  includeDescendantSeabed?: boolean;
}

export interface SurfaceSearchParams {
  query: string;
  in?: string;
  about?: string;
  kind?: string;
  since?: string;
  until?: string;
  history?: boolean;
  includeDescendantSeabed?: boolean;
  limit?: number;
  cursor?: string;
}

export interface SurfaceChangesParams {
  sinceSeq?: number;
  generation?: number;
  in?: string;
  limit?: number;
  includeDescendantSeabed?: boolean;
  /** Optional long-poll wait in seconds (0..25); supported on server/pump surfaces */
  waitSeconds?: number;
  signal?: AbortSignal;
}

export interface SurfaceWriteInput {
  in?: string;
  title: string;
  body: string;
  kind?: string;
  extKind?: string | null;
  about?: string[];
  supersedes?: string[];
  because?: string[];
  occurredAt?: string | null;
  sensitivity?: Sensitivity;
  idempotencyKey?: string;
  /** Untrusted workspace hint (.meru-mind-realm); intersected with principal scope */
  workspaceHint?: string | null;
  /** Optional last sequence observed by this session for write-time collision hints */
  lastReadSeq?: number;
}

export interface SurfaceWriteResult {
  record: LedgerRecord;
  routedBy: WriteRouteSource;
  relatedActive?: RelatedActiveEcho[];
  /** Recent same-realm changes by other actors since the session's lastReadSeq (advisory, never blocks writes) */
  collisionHints?: ChangeLogEntry[];
}

export interface SurfaceRawAddInput {
  in?: string;
  kind?: SeabedKind;
  text: string;
  topicId?: string;
  sourceRef?: string;
  occurredAt?: string | null;
  sensitivity?: Sensitivity;
  idempotencyKey?: string;
  workspaceHint?: string | null;
}

export interface SurfaceMoveInput {
  entryIds: string[];
  targetRealmRef: string;
  dryRun?: boolean;
  /** Optional CAS guard: verify every entry currently resides in this realm before moving (ideal for inbox triage) */
  expectedFromRealmRef?: string;
  idempotencyKey?: string;
}

export interface SurfaceAddRuleInput {
  in: string;
  title: string;
  body: string;
  about?: string[];
  supersedes?: string[];
  because?: string[];
  occurredAt?: string | null;
  sensitivity?: Sensitivity;
  idempotencyKey?: string;
}

export interface SurfaceRedactInput {
  entryId: string;
  reason?: string;
}

export interface SurfaceCreateRealmInput {
  parentRef: string;
  slug: string;
  name: string;
  scope?: string | null;
}

export interface SurfaceUpdateRealmInput {
  ref: string;
  name?: string;
  scope?: string;
}

export interface SurfaceMountRealmInput {
  viewerRef: string;
  targetRef: string;
  scope?: MountScope;
}

export interface SurfaceCreateTokenInput {
  actorId: string;
  actorKind: "human" | "agent";
  actorFamily?: string | null;
  actorRole?: ActorRole;
  boundRealmRef?: string | null;
  writeScope?: TokenWriteScope;
  label?: string | null;
}

export interface SurfaceCreateTokenResult {
  token: string;
  record: AuthTokenPublic;
}

export interface SurfaceCreateObjectInput {
  in?: string;
  kind: string;
  name: string;
  parentRef?: string | null;
  ifNotExists?: boolean;
}

export interface SurfaceMoveObjectInput {
  ref: string;
  parentRef: string | null;
}

export interface SurfaceDeleteObjectInput {
  ref: string;
}

export interface SurfaceLinkObjectInput {
  entryId: string;
  objectRef: string;
}

export interface SurfaceUnlinkObjectInput {
  entryId: string;
  objectRef: string;
}

export interface SurfaceSetObjectStateInput {
  ref: string;
  state: ObjectState;
  label?: string;
  since?: string;
  because?: string;
}

export interface SurfaceUpdateObjectAliasesInput {
  ref: string;
  add?: string[];
  remove?: string[];
}

/**
 * First stable public TypeScript contract of Meru Mind (v0.3+).
 * Hides raw `DbPort` completely so local CLI/SDK, stdio MCP, HTTP REST, Streamable HTTP MCP,
 * and browser governance clients all execute through the exact same policy choke point.
 */
export interface MindSurface {
  readonly mode: "local" | "remote";
  readonly principal: Principal;

  whoami(): Promise<WhoamiResult>;
  tree(params?: SurfaceTreeParams): Promise<TreeResult>;
  ls(params?: SurfaceLsParams): Promise<LsResult>;
  show(params: SurfaceShowParams): Promise<ShowResult>;
  search(params: SurfaceSearchParams): Promise<SearchResult>;
  changes(params?: SurfaceChangesParams): Promise<ChangesResult>;
  write(params: SurfaceWriteInput): Promise<SurfaceWriteResult>;
  rawAdd(params: SurfaceRawAddInput): Promise<SeabedEntry>;
  move(params: SurfaceMoveInput): Promise<MoveEntriesResult>;
  getEntryChain(entryId: string): Promise<ShowSupersedeChainResult>;

  // Human governance operations (Cookie sessions receive 403 + CLI command for irreversible/scope-widening verbs)
  addRule(params: SurfaceAddRuleInput): Promise<LedgerRecord>;
  redact(params: SurfaceRedactInput): Promise<RedactResult>;
  createRealm(params: SurfaceCreateRealmInput): Promise<Realm>;
  updateRealm(params: SurfaceUpdateRealmInput): Promise<Realm>;
  mountRealm(params: SurfaceMountRealmInput): Promise<RealmMount>;
  unmountRealm(params: { viewerRef: string; targetRef: string }): Promise<boolean>;
  archiveRealm(params: { ref: string }): Promise<RealmArchiveResult>;
  unarchiveRealm(params: { ref: string }): Promise<RealmUnarchiveResult>;
  setOrgPolicy(params: { policy: OrgPolicy }): Promise<Organization>;

  // Server token management (human bearer/local only)
  createToken(params: SurfaceCreateTokenInput): Promise<SurfaceCreateTokenResult>;
  listTokens(params?: { includeRevoked?: boolean }): Promise<AuthTokenPublic[]>;
  revokeToken(params: { tokenId: string }): Promise<boolean>;

  // Object lifecycle management (v0.6.5 remote & local parity)
  createObject(params: SurfaceCreateObjectInput): Promise<CreateObjectResult>;
  moveObject(params: SurfaceMoveObjectInput): Promise<MindObject>;
  deleteObject(params: SurfaceDeleteObjectInput): Promise<boolean>;
  linkObject(params: SurfaceLinkObjectInput): Promise<EntryObjectLink>;
  unlinkObject(params: SurfaceUnlinkObjectInput): Promise<boolean>;
  setObjectState(params: SurfaceSetObjectStateInput): Promise<ObjectStateSetResult>;
  updateObjectAliases(
    params: SurfaceUpdateObjectAliasesInput,
  ): Promise<ObjectAliasUpdateResult>;

  // Unified online/local batch import & independent verification (v0.6.5)
  importBatch(params: ImportBatchInput): Promise<ImportBatchResult>;
  verifyImport(params: VerifyImportInput): Promise<VerifyImportResult>;

  // External WorkProvider SSOT bindings & live queries (v0.5; zero task tables in mind-core)
  bindWork(params: {
    realmRef: string;
    provider: string;
    config: Record<string, unknown>;
  }): Promise<WorkBindingRecord>;
  unbindWork(params: { realmRef: string }): Promise<boolean>;
  listWorkBindings(): Promise<WorkBindingRecord[]>;
  resolveWork(params: {
    realmRef?: string;
    items: string[];
  }): Promise<SafeResolveResult>;
  listReadyWork(params?: {
    realmRef?: string;
    limit?: number;
    cursor?: string;
  }): Promise<SafeListReadyResult>;

  close(): Promise<void>;
}
