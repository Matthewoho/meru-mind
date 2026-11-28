import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertWriteAccess,
  getWritableRealmIds,
  intersectAccessScopes,
  isRealmEffectivelyArchived,
  normalizeWriteScope,
  resolveAccess,
  resolveAccessScope,
} from "../policy.js";
import type { DbPort } from "../ports.js";
import {
  MindError,
  type AccessScope,
  type Actor,
  type AssetKind,
  type ImportBatchInput,
  type ImportBatchItemAction,
  type ImportBatchItemInput,
  type ImportBatchItemResult,
  type ImportBatchRealmProjection,
  type ImportBatchResult,
  type ImportConsistencyMismatch,
  type ImportConsistencyResult,
  type ImportDryRunOversizedFile,
  type ImportDryRunResult,
  type ImportDryRunUnresolvedRealm,
  type ImportJsonlResult,
  type ImportMappingConfig,
  type ImportMdItemResult,
  type ImportMdResult,
  type ImportTargetLayer,
  type LedgerRecord,
  type OrgPolicy,
  type Realm,
  type RecordKind,
  type SeabedEntry,
  type SeabedKind,
  type Sensitivity,
  type TokenWriteScope,
  type VerifyImportExpectedKey,
  type VerifyImportInput,
  type VerifyImportManifestItem,
  type VerifyImportResult,
  type VerifyImportUnexpectedEntry,
} from "../types.js";
import {
  computePayloadHash,
  computeRecordContentSha256,
  computeSeabedContentSha256,
} from "./content-hash.js";
import type { LedgerEngine } from "./ledger.js";
import {
  normalizeResourceTag,
  OPAQUE_ENTRY_NOT_FOUND,
  OPAQUE_REALM_NOT_FOUND,
  resolveVisibleRealm,
} from "./objects.js";
import type { SeaEngine } from "./sea.js";
import {
  assertNoAccidentalSecret,
  detectPlaintextSecret,
} from "./secret-guard.js";
import {
  createVisibilityHelpers,
  type VisibilityHelpers,
} from "./visibility.js";

/** Per-item serialized UTF-8 cap for unified online & local imports (1.2 MB; never truncated). */
export const MAX_IMPORT_ITEM_BYTES = 1_200_000;

/** Maximum items per `POST /v1/import/batch` request. */
export const MAX_IMPORT_BATCH_ITEMS = 100;

/** Maximum items per `POST /v1/import/verify` request. */
export const MAX_VERIFY_MANIFEST_ITEMS = 250;

/** Hard per-item array caps in `ingestBatch` to prevent synchronous DB scan DoS. */
export const MAX_IMPORT_ITEM_SUPERSEDES = 32;
export const MAX_IMPORT_ITEM_REFS = 32;
export const MAX_IMPORT_ITEM_OBJECT_REFS = 64;
export const MAX_IMPORT_ITEM_RESOURCE_TAGS = 64;

/**
 * Backward-compatible 2 MB constant aligned with HTTP JSON body cap (`http-server.ts`).
 * Per-item import cap defaults to `MAX_IMPORT_ITEM_BYTES` (1.2 MB).
 */
export const MAX_IMPORT_MD_BYTES = 2 * 1024 * 1024;

// Preserve UTF-8 BOM byte-for-byte while rejecting invalid byte sequences strictly.
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const RESERVED_EXTRA_PAYLOAD_KEYS = new Set<string>([
  "body",
  "summary",
  "sourceRef",
  "contentSha256",
  "rawContentSha256",
  "frontmatter",
  "sourceId",
  "crossRealmSupersedes",
]);

const ALLOWED_IDEMPOTENCY_PREFIXES = new Set<string>([
  "import-md",
  "import-jsonl",
  "import-batch",
]);

const VALID_RECORD_KINDS = new Set<string>([
  "thing",
  "claim",
  "proposal",
  "verdict",
  "finding",
  "decision",
  "rule",
]);

const VALID_SEABED_KINDS = new Set<string>([
  "message",
  "artifact",
  "evidence",
  "signal",
]);

const VALID_SENSITIVITIES = new Set<string>([
  "public",
  "internal",
  "confidential",
  "secret",
]);

function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function normalizeSourceRef(raw: string): string {
  return raw.trim().normalize("NFC");
}

export function decodeUtf8Strict(buf: Buffer, label: string): string {
  try {
    return UTF8_FATAL_DECODER.decode(buf);
  } catch {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid UTF-8 encoding in "${label}" (strict UTF-8 decoding required; refusing lossy replacement).`,
      { reason: "invalid_utf8", filePath: label },
    );
  }
}

export function resolveImportSkipSecret(
  explicitSkipSecret?: boolean,
  mapping?: ImportMappingConfig,
): boolean {
  if (explicitSkipSecret !== undefined) return explicitSkipSecret;
  return mapping?.skipSecret ?? true;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim().normalize("NFC").replace(/\\/g, "/");
  let re = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function matchesExcludePattern(
  relPathNfc: string,
  patterns: string[],
): boolean {
  if (patterns.length === 0) return false;
  const cleanRel = relPathNfc.replace(/\\/g, "/").replace(/^\.\//, "");
  const baseName = path.posix.basename(cleanRel);
  for (const rawPat of patterns) {
    const pat = rawPat
      .trim()
      .normalize("NFC")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    if (!pat) continue;
    const re = globToRegExp(pat);
    if (re.test(cleanRel)) return true;
    if (!pat.includes("/") && re.test(baseName)) return true;
  }
  return false;
}

function serializeByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Iterative Kahn's topological sort over supersedes edges (zero recursion stack overflow).
 * Rejects self-supersedes and cycles with `INVALID_INPUT` (`reason: "supersedes_cycle"`).
 */
function topologicalSortImportItems<
  T extends {
    sourceRef: string;
    sourceId?: string | null;
    supersedesSourceRefs?: string[];
  },
>(items: T[]): T[] {
  const n = items.length;
  if (n === 0) return [];

  const indexByKey = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    const item = items[i]!;
    indexByKey.set(normalizeSourceRef(item.sourceRef), i);
    if (item.sourceId?.trim()) {
      indexByKey.set(normalizeSourceRef(item.sourceId), i);
    }
  }

  // Edge: parentIdx -> childIdx (parent must be ingested BEFORE child)
  const dependents: number[][] = Array.from({ length: n }, () => []);
  const inDegree = new Int32Array(n);

  for (let childIdx = 0; childIdx < n; childIdx += 1) {
    const item = items[childIdx]!;
    const seenParents = new Set<number>();
    for (const supRef of item.supersedesSourceRefs ?? []) {
      const norm = normalizeSourceRef(supRef);
      if (!norm) continue;
      const parentIdx = indexByKey.get(norm);
      if (parentIdx === undefined) continue;
      if (parentIdx === childIdx) {
        throw new MindError(
          "INVALID_INPUT",
          `Self-supersedes cycle detected on "${item.sourceRef}".`,
          { reason: "supersedes_cycle", sourceRef: item.sourceRef },
        );
      }
      if (!seenParents.has(parentIdx)) {
        seenParents.add(parentIdx);
        dependents[parentIdx]!.push(childIdx);
        inDegree[childIdx] = inDegree[childIdx]! + 1;
      }
    }
  }

  // Min-index deterministic Kahn queue (binary min-heap so original input order is preserved)
  const heap: number[] = [];
  const pushHeap = (val: number) => {
    heap.push(val);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]! <= heap[i]!) break;
      const tmp = heap[p]!;
      heap[p] = heap[i]!;
      heap[i] = tmp;
      i = p;
    }
  };
  const popHeap = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      const len = heap.length;
      while (true) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < len && heap[l]! < heap[smallest]!) smallest = l;
        if (r < len && heap[r]! < heap[smallest]!) smallest = r;
        if (smallest === i) break;
        const tmp = heap[i]!;
        heap[i] = heap[smallest]!;
        heap[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  };

  for (let i = 0; i < n; i += 1) {
    if (inDegree[i] === 0) pushHeap(i);
  }

  const ordered: T[] = [];
  while (heap.length > 0) {
    const cur = popHeap();
    ordered.push(items[cur]!);
    for (const next of dependents[cur]!) {
      const deg = inDegree[next]! - 1;
      inDegree[next] = deg;
      if (deg === 0) {
        pushHeap(next);
      }
    }
  }

  if (ordered.length < n) {
    let cycleRef = items[0]!.sourceRef;
    for (let i = 0; i < n; i += 1) {
      if (inDegree[i]! > 0) {
        cycleRef = items[i]!.sourceRef;
        break;
      }
    }
    throw new MindError(
      "INVALID_INPUT",
      `Supersedes cycle detected involving "${cycleRef}". Break the cycle before importing.`,
      { reason: "supersedes_cycle", sourceRef: cycleRef },
    );
  }

  return ordered;
}

function normalizeDeclaredTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)
    ? trimmed.replace(" ", "T")
    : trimmed;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function isDateOnlyLiteral(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw.trim().replace(/^["']|["']$/g, ""));
}

/**
 * Resolves the highest-precedence declared timestamp while preserving sub-day precision:
 * if the highest-priority candidate is date-only (`YYYY-MM-DD`) and a lower-priority
 * candidate on the same calendar day supplies an exact time-of-day, upgrade to the
 * exact timestamp so same-day records never invert on ingestion-order tie-breaks.
 */
export function resolveMostPreciseDeclaredTimestamp(
  candidates: unknown[],
): string | null {
  let primaryIso: string | null = null;
  let primaryDateOnlyDay: string | null = null;

  for (const raw of candidates) {
    const iso = normalizeDeclaredTimestamp(raw);
    if (!iso) continue;
    if (!primaryIso) {
      primaryIso = iso;
      if (isDateOnlyLiteral(raw)) {
        primaryDateOnlyDay = String(raw)
          .trim()
          .replace(/^["']|["']$/g, "")
          .slice(0, 10);
      } else {
        return primaryIso;
      }
      continue;
    }
    if (primaryDateOnlyDay && !isDateOnlyLiteral(raw)) {
      const rawDay = String(raw)
        .trim()
        .replace(/^["']|["']$/g, "")
        .slice(0, 10);
      if (rawDay === primaryDateOnlyDay || iso.slice(0, 10) === primaryDateOnlyDay) {
        return iso;
      }
    }
  }
  return primaryIso;
}

function getAllFields(
  obj: Record<string, unknown>,
  spec?: string | string[],
): unknown[] {
  if (!spec) return [];
  const paths = Array.isArray(spec) ? spec : [spec];
  const out: unknown[] = [];
  for (const p of paths) {
    const v = getFieldByPath(obj, p);
    if (v !== undefined && v !== null && v !== "") out.push(v);
  }
  return out;
}

function validateMappingConfig(mapping?: ImportMappingConfig): RegExp | null {
  if (!mapping) return null;
  if (mapping.target && mapping.target !== "record" && mapping.target !== "seabed") {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid mapping target "${String(mapping.target)}": expected "record" or "seabed"`,
    );
  }
  if (mapping.statusMap) {
    for (const [src, target] of Object.entries(mapping.statusMap)) {
      const normalized = String(target).trim().toLowerCase();
      if (normalized !== "active" && normalized !== "superseded") {
        throw new MindError(
          "INVALID_INPUT",
          `Invalid statusMap target "${String(target)}" for source status "${src}": only "active" or "superseded" is permitted ("retracted" is reserved exclusively for redact())`,
        );
      }
    }
  }
  if (mapping.filenameDatePattern) {
    try {
      return new RegExp(mapping.filenameDatePattern);
    } catch (err) {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid filenameDatePattern regex "${mapping.filenameDatePattern}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return null;
}

function resolveTargetLayer(
  explicit?: string,
  mapping?: ImportMappingConfig,
): ImportTargetLayer {
  const raw = (explicit ?? mapping?.target ?? "record").trim().toLowerCase();
  if (raw !== "record" && raw !== "seabed") {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid --target "${raw}": expected "record" or "seabed"`,
    );
  }
  return raw;
}

function resolveMappedInitialStatus(params: {
  rawStatus: unknown;
  rawValidUntil: unknown;
  statusMap?: Record<string, string>;
  nowIso: string;
}): "active" | "superseded" {
  let mapped: "active" | "superseded" | null = null;
  if (
    params.rawStatus !== undefined &&
    params.rawStatus !== null &&
    String(params.rawStatus).trim()
  ) {
    const rawStr = String(params.rawStatus).trim();
    const rawLower = rawStr.toLowerCase();
    let targetVal: string | undefined;
    if (params.statusMap) {
      if (rawStr in params.statusMap) {
        targetVal = params.statusMap[rawStr];
      } else {
        for (const [k, v] of Object.entries(params.statusMap)) {
          if (k.toLowerCase() === rawLower) {
            targetVal = v;
            break;
          }
        }
      }
    }
    const candidate = (targetVal ?? rawLower).trim().toLowerCase();
    if (candidate === "retracted") {
      throw new MindError(
        "INVALID_INPUT",
        `Source status "${rawStr}" cannot map to "retracted" ("retracted" is reserved exclusively for redact())`,
      );
    }
    if (candidate === "superseded") {
      mapped = "superseded";
    } else if (candidate === "active") {
      mapped = "active";
    } else if (targetVal !== undefined) {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid mapped status "${targetVal}" for "${rawStr}": expected "active" or "superseded"`,
      );
    }
  }

  if (mapped === "superseded") {
    return "superseded";
  }

  const validUntilIso = normalizeDeclaredTimestamp(params.rawValidUntil);
  if (validUntilIso && validUntilIso < params.nowIso) {
    return "superseded";
  }

  return mapped ?? "active";
}

export interface ParsedMarkdownDoc {
  title: string;
  summary: string;
  body: string;
  occurredAt: string | null;
  frontmatter: Record<string, unknown>;
  tags: string[];
  sensitivity: Sensitivity | null;
  kind: RecordKind | null;
  externalRef: string | null;
}

function parseScalarYamlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  return trimmed;
}

/**
 * Parses a Markdown document to extract frontmatter, explicit timestamps
 * (NEVER filesystem mtime), title, summary section, and optional valid resource tags.
 */
export function parseMarkdownDocument(
  rawContent: string,
  fallbackTitle: string,
): ParsedMarkdownDoc {
  const content = rawContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const frontmatter: Record<string, unknown> = {};
  let body = content;

  // 1. Parse optional YAML frontmatter delimited by ---
  const fmMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (fmMatch) {
    const fmBlock = fmMatch[1] ?? "";
    body = content.slice(fmMatch[0].length);
    const lines = fmBlock.split("\n");
    let currentListKey: string | null = null;
    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const listItem = /^\s*-\s+(.+)$/.exec(line);
      if (listItem && currentListKey) {
        const existing = frontmatter[currentListKey];
        const arr = Array.isArray(existing) ? existing : [];
        arr.push(parseScalarYamlValue(listItem[1]!));
        frontmatter[currentListKey] = arr;
        continue;
      }
      const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) {
        const key = kv[1]!.trim();
        const valRaw = kv[2]!.trim();
        if (!valRaw) {
          frontmatter[key] = [];
          currentListKey = key;
        } else {
          frontmatter[key] = parseScalarYamlValue(valRaw);
          currentListKey = null;
        }
      } else {
        currentListKey = null;
      }
    }
  }

  // 2. Extract explicit declared timestamp from frontmatter or top metadata lines (NEVER mtime)
  const timeKeys = [
    "occurred_at",
    "occurredAt",
    "updated_at",
    "updatedAt",
    "valid_from",
    "validFrom",
    "created_at",
    "createdAt",
    "date",
    "timestamp",
  ];
  const fmCandidates: unknown[] = [];
  for (const key of timeKeys) {
    if (key in frontmatter) {
      fmCandidates.push(frontmatter[key]);
    }
  }
  let occurredAt = resolveMostPreciseDeclaredTimestamp(fmCandidates);

  if (!occurredAt) {
    const headerLines = body.split("\n").slice(0, 30);
    const headerCandidates: unknown[] = [];
    for (const line of headerLines) {
      const m =
        /^\s*(?:[-*]\s*)?(?:\*\*)?(occurred_at|updated_at|valid_from|created_at|date|timestamp)(?:\*\*)?\s*[:：]\s*(.+)$/i.exec(
          line,
        );
      if (m) {
        headerCandidates.push(m[2]);
      }
    }
    occurredAt = resolveMostPreciseDeclaredTimestamp(headerCandidates);
  }

  // 3. Title: frontmatter title -> first # H1 heading -> fallbackTitle
  let title =
    typeof frontmatter.title === "string" && frontmatter.title.trim()
      ? frontmatter.title.trim()
      : "";
  if (!title) {
    const h1 = /^#\s+(.+)$/m.exec(body);
    if (h1 && h1[1]?.trim()) {
      title = h1[1].trim();
    } else {
      title = fallbackTitle;
    }
  }

  // 4. Summary: frontmatter summary -> explicit Summary/Overview/Abstract/TL;DR section -> first paragraph
  let summary =
    typeof frontmatter.summary === "string" && frontmatter.summary.trim()
      ? frontmatter.summary.trim()
      : "";
  if (!summary) {
    const summaryHeadingRe =
      /^##\s+(?:Summary|Overview|Abstract|TL;DR|Executive Summary|摘要|核心摘要|概述)\s*$/im;
    const match = summaryHeadingRe.exec(body);
    if (match) {
      const after = body.slice(match.index + match[0].length);
      const nextHeading = /^#{1,2}\s+/m.exec(after);
      const sectionText = (
        nextHeading ? after.slice(0, nextHeading.index) : after
      ).trim();
      if (sectionText) {
        summary = sectionText.slice(0, 800);
      }
    }
  }
  if (!summary) {
    const paragraphs = body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !p.startsWith("#") && !p.startsWith("---"));
    if (paragraphs.length > 0) {
      summary = paragraphs[0]!.slice(0, 800);
    }
  }

  // 5. Optional resource tags from frontmatter (only valid <type>:<name> tags)
  const rawTags: unknown[] = [];
  for (const k of ["resource_tags", "resourceTags", "tags"]) {
    const v = frontmatter[k];
    if (Array.isArray(v)) rawTags.push(...v);
    else if (typeof v === "string" && v.trim()) rawTags.push(v.trim());
  }
  const tags: string[] = [];
  for (const rt of rawTags) {
    if (typeof rt !== "string") continue;
    try {
      tags.push(normalizeResourceTag(rt));
    } catch {
      // Ignore plain non-<type>:<name> markdown tags unless formatted as resource tag
    }
  }

  const rawSens =
    typeof frontmatter.sensitivity === "string"
      ? frontmatter.sensitivity.trim().toLowerCase()
      : "";
  const sensitivity = VALID_SENSITIVITIES.has(rawSens)
    ? (rawSens as Sensitivity)
    : null;

  const rawKind =
    typeof frontmatter.kind === "string"
      ? frontmatter.kind.trim().toLowerCase()
      : "";
  const kind = VALID_RECORD_KINDS.has(rawKind) ? (rawKind as RecordKind) : null;

  const externalRef =
    typeof frontmatter.external_ref === "string" &&
    frontmatter.external_ref.trim()
      ? frontmatter.external_ref.trim()
      : typeof frontmatter.externalRef === "string" &&
          frontmatter.externalRef.trim()
        ? frontmatter.externalRef.trim()
        : null;

  return {
    title,
    summary,
    body: body.trim(),
    occurredAt,
    frontmatter,
    tags: Array.from(new Set(tags)),
    sensitivity,
    kind,
    externalRef,
  };
}

function collectMarkdownFiles(
  inputPath: string,
  explicitBaseDir?: string,
  options?: { includeNonRegular?: boolean },
): {
  baseDir: string;
  isSingleFile: boolean;
  files: string[];
  symlinkDirs: string[];
  symlinkFiles: string[];
} {
  const abs = path.resolve(inputPath);
  if (!fs.existsSync(abs)) {
    throw new MindError("NOT_FOUND", `Markdown path not found: ${inputPath}`);
  }
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (explicitBaseDir) {
      const resolvedBase = path.resolve(explicitBaseDir);
      const rel = path.relative(resolvedBase, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new MindError(
          "INVALID_INPUT",
          `Markdown file "${inputPath}" is outside baseDir "${explicitBaseDir}"`,
        );
      }
      return {
        baseDir: resolvedBase,
        isSingleFile: true,
        files: [abs],
        symlinkDirs: [],
        symlinkFiles: [],
      };
    }
    return {
      baseDir: path.dirname(abs),
      isSingleFile: true,
      files: [abs],
      symlinkDirs: [],
      symlinkFiles: [],
    };
  }
  if (!stat.isDirectory()) {
    throw new MindError(
      "INVALID_INPUT",
      `Unsupported path type for import-md: ${inputPath}`,
    );
  }
  const files: string[] = [];
  const symlinkDirs: string[] = [];
  const symlinkFiles: string[] = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isSymbolicLink()) {
        // Never follow symlinks during directory walk (prevents corpus escape & keeps import/verify 100% aligned)
        if (options?.includeNonRegular) {
          try {
            const targetStat = fs.statSync(full);
            if (targetStat.isDirectory()) {
              symlinkDirs.push(full);
            } else if (/\.md$/i.test(entry.name)) {
              symlinkFiles.push(full);
            }
          } catch {
            if (/\.md$/i.test(entry.name)) {
              symlinkFiles.push(full);
            } else {
              symlinkDirs.push(full);
            }
          }
        }
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(abs);
  if (explicitBaseDir) {
    const resolvedBase = path.resolve(explicitBaseDir);
    const rel = path.relative(resolvedBase, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new MindError(
        "INVALID_INPUT",
        `Markdown directory "${inputPath}" is outside baseDir "${explicitBaseDir}"`,
      );
    }
    return {
      baseDir: resolvedBase,
      isSingleFile: false,
      files,
      symlinkDirs,
      symlinkFiles,
    };
  }
  return {
    baseDir: abs,
    isSingleFile: false,
    files,
    symlinkDirs,
    symlinkFiles,
  };
}

function deriveDefaultSourceRef(params: {
  filePath: string;
  baseDir: string;
  isSingleFile: boolean;
  hasExplicitBaseDir: boolean;
}): string {
  if (!params.isSingleFile || params.hasExplicitBaseDir) {
    const rel = path
      .relative(params.baseDir, params.filePath)
      .split(path.sep)
      .join("/");
    return normalizeSourceRef(rel || path.basename(params.filePath));
  }
  const parentName = path.basename(path.dirname(params.filePath));
  const baseName = path.basename(params.filePath);
  return normalizeSourceRef(
    parentName ? `${parentName}/${baseName}` : baseName,
  );
}

function getFieldByPath(obj: Record<string, unknown>, dotPath?: string): unknown {
  if (!dotPath) return undefined;
  const parts = dotPath.split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function getFirstField(
  obj: Record<string, unknown>,
  spec?: string | string[],
): unknown {
  if (!spec) return undefined;
  const paths = Array.isArray(spec) ? spec : [spec];
  for (const p of paths) {
    const val = getFieldByPath(obj, p);
    if (val !== undefined && val !== null && val !== "") {
      return val;
    }
  }
  return undefined;
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val
      .map((item) =>
        typeof item === "string" ? item.trim() : String(item ?? "").trim(),
      )
      .filter(Boolean);
  }
  if (typeof val === "string" && val.trim()) {
    return [val.trim()];
  }
  return [];
}

function extractFilenameDate(
  regex: RegExp | null,
  filePath: string,
  sourceRef: string,
): string | null {
  if (!regex) return null;
  const base = path.basename(filePath).normalize("NFC");
  const m = regex.exec(base) ?? regex.exec(sourceRef);
  if (!m) return null;
  const raw = m[1] ?? m[0];
  return normalizeDeclaredTimestamp(raw);
}

// ---- Pure Client-Side Planners (Zero DB / Network I/O; shared by local & remote CLI) ----

export interface PlanMarkdownImportResult {
  items: ImportBatchItemInput[];
  totalFiles: number;
  excludedCount: number;
  undatedCount: number;
  defaultRealmCount: number;
  baseDir: string;
}

export function planMarkdownImport(params: {
  inputPath: string;
  baseDir?: string;
  sourceRef?: string;
  target?: ImportTargetLayer;
  targetRealmRef?: string;
  kind?: string;
  extKind?: string;
  sensitivity?: Sensitivity;
  objectRefs?: string[];
  resourceTags?: string[];
  mapping?: ImportMappingConfig;
  exclude?: string[];
  maxItemBytes?: number;
  nowIso?: string;
}): PlanMarkdownImportResult {
  const mapping = params.mapping;
  const filenameDateRe = validateMappingConfig(mapping);
  const target = resolveTargetLayer(params.target, mapping);
  const maxItemBytes = params.maxItemBytes ?? MAX_IMPORT_ITEM_BYTES;
  const nowIso = params.nowIso ?? new Date().toISOString();
  const excludePatterns = params.exclude ?? [];

  const { baseDir, isSingleFile, files: rawFiles } = collectMarkdownFiles(
    params.inputPath,
    params.baseDir,
  );
  const hasExplicitBaseDir = Boolean(params.baseDir?.trim());

  const files: string[] = [];
  let excludedCount = 0;
  for (const filePath of rawFiles) {
    const relPathNfc = normalizeSourceRef(
      path.relative(baseDir, filePath).split(path.sep).join("/") ||
        path.basename(filePath),
    );
    if (matchesExcludePattern(relPathNfc, excludePatterns)) {
      excludedCount += 1;
      continue;
    }
    files.push(filePath);
  }

  if (params.sourceRef && files.length > 1) {
    throw new MindError(
      "INVALID_INPUT",
      "Explicit sourceRef can only be used when importing a single Markdown file",
    );
  }

  // Pre-check file sizes before parsing so failures abort cleanly before any write
  for (const filePath of files) {
    const sizeBytes = fs.statSync(filePath).size;
    if (sizeBytes > maxItemBytes) {
      throw new MindError(
        "INVALID_INPUT",
        `Markdown file exceeds ${maxItemBytes} byte import limit (${sizeBytes} bytes): ${filePath}`,
        {
          reason: "item_too_large",
          filePath,
          sizeBytes,
          limitBytes: maxItemBytes,
          try: "Run 'meru-mind import md <path> --dry-run' to list oversized files, or split/store raw attachments externally.",
        },
      );
    }
  }

  const extraTags = (params.resourceTags ?? []).map((t) =>
    normalizeResourceTag(t),
  );
  const items: ImportBatchItemInput[] = [];
  let undatedCount = 0;
  let defaultRealmCount = 0;

  for (const filePath of files) {
    const rawBuf = fs.readFileSync(filePath);
    const rawContent = decodeUtf8Strict(rawBuf, filePath);
    const rawContentSha256 = sha256Text(rawContent);
    const sourceRef = normalizeSourceRef(
      params.sourceRef?.trim() ||
        deriveDefaultSourceRef({
          filePath,
          baseDir,
          isSingleFile,
          hasExplicitBaseDir,
        }),
    );
    const fallbackTitle = path
      .basename(filePath, path.extname(filePath))
      .normalize("NFC");
    const parsed = parseMarkdownDocument(rawContent, fallbackTitle);
    const fm = parsed.frontmatter;

    const mappedOccurred = mapping?.occurredAt
      ? resolveMostPreciseDeclaredTimestamp(getAllFields(fm, mapping.occurredAt))
      : null;
    const occurredAt: string | null =
      mappedOccurred ??
      parsed.occurredAt ??
      extractFilenameDate(filenameDateRe, filePath, sourceRef);
    if (occurredAt === null) {
      undatedCount += 1;
    }

    const rawMappedSens = mapping?.sensitivity
      ? getFieldByPath(fm, mapping.sensitivity)
      : undefined;
    const mappedSens =
      typeof rawMappedSens === "string" &&
      VALID_SENSITIVITIES.has(rawMappedSens.trim().toLowerCase())
        ? (rawMappedSens.trim().toLowerCase() as Sensitivity)
        : null;
    const sensitivity: Sensitivity =
      params.sensitivity ??
      mappedSens ??
      parsed.sensitivity ??
      mapping?.defaultSensitivity ??
      "internal";

    let realmRef: string | undefined;
    if (mapping?.realmPath) {
      const rawRealmVal = getFieldByPath(fm, mapping.realmPath);
      const rawRealmStr =
        rawRealmVal !== undefined && rawRealmVal !== null
          ? String(rawRealmVal).trim()
          : "";
      const mappedRealmRef = rawRealmStr
        ? (mapping.realmMap?.[rawRealmStr] ?? rawRealmStr)
        : "";
      if (mappedRealmRef) {
        realmRef = mappedRealmRef.trim();
      }
    }
    if (!realmRef) {
      defaultRealmCount += 1;
    }

    const initialStatus = resolveMappedInitialStatus({
      rawStatus: mapping?.status ? getFieldByPath(fm, mapping.status) : fm.status,
      rawValidUntil: mapping?.validUntil
        ? getFirstField(fm, mapping.validUntil)
        : (fm.valid_until ?? fm.validUntil),
      statusMap: mapping?.statusMap,
      nowIso,
    });

    let mappedKind: string | undefined;
    if (mapping?.kind) {
      const rawK = getFieldByPath(fm, mapping.kind);
      if (typeof rawK === "string" && rawK.trim()) {
        mappedKind = mapping.kindMap?.[rawK.trim()] ?? rawK.trim();
      }
    }
    const desiredKind =
      params.kind?.trim() ||
      mappedKind ||
      (target === "record" ? (parsed.kind ?? undefined) : undefined) ||
      mapping?.defaultKind?.trim() ||
      (target === "seabed" ? "artifact" : "claim");

    const objectRefs = [...(params.objectRefs ?? [])];
    if (mapping?.objectRefs) {
      for (const ref of toStringArray(getFieldByPath(fm, mapping.objectRefs))) {
        objectRefs.push(mapping.objectMap?.[ref] ?? ref);
      }
    }

    const mappedTags: string[] = [];
    if (mapping?.resourceTags) {
      for (const t of toStringArray(getFieldByPath(fm, mapping.resourceTags))) {
        const candidate =
          !t.includes(":") && mapping.defaultTagType
            ? `${mapping.defaultTagType}:${t}`
            : t;
        mappedTags.push(normalizeResourceTag(candidate));
      }
    }
    const resourceTags = Array.from(
      new Set([...extraTags, ...parsed.tags, ...mappedTags]),
    );

    const extraPayload: Record<string, unknown> = {};
    if (mapping?.extractFields && mapping.extractFields.length > 0) {
      for (const fp of mapping.extractFields) {
        const key = fp.replace(/\./g, "_");
        if (RESERVED_EXTRA_PAYLOAD_KEYS.has(key)) continue;
        const val = getFieldByPath(fm, fp);
        if (val !== undefined) {
          extraPayload[key] = val;
        }
      }
    }

    // P1-1: Only read supersedes from frontmatter when mapping.supersedes is explicitly configured
    const rawSupersedes = mapping?.supersedes
      ? toStringArray(getFieldByPath(fm, mapping.supersedes))
      : [];
    const supersedesIds: string[] = [];
    const supersedesSourceRefs: string[] = [];
    for (const s of rawSupersedes) {
      if (s.startsWith("rec_")) supersedesIds.push(s);
      else supersedesSourceRefs.push(normalizeSourceRef(s));
    }

    const item: ImportBatchItemInput =
      target === "seabed"
        ? {
            target: "seabed",
            sourceRef,
            ...(realmRef ? { realmRef } : {}),
            kind: VALID_SEABED_KINDS.has(desiredKind) ? desiredKind : "artifact",
            text: rawContent,
            contentSha256: rawContentSha256,
            rawContentSha256,
            ...(Object.keys(extraPayload).length > 0 ? { extraPayload } : {}),
            ...(objectRefs.length > 0
              ? { objectRefs: Array.from(new Set(objectRefs)) }
              : {}),
            ...(resourceTags.length > 0 ? { resourceTags } : {}),
            occurredAt,
            sensitivity,
            filePath,
          }
        : {
            target: "record",
            sourceRef,
            ...(realmRef ? { realmRef } : {}),
            kind: VALID_RECORD_KINDS.has(desiredKind) ? desiredKind : "claim",
            ...(params.extKind ? { extKind: params.extKind } : {}),
            title: parsed.title,
            summary: parsed.summary,
            body: parsed.body,
            contentSha256: sha256Text(parsed.body),
            rawContentSha256,
            ...(Object.keys(fm).length > 0 ? { frontmatter: fm } : {}),
            ...(Object.keys(extraPayload).length > 0 ? { extraPayload } : {}),
            ...(parsed.externalRef ? { externalRef: parsed.externalRef } : {}),
            ...(objectRefs.length > 0
              ? { objectRefs: Array.from(new Set(objectRefs)) }
              : {}),
            ...(resourceTags.length > 0 ? { resourceTags } : {}),
            ...(supersedesIds.length > 0 ? { supersedesIds } : {}),
            ...(supersedesSourceRefs.length > 0 ? { supersedesSourceRefs } : {}),
            initialStatus,
            occurredAt,
            sensitivity,
            filePath,
          };

    const itemBytes = serializeByteLength(item);
    if (itemBytes > maxItemBytes) {
      throw new MindError(
        "INVALID_INPUT",
        `Import item "${sourceRef}" exceeds ${maxItemBytes} byte import limit (${itemBytes} serialized UTF-8 bytes).`,
        {
          reason: "item_too_large",
          sourceRef,
          filePath,
          sizeBytes: itemBytes,
          limitBytes: maxItemBytes,
        },
      );
    }

    items.push(item);
  }

  const ordered = topologicalSortImportItems(items);
  return {
    items: ordered,
    totalFiles: files.length,
    excludedCount,
    undatedCount,
    defaultRealmCount,
    baseDir,
  };
}

export interface PlanJsonlImportResult {
  items: ImportBatchItemInput[];
  totalRows: number;
  undatedCount: number;
  defaultRealmCount: number;
}

export function planJsonlImport(params: {
  jsonlPath: string;
  mapping: ImportMappingConfig;
  target?: ImportTargetLayer;
  targetRealmRef?: string;
  maxItemBytes?: number;
  nowIso?: string;
}): PlanJsonlImportResult {
  const mapping = params.mapping;
  validateMappingConfig(mapping);
  const target = resolveTargetLayer(params.target, mapping);
  const maxItemBytes = params.maxItemBytes ?? MAX_IMPORT_ITEM_BYTES;
  const nowIso = params.nowIso ?? new Date().toISOString();
  const sourceRefPrefix = mapping.idempotencyPrefix?.trim() || "import-jsonl";

  if (!fs.existsSync(params.jsonlPath)) {
    throw new MindError(
      "NOT_FOUND",
      `JSONL file not found: ${params.jsonlPath}`,
    );
  }

  const rawBuf = fs.readFileSync(params.jsonlPath);
  const rawText = decodeUtf8Strict(rawBuf, params.jsonlPath);
  const rawLines = rawText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");

  interface PlannedJsonlEntry {
    lineNumber: number;
    occurredAt: string | null;
    item: ImportBatchItemInput;
  }

  const entries: PlannedJsonlEntry[] = [];
  let undatedCount = 0;
  let defaultRealmCount = 0;

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid JSON on line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MindError(
        "INVALID_INPUT",
        `Expected JSON object on line ${i + 1}`,
      );
    }
    const row = parsed as Record<string, unknown>;
    const rawId = getFieldByPath(row, mapping.id);
    const sourceId =
      rawId !== undefined && rawId !== null && String(rawId).trim()
        ? normalizeSourceRef(String(rawId))
        : null;
    const rawSourceRef = getFieldByPath(row, mapping.sourceRef);
    const sourceRef = normalizeSourceRef(
      typeof rawSourceRef === "string" && rawSourceRef.trim()
        ? rawSourceRef
        : sourceId
          ? `${sourceRefPrefix}:${sourceId}`
          : `${sourceRefPrefix}:line-${i + 1}`,
    );
    const occurredAt = resolveMostPreciseDeclaredTimestamp(
      getAllFields(row, mapping.occurredAt),
    );
    if (occurredAt === null) {
      undatedCount += 1;
    }

    const rawSens = getFieldByPath(row, mapping.sensitivity);
    const sensitivity: Sensitivity =
      typeof rawSens === "string" &&
      VALID_SENSITIVITIES.has(rawSens.trim().toLowerCase())
        ? (rawSens.trim().toLowerCase() as Sensitivity)
        : (mapping.defaultSensitivity ?? "internal");

    const rawRealmVal = getFieldByPath(row, mapping.realmPath);
    const rawRealmStr =
      rawRealmVal !== undefined && rawRealmVal !== null
        ? String(rawRealmVal).trim()
        : "";
    const mappedRealmRef = rawRealmStr
      ? (mapping.realmMap?.[rawRealmStr] ?? rawRealmStr)
      : "";
    let realmRef: string | undefined;
    if (mappedRealmRef) {
      realmRef = mappedRealmRef.trim();
    } else {
      defaultRealmCount += 1;
    }

    const objectRefs = toStringArray(getFieldByPath(row, mapping.objectRefs)).map(
      (ref) => mapping.objectMap?.[ref] ?? ref,
    );

    const resourceTags = toStringArray(
      getFieldByPath(row, mapping.resourceTags),
    ).map((t) => {
      const candidate =
        !t.includes(":") && mapping.defaultTagType
          ? `${mapping.defaultTagType}:${t}`
          : t;
      return normalizeResourceTag(candidate);
    });

    const rawTitle = getFirstField(row, mapping.title);
    const rawBody = getFirstField(row, mapping.body);
    const bodyStr =
      typeof rawBody === "string"
        ? rawBody
        : rawBody !== undefined && rawBody !== null
          ? JSON.stringify(rawBody)
          : "";
    const titleStr =
      typeof rawTitle === "string" && rawTitle.trim()
        ? rawTitle.trim()
        : bodyStr
          ? bodyStr.slice(0, 120)
          : sourceId || `Imported row #${i + 1}`;

    const extraPayload: Record<string, unknown> = {};
    if (mapping.extractFields && mapping.extractFields.length > 0) {
      for (const fieldPath of mapping.extractFields) {
        const key = fieldPath.includes(".")
          ? fieldPath.replace(/\./g, "_")
          : fieldPath;
        if (RESERVED_EXTRA_PAYLOAD_KEYS.has(key)) continue;
        const val = getFieldByPath(row, fieldPath);
        if (val !== undefined) {
          extraPayload[key] = val;
        }
      }
    }

    const rowPayloadHash = computePayloadHash(row);
    const rawKind = getFieldByPath(row, mapping.kind);
    const mappedKind =
      typeof rawKind === "string" && rawKind.trim()
        ? (mapping.kindMap?.[rawKind.trim()] ?? rawKind.trim())
        : (mapping.defaultKind ?? (target === "seabed" ? "evidence" : "claim"));

    const rawExtKind = getFieldByPath(row, mapping.extKind);
    const extKind =
      typeof rawExtKind === "string" && rawExtKind.trim()
        ? rawExtKind.trim()
        : undefined;

    const rawExternalRef = getFieldByPath(row, mapping.externalRef);
    const externalRef =
      typeof rawExternalRef === "string" && rawExternalRef.trim()
        ? rawExternalRef.trim()
        : undefined;

    const rawThingRef = getFieldByPath(row, mapping.thingRef);
    const thingRef =
      typeof rawThingRef === "string" && rawThingRef.trim()
        ? rawThingRef.trim()
        : undefined;

    const refs = toStringArray(getFieldByPath(row, mapping.refs));

    const rawSupersedes = Array.from(
      new Set(toStringArray(getFieldByPath(row, mapping.supersedes))),
    );
    const supersedesIds: string[] = [];
    const supersedesSourceRefs: string[] = [];
    for (const s of rawSupersedes) {
      if (s.startsWith("rec_")) supersedesIds.push(s);
      else supersedesSourceRefs.push(normalizeSourceRef(s));
    }

    const initialStatus = resolveMappedInitialStatus({
      rawStatus: mapping.status ? getFieldByPath(row, mapping.status) : undefined,
      rawValidUntil: mapping.validUntil
        ? getFirstField(row, mapping.validUntil)
        : undefined,
      statusMap: mapping.statusMap,
      nowIso,
    });

    const item: ImportBatchItemInput =
      target === "seabed"
        ? {
            target: "seabed",
            sourceRef,
            ...(realmRef ? { realmRef } : {}),
            kind: VALID_SEABED_KINDS.has(mappedKind) ? mappedKind : "evidence",
            text: bodyStr || titleStr,
            contentSha256: sha256Text(bodyStr || titleStr),
            rawContentSha256: rowPayloadHash,
            ...(Object.keys(extraPayload).length > 0 ? { extraPayload } : {}),
            ...(sourceId ? { sourceId } : {}),
            ...(objectRefs.length > 0 ? { objectRefs } : {}),
            ...(resourceTags.length > 0 ? { resourceTags } : {}),
            occurredAt,
            sensitivity,
            idempotencyPrefix: "import-jsonl",
          }
        : {
            target: "record",
            sourceRef,
            ...(realmRef ? { realmRef } : {}),
            kind: VALID_RECORD_KINDS.has(mappedKind) ? mappedKind : "claim",
            ...(extKind ? { extKind } : {}),
            title: titleStr,
            body: bodyStr,
            contentSha256: sha256Text(bodyStr),
            rawContentSha256: rowPayloadHash,
            ...(Object.keys(extraPayload).length > 0 ? { extraPayload } : {}),
            ...(externalRef ? { externalRef } : {}),
            ...(sourceId ? { sourceId } : {}),
            ...(thingRef ? { thingRef } : {}),
            ...(objectRefs.length > 0 ? { objectRefs } : {}),
            ...(resourceTags.length > 0 ? { resourceTags } : {}),
            ...(refs.length > 0 ? { refs } : {}),
            ...(supersedesIds.length > 0 ? { supersedesIds } : {}),
            ...(supersedesSourceRefs.length > 0 ? { supersedesSourceRefs } : {}),
            initialStatus,
            occurredAt,
            sensitivity,
            idempotencyPrefix: "import-jsonl",
          };

    const itemBytes = serializeByteLength(item);
    if (itemBytes > maxItemBytes) {
      throw new MindError(
        "INVALID_INPUT",
        `JSONL row #${i + 1} ("${sourceRef}") exceeds ${maxItemBytes} byte import limit (${itemBytes} serialized UTF-8 bytes).`,
        {
          reason: "item_too_large",
          sourceRef,
          lineNumber: i + 1,
          sizeBytes: itemBytes,
          limitBytes: maxItemBytes,
        },
      );
    }

    entries.push({ lineNumber: i + 1, occurredAt, item });
  }

  entries.sort((a, b) => {
    if (a.occurredAt && b.occurredAt && a.occurredAt !== b.occurredAt) {
      return a.occurredAt.localeCompare(b.occurredAt);
    }
    if (a.occurredAt && !b.occurredAt) return -1;
    if (!a.occurredAt && b.occurredAt) return 1;
    return a.lineNumber - b.lineNumber;
  });

  const ordered = topologicalSortImportItems(entries.map((e) => e.item));
  return {
    items: ordered,
    totalRows: ordered.length,
    undatedCount,
    defaultRealmCount,
  };
}

export function chunkImportBatchItems(
  items: ImportBatchItemInput[],
  options?: { maxItems?: number; maxChunkBytes?: number },
): ImportBatchItemInput[][] {
  const maxItems = Math.max(
    1,
    Math.min(MAX_IMPORT_BATCH_ITEMS, options?.maxItems ?? MAX_IMPORT_BATCH_ITEMS),
  );
  const maxChunkBytes = Math.max(
    1024,
    options?.maxChunkBytes ?? MAX_IMPORT_ITEM_BYTES,
  );
  if (items.length === 0) return [];

  const chunks: ImportBatchItemInput[][] = [];
  let current: ImportBatchItemInput[] = [];
  let currentBytes = 64;

  for (const item of items) {
    const itemBytes = serializeByteLength(item) + 2;
    if (
      current.length > 0 &&
      (current.length >= maxItems || currentBytes + itemBytes > maxChunkBytes)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 64;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export interface PlanSourceVerificationResult {
  items: VerifyImportManifestItem[];
  allExpectedSourceRefs: string[];
  allExpectedEntries: VerifyImportExpectedKey[];
  totalSourceFiles: number;
  excludedCount: number;
  unaccountedPaths: string[];
  undatedCount: number;
  defaultRealmFallbackCount: number;
}

export function planSourceVerification(params: {
  sourcePath: string;
  mapping?: ImportMappingConfig;
  baseDir?: string;
  target?: ImportTargetLayer;
  targetRealmRef?: string;
  defaultRealmRef?: string;
  skipSecret?: boolean;
  exclude?: string[];
  maxItemBytes?: number;
  nowIso?: string;
}): PlanSourceVerificationResult {
  const mapping = params.mapping;
  const filenameDateRe = validateMappingConfig(mapping);
  const target = resolveTargetLayer(params.target, mapping);
  const skipSecret = resolveImportSkipSecret(params.skipSecret, mapping);
  const excludePatterns = params.exclude ?? [];
  const maxItemBytes = params.maxItemBytes ?? MAX_IMPORT_ITEM_BYTES;
  const nowIso = params.nowIso ?? new Date().toISOString();
  const fallbackRealmRef =
    params.targetRealmRef?.trim() ||
    mapping?.defaultRealm?.trim() ||
    params.defaultRealmRef?.trim() ||
    "/";

  const abs = path.resolve(params.sourcePath);
  if (!fs.existsSync(abs)) {
    throw new MindError(
      "NOT_FOUND",
      `Source path not found: ${params.sourcePath}`,
    );
  }
  const stat = fs.statSync(abs);
  const isJsonl = stat.isFile() && /\.jsonl$/i.test(abs);

  const items: VerifyImportManifestItem[] = [];
  const allExpectedSourceRefs: string[] = [];
  const allExpectedEntries: VerifyImportExpectedKey[] = [];
  const unaccountedPaths: string[] = [];
  let totalSourceFiles = 0;
  let excludedCount = 0;
  let undatedCount = 0;
  let defaultRealmFallbackCount = 0;

  if (isJsonl) {
    if (!mapping) {
      throw new MindError(
        "INVALID_INPUT",
        "import verify requires --map <mapping.json> for JSONL sources",
      );
    }
    totalSourceFiles = 1;
    const rawBuf = fs.readFileSync(abs);
    let rawText: string;
    try {
      rawText = decodeUtf8Strict(rawBuf, params.sourcePath);
    } catch {
      return {
        items: [],
        allExpectedSourceRefs: [],
        allExpectedEntries: [],
        totalSourceFiles: 1,
        excludedCount: 0,
        unaccountedPaths: [`${path.basename(abs)} (invalid_utf8)`],
        undatedCount: 0,
        defaultRealmFallbackCount: 0,
      };
    }

    const sourceRefPrefix = mapping.idempotencyPrefix?.trim() || "import-jsonl";
    const rawLines = rawText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < rawLines.length; i += 1) {
      const line = rawLines[i]!.trim();
      if (!line) continue;
      let parsedRow: unknown;
      try {
        parsedRow = JSON.parse(line);
      } catch (err) {
        throw new MindError(
          "INVALID_INPUT",
          `Invalid JSON on line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!parsedRow || typeof parsedRow !== "object" || Array.isArray(parsedRow)) {
        throw new MindError(
          "INVALID_INPUT",
          `Expected JSON object on line ${i + 1}`,
        );
      }
      const row = parsedRow as Record<string, unknown>;
      const rawSens = getFieldByPath(row, mapping.sensitivity);
      const sensCandidate: Sensitivity =
        typeof rawSens === "string" &&
        VALID_SENSITIVITIES.has(rawSens.trim().toLowerCase())
          ? (rawSens.trim().toLowerCase() as Sensitivity)
          : (mapping.defaultSensitivity ?? "internal");

      const rawId = getFieldByPath(row, mapping.id);
      const sourceId =
        rawId !== undefined && rawId !== null && String(rawId).trim()
          ? normalizeSourceRef(String(rawId))
          : null;
      const rawSourceRef = getFieldByPath(row, mapping.sourceRef);
      const sourceRef = normalizeSourceRef(
        typeof rawSourceRef === "string" && rawSourceRef.trim()
          ? rawSourceRef
          : sourceId
            ? `${sourceRefPrefix}:${sourceId}`
            : `${sourceRefPrefix}:line-${i + 1}`,
      );

      const rawTitle = getFirstField(row, mapping.title);
      const rawBody = getFirstField(row, mapping.body);
      const bodyStr =
        typeof rawBody === "string"
          ? rawBody
          : rawBody !== undefined && rawBody !== null
            ? JSON.stringify(rawBody)
            : "";
      const titleStr =
        typeof rawTitle === "string" && rawTitle.trim()
          ? rawTitle.trim()
          : bodyStr
            ? bodyStr.slice(0, 120)
            : sourceId || `Imported row #${i + 1}`;
      const payloadText = target === "seabed" ? bodyStr || titleStr : bodyStr;
      const rawContentSha256 = computePayloadHash(row);

      const expectedOccurredAt = resolveMostPreciseDeclaredTimestamp(
        getAllFields(row, mapping.occurredAt),
      );
      if (expectedOccurredAt === null) undatedCount += 1;

      const rawRealmVal = getFieldByPath(row, mapping.realmPath);
      const rawRealmStr =
        rawRealmVal !== undefined && rawRealmVal !== null
          ? String(rawRealmVal).trim()
          : "";
      const mappedRealmRef = rawRealmStr
        ? (mapping.realmMap?.[rawRealmStr] ?? rawRealmStr)
        : "";
      let expectedRealmRef = fallbackRealmRef;
      if (mappedRealmRef) {
        expectedRealmRef = mappedRealmRef.trim();
      } else {
        defaultRealmFallbackCount += 1;
      }

      const expectedStatus = resolveMappedInitialStatus({
        rawStatus: mapping.status
          ? getFieldByPath(row, mapping.status)
          : undefined,
        rawValidUntil: mapping.validUntil
          ? getFirstField(row, mapping.validUntil)
          : undefined,
        statusMap: mapping.statusMap,
        nowIso,
      });

      const hasSecret =
        sensCandidate === "secret" ||
        Boolean(detectPlaintextSecret(JSON.stringify(row)));
      if (skipSecret && hasSecret) {
        items.push({
          sourceRef,
          target,
          expectedRealmRef,
          contentSha256: "",
          rawContentSha256,
          byteLength: 0,
          expectedStatus,
          expectedOccurredAt,
          secretSkipped: true,
        });
        continue;
      }

      allExpectedSourceRefs.push(sourceRef);
      allExpectedEntries.push({
        realmRef: expectedRealmRef,
        target,
        sourceRef,
      });
      items.push({
        sourceRef,
        target,
        expectedRealmRef,
        contentSha256: sha256Text(payloadText),
        rawContentSha256,
        byteLength: Buffer.byteLength(payloadText, "utf8"),
        ...(target === "record" ? { expectedTitle: titleStr } : {}),
        expectedStatus,
        expectedOccurredAt,
      });
    }
  } else {
    const { baseDir, isSingleFile, files, symlinkDirs, symlinkFiles } =
      collectMarkdownFiles(params.sourcePath, params.baseDir, {
        includeNonRegular: true,
      });
    const hasExplicitBaseDir = Boolean(params.baseDir?.trim());
    totalSourceFiles = files.length + symlinkDirs.length + symlinkFiles.length;

    for (const symDir of symlinkDirs) {
      const relPathNfc = normalizeSourceRef(
        path.relative(baseDir, symDir).split(path.sep).join("/") ||
          path.basename(symDir),
      );
      if (matchesExcludePattern(relPathNfc, excludePatterns)) {
        excludedCount += 1;
      } else {
        unaccountedPaths.push(`${relPathNfc} (symlink_dir)`);
      }
    }

    for (const symFile of symlinkFiles) {
      const relPathNfc = normalizeSourceRef(
        path.relative(baseDir, symFile).split(path.sep).join("/") ||
          path.basename(symFile),
      );
      if (matchesExcludePattern(relPathNfc, excludePatterns)) {
        excludedCount += 1;
      } else {
        unaccountedPaths.push(`${relPathNfc} (symlink_file)`);
      }
    }

    for (const filePath of files) {
      const relPathNfc = normalizeSourceRef(
        path.relative(baseDir, filePath).split(path.sep).join("/") ||
          path.basename(filePath),
      );
      if (matchesExcludePattern(relPathNfc, excludePatterns)) {
        excludedCount += 1;
        continue;
      }

      let fileStat: fs.Stats;
      try {
        fileStat = fs.statSync(filePath);
      } catch {
        unaccountedPaths.push(`${relPathNfc} (unreadable)`);
        continue;
      }
      if (!fileStat.isFile()) {
        unaccountedPaths.push(`${relPathNfc} (non_file)`);
        continue;
      }
      if (fileStat.size > maxItemBytes) {
        unaccountedPaths.push(
          `${relPathNfc} (oversized: ${fileStat.size} > ${maxItemBytes})`,
        );
        continue;
      }

      let rawContent: string;
      try {
        rawContent = decodeUtf8Strict(fs.readFileSync(filePath), relPathNfc);
      } catch {
        unaccountedPaths.push(`${relPathNfc} (invalid_utf8)`);
        continue;
      }

      const rawContentSha256 = sha256Text(rawContent);
      const sourceRef = deriveDefaultSourceRef({
        filePath,
        baseDir,
        isSingleFile,
        hasExplicitBaseDir,
      });
      const fallbackTitle = path
        .basename(filePath, path.extname(filePath))
        .normalize("NFC");
      const parsed = parseMarkdownDocument(rawContent, fallbackTitle);
      const fm = parsed.frontmatter;

      const rawMappedSens = mapping?.sensitivity
        ? getFieldByPath(fm, mapping.sensitivity)
        : undefined;
      const mappedSens =
        typeof rawMappedSens === "string" &&
        VALID_SENSITIVITIES.has(rawMappedSens.trim().toLowerCase())
          ? (rawMappedSens.trim().toLowerCase() as Sensitivity)
          : null;
      const sens: Sensitivity =
        mappedSens ??
        parsed.sensitivity ??
        mapping?.defaultSensitivity ??
        "internal";

      const mappedOccurred = mapping?.occurredAt
        ? resolveMostPreciseDeclaredTimestamp(
            getAllFields(fm, mapping.occurredAt),
          )
        : null;
      const expectedOccurredAt =
        mappedOccurred ??
        parsed.occurredAt ??
        extractFilenameDate(filenameDateRe, filePath, sourceRef);
      if (expectedOccurredAt === null) undatedCount += 1;

      let expectedRealmRef = fallbackRealmRef;
      let usedDefault = true;
      if (mapping?.realmPath) {
        const rawRealmVal = getFieldByPath(fm, mapping.realmPath);
        const rawRealmStr =
          rawRealmVal !== undefined && rawRealmVal !== null
            ? String(rawRealmVal).trim()
            : "";
        const mappedRealmRef = rawRealmStr
          ? (mapping.realmMap?.[rawRealmStr] ?? rawRealmStr)
          : "";
        if (mappedRealmRef) {
          expectedRealmRef = mappedRealmRef.trim();
          usedDefault = false;
        }
      }
      if (usedDefault) defaultRealmFallbackCount += 1;

      const expectedStatus = resolveMappedInitialStatus({
        rawStatus: mapping?.status
          ? getFieldByPath(fm, mapping.status)
          : fm.status,
        rawValidUntil: mapping?.validUntil
          ? getFirstField(fm, mapping.validUntil)
          : (fm.valid_until ?? fm.validUntil),
        statusMap: mapping?.statusMap,
        nowIso,
      });

      const payloadText = target === "seabed" ? rawContent : parsed.body;
      const hasSecret =
        sens === "secret" || Boolean(detectPlaintextSecret(rawContent));

      if (skipSecret && hasSecret) {
        items.push({
          sourceRef,
          target,
          expectedRealmRef,
          contentSha256: "",
          rawContentSha256,
          byteLength: 0,
          expectedStatus,
          expectedOccurredAt,
          secretSkipped: true,
          filePath,
        });
        continue;
      }

      allExpectedSourceRefs.push(sourceRef);
      allExpectedEntries.push({
        realmRef: expectedRealmRef,
        target,
        sourceRef,
      });
      items.push({
        sourceRef,
        target,
        expectedRealmRef,
        contentSha256: sha256Text(payloadText),
        rawContentSha256,
        byteLength: Buffer.byteLength(payloadText, "utf8"),
        ...(target === "record" ? { expectedTitle: parsed.title } : {}),
        expectedStatus,
        expectedOccurredAt,
        filePath,
      });
    }
  }

  return {
    items,
    allExpectedSourceRefs,
    allExpectedEntries,
    totalSourceFiles,
    excludedCount,
    unaccountedPaths,
    undatedCount,
    defaultRealmFallbackCount,
  };
}

export function chunkVerifyManifestItems(
  items: VerifyImportManifestItem[],
  maxItems = 200,
): VerifyImportManifestItem[][] {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.min(MAX_VERIFY_MANIFEST_ITEMS, maxItems));
  const chunks: VerifyImportManifestItem[][] = [];
  for (let i = 0; i < items.length; i += cap) {
    chunks.push(items.slice(i, i + cap));
  }
  return chunks;
}

export function mergeVerifyImportResults(
  parts: VerifyImportResult[],
  meta: {
    totalSourceFiles: number;
    excludedCount: number;
    unaccountedPaths: string[];
    allowSkips: number;
    checkedLayers?: ImportTargetLayer[];
    undatedCount?: number;
    defaultRealmFallbackCount?: number;
  },
): VerifyImportResult {
  let expectedCount = 0;
  let foundCount = 0;
  let missingCount = 0;
  let contentMismatchCount = 0;
  let realmMismatchCount = 0;
  let layerMismatchCount = 0;
  let statusMismatchCount = 0;
  let timestampMismatchCount = 0;
  let skippedSecretCount = 0;
  let skippedRedactedCount = 0;
  let totalChecked = 0;
  const mismatches: ImportConsistencyMismatch[] = [];
  const activeSupersededMismatches: ImportConsistencyMismatch[] = [];
  const timestampMismatches: ImportConsistencyMismatch[] = [];
  const unexpectedById = new Map<string, VerifyImportUnexpectedEntry>();

  for (const part of parts) {
    expectedCount += part.expectedCount;
    foundCount += part.foundCount;
    missingCount += part.missingCount;
    contentMismatchCount += part.contentMismatchCount;
    realmMismatchCount += part.realmMismatchCount;
    layerMismatchCount += part.layerMismatchCount;
    statusMismatchCount += part.statusMismatchCount;
    timestampMismatchCount += part.timestampMismatchCount;
    skippedSecretCount += part.skippedSecretCount;
    skippedRedactedCount += part.skippedRedactedCount;
    totalChecked += part.totalChecked;
    mismatches.push(...part.mismatches);
    activeSupersededMismatches.push(...part.activeSupersededMismatches);
    timestampMismatches.push(...part.timestampMismatches);
    for (const u of part.unexpectedEntries) {
      unexpectedById.set(u.entryId, u);
    }
  }

  const unexpectedEntries = Array.from(unexpectedById.values());
  const unaccountedCount = meta.unaccountedPaths.length;
  const unexpectedCount = unexpectedEntries.length;
  const allowSkips = Math.max(0, Math.floor(meta.allowSkips));

  const passed =
    unaccountedCount === 0 &&
    missingCount === 0 &&
    contentMismatchCount === 0 &&
    realmMismatchCount === 0 &&
    layerMismatchCount === 0 &&
    statusMismatchCount === 0 &&
    timestampMismatchCount === 0 &&
    unexpectedCount === 0 &&
    skippedSecretCount + skippedRedactedCount <= allowSkips;

  const checkedLayers =
    meta.checkedLayers ??
    parts.find((p) => p.checkedLayers && p.checkedLayers.length > 0)
      ?.checkedLayers;

  return {
    passed,
    totalSourceFiles: meta.totalSourceFiles,
    expectedCount,
    excludedCount: meta.excludedCount,
    unaccountedCount,
    unaccountedPaths: [...meta.unaccountedPaths],
    foundCount,
    missingCount,
    contentMismatchCount,
    realmMismatchCount,
    layerMismatchCount,
    statusMismatchCount,
    timestampMismatchCount,
    unexpectedCount,
    skippedSecretCount,
    skippedRedactedCount,
    allowSkips,
    ...(checkedLayers ? { checkedLayers } : {}),
    mismatches,
    unexpectedEntries,
    totalChecked,
    undatedCount: meta.undatedCount ?? 0,
    defaultRealmFallbackCount: meta.defaultRealmFallbackCount ?? 0,
    activeSupersededMismatches,
    timestampMismatches,
  };
}

const ISO_DATE_OR_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

function assertOptString(
  val: unknown,
  field: string,
  itemIndex: number,
  allowNull = true,
): string | null | undefined {
  if (val === undefined) return undefined;
  if (val === null && allowNull) return null;
  if (typeof val !== "string") {
    throw new MindError(
      "INVALID_INPUT",
      `Import item #${itemIndex} field "${field}" must be a string`,
      { itemIndex, field },
    );
  }
  return val;
}

function assertOptPlainObject(
  val: unknown,
  field: string,
  itemIndex: number,
): Record<string, unknown> | undefined {
  if (val === undefined) return undefined;
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    throw new MindError(
      "INVALID_INPUT",
      `Import item #${itemIndex} field "${field}" must be a plain object`,
      { itemIndex, field },
    );
  }
  return val as Record<string, unknown>;
}

function assertOptStringArrayWithCap(
  val: unknown,
  field: string,
  itemIndex: number,
  maxLen: number,
): string[] | undefined {
  if (val === undefined) return undefined;
  if (!Array.isArray(val)) {
    throw new MindError(
      "INVALID_INPUT",
      `Import item #${itemIndex} field "${field}" must be an array of strings`,
      { itemIndex, field },
    );
  }
  if (val.length > maxLen) {
    throw new MindError(
      "INVALID_INPUT",
      `Import item #${itemIndex} field "${field}" exceeds maximum length of ${maxLen} (${val.length} provided)`,
      { reason: "array_too_large", itemIndex, field, maxLen },
    );
  }
  for (let i = 0; i < val.length; i += 1) {
    if (typeof val[i] !== "string") {
      throw new MindError(
        "INVALID_INPUT",
        `Import item #${itemIndex} field "${field}[${i}]" must be a string`,
        { itemIndex, field },
      );
    }
  }
  return val as string[];
}

interface ScopedImporterReader {
  getVisibleRecordById(id: string): LedgerRecord | null;
  getVisibleSeabedById(id: string): SeabedEntry | null;
  findActiveRecordBySourceRef(
    sourceRef: string,
    realmIds: string[],
  ): LedgerRecord | null;
  findActiveRecordsBySourceRef(
    sourceRef: string,
    realmIds: string[],
  ): LedgerRecord[];
  findLatestRecordsBySourceRef(
    sourceRef: string,
    realmIds: string[],
  ): LedgerRecord[];
  findLatestRecordBySourceId(
    sourceId: string,
    realmIds: string[],
  ): LedgerRecord | null;
  findSeabedBySourceRef(
    sourceRef: string,
    realmIds: string[],
    opts?: { limitPerRealm?: number },
  ): SeabedEntry[];
  listImportedEntriesInRealms(
    ledgerRealmIds: string[],
    seabedRealmIds: string[],
  ): Array<{
    sourceRef: string;
    realmId: string;
    layer: "record" | "seabed";
    entryId: string;
    status: string;
  }>;
}

/**
 * Single unified visibility-checked lookup choke point for ALL existing-entry reads
 * across both `ingestBatch` and `verifyImportManifest`.
 * Every query is strictly intersected with `scope` (respecting `scopeCeiling`), filtered
 * through `vis.canSeeRecord` / `vis.canSeeSeabed`, and UNCONDITIONALLY excludes
 * `sensitivity === "secret"` (matching all MindSurface read surfaces: show/ls/search/brief/changes).
 */
function createScopedImporterReader(params: {
  db: DbPort;
  orgId: string;
  scope: AccessScope;
  vis: VisibilityHelpers;
}): ScopedImporterReader {
  const { db, orgId, scope, vis } = params;
  const readableLedgerSet = new Set(scope.readableLedgerIds);
  const readableSeabedSet = new Set(scope.readableSeabedIds);

  const intersectLedger = (realmIds: string[]): string[] =>
    realmIds.filter((id) => readableLedgerSet.has(id));
  const intersectSeabed = (realmIds: string[]): string[] =>
    realmIds.filter((id) => readableSeabedSet.has(id));

  const filterRecord = (rec: LedgerRecord | null): LedgerRecord | null => {
    if (!rec || rec.orgId !== orgId) return null;
    if (rec.sensitivity === "secret") return null;
    if (!readableLedgerSet.has(rec.realmId) || !vis.canSeeRecord(rec)) {
      return null;
    }
    return rec;
  };

  const filterSeabed = (sea: SeabedEntry | null): SeabedEntry | null => {
    if (!sea || sea.orgId !== orgId) return null;
    if (sea.sensitivity === "secret") return null;
    if (!readableSeabedSet.has(sea.realmId) || !vis.canSeeSeabed(sea)) {
      return null;
    }
    return sea;
  };

  return {
    getVisibleRecordById(id) {
      return filterRecord(db.getRecord(id));
    },
    getVisibleSeabedById(id) {
      return filterSeabed(db.getSeabedEntry(id));
    },
    findActiveRecordBySourceRef(sourceRef, realmIds) {
      const allowed = intersectLedger(realmIds);
      if (allowed.length === 0) return null;
      const rows = db
        .findActiveRecordsBySourceRefInRealms(orgId, sourceRef, allowed, {
          excludeSecret: true,
        })
        .filter((r) => filterRecord(r) !== null);
      return rows[0] ?? null;
    },
    findActiveRecordsBySourceRef(sourceRef, realmIds) {
      const allowed = intersectLedger(realmIds);
      if (allowed.length === 0) return [];
      return db
        .findActiveRecordsBySourceRefInRealms(orgId, sourceRef, allowed, {
          excludeSecret: true,
        })
        .filter((r) => filterRecord(r) !== null);
    },
    findLatestRecordsBySourceRef(sourceRef, realmIds) {
      const allowed = intersectLedger(realmIds);
      if (allowed.length === 0) return [];
      return db
        .findLatestRecordsBySourceRefInRealms(orgId, sourceRef, allowed, {
          excludeSecret: true,
        })
        .filter((r) => filterRecord(r) !== null);
    },
    findLatestRecordBySourceId(sourceId, realmIds) {
      const allowed = intersectLedger(realmIds);
      if (allowed.length === 0) return null;
      const row = db.findLatestRecordByPayloadSourceIdInRealms(
        orgId,
        sourceId,
        allowed,
        { excludeSecret: true },
      );
      return filterRecord(row);
    },
    findSeabedBySourceRef(sourceRef, realmIds, opts) {
      const allowed = intersectSeabed(realmIds);
      if (allowed.length === 0) return [];
      return db
        .findSeabedBySourceRefInRealms(orgId, sourceRef, allowed, {
          excludeSecret: true,
          limitPerRealm: opts?.limitPerRealm,
        })
        .filter((s) => filterSeabed(s) !== null);
    },
    listImportedEntriesInRealms(ledgerRealmIds, seabedRealmIds) {
      const allowedLedger = Array.from(new Set(intersectLedger(ledgerRealmIds)));
      const allowedSeabed = Array.from(new Set(intersectSeabed(seabedRealmIds)));
      if (allowedLedger.length === 0 && allowedSeabed.length === 0) return [];
      const rawEntries = db.listImportedSourceRefsInRealms(
        orgId,
        allowedLedger,
        allowedSeabed,
        { excludeSecret: true },
      );
      // Verify every single entry through vis.canSeeRecord / vis.canSeeSeabed (batched for O(1) SQL overhead)
      const recIds: string[] = [];
      const seaIds: string[] = [];
      for (const e of rawEntries) {
        if (e.layer === "record") recIds.push(e.entryId);
        else seaIds.push(e.entryId);
      }
      const visibleRecIds = new Set<string>();
      for (let i = 0; i < recIds.length; i += 500) {
        for (const r of db.getRecordsByIds(recIds.slice(i, i + 500))) {
          if (filterRecord(r) !== null) visibleRecIds.add(r.id);
        }
      }
      const visibleSeaIds = new Set<string>();
      for (let i = 0; i < seaIds.length; i += 500) {
        for (const s of db.getSeabedEntriesByIds(seaIds.slice(i, i + 500))) {
          if (filterSeabed(s) !== null) visibleSeaIds.add(s.id);
        }
      }
      return rawEntries.filter((e) =>
        e.layer === "record"
          ? visibleRecIds.has(e.entryId)
          : visibleSeaIds.has(e.entryId),
      );
    },
  };
}

export class ImporterEngine {
  constructor(
    private readonly db: DbPort,
    private readonly ledger: LedgerEngine,
    private readonly sea: SeaEngine,
  ) {}

  private getOrgPolicy(orgId: string | undefined): OrgPolicy {
    if (!orgId) return "tree";
    return this.db.getOrg(orgId)?.policy ?? "tree";
  }

  /**
   * Unified transactional batch ingestion engine (`POST /v1/import/batch` AND local CLI).
   * - Never touches the server's local filesystem (zero LFI/SSRF).
   * - Server ALWAYS recomputes SHA-256 from actual payload/text and rejects mismatches.
   * - Rejects reserved keys in `extraPayload` and spreads `extraPayload` strictly BEFORE canonical fields.
   * - Allowlists `idempotencyPrefix` and ALWAYS scopes every idempotency key with `effectiveRealmId`.
   * - Enforces `--relocate` as strictly `human-only` with per-entry `assertWriteAccess` on every source & target realm.
   * - Seals cross-realm `sourceRef` disclosure in `tree` mode (searches ONLY targetRealm + unified writable ∩ visible ∩ unarchived realms).
   * - `dryRun: true` runs the exact same code path inside a rolled-back SQLite transaction with zero WakeBus/WS notifications.
   */
  ingestBatch(params: {
    actor: Actor;
    viewerRealmId: string;
    writeScope?: TokenWriteScope;
    scopeCeiling?: AccessScope;
    input: ImportBatchInput;
  }): ImportBatchResult {
    const actor = params.actor;
    const writeScope: TokenWriteScope = params.writeScope ?? "self";
    const input = params.input;
    if (!input || !Array.isArray(input.items)) {
      throw new MindError("INVALID_INPUT", "import batch requires an items array");
    }
    if (input.items.length > MAX_IMPORT_BATCH_ITEMS) {
      throw new MindError(
        "INVALID_INPUT",
        `Import batch size (${input.items.length}) exceeds maximum of ${MAX_IMPORT_BATCH_ITEMS} items per request.`,
        { reason: "batch_too_large", maxItems: MAX_IMPORT_BATCH_ITEMS },
      );
    }

    if (
      input.defaultRealmRef !== undefined &&
      (typeof input.defaultRealmRef !== "string" || !input.defaultRealmRef.trim())
    ) {
      throw new MindError(
        "INVALID_INPUT",
        "import batch defaultRealmRef must be a non-empty string",
      );
    }

    const skipSecret = input.skipSecret ?? true;
    const dryRun = Boolean(input.dryRun);
    const relocate = Boolean(input.relocate);

    // P0-3: `--relocate` moves entries across realms and is strictly human-only (aligned with `entry move`).
    if (relocate && actor.kind !== "human") {
      throw new MindError(
        "ACCESS_DENIED",
        `Only human actors can use --relocate to move entries between realms (actor "${actor.id}" is "${actor.kind}").`,
        { reason: "relocate_requires_human" },
      );
    }

    // Pre-validate every item's runtime types, array caps, reserved keys, sensitivity, idempotencyPrefix, size, and server-recomputed SHA-256
    interface ValidatedBatchItem {
      index: number;
      raw: ImportBatchItemInput;
      target: ImportTargetLayer;
      sourceRef: string;
      occurredAt: string | null;
      actualTextOrBody: string;
      actualSha: string;
      validatedRawSha: string | null;
      validatedIdempPrefix: "import-md" | "import-jsonl" | "import-batch" | null;
      sensitivity: Sensitivity;
    }

    const validatedItems: ValidatedBatchItem[] = [];
    for (let index = 0; index < input.items.length; index += 1) {
      const item = input.items[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new MindError(
          "INVALID_INPUT",
          `Import batch item #${index} must be an object`,
          { itemIndex: index },
        );
      }
      if (item.target !== "record" && item.target !== "seabed") {
        throw new MindError(
          "INVALID_INPUT",
          `Import batch item #${index} has invalid target "${String(item.target)}": expected "record" or "seabed"`,
          { itemIndex: index },
        );
      }
      if (typeof item.sourceRef !== "string" || !item.sourceRef.trim()) {
        throw new MindError(
          "INVALID_INPUT",
          `Import batch item #${index} requires a non-empty sourceRef`,
          { itemIndex: index },
        );
      }
      const sourceRef = normalizeSourceRef(item.sourceRef);

      // P1-7: Strict runtime type validation on every optional/required item field (400 INVALID_INPUT, never 500 TypeError)
      if (item.realmRef !== undefined && item.realmRef !== null) {
        if (typeof item.realmRef !== "string" || !item.realmRef.trim()) {
          throw new MindError(
            "INVALID_INPUT",
            `Import batch item #${index} ("${sourceRef}") realmRef must be a non-empty string`,
            { itemIndex: index, sourceRef },
          );
        }
      }
      if (item.body !== undefined && typeof item.body !== "string") {
        throw new MindError(
          "INVALID_INPUT",
          `Import batch item #${index} ("${sourceRef}") body must be a string`,
          { itemIndex: index, sourceRef },
        );
      }
      if (item.text !== undefined && typeof item.text !== "string") {
        throw new MindError(
          "INVALID_INPUT",
          `Import batch item #${index} ("${sourceRef}") text must be a string`,
          { itemIndex: index, sourceRef },
        );
      }
      assertOptString(item.kind, "kind", index, true);
      assertOptString(item.extKind, "extKind", index, true);
      assertOptString(item.title, "title", index, true);
      assertOptString(item.summary, "summary", index, true);
      assertOptString(item.sourceId, "sourceId", index, true);
      assertOptString(item.thingRef, "thingRef", index, true);
      assertOptString(item.externalRef, "externalRef", index, true);
      assertOptString(
        (item as unknown as Record<string, unknown>).topicId,
        "topicId",
        index,
        true,
      );
      assertOptString(item.filePath, "filePath", index, true);
      assertOptString(item.contentSha256, "contentSha256", index, false);

      // Strict occurredAt validation: must be null/undefined or a valid ISO date/datetime string
      let validatedOccurredAt: string | null = null;
      if (item.occurredAt !== undefined && item.occurredAt !== null) {
        if (typeof item.occurredAt !== "string") {
          throw new MindError(
            "INVALID_INPUT",
            `Import batch item #${index} ("${sourceRef}") occurredAt must be an ISO date/datetime string or null`,
            { itemIndex: index, sourceRef },
          );
        }
        const trimmedOcc = item.occurredAt.trim();
        if (
          !ISO_DATE_OR_DATETIME_RE.test(trimmedOcc) ||
          normalizeDeclaredTimestamp(trimmedOcc) === null
        ) {
          throw new MindError(
            "INVALID_INPUT",
            `Import batch item #${index} ("${sourceRef}") has invalid occurredAt "${item.occurredAt}": expected ISO-8601 date or timestamp`,
            { itemIndex: index, sourceRef },
          );
        }
        validatedOccurredAt = trimmedOcc;
      }

      // P1-5: Hard array caps + per-element string checks (blocks synchronous O(N) lookup DoS)
      assertOptStringArrayWithCap(
        item.supersedesIds,
        "supersedesIds",
        index,
        MAX_IMPORT_ITEM_SUPERSEDES,
      );
      assertOptStringArrayWithCap(
        item.supersedesSourceRefs,
        "supersedesSourceRefs",
        index,
        MAX_IMPORT_ITEM_SUPERSEDES,
      );
      assertOptStringArrayWithCap(
        item.refs,
        "refs",
        index,
        MAX_IMPORT_ITEM_REFS,
      );
      assertOptStringArrayWithCap(
        item.objectRefs,
        "objectRefs",
        index,
        MAX_IMPORT_ITEM_OBJECT_REFS,
      );
      assertOptStringArrayWithCap(
        item.resourceTags,
        "resourceTags",
        index,
        MAX_IMPORT_ITEM_RESOURCE_TAGS,
      );
      assertOptPlainObject(item.frontmatter, "frontmatter", index);

      // P1-6: strict sensitivity validation
      let sensitivity: Sensitivity = "internal";
      if (item.sensitivity !== undefined && item.sensitivity !== null) {
        if (
          typeof item.sensitivity !== "string" ||
          !VALID_SENSITIVITIES.has(item.sensitivity)
        ) {
          throw new MindError(
            "INVALID_INPUT",
            `Invalid sensitivity "${String(item.sensitivity)}" for "${sourceRef}": expected public, internal, confidential, or secret`,
            { itemIndex: index, sourceRef },
          );
        }
        sensitivity = item.sensitivity as Sensitivity;
      }

      // P0-1: strictly reject reserved keys inside extraPayload
      const checkedExtraPayload = assertOptPlainObject(
        item.extraPayload,
        "extraPayload",
        index,
      );
      if (checkedExtraPayload) {
        for (const k of Object.keys(checkedExtraPayload)) {
          if (RESERVED_EXTRA_PAYLOAD_KEYS.has(k)) {
            throw new MindError(
              "INVALID_INPUT",
              `Reserved key "${k}" is not allowed in extraPayload for "${sourceRef}"`,
              { reason: "reserved_payload_key", itemIndex: index, sourceRef, key: k },
            );
          }
        }
      }

      // P0-2: strictly allowlist idempotencyPrefix
      let validatedIdempPrefix:
        | "import-md"
        | "import-jsonl"
        | "import-batch"
        | null = null;
      if (item.idempotencyPrefix !== undefined && item.idempotencyPrefix !== null) {
        if (typeof item.idempotencyPrefix !== "string") {
          throw new MindError(
            "INVALID_INPUT",
            `Invalid idempotencyPrefix for "${sourceRef}": must be a string`,
            { reason: "invalid_idempotency_prefix", itemIndex: index, sourceRef },
          );
        }
        const trimmedPrefix = item.idempotencyPrefix.trim();
        if (!ALLOWED_IDEMPOTENCY_PREFIXES.has(trimmedPrefix)) {
          throw new MindError(
            "INVALID_INPUT",
            `Invalid idempotencyPrefix "${item.idempotencyPrefix}" for "${sourceRef}": allowed values are import-md, import-jsonl, import-batch`,
            { reason: "invalid_idempotency_prefix", itemIndex: index, sourceRef },
          );
        }
        validatedIdempPrefix = trimmedPrefix as
          | "import-md"
          | "import-jsonl"
          | "import-batch";
      }

      // P1-9: validate optional rawContentSha256 format strictly (64-hex SHA-256)
      let validatedRawSha: string | null = null;
      if (item.rawContentSha256 !== undefined && item.rawContentSha256 !== null) {
        const normRaw =
          typeof item.rawContentSha256 === "string"
            ? item.rawContentSha256.trim().toLowerCase()
            : "";
        if (!SHA256_HEX_RE.test(normRaw)) {
          throw new MindError(
            "INVALID_INPUT",
            `Invalid rawContentSha256 for "${sourceRef}": expected 64-character lowercase hex SHA-256`,
            { itemIndex: index, sourceRef },
          );
        }
        validatedRawSha = normRaw;
      }

      const itemBytes = serializeByteLength(item);
      if (itemBytes > MAX_IMPORT_ITEM_BYTES) {
        throw new MindError(
          "INVALID_INPUT",
          `Import batch item #${index} ("${sourceRef}") exceeds ${MAX_IMPORT_ITEM_BYTES} byte import limit (${itemBytes} bytes).`,
          {
            reason: "item_too_large",
            itemIndex: index,
            sourceRef,
            sizeBytes: itemBytes,
            limitBytes: MAX_IMPORT_ITEM_BYTES,
          },
        );
      }

      const actualTextOrBody =
        item.target === "seabed"
          ? typeof item.text === "string"
            ? item.text
            : typeof item.body === "string"
              ? item.body
              : ""
          : typeof item.body === "string"
            ? item.body
            : "";
      const actualSha = sha256Text(actualTextOrBody);
      if (
        typeof item.contentSha256 !== "string" ||
        item.contentSha256.trim().toLowerCase() !== actualSha
      ) {
        throw new MindError(
          "INVALID_INPUT",
          `Content SHA-256 mismatch for "${sourceRef}" (item #${index}): declared "${String(item.contentSha256 ?? "")}", server computed "${actualSha}".`,
          {
            reason: "content_sha_mismatch",
            itemIndex: index,
            sourceRef,
          },
        );
      }
      if (
        item.initialStatus !== undefined &&
        item.initialStatus !== null &&
        item.initialStatus !== "active" &&
        item.initialStatus !== "superseded"
      ) {
        throw new MindError(
          "INVALID_INPUT",
          `Invalid initialStatus "${String(item.initialStatus)}" for "${sourceRef}": expected "active" or "superseded"`,
          { itemIndex: index, sourceRef },
        );
      }
      validatedItems.push({
        index,
        raw: item,
        target: item.target,
        sourceRef,
        occurredAt: validatedOccurredAt,
        actualTextOrBody,
        actualSha,
        validatedRawSha,
        validatedIdempPrefix,
        sensitivity,
      });
    }

    const runInTx = dryRun
      ? <T>(fn: () => T) => this.db.dryRunTransaction(fn)
      : <T>(fn: () => T) => this.db.transaction(fn);

    return runInTx(() => {
      const realms = this.db.listRealms();
      const mounts = this.db.listMounts();
      const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
      if (!viewerRealm) {
        throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
      }
      const orgId = viewerRealm.orgId;
      const orgPolicy = this.getOrgPolicy(orgId);
      const hasSeabedItems = validatedItems.some((i) => i.target === "seabed");
      const baseScope = resolveAccessScope({
        realms,
        mounts,
        viewerRealmId: viewerRealm.id,
        orgPolicy,
        includeDescendantSeabed: writeScope === "subtree" && hasSeabedItems,
      });
      const scope = params.scopeCeiling
        ? intersectAccessScopes(baseScope, params.scopeCeiling)
        : baseScope;

      const realmsById = new Map(realms.map((r) => [r.id, r]));
      const vis = createVisibilityHelpers({
        db: this.db,
        realms,
        mounts,
        actor,
        viewerRealmId: viewerRealm.id,
        scope,
        includeDescendantSeabed: writeScope === "subtree" && hasSeabedItems,
      });
      const reader = createScopedImporterReader({
        db: this.db,
        orgId,
        scope,
        vis,
      });

      // P1-8: Single canonical writable ∩ visible ∩ unarchived realm sets matching assertWriteAccess 100%
      const writableLedgerRealmIds = getWritableRealmIds({
        realms,
        orgPolicy,
        viewerRealmId: viewerRealm.id,
        writeScope,
        scopeCeiling: scope,
        assetKind: "ledger",
        excludeArchived: true,
      });
      const writableSeabedRealmIds = getWritableRealmIds({
        realms,
        orgPolicy,
        viewerRealmId: viewerRealm.id,
        writeScope,
        scopeCeiling: scope,
        assetKind: "seabed",
        excludeArchived: true,
      });

      const defaultRealm: Realm = input.defaultRealmRef?.trim()
        ? resolveVisibleRealm({
            realms,
            orgId,
            ref: input.defaultRealmRef.trim(),
            scope,
          })
        : viewerRealm;

      const orgObjects = this.db.listObjects({
        orgId,
        realmIds: scope.readableLedgerIds,
      });
      const objectsById = new Map(orgObjects.map((o) => [o.id, o]));
      const objectsByKindName = new Map(
        orgObjects.map((o) => [
          `${o.kind.toLowerCase()}:${o.name.toLowerCase()}`,
          o,
        ]),
      );

      // Baseline counts per realm for dry-run doctor threshold projection
      const baselineDirectCountByRealm = new Map<string, number>();
      const projectedDeltaByRealm = new Map<string, number>();
      const touchedRealmIds = new Set<string>();
      const orgRealms = realms.filter((r) => r.orgId === orgId);
      const parentIdsWithChildren = new Set<string>(
        orgRealms.filter((r) => r.parentId).map((r) => r.parentId!),
      );

      const getBaselineDirectCount = (realmId: string): number => {
        const cached = baselineDirectCountByRealm.get(realmId);
        if (cached !== undefined) return cached;
        const recCount = this.db.listRecords({
          realmIds: [realmId],
          includeSuperseded: false,
          limit: 1,
        }).total;
        const seaCount = this.db.listSeabedEntries({
          realmIds: [realmId],
          limit: 1,
        }).total;
        const total = recCount + seaCount;
        baselineDirectCountByRealm.set(realmId, total);
        return total;
      };

      const sourceKeyToEntryId = new Map<string, string>();
      const items: ImportBatchItemResult[] = [];
      let created = 0;
      let superseded = 0;
      let relocated = 0;
      let skippedUnchanged = 0;
      let skippedRedacted = 0;
      let skippedSecret = 0;
      let treeDegradedCrossRealmSupersedes = 0;
      let undatedCount = 0;
      let defaultRealmCount = 0;

      for (const v of validatedItems) {
        const {
          index,
          raw: item,
          target,
          sourceRef,
          occurredAt,
          actualTextOrBody,
          actualSha,
          validatedRawSha,
          validatedIdempPrefix,
          sensitivity,
        } = v;
        try {
          const usedDefaultRealm = !item.realmRef?.trim();
          const targetRealm: Realm = usedDefaultRealm
            ? defaultRealm
            : resolveVisibleRealm({
                realms,
                orgId,
                ref: item.realmRef!.trim(),
                scope,
              });
          if (usedDefaultRealm) {
            defaultRealmCount += 1;
          }

          if (occurredAt === null) {
            undatedCount += 1;
          }

          const desiredKindRaw =
            item.kind?.trim().toLowerCase() ||
            (target === "seabed" ? "artifact" : "claim");
          const recordKind: RecordKind = VALID_RECORD_KINDS.has(desiredKindRaw)
            ? (desiredKindRaw as RecordKind)
            : "claim";
          const seabedKind: SeabedKind = VALID_SEABED_KINDS.has(desiredKindRaw)
            ? (desiredKindRaw as SeabedKind)
            : "artifact";

          // 1. Policy & write-access check FIRST (before secret/redacted/sourceRef to prevent side-channel oracles)
          assertWriteAccess({
            realms,
            mounts,
            actor,
            viewerRealmId: viewerRealm.id,
            targetRealmId: targetRealm.id,
            assetKind:
              target === "seabed"
                ? "seabed"
                : recordKind === "rule"
                  ? "rule"
                  : "ledger",
            orgPolicy,
            writeScope,
            category:
              target === "record" && recordKind === "rule" ? "admin" : "content",
          });

          if (dryRun) {
            touchedRealmIds.add(targetRealm.id);
            getBaselineDirectCount(targetRealm.id);
          }

          // 2. P1-6 Full-surface Secret Guard: scan title, summary, body/text, frontmatter, AND extraPayload!
          const secretScanTexts: string[] = [
            item.title ?? "",
            item.summary ?? "",
            actualTextOrBody,
            item.frontmatter ? JSON.stringify(item.frontmatter) : "",
            item.extraPayload ? JSON.stringify(item.extraPayload) : "",
          ];
          const hasPlaintextSecret = secretScanTexts.some((t) =>
            Boolean(detectPlaintextSecret(t)),
          );
          if (skipSecret && (sensitivity === "secret" || hasPlaintextSecret)) {
            skippedSecret += 1;
            items.push({
              index,
              sourceRef,
              target,
              contentSha256: actualSha,
              action: "skipped_secret",
              entryId: null,
              supersedesId: null,
              realmId: targetRealm.id,
              realmPath: targetRealm.path,
              occurredAt,
              ...(item.filePath ? { filePath: item.filePath } : {}),
              ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
            });
            continue;
          }
          if (!skipSecret && sensitivity !== "secret" && hasPlaintextSecret) {
            assertNoAccidentalSecret({
              texts: secretScanTexts,
              sensitivity,
              surfaceHint:
                "Remove the credential value or classify the source with sensitivity: secret.",
            });
          }

          // 3. Redacted blocklist pre-check (server-computed SHA + optional validated rawContentSha256)
          const isPreBlocked =
            this.db.isContentShaBlocked(orgId, actualSha) ||
            (validatedRawSha !== null &&
              this.db.isContentShaBlocked(orgId, validatedRawSha));
          if (isPreBlocked) {
            skippedRedacted += 1;
            items.push({
              index,
              sourceRef,
              target,
              contentSha256: actualSha,
              action: "skipped_redacted",
              entryId: null,
              supersedesId: null,
              realmId: targetRealm.id,
              realmPath: targetRealm.path,
              occurredAt,
              ...(item.filePath ? { filePath: item.filePath } : {}),
              ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
            });
            continue;
          }

          // Resolve objectIds and resourceTags
          const objectIds: string[] = [];
          for (const ref of item.objectRefs ?? []) {
            if (objectsById.has(ref)) {
              objectIds.push(ref);
            } else {
              const byName = objectsByKindName.get(ref.toLowerCase());
              if (byName) objectIds.push(byName.id);
            }
          }
          const uniqueObjectIds = Array.from(new Set(objectIds));
          const resourceTags = Array.from(
            new Set((item.resourceTags ?? []).map((t) => normalizeResourceTag(t))),
          );

          // ---- TARGET: SEABED ----
          if (target === "seabed") {
            if (
              actualTextOrBody.trim() &&
              this.db.isContentShaBlocked(
                orgId,
                computeSeabedContentSha256(actualTextOrBody),
              )
            ) {
              skippedRedacted += 1;
              items.push({
                index,
                sourceRef,
                target,
                contentSha256: actualSha,
                action: "skipped_redacted",
                entryId: null,
                supersedesId: null,
                realmId: targetRealm.id,
                realmPath: targetRealm.path,
                occurredAt,
                ...(item.filePath ? { filePath: item.filePath } : {}),
                ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
              });
              continue;
            }

            const existingInTarget = reader.findSeabedBySourceRef(
              sourceRef,
              [targetRealm.id],
            );
            const exactInTarget = existingInTarget.find(
              (s) => sha256Text(s.text) === actualSha,
            );
            if (exactInTarget) {
              skippedUnchanged += 1;
              sourceKeyToEntryId.set(sourceRef, exactInTarget.id);
              if (item.sourceId) {
                sourceKeyToEntryId.set(
                  normalizeSourceRef(item.sourceId),
                  exactInTarget.id,
                );
              }
              items.push({
                index,
                sourceRef,
                target,
                contentSha256: actualSha,
                action: "skipped_unchanged",
                entryId: exactInTarget.id,
                supersedesId: null,
                realmId: targetRealm.id,
                realmPath: targetRealm.path,
                occurredAt: exactInTarget.occurredAt,
                ...(item.filePath ? { filePath: item.filePath } : {}),
                ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
              });
              continue;
            }

            const otherWritableSeabedIds = writableSeabedRealmIds.filter(
              (id) => id !== targetRealm.id,
            );
            let didRelocate = false;
            if (
              orgPolicy === "tree" &&
              existingInTarget.length === 0 &&
              (relocate || otherWritableSeabedIds.length > 0)
            ) {
              // For relocate check, include archived descendants ONLY so relocate explicitly catches & rejects archived sources!
              const relocateSearchIds = relocate
                ? getWritableRealmIds({
                    realms,
                    orgPolicy,
                    viewerRealmId: viewerRealm.id,
                    writeScope,
                    scopeCeiling: scope,
                    assetKind: "seabed",
                    excludeArchived: false,
                  }).filter((id) => id !== targetRealm.id)
                : otherWritableSeabedIds;
              const inOtherWritable = reader.findSeabedBySourceRef(
                sourceRef,
                relocateSearchIds,
              );
              if (inOtherWritable.length > 0) {
                const otherSea = inOtherWritable[0]!;
                const otherRealmRaw = realmsById.get(otherSea.realmId);
                const otherPath = otherRealmRaw
                  ? vis.sanitizeRealm(otherRealmRaw).path
                  : otherSea.realmId;
                if (!relocate) {
                  throw new MindError(
                    "CONFLICT",
                    `sourceRef "${sourceRef}" already exists in writable realm "${otherPath}". Pass --relocate to move it into "${targetRealm.path}".`,
                    {
                      reason: "source_ref_realm_conflict",
                      itemIndex: index,
                      sourceRef,
                      existingRealmPath: otherPath,
                      targetRealmPath: targetRealm.path,
                    },
                  );
                }
                // P0-3: verify assertWriteAccess (including archive freeze!) on EVERY seabed entry before moving ANY!
                for (const s of inOtherWritable) {
                  assertWriteAccess({
                    realms,
                    mounts,
                    actor,
                    viewerRealmId: viewerRealm.id,
                    targetRealmId: s.realmId,
                    assetKind: "seabed",
                    orgPolicy,
                    writeScope,
                    category: "content",
                  });
                }
                const moveNow = new Date().toISOString();
                for (const s of inOtherWritable) {
                  if (s.realmId === targetRealm.id) continue;
                  this.db.moveEntryRealm({
                    orgId,
                    targetTable: "seabed_entries",
                    entryId: s.id,
                    newRealmId: targetRealm.id,
                  });
                  this.db.appendChangeLog({
                    orgId,
                    realmId: s.realmId,
                    entityType: "seabed",
                    entityId: s.id,
                    op: "move_out",
                    actorId: actor.id,
                    createdAt: moveNow,
                  });
                  this.db.appendChangeLog({
                    orgId,
                    realmId: targetRealm.id,
                    entityType: "seabed",
                    entityId: s.id,
                    op: "move_in",
                    actorId: actor.id,
                    createdAt: moveNow,
                  });
                }
                didRelocate = true;
                const matchingRelocated = inOtherWritable.find(
                  (s) => sha256Text(s.text) === actualSha,
                );
                if (matchingRelocated) {
                  relocated += 1;
                  if (dryRun) {
                    projectedDeltaByRealm.set(
                      targetRealm.id,
                      (projectedDeltaByRealm.get(targetRealm.id) ?? 0) + 1,
                    );
                  }
                  sourceKeyToEntryId.set(sourceRef, matchingRelocated.id);
                  if (item.sourceId) {
                    sourceKeyToEntryId.set(
                      normalizeSourceRef(item.sourceId),
                      matchingRelocated.id,
                    );
                  }
                  items.push({
                    index,
                    sourceRef,
                    target,
                    contentSha256: actualSha,
                    action: "relocated",
                    entryId: matchingRelocated.id,
                    supersedesId: null,
                    realmId: targetRealm.id,
                    realmPath: targetRealm.path,
                    occurredAt: matchingRelocated.occurredAt,
                    ...(item.filePath ? { filePath: item.filePath } : {}),
                    ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
                  });
                  continue;
                }
              }
            }

            const metadata: Record<string, unknown> = {
              ...(item.extraPayload ?? {}),
              sourceRef,
              contentSha256: actualSha,
              ...(validatedRawSha ? { rawContentSha256: validatedRawSha } : {}),
              ...(item.sourceId ? { sourceId: item.sourceId } : {}),
            };
            const idempPrefix = validatedIdempPrefix ?? "import-batch";
            // `sensitivity: "secret"` entries are strictly write-only across all MindSurface APIs:
            // omit deterministic idempotency keys so probing via dryRun/import can never oracle existing secret rows.
            const idempotencyKey =
              sensitivity === "secret"
                ? undefined
                : `${idempPrefix}:${targetRealm.id}:seabed:${sourceRef}:${actualSha}:${sensitivity}`;
            const rawPreExistingKey = idempotencyKey
              ? this.db.getIdempotencyKey(orgId, idempotencyKey)
              : null;
            const preExistingPointsToHidden = (() => {
              if (rawPreExistingKey === null) return false;
              if (rawPreExistingKey.targetTable === "seabed_entries") {
                const targetSea = this.db.getSeabedEntry(rawPreExistingKey.targetId);
                if (!targetSea) return false;
                return targetSea.sensitivity === "secret" || !vis.canSeeSeabed(targetSea);
              }
              const targetRec = this.db.getRecord(rawPreExistingKey.targetId);
              if (!targetRec) return false;
              return targetRec.sensitivity === "secret" || !vis.canSeeRecord(targetRec);
            })();
            const effectiveIdempotencyKey = preExistingPointsToHidden
              ? undefined
              : idempotencyKey;
            const preExistingKey = preExistingPointsToHidden
              ? null
              : rawPreExistingKey;

            const sea = this.ledger.captureSeabedSync({
              actor,
              viewerRealmId: viewerRealm.id,
              targetRealmId: targetRealm.id,
              kind: seabedKind,
              text: actualTextOrBody,
              preserveExactText: true,
              sourceRef,
              metadata,
              objectIds: uniqueObjectIds,
              resourceTags,
              occurredAt,
              sensitivity,
              idempotencyKey: effectiveIdempotencyKey,
              writeScope,
            });

            sourceKeyToEntryId.set(sourceRef, sea.id);
            if (item.sourceId) {
              sourceKeyToEntryId.set(normalizeSourceRef(item.sourceId), sea.id);
            }
            const action: ImportBatchItemAction = preExistingKey
              ? "skipped_unchanged"
              : didRelocate
                ? "relocated"
                : "created";
            if (action === "skipped_unchanged") skippedUnchanged += 1;
            else if (action === "relocated") relocated += 1;
            else created += 1;
            if (dryRun && action !== "skipped_unchanged") {
              projectedDeltaByRealm.set(
                targetRealm.id,
                (projectedDeltaByRealm.get(targetRealm.id) ?? 0) + 1,
              );
            }
            items.push({
              index,
              sourceRef,
              target,
              contentSha256: actualSha,
              action,
              entryId: sea.id,
              supersedesId: null,
              realmId: sea.realmId,
              realmPath: targetRealm.path,
              occurredAt: sea.occurredAt,
              ...(item.filePath ? { filePath: item.filePath } : {}),
              ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
            });
            continue;
          }

          // ---- TARGET: RECORD ----
          const initialStatus = item.initialStatus ?? "active";
          const title =
            item.title?.trim() ||
            actualTextOrBody.slice(0, 120).trim() ||
            sourceRef;

          // P1-2: All existing-record lookups pass strictly through ScopedImporterReader (vis + unconditional secret filter)
          let head: LedgerRecord | null = reader.findActiveRecordBySourceRef(
            sourceRef,
            orgPolicy === "open" ? scope.readableLedgerIds : [targetRealm.id],
          );

          // P1-3: Tree-mode human `entry move` protection strictly via targetRealm's own `change_log`
          // (`op = 'move_out'`, zero lookup of destination realm, zero cross-realm disclosure!)
          if (
            orgPolicy === "tree" &&
            !head &&
            !relocate &&
            this.db.hasRealmSourceRefMoveOut(orgId, targetRealm.id, sourceRef, {
              excludeSecret: true,
            })
          ) {
            skippedUnchanged += 1;
            items.push({
              index,
              sourceRef,
              target,
              contentSha256: actualSha,
              action: "skipped_unchanged",
              entryId: null,
              supersedesId: null,
              realmId: targetRealm.id,
              realmPath: targetRealm.path,
              occurredAt,
              ...(item.filePath ? { filePath: item.filePath } : {}),
              ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
            });
            continue;
          }

          const otherWritableLedgerIds = writableLedgerRealmIds.filter(
            (id) => id !== targetRealm.id,
          );
          let didRelocate = false;
          if (orgPolicy === "tree" && !head) {
            const relocateSearchIds = relocate
              ? getWritableRealmIds({
                  realms,
                  orgPolicy,
                  viewerRealmId: viewerRealm.id,
                  writeScope,
                  scopeCeiling: scope,
                  assetKind: "ledger",
                  excludeArchived: false,
                }).filter((id) => id !== targetRealm.id)
              : otherWritableLedgerIds;
            const otherHeads =
              relocateSearchIds.length > 0
                ? reader.findActiveRecordsBySourceRef(
                    sourceRef,
                    relocateSearchIds,
                  )
                : [];
            if (otherHeads.length > 0) {
              const otherHead = otherHeads[0]!;
              const otherRealmRaw = realmsById.get(otherHead.realmId);
              const otherPath = otherRealmRaw
                ? vis.sanitizeRealm(otherRealmRaw).path
                : otherHead.realmId;
              if (!relocate) {
                throw new MindError(
                  "CONFLICT",
                  `sourceRef "${sourceRef}" already exists in writable realm "${otherPath}". Pass --relocate to move it into "${targetRealm.path}".`,
                  {
                    reason: "source_ref_realm_conflict",
                    itemIndex: index,
                    sourceRef,
                    existingRealmPath: otherPath,
                    targetRealmPath: targetRealm.path,
                  },
                );
              }
              // P1-6: Expand connected supersede chain and verify visibility + assertWriteAccess on BOTH
              // `node.realmId` AND `targetRealm.id` using each node's OWN `kind`/`category` (blocks rule smuggling)!
              const chainIds = new Set<string>();
              const queue: string[] = [otherHead.id];
              const chainNodes: LedgerRecord[] = [];
              while (queue.length > 0) {
                const curId = queue.shift()!;
                if (chainIds.has(curId)) continue;
                const rawNode = this.db.getRecord(curId);
                if (!rawNode || rawNode.orgId !== orgId) continue;
                const visibleNode = reader.getVisibleRecordById(curId);
                if (!visibleNode) {
                  // Never leak an invisible realm ID in error details
                  throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
                }
                const nodeAssetKind: AssetKind =
                  visibleNode.kind === "rule" ? "rule" : "ledger";
                const nodeCategory =
                  visibleNode.kind === "rule" ? "admin" : "content";
                assertWriteAccess({
                  realms,
                  mounts,
                  actor,
                  viewerRealmId: viewerRealm.id,
                  targetRealmId: visibleNode.realmId,
                  assetKind: nodeAssetKind,
                  orgPolicy,
                  writeScope,
                  category: nodeCategory,
                });
                assertWriteAccess({
                  realms,
                  mounts,
                  actor,
                  viewerRealmId: viewerRealm.id,
                  targetRealmId: targetRealm.id,
                  assetKind: nodeAssetKind,
                  orgPolicy,
                  writeScope,
                  category: nodeCategory,
                });
                chainIds.add(curId);
                chainNodes.push(visibleNode);
                const neighbors = this.db.listRecordSupersedeNeighborIds(
                  orgId,
                  curId,
                );
                for (const nid of neighbors) {
                  if (!chainIds.has(nid)) queue.push(nid);
                }
              }
              const moveNow = new Date().toISOString();
              for (const node of chainNodes) {
                if (node.realmId === targetRealm.id) continue;
                this.db.moveEntryRealm({
                  orgId,
                  targetTable: "records",
                  entryId: node.id,
                  newRealmId: targetRealm.id,
                });
                this.db.appendChangeLog({
                  orgId,
                  realmId: node.realmId,
                  entityType: "record",
                  entityId: node.id,
                  op: "move_out",
                  actorId: actor.id,
                  createdAt: moveNow,
                });
                this.db.appendChangeLog({
                  orgId,
                  realmId: targetRealm.id,
                  entityType: "record",
                  entityId: node.id,
                  op: "move_in",
                  actorId: actor.id,
                  createdAt: moveNow,
                });
              }
              head = { ...otherHead, realmId: targetRealm.id };
              didRelocate = true;
            }
          }

          // Open-mode N2 protection against undoing explicit human `entry move` (unless relocate === true)
          const isFallbackRealm =
            usedDefaultRealm &&
            (!input.defaultRealmRef?.trim() ||
              defaultRealm.path === "/" ||
              defaultRealm.path === "/inbox");
          const wasHumanMoved =
            orgPolicy === "open" &&
            !relocate &&
            usedDefaultRealm &&
            head !== null &&
            head.realmId !== targetRealm.id &&
            this.db.hasRecordLineageChangeLogOp(
              orgId,
              head.id,
              "move_in",
              head.realmId,
            );
          const effectiveRealmId =
            orgPolicy === "open" &&
            !relocate &&
            (isFallbackRealm || wasHumanMoved) &&
            head &&
            head.realmId !== targetRealm.id &&
            !isRealmEffectivelyArchived(realms, head.realmId)
              ? head.realmId
              : targetRealm.id;
          const effectiveRealmPath =
            realmsById.get(effectiveRealmId)?.path ?? targetRealm.path;

          // P1-1 & P1-4: Check unchanged match on existing head (INCLUDING upgrade-safe JSONL re-imports!)
          if (head) {
            const headBody =
              typeof head.payload.body === "string" ? head.payload.body : "";
            const headBodySha = sha256Text(headBody);
            const headRawSha =
              typeof head.payload.rawContentSha256 === "string"
                ? head.payload.rawContentSha256
                : null;
            const headStoredSha =
              typeof head.payload.contentSha256 === "string"
                ? head.payload.contentSha256
                : null;
            const isUnchangedHead =
              head.sensitivity === sensitivity &&
              (validatedIdempPrefix === "import-jsonl"
                ? head.realmId === effectiveRealmId &&
                  head.status === initialStatus &&
                  ((validatedRawSha !== null &&
                    (headRawSha === validatedRawSha ||
                      headStoredSha === validatedRawSha)) ||
                    (headBodySha === actualSha &&
                      head.title === title &&
                      head.occurredAt === occurredAt))
                : headBodySha === actualSha &&
                  (!validatedRawSha ||
                    !headRawSha ||
                    headRawSha === validatedRawSha) &&
                  head.title === title &&
                  head.realmId === effectiveRealmId &&
                  head.status === initialStatus &&
                  head.occurredAt === occurredAt);

            if (isUnchangedHead) {
              sourceKeyToEntryId.set(sourceRef, head.id);
              if (item.sourceId) {
                sourceKeyToEntryId.set(normalizeSourceRef(item.sourceId), head.id);
              }
              if (didRelocate) {
                relocated += 1;
                if (dryRun) {
                  projectedDeltaByRealm.set(
                    effectiveRealmId,
                    (projectedDeltaByRealm.get(effectiveRealmId) ?? 0) + 1,
                  );
                }
                items.push({
                  index,
                  sourceRef,
                  target,
                  contentSha256: actualSha,
                  action: "relocated",
                  entryId: head.id,
                  supersedesId: null,
                  realmId: effectiveRealmId,
                  realmPath: effectiveRealmPath,
                  occurredAt: head.occurredAt,
                  ...(item.filePath ? { filePath: item.filePath } : {}),
                  ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
                });
              } else {
                skippedUnchanged += 1;
                items.push({
                  index,
                  sourceRef,
                  target,
                  contentSha256: actualSha,
                  action: "skipped_unchanged",
                  entryId: head.id,
                  supersedesId: null,
                  realmId: effectiveRealmId,
                  realmPath: effectiveRealmPath,
                  occurredAt: head.occurredAt,
                  ...(item.filePath ? { filePath: item.filePath } : {}),
                  ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
                });
              }
              continue;
            }
          }

          const effectiveKind: RecordKind = head?.kind ?? recordKind;

          // P0-1: Spread extraPayload FIRST so validated canonical fields can NEVER be overwritten!
          const payload: Record<string, unknown> = {
            ...(item.extraPayload ?? {}),
            ...(item.summary ? { summary: item.summary } : {}),
            ...(actualTextOrBody ? { body: actualTextOrBody } : {}),
            sourceRef,
            contentSha256: actualSha,
            ...(validatedRawSha ? { rawContentSha256: validatedRawSha } : {}),
            ...(item.sourceId ? { sourceId: item.sourceId } : {}),
            ...(item.frontmatter && Object.keys(item.frontmatter).length > 0
              ? { frontmatter: item.frontmatter }
              : {}),
          };

          // P1-9: Always check server-computed canonical record hash against redacted_blocklist
          if (
            this.db.isContentShaBlocked(
              orgId,
              computeRecordContentSha256(title, payload),
            )
          ) {
            skippedRedacted += 1;
            items.push({
              index,
              sourceRef,
              target,
              contentSha256: actualSha,
              action: "skipped_redacted",
              entryId: null,
              supersedesId: null,
              realmId: effectiveRealmId,
              realmPath: effectiveRealmPath,
              occurredAt,
              ...(item.filePath ? { filePath: item.filePath } : {}),
              ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
            });
            continue;
          }

          // Resolve optional thingRef strictly through ScopedImporterReader (vis + unconditional secret filter!)
          let thingId: string | undefined;
          if (item.thingRef?.trim()) {
            const ref = item.thingRef.trim();
            const mappedFromBatch = sourceKeyToEntryId.get(
              normalizeSourceRef(ref),
            );
            if (mappedFromBatch) {
              const batchRec = reader.getVisibleRecordById(mappedFromBatch);
              if (batchRec) thingId = batchRec.thingId ?? batchRec.id;
            } else {
              const direct = reader.getVisibleRecordById(ref);
              if (direct) {
                thingId = direct.thingId ?? direct.id;
              } else {
                const byExt = this.ledger.findThingByExternalRef({
                  actor,
                  viewerRealmId: viewerRealm.id,
                  externalRef: ref,
                });
                if (byExt && byExt.sensitivity !== "secret") {
                  thingId = byExt.thingId ?? byExt.id;
                }
              }
            }
          }

          // Resolve optional refs strictly through ScopedImporterReader (vis + unconditional secret filter!)
          const resolvedRefs: string[] = [];
          for (const rawRef of item.refs ?? []) {
            const mapped =
              sourceKeyToEntryId.get(normalizeSourceRef(rawRef)) ?? rawRef;
            const targetRec = reader.getVisibleRecordById(mapped);
            if (targetRec) {
              resolvedRefs.push(targetRec.id);
              continue;
            }
            const targetSea = reader.getVisibleSeabedById(mapped);
            if (targetSea) {
              resolvedRefs.push(targetSea.id);
            }
          }

          // P1-2: Resolve supersedes strictly through ScopedImporterReader (by source_ref OR indexed payload.sourceId)
          const candidateSupersedeRecords: LedgerRecord[] = [];
          const seenSupIds = new Set<string>();
          const pushSupCandidate = (rec: LedgerRecord | null | undefined) => {
            if (!rec || rec.orgId !== orgId || seenSupIds.has(rec.id)) return;
            if (rec.sensitivity === "secret") return;
            if (
              !scope.readableLedgerIds.includes(rec.realmId) ||
              !vis.canSeeRecord(rec)
            ) {
              return;
            }
            seenSupIds.add(rec.id);
            candidateSupersedeRecords.push(rec);
          };

          if (head && validatedIdempPrefix !== "import-jsonl") {
            pushSupCandidate(head);
          }
          for (const supId of item.supersedesIds ?? []) {
            pushSupCandidate(reader.getVisibleRecordById(supId));
          }
          for (const supRefRaw of item.supersedesSourceRefs ?? []) {
            const supRef = normalizeSourceRef(supRefRaw);
            const fromBatch = sourceKeyToEntryId.get(supRef);
            if (fromBatch) {
              pushSupCandidate(reader.getVisibleRecordById(fromBatch));
              continue;
            }
            // Cross-chunk lookup: target realm FIRST (by source_ref, then indexed payload.sourceId)
            const inTargetByRef = reader.findLatestRecordsBySourceRef(supRef, [
              effectiveRealmId,
            ]);
            if (inTargetByRef.length > 0) {
              pushSupCandidate(inTargetByRef[0]);
              continue;
            }
            const inTargetBySourceId = reader.findLatestRecordBySourceId(
              supRef,
              [effectiveRealmId],
            );
            if (inTargetBySourceId) {
              pushSupCandidate(inTargetBySourceId);
              continue;
            }
            // Fallback across caller's visible realms (for open-mode cross-realm supersede OR tree-mode degradation)
            const inVisibleByRef = reader.findLatestRecordsBySourceRef(
              supRef,
              scope.readableLedgerIds,
            );
            if (inVisibleByRef.length > 0) {
              pushSupCandidate(inVisibleByRef[0]);
              continue;
            }
            const inVisibleBySourceId = reader.findLatestRecordBySourceId(
              supRef,
              scope.readableLedgerIds,
            );
            if (inVisibleBySourceId) {
              pushSupCandidate(inVisibleBySourceId);
              continue;
            }
          }

          const resolvedSupersedesIds: string[] = [];
          const degradedCrossRealmIds: string[] = [];
          for (const oldRec of candidateSupersedeRecords) {
            if (orgPolicy === "open") {
              if (oldRec.kind === effectiveKind) {
                resolvedSupersedesIds.push(oldRec.id);
              }
            } else {
              if (oldRec.realmId === effectiveRealmId) {
                if (oldRec.kind === effectiveKind) {
                  resolvedSupersedesIds.push(oldRec.id);
                }
              } else {
                const oldAccess = resolveAccess({
                  realms,
                  mounts,
                  actor,
                  viewerRealmId: viewerRealm.id,
                  targetRealmId: oldRec.realmId,
                  assetKind: oldRec.kind === "rule" ? "rule" : "ledger",
                  orgPolicy,
                });
                if (oldAccess !== "none") {
                  treeDegradedCrossRealmSupersedes += 1;
                  degradedCrossRealmIds.push(oldRec.id);
                  resolvedRefs.push(oldRec.id);
                }
              }
            }
          }

          if (degradedCrossRealmIds.length === 1) {
            payload.crossRealmSupersedes = degradedCrossRealmIds[0];
          } else if (degradedCrossRealmIds.length > 1) {
            payload.crossRealmSupersedes = degradedCrossRealmIds;
          }

          // P0-2: Server ALWAYS generates realm-scoped & sensitivity-scoped idempotency keys using allowlisted prefixes!
          // `sensitivity: "secret"` entries are strictly write-only across all MindSurface APIs:
          // omit deterministic idempotency keys so probing via dryRun/import can never oracle existing secret rows.
          const idempBase = validatedIdempPrefix ?? "import-batch";
          const idempotencyKey =
            sensitivity === "secret"
              ? undefined
              : idempBase === "import-jsonl"
                ? `import-jsonl:${effectiveRealmId}:${item.sourceId ?? sourceRef}:${validatedRawSha ?? actualSha}:${sensitivity}`
                : resolvedSupersedesIds.length > 0
                  ? `${idempBase}:${effectiveRealmId}:${sourceRef}:after:${resolvedSupersedesIds.join(",")}:${actualSha}:${initialStatus}:${sensitivity}`
                  : `${idempBase}:${effectiveRealmId}:${sourceRef}:init:${actualSha}:${initialStatus}:${sensitivity}`;
          const rawPreExistingKey = idempotencyKey
            ? this.db.getIdempotencyKey(orgId, idempotencyKey)
            : null;
          const preExistingPointsToHidden = (() => {
            if (rawPreExistingKey === null) return false;
            if (rawPreExistingKey.targetTable === "seabed_entries") {
              const targetSea = this.db.getSeabedEntry(rawPreExistingKey.targetId);
              if (!targetSea) return false;
              return targetSea.sensitivity === "secret" || !vis.canSeeSeabed(targetSea);
            }
            const targetRec = this.db.getRecord(rawPreExistingKey.targetId);
            if (!targetRec) return false;
            return targetRec.sensitivity === "secret" || !vis.canSeeRecord(targetRec);
          })();
          const effectiveIdempotencyKey = preExistingPointsToHidden
            ? undefined
            : idempotencyKey;
          const preExistingKey = preExistingPointsToHidden
            ? null
            : rawPreExistingKey;

          const rec = this.ledger.appendRecordSync({
            actor,
            viewerRealmId: viewerRealm.id,
            targetRealmId: effectiveRealmId,
            thingId,
            kind: effectiveKind,
            extKind: item.extKind ?? undefined,
            title,
            payload,
            refs: Array.from(new Set(resolvedRefs)),
            externalRef: item.externalRef ?? undefined,
            sourceRef,
            objectIds: uniqueObjectIds,
            resourceTags,
            supersedesIds:
              resolvedSupersedesIds.length > 0
                ? resolvedSupersedesIds
                : undefined,
            initialStatus,
            occurredAt,
            sensitivity,
            idempotencyKey: effectiveIdempotencyKey,
            writeScope,
          });

          sourceKeyToEntryId.set(sourceRef, rec.id);
          if (item.sourceId) {
            sourceKeyToEntryId.set(normalizeSourceRef(item.sourceId), rec.id);
          }

          const action: ImportBatchItemAction = preExistingKey
            ? "skipped_unchanged"
            : didRelocate
              ? "relocated"
              : resolvedSupersedesIds.length > 0
                ? "superseded"
                : "created";
          if (action === "skipped_unchanged") {
            skippedUnchanged += 1;
          } else if (action === "relocated") {
            relocated += 1;
            if (resolvedSupersedesIds.length > 0) superseded += 1;
          } else if (action === "superseded") {
            superseded += 1;
          } else {
            created += 1;
          }

          if (dryRun && (action === "created" || action === "relocated")) {
            projectedDeltaByRealm.set(
              effectiveRealmId,
              (projectedDeltaByRealm.get(effectiveRealmId) ?? 0) + 1,
            );
          }

          items.push({
            index,
            sourceRef,
            target,
            contentSha256: actualSha,
            action,
            entryId: rec.id,
            supersedesId: resolvedSupersedesIds[0] ?? null,
            realmId: rec.realmId,
            realmPath: effectiveRealmPath,
            occurredAt: rec.occurredAt,
            ...(item.filePath ? { filePath: item.filePath } : {}),
            ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}),
          });
        } catch (err) {
          if (err instanceof MindError) {
            throw new MindError(err.code, err.message, {
              ...(err.details ?? {}),
              itemIndex: index,
              sourceRef,
            });
          }
          throw err;
        }
      }

      let realmProjections: ImportBatchRealmProjection[] | undefined;
      if (dryRun) {
        realmProjections = Array.from(touchedRealmIds)
          .map((realmId) => {
            const realm = realmsById.get(realmId);
            const realmPath = realm?.path ?? realmId;
            const isLeaf = !parentIdsWithChildren.has(realmId);
            const doctorThreshold =
              realmPath === "/" ? 20 : isLeaf ? 500 : 50;
            const existingDirectCount = getBaselineDirectCount(realmId);
            const projectedDelta = projectedDeltaByRealm.get(realmId) ?? 0;
            const projectedDirectCount = existingDirectCount + projectedDelta;
            return {
              realmId,
              realmPath,
              isLeaf,
              existingDirectCount,
              projectedDelta,
              projectedDirectCount,
              doctorThreshold,
              exceedsDoctorThreshold: projectedDirectCount > doctorThreshold,
            };
          })
          .sort((a, b) => a.realmPath.localeCompare(b.realmPath));
      }

      return {
        dryRun,
        totalItems: validatedItems.length,
        created,
        superseded,
        relocated,
        skippedUnchanged,
        skippedRedacted,
        skippedSecret,
        treeDegradedCrossRealmSupersedes,
        undatedCount,
        defaultRealmCount,
        items,
        ...(realmProjections ? { realmProjections } : {}),
      };
    });
  }

  /**
   * Independent zero-truncation verification engine (`POST /v1/import/verify` AND local CLI).
   * - Capped at `MAX_VERIFY_MANIFEST_ITEMS` (250) items per call; rejects duplicate `(target, realmId, sourceRef)`
   *   within a single request (`400 INVALID_INPUT`) to prevent hash-amplification DoS.
   * - Descendant seabed visibility strictly aligns with `importBatch`: ONLY enabled when
   *   `writeScope === "subtree" && hasSeabedItems` (NEVER for `self` principals!).
   * - Every existing-entry lookup (including `--check-realm`) passes through `ScopedImporterReader`
   *   (`scopeCeiling` + `vis.canSeeRecord`/`vis.canSeeSeabed` + unconditionally excluding `sensitivity === "secret"`,
   *   since `sensitivity: "secret"` entries are strictly write-only/unreadable across all MindSurface APIs).
   * - Never trusts cached `metadata.contentSha256` or `payload.contentSha256`.
   * - Always recomputes SHA-256 and UTF-8 byte length directly from stored `payload.body` (record)
   *   or stored `text` (seabed), and checks `expectedTitle` on records when supplied.
   * - Checks unexpected imported entries by composite `(realmId, layer, sourceRef)` key.
   */
  verifyImportManifest(params: {
    actor?: Actor;
    viewerRealmId: string;
    writeScope?: TokenWriteScope;
    scopeCeiling?: AccessScope;
    input: VerifyImportInput;
  }): VerifyImportResult {
    const input = params.input;
    if (!input || !Array.isArray(input.items)) {
      throw new MindError("INVALID_INPUT", "verify manifest requires an items array");
    }
    if (input.items.length > MAX_VERIFY_MANIFEST_ITEMS) {
      throw new MindError(
        "INVALID_INPUT",
        `Verify manifest size (${input.items.length}) exceeds maximum of ${MAX_VERIFY_MANIFEST_ITEMS} items per request.`,
        { reason: "verify_batch_too_large", maxItems: MAX_VERIFY_MANIFEST_ITEMS },
      );
    }

    // Pre-validate every manifest item runtime type (400 INVALID_INPUT, never 500 TypeError)
    for (let idx = 0; idx < input.items.length; idx += 1) {
      const it = input.items[idx];
      if (!it || typeof it !== "object" || Array.isArray(it)) {
        throw new MindError(
          "INVALID_INPUT",
          `Verify manifest item #${idx} must be an object`,
          { itemIndex: idx },
        );
      }
      if (it.target !== "record" && it.target !== "seabed") {
        throw new MindError(
          "INVALID_INPUT",
          `Verify manifest item #${idx} has invalid target "${String(it.target)}"`,
          { itemIndex: idx },
        );
      }
      if (typeof it.sourceRef !== "string" || !it.sourceRef.trim()) {
        throw new MindError(
          "INVALID_INPUT",
          `Verify manifest item #${idx} requires a non-empty string sourceRef`,
          { itemIndex: idx },
        );
      }
      if (
        typeof it.expectedRealmRef !== "string" ||
        !it.expectedRealmRef.trim()
      ) {
        throw new MindError(
          "INVALID_INPUT",
          `Verify manifest item #${idx} requires a non-empty string expectedRealmRef`,
          { itemIndex: idx },
        );
      }
      if (typeof it.contentSha256 !== "string") {
        throw new MindError(
          "INVALID_INPUT",
          `Verify manifest item #${idx} requires a string contentSha256`,
          { itemIndex: idx },
        );
      }
      if (
        typeof it.byteLength !== "number" ||
        !Number.isInteger(it.byteLength) ||
        it.byteLength < 0
      ) {
        throw new MindError(
          "INVALID_INPUT",
          `Verify manifest item #${idx} requires a non-negative integer byteLength`,
          { itemIndex: idx },
        );
      }
      if (
        it.expectedOccurredAt !== null &&
        it.expectedOccurredAt !== undefined &&
        typeof it.expectedOccurredAt !== "string"
      ) {
        throw new MindError(
          "INVALID_INPUT",
          `Verify manifest item #${idx} expectedOccurredAt must be a string or null`,
          { itemIndex: idx },
        );
      }
      assertOptString(it.expectedTitle, "expectedTitle", idx, true);
      assertOptString(it.rawContentSha256, "rawContentSha256", idx, true);
    }
    if (input.allExpectedEntries !== undefined) {
      if (!Array.isArray(input.allExpectedEntries)) {
        throw new MindError(
          "INVALID_INPUT",
          "allExpectedEntries must be an array",
        );
      }
      for (let idx = 0; idx < input.allExpectedEntries.length; idx += 1) {
        const exp = input.allExpectedEntries[idx];
        if (
          !exp ||
          typeof exp !== "object" ||
          typeof exp.realmRef !== "string" ||
          (exp.target !== "record" && exp.target !== "seabed") ||
          typeof exp.sourceRef !== "string"
        ) {
          throw new MindError(
            "INVALID_INPUT",
            `allExpectedEntries[${idx}] must have string realmRef, target ("record"|"seabed"), and string sourceRef`,
          );
        }
      }
    }

    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const orgId = viewerRealm.orgId;
    const orgPolicy = this.getOrgPolicy(orgId);
    const writeScope = normalizeWriteScope(params.writeScope);
    const hasSeabedItems = input.items.some((i) => i.target === "seabed");
    // P0 Option A: Align descendant seabed diving strictly with `importBatch` (NEVER for `self` principals!)
    const allowDescendantSeabed = writeScope === "subtree" && hasSeabedItems;
    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed: allowDescendantSeabed,
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    const actor: Actor = params.actor ?? { id: "verifier", kind: "agent" };
    const vis = createVisibilityHelpers({
      db: this.db,
      realms,
      mounts,
      actor,
      viewerRealmId: viewerRealm.id,
      scope,
      includeDescendantSeabed: allowDescendantSeabed,
    });
    const reader = createScopedImporterReader({
      db: this.db,
      orgId,
      scope,
      vis,
    });
    const realmsById = new Map(realms.map((r) => [r.id, r]));
    const allowSkips = Math.max(0, Math.floor(input.allowSkips ?? 0));
    const unaccountedPaths = [...(input.unaccountedPaths ?? [])];

    let expectedCount = 0;
    let foundCount = 0;
    let missingCount = 0;
    let contentMismatchCount = 0;
    let realmMismatchCount = 0;
    let layerMismatchCount = 0;
    let statusMismatchCount = 0;
    let timestampMismatchCount = 0;
    let skippedSecretCount = 0;
    let skippedRedactedCount = 0;
    let totalChecked = 0;
    const mismatches: ImportConsistencyMismatch[] = [];
    const activeSupersededMismatches: ImportConsistencyMismatch[] = [];
    const timestampMismatches: ImportConsistencyMismatch[] = [];

    const seenVerifyKeys = new Set<string>();
    for (const rawItem of input.items) {
      const sourceRef = normalizeSourceRef(rawItem.sourceRef);
      expectedCount += 1;

      if (rawItem.secretSkipped) {
        skippedSecretCount += 1;
        continue;
      }

      const expectedRealm = resolveVisibleRealm({
        realms,
        orgId,
        ref: rawItem.expectedRealmRef,
        scope,
      });

      // Reject duplicate (target, realmId, sourceRef) in the same request to block hash-amplification DoS
      const dedupKey = `${rawItem.target}\u0000${expectedRealm.id}\u0000${sourceRef}`;
      if (seenVerifyKeys.has(dedupKey)) {
        throw new MindError(
          "INVALID_INPUT",
          `Duplicate verify manifest item for (${rawItem.target}, "${expectedRealm.path}", "${sourceRef}") in the same request`,
          {
            reason: "duplicate_verify_item",
            target: rawItem.target,
            sourceRef,
          },
        );
      }
      seenVerifyKeys.add(dedupKey);

      totalChecked += 1;

      // Unified visibility-checked & secret-excluding lookup strictly bounded by `scope`
      const visibleRecs = reader.findLatestRecordsBySourceRef(
        sourceRef,
        scope.readableLedgerIds,
      );
      const visibleSeas = reader.findSeabedBySourceRef(
        sourceRef,
        scope.readableSeabedIds,
        { limitPerRealm: 5 },
      );

      if (rawItem.target === "record") {
        const rec: LedgerRecord | null =
          visibleRecs.find((r) => r.realmId === expectedRealm.id) ??
          visibleRecs[0] ??
          null;

        if (!rec) {
          // Layer mismatch uses ONLY `visibleSeas` already strictly bounded by `scope.readableSeabedIds` & `vis`
          if (visibleSeas.length > 0) {
            layerMismatchCount += 1;
            mismatches.push({
              sourceRef,
              recordId: visibleSeas[0]!.id,
              expected: "record",
              actual: "seabed",
              reason: "Expected record entry but found only seabed entry",
            });
          } else if (
            this.db.isContentShaBlocked(orgId, rawItem.contentSha256) ||
            (rawItem.rawContentSha256 &&
              this.db.isContentShaBlocked(orgId, rawItem.rawContentSha256)) ||
            this.db.isRedactedBlocked(orgId, sourceRef, rawItem.contentSha256)
          ) {
            skippedRedactedCount += 1;
          } else {
            missingCount += 1;
            mismatches.push({
              sourceRef,
              recordId: null,
              expected: expectedRealm.path,
              actual: null,
              reason: "Expected record entry missing from visible scope",
            });
          }
          continue;
        }

        foundCount += 1;

        if (rec.realmId !== expectedRealm.id) {
          realmMismatchCount += 1;
          const actualRealmRaw = realmsById.get(rec.realmId);
          mismatches.push({
            sourceRef,
            recordId: rec.id,
            expected: expectedRealm.path,
            actual: actualRealmRaw
              ? vis.sanitizeRealm(actualRealmRaw).path
              : rec.realmId,
            reason: "Stored record is in a different realm than expected",
          });
        }

        // Recompute SHA-256 & UTF-8 byte length DIRECTLY from stored payload.body (NEVER trust cached metadata hash!)
        const storedBody =
          typeof rec.payload.body === "string" ? rec.payload.body : "";
        const actualSha = sha256Text(storedBody);
        const actualBytes = Buffer.byteLength(storedBody, "utf8");
        if (
          actualSha !== rawItem.contentSha256 ||
          actualBytes !== rawItem.byteLength
        ) {
          contentMismatchCount += 1;
          mismatches.push({
            sourceRef,
            recordId: rec.id,
            expected: `${rawItem.contentSha256} (${rawItem.byteLength}B)`,
            actual: `${actualSha} (${actualBytes}B)`,
            reason:
              "Stored record payload.body SHA-256 or byte length differs from source",
          });
        }

        // P1-5: Verify stored record title when expectedTitle is supplied
        if (
          typeof rawItem.expectedTitle === "string" &&
          rec.title !== rawItem.expectedTitle
        ) {
          contentMismatchCount += 1;
          mismatches.push({
            sourceRef,
            recordId: rec.id,
            expected: rawItem.expectedTitle,
            actual: rec.title,
            reason: "Stored record title differs from source",
          });
        }

        if (rawItem.expectedStatus === "superseded" && rec.status === "active") {
          statusMismatchCount += 1;
          const m: ImportConsistencyMismatch = {
            sourceRef,
            recordId: rec.id,
            expected: "superseded",
            actual: rec.status,
            reason: "Source mapped as superseded/expired but DB row is active",
          };
          activeSupersededMismatches.push(m);
          mismatches.push(m);
        } else if (
          rawItem.expectedStatus === "active" &&
          rec.status === "superseded" &&
          rec.supersededById === null
        ) {
          statusMismatchCount += 1;
          const m: ImportConsistencyMismatch = {
            sourceRef,
            recordId: rec.id,
            expected: "active",
            actual: rec.status,
            reason:
              "Source mapped as active but DB row is orphan superseded with no successor",
          };
          activeSupersededMismatches.push(m);
          mismatches.push(m);
        }

        if (rec.occurredAt !== rawItem.expectedOccurredAt) {
          timestampMismatchCount += 1;
          const m: ImportConsistencyMismatch = {
            sourceRef,
            recordId: rec.id,
            expected: rawItem.expectedOccurredAt,
            actual: rec.occurredAt,
            reason: "Stored occurred_at differs from declared source timestamp",
          };
          timestampMismatches.push(m);
          mismatches.push(m);
        }
      } else {
        // target === "seabed"
        const sea: SeabedEntry | null =
          visibleSeas.find(
            (s) =>
              s.realmId === expectedRealm.id &&
              sha256Text(s.text) === rawItem.contentSha256,
          ) ??
          visibleSeas.find((s) => s.realmId === expectedRealm.id) ??
          visibleSeas[0] ??
          null;

        if (!sea) {
          if (visibleRecs.length > 0) {
            layerMismatchCount += 1;
            mismatches.push({
              sourceRef,
              recordId: visibleRecs[0]!.id,
              expected: "seabed",
              actual: "record",
              reason: "Expected seabed entry but found only record entry",
            });
          } else if (
            this.db.isContentShaBlocked(orgId, rawItem.contentSha256) ||
            this.db.isRedactedBlocked(orgId, sourceRef, rawItem.contentSha256)
          ) {
            skippedRedactedCount += 1;
          } else {
            missingCount += 1;
            mismatches.push({
              sourceRef,
              recordId: null,
              expected: expectedRealm.path,
              actual: null,
              reason: "Expected seabed entry missing from visible scope",
            });
          }
          continue;
        }

        foundCount += 1;

        if (sea.realmId !== expectedRealm.id) {
          realmMismatchCount += 1;
          const actualRealmRaw = realmsById.get(sea.realmId);
          mismatches.push({
            sourceRef,
            recordId: sea.id,
            expected: expectedRealm.path,
            actual: actualRealmRaw
              ? vis.sanitizeRealm(actualRealmRaw).path
              : sea.realmId,
            reason: "Stored seabed entry is in a different realm than expected",
          });
        }

        // Recompute SHA-256 & UTF-8 byte length DIRECTLY from stored sea.text (NEVER trust metadata hash!)
        const actualSha = sha256Text(sea.text);
        const actualBytes = Buffer.byteLength(sea.text, "utf8");
        if (
          actualSha !== rawItem.contentSha256 ||
          actualBytes !== rawItem.byteLength
        ) {
          contentMismatchCount += 1;
          mismatches.push({
            sourceRef,
            recordId: sea.id,
            expected: `${rawItem.contentSha256} (${rawItem.byteLength}B)`,
            actual: `${actualSha} (${actualBytes}B)`,
            reason:
              "Stored seabed text SHA-256 or byte length differs from source",
          });
        }

        if (sea.occurredAt !== rawItem.expectedOccurredAt) {
          timestampMismatchCount += 1;
          const m: ImportConsistencyMismatch = {
            sourceRef,
            recordId: sea.id,
            expected: rawItem.expectedOccurredAt,
            actual: sea.occurredAt,
            reason: "Stored occurred_at differs from declared source timestamp",
          };
          timestampMismatches.push(m);
          mismatches.push(m);
        }
      }
    }

    if (
      input.target !== undefined &&
      input.target !== "record" &&
      input.target !== "seabed"
    ) {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid verify target "${String(input.target)}": expected "record" or "seabed"`,
      );
    }
    const checkedLayers: ImportTargetLayer[] = input.target
      ? [input.target]
      : ["record", "seabed"];

    // P1-5: Check unexpected imported entries keyed by composite (realmId, layer, sourceRef)!
    const unexpectedEntries: VerifyImportUnexpectedEntry[] = [];
    if (
      input.checkUnexpectedInRealmRefs &&
      input.checkUnexpectedInRealmRefs.length > 0
    ) {
      const checkLedgerIds: string[] = [];
      const checkSeabedIds: string[] = [];
      const readableLedgerSet = new Set(scope.readableLedgerIds);
      const readableSeabedSet = new Set(scope.readableSeabedIds);
      const checkRecordLayer = checkedLayers.includes("record");
      const checkSeabedLayer = checkedLayers.includes("seabed");

      for (const ref of input.checkUnexpectedInRealmRefs) {
        if (!ref?.trim()) continue;
        const realm = resolveVisibleRealm({
          realms,
          orgId,
          ref: ref.trim(),
          scope,
        });
        // P0 Option A: Determine readable realms strictly from `scope` (zero raw resolveAccess fallbacks!)
        // Dogfood (a): Respect explicit --target layer so seabed entries don't false-positive on record verify (and vice versa).
        if (checkRecordLayer && readableLedgerSet.has(realm.id)) {
          checkLedgerIds.push(realm.id);
        }
        if (checkSeabedLayer && readableSeabedSet.has(realm.id)) {
          checkSeabedIds.push(realm.id);
        }
      }

      const expectedCompositeKeys = new Set<string>();
      const sourceEntries: VerifyImportExpectedKey[] =
        input.allExpectedEntries && input.allExpectedEntries.length > 0
          ? input.allExpectedEntries
          : input.items
              .filter((i) => !i.secretSkipped)
              .map((i) => ({
                realmRef: i.expectedRealmRef,
                target: i.target,
                sourceRef: i.sourceRef,
              }));

      for (const exp of sourceEntries) {
        try {
          const r = resolveVisibleRealm({
            realms,
            orgId,
            ref: exp.realmRef,
            scope,
          });
          expectedCompositeKeys.add(
            `${r.id}\u0000${exp.target}\u0000${normalizeSourceRef(exp.sourceRef)}`,
          );
        } catch {
          // Ignore non-visible expected realm ref when building expected set
        }
      }

      // Fallback legacy set if caller passed ONLY allExpectedSourceRefs without items/allExpectedEntries
      const useFallbackSourceRefOnly =
        expectedCompositeKeys.size === 0 &&
        Boolean(input.allExpectedSourceRefs && input.allExpectedSourceRefs.length > 0);
      const fallbackRefSet = useFallbackSourceRefOnly
        ? new Set(input.allExpectedSourceRefs!.map(normalizeSourceRef))
        : null;

      // Every returned entry is verified through ScopedImporterReader (vis.canSeeRecord / vis.canSeeSeabed + non-secret)
      const importedInRealms = reader.listImportedEntriesInRealms(
        checkLedgerIds,
        checkSeabedIds,
      );
      for (const entry of importedInRealms) {
        const norm = normalizeSourceRef(entry.sourceRef);
        const compositeKey = `${entry.realmId}\u0000${entry.layer}\u0000${norm}`;
        const isExpected = useFallbackSourceRefOnly
          ? fallbackRefSet!.has(norm)
          : expectedCompositeKeys.has(compositeKey);
        if (!isExpected) {
          const realmRaw = realmsById.get(entry.realmId);
          unexpectedEntries.push({
            sourceRef: norm,
            entryId: entry.entryId,
            realmPath: realmRaw
              ? vis.sanitizeRealm(realmRaw).path
              : entry.realmId,
            layer: entry.layer,
          });
        }
      }
    }

    const totalSourceFiles =
      input.totalSourceFiles ??
      expectedCount + (input.excludedCount ?? 0) + unaccountedPaths.length;
    const excludedCount = input.excludedCount ?? 0;
    const unaccountedCount = unaccountedPaths.length;
    const unexpectedCount = unexpectedEntries.length;

    const passed =
      unaccountedCount === 0 &&
      missingCount === 0 &&
      contentMismatchCount === 0 &&
      realmMismatchCount === 0 &&
      layerMismatchCount === 0 &&
      statusMismatchCount === 0 &&
      timestampMismatchCount === 0 &&
      unexpectedCount === 0 &&
      skippedSecretCount + skippedRedactedCount <= allowSkips;

    return {
      passed,
      totalSourceFiles,
      expectedCount,
      excludedCount,
      unaccountedCount,
      unaccountedPaths,
      foundCount,
      missingCount,
      contentMismatchCount,
      realmMismatchCount,
      layerMismatchCount,
      statusMismatchCount,
      timestampMismatchCount,
      unexpectedCount,
      skippedSecretCount,
      skippedRedactedCount,
      allowSkips,
      checkedLayers,
      mismatches,
      unexpectedEntries,
      totalChecked,
      undatedCount: 0,
      defaultRealmFallbackCount: 0,
      activeSupersededMismatches,
      timestampMismatches,
    };
  }

  /**
   * Imports a Markdown file or directory of Markdown files via the unified `planMarkdownImport` + `ingestBatch` pipeline.
   */
  async importMd(params: {
    actor?: Actor;
    viewerRealmId: string;
    writeScope?: TokenWriteScope;
    targetRealmRef?: string;
    inputPath: string;
    baseDir?: string;
    sourceRef?: string;
    target?: ImportTargetLayer;
    kind?: RecordKind | SeabedKind;
    extKind?: string;
    sensitivity?: Sensitivity;
    skipSecret?: boolean;
    objectIds?: string[];
    resourceTags?: string[];
    mapping?: ImportMappingConfig;
    exclude?: string[];
    relocate?: boolean;
    syncEmbeddings?: boolean;
    /** Maximum allowed bytes per Markdown item (default: 1.2 MB) */
    maxFileBytes?: number;
  }): Promise<ImportMdResult> {
    const actor: Actor = params.actor ?? { id: "importer", kind: "agent" };
    const mapping = params.mapping;
    const skipSecret = resolveImportSkipSecret(params.skipSecret, mapping);

    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const orgPolicy = this.getOrgPolicy(viewerRealm.orgId);
    const scope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed: false,
    });

    if (mapping?.realmMap) {
      for (const targetRef of Object.values(mapping.realmMap)) {
        if (targetRef && targetRef.trim()) {
          resolveVisibleRealm({
            realms,
            orgId: viewerRealm.orgId,
            ref: targetRef.trim(),
            scope,
          });
        }
      }
    }

    const planned = planMarkdownImport({
      inputPath: params.inputPath,
      baseDir: params.baseDir,
      sourceRef: params.sourceRef,
      target: params.target,
      targetRealmRef: params.targetRealmRef,
      kind: params.kind,
      extKind: params.extKind,
      sensitivity: params.sensitivity,
      objectRefs: params.objectIds,
      resourceTags: params.resourceTags,
      mapping,
      exclude: params.exclude,
      maxItemBytes: params.maxFileBytes ?? MAX_IMPORT_ITEM_BYTES,
    });

    const chunks = chunkImportBatchItems(planned.items);
    const items: ImportMdItemResult[] = [];
    let created = 0;
    let superseded = 0;
    let skippedUnchanged = 0;
    let skippedRedacted = 0;
    let skippedSecret = 0;

    for (const chunk of chunks) {
      const res = this.ingestBatch({
        actor,
        viewerRealmId: viewerRealm.id,
        writeScope: params.writeScope,
        input: {
          items: chunk,
          defaultRealmRef: params.targetRealmRef ?? mapping?.defaultRealm,
          skipSecret,
          relocate: params.relocate,
        },
      });
      created += res.created;
      superseded += res.superseded;
      skippedUnchanged += res.skippedUnchanged;
      skippedRedacted += res.skippedRedacted;
      skippedSecret += res.skippedSecret;
      for (const it of res.items) {
        items.push({
          filePath: it.filePath ?? it.sourceRef,
          sourceRef: it.sourceRef,
          contentSha256: it.contentSha256,
          action:
            it.action === "relocated"
              ? it.supersedesId
                ? "superseded"
                : "created"
              : it.action,
          recordId: it.entryId,
          supersedesId: it.supersedesId,
          realmId: it.realmId,
          occurredAt: it.occurredAt,
        });
      }
    }

    const embeddingsSynced = params.syncEmbeddings
      ? await this.sea.syncEmbeddings()
      : undefined;

    return {
      totalFiles: planned.totalFiles,
      created,
      superseded,
      skippedUnchanged,
      skippedRedacted,
      skippedSecret,
      undatedCount: planned.undatedCount,
      defaultRealmCount: planned.defaultRealmCount,
      items,
      ...(embeddingsSynced ? { embeddingsSynced } : {}),
    };
  }

  /**
   * Generic field-mapped JSONL importer via the unified `planJsonlImport` + `ingestBatch` pipeline.
   */
  async importJsonl(params: {
    actor?: Actor;
    viewerRealmId: string;
    writeScope?: TokenWriteScope;
    targetRealmRef?: string;
    jsonlPath: string;
    mapping: ImportMappingConfig;
    target?: ImportTargetLayer;
    skipSecret?: boolean;
    relocate?: boolean;
    syncEmbeddings?: boolean;
  }): Promise<ImportJsonlResult> {
    const actor: Actor = params.actor ?? { id: "importer", kind: "agent" };
    const mapping = params.mapping;
    const skipSecret = resolveImportSkipSecret(params.skipSecret, mapping);

    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const orgPolicy = this.getOrgPolicy(viewerRealm.orgId);
    const scope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed: false,
    });

    if (mapping.realmMap) {
      for (const targetRef of Object.values(mapping.realmMap)) {
        if (targetRef && targetRef.trim()) {
          resolveVisibleRealm({
            realms,
            orgId: viewerRealm.orgId,
            ref: targetRef.trim(),
            scope,
          });
        }
      }
    }

    const planned = planJsonlImport({
      jsonlPath: params.jsonlPath,
      mapping,
      target: params.target,
      targetRealmRef: params.targetRealmRef,
    });

    const chunks = chunkImportBatchItems(planned.items);
    const idMap: Record<string, string> = {};
    const entryIds: string[] = [];
    let imported = 0;
    let superseded = 0;
    let skippedSecret = 0;
    let skippedRedacted = 0;
    let treeDegradedCrossRealmSupersedes = 0;

    for (const chunk of chunks) {
      const res = this.ingestBatch({
        actor,
        viewerRealmId: viewerRealm.id,
        writeScope: params.writeScope,
        input: {
          items: chunk,
          defaultRealmRef: params.targetRealmRef ?? mapping.defaultRealm,
          skipSecret,
          relocate: params.relocate,
        },
      });
      imported +=
        res.created + res.superseded + res.relocated + res.skippedUnchanged;
      superseded += res.superseded;
      skippedSecret += res.skippedSecret;
      skippedRedacted += res.skippedRedacted;
      treeDegradedCrossRealmSupersedes += res.treeDegradedCrossRealmSupersedes;

      for (const it of res.items) {
        if (it.entryId) {
          entryIds.push(it.entryId);
          if (it.sourceId) idMap[it.sourceId] = it.entryId;
        }
      }
    }

    const embeddingsSynced = params.syncEmbeddings
      ? await this.sea.syncEmbeddings()
      : undefined;

    return {
      totalRows: planned.totalRows,
      imported,
      superseded,
      skippedSecret,
      skippedRedacted,
      treeDegradedCrossRealmSupersedes,
      undatedCount: planned.undatedCount,
      defaultRealmCount: planned.defaultRealmCount,
      idMap,
      entryIds,
      ...(embeddingsSynced ? { embeddingsSynced } : {}),
    };
  }

  /**
   * Local independent verification delegating to the exact same `planSourceVerification`
   * + chunked `verifyImportManifest` engine used by `POST /v1/import/verify`.
   */
  verifyImportConsistency(params: {
    actor?: Actor;
    viewerRealmId: string;
    writeScope?: TokenWriteScope;
    sourcePath: string;
    mapping?: ImportMappingConfig;
    baseDir?: string;
    target?: ImportTargetLayer;
    targetRealmRef?: string;
    exclude?: string[];
    checkUnexpectedInRealmRefs?: string[];
    allowSkips?: number;
    skipSecret?: boolean;
  }): ImportConsistencyResult {
    const realms = this.db.listRealms();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }

    const planned = planSourceVerification({
      sourcePath: params.sourcePath,
      mapping: params.mapping,
      baseDir: params.baseDir,
      target: params.target,
      targetRealmRef: params.targetRealmRef,
      defaultRealmRef: viewerRealm.path,
      skipSecret: params.skipSecret,
      exclude: params.exclude,
    });

    const allowSkips = params.allowSkips ?? 0;
    const chunks = chunkVerifyManifestItems(planned.items, 200);
    const parts: VerifyImportResult[] = [];
    if (chunks.length === 0) {
      parts.push(
        this.verifyImportManifest({
          actor: params.actor,
          viewerRealmId: viewerRealm.id,
          writeScope: params.writeScope,
          input: {
            items: [],
            target: params.target,
            checkUnexpectedInRealmRefs: params.checkUnexpectedInRealmRefs,
            allExpectedSourceRefs: planned.allExpectedSourceRefs,
            allExpectedEntries: planned.allExpectedEntries,
            allowSkips,
            totalSourceFiles: planned.totalSourceFiles,
            excludedCount: planned.excludedCount,
            unaccountedPaths: planned.unaccountedPaths,
          },
        }),
      );
    } else {
      for (let i = 0; i < chunks.length; i += 1) {
        parts.push(
          this.verifyImportManifest({
            actor: params.actor,
            viewerRealmId: viewerRealm.id,
            writeScope: params.writeScope,
            input: {
              items: chunks[i]!,
              target: params.target,
              checkUnexpectedInRealmRefs:
                i === 0 ? params.checkUnexpectedInRealmRefs : undefined,
              allExpectedSourceRefs:
                i === 0 ? planned.allExpectedSourceRefs : undefined,
              allExpectedEntries:
                i === 0 ? planned.allExpectedEntries : undefined,
              allowSkips,
            },
          }),
        );
      }
    }

    return mergeVerifyImportResults(parts, {
      totalSourceFiles: planned.totalSourceFiles,
      excludedCount: planned.excludedCount,
      unaccountedPaths: planned.unaccountedPaths,
      allowSkips,
      checkedLayers: params.target ? [params.target] : ["record", "seabed"],
      undatedCount: planned.undatedCount,
      defaultRealmFallbackCount: planned.defaultRealmFallbackCount,
    });
  }

  /**
   * Read-only dry-run preview for `import md` or `import jsonl`.
   * Never mutates SQLite and never lazily creates `/inbox`.
   */
  previewImport(params: {
    viewerRealmId: string;
    sourcePath: string;
    sourceType?: "md" | "jsonl";
    mapping?: ImportMappingConfig;
    baseDir?: string;
    targetRealmRef?: string;
    /** Virtual fallback path (e.g. "/inbox") when default realm does not exist yet */
    virtualDefaultRealmPath?: string;
    skipSecret?: boolean;
    exclude?: string[];
    /** Maximum allowed bytes per Markdown file (default: 1.2 MB) */
    maxFileBytes?: number;
  }): ImportDryRunResult {
    const mapping = params.mapping;
    const filenameDateRe = validateMappingConfig(mapping);
    const skipSecret = resolveImportSkipSecret(params.skipSecret, mapping);
    const maxFileBytes = params.maxFileBytes ?? MAX_IMPORT_ITEM_BYTES;
    const excludePatterns = params.exclude ?? [];

    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const orgPolicy = this.getOrgPolicy(viewerRealm.orgId);
    const scope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed: false,
    });

    let plannedDefaultRealm: string;
    if (params.targetRealmRef) {
      plannedDefaultRealm = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: params.targetRealmRef,
        scope,
      }).path;
    } else if (mapping?.defaultRealm) {
      plannedDefaultRealm = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: mapping.defaultRealm,
        scope,
      }).path;
    } else if (params.virtualDefaultRealmPath) {
      plannedDefaultRealm = params.virtualDefaultRealmPath;
    } else {
      plannedDefaultRealm = viewerRealm.path;
    }

    const abs = path.resolve(params.sourcePath);
    if (!fs.existsSync(abs)) {
      throw new MindError(
        "NOT_FOUND",
        `Source path not found: ${params.sourcePath}`,
      );
    }
    const stat = fs.statSync(abs);
    const sourceType: "md" | "jsonl" =
      params.sourceType ??
      (stat.isFile() && /\.jsonl$/i.test(abs) ? "jsonl" : "md");

    let totalItems = 0;
    let defaultRealmCount = 0;
    let undatedCount = 0;
    let skippedSecret = 0;
    let skippedRedacted = 0;
    const realmDistribution: Record<string, number> = {};
    const unmatchedRealmValues: Record<string, number> = {};
    const unresolvedMap = new Map<string, ImportDryRunUnresolvedRealm>();
    const oversizedFiles: ImportDryRunOversizedFile[] = [];

    const bump = (map: Record<string, number>, key: string) => {
      map[key] = (map[key] ?? 0) + 1;
    };

    const resolveRowRealm = (rawRealmVal: unknown): void => {
      const rawRealmStr =
        rawRealmVal !== undefined && rawRealmVal !== null
          ? String(rawRealmVal).trim()
          : "";
      if (!rawRealmStr) {
        defaultRealmCount += 1;
        bump(realmDistribution, plannedDefaultRealm);
        return;
      }
      const inMap = mapping?.realmMap
        ? Object.prototype.hasOwnProperty.call(mapping.realmMap, rawRealmStr)
        : false;
      const mappedRef = inMap
        ? mapping!.realmMap![rawRealmStr]!.trim()
        : rawRealmStr;
      if (!mappedRef) {
        defaultRealmCount += 1;
        bump(unmatchedRealmValues, rawRealmStr);
        bump(realmDistribution, plannedDefaultRealm);
        return;
      }
      try {
        const resolved = resolveVisibleRealm({
          realms,
          orgId: viewerRealm.orgId,
          ref: mappedRef,
          scope,
        });
        bump(realmDistribution, resolved.path);
      } catch {
        if (!inMap) {
          bump(unmatchedRealmValues, rawRealmStr);
        }
        const key = `${rawRealmStr}\u0000${mappedRef}`;
        const existing = unresolvedMap.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          unresolvedMap.set(key, {
            rawValue: rawRealmStr,
            targetRef: mappedRef,
            count: 1,
          });
        }
      }
    };

    if (sourceType === "jsonl") {
      if (!mapping) {
        throw new MindError(
          "INVALID_INPUT",
          "JSONL import dry-run requires a --map configuration",
        );
      }
      const rawText = decodeUtf8Strict(fs.readFileSync(abs), params.sourcePath);
      const lines = rawText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!.trim();
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          throw new MindError(
            "INVALID_INPUT",
            `Invalid JSON on line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new MindError(
            "INVALID_INPUT",
            `Expected JSON object on line ${i + 1}`,
          );
        }
        const row = parsed as Record<string, unknown>;
        totalItems += 1;

        const occurredAt = resolveMostPreciseDeclaredTimestamp(
          getAllFields(row, mapping.occurredAt),
        );
        if (occurredAt === null) undatedCount += 1;

        const rawSens = getFieldByPath(row, mapping.sensitivity);
        const sens =
          typeof rawSens === "string" &&
          VALID_SENSITIVITIES.has(rawSens.trim().toLowerCase())
            ? (rawSens.trim().toLowerCase() as Sensitivity)
            : (mapping.defaultSensitivity ?? "internal");
        if (
          skipSecret &&
          (sens === "secret" || Boolean(detectPlaintextSecret(JSON.stringify(row))))
        ) {
          skippedSecret += 1;
          continue;
        }
        const contentSha256 = computePayloadHash(row);
        if (this.db.isContentShaBlocked(viewerRealm.orgId, contentSha256)) {
          skippedRedacted += 1;
          continue;
        }

        const rawRealmVal = mapping.realmPath
          ? getFieldByPath(row, mapping.realmPath)
          : undefined;
        resolveRowRealm(rawRealmVal);
      }
    } else {
      const { baseDir, isSingleFile, files } = collectMarkdownFiles(
        params.sourcePath,
        params.baseDir,
      );
      const hasExplicitBaseDir = Boolean(params.baseDir?.trim());
      for (const filePath of files) {
        const relPathNfc = normalizeSourceRef(
          path.relative(baseDir, filePath).split(path.sep).join("/") ||
            path.basename(filePath),
        );
        if (matchesExcludePattern(relPathNfc, excludePatterns)) {
          continue;
        }
        totalItems += 1;
        const sizeBytes = fs.statSync(filePath).size;
        if (sizeBytes > maxFileBytes) {
          oversizedFiles.push({
            path: relPathNfc,
            sizeBytes,
            limitBytes: maxFileBytes,
          });
          continue;
        }
        const rawContent = decodeUtf8Strict(fs.readFileSync(filePath), filePath);
        const sha = sha256Text(rawContent);
        const sourceRef = deriveDefaultSourceRef({
          filePath,
          baseDir,
          isSingleFile,
          hasExplicitBaseDir,
        });
        const fallbackTitle = path
          .basename(filePath, path.extname(filePath))
          .normalize("NFC");
        const parsed = parseMarkdownDocument(rawContent, fallbackTitle);
        const fm = parsed.frontmatter;

        const mappedOccurred = mapping?.occurredAt
          ? resolveMostPreciseDeclaredTimestamp(
              getAllFields(fm, mapping.occurredAt),
            )
          : null;
        const occurredAt =
          mappedOccurred ??
          parsed.occurredAt ??
          extractFilenameDate(filenameDateRe, filePath, sourceRef);
        if (occurredAt === null) undatedCount += 1;

        const rawMappedSens = mapping?.sensitivity
          ? getFieldByPath(fm, mapping.sensitivity)
          : undefined;
        const mappedSens =
          typeof rawMappedSens === "string" &&
          VALID_SENSITIVITIES.has(rawMappedSens.trim().toLowerCase())
            ? (rawMappedSens.trim().toLowerCase() as Sensitivity)
            : null;
        const sens =
          mappedSens ??
          parsed.sensitivity ??
          mapping?.defaultSensitivity ??
          "internal";
        if (
          skipSecret &&
          (sens === "secret" || Boolean(detectPlaintextSecret(rawContent)))
        ) {
          skippedSecret += 1;
          continue;
        }
        if (
          this.db.isContentShaBlocked(viewerRealm.orgId, sha) ||
          this.db.isContentShaBlocked(viewerRealm.orgId, sha256Text(parsed.body))
        ) {
          skippedRedacted += 1;
          continue;
        }

        const rawRealmVal = mapping?.realmPath
          ? getFieldByPath(fm, mapping.realmPath)
          : undefined;
        resolveRowRealm(rawRealmVal);
      }
    }

    const unresolvedRealms = Array.from(unresolvedMap.values()).sort(
      (a, b) => b.count - a.count,
    );

    return {
      dryRun: true,
      sourceType,
      totalItems,
      plannedDefaultRealm,
      defaultRealmCount,
      undatedCount,
      skippedSecret,
      skippedRedacted,
      realmDistribution,
      unmatchedRealmValues,
      unresolvedRealms,
      oversizedFiles,
      valid: unresolvedRealms.length === 0 && oversizedFiles.length === 0,
    };
  }
}
