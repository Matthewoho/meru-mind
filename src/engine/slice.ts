import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveAccessScope } from "../policy.js";
import type { DbPort, DrivePort } from "../ports.js";
import {
  MindError,
  type Actor,
  type BriefBudget,
  type BriefOutput,
  type Sensitivity,
  type SliceExportResult,
  type SliceVerificationResult,
} from "../types.js";
import type { LedgerEngine } from "./ledger.js";
import type { SeaEngine } from "./sea.js";

const SQLITE_HEADER = "SQLite format 3";

function sha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function isForbiddenSqliteArtifact(relPath: string, content: string | Buffer): boolean {
  const lower = relPath.toLowerCase();
  if (
    lower.endsWith(".sqlite") ||
    lower.endsWith(".sqlite3") ||
    lower.endsWith(".sqlite-wal") ||
    lower.endsWith(".sqlite-shm") ||
    lower.endsWith(".db")
  ) {
    return true;
  }
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (
    buf.length >= SQLITE_HEADER.length &&
    buf.subarray(0, SQLITE_HEADER.length).toString("utf8") === SQLITE_HEADER
  ) {
    return true;
  }
  return false;
}

export function restoreWritablePermissions(dir: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    fs.chmodSync(dir, 0o755);
  } catch {
    // ignore
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      restoreWritablePermissions(full);
    } else if (entry.isFile()) {
      try {
        fs.chmodSync(full, 0o644);
      } catch {
        // ignore
      }
    }
  }
}

function restoreWritable(dir: string): void {
  restoreWritablePermissions(dir);
}

function lockReadonly(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      lockReadonly(full);
      try {
        fs.chmodSync(full, 0o555);
      } catch {
        // ignore
      }
    } else if (entry.isFile()) {
      try {
        fs.chmodSync(full, 0o444);
      } catch {
        // ignore
      }
    }
  }
  try {
    fs.chmodSync(dir, 0o555);
  } catch {
    // ignore
  }
}

function renderBriefMarkdown(brief: BriefOutput): string {
  const lines: string[] = [
    `# MindRealm Brief: ${brief.realm.name} (${brief.realm.path})`,
    ``,
    `- Realm ID: \`${brief.realm.id}\``,
    `- Generated At: \`${brief.generatedAt}\``,
    ``,
    `## Active Rules (${brief.middleMind.rules.items.length}/${brief.middleMind.rules.totalCount}, omitted: ${brief.middleMind.rules.omittedCount})`,
  ];
  if (brief.middleMind.rules.items.length === 0) {
    lines.push(`- (none)`);
  } else {
    for (const r of brief.middleMind.rules.items) {
      lines.push(
        `- [${r.id}] ${r.title}${r.inherited ? ` *(inherited from ${r.realmId})*` : ""}`,
      );
    }
  }

  lines.push(
    ``,
    `## Active Decisions (${brief.upperLedger.activeDecisions.items.length}/${brief.upperLedger.activeDecisions.totalCount}, omitted: ${brief.upperLedger.activeDecisions.omittedCount})`,
  );
  if (brief.upperLedger.activeDecisions.items.length === 0) {
    lines.push(`- (none)`);
  } else {
    for (const d of brief.upperLedger.activeDecisions.items) {
      lines.push(`- [${d.id}] ${d.title} *(realm: ${d.realmId})*`);
    }
  }

  lines.push(
    ``,
    `## Active Things (${brief.upperLedger.activeThings.items.length}/${brief.upperLedger.activeThings.totalCount}, omitted: ${brief.upperLedger.activeThings.omittedCount})`,
  );
  if (brief.upperLedger.activeThings.items.length === 0) {
    lines.push(`- (none)`);
  } else {
    for (const t of brief.upperLedger.activeThings.items) {
      lines.push(`- [${t.id}] ${t.title}`);
    }
  }

  lines.push(
    ``,
    `## Pending Questions (${brief.upperLedger.pendingQuestions.items.length}/${brief.upperLedger.pendingQuestions.totalCount}, omitted: ${brief.upperLedger.pendingQuestions.omittedCount})`,
  );
  if (brief.upperLedger.pendingQuestions.items.length === 0) {
    lines.push(`- (none)`);
  } else {
    for (const q of brief.upperLedger.pendingQuestions.items) {
      lines.push(`- [${q.id}] ${q.title}`);
    }
  }

  if (brief.middleMind.realmCard) {
    lines.push(
      ``,
      `## Cognitive Card (${brief.middleMind.realmCard.id})`,
      ``,
      brief.middleMind.realmCard.narrativeMd,
    );
  }

  if (brief.middleMind.ancestorSummaries.length > 0) {
    lines.push(``, `## Ancestors`);
    for (const a of brief.middleMind.ancestorSummaries) {
      lines.push(`- ${a.realmPath} (${a.realmId}): ${a.summary}`);
    }
  }

  if (brief.middleMind.childSummaries.items.length > 0) {
    lines.push(
      ``,
      `## Child Realms (${brief.middleMind.childSummaries.items.length}/${brief.middleMind.childSummaries.totalCount}, omitted: ${brief.middleMind.childSummaries.omittedCount})`,
    );
    for (const c of brief.middleMind.childSummaries.items) {
      const pendingSuffix =
        c.pendingQuestions > 0 ? `, pendingQuestions=${c.pendingQuestions}` : "";
      lines.push(
        `- ${c.realmPath} (${c.realmId}): conclusions=${c.activeConclusions}, rules=${c.activeRules}, objects=${c.activeObjects}${pendingSuffix}`,
      );
    }
  }

  lines.push(
    ``,
    `## Recent Messages (${brief.surface.recentMessages.items.length}/${brief.surface.recentMessages.totalCount}, omitted: ${brief.surface.recentMessages.omittedCount})`,
  );
  for (const m of brief.surface.recentMessages.items) {
    lines.push(`- [${m.id}] ${m.authorId}: ${m.text.replace(/\s+/g, " ").trim()}`);
  }

  lines.push(``, `> ${brief.drilldownHint}`);
  return `${lines.join("\n")}\n`;
}

function realpathExistingPrefix(targetPath: string): string {
  const abs = path.resolve(targetPath);
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

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isExistingMeruSliceDir(dir: string): boolean {
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      viewerRealmId?: unknown;
      files?: unknown;
    };
    return (
      typeof parsed.viewerRealmId === "string" &&
      parsed.files !== null &&
      typeof parsed.files === "object"
    );
  } catch {
    return false;
  }
}

/**
 * Exports a strictly scoped, read-only MindRealm slice (e.g. `.meru/.mindrealm/`)
 * for shallow-integrated agents, and verifies post-run that no read-only slice file was tampered with.
 */
export class SliceExporter {
  constructor(
    private readonly db: DbPort,
    private readonly drive: DrivePort,
    private readonly ledger: LedgerEngine,
    private readonly sea: SeaEngine,
    private readonly homeDir?: string,
  ) {}

  private assertSafeOutDir(outDir: string): string {
    const resolved = realpathExistingPrefix(outDir);
    const fsRoot = path.parse(resolved).root;
    if (resolved === fsRoot) {
      throw new MindError(
        "SLICE_VIOLATION",
        `Refusing to export slice into filesystem root (${resolved})`,
      );
    }
    if (this.homeDir) {
      const realHome = realpathExistingPrefix(this.homeDir);
      if (
        isSameOrInside(resolved, realHome) ||
        isSameOrInside(realHome, resolved)
      ) {
        throw new MindError(
          "SLICE_VIOLATION",
          `Refusing to export slice overlapping runtime homeDir (${realHome})`,
        );
      }
    }
    if (fs.existsSync(resolved)) {
      const stat = fs.lstatSync(resolved);
      if (!stat.isDirectory()) {
        throw new MindError(
          "SLICE_VIOLATION",
          `Slice export target exists and is not a directory: ${resolved}`,
        );
      }
      const entries = fs.readdirSync(resolved);
      if (entries.length > 0 && !isExistingMeruSliceDir(resolved)) {
        throw new MindError(
          "SLICE_VIOLATION",
          `Refusing to overwrite non-empty directory that is not an existing MindRealm slice: ${resolved}`,
        );
      }
    }
    return resolved;
  }

  async exportSlice(params: {
    actor: Actor;
    viewerRealmId: string;
    outDir: string;
    budget?: BriefBudget;
    readonly?: boolean;
  }): Promise<SliceExportResult> {
    // Validate target outDir before touching filesystem
    const outDir = this.assertSafeOutDir(params.outDir);

    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const realmsById = new Map(realms.map((r) => [r.id, r]));
    const viewerRealm = realmsById.get(params.viewerRealmId);
    const orgPolicy = viewerRealm
      ? (this.db.getOrg(viewerRealm.orgId)?.policy ?? "tree")
      : "tree";

    const scope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: params.viewerRealmId,
      orgPolicy,
      includeDescendantSeabed: false,
    });

    const exportExcludedSensitivities: Sensitivity[] = [
      "secret",
      "confidential",
    ];

    const brief = this.sea.brief({
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      budget: params.budget,
      excludeSensitivities: exportExcludedSensitivities,
    });

    const files: Record<string, string> = {};
    const put = (relPath: string, content: string) => {
      if (isForbiddenSqliteArtifact(relPath, content)) {
        throw new MindError(
          "SLICE_VIOLATION",
          `Database file "${relPath}" is forbidden from entering a sandbox slice`,
        );
      }
      files[relPath] = content;
    };

    put("BRIEF.md", renderBriefMarkdown(brief));
    put("brief.json", JSON.stringify(brief, null, 2));

    const visibleLedgerSet = new Set(scope.readableLedgerIds);
    const visibleSeabedSet = new Set(scope.readableSeabedIds);
    const visibleDriveSet = new Set(scope.readableDriveIds);
    const isExportableRef = (ref: string): boolean => {
      if (ref.startsWith("drive://")) {
        const rest = ref.slice("drive://".length);
        const slash = rest.indexOf("/");
        if (slash > 0) {
          return visibleDriveSet.has(rest.slice(0, slash));
        }
      }
      const r = this.db.getRecord(ref);
      if (r) {
        return (
          visibleLedgerSet.has(r.realmId) &&
          r.sensitivity !== "secret" &&
          r.sensitivity !== "confidential"
        );
      }
      const s = this.db.getSeabedEntry(ref);
      if (s) {
        return (
          visibleSeabedSet.has(s.realmId) &&
          s.sensitivity !== "secret" &&
          s.sensitivity !== "confidential"
        );
      }
      const d = this.db.getDistillation(ref);
      if (d) return visibleLedgerSet.has(d.realmId);
      return true;
    };

    // Export self ledger & drive (strictly excluding secret & confidential)
    const exportRealmData = async (prefix: string, realmId: string, includeDrive: boolean) => {
      const sanitizeList = (items: ReturnType<DbPort["listRecords"]>["items"]) =>
        items.map((r) => {
          const visibleSupIds = (
            r.supersedesIds && r.supersedesIds.length > 0
              ? r.supersedesIds
              : r.supersedesId
                ? [r.supersedesId]
                : []
          ).filter(isExportableRef);
          return {
            ...r,
            refs: r.refs.filter(isExportableRef),
            supersedesId: visibleSupIds[0] ?? null,
            supersedesIds: visibleSupIds,
            supersededById:
              r.supersededById && isExportableRef(r.supersededById)
                ? r.supersededById
                : null,
          };
        });

      const rules = sanitizeList(
        this.db.listRecords({
          realmIds: [realmId],
          kinds: ["rule"],
          includeSuperseded: false,
          excludeSensitivities: exportExcludedSensitivities,
          limit: 200,
        }).items,
      );
      const decisions = sanitizeList(
        this.db.listRecords({
          realmIds: [realmId],
          kinds: ["decision"],
          includeSuperseded: false,
          excludeSensitivities: exportExcludedSensitivities,
          limit: 200,
        }).items,
      );
      const things = sanitizeList(
        this.db.listRecords({
          realmIds: [realmId],
          kinds: ["thing"],
          includeSuperseded: false,
          excludeSensitivities: exportExcludedSensitivities,
          limit: 200,
        }).items,
      );

      put(`${prefix}/rules.json`, JSON.stringify(rules, null, 2));
      put(`${prefix}/decisions.json`, JSON.stringify(decisions, null, 2));
      put(`${prefix}/things.json`, JSON.stringify(things, null, 2));

      if (includeDrive) {
        const driveMetas = await this.drive.listFiles(realmId);
        for (const meta of driveMetas) {
          const loaded = await this.drive.readFile(realmId, meta.relPath);
          if (loaded) {
            put(`${prefix}/drive/${meta.relPath}`, loaded.content);
          }
        }
      }
    };

    await exportRealmData("self", params.viewerRealmId, true);

    for (const aid of scope.ancestorIds) {
      const aRealm = realmsById.get(aid)!;
      await exportRealmData(`ancestors/${aRealm.slug}_${aid}`, aid, true);
    }

    const mountedAll = Array.from(
      new Set([...scope.mountedLedgerIds, ...scope.mountedDriveIds]),
    );
    for (const mid of mountedAll) {
      const mRealm = realmsById.get(mid)!;
      const includeDrive = scope.mountedDriveIds.includes(mid);
      const includeLedger = scope.mountedLedgerIds.includes(mid);
      if (includeLedger) {
        await exportRealmData(`@mounted/${mRealm.slug}_${mid}`, mid, includeDrive);
      } else if (includeDrive) {
        const driveMetas = await this.drive.listFiles(mid);
        for (const meta of driveMetas) {
          const loaded = await this.drive.readFile(mid, meta.relPath);
          if (loaded) {
            put(`@mounted/${mRealm.slug}_${mid}/drive/${meta.relPath}`, loaded.content);
          }
        }
      }
    }

    // Descendants: export ledger summaries only (no descendant raw seabed)
    for (const childSummary of brief.middleMind.childSummaries.items) {
      const cRealm = realmsById.get(childSummary.realmId)!;
      put(
        `children/${cRealm.slug}_${cRealm.id}/summary.json`,
        JSON.stringify(childSummary, null, 2),
      );
    }

    // Open policy: also export same-org peer realms (never cross-org, never secret/confidential)
    if (scope.policy === "open") {
      const alreadyExported = new Set<string>([
        params.viewerRealmId,
        ...scope.ancestorIds,
        ...scope.descendantIds,
        ...mountedAll,
      ]);
      for (const peerId of scope.readableLedgerIds) {
        if (alreadyExported.has(peerId)) continue;
        const pRealm = realmsById.get(peerId);
        if (!pRealm) continue;
        await exportRealmData(
          `org/${pRealm.slug}_${pRealm.id}`,
          pRealm.id,
          scope.readableDriveIds.includes(pRealm.id),
        );
      }
    }

    // Compute manifest (never mentions hidden sibling realm IDs!)
    const manifest: Record<string, string> = {};
    for (const [relPath, content] of Object.entries(files).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      manifest[relPath] = sha256(content);
    }

    const exportedAt = new Date().toISOString();
    const manifestJson = JSON.stringify(
      {
        viewerRealmId: params.viewerRealmId,
        exportedAt,
        files: manifest,
      },
      null,
      2,
    );

    // Replace validated empty or prior-slice directory cleanly
    if (fs.existsSync(outDir)) {
      restoreWritable(outDir);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outDir, { recursive: true });

    for (const [relPath, content] of Object.entries(files)) {
      const full = path.join(outDir, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
    fs.writeFileSync(path.join(outDir, "manifest.json"), manifestJson, "utf8");
    manifest["manifest.json"] = sha256(manifestJson);

    if (params.readonly !== false) {
      lockReadonly(outDir);
    }

    return {
      realmId: params.viewerRealmId,
      outDir,
      exportedAt,
      fileCount: Object.keys(manifest).length,
      manifest,
    };
  }

  async verifySlice(params: {
    actor: Actor;
    viewerRealmId: string;
    outDir: string;
    expectedManifest: Record<string, string>;
    recordFindingOnViolation?: boolean;
  }): Promise<SliceVerificationResult> {
    const outDir = path.resolve(params.outDir);
    const actual: Record<string, string> = {};

    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(outDir, full).split(path.sep).join("/");
        if (entry.isSymbolicLink()) {
          // Never follow symlinks; record symlink target as a tampered/added artifact
          actual[rel] = sha256(`symlink:${fs.readlinkSync(full)}`);
        } else if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          actual[rel] = sha256(fs.readFileSync(full));
        } else {
          actual[rel] = sha256(`special:${rel}`);
        }
      }
    };
    walk(outDir);

    const modifiedPaths: string[] = [];
    const deletedPaths: string[] = [];
    const addedPaths: string[] = [];

    for (const [rel, expectedHash] of Object.entries(params.expectedManifest)) {
      if (!(rel in actual)) {
        deletedPaths.push(rel);
      } else if (actual[rel] !== expectedHash) {
        modifiedPaths.push(rel);
      }
    }
    for (const rel of Object.keys(actual)) {
      if (!(rel in params.expectedManifest)) {
        addedPaths.push(rel);
      }
    }

    const intact =
      modifiedPaths.length === 0 &&
      deletedPaths.length === 0 &&
      addedPaths.length === 0;

    let findingId: string | undefined;
    if (!intact && params.recordFindingOnViolation !== false) {
      const finding = await this.ledger.appendRecord({
        actor: params.actor,
        viewerRealmId: params.viewerRealmId,
        kind: "finding",
        title: "Read-only MindRealm slice was modified inside sandbox",
        payload: {
          code: "SLICE_VIOLATION",
          outDir,
          modifiedPaths,
          deletedPaths,
          addedPaths,
          resolution: "discarded",
        },
      });
      findingId = finding.id;
    }

    return {
      intact,
      modifiedPaths,
      deletedPaths,
      addedPaths,
      findingId,
    };
  }
}
