import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalBlobStore } from "./adapters/blob-store.js";
import { createEmbedderFromEnv } from "./adapters/embedder.js";
import { LocalFsDriveAdapter } from "./adapters/local-drive.js";
import { SqliteDb } from "./adapters/sqlite-db.js";
import { LedgerEngine } from "./engine/ledger.js";
import { ImporterEngine } from "./engine/importer.js";
import { ObjectEngine } from "./engine/objects.js";
import { SeaEngine } from "./engine/sea.js";
import { SliceExporter } from "./engine/slice.js";
import { assertNoLiveServeLock } from "./server/writer-lock.js";
import type { BlobPort, DbPort, DrivePort, EmbedderPort } from "./ports.js";
import { MindError } from "./types.js";

export * from "./types.js";
export * from "./policy.js";
export * from "./ports.js";
export {
  SqliteDb,
  normalizeForFts,
  parseSearchQuery,
  buildFtsMatchExpression,
  buildDateLiteralFtsExpr,
  CJK_COVERAGE_THRESHOLD,
  type DateConcept,
  type SearchConcept,
  type ParsedSearchQuery,
} from "./adapters/sqlite-db.js";
export { computeHighlightRanges, placeholders } from "./query/fts-query.js";
export {
  detectPlaintextSecret,
  assertNoAccidentalSecret,
  type SecretPatternMatch,
} from "./engine/secret-guard.js";
export type {
  MindSurface,
  SurfaceTreeParams,
  SurfaceLsParams,
  SurfaceShowParams,
  SurfaceSearchParams,
  SurfaceChangesParams,
  SurfaceWriteInput,
  SurfaceWriteResult,
  SurfaceRawAddInput,
  SurfaceMoveInput,
  SurfaceSettleInput,
  SurfaceAddRuleInput,
  SurfaceRedactInput,
  SurfaceCreateRealmInput,
  SurfaceUpdateRealmInput,
  SurfaceMountRealmInput,
  SurfaceCreateTokenInput,
  SurfaceCreateTokenResult,
  SurfaceCreateObjectInput,
  SurfaceMoveObjectInput,
  SurfaceDeleteObjectInput,
  SurfaceLinkObjectInput,
  SurfaceUnlinkObjectInput,
  SurfaceSetObjectStateInput,
  SurfaceUpdateObjectAliasesInput,
} from "./surface.js";
export {
  LocalMindSurface,
  type LocalMindSurfaceOptions,
} from "./surface-local.js";
export {
  RemoteMindSurface,
  type RemoteMindSurfaceOptions,
} from "./surface-remote.js";
export {
  ChangeWakeBus,
  MindPump,
  type PumpPollParams,
  type PumpPollResult,
} from "./server/pump.js";
export {
  TOKEN_PREFIX,
  DEFAULT_SSO_TOKEN_TTL_DAYS,
  MAX_DISPLAY_NAME_CHARS,
  sanitizeDisplayName,
  hashAuthToken,
  generateAuthTokenPlaintext,
  toPublicToken,
  createAuthToken,
  resolvePrincipalFromToken,
  isPrincipalTokenActive,
  TokenTouchThrottle,
  DEFAULT_TOKEN_TOUCH_THROTTLE_MS,
  type CreateAuthTokenParams,
  type CreateAuthTokenResult,
} from "./server/tokens.js";
export {
  OidcManager,
  OIDC_TX_COOKIE_PREFIX,
  OIDC_HOST_TX_COOKIE_PREFIX,
  DEVICE_TX_COOKIE_NAME,
  DEVICE_HOST_TX_COOKIE_NAME,
  INVITE_TX_COOKIE_NAME,
  INVITE_HOST_TX_COOKIE_NAME,
  INVITE_CODE_PREFIX,
  MAX_PENDING_DEVICE_CODES_GLOBAL,
  normalizeIpRateLimitKey,
  isTrustedProxyIp,
  extractClientIp,
  loadOidcConfigFromEnv,
  sanitizeReturnTo,
  hashInviteCode,
  toPublicInvite,
  createInvite,
} from "./server/oidc.js";
export {
  MAX_HARNESS_SESSION_CHARS,
  MAX_HARNESS_CLIENT_CHARS,
  PARENT_MAP_TTL_MS,
  MAX_PARENT_MAP_ENTRIES,
  sanitizeHarnessSessionId,
  sanitizeHarnessClientHint,
  resolveParentMapFilePath,
  recordHarnessParentLink,
  lookupHarnessParentSession,
  resolveHarnessSessionContext,
  type HarnessParentMapEntry,
  type HarnessParentMapSchema,
  type HarnessSessionContext,
} from "./harness-session.js";
export {
  DEFAULT_RELEASES_API_URL,
  compareSemver,
  detectInstallMode,
  checkForUpgrade,
  runUpgrade,
  formatUpgradeMarkdown,
  type InstallMode,
  type InstallInfo,
  type RemoteServerVersionInfo,
  type UpgradeCheckResult,
  type UpgradeRunResult,
  type ExecFileFn,
  type DetectInstallModeOptions,
  type CheckForUpgradeOptions,
  type RunUpgradeOptions,
} from "./upgrade.js";
export {
  resolveCredentialsFilePath,
  readCredentialsFile,
  saveProfileCredential,
  lookupSavedCredential,
  normalizeServerUrlKey,
  type SavedProfileCredential,
  type CredentialsFileSchema,
} from "./credentials.js";
export {
  SERVE_LOCK_FILENAME,
  readLiveServeLock,
  assertNoLiveServeLock,
  acquireServeWriterLock,
  type ServeLockInfo,
  type ServeWriterLockHandle,
} from "./server/writer-lock.js";
export {
  startMindServer,
  SERVER_VERSION,
  type AccessLogEntry,
  type MindServerOptions,
  type MindServerHandle,
} from "./server/http-server.js";
export { createSurfaceMcpServer } from "./server/mcp-http.js";
export {
  MindPulseStore,
  sanitizeClientHint,
  sanitizeObservedActivity,
  MAX_FOCUS_REFS,
  MAX_FOCUS_ITEM_CHARS,
  MAX_NOTE_CHARS,
  MAX_ACTIVITY_CHARS,
  MAX_SESSION_TAG_CHARS,
  MAX_CLIENT_HINT_CHARS,
  MAX_SESSIONS_PER_PRINCIPAL,
  MAX_TOTAL_SESSIONS,
  ONLINE_WINDOW_MS,
  SILENT_WINDOW_MS,
  ACTIVE_PEER_WINDOW_MS,
  STALE_EVICT_MS,
  TURN_ENDED_EVICT_MS,
  type PulseEntry,
  type PulseOverlap,
  type PulseDeclareResult,
  type InFlightWorkGroup,
  type PulseListResult,
} from "./server/pulse.js";
export {
  normalizeDeterministicKey,
  normalizeTargetKeys,
  extractDeterministicKeysFromText,
  describeTargetKey,
  MAX_TARGET_KEYS,
  MAX_TARGET_KEY_CHARS,
  type PulseTargetKind,
} from "./server/pulse-keys.js";
export {
  withLivePulse,
  type LivePulseSessionContext,
} from "./server/live-pulse.js";
export {
  UiSessionManager,
  UI_SESSION_COOKIE_NAME,
  UI_HOST_SESSION_COOKIE_NAME,
  parseCookieHeader,
} from "./server/ui-auth.js";
export {
  STRICT_UI_CSP,
  buildMermaidFrameCsp,
  isLoopbackHost,
  assertWebDirAllowed,
  createUiRouteHandler,
  ejectDefaultUiShell,
} from "./server/ui-router.js";
export {
  CLIENT_JS_SOURCE,
  DEFAULT_FAVICON_SVG,
  DEFAULT_SHELL_HTML,
  DEFAULT_SHELL_CSS,
  DEFAULT_SHELL_JS,
} from "./server/ui-assets.js";
export { MARKDOWN_JS_SOURCE } from "./server/markdown-renderer.js";
export {
  MERMAID_FRAME_HTML_SOURCE,
  MERMAID_FRAME_JS_SOURCE,
} from "./server/mermaid-frame.js";
export { MERU_MIND_VERSION } from "./version.js";
export { seedDemoOrg, type DemoSeedSummary } from "./server/demo-seed.js";
export {
  attachPumpWebSocketServer,
  isOriginAllowed,
  type AttachPumpWsOptions,
  type PumpWsHandle,
} from "./server/ws-pump.js";
export {
  validateWorkBindingConfig,
  resolveEnvSecretRef,
  formatDefaultAnnotateComment,
  type WorkRef,
  type WorkLocator,
  type StatusType,
  type ProviderCtx,
  type WorkItemSnapshot,
  type WorkResolveOutcome,
  type AnnotateNote,
  type WorkProvider,
  type WorkBindingRecord,
} from "./work/provider.js";
export {
  LinearWorkProvider,
  type LinearProviderOptions,
} from "./work/linear-provider.js";
export {
  GitHubWorkProvider,
  type GitHubProviderOptions,
} from "./work/github-provider.js";
export {
  WorkProviderRegistry,
  resolveWorkBindingForRealm,
  type CircuitBreakerConfig,
  type SafeResolveResult,
  type SafeListReadyResult,
} from "./work/registry.js";
export {
  DeliveryRetryWorker,
  type DeliveryWorkerOptions,
  type DeliveryDrainResult,
} from "./work/delivery-worker.js";
export { LocalBlobStore } from "./adapters/blob-store.js";
export {
  NoopEmbedder,
  OpenAICompatibleEmbedder,
  createEmbedderFromEnv,
} from "./adapters/embedder.js";
export {
  LocalFsDriveAdapter,
  normalizeSafeRelPath,
} from "./adapters/local-drive.js";
export {
  LedgerEngine,
  DEFAULT_ROOT_REALM_SCOPE,
  computePayloadHash,
  isAllowedSupersedeKind,
} from "./engine/ledger.js";
export {
  runRealmDoctor,
  type DoctorFinding,
  type DoctorFindingCode,
  type DoctorReport,
  type DoctorSeverity,
} from "./engine/doctor.js";
export {
  canonicalizeJson,
  sha256Bytes,
  computeRecordContentSha256,
  computeSeabedContentSha256,
  computeFileContentSha256,
  buildWriteRecordPayload,
  REDACTED_CONTENT_BLOCKED_MSG,
  REDACTED_CONTENT_TRY_HINT,
} from "./engine/content-hash.js";
export {
  OPAQUE_FILE_NOT_FOUND,
  parseRefSyntax,
  formatCanonicalFileRef,
  formatStoredSourceRef,
  formatRealmQualifiedObjectRef,
  computeDuplicateObjectKeys,
  formatCanonicalObjectRef,
  resolveFileRef,
  resolveChangeAboutFilter,
  resolveUnifiedObjectRead,
  resolveAboutRefsForWrite,
  type ParsedRef,
  type UnifiedObjectResolution,
} from "./engine/refs.js";
export {
  writeEverydayConclusion,
  findBoundRulesForEcho,
  findRelatedActiveForEcho,
  resolveWriteTargetRealm,
  EVERYDAY_WRITE_KINDS,
  type BoundRuleEcho,
  type RelatedActiveEcho,
  type SurfaceWriteParams,
  type ResolveWriteTargetParams,
  type ResolvedWriteTarget,
} from "./engine/surface-write.js";
export {
  discoverWorkspaceRealmMarker,
  WORKSPACE_REALM_MARKER_FILE,
  type WorkspaceRealmMarker,
} from "./engine/workspace-marker.js";
export {
  mapMindErrorCodeToWire,
  toSurfaceError,
  formatSurfaceErrorText,
} from "./format/errors.js";
export {
  compileAliasMatcher,
  createInactiveBadgeResolver,
  formatInactiveBadge,
  formatInactiveBadgesMarkdown,
  isAliasRowMentionEligible,
  isEligibleAliasForm,
  isValidCalendarDate,
  matchesAliasForm,
  matchesCompiledAlias,
  MAX_ALIAS_LENGTH,
  MAX_EXPLICIT_ALIASES_PER_OBJECT,
  normalizeAlias,
  OBJECT_STATE_LABEL_RE,
  validateExplicitAliasInput,
  validateStrictIsoDate,
  type CompiledAliasMatcher,
  type InactiveBadgeResolver,
} from "./format/inactive-badges.js";
export {
  ObjectEngine,
  normalizeResourceTag,
  normalizeRealmPath,
  resolveRealmByPath,
  resolveVisibleRealm,
  assertNoObjectCycle,
  getDescendantObjectIds,
  OPAQUE_REALM_NOT_FOUND,
  OPAQUE_OBJECT_NOT_FOUND,
  OPAQUE_ENTRY_NOT_FOUND,
} from "./engine/objects.js";
export {
  ImporterEngine,
  MAX_IMPORT_ITEM_BYTES,
  MAX_IMPORT_BATCH_ITEMS,
  MAX_VERIFY_MANIFEST_ITEMS,
  MAX_IMPORT_ITEM_SUPERSEDES,
  MAX_IMPORT_ITEM_REFS,
  MAX_IMPORT_ITEM_OBJECT_REFS,
  MAX_IMPORT_ITEM_RESOURCE_TAGS,
  MAX_IMPORT_MD_BYTES,
  normalizeSourceRef,
  decodeUtf8Strict,
  resolveImportSkipSecret,
  matchesExcludePattern,
  parseMarkdownDocument,
  resolveMostPreciseDeclaredTimestamp,
  planMarkdownImport,
  planJsonlImport,
  chunkImportBatchItems,
  planSourceVerification,
  chunkVerifyManifestItems,
  mergeVerifyImportResults,
  type ParsedMarkdownDoc,
  type PlanMarkdownImportResult,
  type PlanJsonlImportResult,
  type PlanSourceVerificationResult,
} from "./engine/importer.js";
export { exportRecordsAsMarkdown } from "./engine/export-md.js";
export {
  classifyRulesForViewer,
  collectActiveDecisionHeads,
  collectObjectCardEntryIds,
  collectObjectScopedRules,
  collectWallRules,
  computeGoverningRealmIds,
  evaluateCardObjectFreshness,
  extractRuleBodyText,
  hasActiveRulesOnObjectHierarchy,
  sanitizeNarrativeForAgent,
  walkVisibleWithinAncestors,
} from "./engine/object-rules.js";
export {
  createVisibilityHelpers,
  filterVisibleChangeFrames,
  parseDriveSourceRef,
  sanitizeRealmsForScope,
  type FilterableChangeFrame,
  type VisibilityHelpers,
} from "./engine/visibility.js";
export {
  buildCanonicalEntryContent,
  buildRecordFtsBody,
  buildSnippet,
  buildSnippetWithMeta,
  DEFAULT_SHOW_LIMIT,
  extractReadableText,
  MAX_SHOW_LIMIT,
  windowText,
  type SnippetConceptLike,
  type SnippetWithMeta,
  type WindowTextResult,
} from "./format/snippet.js";
export { SeaEngine } from "./engine/sea.js";
export {
  SliceExporter,
  restoreWritablePermissions,
} from "./engine/slice.js";
export {
  formatBehaviorBadge,
  formatBriefMarkdown,
  formatCatMarkdown,
  formatChangesMarkdown,
  formatDoctorMarkdown,
  formatExportMdMarkdown,
  formatGenericMarkdown,
  formatImportBatchMarkdown,
  formatImportDryRunMarkdown,
  formatImportJsonlMarkdown,
  formatImportMdMarkdown,
  formatImportVerifyMarkdown,
  formatLsMarkdown,
  formatObjectsMarkdown,
  formatRecallMarkdown,
  formatReplayMarkdown,
  formatSearchMarkdown,
  formatShowMarkdown,
  formatTagsMarkdown,
  formatThingsMarkdown,
  formatTreeMarkdown,
  formatWhoamiMarkdown,
} from "./format/markdown.js";

export interface MindEngineOptions {
  /** Runtime data home directory. Defaults to MERU_MIND_HOME or ~/.meru-mind */
  homeDir?: string;
  /** Optional custom ports (for testing or custom adapters) */
  db?: DbPort;
  blobs?: BlobPort;
  drive?: DrivePort;
  embedder?: EmbedderPort;
  /** Override vector dimensions (must match embedder.dimensions) */
  vectorDimensions?: number;
  /** Enable sqlite-vec extension loading (default: true) */
  enableVector?: boolean;
  /** Internal flag set by `meru-mind serve` after acquiring the exclusive writer lock */
  isServerOwner?: boolean;
}

export interface MindEngine {
  readonly homeDir: string;
  readonly db: DbPort;
  readonly blobs: BlobPort;
  readonly drive: DrivePort;
  readonly embedder: EmbedderPort;
  readonly ledger: LedgerEngine;
  readonly objects: ObjectEngine;
  readonly sea: SeaEngine;
  readonly importer: ImporterEngine;
  readonly slice: SliceExporter;
  close(): Promise<void>;
}

/**
 * Resolves the default runtime home outside any source repository.
 */
export function resolveDefaultHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env.MERU_MIND_HOME?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".meru-mind");
}

function realpathExistingPrefix(targetDir: string): string {
  const abs = path.resolve(targetDir);
  const parts: string[] = [];
  let cur = abs;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    parts.unshift(path.basename(cur));
    cur = parent;
  }
  const realBase = fs.existsSync(cur) ? fs.realpathSync(cur) : cur;
  return parts.length > 0 ? path.join(realBase, ...parts) : realBase;
}

function isInsideSourcePackage(targetDir: string): boolean {
  let cur = realpathExistingPrefix(targetDir);
  const root = path.parse(cur).root;
  while (cur !== root) {
    const pkgPath = path.join(cur, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
          name?: string;
        };
        if (pkg.name === "@meru-mind/core") {
          return true;
        }
      } catch {
        // ignore invalid package.json
      }
    }
    cur = path.dirname(cur);
  }
  return false;
}

export async function createMindEngine(
  options: MindEngineOptions = {},
): Promise<MindEngine> {
  const homeDir = path.resolve(options.homeDir ?? resolveDefaultHomeDir());

  // Prevent accidentally storing user runtime data inside the open-source repository tree.
  if (isInsideSourcePackage(homeDir)) {
    throw new MindError(
      "FORBIDDEN_HOME_PATH",
      `Refusing to store runtime data inside the @meru-mind/core repository (${homeDir}). Set MERU_MIND_HOME or --home to an external path (e.g. ~/.meru-mind).`,
    );
  }

  // Block direct local SQLite access whenever a live `meru-mind serve` holds the exclusive writer lock.
  if (!options.isServerOwner && !options.db) {
    assertNoLiveServeLock(homeDir);
  }

  fs.mkdirSync(homeDir, { recursive: true });

  const embedder = options.embedder ?? createEmbedderFromEnv();
  const vectorDimensions = options.vectorDimensions ?? embedder.dimensions;

  const db =
    options.db ??
    new SqliteDb({
      dbPath: path.join(homeDir, "mind.sqlite"),
      vectorDimensions,
      enableVector: options.enableVector ?? true,
    });

  const blobs =
    options.blobs ?? new LocalBlobStore(path.join(homeDir, "blobs"));

  const drive: DrivePort =
    options.drive ?? new LocalFsDriveAdapter(path.join(homeDir, "drive"));

  await drive.init();

  const ledger = new LedgerEngine(db, blobs, drive, embedder);
  const objects = new ObjectEngine(db);
  const sea = new SeaEngine(db, blobs, drive, embedder);
  const importer = new ImporterEngine(db, ledger, sea);
  const slice = new SliceExporter(db, drive, ledger, sea, homeDir);

  return {
    homeDir,
    db,
    blobs,
    drive,
    embedder,
    ledger,
    objects,
    sea,
    importer,
    slice,
    async close() {
      await drive.close();
      db.close();
    },
  };
}
