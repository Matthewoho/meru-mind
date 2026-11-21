import crypto from "node:crypto";
import { assertSafeIdentifier } from "../adapters/local-drive.js";
import {
  assertAccess,
  intersectAccessScopes,
  resolveAccess,
  resolveAccessScope,
} from "../policy.js";
import type { DbPort } from "../ports.js";
import {
  MindError,
  type AccessScope,
  type Actor,
  type EntryObjectLink,
  type MindObject,
  type OrgPolicy,
  type Realm,
  type ResourceTag,
  type ResourceTagSummary,
} from "../types.js";
import { createVisibilityHelpers, sanitizeRealmsForScope } from "./visibility.js";

export const OPAQUE_REALM_NOT_FOUND = "Realm not found in visible scope";
export const OPAQUE_OBJECT_NOT_FOUND = "Object not found in visible scope";
export const OPAQUE_ENTRY_NOT_FOUND = "Entry not found in visible scope";

const RESOURCE_TAG_RE = /^([a-z][a-z0-9_-]*):([^\s]+)$/i;

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Validates and normalizes a `<type>:<name>` resource tag (e.g. `repo:api`, `svc:billing`).
 */
export function normalizeResourceTag(raw: string): string {
  const trimmed = raw.trim();
  const m = RESOURCE_TAG_RE.exec(trimmed);
  if (!m) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid resource tag "${raw}": expected "<type>:<name>" format with no whitespace`,
    );
  }
  const typePart = m[1]!.toLowerCase();
  if (typePart === "file") {
    throw new MindError(
      "INVALID_INPUT",
      'Tag prefix "file:" is reserved for file:<path> references and cannot be used as an object or tag kind',
    );
  }
  const namePart = m[2]!;
  return `${typePart}:${namePart}`;
}

export function normalizeRealmPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("/")) {
    throw new MindError(
      "INVALID_INPUT",
      `Realm path must start with "/": "${rawPath}"`,
    );
  }
  const collapsed = trimmed.replace(/\/+/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/, "");
}

/**
 * Resolves a realm by walking the organization's realm tree layer-by-layer by slug.
 */
export function resolveRealmByPath(
  orgRealms: Realm[],
  rawPath: string,
): Realm | null {
  const normalized = normalizeRealmPath(rawPath);
  const root = orgRealms.find((r) => r.parentId === null && r.path === "/");
  if (!root) return null;
  if (normalized === "/") return root;

  const segments = normalized.slice(1).split("/").filter(Boolean);
  let current: Realm = root;
  for (const seg of segments) {
    const slug = seg.toLowerCase();
    const next = orgRealms.find(
      (r) => r.parentId === current.id && r.slug.toLowerCase() === slug,
    );
    if (!next) return null;
    current = next;
  }
  return current;
}

/**
 * Resolves a realm reference (stable realm ID, slash path like `/ops/cicd`, or `@mounted/<alias>`)
 * within `scope`. In `tree` mode, hidden realms, hidden-ancestor paths, and nonexistent realms
 * throw the EXACT same opaque `NOT_FOUND` error with zero existence disclosure.
 * Always returns the P0-1 sanitized Realm.
 */
export function resolveVisibleRealm(params: {
  realms: Realm[];
  orgId: string;
  ref: string;
  scope: AccessScope;
}): Realm {
  const ref = params.ref.trim();
  if (!ref) {
    throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
  }
  const orgRealms = params.realms.filter((r) => r.orgId === params.orgId);
  const sanitizedMap = sanitizeRealmsForScope(orgRealms, params.scope);

  if (ref.toLowerCase().startsWith("@mounted/")) {
    const targetLower = ref.toLowerCase();
    for (const clean of sanitizedMap.values()) {
      if (clean.path.toLowerCase() === targetLower) {
        return { ...clean };
      }
    }
    throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
  }

  if (ref.startsWith("/")) {
    const normalized = normalizeRealmPath(ref);
    const candidate = resolveRealmByPath(orgRealms, normalized);
    if (!candidate) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const clean = sanitizedMap.get(candidate.id);
    // Reject real path when ANY ancestor is hidden (clean.path was rewritten to @mounted/<alias>)
    if (!clean || clean.path.toLowerCase() !== normalized.toLowerCase()) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    return { ...clean };
  }

  const clean = sanitizedMap.get(ref);
  if (!clean) {
    throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
  }
  return { ...clean };
}

export function assertNoObjectCycle(
  objectsById: Map<string, MindObject>,
  objectId: string,
  candidateParentId: string | null,
): void {
  let curId = candidateParentId;
  const visited = new Set<string>([objectId]);
  while (curId) {
    if (visited.has(curId)) {
      throw new MindError(
        "INVALID_INPUT",
        `Cycle detected in object tree at "${curId}"`,
      );
    }
    visited.add(curId);
    const parent = objectsById.get(curId);
    if (!parent) break;
    curId = parent.parentObjectId;
  }
}

export function getDescendantObjectIds(
  objects: MindObject[],
  rootObjectId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const obj of objects) {
    if (!obj.parentObjectId) continue;
    const list = childrenByParent.get(obj.parentObjectId) ?? [];
    list.push(obj.id);
    childrenByParent.set(obj.parentObjectId, list);
  }
  const result: string[] = [];
  const queue = [...(childrenByParent.get(rootObjectId) ?? [])];
  const visited = new Set<string>([rootObjectId]);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    const kids = childrenByParent.get(id);
    if (kids) queue.push(...kids);
  }
  return result;
}

export class ObjectEngine {
  constructor(private readonly db: DbPort) {}

  private getOrgPolicy(orgId: string | undefined): OrgPolicy {
    if (!orgId) return "tree";
    return this.db.getOrg(orgId)?.policy ?? "tree";
  }

  private resolveScope(params: {
    viewerRealmId: string;
    includeDescendantSeabed?: boolean;
    scopeCeiling?: AccessScope;
  }): {
    viewerRealm: Realm;
    orgPolicy: OrgPolicy;
    realms: Realm[];
    scope: AccessScope;
  } {
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const orgPolicy = this.getOrgPolicy(viewerRealm.orgId);
    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed: params.includeDescendantSeabed ?? false,
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;
    return { viewerRealm, orgPolicy, realms, scope };
  }

  /**
   * Resolves a realm by stable ID or slash path (`/ops/cicd`) within caller visibility.
   * Hidden realms in `tree` mode throw the exact same opaque `NOT_FOUND` as nonexistent paths.
   */
  resolveRealmRef(params: {
    viewerRealmId: string;
    ref: string;
    scopeCeiling?: AccessScope;
  }): Realm {
    const { viewerRealm, realms, scope } = this.resolveScope({
      viewerRealmId: params.viewerRealmId,
      scopeCeiling: params.scopeCeiling,
    });
    return resolveVisibleRealm({
      realms,
      orgId: viewerRealm.orgId,
      ref: params.ref,
      scope,
    });
  }

  createObject(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmRef?: string;
    parentObjectId?: string | null;
    kind: string;
    name: string;
    id?: string;
    scopeCeiling?: AccessScope;
  }): MindObject {
    const kind = params.kind.trim();
    if (!kind) {
      throw new MindError("INVALID_INPUT", "Object kind cannot be empty");
    }
    if (kind.toLowerCase() === "file") {
      throw new MindError(
        "INVALID_INPUT",
        'Object kind "file" is reserved for file:<path> references',
      );
    }
    const name = params.name.trim();
    if (!name) {
      throw new MindError("INVALID_INPUT", "Object name cannot be empty");
    }
    if (!params.actor?.id?.trim()) {
      throw new MindError("INVALID_INPUT", "Actor id cannot be empty");
    }

    return this.db.transaction(() => {
      const { viewerRealm, orgPolicy, realms, scope } = this.resolveScope({
        viewerRealmId: params.viewerRealmId,
        scopeCeiling: params.scopeCeiling,
      });
      const mounts = this.db.listMounts();

      const targetRealm = params.targetRealmRef
        ? resolveVisibleRealm({
            realms,
            orgId: viewerRealm.orgId,
            ref: params.targetRealmRef,
            scope,
          })
        : viewerRealm;

      assertAccess({
        realms,
        mounts,
        actor: params.actor,
        viewerRealmId: viewerRealm.id,
        targetRealmId: targetRealm.id,
        assetKind: "ledger",
        required: "write",
        orgPolicy,
      });

      const id = params.id?.trim() || makeId("obj");
      assertSafeIdentifier(id, "objectId");

      const parentObjectId = params.parentObjectId?.trim() || null;
      if (parentObjectId) {
        const parent = this.db.getObject(parentObjectId);
        if (
          !parent ||
          parent.orgId !== viewerRealm.orgId ||
          !scope.readableLedgerIds.includes(parent.realmId)
        ) {
          throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
        }
        const orgObjects = this.db.listObjects({ orgId: viewerRealm.orgId });
        const objectsById = new Map(orgObjects.map((o) => [o.id, o]));
        assertNoObjectCycle(objectsById, id, parentObjectId);
      }

      const now = new Date().toISOString();
      const obj: MindObject = {
        id,
        orgId: viewerRealm.orgId,
        parentObjectId,
        realmId: targetRealm.id,
        kind,
        name,
        createdAt: now,
      };
      this.db.insertObject(obj);
      this.db.appendChangeLog({
        orgId: obj.orgId,
        realmId: obj.realmId,
        entityType: "object",
        entityId: obj.id,
        op: "create",
        actorId: params.actor.id,
        createdAt: now,
      });
      return obj;
    });
  }

  moveObject(params: {
    actor: Actor;
    viewerRealmId: string;
    objectId: string;
    parentObjectId: string | null;
    scopeCeiling?: AccessScope;
  }): MindObject {
    if (!params.actor?.id?.trim()) {
      throw new MindError("INVALID_INPUT", "Actor id cannot be empty");
    }
    return this.db.transaction(() => {
      const { viewerRealm, orgPolicy, realms, scope } = this.resolveScope({
        viewerRealmId: params.viewerRealmId,
        scopeCeiling: params.scopeCeiling,
      });
      const mounts = this.db.listMounts();

      const obj = this.db.getObject(params.objectId);
      if (
        !obj ||
        obj.orgId !== viewerRealm.orgId ||
        !scope.readableLedgerIds.includes(obj.realmId)
      ) {
        throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
      }

      assertAccess({
        realms,
        mounts,
        actor: params.actor,
        viewerRealmId: viewerRealm.id,
        targetRealmId: obj.realmId,
        assetKind: "ledger",
        required: "write",
        orgPolicy,
      });

      const nextParentId = params.parentObjectId?.trim() || null;
      if (nextParentId) {
        const parent = this.db.getObject(nextParentId);
        if (
          !parent ||
          parent.orgId !== viewerRealm.orgId ||
          !scope.readableLedgerIds.includes(parent.realmId)
        ) {
          throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
        }
        const orgObjects = this.db.listObjects({ orgId: viewerRealm.orgId });
        const objectsById = new Map(orgObjects.map((o) => [o.id, o]));
        assertNoObjectCycle(objectsById, obj.id, nextParentId);
      }

      this.db.updateObjectParent(obj.id, nextParentId);
      const now = new Date().toISOString();
      this.db.appendChangeLog({
        orgId: obj.orgId,
        realmId: obj.realmId,
        entityType: "object",
        entityId: obj.id,
        op: "move",
        actorId: params.actor.id,
        createdAt: now,
      });
      return {
        ...obj,
        parentObjectId: nextParentId,
      };
    });
  }

  getObject(params: {
    viewerRealmId: string;
    objectId: string;
    scopeCeiling?: AccessScope;
  }): MindObject {
    const { viewerRealm, realms, scope } = this.resolveScope({
      viewerRealmId: params.viewerRealmId,
      scopeCeiling: params.scopeCeiling,
    });
    const obj = this.db.getObject(params.objectId);
    if (
      !obj ||
      obj.orgId !== viewerRealm.orgId ||
      !scope.readableLedgerIds.includes(obj.realmId)
    ) {
      throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
    }
    const vis = createVisibilityHelpers({
      db: this.db,
      realms,
      mounts: this.db.listMounts(),
      actor: { id: "reader", kind: "agent" },
      viewerRealmId: viewerRealm.id,
      scope,
    });
    return vis.sanitizeObject(obj);
  }

  listObjects(params: {
    viewerRealmId: string;
    realmRef?: string;
    parentObjectId?: string | null;
    kind?: string;
    scopeCeiling?: AccessScope;
  }): MindObject[] {
    const { viewerRealm, realms, scope } = this.resolveScope({
      viewerRealmId: params.viewerRealmId,
      scopeCeiling: params.scopeCeiling,
    });

    let realmIds = scope.readableLedgerIds;
    if (params.realmRef) {
      const target = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: params.realmRef,
        scope,
      });
      realmIds = scope.readableLedgerIds.includes(target.id) ? [target.id] : [];
    }

    if (params.parentObjectId) {
      const parent = this.db.getObject(params.parentObjectId);
      if (
        !parent ||
        parent.orgId !== viewerRealm.orgId ||
        !scope.readableLedgerIds.includes(parent.realmId)
      ) {
        throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
      }
    }

    const rawObjects = this.db.listObjects({
      orgId: viewerRealm.orgId,
      realmIds,
      parentObjectId: params.parentObjectId,
      kind: params.kind?.trim() || undefined,
    });
    const vis = createVisibilityHelpers({
      db: this.db,
      realms,
      mounts: [],
      actor: { id: "reader", kind: "agent" },
      viewerRealmId: viewerRealm.id,
      scope,
    });
    return vis.sanitizeObjects(rawObjects);
  }

  deleteObject(params: {
    actor: Actor;
    viewerRealmId: string;
    objectId: string;
    scopeCeiling?: AccessScope;
  }): boolean {
    if (!params.actor?.id?.trim()) {
      throw new MindError("INVALID_INPUT", "Actor id cannot be empty");
    }
    return this.db.transaction(() => {
      const { viewerRealm, orgPolicy, realms, scope } = this.resolveScope({
        viewerRealmId: params.viewerRealmId,
        scopeCeiling: params.scopeCeiling,
      });
      const mounts = this.db.listMounts();

      const obj = this.db.getObject(params.objectId);
      if (
        !obj ||
        obj.orgId !== viewerRealm.orgId ||
        !scope.readableLedgerIds.includes(obj.realmId)
      ) {
        throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
      }

      assertAccess({
        realms,
        mounts,
        actor: params.actor,
        viewerRealmId: viewerRealm.id,
        targetRealmId: obj.realmId,
        assetKind: "ledger",
        required: "write",
        orgPolicy,
      });

      if (this.db.countChildObjects(obj.id) > 0) {
        throw new MindError(
          "CONFLICT",
          `Cannot delete object "${obj.id}" while child objects still exist`,
        );
      }

      const deleted = this.db.deleteObject(obj.id);
      if (deleted) {
        this.db.appendChangeLog({
          orgId: obj.orgId,
          realmId: obj.realmId,
          entityType: "object",
          entityId: obj.id,
          op: "delete",
          actorId: params.actor.id,
          createdAt: new Date().toISOString(),
        });
      }
      return deleted;
    });
  }

  linkEntryObject(params: {
    actor: Actor;
    viewerRealmId: string;
    entryId: string;
    objectId: string;
    scopeCeiling?: AccessScope;
  }): EntryObjectLink {
    if (!params.actor?.id?.trim()) {
      throw new MindError("INVALID_INPUT", "Actor id cannot be empty");
    }
    return this.db.transaction(() => {
      const { viewerRealm, orgPolicy, realms, scope } = this.resolveScope({
        viewerRealmId: params.viewerRealmId,
        scopeCeiling: params.scopeCeiling,
      });
      const mounts = this.db.listMounts();

      const rec = this.db.getRecord(params.entryId);
      const sea = rec ? null : this.db.getSeabedEntry(params.entryId);
      if (!rec && !sea) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      const entryOrgId = rec ? rec.orgId : sea!.orgId;
      const entryRealmId = rec ? rec.realmId : sea!.realmId;
      const assetKind = rec ? (rec.kind === "rule" ? "rule" : "ledger") : "seabed";

      if (entryOrgId !== viewerRealm.orgId) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      const readLevel = resolveAccess({
        realms,
        mounts,
        actor: params.actor,
        viewerRealmId: viewerRealm.id,
        targetRealmId: entryRealmId,
        assetKind,
        orgPolicy,
      });
      if (readLevel === "none") {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      assertAccess({
        realms,
        mounts,
        actor: params.actor,
        viewerRealmId: viewerRealm.id,
        targetRealmId: entryRealmId,
        assetKind,
        required: "write",
        orgPolicy,
      });

      const obj = this.db.getObject(params.objectId);
      if (
        !obj ||
        obj.orgId !== viewerRealm.orgId ||
        !scope.readableLedgerIds.includes(obj.realmId)
      ) {
        throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
      }

      const link: EntryObjectLink = {
        entryId: params.entryId,
        orgId: viewerRealm.orgId,
        objectId: obj.id,
      };
      this.db.insertEntryObject(link);
      this.db.appendChangeLog({
        orgId: viewerRealm.orgId,
        realmId: entryRealmId,
        entityType: "entry_object",
        entityId: `${params.entryId}:${obj.id}`,
        op: "link",
        actorId: params.actor.id,
        createdAt: new Date().toISOString(),
      });
      return link;
    });
  }

  unlinkEntryObject(params: {
    actor: Actor;
    viewerRealmId: string;
    entryId: string;
    objectId: string;
    scopeCeiling?: AccessScope;
  }): boolean {
    if (!params.actor?.id?.trim()) {
      throw new MindError("INVALID_INPUT", "Actor id cannot be empty");
    }
    return this.db.transaction(() => {
      const { viewerRealm, orgPolicy, realms, scope } = this.resolveScope({
        viewerRealmId: params.viewerRealmId,
        scopeCeiling: params.scopeCeiling,
      });
      const mounts = this.db.listMounts();

      const rec = this.db.getRecord(params.entryId);
      const sea = rec ? null : this.db.getSeabedEntry(params.entryId);
      if (!rec && !sea) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      const entryOrgId = rec ? rec.orgId : sea!.orgId;
      const entryRealmId = rec ? rec.realmId : sea!.realmId;
      const assetKind = rec ? (rec.kind === "rule" ? "rule" : "ledger") : "seabed";

      if (entryOrgId !== viewerRealm.orgId) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      const readLevel = resolveAccess({
        realms,
        mounts,
        actor: params.actor,
        viewerRealmId: viewerRealm.id,
        targetRealmId: entryRealmId,
        assetKind,
        orgPolicy,
      });
      if (readLevel === "none") {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      assertAccess({
        realms,
        mounts,
        actor: params.actor,
        viewerRealmId: viewerRealm.id,
        targetRealmId: entryRealmId,
        assetKind,
        required: "write",
        orgPolicy,
      });

      const obj = this.db.getObject(params.objectId);
      if (
        !obj ||
        obj.orgId !== viewerRealm.orgId ||
        !scope.readableLedgerIds.includes(obj.realmId)
      ) {
        throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
      }

      const removed = this.db.deleteEntryObject(params.entryId, obj.id);
      if (removed) {
        this.db.appendChangeLog({
          orgId: viewerRealm.orgId,
          realmId: entryRealmId,
          entityType: "entry_object",
          entityId: `${params.entryId}:${obj.id}`,
          op: "unlink",
          actorId: params.actor.id,
          createdAt: new Date().toISOString(),
        });
      }
      return removed;
    });
  }

  tagEntryResource(params: {
    actor: Actor;
    viewerRealmId: string;
    entryId: string;
    tag: string;
    scopeCeiling?: AccessScope;
  }): ResourceTag {
    if (!params.actor?.id?.trim()) {
      throw new MindError("INVALID_INPUT", "Actor id cannot be empty");
    }
    const normalizedTag = normalizeResourceTag(params.tag);
    return this.db.transaction(() => {
      const { viewerRealm, orgPolicy, realms } = this.resolveScope({
        viewerRealmId: params.viewerRealmId,
        scopeCeiling: params.scopeCeiling,
      });
      const mounts = this.db.listMounts();

      const rec = this.db.getRecord(params.entryId);
      const sea = rec ? null : this.db.getSeabedEntry(params.entryId);
      if (!rec && !sea) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      const entryOrgId = rec ? rec.orgId : sea!.orgId;
      const entryRealmId = rec ? rec.realmId : sea!.realmId;
      const assetKind = rec ? (rec.kind === "rule" ? "rule" : "ledger") : "seabed";

      if (entryOrgId !== viewerRealm.orgId) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      const readLevel = resolveAccess({
        realms,
        mounts,
        actor: params.actor,
        viewerRealmId: viewerRealm.id,
        targetRealmId: entryRealmId,
        assetKind,
        orgPolicy,
      });
      if (readLevel === "none") {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      assertAccess({
        realms,
        mounts,
        actor: params.actor,
        viewerRealmId: viewerRealm.id,
        targetRealmId: entryRealmId,
        assetKind,
        required: "write",
        orgPolicy,
      });

      const resTag: ResourceTag = {
        entryId: params.entryId,
        orgId: viewerRealm.orgId,
        tag: normalizedTag,
      };
      this.db.insertResourceTag(resTag);
      // Store ONLY entryId in change_log.entity_id (zero tag text or unkeyed hash leakage)
      this.db.appendChangeLog({
        orgId: viewerRealm.orgId,
        realmId: entryRealmId,
        entityType: "resource_tag",
        entityId: params.entryId,
        op: "tag",
        actorId: params.actor.id,
        createdAt: new Date().toISOString(),
      });
      return resTag;
    });
  }

  listResourceTags(params: {
    viewerRealmId: string;
    prefix?: string;
    realmRef?: string;
    includeDescendantSeabed?: boolean;
    scopeCeiling?: AccessScope;
  }): ResourceTagSummary[] {
    const { viewerRealm, realms, scope } = this.resolveScope({
      viewerRealmId: params.viewerRealmId,
      includeDescendantSeabed: params.includeDescendantSeabed ?? false,
      scopeCeiling: params.scopeCeiling,
    });

    let ledgerRealmIds = scope.readableLedgerIds;
    let seabedRealmIds = scope.readableSeabedIds;

    if (params.realmRef) {
      const target = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: params.realmRef,
        scope,
      });
      ledgerRealmIds = scope.readableLedgerIds.includes(target.id)
        ? [target.id]
        : [];
      seabedRealmIds = scope.readableSeabedIds.includes(target.id)
        ? [target.id]
        : [];
    }

    return this.db.listVisibleResourceTags({
      orgId: viewerRealm.orgId,
      ledgerRealmIds,
      seabedRealmIds,
      prefix: params.prefix,
    });
  }
}
