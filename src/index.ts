import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalBlobStore } from "./adapters/blob-store.js";
import { createEmbedderFromEnv } from "./adapters/embedder.js";
import {
  LayerFSDriveAdapter,
  type LayerFSClientLike,
} from "./adapters/layerfs-drive.js";
import { LocalFsDriveAdapter } from "./adapters/local-drive.js";
import { SqliteDb } from "./adapters/sqlite-db.js";
import { LedgerEngine } from "./engine/ledger.js";
import { ImporterEngine } from "./engine/importer.js";
import { ObjectEngine } from "./engine/objects.js";
import { SeaEngine } from "./engine/sea.js";
import { SliceExporter } from "./engine/slice.js";
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
  LayerFSDriveAdapter,
  type LayerFSClientLike,
  type LayerFSDriveOptions,
  type LayerFSRuntimeLike,
  type LayerFSWorkspaceHandle,
} from "./adapters/layerfs-drive.js";
export {
  LedgerEngine,
  computePayloadHash,
} from "./engine/ledger.js";
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
  resolveUnifiedObjectRead,
  resolveAboutRefsForWrite,
  type ParsedRef,
  type UnifiedObjectResolution,
} from "./engine/refs.js";
export {
  writeEverydayConclusion,
  EVERYDAY_WRITE_KINDS,
  type SurfaceWriteParams,
} from "./engine/surface-write.js";
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
  parseMarkdownDocument,
  type ParsedMarkdownDoc,
} from "./engine/importer.js";
export {
  createVisibilityHelpers,
  parseDriveSourceRef,
  sanitizeRealmsForScope,
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
  formatGenericMarkdown,
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
  /** Drive backend: "local" (default, zero-Docker) or "layerfs" (concurrent LayerFS SDK) */
  driveMode?: "local" | "layerfs";
  /** LayerFS project name when driveMode === "layerfs" */
  layerfsProjectName?: string;
  /** Optional explicit LayerFS SDK module path */
  layerfsSdkSpecifier?: string;
  /** Optional custom ports (for testing or cloud adapters) */
  db?: DbPort;
  blobs?: BlobPort;
  drive?: DrivePort;
  layerfsClient?: LayerFSClientLike;
  embedder?: EmbedderPort;
  /** Override vector dimensions (must match embedder.dimensions) */
  vectorDimensions?: number;
  /** Enable sqlite-vec extension loading (default: true) */
  enableVector?: boolean;
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

  let drive: DrivePort;
  if (options.drive) {
    drive = options.drive;
  } else if (options.driveMode === "layerfs") {
    drive = new LayerFSDriveAdapter({
      projectName: options.layerfsProjectName ?? "meru-mind-drive",
      homeDir: path.join(homeDir, "layerfs"),
      sdkSpecifier: options.layerfsSdkSpecifier,
      client: options.layerfsClient,
      getCanonicalMeta: (realmId, relPath) =>
        db.getDriveFileMeta(realmId, relPath),
    });
  } else {
    drive = new LocalFsDriveAdapter(path.join(homeDir, "drive"));
  }

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
