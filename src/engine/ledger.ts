import crypto from "node:crypto";
import { assertSafeIdentifier } from "../adapters/local-drive.js";
import { assertAccess, resolveAccess } from "../policy.js";
import type {
  BlobPort,
  DbPort,
  DrivePort,
  EmbedderPort,
} from "../ports.js";
import {
  MindError,
  type Actor,
  type DriveFileContent,
  type DriveFileMeta,
  type LedgerRecord,
  type MountScope,
  type Organization,
  type Realm,
  type RealmMount,
  type RecordKind,
  type SeabedEntry,
  type SeabedKind,
} from "../types.js";

const VALID_SEABED_KINDS = new Set<string>([
  "message",
  "artifact",
  "evidence",
  "signal",
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
const VALID_MOUNT_SCOPES = new Set<string>(["all", "ledger", "drive"]);
const VALID_ACTOR_KINDS = new Set<string>(["human", "agent", "system"]);

function validateActor(actor: Actor): Actor {
  if (!actor || !actor.id?.trim()) {
    throw new MindError("INVALID_INPUT", "Actor id cannot be empty");
  }
  if (!VALID_ACTOR_KINDS.has(actor.kind)) {
    throw new MindError("INVALID_INPUT", `Invalid actor kind: "${String(actor.kind)}"`);
  }
  const family = actor.family?.trim();
  return {
    id: actor.id.trim(),
    kind: actor.kind,
    ...(family ? { family } : {}),
  };
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function normalizeSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new MindError("INVALID_INPUT", `Invalid slug: "${raw}"`);
  }
  return slug;
}

export interface IndexHooks {
  indexSeabed(entry: SeabedEntry): Promise<void>;
  indexRecord(record: LedgerRecord): Promise<void>;
}

export class LedgerEngine {
  constructor(
    private readonly db: DbPort,
    private readonly blobs: BlobPort,
    private readonly drive: DrivePort,
    private readonly embedder: EmbedderPort,
  ) {}

  private async indexItem(params: {
    itemId: string;
    sourceType: "record" | "seabed" | "distillation";
    realmId: string;
    status: string;
    title: string;
    body: string;
  }): Promise<void> {
    this.db.upsertFtsItem(params);
    const embedText = `${params.title}\n${params.body}`.trim();
    if (!embedText) return;

    if (this.db.vecEnabled && this.embedder.configured) {
      const vec = await this.embedder.embed(embedText);
      if (vec) {
        this.db.upsertVectorItem({
          itemId: params.itemId,
          sourceType: params.sourceType,
          realmId: params.realmId,
          status: params.status,
          embedding: vec,
        });
        return;
      }
    }
    this.db.markVectorPending({
      itemId: params.itemId,
      sourceType: params.sourceType,
      realmId: params.realmId,
      status: params.status,
      text: embedText,
    });
  }

  // ---- Organizations & Realms ----

  createOrg(params: {
    id?: string;
    name: string;
    isPersonalRoot?: boolean;
  }): { org: Organization; rootRealm: Realm } {
    const name = params.name.trim();
    if (!name) {
      throw new MindError("INVALID_INPUT", "Organization name cannot be empty");
    }
    const orgId = params.id?.trim() || makeId("org");
    assertSafeIdentifier(orgId, "orgId");
    const now = new Date().toISOString();
    const org: Organization = {
      id: orgId,
      name,
      isPersonalRoot: Boolean(params.isPersonalRoot),
      createdAt: now,
    };
    const rootRealm: Realm = {
      id: makeId("realm"),
      orgId: org.id,
      parentId: null,
      slug: "root",
      path: "/",
      name: `${name} Root`,
      archivedAt: null,
      createdAt: now,
    };

    this.db.transaction(() => {
      this.db.insertOrg(org);
      this.db.insertRealm(rootRealm);
    });
    return { org, rootRealm };
  }

  listOrgs(): Organization[] {
    return this.db.listOrgs();
  }

  createRealm(params: {
    id?: string;
    orgId: string;
    parentId: string;
    slug: string;
    name: string;
  }): Realm {
    const name = params.name.trim();
    if (!name) {
      throw new MindError("INVALID_INPUT", "Realm name cannot be empty");
    }
    const org = this.db.getOrg(params.orgId);
    if (!org) {
      throw new MindError("NOT_FOUND", `Organization not found: ${params.orgId}`);
    }
    const parent = this.db.getRealm(params.parentId);
    if (!parent) {
      throw new MindError("NOT_FOUND", `Parent realm not found: ${params.parentId}`);
    }
    if (parent.orgId !== params.orgId) {
      throw new MindError(
        "ACCESS_DENIED",
        `Parent realm "${params.parentId}" belongs to a different organization`,
      );
    }

    const slug = normalizeSlug(params.slug);
    const realmPath =
      parent.path === "/" ? `/${slug}` : `${parent.path}/${slug}`;
    if (this.db.getRealmByPath(params.orgId, realmPath)) {
      throw new MindError(
        "CONFLICT",
        `Realm already exists at path "${realmPath}" in org "${params.orgId}"`,
      );
    }

    const realmId = params.id?.trim() || makeId("realm");
    assertSafeIdentifier(realmId, "realmId");
    const realm: Realm = {
      id: realmId,
      orgId: params.orgId,
      parentId: parent.id,
      slug,
      path: realmPath,
      name,
      archivedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.db.insertRealm(realm);
    return realm;
  }

  getRealm(id: string): Realm | null {
    return this.db.getRealm(id);
  }

  listRealms(orgId?: string): Realm[] {
    return this.db.listRealms(orgId);
  }

  mountRealm(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId: string;
    scope?: MountScope;
  }): RealmMount {
    const actor = validateActor(params.actor);
    const scope = params.scope ?? "all";
    if (!VALID_MOUNT_SCOPES.has(scope)) {
      throw new MindError("INVALID_INPUT", `Invalid mount scope: "${String(scope)}"`);
    }
    if (params.viewerRealmId === params.targetRealmId) {
      throw new MindError(
        "INVALID_INPUT",
        "Cannot mount a realm onto itself",
      );
    }
    const viewer = this.db.getRealm(params.viewerRealmId);
    const target = this.db.getRealm(params.targetRealmId);
    if (!viewer) {
      throw new MindError("NOT_FOUND", `Viewer realm not found: ${params.viewerRealmId}`);
    }
    if (!target) {
      throw new MindError("NOT_FOUND", `Target realm not found: ${params.targetRealmId}`);
    }
    if (viewer.orgId !== target.orgId) {
      throw new MindError(
        "ACCESS_DENIED",
        "Cross-organization realm mounts are forbidden",
      );
    }

    const mount: RealmMount = {
      id: makeId("mnt"),
      viewerRealmId: viewer.id,
      targetRealmId: target.id,
      scope,
      mountedBy: actor.id,
      createdAt: new Date().toISOString(),
    };
    this.db.insertMount(mount);
    return mount;
  }

  unmountRealm(viewerRealmId: string, targetRealmId: string): boolean {
    return this.db.deleteMount(viewerRealmId, targetRealmId);
  }

  listMounts(viewerRealmId?: string): RealmMount[] {
    return this.db.listMounts(viewerRealmId);
  }

  // ---- Seabed (Truth Source 1) ----

  async captureSeabed(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId?: string;
    kind: SeabedKind;
    topicId?: string | null;
    text: string;
    blobContent?: Buffer | string;
    sourceRef?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<SeabedEntry> {
    const actor = validateActor(params.actor);
    if (!VALID_SEABED_KINDS.has(params.kind)) {
      throw new MindError("INVALID_INPUT", `Invalid seabed kind: "${String(params.kind)}"`);
    }
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();

    assertAccess({
      realms,
      mounts,
      actor,
      viewerRealmId: params.viewerRealmId,
      targetRealmId,
      assetKind: "seabed",
      required: "write",
    });

    const text = params.text.trim();
    if (!text && !params.blobContent) {
      throw new MindError(
        "INVALID_INPUT",
        "Seabed entry requires non-empty text or blobContent",
      );
    }

    let blobSha256: string | null = null;
    if (params.blobContent !== undefined) {
      blobSha256 = this.blobs.put(params.blobContent).sha256;
    }

    const entry: SeabedEntry = {
      id: makeId("sea"),
      realmId: targetRealmId,
      topicId: params.topicId ?? null,
      kind: params.kind,
      authorId: actor.id,
      authorKind: actor.kind,
      authorFamily: actor.family ?? null,
      text,
      blobSha256,
      sourceRef: params.sourceRef ?? null,
      metadata: params.metadata ?? {},
      createdAt: new Date().toISOString(),
    };

    this.db.insertSeabedEntry(entry);
    await this.indexItem({
      itemId: entry.id,
      sourceType: "seabed",
      realmId: entry.realmId,
      status: "evidence",
      title: `${entry.kind}:${entry.topicId ?? entry.realmId}`,
      body: entry.text,
    });

    return entry;
  }

  // ---- Ledger Records (Truth Source 2) ----

  async appendRecord(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId?: string;
    thingId?: string | null;
    kind: RecordKind;
    title: string;
    payload?: Record<string, unknown>;
    refs?: string[];
    supersedesId?: string | null;
  }): Promise<LedgerRecord> {
    const actor = validateActor(params.actor);
    if (!VALID_RECORD_KINDS.has(params.kind)) {
      throw new MindError("INVALID_INPUT", `Invalid record kind: "${String(params.kind)}"`);
    }
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();

    assertAccess({
      realms,
      mounts,
      actor,
      viewerRealmId: params.viewerRealmId,
      targetRealmId,
      assetKind: params.kind === "rule" ? "rule" : "ledger",
      required: "write",
    });

    const title = params.title.trim();
    if (!title) {
      throw new MindError("INVALID_INPUT", "Record title cannot be empty");
    }

    const payload = params.payload ?? {};
    const refs = Array.from(new Set(params.refs ?? []));

    const resolveVisibleRecord = (id: string): LedgerRecord | null => {
      const rec = this.db.getRecord(id);
      if (!rec) return null;
      const access = resolveAccess({
        realms,
        mounts,
        actor,
        viewerRealmId: params.viewerRealmId,
        targetRealmId: rec.realmId,
        assetKind: rec.kind === "rule" ? "rule" : "ledger",
      });
      return access === "none" ? null : rec;
    };

    const resolveVisibleSeabed = (id: string): SeabedEntry | null => {
      const sea = this.db.getSeabedEntry(id);
      if (!sea) return null;
      const access = resolveAccess({
        realms,
        mounts,
        actor,
        viewerRealmId: params.viewerRealmId,
        targetRealmId: sea.realmId,
        assetKind: "seabed",
        explicitDescendantDive: true,
      });
      return access === "none" ? null : sea;
    };

    // Opaque existence & visibility check: nonexistent and hidden-sibling IDs produce
    // the exact same error code and message (zero blind-ID oracle).
    const citedRecords: LedgerRecord[] = [];
    for (const refId of refs) {
      const rec = resolveVisibleRecord(refId);
      if (rec) {
        citedRecords.push(rec);
        continue;
      }
      const sea = resolveVisibleSeabed(refId);
      if (sea) {
        continue;
      }
      throw new MindError(
        "NOT_FOUND",
        `Entry not found in visible scope: ${refId}`,
      );
    }

    // Validate supersede chain
    let oldRecord: LedgerRecord | null = null;
    if (params.supersedesId) {
      oldRecord = this.db.getRecord(params.supersedesId);
      if (!oldRecord || oldRecord.realmId !== targetRealmId) {
        throw new MindError(
          "NOT_FOUND",
          `Entry not found in visible scope: ${params.supersedesId}`,
        );
      }
      if (oldRecord.kind !== params.kind) {
        throw new MindError(
          "INVALID_INPUT",
          `Superseding record kind "${params.kind}" must match superseded record kind "${oldRecord.kind}"`,
        );
      }
      if (oldRecord.status !== "active") {
        throw new MindError(
          "CONFLICT",
          `Record "${oldRecord.id}" is already ${oldRecord.status} (supersededBy=${oldRecord.supersededById ?? "none"})`,
        );
      }
    }

    // Verdict invariants: scoped proposal lookup, cross-family check, and cited rejection
    if (params.kind === "verdict") {
      const proposalId =
        typeof payload.proposalId === "string"
          ? payload.proposalId
          : citedRecords.find((r) => r.kind === "proposal")?.id;
      if (proposalId) {
        const proposal = resolveVisibleRecord(proposalId);
        if (!proposal) {
          throw new MindError(
            "NOT_FOUND",
            `Entry not found in visible scope: ${proposalId}`,
          );
        }
        if (proposal.authorKind === "agent" && actor.kind === "agent") {
          const verifierFam = actor.family?.trim().toLowerCase() ?? "";
          const proposalFam = proposal.authorFamily?.trim().toLowerCase() ?? "";
          if (!verifierFam || !proposalFam) {
            throw new MindError(
              "VERDICT_INVARIANT",
              "Agent verdicts on agent proposals require explicit model family stamps on both actors",
            );
          }
          if (verifierFam === proposalFam) {
            throw new MindError(
              "VERDICT_INVARIANT",
              `Same-family self-verification is forbidden: proposal family "${proposal.authorFamily}" matches verifier family "${actor.family}"`,
            );
          }
        }
      }

      const normalizedOutcome =
        typeof payload.outcome === "string"
          ? payload.outcome.trim().toLowerCase()
          : "";
      if (normalizedOutcome === "reject") {
        const hasBasis = citedRecords.some(
          (r) =>
            (r.kind === "decision" || r.kind === "rule") &&
            r.status === "active",
        );
        if (!hasBasis) {
          throw new MindError(
            "VERDICT_INVARIANT",
            "A reject verdict must cite at least one active public decision or rule in refs; if no rule/decision exists, open a question proposal instead.",
          );
        }
      }
    }

    const id = makeId("rec");
    const thingId =
      params.kind === "thing" ? (params.thingId ?? id) : (params.thingId ?? null);

    const record: LedgerRecord = {
      id,
      realmId: targetRealmId,
      thingId,
      kind: params.kind,
      status: "active",
      supersedesId: oldRecord?.id ?? null,
      supersededById: null,
      authorId: actor.id,
      authorKind: actor.kind,
      authorFamily: actor.family ?? null,
      title,
      payload,
      refs,
      createdAt: new Date().toISOString(),
    };

    this.db.transaction(() => {
      this.db.insertRecord(record);
      if (oldRecord) {
        this.db.markRecordSuperseded(oldRecord.id, record.id);
        this.db.updateFtsStatus(oldRecord.id, "superseded");
        this.db.updateVectorStatus(oldRecord.id, "superseded");
      }
    });

    const payloadText = Object.entries(record.payload)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n");
    await this.indexItem({
      itemId: record.id,
      sourceType: "record",
      realmId: record.realmId,
      status: record.status,
      title: record.title,
      body: payloadText,
    });

    return record;
  }

  getSupersedeChain(params: {
    actor: Actor;
    viewerRealmId: string;
    recordId: string;
  }): LedgerRecord[] {
    const actor = validateActor(params.actor);
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const start = this.db.getRecord(params.recordId);
    const access = start
      ? resolveAccess({
          realms,
          mounts,
          actor,
          viewerRealmId: params.viewerRealmId,
          targetRealmId: start.realmId,
          assetKind: start.kind === "rule" ? "rule" : "ledger",
        })
      : "none";
    if (!start || access === "none") {
      throw new MindError(
        "NOT_FOUND",
        `Entry not found in visible scope: ${params.recordId}`,
      );
    }

    // Walk back to oldest ancestor
    let oldest = start;
    const seen = new Set<string>([oldest.id]);
    while (oldest.supersedesId && !seen.has(oldest.supersedesId)) {
      const prev = this.db.getRecord(oldest.supersedesId);
      if (!prev) break;
      seen.add(prev.id);
      oldest = prev;
    }

    // Walk forward to newest
    const chain: LedgerRecord[] = [oldest];
    let cur = oldest;
    while (cur.supersededById) {
      const next = this.db.getRecord(cur.supersededById);
      if (!next || chain.some((c) => c.id === next.id)) break;
      chain.push(next);
      cur = next;
    }
    return chain;
  }

  // ---- MindRealm Shared Drive (LayerFS / Local + Immutable Blob Mirror) ----

  async writeDriveFile(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId?: string;
    relPath: string;
    content: string;
    expectedVersion?: number;
    message?: string;
  }): Promise<{ meta: DriveFileMeta; commitId?: string; artifactId: string }> {
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();

    assertAccess({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      targetRealmId,
      assetKind: "drive",
      required: "write",
    });

    // Write via DrivePort (LayerFS or LocalFs) with optimistic conflict detection
    const res = await this.drive.writeFile({
      realmId: targetRealmId,
      relPath: params.relPath,
      content: params.content,
      authorId: params.actor.id,
      expectedVersion: params.expectedVersion,
      message: params.message,
    });

    // Mirror committed snapshot into immutable BlobPort + SQLite metadata
    // so the entire drive survives a LayerFS volume loss/reset.
    const blob = this.blobs.put(params.content);
    const meta: DriveFileMeta = {
      ...res.meta,
      sha256: blob.sha256,
    };
    this.db.upsertDriveFileMeta(meta);

    const artifact = await this.captureSeabed({
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      targetRealmId,
      kind: "artifact",
      text: `Updated drive file ${meta.relPath} (v${meta.version})${params.message ? `: ${params.message}` : ""}`,
      blobContent: params.content,
      sourceRef: `drive://${targetRealmId}/${meta.relPath}@v${meta.version}`,
      metadata: {
        relPath: meta.relPath,
        version: meta.version,
        sha256: meta.sha256,
        commitId: res.commitId ?? null,
      },
    });

    return { meta, commitId: res.commitId, artifactId: artifact.id };
  }

  async readDriveFile(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId?: string;
    relPath: string;
  }): Promise<DriveFileContent | null> {
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();

    assertAccess({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      targetRealmId,
      assetKind: "drive",
      required: "read",
    });

    return this.drive.readFile(targetRealmId, params.relPath);
  }

  async listDriveFiles(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId?: string;
  }): Promise<DriveFileMeta[]> {
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();

    assertAccess({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      targetRealmId,
      assetKind: "drive",
      required: "read",
    });

    return this.drive.listFiles(targetRealmId);
  }
}
