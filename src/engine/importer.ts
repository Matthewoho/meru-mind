import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAccess, resolveAccessScope } from "../policy.js";
import type { DbPort } from "../ports.js";
import {
  MindError,
  type Actor,
  type ImportJsonlResult,
  type ImportMdItemResult,
  type ImportMdResult,
  type JsonlMappingConfig,
  type OrgPolicy,
  type Realm,
  type RecordKind,
  type SeabedKind,
  type Sensitivity,
} from "../types.js";
import { computePayloadHash, type LedgerEngine } from "./ledger.js";
import {
  normalizeResourceTag,
  OPAQUE_REALM_NOT_FOUND,
  resolveVisibleRealm,
} from "./objects.js";
import type { SeaEngine } from "./sea.js";

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
  let occurredAt: string | null = null;
  for (const key of timeKeys) {
    if (key in frontmatter) {
      const normalized = normalizeDeclaredTimestamp(frontmatter[key]);
      if (normalized) {
        occurredAt = normalized;
        break;
      }
    }
  }

  if (!occurredAt) {
    const headerLines = body.split("\n").slice(0, 30);
    for (const line of headerLines) {
      const m =
        /^\s*(?:[-*]\s*)?(?:\*\*)?(occurred_at|updated_at|valid_from|created_at|date|timestamp)(?:\*\*)?\s*[:：]\s*(.+)$/i.exec(
          line,
        );
      if (m) {
        const normalized = normalizeDeclaredTimestamp(m[2]);
        if (normalized) {
          occurredAt = normalized;
          break;
        }
      }
    }
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

  // 4. Summary: frontmatter summary -> explicit Summary/Overview/Abstract/TL;DR/摘要 section -> first paragraph
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
  // Single-file import without explicit baseDir/sourceRef:
  // include parent directory segment so identically named files in different folders do not collide.
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
      .map((item) => (typeof item === "string" ? item.trim() : String(item ?? "").trim()))
      .filter(Boolean);
  }
  if (typeof val === "string" && val.trim()) {
    return [val.trim()];
  }
  return [];
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
   *
   * Semantics:
   * - Defaults to agent actor (confirmedByHuman = false unless caller explicitly supplies actor.kind === "human").
   * - All writes pass through LedgerEngine.appendRecord() transactions.
   * - Extracts declared timestamps only; NEVER reads filesystem mtime.
   * - Skips files whose (org_id, source_ref, content_sha256) matches redacted_blocklist.
   * - Active chain head lookup:
   *   - `open` mode: looks up active head by (org_id, source_ref) across the organization.
   *   - `tree` mode: looks up active head by (org_id, realm_id, source_ref).
   * - If head matches newSha256 and target realm -> skip without writing.
   * - If no head -> initial insert with key `import-md:${sourceRef}:init:${newSha256}`.
   * - If content changed (including rollback v1 -> v2 -> v1) or open-mode realm moved ->
   *   supersede `head.id` with key `import-md:${sourceRef}:after:${head.id}:${newSha256}`.
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
    syncEmbeddings?: boolean;
  }): Promise<ImportMdResult> {
    const actor: Actor = params.actor ?? { id: "importer", kind: "agent" };
    const skipSecret = params.skipSecret ?? true;

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

    const targetRealm: Realm = params.targetRealmRef
      ? resolveVisibleRealm({
          realms,
          orgId: viewerRealm.orgId,
          ref: params.targetRealmRef,
          scope,
        })
      : viewerRealm;

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
      const sensitivity: Sensitivity =
        params.sensitivity ?? parsed.sensitivity ?? "internal";

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
          occurredAt: parsed.occurredAt,
        });
        continue;
      }

      // Check redacted_blocklist by exact (org_id, source_ref, content_sha256)
      if (this.db.isRedactedBlocked(viewerRealm.orgId, sourceRef, newSha256)) {
        skippedRedacted += 1;
        items.push({
          filePath,
          sourceRef,
          contentSha256: newSha256,
          action: "skipped_redacted",
          recordId: null,
          supersedesId: null,
          realmId: targetRealm.id,
          occurredAt: parsed.occurredAt,
        });
        continue;
      }

      // Active chain head lookup:
      // - open mode: (org_id, source_ref) so realm reassignment supersedes old head cleanly
      // - tree mode: (org_id, realm_id, source_ref) to preserve strict realm partition
      const head =
        orgPolicy === "open"
          ? this.db.findActiveRecordBySourceRef(viewerRealm.orgId, sourceRef)
          : this.db.findActiveRecordBySourceRef(
              viewerRealm.orgId,
              sourceRef,
              targetRealm.id,
            );

      const headSha =
        head && typeof head.payload.contentSha256 === "string"
          ? head.payload.contentSha256
          : null;

      if (head && headSha === newSha256 && head.realmId === targetRealm.id) {
        skippedUnchanged += 1;
        items.push({
          filePath,
          sourceRef,
          contentSha256: newSha256,
          action: "skipped_unchanged",
          recordId: head.id,
          supersedesId: null,
          realmId: targetRealm.id,
          occurredAt: parsed.occurredAt,
        });
        continue;
      }

      const desiredKind: RecordKind =
        head?.kind ?? params.kind ?? parsed.kind ?? "claim";
      const mergedTags = Array.from(new Set([...extraTags, ...parsed.tags]));
      const payload: Record<string, unknown> = {
        summary: parsed.summary,
        body: parsed.body,
        sourceRef,
        contentSha256: newSha256,
        ...(Object.keys(parsed.frontmatter).length > 0
          ? { frontmatter: parsed.frontmatter }
          : {}),
      };

      if (!head) {
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
          objectIds: params.objectIds,
          resourceTags: mergedTags,
          occurredAt: parsed.occurredAt ?? undefined,
          sensitivity,
          idempotencyKey: `import-md:${sourceRef}:init:${newSha256}`,
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
          targetRealmId: targetRealm.id,
          kind: desiredKind,
          extKind: params.extKind,
          title: parsed.title,
          payload,
          externalRef: parsed.externalRef,
          sourceRef,
          objectIds: params.objectIds,
          resourceTags: mergedTags,
          supersedesId: head.id,
          occurredAt: parsed.occurredAt ?? undefined,
          sensitivity,
          idempotencyKey: `import-md:${sourceRef}:after:${head.id}:${newSha256}`,
        });
        superseded += 1;
        items.push({
          filePath,
          sourceRef,
          contentSha256: newSha256,
          action: "superseded",
          recordId: rec.id,
          supersedesId: head.id,
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
      items,
      ...(embeddingsSynced ? { embeddingsSynced } : {}),
    };
  }

  /**
   * Generic field-mapped JSONL importer (100% open-source clean, zero private schemas).
   *
   * Semantics:
   * - Defaults to agent actor (confirmedByHuman = false unless actor.kind === "human").
   * - Sorts entire batch by occurred_at ascending (with same-timestamp supersede topological order).
   * - All writes go through LedgerEngine.appendRecord() or LedgerEngine.captureSeabed().
   * - `open` mode: same-org cross-realm supersedes run normal atomic CAS.
   * - `tree` mode: cross-realm supersedes degrade to `refs` (if visible) + `payload.crossRealmSupersedes`
   *   and increment `treeDegradedCrossRealmSupersedes`.
   * - Supports `extractFields`, `skipSecret`, `redacted_blocklist`, and optional `syncEmbeddings`.
   */
  async importJsonl(params: {
    actor?: Actor;
    viewerRealmId: string;
    targetRealmRef?: string;
    jsonlPath: string;
    mapping: JsonlMappingConfig;
    syncEmbeddings?: boolean;
  }): Promise<ImportJsonlResult> {
    const actor: Actor = params.actor ?? { id: "importer", kind: "agent" };
    const mapping = params.mapping;
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
      supersedesSourceId: string | null;
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
      const rawSup = getFieldByPath(row, mapping.supersedes);
      const supersedesSourceId =
        rawSup !== undefined && rawSup !== null && String(rawSup).trim()
          ? String(rawSup).trim()
          : null;
      const occurredAt = normalizeDeclaredTimestamp(
        getFirstField(row, mapping.occurredAt),
      );

      parsedRows.push({
        lineNumber: i + 1,
        row,
        sourceId,
        supersedesSourceId,
        occurredAt,
      });
    }

    // 2. Sort ascending by occurred_at (rows without occurred_at go last),
    //    then ensure any supersedes parent appears before its successor.
    parsedRows.sort((a, b) => {
      if (a.occurredAt && b.occurredAt && a.occurredAt !== b.occurredAt) {
        return a.occurredAt.localeCompare(b.occurredAt);
      }
      if (a.occurredAt && !b.occurredAt) return -1;
      if (!a.occurredAt && b.occurredAt) return 1;
      return a.lineNumber - b.lineNumber;
    });

    // Topological pass for equal-timestamp or out-of-order supersedes within the batch
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
      if (item.supersedesSourceId) {
        const parent = rowBySourceId.get(item.supersedesSourceId);
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

    for (const item of orderedRows) {
      const { row, sourceId, supersedesSourceId, occurredAt, lineNumber } = item;

      // Sensitivity resolution & secret skip
      const rawSens = getFieldByPath(row, mapping.sensitivity);
      const sensCandidate =
        typeof rawSens === "string" && VALID_SENSITIVITIES.has(rawSens.trim().toLowerCase())
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

      if (
        this.db.isRedactedBlocked(viewerRealm.orgId, sourceRef, contentSha256)
      ) {
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
      const targetRealm = mappedRealmRef
        ? resolveVisibleRealm({
            realms,
            orgId: viewerRealm.orgId,
            ref: mappedRealmRef,
            scope,
          })
        : defaultRealm;

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

      // Payload construction (honoring extractFields allowlist to drop noisy fields)
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
          text: bodyStr || titleStr,
          sourceRef,
          metadata: payload,
          objectIds,
          resourceTags,
          occurredAt: occurredAt ?? undefined,
          sensitivity: sensCandidate,
          idempotencyKey,
        });
        if (sourceId) idMap[sourceId] = sea.id;
        entryIds.push(sea.id);
        imported += 1;
        continue;
      }

      // Record target
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

      // Supersedes resolution with open vs tree semantics
      let supersedesId: string | undefined;
      if (supersedesSourceId) {
        const targetSupId = idMap[supersedesSourceId] ?? supersedesSourceId;
        const oldRec = this.db.getRecord(targetSupId);
        const existingIdemp = this.db.getIdempotencyKey(
          viewerRealm.orgId,
          idempotencyKey,
        );
        const canSupersedeStatus =
          oldRec !== null &&
          oldRec.kind === recordKind &&
          (oldRec.status === "active" || existingIdemp !== null);

        if (oldRec && oldRec.orgId === viewerRealm.orgId) {
          if (orgPolicy === "open") {
            // open mode: allow same-org cross-realm supersede via atomic CAS
            if (canSupersedeStatus) {
              supersedesId = oldRec.id;
            }
          } else {
            // tree mode: same-realm supersedes normally; visible cross-realm degrades to refs + payload.crossRealmSupersedes
            if (oldRec.realmId === targetRealm.id) {
              if (canSupersedeStatus) {
                supersedesId = oldRec.id;
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
                payload.crossRealmSupersedes = oldRec.id;
                resolvedRefs.push(oldRec.id);
              }
            }
          }
        }
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
        supersedesId,
        occurredAt: occurredAt ?? undefined,
        sensitivity: sensCandidate,
        idempotencyKey,
      });

      if (sourceId) idMap[sourceId] = rec.id;
      entryIds.push(rec.id);
      imported += 1;
      if (supersedesId) superseded += 1;
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
      idMap,
      entryIds,
      ...(embeddingsSynced ? { embeddingsSynced } : {}),
    };
  }
}
