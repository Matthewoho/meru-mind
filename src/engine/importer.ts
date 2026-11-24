import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isRealmEffectivelyArchived,
  resolveAccess,
  resolveAccessScope,
} from "../policy.js";
import type { DbPort } from "../ports.js";
import {
  MindError,
  type Actor,
  type ImportConsistencyMismatch,
  type ImportConsistencyResult,
  type ImportDryRunOversizedFile,
  type ImportDryRunResult,
  type ImportDryRunUnresolvedRealm,
  type ImportJsonlResult,
  type ImportMappingConfig,
  type ImportMdItemResult,
  type ImportMdResult,
  type OrgPolicy,
  type Realm,
  type RecordKind,
  type SeabedKind,
  type Sensitivity,
} from "../types.js";
import {
  computePayloadHash,
  computeRecordContentSha256,
  computeSeabedContentSha256,
} from "./content-hash.js";
import type { LedgerEngine } from "./ledger.js";
import {
  normalizeResourceTag,
  OPAQUE_REALM_NOT_FOUND,
  resolveVisibleRealm,
} from "./objects.js";
import type { SeaEngine } from "./sea.js";

/** Shared 2 MB limit aligned with remote HTTP JSON body cap (`http-server.ts`). */
export const MAX_IMPORT_MD_BYTES = 2 * 1024 * 1024;

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

function normalizeDeclaredTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return null;

  // Accept ISO date (YYYY-MM-DD) or ISO-8601 datetime strings
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Support "YYYY-MM-DD HH:mm:ss" by converting space to T
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
  const content = rawContent.replace(/\r\n/g, "\n");
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
): {
  baseDir: string;
  isSingleFile: boolean;
  files: string[];
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
      return { baseDir: resolvedBase, isSingleFile: true, files: [abs] };
    }
    return { baseDir: path.dirname(abs), isSingleFile: true, files: [abs] };
  }
  if (!stat.isDirectory()) {
    throw new MindError(
      "INVALID_INPUT",
      `Unsupported path type for import-md: ${inputPath}`,
    );
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
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
    return { baseDir: resolvedBase, isSingleFile: false, files };
  }
  return { baseDir: abs, isSingleFile: false, files };
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
    return rel || path.basename(params.filePath);
  }
  const parentName = path.basename(path.dirname(params.filePath));
  const baseName = path.basename(params.filePath);
  return parentName ? `${parentName}/${baseName}` : baseName;
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
  const base = path.basename(filePath);
  const m = regex.exec(base) ?? regex.exec(sourceRef);
  if (!m) return null;
  const raw = m[1] ?? m[0];
  return normalizeDeclaredTimestamp(raw);
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
   * Imports a Markdown file or directory of Markdown files into the ledger.
   * Supports unified ImportMappingConfig, never fabricates timestamps for undated sources
   * (persists occurredAt: null), enforces statusMap & validUntil, and skips redacted_blocklist hits.
   */
  async importMd(params: {
    actor?: Actor;
    viewerRealmId: string;
    targetRealmRef?: string;
    inputPath: string;
    baseDir?: string;
    sourceRef?: string;
    kind?: RecordKind;
    extKind?: string;
    sensitivity?: Sensitivity;
    skipSecret?: boolean;
    objectIds?: string[];
    resourceTags?: string[];
    mapping?: ImportMappingConfig;
    syncEmbeddings?: boolean;
    /** Maximum allowed bytes per Markdown file (default: 2 MB, aligned with remote write limit) */
    maxFileBytes?: number;
  }): Promise<ImportMdResult> {
    const actor: Actor = params.actor ?? { id: "importer", kind: "agent" };
    const mapping = params.mapping;
    const filenameDateRe = validateMappingConfig(mapping);
    const skipSecret = params.skipSecret ?? mapping?.skipSecret ?? true;
    const maxFileBytes = params.maxFileBytes ?? MAX_IMPORT_MD_BYTES;

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

    const defaultRealm: Realm = params.targetRealmRef
      ? resolveVisibleRealm({
          realms,
          orgId: viewerRealm.orgId,
          ref: params.targetRealmRef,
          scope,
        })
      : mapping?.defaultRealm
        ? resolveVisibleRealm({
            realms,
            orgId: viewerRealm.orgId,
            ref: mapping.defaultRealm,
            scope,
          })
        : viewerRealm;

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

    const orgObjects = this.db.listObjects({
      orgId: viewerRealm.orgId,
      realmIds: scope.readableLedgerIds,
    });
    const objectsById = new Map(orgObjects.map((o) => [o.id, o]));
    const objectsByKindName = new Map(
      orgObjects.map((o) => [`${o.kind.toLowerCase()}:${o.name.toLowerCase()}`, o]),
    );

    const { baseDir, isSingleFile, files } = collectMarkdownFiles(
      params.inputPath,
      params.baseDir,
    );
    const hasExplicitBaseDir = Boolean(params.baseDir?.trim());
    if (params.sourceRef && files.length > 1) {
      throw new MindError(
        "INVALID_INPUT",
        "Explicit sourceRef can only be used when importing a single Markdown file",
      );
    }

    const extraTags = (params.resourceTags ?? []).map((t) =>
      normalizeResourceTag(t),
    );
    const items: ImportMdItemResult[] = [];
    let created = 0;
    let superseded = 0;
    let skippedUnchanged = 0;
    let skippedRedacted = 0;
    let skippedSecret = 0;
    let undatedCount = 0;
    let defaultRealmCount = 0;
    const nowIso = new Date().toISOString();

    // Pre-check file sizes before reading or mutating SQLite (aligned with 2 MB remote write cap)
    for (const filePath of files) {
      const sizeBytes = fs.statSync(filePath).size;
      if (sizeBytes > maxFileBytes) {
        throw new MindError(
          "INVALID_INPUT",
          `Markdown file exceeds ${maxFileBytes} byte import limit (${sizeBytes} bytes): ${filePath}`,
          {
            try: "Run 'meru-mind import md <path> --dry-run' to list oversized files, or split/store raw attachments externally.",
          },
        );
      }
    }

    for (const filePath of files) {
      const rawContent = fs.readFileSync(filePath, "utf8");
      const newSha256 = sha256Text(rawContent);
      const sourceRef =
        params.sourceRef?.trim() ||
        deriveDefaultSourceRef({
          filePath,
          baseDir,
          isSingleFile,
          hasExplicitBaseDir,
        });
      const fallbackTitle = path.basename(filePath, path.extname(filePath));

      const parsed = parseMarkdownDocument(rawContent, fallbackTitle);
      const fm = parsed.frontmatter;

      // Mapped occurredAt -> parsed frontmatter/header occurredAt -> opt-in filenameDatePattern -> null
      const mappedOccurred = mapping?.occurredAt
        ? normalizeDeclaredTimestamp(getFirstField(fm, mapping.occurredAt))
        : null;
      const occurredAt: string | null =
        mappedOccurred ??
        parsed.occurredAt ??
        extractFilenameDate(filenameDateRe, filePath, sourceRef);

      if (occurredAt === null) {
        undatedCount += 1;
      }

      // Sensitivity resolution
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

      // Realm resolution via mapping.realmPath + realmMap, else defaultRealm
      let targetRealm = defaultRealm;
      let usedDefaultRealm = true;
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
          targetRealm = resolveVisibleRealm({
            realms,
            orgId: viewerRealm.orgId,
            ref: mappedRealmRef,
            scope,
          });
          usedDefaultRealm = false;
        }
      }
      if (usedDefaultRealm) {
        defaultRealmCount += 1;
      }

      if (skipSecret && sensitivity === "secret") {
        skippedSecret += 1;
        items.push({
          filePath,
          sourceRef,
          contentSha256: newSha256,
          action: "skipped_secret",
          recordId: null,
          supersedesId: null,
          realmId: targetRealm.id,
          occurredAt,
        });
        continue;
      }

      // Check redacted_blocklist globally by (org_id, content_sha256) regardless of source_ref
      if (this.db.isContentShaBlocked(viewerRealm.orgId, newSha256)) {
        skippedRedacted += 1;
        items.push({
          filePath,
          sourceRef,
          contentSha256: newSha256,
          action: "skipped_redacted",
          recordId: null,
          supersedesId: null,
          realmId: targetRealm.id,
          occurredAt,
        });
        continue;
      }

      // Status & validUntil resolution (strictly active | superseded; rejects retracted)
      const rawStatus = mapping?.status
        ? getFieldByPath(fm, mapping.status)
        : fm.status;
      const rawValidUntil = mapping?.validUntil
        ? getFirstField(fm, mapping.validUntil)
        : (fm.valid_until ?? fm.validUntil);
      const initialStatus = resolveMappedInitialStatus({
        rawStatus,
        rawValidUntil,
        statusMap: mapping?.statusMap,
        nowIso,
      });

      // Active chain head lookup:
      // - open mode: (org_id, source_ref) so explicit mapping reassignment supersedes old head cleanly
      // - tree mode: (org_id, realm_id, source_ref) to preserve strict realm partition
      const head =
        orgPolicy === "open"
          ? this.db.findActiveRecordBySourceRef(viewerRealm.orgId, sourceRef)
          : this.db.findActiveRecordBySourceRef(
              viewerRealm.orgId,
              sourceRef,
              targetRealm.id,
            );

      // P0-2 / N2 protection against undoing human `entry move`:
      // 1) In `tree` mode, if no active head exists in `targetRealm`, check whether an active head
      //    for this sourceRef already lives in another realm of the same org (single-rev or multi-rev
      //    moved by a human admin). Skip cleanly without leaking the other realm or crashing mid-batch.
      if (orgPolicy === "tree" && !head) {
        const orgHead = this.db.findActiveRecordBySourceRef(
          viewerRealm.orgId,
          sourceRef,
        );
        if (orgHead && orgHead.realmId !== targetRealm.id) {
          skippedUnchanged += 1;
          items.push({
            filePath,
            sourceRef,
            contentSha256: newSha256,
            action: "skipped_unchanged",
            recordId: null,
            supersedesId: null,
            realmId: targetRealm.id,
            occurredAt,
          });
          continue;
        }
      }

      // 2) In `open` mode, when no per-file mapping.realm override is active, honor BOTH fallback
      //    defaults (!targetRealmRef, "/", "/inbox") AND any prior explicit human `entry move`
      //    (recorded via `move_in` in change_log) so re-importing with `--in /ops` never reverts
      //    a human-triaged entry back to the import's default realm.
      const isFallbackRealm =
        usedDefaultRealm &&
        (!params.targetRealmRef?.trim() ||
          defaultRealm.path === "/" ||
          defaultRealm.path === "/inbox");
      const wasHumanMoved =
        orgPolicy === "open" &&
        usedDefaultRealm &&
        head !== null &&
        head.realmId !== targetRealm.id &&
        this.db.hasRecordLineageChangeLogOp(
          viewerRealm.orgId,
          head.id,
          "move_in",
          head.realmId,
        );

      const effectiveRealmId =
        orgPolicy === "open" &&
        (isFallbackRealm || wasHumanMoved) &&
        head &&
        head.realmId !== targetRealm.id &&
        !isRealmEffectivelyArchived(realms, head.realmId)
          ? head.realmId
          : targetRealm.id;

      const headSha =
        head && typeof head.payload.contentSha256 === "string"
          ? head.payload.contentSha256
          : null;

      if (
        head &&
        headSha === newSha256 &&
        head.realmId === effectiveRealmId &&
        head.status === initialStatus
      ) {
        skippedUnchanged += 1;
        items.push({
          filePath,
          sourceRef,
          contentSha256: newSha256,
          action: "skipped_unchanged",
          recordId: head.id,
          supersedesId: null,
          realmId: effectiveRealmId,
          occurredAt,
        });
        continue;
      }

      // Kind resolution
      let mappedKind: RecordKind | null = null;
      if (mapping?.kind) {
        const rawK = getFieldByPath(fm, mapping.kind);
        if (typeof rawK === "string" && rawK.trim()) {
          const kVal = mapping.kindMap?.[rawK.trim()] ?? rawK.trim();
          if (VALID_RECORD_KINDS.has(kVal)) {
            mappedKind = kVal as RecordKind;
          }
        }
      }
      const defaultMappingKind =
        mapping?.defaultKind && VALID_RECORD_KINDS.has(mapping.defaultKind)
          ? (mapping.defaultKind as RecordKind)
          : null;
      const desiredKind: RecordKind =
        head?.kind ??
        params.kind ??
        mappedKind ??
        parsed.kind ??
        defaultMappingKind ??
        "claim";

      // Object references & tags from mapping
      const mappedObjIds: string[] = [...(params.objectIds ?? [])];
      if (mapping?.objectRefs) {
        for (const ref of toStringArray(getFieldByPath(fm, mapping.objectRefs))) {
          const m = mapping.objectMap?.[ref] ?? ref;
          if (objectsById.has(m)) mappedObjIds.push(m);
          else {
            const byName = objectsByKindName.get(m.toLowerCase());
            if (byName) mappedObjIds.push(byName.id);
          }
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
      const mergedTags = Array.from(
        new Set([...extraTags, ...parsed.tags, ...mappedTags]),
      );

      const payload: Record<string, unknown> = {
        summary: parsed.summary,
        body: parsed.body,
        sourceRef,
        contentSha256: newSha256,
        ...(Object.keys(fm).length > 0 ? { frontmatter: fm } : {}),
      };
      if (mapping?.extractFields && mapping.extractFields.length > 0) {
        for (const fp of mapping.extractFields) {
          const val = getFieldByPath(fm, fp);
          if (val !== undefined) {
            payload[fp.replace(/\./g, "_")] = val;
          }
        }
      }

      if (
        this.db.isContentShaBlocked(
          viewerRealm.orgId,
          computeRecordContentSha256(parsed.title, payload),
        )
      ) {
        skippedRedacted += 1;
        items.push({
          filePath,
          sourceRef,
          contentSha256: newSha256,
          action: "skipped_redacted",
          recordId: null,
          supersedesId: null,
          realmId: targetRealm.id,
          occurredAt,
        });
        continue;
      }

      // Optional explicit supersedes list from frontmatter
      const explicitSupersedes = mapping?.supersedes
        ? toStringArray(getFieldByPath(fm, mapping.supersedes))
        : [];
      const supersedesIds = Array.from(
        new Set([
          ...(head ? [head.id] : []),
          ...explicitSupersedes,
        ]),
      );

      if (supersedesIds.length === 0) {
        const rec = await this.ledger.appendRecord({
          actor,
          viewerRealmId: viewerRealm.id,
          targetRealmId: targetRealm.id,
          kind: desiredKind,
          extKind: params.extKind,
          title: parsed.title,
          payload,
          externalRef: parsed.externalRef,
          sourceRef,
          objectIds: Array.from(new Set(mappedObjIds)),
          resourceTags: mergedTags,
          initialStatus,
          occurredAt,
          sensitivity,
          idempotencyKey: `import-md:${sourceRef}:init:${newSha256}:${initialStatus}`,
        });
        created += 1;
        items.push({
          filePath,
          sourceRef,
          contentSha256: newSha256,
          action: "created",
          recordId: rec.id,
          supersedesId: null,
          realmId: rec.realmId,
          occurredAt: rec.occurredAt,
        });
      } else {
        const rec = await this.ledger.appendRecord({
          actor,
          viewerRealmId: viewerRealm.id,
          targetRealmId: effectiveRealmId,
          kind: desiredKind,
          extKind: params.extKind,
          title: parsed.title,
          payload,
          externalRef: parsed.externalRef,
          sourceRef,
          objectIds: Array.from(new Set(mappedObjIds)),
          resourceTags: mergedTags,
          supersedesIds,
          initialStatus,
          occurredAt,
          sensitivity,
          idempotencyKey: `import-md:${sourceRef}:after:${supersedesIds.join(",")}:${newSha256}:${initialStatus}`,
        });
        superseded += 1;
        items.push({
          filePath,
          sourceRef,
          contentSha256: newSha256,
          action: "superseded",
          recordId: rec.id,
          supersedesId: supersedesIds[0] ?? null,
          realmId: rec.realmId,
          occurredAt: rec.occurredAt,
        });
      }
    }

    const embeddingsSynced = params.syncEmbeddings
      ? await this.sea.syncEmbeddings()
      : undefined;

    return {
      totalFiles: files.length,
      created,
      superseded,
      skippedUnchanged,
      skippedRedacted,
      skippedSecret,
      undatedCount,
      defaultRealmCount,
      items,
      ...(embeddingsSynced ? { embeddingsSynced } : {}),
    };
  }

  /**
   * Generic field-mapped JSONL importer (100% open-source clean, zero private schemas).
   * Supports unified ImportMappingConfig, nullable undated occurredAt, status/statusMap/validUntil,
   * scalar and array supersedes (all-or-nothing atomic DAG CAS), and tree-mode cross-realm degradation.
   */
  async importJsonl(params: {
    actor?: Actor;
    viewerRealmId: string;
    targetRealmRef?: string;
    jsonlPath: string;
    mapping: ImportMappingConfig;
    syncEmbeddings?: boolean;
  }): Promise<ImportJsonlResult> {
    const actor: Actor = params.actor ?? { id: "importer", kind: "agent" };
    const mapping = params.mapping;
    validateMappingConfig(mapping);

    const skipSecret = mapping.skipSecret ?? true;
    const targetMode = mapping.target ?? "record";
    const idempotencyPrefix = mapping.idempotencyPrefix?.trim() || "import-jsonl";

    if (!fs.existsSync(params.jsonlPath)) {
      throw new MindError(
        "NOT_FOUND",
        `JSONL file not found: ${params.jsonlPath}`,
      );
    }

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

    const defaultRealm: Realm = params.targetRealmRef
      ? resolveVisibleRealm({
          realms,
          orgId: viewerRealm.orgId,
          ref: params.targetRealmRef,
          scope,
        })
      : mapping.defaultRealm
        ? resolveVisibleRealm({
            realms,
            orgId: viewerRealm.orgId,
            ref: mapping.defaultRealm,
            scope,
          })
        : viewerRealm;

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

    const orgObjects = this.db.listObjects({
      orgId: viewerRealm.orgId,
      realmIds: scope.readableLedgerIds,
    });
    const objectsById = new Map(orgObjects.map((o) => [o.id, o]));
    const objectsByKindName = new Map(
      orgObjects.map((o) => [`${o.kind.toLowerCase()}:${o.name.toLowerCase()}`, o]),
    );

    // 1. Parse all non-empty JSONL rows
    const rawLines = fs
      .readFileSync(params.jsonlPath, "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n");

    interface ParsedRow {
      lineNumber: number;
      row: Record<string, unknown>;
      sourceId: string | null;
      supersedesSourceIds: string[];
      occurredAt: string | null;
    }

    const parsedRows: ParsedRow[] = [];
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
          ? String(rawId).trim()
          : null;
      const supersedesSourceIds = Array.from(
        new Set(toStringArray(getFieldByPath(row, mapping.supersedes))),
      );
      const occurredAt = resolveMostPreciseDeclaredTimestamp(
        getAllFields(row, mapping.occurredAt),
      );

      parsedRows.push({
        lineNumber: i + 1,
        row,
        sourceId,
        supersedesSourceIds,
        occurredAt,
      });
    }

    // 2. Sort ascending by occurred_at (undated rows go last), then topological pass over all supersedes edges
    parsedRows.sort((a, b) => {
      if (a.occurredAt && b.occurredAt && a.occurredAt !== b.occurredAt) {
        return a.occurredAt.localeCompare(b.occurredAt);
      }
      if (a.occurredAt && !b.occurredAt) return -1;
      if (!a.occurredAt && b.occurredAt) return 1;
      return a.lineNumber - b.lineNumber;
    });

    const rowBySourceId = new Map<string, ParsedRow>();
    for (const item of parsedRows) {
      if (item.sourceId) rowBySourceId.set(item.sourceId, item);
    }
    const orderedRows: ParsedRow[] = [];
    const visited = new Set<ParsedRow>();
    const visiting = new Set<ParsedRow>();
    const visit = (item: ParsedRow) => {
      if (visited.has(item) || visiting.has(item)) return;
      visiting.add(item);
      for (const predSourceId of item.supersedesSourceIds) {
        const parent = rowBySourceId.get(predSourceId);
        if (parent) visit(parent);
      }
      visiting.delete(item);
      visited.add(item);
      orderedRows.push(item);
    };
    for (const item of parsedRows) {
      visit(item);
    }

    const idMap: Record<string, string> = {};
    const entryIds: string[] = [];
    let imported = 0;
    let superseded = 0;
    let skippedSecret = 0;
    let skippedRedacted = 0;
    let treeDegradedCrossRealmSupersedes = 0;
    let undatedCount = 0;
    let defaultRealmCount = 0;
    const nowIso = new Date().toISOString();

    for (const item of orderedRows) {
      const { row, sourceId, supersedesSourceIds, occurredAt, lineNumber } =
        item;

      if (occurredAt === null) {
        undatedCount += 1;
      }

      // Sensitivity resolution & secret skip
      const rawSens = getFieldByPath(row, mapping.sensitivity);
      const sensCandidate =
        typeof rawSens === "string" &&
        VALID_SENSITIVITIES.has(rawSens.trim().toLowerCase())
          ? (rawSens.trim().toLowerCase() as Sensitivity)
          : (mapping.defaultSensitivity ?? "internal");

      if (skipSecret && sensCandidate === "secret") {
        skippedSecret += 1;
        continue;
      }

      // Source ref & content hash for blocklist + idempotency
      const rawSourceRef = getFieldByPath(row, mapping.sourceRef);
      const sourceRef =
        typeof rawSourceRef === "string" && rawSourceRef.trim()
          ? rawSourceRef.trim()
          : sourceId
            ? `${idempotencyPrefix}:${sourceId}`
            : `${idempotencyPrefix}:line-${lineNumber}`;
      const contentSha256 = computePayloadHash(row);

      if (this.db.isContentShaBlocked(viewerRealm.orgId, contentSha256)) {
        skippedRedacted += 1;
        continue;
      }

      // Realm resolution via realmPath + realmMap + defaultRealm
      const rawRealmVal = getFieldByPath(row, mapping.realmPath);
      const rawRealmStr =
        rawRealmVal !== undefined && rawRealmVal !== null
          ? String(rawRealmVal).trim()
          : "";
      const mappedRealmRef = rawRealmStr
        ? (mapping.realmMap?.[rawRealmStr] ?? rawRealmStr)
        : "";
      let targetRealm: Realm;
      if (mappedRealmRef) {
        targetRealm = resolveVisibleRealm({
          realms,
          orgId: viewerRealm.orgId,
          ref: mappedRealmRef,
          scope,
        });
      } else {
        targetRealm = defaultRealm;
        defaultRealmCount += 1;
      }

      // Object references resolution
      const rawObjectRefs = toStringArray(
        getFieldByPath(row, mapping.objectRefs),
      );
      const objectIds: string[] = [];
      for (const ref of rawObjectRefs) {
        const mapped = mapping.objectMap?.[ref] ?? ref;
        if (objectsById.has(mapped)) {
          objectIds.push(mapped);
          continue;
        }
        const byName = objectsByKindName.get(mapped.toLowerCase());
        if (byName) {
          objectIds.push(byName.id);
        }
      }

      // Resource tags resolution
      const rawTags = toStringArray(getFieldByPath(row, mapping.resourceTags));
      const resourceTags: string[] = [];
      for (const t of rawTags) {
        const candidate =
          !t.includes(":") && mapping.defaultTagType
            ? `${mapping.defaultTagType}:${t}`
            : t;
        resourceTags.push(normalizeResourceTag(candidate));
      }

      // Title & body
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
            : sourceId || `Imported row #${lineNumber}`;

      // Payload construction (honoring extractFields allowlist)
      const payload: Record<string, unknown> = {
        sourceRef,
        contentSha256,
        ...(sourceId ? { sourceId } : {}),
      };
      if (bodyStr) {
        payload.body = bodyStr;
      }
      if (mapping.extractFields && mapping.extractFields.length > 0) {
        for (const fieldPath of mapping.extractFields) {
          const val = getFieldByPath(row, fieldPath);
          if (val !== undefined) {
            const key = fieldPath.includes(".")
              ? fieldPath.replace(/\./g, "_")
              : fieldPath;
            payload[key] = val;
          }
        }
      }

      const idempotencyKey = `${idempotencyPrefix}:${sourceId ?? `line-${lineNumber}`}:${contentSha256}`;

      if (targetMode === "seabed") {
        const seabedText = bodyStr || titleStr;
        if (
          this.db.isContentShaBlocked(
            viewerRealm.orgId,
            computeSeabedContentSha256(seabedText),
          )
        ) {
          skippedRedacted += 1;
          continue;
        }
        const rawKind = getFieldByPath(row, mapping.kind);
        const mappedKind =
          typeof rawKind === "string" && rawKind.trim()
            ? (mapping.kindMap?.[rawKind.trim()] ?? rawKind.trim())
            : (mapping.defaultKind ?? "evidence");
        const seabedKind: SeabedKind = VALID_SEABED_KINDS.has(mappedKind)
          ? (mappedKind as SeabedKind)
          : "evidence";

        const sea = await this.ledger.captureSeabed({
          actor,
          viewerRealmId: viewerRealm.id,
          targetRealmId: targetRealm.id,
          kind: seabedKind,
          text: seabedText,
          sourceRef,
          metadata: payload,
          objectIds,
          resourceTags,
          occurredAt,
          sensitivity: sensCandidate,
          idempotencyKey,
        });
        if (sourceId) idMap[sourceId] = sea.id;
        entryIds.push(sea.id);
        imported += 1;
        continue;
      }

      if (
        this.db.isContentShaBlocked(
          viewerRealm.orgId,
          computeRecordContentSha256(titleStr, payload),
        )
      ) {
        skippedRedacted += 1;
        continue;
      }

      // Record target: resolve status/validUntil strictly ("active" | "superseded")
      const initialStatus = resolveMappedInitialStatus({
        rawStatus: mapping.status ? getFieldByPath(row, mapping.status) : undefined,
        rawValidUntil: mapping.validUntil
          ? getFirstField(row, mapping.validUntil)
          : undefined,
        statusMap: mapping.statusMap,
        nowIso,
      });

      const rawKind = getFieldByPath(row, mapping.kind);
      const mappedKind =
        typeof rawKind === "string" && rawKind.trim()
          ? (mapping.kindMap?.[rawKind.trim()] ?? rawKind.trim())
          : (mapping.defaultKind ?? "claim");
      const recordKind: RecordKind = VALID_RECORD_KINDS.has(mappedKind)
        ? (mappedKind as RecordKind)
        : "claim";

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

      // Thing ref resolution
      const rawThingRef = getFieldByPath(row, mapping.thingRef);
      let thingId: string | undefined;
      if (typeof rawThingRef === "string" && rawThingRef.trim()) {
        const ref = rawThingRef.trim();
        if (idMap[ref]) {
          thingId = idMap[ref];
        } else {
          const direct = this.db.getRecord(ref);
          if (direct) {
            thingId = direct.thingId ?? direct.id;
          } else {
            const byExt = this.ledger.findThingByExternalRef({
              actor,
              viewerRealmId: viewerRealm.id,
              externalRef: ref,
            });
            if (byExt) thingId = byExt.thingId ?? byExt.id;
          }
        }
      }

      // Refs resolution
      const rawRefs = toStringArray(getFieldByPath(row, mapping.refs));
      const resolvedRefs: string[] = [];
      for (const r of rawRefs) {
        const mapped = idMap[r] ?? r;
        const targetRec = this.db.getRecord(mapped);
        const targetSea = targetRec ? null : this.db.getSeabedEntry(mapped);
        if (targetRec) {
          const access = resolveAccess({
            realms,
            mounts,
            actor,
            viewerRealmId: viewerRealm.id,
            targetRealmId: targetRec.realmId,
            assetKind: targetRec.kind === "rule" ? "rule" : "ledger",
            orgPolicy,
          });
          if (access !== "none") resolvedRefs.push(targetRec.id);
        } else if (targetSea) {
          const access = resolveAccess({
            realms,
            mounts,
            actor,
            viewerRealmId: viewerRealm.id,
            targetRealmId: targetSea.realmId,
            assetKind: "seabed",
            explicitDescendantDive: true,
            orgPolicy,
          });
          if (access !== "none") resolvedRefs.push(targetSea.id);
        }
      }

      // Multi-predecessor supersedes resolution with open vs tree semantics
      const resolvedSupersedesIds: string[] = [];
      const degradedCrossRealmIds: string[] = [];
      for (const supSourceId of supersedesSourceIds) {
        const targetSupId = idMap[supSourceId] ?? supSourceId;
        const oldRec = this.db.getRecord(targetSupId);
        if (!oldRec || oldRec.orgId !== viewerRealm.orgId) {
          continue;
        }
        if (orgPolicy === "open") {
          if (oldRec.kind === recordKind) {
            resolvedSupersedesIds.push(oldRec.id);
          }
        } else {
          if (oldRec.realmId === targetRealm.id) {
            if (oldRec.kind === recordKind) {
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

      const rec = await this.ledger.appendRecord({
        actor,
        viewerRealmId: viewerRealm.id,
        targetRealmId: targetRealm.id,
        thingId,
        kind: recordKind,
        extKind,
        title: titleStr,
        payload,
        refs: Array.from(new Set(resolvedRefs)),
        externalRef,
        sourceRef,
        objectIds,
        resourceTags,
        supersedesIds:
          resolvedSupersedesIds.length > 0 ? resolvedSupersedesIds : undefined,
        initialStatus,
        occurredAt,
        sensitivity: sensCandidate,
        idempotencyKey,
      });

      if (sourceId) idMap[sourceId] = rec.id;
      entryIds.push(rec.id);
      imported += 1;
      if (resolvedSupersedesIds.length > 0) superseded += 1;
    }

    const embeddingsSynced = params.syncEmbeddings
      ? await this.sea.syncEmbeddings()
      : undefined;

    return {
      totalRows: orderedRows.length,
      imported,
      superseded,
      skippedSecret,
      skippedRedacted,
      treeDegradedCrossRealmSupersedes,
      undatedCount,
      defaultRealmCount,
      idMap,
      entryIds,
      ...(embeddingsSynced ? { embeddingsSynced } : {}),
    };
  }

  /**
   * Verifies DB rows against mapped source expectations (Markdown file/dir or JSONL file).
   * Fails on active-vs-superseded mismatches, timestamp mismatches, or missing rows,
   * and reports exact undatedCount and defaultRealmFallbackCount.
   */
  verifyImportConsistency(params: {
    viewerRealmId: string;
    sourcePath: string;
    mapping?: ImportMappingConfig;
    baseDir?: string;
    targetRealmRef?: string;
  }): ImportConsistencyResult {
    const mapping = params.mapping;
    const filenameDateRe = validateMappingConfig(mapping);
    const skipSecret = mapping?.skipSecret ?? true;

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

    const defaultRealm: Realm = params.targetRealmRef
      ? resolveVisibleRealm({
          realms,
          orgId: viewerRealm.orgId,
          ref: params.targetRealmRef,
          scope,
        })
      : mapping?.defaultRealm
        ? resolveVisibleRealm({
            realms,
            orgId: viewerRealm.orgId,
            ref: mapping.defaultRealm,
            scope,
          })
        : viewerRealm;

    const abs = path.resolve(params.sourcePath);
    if (!fs.existsSync(abs)) {
      throw new MindError("NOT_FOUND", `Source path not found: ${params.sourcePath}`);
    }
    const stat = fs.statSync(abs);
    const isJsonl = stat.isFile() && /\.jsonl$/i.test(abs);

    const nowIso = new Date().toISOString();
    let totalChecked = 0;
    let missingCount = 0;
    let undatedCount = 0;
    let defaultRealmFallbackCount = 0;
    const activeSupersededMismatches: ImportConsistencyMismatch[] = [];
    const timestampMismatches: ImportConsistencyMismatch[] = [];

    const checkRecordRow = (item: {
      sourceRef: string;
      expectedStatus: "active" | "superseded";
      expectedOccurredAt: string | null;
      realmId?: string;
    }) => {
      totalChecked += 1;
      const rec =
        orgPolicy === "open"
          ? this.db.findLatestRecordBySourceRef(
              viewerRealm.orgId,
              item.sourceRef,
            )
          : this.db.findLatestRecordBySourceRef(
              viewerRealm.orgId,
              item.sourceRef,
              item.realmId,
            );
      if (!rec) {
        missingCount += 1;
        return;
      }
      if (item.expectedStatus === "superseded" && rec.status === "active") {
        activeSupersededMismatches.push({
          sourceRef: item.sourceRef,
          recordId: rec.id,
          expected: "superseded",
          actual: rec.status,
          reason: "Source mapped as superseded/expired but DB row is active",
        });
      } else if (
        item.expectedStatus === "active" &&
        rec.status === "superseded" &&
        rec.supersededById === null
      ) {
        activeSupersededMismatches.push({
          sourceRef: item.sourceRef,
          recordId: rec.id,
          expected: "active",
          actual: rec.status,
          reason:
            "Source mapped as active but DB row is orphan superseded with no successor",
        });
      }
      if (rec.occurredAt !== item.expectedOccurredAt) {
        timestampMismatches.push({
          sourceRef: item.sourceRef,
          recordId: rec.id,
          expected: item.expectedOccurredAt,
          actual: rec.occurredAt,
          reason: "Stored occurred_at differs from declared source timestamp",
        });
      }
    };

    if (isJsonl) {
      if (!mapping) {
        throw new MindError(
          "INVALID_INPUT",
          "import-verify requires --map <mapping.json> for JSONL sources",
        );
      }
      const idempotencyPrefix =
        mapping.idempotencyPrefix?.trim() || "import-jsonl";
      const rawLines = fs
        .readFileSync(abs, "utf8")
        .replace(/\r\n/g, "\n")
        .split("\n");
      for (let i = 0; i < rawLines.length; i += 1) {
        const line = rawLines[i]!.trim();
        if (!line) continue;
        const row = JSON.parse(line) as Record<string, unknown>;
        const rawSens = getFieldByPath(row, mapping.sensitivity);
        const sensCandidate =
          typeof rawSens === "string" &&
          VALID_SENSITIVITIES.has(rawSens.trim().toLowerCase())
            ? (rawSens.trim().toLowerCase() as Sensitivity)
            : (mapping.defaultSensitivity ?? "internal");
        if (skipSecret && sensCandidate === "secret") continue;

        const rawId = getFieldByPath(row, mapping.id);
        const sourceId =
          rawId !== undefined && rawId !== null && String(rawId).trim()
            ? String(rawId).trim()
            : null;
        const rawSourceRef = getFieldByPath(row, mapping.sourceRef);
        const sourceRef =
          typeof rawSourceRef === "string" && rawSourceRef.trim()
            ? rawSourceRef.trim()
            : sourceId
              ? `${idempotencyPrefix}:${sourceId}`
              : `${idempotencyPrefix}:line-${i + 1}`;
        const contentSha256 = computePayloadHash(row);
        if (
          this.db.isRedactedBlocked(viewerRealm.orgId, sourceRef, contentSha256)
        ) {
          continue;
        }

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
        let realmId = defaultRealm.id;
        if (mappedRealmRef) {
          realmId = resolveVisibleRealm({
            realms,
            orgId: viewerRealm.orgId,
            ref: mappedRealmRef,
            scope,
          }).id;
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

        checkRecordRow({
          sourceRef,
          expectedStatus,
          expectedOccurredAt,
          realmId,
        });
      }
    } else {
      const { baseDir, isSingleFile, files } = collectMarkdownFiles(
        params.sourcePath,
        params.baseDir,
      );
      const hasExplicitBaseDir = Boolean(params.baseDir?.trim());
      for (const filePath of files) {
        const rawContent = fs.readFileSync(filePath, "utf8");
        const sha = sha256Text(rawContent);
        const sourceRef = deriveDefaultSourceRef({
          filePath,
          baseDir,
          isSingleFile,
          hasExplicitBaseDir,
        });
        const fallbackTitle = path.basename(filePath, path.extname(filePath));
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
        const sens =
          mappedSens ?? parsed.sensitivity ?? mapping?.defaultSensitivity ?? "internal";
        if (skipSecret && sens === "secret") continue;
        if (this.db.isRedactedBlocked(viewerRealm.orgId, sourceRef, sha)) {
          continue;
        }

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

        let realmId = defaultRealm.id;
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
            realmId = resolveVisibleRealm({
              realms,
              orgId: viewerRealm.orgId,
              ref: mappedRealmRef,
              scope,
            }).id;
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

        checkRecordRow({
          sourceRef,
          expectedStatus,
          expectedOccurredAt,
          realmId,
        });
      }
    }

    return {
      passed:
        missingCount === 0 &&
        activeSupersededMismatches.length === 0 &&
        timestampMismatches.length === 0,
      totalChecked,
      missingCount,
      undatedCount,
      defaultRealmFallbackCount,
      activeSupersededMismatches,
      timestampMismatches,
    };
  }

  /**
   * Read-only dry-run preview for `import md` or `import jsonl`.
   * Never mutates SQLite and never lazily creates `/inbox`.
   * Reports exact target realm distribution, unmatched raw realm field values,
   * and any unresolved realm references before a single row is written.
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
    /** Maximum allowed bytes per Markdown file (default: 2 MB) */
    maxFileBytes?: number;
  }): ImportDryRunResult {
    const mapping = params.mapping;
    const filenameDateRe = validateMappingConfig(mapping);
    const skipSecret = params.skipSecret ?? mapping?.skipSecret ?? true;
    const maxFileBytes = params.maxFileBytes ?? MAX_IMPORT_MD_BYTES;

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
      throw new MindError("NOT_FOUND", `Source path not found: ${params.sourcePath}`);
    }
    const stat = fs.statSync(abs);
    const sourceType: "md" | "jsonl" =
      params.sourceType ?? (stat.isFile() && /\.jsonl$/i.test(abs) ? "jsonl" : "md");

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
      const inMap = mapping?.realmMap ? Object.prototype.hasOwnProperty.call(mapping.realmMap, rawRealmStr) : false;
      const mappedRef = inMap ? mapping!.realmMap![rawRealmStr]!.trim() : rawRealmStr;
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
      const lines = fs
        .readFileSync(abs, "utf8")
        .replace(/\r\n/g, "\n")
        .split("\n");
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
          throw new MindError("INVALID_INPUT", `Expected JSON object on line ${i + 1}`);
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
        if (skipSecret && sens === "secret") {
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
        totalItems += 1;
        const sizeBytes = fs.statSync(filePath).size;
        if (sizeBytes > maxFileBytes) {
          oversizedFiles.push({
            path: path.relative(baseDir, filePath) || path.basename(filePath),
            sizeBytes,
            limitBytes: maxFileBytes,
          });
          continue;
        }
        const rawContent = fs.readFileSync(filePath, "utf8");
        const sha = sha256Text(rawContent);
        const sourceRef = deriveDefaultSourceRef({
          filePath,
          baseDir,
          isSingleFile,
          hasExplicitBaseDir,
        });
        const fallbackTitle = path.basename(filePath, path.extname(filePath));
        const parsed = parseMarkdownDocument(rawContent, fallbackTitle);
        const fm = parsed.frontmatter;

        const mappedOccurred = mapping?.occurredAt
          ? normalizeDeclaredTimestamp(getFirstField(fm, mapping.occurredAt))
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
          mappedSens ?? parsed.sensitivity ?? mapping?.defaultSensitivity ?? "internal";
        if (skipSecret && sens === "secret") {
          skippedSecret += 1;
          continue;
        }
        if (this.db.isContentShaBlocked(viewerRealm.orgId, sha)) {
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
