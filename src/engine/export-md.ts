import fs from "node:fs";
import path from "node:path";
import { resolveAccessScope } from "../policy.js";
import type { DbPort } from "../ports.js";
import {
  MindError,
  type ExportMdItemResult,
  type ExportMdResult,
  type LedgerRecord,
  type Realm,
} from "../types.js";
import { OPAQUE_REALM_NOT_FOUND, resolveVisibleRealm } from "./objects.js";
import { sanitizeRealmsForScope } from "./visibility.js";

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function slugifyTitle(raw: string): string {
  const cleaned = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return cleaned || "entry";
}

function sanitizeSourceRefPath(sourceRef: string): string | null {
  let trimmed = sourceRef.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return null;
  }
  trimmed = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (seg === "." || seg === ".." || seg.includes("\0")) {
      return null;
    }
  }
  const rel = segments.join("/");
  return rel.endsWith(".md") ? rel : `${rel}.md`;
}

function extractBody(rec: LedgerRecord): string {
  if (typeof rec.payload.body === "string" && rec.payload.body.trim()) {
    return rec.payload.body.trimEnd();
  }
  if (typeof rec.payload.summary === "string" && rec.payload.summary.trim()) {
    return rec.payload.summary.trimEnd();
  }
  return `\`\`\`json\n${JSON.stringify(rec.payload, null, 2)}\n\`\`\``;
}

function renderRecordMarkdown(
  rec: LedgerRecord,
  realmPath: string,
  tags: string[],
): string {
  const fmLines: string[] = [
    "---",
    `id: ${yamlScalar(rec.id)}`,
    `kind: ${yamlScalar(rec.kind)}`,
    `realm: ${yamlScalar(realmPath)}`,
    `title: ${yamlScalar(rec.title)}`,
    `status: ${yamlScalar(rec.status)}`,
    `sensitivity: ${yamlScalar(rec.sensitivity)}`,
    `author: ${yamlScalar(rec.authorId)}`,
    `created_at: ${yamlScalar(rec.createdAt)}`,
  ];
  if (rec.occurredAt) {
    fmLines.push(`occurred_at: ${yamlScalar(rec.occurredAt)}`);
  }
  if (rec.sourceRef) {
    fmLines.push(`source_ref: ${yamlScalar(rec.sourceRef)}`);
  }
  if (rec.externalRef) {
    fmLines.push(`external_ref: ${yamlScalar(rec.externalRef)}`);
  }
  if (tags.length > 0) {
    fmLines.push(`tags: [${tags.map((t) => yamlScalar(t)).join(", ")}]`);
  }
  fmLines.push("---", "");

  const body = extractBody(rec);
  const hasHeading = /^#\s+/m.test(body);
  const content = hasHeading ? body : `# ${rec.title}\n\n${body}`;
  return `${fmLines.join("\n")}${content}\n`;
}

function assertPathWithinDir(rootDir: string, candidatePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(candidatePath);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new MindError(
      "INVALID_INPUT",
      `Refusing to write outside export root: ${candidatePath}`,
    );
  }
  return resolvedTarget;
}

/**
 * Strictly one-way Markdown projection (`admin export-md`).
 * Exports active, non-redacted records within visible scope as readable `.md` files with
 * deterministic YAML frontmatter.
 *
 * Security & truth-source invariants:
 * - NEVER exports `secret` entries.
 * - Excludes `confidential` entries by default (`includeConfidential: false`).
 * - Strictly one-way: editing exported files never syncs back into SQLite.
 * - Note: committing exported files to Git means `redact` cannot erase historical Git commits.
 */
export function exportRecordsAsMarkdown(params: {
  db: DbPort;
  viewerRealmId: string;
  outDir: string;
  targetRealmRef?: string;
  includeConfidential?: boolean;
  dryRun?: boolean;
}): ExportMdResult {
  const includeConfidential = Boolean(params.includeConfidential);
  const dryRun = Boolean(params.dryRun);
  const outDir = path.resolve(params.outDir);

  const realms = params.db.listRealms();
  const mounts = params.db.listMounts();
  const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
  if (!viewerRealm) {
    throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
  }
  const org = params.db.getOrg(viewerRealm.orgId);
  if (!org) {
    throw new MindError("NOT_FOUND", `Organization not found: ${viewerRealm.orgId}`);
  }

  const scope = resolveAccessScope({
    realms,
    mounts,
    viewerRealmId: viewerRealm.id,
    orgPolicy: org.policy,
    includeDescendantSeabed: false,
  });
  const sanitizedMap = sanitizeRealmsForScope(realms, scope);

  let targetRealmIds: string[];
  if (params.targetRealmRef?.trim()) {
    const resolved = resolveVisibleRealm({
      realms,
      orgId: org.id,
      ref: params.targetRealmRef.trim(),
      scope,
    });
    // Include target realm + visible descendants under it
    const orgRealms = realms.filter((r) => r.orgId === org.id);
    const byParent = new Map<string, Realm[]>();
    for (const r of orgRealms) {
      if (!r.parentId) continue;
      const arr = byParent.get(r.parentId) ?? [];
      arr.push(r);
      byParent.set(r.parentId, arr);
    }
    const subtree: string[] = [];
    const queue = [resolved.id];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id) || !sanitizedMap.has(id)) continue;
      seen.add(id);
      subtree.push(id);
      for (const child of byParent.get(id) ?? []) {
        queue.push(child.id);
      }
    }
    targetRealmIds = subtree;
  } else {
    targetRealmIds = Array.from(sanitizedMap.keys());
  }

  // Stream all active records in visible target realms deterministically by ID
  const allRecords: LedgerRecord[] = [];
  const PAGE = 500;
  let offset = 0;
  while (true) {
    const page = params.db.listRecords({
      realmIds: targetRealmIds,
      includeSuperseded: false,
      excludeSensitivities: [], // we count skipped secret & confidential explicitly below
      limit: PAGE,
      offset,
    });
    if (page.items.length === 0) break;
    allRecords.push(...page.items);
    if (page.items.length < PAGE) break;
    offset += PAGE;
  }
  allRecords.sort((a, b) => a.id.localeCompare(b.id));

  let skippedSecret = 0;
  let skippedConfidential = 0;
  let skippedRedacted = 0;
  const usedPaths = new Set<string>();
  const items: ExportMdItemResult[] = [];

  if (!dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  for (const rec of allRecords) {
    if (rec.redactedAt !== null || rec.status === "retracted") {
      skippedRedacted += 1;
      continue;
    }
    if (rec.sensitivity === "secret") {
      skippedSecret += 1;
      continue;
    }
    if (rec.sensitivity === "confidential" && !includeConfidential) {
      skippedConfidential += 1;
      continue;
    }

    const realmPath = sanitizedMap.get(rec.realmId)?.path ?? "/";
    const safeSourceRel = rec.sourceRef ? sanitizeSourceRefPath(rec.sourceRef) : null;
    let relPath: string;
    if (safeSourceRel) {
      relPath = safeSourceRel;
    } else {
      const dirPart =
        realmPath === "/"
          ? "_root"
          : realmPath.replace(/^\/+/, "").replace(/^@mounted\//, "_mounted/");
      const shortId = rec.id.replace(/^rec_/, "").slice(0, 8);
      relPath = `${dirPart}/${slugifyTitle(rec.title)}-${shortId}.md`;
    }

    const lowerRel = relPath.toLowerCase();
    if (usedPaths.has(lowerRel)) {
      const shortId = rec.id.replace(/^rec_/, "").slice(0, 8);
      relPath = relPath.replace(/\.md$/i, `_${shortId}.md`);
    }
    usedPaths.add(relPath.toLowerCase());

    const tags = params.db.listResourceTagsForEntry(rec.id, org.id);
    const markdown = renderRecordMarkdown(rec, realmPath, tags);
    const bytes = Buffer.byteLength(markdown, "utf8");

    if (!dryRun) {
      const fullPath = assertPathWithinDir(outDir, path.join(outDir, relPath));
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, markdown, "utf8");
    }

    items.push({
      recordId: rec.id,
      realmPath,
      relativePath: relPath,
      bytes,
    });
  }

  let manifestPath: string | null = null;
  if (!dryRun) {
    manifestPath = assertPathWithinDir(outDir, path.join(outDir, "MANIFEST.json"));
    const manifest = {
      oneWayProjection: true,
      warning:
        "One-way Markdown mirror exported from Meru Mind SQLite. Do not edit expecting sync back. Committing exports to Git means `redact` cannot purge historical commits.",
      exportedAt: new Date().toISOString(),
      orgId: org.id,
      orgName: org.name,
      includeConfidential,
      exportedCount: items.length,
      skippedSecret,
      skippedConfidential,
      skippedRedacted,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  return {
    oneWayProjection: true,
    dryRun,
    outDir,
    orgId: org.id,
    orgName: org.name,
    exportedCount: items.length,
    skippedSecret,
    skippedConfidential,
    skippedRedacted,
    includeConfidential,
    manifestPath,
    items,
  };
}
