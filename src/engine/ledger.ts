import crypto from "node:crypto";
import { assertSafeIdentifier } from "../adapters/local-drive.js";
import { buildRecordFtsBody } from "../format/snippet.js";
import {
  assertAccess,
  findEffectiveArchivedRealm,
  intersectAccessScopes,
  resolveAccess,
  resolveAccessScope,
} from "../policy.js";
import type {
  BlobPort,
  DbPort,
  DrivePort,
  EmbedderPort,
} from "../ports.js";
import {
  MindError,
  type AccessScope,
  type Actor,
  type DriveFileContent,
  type DriveFileMeta,
  type LedgerRecord,
  type MountScope,
  type MovedEntryItem,
  type MoveEntriesResult,
  type Organization,
  type OrgPolicy,
  type Realm,
  type RealmArchiveResult,
  type RealmMount,
  type RealmUnarchiveResult,
  type RecordKind,
  type RedactResult,
  type SeabedEntry,
  type SeabedKind,
  type Sensitivity,
  type SupersedeChainResult,
} from "../types.js";
import {
  createVisibilityHelpers,
  parseDriveSourceRef,
  sanitizeRealmsForScope,
} from "./visibility.js";
import {
  computeFileContentSha256,
  computePayloadHash,
  computeRecordContentSha256,
  computeSeabedContentSha256,
  REDACTED_CONTENT_BLOCKED_MSG,
  REDACTED_CONTENT_TRY_HINT,
  sha256Bytes,
} from "./content-hash.js";
import {
  normalizeResourceTag,
  OPAQUE_OBJECT_NOT_FOUND,
  resolveVisibleRealm,
} from "./objects.js";

export { computePayloadHash };

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
const VALID_ORG_POLICIES = new Set<string>(["open", "tree"]);
const VALID_SENSITIVITIES = new Set<string>([
  "public",
  "internal",
  "confidential",
  "secret",
]);

function validateSensitivity(raw?: Sensitivity): Sensitivity {
  const sensitivity = raw ?? "internal";
  if (!VALID_SENSITIVITIES.has(sensitivity)) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid sensitivity: "${String(sensitivity)}"`,
    );
  }
  return sensitivity;
}

function normalizeIdempotencyKey(raw?: string): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new MindError(
      "INVALID_INPUT",
      "idempotencyKey cannot be empty when provided",
    );
  }
  return trimmed;
}

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

const MAX_REALM_SCOPE_CHARS = 280;

function normalizeRealmScope(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new MindError("INVALID_INPUT", "Realm scope cannot be empty");
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new MindError(
      "INVALID_INPUT",
      "Realm scope must be a single line (newlines are not allowed)",
    );
  }
  if (trimmed.length > MAX_REALM_SCOPE_CHARS) {
    throw new MindError(
      "INVALID_INPUT",
      `Realm scope must be <= ${MAX_REALM_SCOPE_CHARS} characters (got ${trimmed.length})`,
    );
  }
  return trimmed;
}

function stripIdFromHardFacts(value: unknown, entryId: string): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== entryId)
      .map((item) => stripIdFromHardFacts(item, entryId));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === entryId) continue;
      out[k] = stripIdFromHardFacts(v, entryId);
    }
    return out;
  }
  return value;
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
    _embedder?: EmbedderPort,
  ) {}

  private getOrgPolicy(orgId: string | undefined): OrgPolicy {
    if (!orgId) return "tree";
    return this.db.getOrg(orgId)?.policy ?? "tree";
  }

  private upsertFtsSync(params: {
    itemId: string;
    sourceType: "record" | "seabed" | "distillation";
    orgId: string;
    realmId: string;
    status: string;
    kind: string;
    occurredAt: string | null;
    title: string;
    body: string;
    sensitivity: Sensitivity;
    queuedAt: string;
  }): void {
    if (params.sensitivity === "secret") {
      return;
    }
    this.db.upsertFtsItem({
      itemId: params.itemId,
      orgId: params.orgId,
      sourceType: params.sourceType,
      realmId: params.realmId,
      status: params.status,
      kind: params.kind,
      occurredAt: params.occurredAt,
      title: params.title,
      body: params.body,
    });
    const embedText = `${params.title}\n${params.body}`.trim();
    if (!embedText) return;
    this.db.markVectorPending({
      itemId: params.itemId,
      sourceType: params.sourceType,
      orgId: params.orgId,
      realmId: params.realmId,
      status: params.status,
      text: embedText,
      queuedAt: params.queuedAt,
    });
  }

  // ---- Organizations & Realms ----

  createOrg(params: {
    id?: string;
    name: string;
    isPersonalRoot?: boolean;
    policy?: OrgPolicy;
  }): { org: Organization; rootRealm: Realm } {
    const name = params.name.trim();
    if (!name) {
      throw new MindError("INVALID_INPUT", "Organization name cannot be empty");
    }
    const policy = params.policy ?? "open";
    if (!VALID_ORG_POLICIES.has(policy)) {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid organization policy: "${String(policy)}"`,
      );
    }
    const orgId = params.id?.trim() || makeId("org");
    assertSafeIdentifier(orgId, "orgId");
    const now = new Date().toISOString();
    const org: Organization = {
      id: orgId,
      name,
      isPersonalRoot: Boolean(params.isPersonalRoot),
      policy,
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

  setOrgPolicy(params: {
    orgId: string;
    policy: OrgPolicy;
    actor: Actor;
  }): Organization {
    const actor = validateActor(params.actor);
    if (actor.kind !== "human") {
      throw new MindError(
        "ACCESS_DENIED",
        `Only human actors can change organization policy (actor "${actor.id}" is "${actor.kind}")`,
      );
    }
    if (!VALID_ORG_POLICIES.has(params.policy)) {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid organization policy: "${String(params.policy)}"`,
      );
    }

    return this.db.transaction(() => {
      const existing = this.db.getOrg(params.orgId);
      if (!existing) {
        throw new MindError(
          "NOT_FOUND",
          `Organization not found: ${params.orgId}`,
        );
      }
      this.db.updateOrgPolicy(existing.id, params.policy);
      const rootRealm = this.db.getRealmByPath(existing.id, "/");
      const now = new Date().toISOString();
      this.db.appendChangeLog({
        orgId: existing.id,
        realmId: rootRealm?.id ?? "__org__",
        entityType: "org",
        entityId: existing.id,
        op: "org_policy_change",
        actorId: actor.id,
        createdAt: now,
      });
      return {
        ...existing,
        policy: params.policy,
      };
    });
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
    scope?: string | null;
    actor: Actor;
  }): Realm {
    const actor = validateActor(params.actor);
    const name = params.name.trim();
    if (!name) {
      throw new MindError("INVALID_INPUT", "Realm name cannot be empty");
    }

    return this.db.transaction(() => {
      const org = this.db.getOrg(params.orgId);
      if (!org) {
        throw new MindError(
          "NOT_FOUND",
          `Organization not found: ${params.orgId}`,
        );
      }
      if (actor.kind !== "human") {
        throw new MindError(
          "ACCESS_DENIED",
          `Only human actors can create realms (actor "${actor.id}" is "${actor.kind}")`,
          {
            try: 'meru-mind realm create --parent / --slug <slug> --name "<name>" --as-human',
          },
        );
      }
      const parent = this.db.getRealm(params.parentId);
      if (!parent) {
        throw new MindError(
          "NOT_FOUND",
          `Parent realm not found: ${params.parentId}`,
        );
      }
      if (parent.orgId !== params.orgId) {
        throw new MindError(
          "ACCESS_DENIED",
          `Parent realm "${params.parentId}" belongs to a different organization`,
        );
      }

      const normalizedScope =
        params.scope !== undefined && params.scope !== null
          ? normalizeRealmScope(params.scope)
          : null;

      const allOrgRealms = this.db.listRealms(params.orgId);
      const archivedParent = findEffectiveArchivedRealm(allOrgRealms, parent.id);
      if (archivedParent) {
        throw new MindError(
          "CONFLICT",
          `Cannot create child realm under archived realm "${archivedParent.path}".`,
          {
            reason: "realm_archived",
            archivedRealmId: archivedParent.id,
            try: `meru-mind realm unarchive ${archivedParent.path} --as-human`,
          },
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
      const now = new Date().toISOString();
      const realm: Realm = {
        id: realmId,
        orgId: params.orgId,
        parentId: parent.id,
        slug,
        path: realmPath,
        name,
        ...(normalizedScope !== null ? { scope: normalizedScope } : {}),
        archivedAt: null,
        createdAt: now,
      };
      this.db.insertRealm(realm);
      this.db.appendChangeLog({
        orgId: org.id,
        realmId: realm.id,
        entityType: "realm",
        entityId: realm.id,
        op: "create_realm",
        actorId: actor.id,
        createdAt: now,
      });
      return realm;
    });
  }

  /**
   * Org-admin human-only realm metadata update (display name and/or single-line scope).
   * Slug and path are strictly immutable. Allowed on archived realms (e.g. to document archive reason).
   */
  updateRealm(params: {
    actor: Actor;
    orgId: string;
    realmId: string;
    name?: string;
    scope?: string;
  }): Realm {
    const actor = validateActor(params.actor);
    if (actor.kind !== "human") {
      throw new MindError(
        "ACCESS_DENIED",
        `Only human actors can update realm metadata (actor "${actor.id}" is "${actor.kind}")`,
        {
          try: 'meru-mind realm set <realm> --scope "<scope>" --as-human',
        },
      );
    }
    if (params.name === undefined && params.scope === undefined) {
      throw new MindError(
        "INVALID_INPUT",
        "At least one of --name or --scope must be provided to update a realm",
        {
          try: 'meru-mind realm set <realm> --scope "<scope>" --as-human',
        },
      );
    }
    const nextName =
      params.name !== undefined ? params.name.trim() : undefined;
    if (nextName !== undefined && !nextName) {
      throw new MindError("INVALID_INPUT", "Realm name cannot be empty");
    }
    const nextScope =
      params.scope !== undefined ? normalizeRealmScope(params.scope) : undefined;

    return this.db.transaction(() => {
      const existing = this.db.getRealm(params.realmId);
      if (!existing || existing.orgId !== params.orgId) {
        throw new MindError("NOT_FOUND", `Realm not found: ${params.realmId}`);
      }
      this.db.updateRealmMetadata(existing.id, {
        ...(nextName !== undefined ? { name: nextName } : {}),
        ...(nextScope !== undefined ? { scope: nextScope } : {}),
      });
      const now = new Date().toISOString();
      this.db.appendChangeLog({
        orgId: existing.orgId,
        realmId: existing.id,
        entityType: "realm",
        entityId: existing.id,
        op: "update_realm",
        actorId: actor.id,
        createdAt: now,
      });
      return this.db.getRealm(existing.id)!;
    });
  }

  /**
   * Org-admin human-only realm archive (idempotent).
   * Freezes writes on this realm and all descendants (computed at read/write time);
   * root "/" and open-mode "/inbox" cannot be archived.
   */
  archiveRealm(params: {
    actor: Actor;
    orgId: string;
    realmId: string;
  }): RealmArchiveResult {
    const actor = validateActor(params.actor);
    if (actor.kind !== "human") {
      throw new MindError(
        "ACCESS_DENIED",
        `Only human actors can archive realms (actor "${actor.id}" is "${actor.kind}")`,
        {
          try: "meru-mind realm archive <realm> --as-human",
        },
      );
    }

    return this.db.transaction(() => {
      const org = this.db.getOrg(params.orgId);
      if (!org) {
        throw new MindError("NOT_FOUND", `Organization not found: ${params.orgId}`);
      }
      const existing = this.db.getRealm(params.realmId);
      if (!existing || existing.orgId !== params.orgId) {
        throw new MindError("NOT_FOUND", `Realm not found: ${params.realmId}`);
      }
      if (existing.path === "/") {
        throw new MindError("INVALID_INPUT", 'Root realm "/" cannot be archived');
      }
      if (org.policy === "open" && existing.path === "/inbox") {
        throw new MindError(
          "INVALID_INPUT",
          'Inbox realm "/inbox" cannot be archived in an open policy organization',
        );
      }
      if (existing.archivedAt !== null) {
        return {
          realm: existing,
          alreadyArchived: true,
          effectivelyArchived: true,
        };
      }
      const now = new Date().toISOString();
      this.db.setRealmArchivedAt(existing.id, now);
      this.db.appendChangeLog({
        orgId: existing.orgId,
        realmId: existing.id,
        entityType: "realm",
        entityId: existing.id,
        op: "archive_realm",
        actorId: actor.id,
        createdAt: now,
      });
      const updated = this.db.getRealm(existing.id)!;
      return {
        realm: updated,
        alreadyArchived: false,
        effectivelyArchived: true,
      };
    });
  }

  /**
   * Org-admin human-only realm unarchive (idempotent).
   * If an ancestor realm is still archived, clears this realm's own archivedAt and reports
   * `effectivelyArchived: true` plus `archivedAncestorPath`.
   */
  unarchiveRealm(params: {
    actor: Actor;
    orgId: string;
    realmId: string;
  }): RealmUnarchiveResult {
    const actor = validateActor(params.actor);
    if (actor.kind !== "human") {
      throw new MindError(
        "ACCESS_DENIED",
        `Only human actors can unarchive realms (actor "${actor.id}" is "${actor.kind}")`,
        {
          try: "meru-mind realm unarchive <realm> --as-human",
        },
      );
    }

    return this.db.transaction(() => {
      const existing = this.db.getRealm(params.realmId);
      if (!existing || existing.orgId !== params.orgId) {
        throw new MindError("NOT_FOUND", `Realm not found: ${params.realmId}`);
      }
      const alreadyActive = existing.archivedAt === null;
      if (!alreadyActive) {
        const now = new Date().toISOString();
        this.db.setRealmArchivedAt(existing.id, null);
        this.db.appendChangeLog({
          orgId: existing.orgId,
          realmId: existing.id,
          entityType: "realm",
          entityId: existing.id,
          op: "unarchive_realm",
          actorId: actor.id,
          createdAt: now,
        });
      }
      const updated = this.db.getRealm(existing.id)!;
      const orgRealms = this.db.listRealms(existing.orgId);
      const stillArchivedBy = findEffectiveArchivedRealm(orgRealms, updated.id);
      return {
        realm: updated,
        alreadyActive,
        effectivelyArchived: stillArchivedBy !== null,
        ...(stillArchivedBy ? { archivedAncestorPath: stillArchivedBy.path } : {}),
      };
    });
  }

  /**
   * Org-admin human-only in-place entry move across realms within one BEGIN IMMEDIATE transaction.
   * - Updates all 4 realm_id copies: records/seabed_entries, fts_docs, vec_items+vec_pending, idempotency_keys.
   * - Rejects effectively archived target realms (CONFLICT reason="realm_archived"), while allowing
   *   evacuation OUT of archived source realms into active realms.
   * - Rejects drive://-backed seabed artifacts (drive files remain bound to their realm).
   * - In `tree` mode, atomically expands to the full connected supersede component (enforcing same-realm invariant).
   * - In `open` mode, moves strictly the requested entry IDs (preserving legal cross-realm supersedes).
   * - Caps total moved entries per transaction at 500; appends dual `move_out` / `move_in` change_log rows.
   */
  moveEntries(params: {
    actor: Actor;
    orgId: string;
    entryIds: string[];
    targetRealmId: string;
    dryRun?: boolean;
  }): MoveEntriesResult {
    const MAX_MOVE_BATCH = 500;
    const actor = validateActor(params.actor);
    if (actor.kind !== "human") {
      throw new MindError(
        "ACCESS_DENIED",
        `Only human actors can move entries between realms (actor "${actor.id}" is "${actor.kind}")`,
        {
          try: "meru-mind entry move <entryId> --to <realm> --as-human",
        },
      );
    }
    const requestedIds = Array.from(
      new Set(params.entryIds.map((id) => id.trim()).filter(Boolean)),
    );
    if (requestedIds.length === 0) {
      throw new MindError(
        "INVALID_INPUT",
        "At least one entry ID (rec_... or sea_...) is required for entry move",
        { try: "meru-mind entry move <entryId> --to <realm> --as-human" },
      );
    }
    if (requestedIds.length > MAX_MOVE_BATCH) {
      throw new MindError(
        "INVALID_INPUT",
        `entry move batch size (${requestedIds.length}) exceeds maximum of ${MAX_MOVE_BATCH}`,
      );
    }

    return this.db.transaction(() => {
      const org = this.db.getOrg(params.orgId);
      if (!org) {
        throw new MindError("NOT_FOUND", `Organization not found: ${params.orgId}`);
      }
      const orgRealms = this.db.listRealms(org.id);
      const realmsById = new Map(orgRealms.map((r) => [r.id, r]));
      const targetRealm = realmsById.get(params.targetRealmId);
      if (!targetRealm) {
        throw new MindError(
          "NOT_FOUND",
          `Target realm not found in org "${org.id}": ${params.targetRealmId}`,
        );
      }
      const archivedTarget = findEffectiveArchivedRealm(
        orgRealms,
        targetRealm.id,
      );
      if (archivedTarget) {
        throw new MindError(
          "CONFLICT",
          `Target realm "${archivedTarget.path}" is archived and frozen for writes.`,
          {
            reason: "realm_archived",
            targetRealmId: targetRealm.id,
            archivedRealmId: archivedTarget.id,
            try: `meru-mind realm unarchive ${archivedTarget.path} --as-human`,
          },
        );
      }

      // Resolve requested entries & expand connected supersede component in tree mode
      interface PlannedMove {
        id: string;
        entityType: "record" | "seabed";
        fromRealmId: string;
        chainExpanded: boolean;
      }
      const plannedById = new Map<string, PlannedMove>();
      const queue: Array<{ id: string; chainExpanded: boolean }> =
        requestedIds.map((id) => ({ id, chainExpanded: false }));

      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (plannedById.has(cur.id)) continue;

        const rec = this.db.getRecord(cur.id);
        if (rec) {
          if (rec.orgId !== org.id) {
            throw new MindError(
              "NOT_FOUND",
              `Entry not found in organization "${org.id}": ${cur.id}`,
            );
          }
          plannedById.set(rec.id, {
            id: rec.id,
            entityType: "record",
            fromRealmId: rec.realmId,
            chainExpanded: cur.chainExpanded,
          });
          if (plannedById.size > MAX_MOVE_BATCH) {
            throw new MindError(
              "INVALID_INPUT",
              `Expanded supersede chain exceeds maximum batch size of ${MAX_MOVE_BATCH} entries`,
            );
          }
          if (org.policy === "tree") {
            const neighbors = this.db.listRecordSupersedeNeighborIds(
              org.id,
              rec.id,
            );
            for (const nid of neighbors) {
              if (!plannedById.has(nid)) {
                queue.push({ id: nid, chainExpanded: true });
              }
            }
          }
          continue;
        }

        const sea = this.db.getSeabedEntry(cur.id);
        if (sea) {
          if (sea.orgId !== org.id) {
            throw new MindError(
              "NOT_FOUND",
              `Entry not found in organization "${org.id}": ${cur.id}`,
            );
          }
          if (sea.sourceRef && parseDriveSourceRef(sea.sourceRef)) {
            throw new MindError(
              "INVALID_INPUT",
              `Cannot move drive-backed seabed entry "${sea.id}" (${sea.sourceRef}): drive files remain bound to their realm.`,
            );
          }
          plannedById.set(sea.id, {
            id: sea.id,
            entityType: "seabed",
            fromRealmId: sea.realmId,
            chainExpanded: false,
          });
          if (plannedById.size > MAX_MOVE_BATCH) {
            throw new MindError(
              "INVALID_INPUT",
              `entry move batch exceeds maximum of ${MAX_MOVE_BATCH} entries`,
            );
          }
          continue;
        }

        throw new MindError(
          "NOT_FOUND",
          `Entry not found in organization "${org.id}": ${cur.id}`,
        );
      }

      const moved: MovedEntryItem[] = [];
      const skippedAlreadyInTargetIds: string[] = [];
      const now = new Date().toISOString();
      const dryRun = Boolean(params.dryRun);

      for (const item of plannedById.values()) {
        if (item.fromRealmId === targetRealm.id) {
          skippedAlreadyInTargetIds.push(item.id);
          continue;
        }
        const fromRealmPath =
          realmsById.get(item.fromRealmId)?.path ?? item.fromRealmId;
        if (!dryRun) {
          this.db.moveEntryRealm({
            orgId: org.id,
            targetTable:
              item.entityType === "record" ? "records" : "seabed_entries",
            entryId: item.id,
            newRealmId: targetRealm.id,
          });
          this.db.appendChangeLog({
            orgId: org.id,
            realmId: item.fromRealmId,
            entityType: item.entityType,
            entityId: item.id,
            op: "move_out",
            actorId: actor.id,
            createdAt: now,
          });
          this.db.appendChangeLog({
            orgId: org.id,
            realmId: targetRealm.id,
            entityType: item.entityType,
            entityId: item.id,
            op: "move_in",
            actorId: actor.id,
            createdAt: now,
          });
        }
        moved.push({
          id: item.id,
          entityType: item.entityType,
          fromRealmId: item.fromRealmId,
          fromRealmPath,
          toRealmId: targetRealm.id,
          toRealmPath: targetRealm.path,
          ...(item.chainExpanded ? { chainExpanded: true } : {}),
        });
      }

      return {
        targetRealmId: targetRealm.id,
        targetRealmPath: targetRealm.path,
        dryRun,
        moved,
        skippedAlreadyInTargetIds,
      };
    });
  }

  getRealm(id: string): Realm | null {
    return this.db.getRealm(id);
  }

  listRealms(params: {
    orgId: string;
    viewerRealmId?: string;
    scopeCeiling?: AccessScope;
  }): Realm[] {
    const orgId = params?.orgId?.trim();
    if (!orgId) {
      throw new MindError("INVALID_INPUT", "orgId is required for listRealms");
    }
    const org = this.db.getOrg(orgId);
    if (!org) {
      throw new MindError("NOT_FOUND", `Organization not found: ${orgId}`);
    }
    if (params.scopeCeiling && params.scopeCeiling.orgId !== org.id) {
      throw new MindError(
        "ACCESS_DENIED",
        `Organization "${orgId}" is outside bound scope`,
      );
    }

    const orgRealms = this.db.listRealms(org.id);
    if (org.policy === "tree") {
      const viewerRealmId = params.viewerRealmId?.trim();
      if (!viewerRealmId) {
        throw new MindError(
          "INVALID_INPUT",
          `viewerRealmId is required for listRealms in 'tree' policy organization "${org.id}"`,
        );
      }
      const mounts = this.db.listMounts();
      const baseScope = resolveAccessScope({
        realms: orgRealms,
        mounts,
        viewerRealmId,
        orgPolicy: "tree",
        includeDescendantSeabed: false,
      });
      const effective = params.scopeCeiling
        ? intersectAccessScopes(baseScope, params.scopeCeiling)
        : baseScope;
      const sanitizedMap = sanitizeRealmsForScope(orgRealms, effective);
      return orgRealms
        .filter((r) => sanitizedMap.has(r.id))
        .map((r) => sanitizedMap.get(r.id)!);
    }

    if (params.scopeCeiling) {
      const sanitizedMap = sanitizeRealmsForScope(orgRealms, params.scopeCeiling);
      return orgRealms
        .filter((r) => sanitizedMap.has(r.id))
        .map((r) => sanitizedMap.get(r.id)!);
    }
    return orgRealms;
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
      throw new MindError(
        "INVALID_INPUT",
        `Invalid mount scope: "${String(scope)}"`,
      );
    }
    if (params.viewerRealmId === params.targetRealmId) {
      throw new MindError("INVALID_INPUT", "Cannot mount a realm onto itself");
    }

    return this.db.transaction(() => {
      const viewer = this.db.getRealm(params.viewerRealmId);
      const target = this.db.getRealm(params.targetRealmId);
      if (!viewer) {
        throw new MindError(
          "NOT_FOUND",
          `Viewer realm not found: ${params.viewerRealmId}`,
        );
      }
      if (!target) {
        throw new MindError(
          "NOT_FOUND",
          `Target realm not found: ${params.targetRealmId}`,
        );
      }
      if (viewer.orgId !== target.orgId) {
        throw new MindError(
          "ACCESS_DENIED",
          "Cross-organization realm mounts are forbidden",
        );
      }

      if (actor.kind !== "human") {
        throw new MindError(
          "ACCESS_DENIED",
          `Only human actors can mount realms (actor "${actor.id}" is "${actor.kind}")`,
          {
            try: "meru-mind realm mount --viewer <realm> --target <realm> --as-human",
          },
        );
      }

      const now = new Date().toISOString();
      const mount: RealmMount = {
        id: makeId("mnt"),
        viewerRealmId: viewer.id,
        targetRealmId: target.id,
        scope,
        mountedBy: actor.id,
        createdAt: now,
      };
      this.db.insertMount(mount);
      this.db.appendChangeLog({
        orgId: viewer.orgId,
        realmId: viewer.id,
        entityType: "mount",
        entityId: mount.id,
        op: "mount_realm",
        actorId: actor.id,
        createdAt: now,
      });
      return mount;
    });
  }

  unmountRealm(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId: string;
  }): boolean {
    const actor = validateActor(params.actor);
    return this.db.transaction(() => {
      const viewer = this.db.getRealm(params.viewerRealmId);
      if (!viewer) {
        throw new MindError(
          "NOT_FOUND",
          `Viewer realm not found: ${params.viewerRealmId}`,
        );
      }
      if (actor.kind !== "human") {
        throw new MindError(
          "ACCESS_DENIED",
          `Only human actors can unmount realms (actor "${actor.id}" is "${actor.kind}")`,
          {
            try: "meru-mind realm unmount --viewer <realm> --target <realm> --as-human",
          },
        );
      }
      const target = this.db.getRealm(params.targetRealmId);
      if (target && target.orgId !== viewer.orgId) {
        throw new MindError(
          "ACCESS_DENIED",
          "Cross-organization realm unmounts are forbidden",
        );
      }
      const removed = this.db.deleteMount(viewer.id, params.targetRealmId);
      if (removed) {
        this.db.appendChangeLog({
          orgId: viewer.orgId,
          realmId: viewer.id,
          entityType: "mount",
          entityId: `${viewer.id}->${params.targetRealmId}`,
          op: "unmount_realm",
          actorId: actor.id,
          createdAt: new Date().toISOString(),
        });
      }
      return removed;
    });
  }

  listMounts(params: {
    orgId: string;
    viewerRealmId?: string;
    scopeCeiling?: AccessScope;
  }): RealmMount[] {
    const visibleRealms = this.listRealms(params);
    const visibleIds = new Set(visibleRealms.map((r) => r.id));
    const allMounts = this.db.listMounts();
    return allMounts.filter(
      (m) => visibleIds.has(m.viewerRealmId) && visibleIds.has(m.targetRealmId),
    );
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
    objectIds?: string[];
    resourceTags?: string[];
    occurredAt?: string | null;
    originSessionId?: string | null;
    sensitivity?: Sensitivity;
    idempotencyKey?: string;
    /** Explicit human-only override to allow writing content matching redacted_blocklist */
    allowRedactedReingest?: boolean;
  }): Promise<SeabedEntry> {
    const actor = validateActor(params.actor);
    if (!VALID_SEABED_KINDS.has(params.kind)) {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid seabed kind: "${String(params.kind)}"`,
      );
    }
    const sensitivity = validateSensitivity(params.sensitivity);
    const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKey);
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;

    const text = params.text.trim();
    if (!text && !params.blobContent) {
      throw new MindError(
        "INVALID_INPUT",
        "Seabed entry requires non-empty text or blobContent",
      );
    }

    const metadata = params.metadata ?? {};
    const objectIds = Array.from(
      new Set((params.objectIds ?? []).map((s) => s.trim()).filter(Boolean)),
    ).sort();
    const resourceTags = Array.from(
      new Set((params.resourceTags ?? []).map((t) => normalizeResourceTag(t))),
    ).sort();
    const pendingBlobSha256 =
      params.blobContent !== undefined
        ? sha256Bytes(params.blobContent)
        : null;
    const hasExplicitNullOccurredAt = params.occurredAt === null;
    const explicitOccurredAt =
      typeof params.occurredAt === "string"
        ? params.occurredAt.trim() || null
        : null;

    const payloadHash = idempotencyKey
      ? computePayloadHash({
          targetTable: "seabed_entries",
          targetRealmId,
          kind: params.kind,
          topicId: params.topicId ?? null,
          text,
          blobSha256: pendingBlobSha256,
          sourceRef: params.sourceRef ?? null,
          metadata,
          ...(objectIds.length > 0 ? { objectIds } : {}),
          ...(resourceTags.length > 0 ? { resourceTags } : {}),
          occurredAt: explicitOccurredAt,
          originSessionId: params.originSessionId ?? null,
          sensitivity,
        })
      : "";

    return this.db.transaction(() => {
      const realms = this.db.listRealms();
      const mounts = this.db.listMounts();
      const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
      const orgPolicy = this.getOrgPolicy(viewerRealm?.orgId);

      // 1. Idempotency check at the very start of BEGIN IMMEDIATE
      if (idempotencyKey && viewerRealm) {
        const existingKey = this.db.getIdempotencyKey(
          viewerRealm.orgId,
          idempotencyKey,
        );
        if (existingKey) {
          const existingAccess =
            existingKey.targetTable === "seabed_entries"
              ? resolveAccess({
                  realms,
                  mounts,
                  actor,
                  viewerRealmId: params.viewerRealmId,
                  targetRealmId: existingKey.realmId,
                  assetKind: "seabed",
                  explicitDescendantDive: false,
                  orgPolicy,
                })
              : (() => {
                  const rec = this.db.getRecord(existingKey.targetId);
                  return resolveAccess({
                    realms,
                    mounts,
                    actor,
                    viewerRealmId: params.viewerRealmId,
                    targetRealmId: existingKey.realmId,
                    assetKind: rec?.kind === "rule" ? "rule" : "ledger",
                    orgPolicy,
                  });
                })();

          if (existingAccess === "none") {
            throw new MindError(
              "NOT_FOUND",
              "Entry not found in visible scope",
            );
          }
          if (
            existingKey.targetTable !== "seabed_entries" ||
            existingKey.payloadHash !== payloadHash
          ) {
            throw new MindError(
              "IDEMPOTENCY_MISMATCH",
              `Idempotency key "${idempotencyKey}" already exists with a different payload`,
            );
          }
          const existingEntry = this.db.getSeabedEntry(existingKey.targetId);
          if (!existingEntry) {
            throw new MindError(
              "NOT_FOUND",
              "Entry not found in visible scope",
            );
          }
          return existingEntry;
        }
      }

      assertAccess({
        realms,
        mounts,
        actor,
        viewerRealmId: params.viewerRealmId,
        targetRealmId,
        assetKind: "seabed",
        required: "write",
        orgPolicy,
      });

      const targetRealm = realms.find((r) => r.id === targetRealmId)!;

      // Global content-hash redaction blocklist check across org regardless of source_ref
      const allowRedacted =
        params.allowRedactedReingest === true && actor.kind === "human";
      if (!allowRedacted) {
        const textSha = text ? computeSeabedContentSha256(text) : null;
        const metaSha =
          typeof metadata.contentSha256 === "string" &&
          metadata.contentSha256.trim()
            ? metadata.contentSha256.trim()
            : null;
        if (
          (textSha !== null &&
            this.db.isContentShaBlocked(targetRealm.orgId, textSha)) ||
          (pendingBlobSha256 !== null &&
            this.db.isContentShaBlocked(targetRealm.orgId, pendingBlobSha256)) ||
          (metaSha !== null &&
            this.db.isContentShaBlocked(targetRealm.orgId, metaSha))
        ) {
          throw new MindError("ACCESS_DENIED", REDACTED_CONTENT_BLOCKED_MSG, {
            reason: "redacted_blocklist",
            try: REDACTED_CONTENT_TRY_HINT,
          });
        }
      }

      if (objectIds.length > 0) {
        const callerScope = resolveAccessScope({
          realms,
          mounts,
          viewerRealmId: params.viewerRealmId,
          orgPolicy,
          includeDescendantSeabed: false,
        });
        const readableSet = new Set(callerScope.readableLedgerIds);
        for (const objId of objectIds) {
          const obj = this.db.getObject(objId);
          if (
            !obj ||
            obj.orgId !== targetRealm.orgId ||
            !readableSet.has(obj.realmId)
          ) {
            throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
          }
        }
      }

      let blobSha256: string | null = null;
      if (params.blobContent !== undefined) {
        blobSha256 = this.blobs.put(params.blobContent).sha256;
      }

      const now = new Date().toISOString();
      const entry: SeabedEntry = {
        id: makeId("sea"),
        orgId: targetRealm.orgId,
        realmId: targetRealmId,
        topicId: params.topicId ?? null,
        kind: params.kind,
        authorId: actor.id,
        authorKind: actor.kind,
        authorFamily: actor.family ?? null,
        text,
        blobSha256,
        sourceRef: params.sourceRef ?? null,
        metadata,
        occurredAt: hasExplicitNullOccurredAt
          ? null
          : (explicitOccurredAt ?? now),
        originSessionId: params.originSessionId ?? null,
        sensitivity,
        redactedAt: null,
        redactedBy: null,
        redactedReason: null,
        createdAt: now,
      };

      this.db.insertSeabedEntry(entry);

      for (const objId of objectIds) {
        this.db.insertEntryObject({
          entryId: entry.id,
          orgId: entry.orgId,
          objectId: objId,
        });
      }
      for (const tag of resourceTags) {
        this.db.insertResourceTag({
          entryId: entry.id,
          orgId: entry.orgId,
          tag,
        });
      }

      if (idempotencyKey) {
        this.db.insertIdempotencyKey({
          orgId: targetRealm.orgId,
          key: idempotencyKey,
          targetTable: "seabed_entries",
          targetId: entry.id,
          realmId: entry.realmId,
          payloadHash,
          createdAt: now,
        });
      }

      this.upsertFtsSync({
        itemId: entry.id,
        sourceType: "seabed",
        orgId: entry.orgId,
        realmId: entry.realmId,
        status: "evidence",
        kind: entry.kind,
        occurredAt: entry.occurredAt,
        title: `${entry.kind}:${entry.topicId ?? entry.realmId}`,
        body: entry.text,
        sensitivity: entry.sensitivity,
        queuedAt: now,
      });

      this.db.appendChangeLog({
        orgId: entry.orgId,
        realmId: entry.realmId,
        entityType: "seabed",
        entityId: entry.id,
        op: "create",
        actorId: actor.id,
        createdAt: now,
      });

      return entry;
    });
  }

  // ---- Ledger Records (Truth Source 2) ----

  async appendRecord(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId?: string;
    thingId?: string | null;
    kind: RecordKind;
    extKind?: string | null;
    title: string;
    payload?: Record<string, unknown>;
    refs?: string[];
    externalRef?: string | null;
    sourceRef?: string | null;
    objectIds?: string[];
    resourceTags?: string[];
    supersedesId?: string | null;
    supersedesIds?: string[];
    initialStatus?: "active" | "superseded";
    occurredAt?: string | null;
    originSessionId?: string | null;
    sensitivity?: Sensitivity;
    idempotencyKey?: string;
    /** Explicit human-only override to allow writing content matching redacted_blocklist */
    allowRedactedReingest?: boolean;
  }): Promise<LedgerRecord> {
    const actor = validateActor(params.actor);
    if (!VALID_RECORD_KINDS.has(params.kind)) {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid record kind: "${String(params.kind)}"`,
      );
    }
    const initialStatus = params.initialStatus ?? "active";
    if (initialStatus !== "active" && initialStatus !== "superseded") {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid initialStatus "${String(initialStatus)}": only "active" or "superseded" is allowed ("retracted" is reserved for redact())`,
      );
    }
    const sensitivity = validateSensitivity(params.sensitivity);
    const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKey);
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;

    const title = params.title.trim();
    if (!title) {
      throw new MindError("INVALID_INPUT", "Record title cannot be empty");
    }

    const extKind = params.extKind?.trim() || null;
    const payload = params.payload ?? {};
    const refs = Array.from(new Set(params.refs ?? []));
    const objectIds = Array.from(
      new Set((params.objectIds ?? []).map((s) => s.trim()).filter(Boolean)),
    ).sort();
    const resourceTags = Array.from(
      new Set((params.resourceTags ?? []).map((t) => normalizeResourceTag(t))),
    ).sort();
    const externalRef =
      params.externalRef?.trim() ||
      (typeof payload.externalRef === "string" && payload.externalRef.trim()
        ? payload.externalRef.trim()
        : null);
    const sourceRef =
      params.sourceRef?.trim() ||
      (typeof payload.sourceRef === "string" && payload.sourceRef.trim()
        ? payload.sourceRef.trim()
        : null);
    const supersedesList = Array.from(
      new Set(
        [
          ...(params.supersedesIds ?? []),
          ...(params.supersedesId ? [params.supersedesId] : []),
        ]
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    );
    const hasExplicitNullOccurredAt = params.occurredAt === null;
    const explicitOccurredAt =
      typeof params.occurredAt === "string"
        ? params.occurredAt.trim() || null
        : null;

    const payloadHash = idempotencyKey
      ? computePayloadHash({
          targetTable: "records",
          targetRealmId,
          thingId: params.thingId ?? null,
          kind: params.kind,
          extKind,
          title,
          payload,
          refs,
          ...(externalRef ? { externalRef } : {}),
          ...(sourceRef ? { sourceRef } : {}),
          ...(objectIds.length > 0 ? { objectIds } : {}),
          ...(resourceTags.length > 0 ? { resourceTags } : {}),
          supersedesId: supersedesList[0] ?? null,
          ...(supersedesList.length > 1 ? { supersedesIds: supersedesList } : {}),
          ...(initialStatus !== "active" ? { initialStatus } : {}),
          occurredAt: explicitOccurredAt,
          originSessionId: params.originSessionId ?? null,
          sensitivity,
        })
      : "";

    return this.db.transaction(() => {
      const realms = this.db.listRealms();
      const mounts = this.db.listMounts();
      const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
      const orgPolicy = this.getOrgPolicy(viewerRealm?.orgId);

      // 1. Idempotency check at the very start of BEGIN IMMEDIATE
      if (idempotencyKey && viewerRealm) {
        const existingKey = this.db.getIdempotencyKey(
          viewerRealm.orgId,
          idempotencyKey,
        );
        if (existingKey) {
          const existingAccess =
            existingKey.targetTable === "seabed_entries"
              ? resolveAccess({
                  realms,
                  mounts,
                  actor,
                  viewerRealmId: params.viewerRealmId,
                  targetRealmId: existingKey.realmId,
                  assetKind: "seabed",
                  explicitDescendantDive: false,
                  orgPolicy,
                })
              : (() => {
                  const rec = this.db.getRecord(existingKey.targetId);
                  return resolveAccess({
                    realms,
                    mounts,
                    actor,
                    viewerRealmId: params.viewerRealmId,
                    targetRealmId: existingKey.realmId,
                    assetKind: rec?.kind === "rule" ? "rule" : "ledger",
                    orgPolicy,
                  });
                })();

          if (existingAccess === "none") {
            throw new MindError(
              "NOT_FOUND",
              "Entry not found in visible scope",
            );
          }
          if (
            existingKey.targetTable !== "records" ||
            existingKey.payloadHash !== payloadHash
          ) {
            throw new MindError(
              "IDEMPOTENCY_MISMATCH",
              `Idempotency key "${idempotencyKey}" already exists with a different payload`,
            );
          }
          const existingRecord = this.db.getRecord(existingKey.targetId);
          if (!existingRecord) {
            throw new MindError(
              "NOT_FOUND",
              "Entry not found in visible scope",
            );
          }
          return existingRecord;
        }
      }

      // 2. Access control & all validations inside BEGIN IMMEDIATE (zero TOCTOU)
      assertAccess({
        realms,
        mounts,
        actor,
        viewerRealmId: params.viewerRealmId,
        targetRealmId,
        assetKind: params.kind === "rule" ? "rule" : "ledger",
        required: "write",
        orgPolicy,
      });

      const targetRealm = realms.find((r) => r.id === targetRealmId)!;

      // Global content-hash redaction blocklist check across org regardless of source_ref
      const allowRedacted =
        params.allowRedactedReingest === true && actor.kind === "human";
      if (!allowRedacted) {
        const recordSha = computeRecordContentSha256(title, payload);
        const payloadContentSha =
          typeof payload.contentSha256 === "string" &&
          payload.contentSha256.trim()
            ? payload.contentSha256.trim()
            : null;
        if (
          this.db.isContentShaBlocked(targetRealm.orgId, recordSha) ||
          (payloadContentSha !== null &&
            this.db.isContentShaBlocked(targetRealm.orgId, payloadContentSha))
        ) {
          throw new MindError("ACCESS_DENIED", REDACTED_CONTENT_BLOCKED_MSG, {
            reason: "redacted_blocklist",
            try: REDACTED_CONTENT_TRY_HINT,
          });
        }
      }

      if (objectIds.length > 0) {
        const callerScope = resolveAccessScope({
          realms,
          mounts,
          viewerRealmId: params.viewerRealmId,
          orgPolicy,
          includeDescendantSeabed: false,
        });
        const readableSet = new Set(callerScope.readableLedgerIds);
        for (const objId of objectIds) {
          const obj = this.db.getObject(objId);
          if (
            !obj ||
            obj.orgId !== targetRealm.orgId ||
            !readableSet.has(obj.realmId)
          ) {
            throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
          }
        }
      }

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
          orgPolicy,
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
          orgPolicy,
        });
        return access === "none" ? null : sea;
      };

      // Opaque existence & visibility check: nonexistent and hidden-sibling IDs produce
      // the exact same error code and message (zero blind-ID oracle).
      for (const refId of refs) {
        const rec = resolveVisibleRecord(refId);
        if (rec) {
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

      // 3. Validate all predecessors inside BEGIN IMMEDIATE (all-or-nothing multi-predecessor DAG CAS)
      // - open mode: allows same-org cross-realm supersedes (prevents dual-active heads across realms)
      // - tree mode: enforces strict same-realm supersedes
      const oldRecords: LedgerRecord[] = [];
      for (const supId of supersedesList) {
        const oldRec = this.db.getRecord(supId);
        const allowedSupersedeTarget =
          oldRec &&
          (orgPolicy === "open"
            ? oldRec.orgId === targetRealm.orgId
            : oldRec.realmId === targetRealmId);
        if (!oldRec || !allowedSupersedeTarget) {
          throw new MindError(
            "NOT_FOUND",
            `Entry not found in visible scope: ${supId}`,
          );
        }
        if (oldRec.kind !== params.kind) {
          throw new MindError(
            "INVALID_INPUT",
            `Superseding record kind "${params.kind}" must match superseded record kind "${oldRec.kind}"`,
          );
        }
        if (oldRec.status !== "active" || oldRec.supersededById !== null) {
          throw new MindError(
            "CONFLICT",
            `Record "${oldRec.id}" is already ${oldRec.status} (supersededBy=${oldRec.supersededById ?? "none"})`,
          );
        }
        oldRecords.push(oldRec);
      }

      const id = makeId("rec");
      const thingId =
        params.kind === "thing"
          ? (params.thingId ?? id)
          : (params.thingId ?? null);
      const now = new Date().toISOString();

      const record: LedgerRecord = {
        id,
        orgId: targetRealm.orgId,
        realmId: targetRealmId,
        thingId,
        kind: params.kind,
        extKind,
        status: initialStatus,
        supersedesId: oldRecords[0]?.id ?? null,
        supersedesIds: oldRecords.map((r) => r.id),
        supersededById: null,
        authorId: actor.id,
        authorKind: actor.kind,
        authorFamily: actor.family ?? null,
        confirmedByHuman: actor.kind === "human",
        title,
        payload,
        refs,
        externalRef,
        sourceRef,
        occurredAt: hasExplicitNullOccurredAt
          ? null
          : (explicitOccurredAt ?? now),
        originSessionId: params.originSessionId ?? null,
        sensitivity,
        redactedAt: null,
        redactedBy: null,
        redactedReason: null,
        createdAt: now,
      };

      this.db.insertRecord(record);

      for (const objId of objectIds) {
        this.db.insertEntryObject({
          entryId: record.id,
          orgId: record.orgId,
          objectId: objId,
        });
      }
      for (const tag of resourceTags) {
        this.db.insertResourceTag({
          entryId: record.id,
          orgId: record.orgId,
          tag,
        });
      }

      // 4. Atomic CAS on every superseded predecessor (assert changes === 1 with org_id guard, else rollback entire txn)
      for (const oldRec of oldRecords) {
        const casOk = this.db.markRecordSuperseded(
          oldRec.id,
          record.id,
          targetRealm.orgId,
        );
        if (!casOk) {
          throw new MindError(
            "CONFLICT",
            `Concurrent supersede conflict on record "${oldRec.id}"`,
          );
        }
        this.db.updateFtsStatus(oldRec.id, "superseded");
        this.db.updateVectorStatus(oldRec.id, "superseded");
      }

      if (idempotencyKey) {
        this.db.insertIdempotencyKey({
          orgId: targetRealm.orgId,
          key: idempotencyKey,
          targetTable: "records",
          targetId: record.id,
          realmId: record.realmId,
          payloadHash,
          createdAt: now,
        });
      }

      const payloadText = buildRecordFtsBody(record.payload);

      // 5. Synchronous FTS5 + vec_pending + change_log in the same transaction (zero sync embed())
      this.upsertFtsSync({
        itemId: record.id,
        sourceType: "record",
        orgId: record.orgId,
        realmId: record.realmId,
        status: record.status,
        kind: record.kind,
        occurredAt: record.occurredAt,
        title: record.title,
        body: payloadText,
        sensitivity: record.sensitivity,
        queuedAt: now,
      });

      this.db.appendChangeLog({
        orgId: record.orgId,
        realmId: record.realmId,
        entityType: "record",
        entityId: record.id,
        op: oldRecords.length > 0 ? "supersede" : "create",
        actorId: actor.id,
        createdAt: now,
      });

      return record;
    });
  }

  // ---- Identity Anchors (Reusing records.kind = 'thing' + external_ref, no separate things table) ----

  async createThing(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId?: string;
    title: string;
    externalRef?: string | null;
    payload?: Record<string, unknown>;
    refs?: string[];
    objectIds?: string[];
    resourceTags?: string[];
    occurredAt?: string | null;
    originSessionId?: string | null;
    sensitivity?: Sensitivity;
    idempotencyKey?: string;
    dedupeByExternalRef?: boolean;
  }): Promise<LedgerRecord> {
    const extRef = params.externalRef?.trim() || null;
    if (params.dedupeByExternalRef && extRef) {
      const existing = this.findThingByExternalRef({
        actor: params.actor,
        viewerRealmId: params.viewerRealmId,
        externalRef: extRef,
      });
      if (existing) {
        return existing;
      }
    }
    return this.appendRecord({
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      targetRealmId: params.targetRealmId,
      kind: "thing",
      title: params.title,
      externalRef: extRef,
      payload: params.payload,
      refs: params.refs,
      objectIds: params.objectIds,
      resourceTags: params.resourceTags,
      occurredAt: params.occurredAt,
      originSessionId: params.originSessionId,
      sensitivity: params.sensitivity,
      idempotencyKey: params.idempotencyKey,
    });
  }

  findThingByExternalRef(params: {
    actor: Actor;
    viewerRealmId: string;
    externalRef: string;
    scopeCeiling?: AccessScope;
  }): LedgerRecord | null {
    const actor = validateActor(params.actor);
    const extRef = params.externalRef.trim();
    if (!extRef) return null;

    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) return null;
    const orgPolicy = this.getOrgPolicy(viewerRealm.orgId);

    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed: false,
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    const vis = createVisibilityHelpers({
      db: this.db,
      realms,
      mounts,
      actor,
      viewerRealmId: viewerRealm.id,
      scope,
      includeDescendantSeabed: false,
    });

    const matches = this.db.findRecordsByExternalRef(
      viewerRealm.orgId,
      extRef,
      scope.readableLedgerIds,
      ["secret"],
    );
    const found = matches.find(
      (r) =>
        r.kind === "thing" &&
        r.sensitivity !== "secret" &&
        r.redactedAt === null &&
        vis.canSeeRecord(r),
    );
    return found ? vis.sanitizeRecord(found) : null;
  }

  listThings(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmRef?: string;
    externalRef?: string;
    includeSuperseded?: boolean;
    limit?: number;
    offset?: number;
    scopeCeiling?: AccessScope;
  }): { items: LedgerRecord[]; total: number } {
    const actor = validateActor(params.actor);
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError(
        "NOT_FOUND",
        `Realm not found: ${params.viewerRealmId}`,
      );
    }
    const orgPolicy = this.getOrgPolicy(viewerRealm.orgId);

    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed: false,
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    let realmIds = scope.readableLedgerIds;
    if (params.targetRealmRef) {
      const target = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: params.targetRealmRef,
        scope,
      });
      realmIds = scope.readableLedgerIds.includes(target.id) ? [target.id] : [];
    }

    const vis = createVisibilityHelpers({
      db: this.db,
      realms,
      mounts,
      actor,
      viewerRealmId: viewerRealm.id,
      scope,
      ledgerRealmIds: realmIds,
      includeDescendantSeabed: false,
    });

    const res = this.db.listRecords({
      realmIds,
      kinds: ["thing"],
      externalRef: params.externalRef?.trim() || undefined,
      includeSuperseded: Boolean(params.includeSuperseded),
      excludeSensitivities: ["secret"],
      limit: params.limit ?? 50,
      offset: params.offset ?? 0,
    });

    return {
      items: res.items
        .filter((r) => r.sensitivity !== "secret" && vis.canSeeRecord(r))
        .map((r) => vis.sanitizeRecord(r)),
      total: res.total,
    };
  }

  getSupersedeChain(params: {
    actor: Actor;
    viewerRealmId: string;
    recordId: string;
    scopeCeiling?: AccessScope;
  }): SupersedeChainResult {
    const actor = validateActor(params.actor);
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    const orgPolicy = this.getOrgPolicy(viewerRealm?.orgId);
    if (!viewerRealm) {
      throw new MindError(
        "NOT_FOUND",
        `Entry not found in visible scope: ${params.recordId}`,
      );
    }

    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: params.viewerRealmId,
      orgPolicy,
      includeDescendantSeabed: false,
    });
    const effectiveScope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    const vis = createVisibilityHelpers({
      db: this.db,
      realms,
      mounts,
      actor,
      viewerRealmId: params.viewerRealmId,
      scope: effectiveScope,
      includeDescendantSeabed: false,
    });

    const start = this.db.getRecord(params.recordId);
    if (!start || !vis.canSeeRecord(start)) {
      throw new MindError(
        "NOT_FOUND",
        `Entry not found in visible scope: ${params.recordId}`,
      );
    }

    return vis.traverseSupersedeDag(start);
  }

  // ---- Full-Chain Redact (Human-Only Withdrawal + Blob Refcount + FTS Optimize + WAL Checkpoint) ----

  redact(params: {
    actor: Actor;
    entryId: string;
    reason?: string;
    viewerRealmId?: string;
  }): RedactResult {
    const actor = validateActor(params.actor);
    if (actor.kind !== "human") {
      throw new MindError(
        "ACCESS_DENIED",
        `Only human actors can redact entries (actor "${actor.id}" is "${actor.kind}")`,
      );
    }
    const entryId = params.entryId?.trim();
    if (!entryId) {
      throw new MindError("INVALID_INPUT", "entryId is required for redact");
    }
    const reason = params.reason?.trim() || null;

    const txResult = this.db.transaction(() => {
      const rec = this.db.getRecord(entryId);
      const sea = rec ? null : this.db.getSeabedEntry(entryId);
      if (!rec && !sea) {
        throw new MindError("NOT_FOUND", `Entry not found: ${entryId}`);
      }

      const entityType: "record" | "seabed" = rec ? "record" : "seabed";
      const realmId = rec ? rec.realmId : sea!.realmId;
      const realm = this.db.getRealm(realmId);
      const orgId = (rec ? rec.orgId : sea!.orgId) || realm?.orgId || "";

      if (params.viewerRealmId) {
        const viewerRealm = this.db.getRealm(params.viewerRealmId);
        if (!viewerRealm || viewerRealm.orgId !== orgId) {
          throw new MindError("NOT_FOUND", `Entry not found: ${entryId}`);
        }
      }

      const now = new Date().toISOString();
      const residualLocations: string[] = [];
      let blobToDelete: string | null = null;

      // Compute canonical content hashes before wiping content
      let sourceRef: string;
      const contentHashes = new Set<string>();
      let blobSha256: string | null = null;

      if (rec) {
        sourceRef =
          rec.sourceRef?.trim() ||
          (typeof rec.payload.sourceRef === "string" &&
          rec.payload.sourceRef.trim()
            ? rec.payload.sourceRef.trim()
            : `record://${rec.id}`);
        contentHashes.add(computeRecordContentSha256(rec.title, rec.payload));
        if (
          typeof rec.payload.contentSha256 === "string" &&
          rec.payload.contentSha256.trim()
        ) {
          contentHashes.add(rec.payload.contentSha256.trim());
        }
        this.db.redactRecordRow({
          id: rec.id,
          redactedAt: now,
          redactedBy: actor.id,
          redactedReason: reason,
        });
      } else {
        const s = sea!;
        blobSha256 = s.blobSha256;
        sourceRef = s.sourceRef?.trim() || `seabed://${s.id}`;
        if (s.blobSha256) {
          contentHashes.add(s.blobSha256);
        }
        if (
          typeof s.metadata.contentSha256 === "string" &&
          s.metadata.contentSha256.trim()
        ) {
          contentHashes.add(s.metadata.contentSha256.trim());
        }
        if (s.text.trim()) {
          contentHashes.add(computeSeabedContentSha256(s.text));
        }
        this.db.redactSeabedRow({
          id: s.id,
          redactedAt: now,
          redactedBy: actor.id,
          redactedReason: reason,
        });
      }

      // Remove target from FTS5, sqlite-vec, vec_pending, entry_objects, resource_tags, and sanitize change_log suffixes
      this.db.deleteFtsItem(entryId);
      this.db.deleteVectorItem(entryId);
      this.db.deleteEntryObjectsByEntry(entryId);
      this.db.deleteResourceTagsByEntry(entryId);
      this.db.redactChangeLogForEntry(entryId);

      // Clear state_label & state_evidence_id on inactive objects citing this evidence record
      // (preserves state='inactive' and state_since; never resurrects to active)
      const clearedObjects = this.db.clearObjectStateEvidenceByEntry(entryId);
      const clearedObjectIds: string[] = [];
      for (const clearedObj of clearedObjects) {
        clearedObjectIds.push(clearedObj.id);
        this.db.appendChangeLog({
          orgId: clearedObj.orgId,
          realmId: clearedObj.realmId,
          entityType: "object",
          entityId: clearedObj.id,
          op: "object_evidence_redacted",
          actorId: actor.id,
          createdAt: now,
        });
      }

      // Cascade retraction to every distillation citing this entryId in source_ids
      const affectedDists = this.db.findDistillationsBySourceId(entryId);
      const retractedDistillationIds: string[] = [];
      for (const dist of affectedDists) {
        const cleanedHardFacts = stripIdFromHardFacts(
          dist.hardFacts,
          entryId,
        ) as Record<string, unknown>;
        this.db.redactDistillationRow({
          id: dist.id,
          hardFacts: cleanedHardFacts,
        });
        this.db.deleteFtsItem(dist.id);
        this.db.deleteVectorItem(dist.id);
        retractedDistillationIds.push(dist.id);
      }

      // Blob reference count check across seabed_entries and drive_files
      // (actual disk deletion happens AFTER transaction COMMIT so a rollback never orphans DB refs)
      const residualSet = new Set<string>();
      if (blobSha256) {
        const refs = this.db.countBlobReferences(blobSha256);
        for (const df of refs.driveFiles) {
          residualSet.add(`drive://${df.realmId}/${df.relPath}@v${df.version}`);
        }
        if (refs.seabedCount === 0 && refs.driveFiles.length === 0) {
          blobToDelete = blobSha256;
        }
      }

      // Also inspect sourceRef if it points to a live drive file
      const parsedDriveRef = parseDriveSourceRef(sourceRef);
      if (parsedDriveRef) {
        const df = this.db.getDriveFileMeta(
          parsedDriveRef.realmId,
          parsedDriveRef.relPath,
        );
        if (df) {
          residualSet.add(`drive://${df.realmId}/${df.relPath}@v${df.version}`);
        }
      }
      residualLocations.push(...Array.from(residualSet).sort());

      // Record exact (org_id, source_ref, content_sha256) entries in redacted_blocklist
      for (const contentSha256 of contentHashes) {
        this.db.insertRedactedBlocklist({
          orgId,
          sourceRef,
          contentSha256,
          reason,
          redactedAt: now,
        });
      }

      // Record redact op in change_log
      this.db.appendChangeLog({
        orgId,
        realmId,
        entityType,
        entityId: entryId,
        op: "redact",
        actorId: actor.id,
        createdAt: now,
      });

      return {
        entryId,
        entityType,
        orgId,
        realmId,
        redactedAt: now,
        redactedBy: actor.id,
        reason,
        retractedDistillationIds,
        clearedObjectIds,
        blobToDelete,
        blocklistRecorded: true,
        residualLocations,
      };
    });

    // Post-commit: unlink unreferenced blob from disk only after SQLite COMMIT succeeded
    let deletedBlobSha256: string | null = null;
    if (txResult.blobToDelete && this.blobs.delete(txResult.blobToDelete)) {
      deletedBlobSha256 = txResult.blobToDelete;
    }

    // Post-commit: optimize FTS5 b-trees and truncate WAL
    const walCheckpoint = this.db.optimizeFtsAndCheckpoint();

    const { blobToDelete: _ignored, ...publicResult } = txResult;
    return {
      ...publicResult,
      deletedBlobSha256,
      walCheckpoint,
    };
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
    /** Explicit human-only override to allow writing content matching redacted_blocklist */
    allowRedactedReingest?: boolean;
  }): Promise<{ meta: DriveFileMeta; commitId?: string; artifactId: string }> {
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    const orgPolicy = this.getOrgPolicy(viewerRealm?.orgId);

    assertAccess({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      targetRealmId,
      assetKind: "drive",
      required: "write",
      orgPolicy,
    });

    const targetRealm = realms.find((r) => r.id === targetRealmId)!;
    const allowRedacted =
      params.allowRedactedReingest === true && params.actor.kind === "human";
    if (!allowRedacted) {
      const fileSha = computeFileContentSha256(params.content);
      if (this.db.isContentShaBlocked(targetRealm.orgId, fileSha)) {
        throw new MindError("ACCESS_DENIED", REDACTED_CONTENT_BLOCKED_MSG, {
          reason: "redacted_blocklist",
          try: REDACTED_CONTENT_TRY_HINT,
        });
      }
    }

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
      allowRedactedReingest: params.allowRedactedReingest,
    });

    return { meta, commitId: res.commitId, artifactId: artifact.id };
  }

  async readDriveFile(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId?: string;
    relPath: string;
    scopeCeiling?: AccessScope;
  }): Promise<DriveFileContent | null> {
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    const orgPolicy = this.getOrgPolicy(viewerRealm?.orgId);

    assertAccess({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      targetRealmId,
      assetKind: "drive",
      required: "read",
      orgPolicy,
    });

    if (
      params.scopeCeiling &&
      !params.scopeCeiling.readableDriveIds.includes(targetRealmId)
    ) {
      throw new MindError(
        "ACCESS_DENIED",
        `Read access denied for drive in realm "${targetRealmId}" outside bound scope.`,
      );
    }

    return this.drive.readFile(targetRealmId, params.relPath);
  }

  async listDriveFiles(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId?: string;
    scopeCeiling?: AccessScope;
  }): Promise<DriveFileMeta[]> {
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    const orgPolicy = this.getOrgPolicy(viewerRealm?.orgId);

    assertAccess({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      targetRealmId,
      assetKind: "drive",
      required: "read",
      orgPolicy,
    });

    if (
      params.scopeCeiling &&
      !params.scopeCeiling.readableDriveIds.includes(targetRealmId)
    ) {
      throw new MindError(
        "ACCESS_DENIED",
        `Read access denied for drive in realm "${targetRealmId}" outside bound scope.`,
      );
    }

    return this.drive.listFiles(targetRealmId);
  }
}
