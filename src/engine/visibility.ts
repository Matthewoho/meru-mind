import { getAncestorIds, resolveAccess } from "../policy.js";
import type { DbPort } from "../ports.js";
import type {
  AccessScope,
  Actor,
  Distillation,
  LedgerRecord,
  MindObject,
  Realm,
  RealmMount,
  SeabedEntry,
  SupersedeChainResult,
} from "../types.js";

const DRIVE_SOURCE_REF_RE = /^drive:\/\/([^/]+)\/(.+?)(?:@v\d+)?$/;

export function parseDriveSourceRef(
  sourceRef: string,
): { realmId: string; relPath: string } | null {
  const m = DRIVE_SOURCE_REF_RE.exec(sourceRef.trim());
  if (!m) return null;
  return { realmId: m[1]!, relPath: m[2]! };
}

/**
 * P0-1 Hard-Wall Zero-Leak Realm Sanitizer.
 *
 * For every realm visible in `scope`, if ANY ancestor of that realm is NOT in
 * `scope.readableLedgerIds` (e.g., a mounted sibling `C1` under hidden branch `B1`):
 * - Rewrite `path` to `"@mounted/" + alias` derived strictly from the realm's OWN `slug`
 *   (deterministically disambiguated with its own short ID suffix on slug collision —
 *   NEVER exposing any hidden ancestor slug).
 * - Set `parentId = null` (NEVER exposing any hidden ancestor realm ID).
 */
export function sanitizeRealmsForScope(
  realms: Realm[],
  scope: AccessScope,
): Map<string, Realm> {
  const orgRealms = realms.filter((r) => r.orgId === scope.orgId);
  const orgRealmsById = new Map(orgRealms.map((r) => [r.id, r]));
  const readableLedgerSet = new Set(scope.readableLedgerIds);
  const visibleSet = new Set<string>([
    ...scope.readableLedgerIds,
    ...scope.readableDriveIds,
    ...scope.readableSeabedIds,
  ]);

  const hiddenAncestorRealms: Realm[] = [];
  const cleanMap = new Map<string, Realm>();

  for (const r of orgRealms) {
    if (!visibleSet.has(r.id)) continue;
    const ancestors = getAncestorIds(orgRealmsById, r.id);
    const hasHiddenAncestor =
      ancestors.some((aid) => !readableLedgerSet.has(aid)) ||
      (r.parentId !== null && !readableLedgerSet.has(r.parentId));
    if (hasHiddenAncestor) {
      hiddenAncestorRealms.push(r);
    } else {
      cleanMap.set(r.id, { ...r });
    }
  }

  // Deterministic slug-collision disambiguation using strictly each realm's own slug + short ID suffix
  const slugCounts = new Map<string, number>();
  for (const r of hiddenAncestorRealms) {
    const key = r.slug.toLowerCase();
    slugCounts.set(key, (slugCounts.get(key) ?? 0) + 1);
  }

  for (const r of hiddenAncestorRealms) {
    const key = r.slug.toLowerCase();
    const hasCollision = (slugCounts.get(key) ?? 0) > 1;
    const shortId = r.id.replace(/^realm_/, "").slice(0, 6);
    const alias = hasCollision ? `${r.slug}-${shortId}` : r.slug;
    cleanMap.set(r.id, {
      ...r,
      parentId: null,
      path: `@mounted/${alias}`,
    });
  }

  return cleanMap;
}

export interface VisibilityHelpers {
  canSeeRecord(rec: LedgerRecord): boolean;
  canSeeSeabed(sea: SeabedEntry): boolean;
  canSeeDistillation(dist: Distillation): boolean;
  canSeeDriveRealm(realmId: string): boolean;
  isRefVisible(ref: string): boolean;
  preloadRefs(refs: string[]): void;
  sanitizeRealm(realm: Realm): Realm;
  sanitizeRealms(realms: Realm[]): Realm[];
  getSanitizedRealmPath(realmId: string): string;
  sanitizeObject(obj: MindObject): MindObject;
  sanitizeObjects(objects: MindObject[]): MindObject[];
  sanitizeRecord(rec: LedgerRecord): LedgerRecord;
  sanitizeSeabed(sea: SeabedEntry): SeabedEntry;
  sanitizeDistillation(dist: Distillation): Distillation;
  isOrphanSuperseded(rec: LedgerRecord): boolean;
  resolveCurrentHeadId(rec: LedgerRecord): string | null;
  traverseSupersedeDag(start: LedgerRecord): SupersedeChainResult;
}

/**
 * Single shared visibility, P0-1 realm/object path/parent sanitizer,
 * and field-level reference sanitizer used across LedgerEngine, ObjectEngine, and SeaEngine.
 */
export function createVisibilityHelpers(params: {
  db: DbPort;
  realms: Realm[];
  mounts: RealmMount[];
  actor: Actor;
  viewerRealmId: string;
  scope: AccessScope;
  ledgerRealmIds?: string[];
  seabedRealmIds?: string[];
  includeDescendantSeabed?: boolean;
}): VisibilityHelpers {
  const {
    db,
    realms,
    mounts,
    actor,
    viewerRealmId,
    scope,
    includeDescendantSeabed = false,
  } = params;
  const ledgerRealmIds = params.ledgerRealmIds ?? scope.readableLedgerIds;
  const seabedRealmIds = params.seabedRealmIds ?? scope.readableSeabedIds;

  const ledgerSet = new Set(ledgerRealmIds);
  const seabedSet = new Set(seabedRealmIds);
  const driveSet = new Set(scope.readableDriveIds);
  const realmIdSet = new Set(realms.map((r) => r.id));

  const sanitizedRealmsMap = sanitizeRealmsForScope(realms, scope);

  // Per-call caches populated by preloadRefs() to keep ref sanitization strictly O(1) SQL queries
  const recordCache = new Map<string, LedgerRecord | null>();
  const seabedCache = new Map<string, SeabedEntry | null>();
  const distCache = new Map<string, Distillation | null>();

  const getCachedRecord = (id: string): LedgerRecord | null => {
    if (recordCache.has(id)) return recordCache.get(id)!;
    const rec = db.getRecord(id);
    recordCache.set(id, rec);
    return rec;
  };

  const getCachedSeabed = (id: string): SeabedEntry | null => {
    if (seabedCache.has(id)) return seabedCache.get(id)!;
    const sea = db.getSeabedEntry(id);
    seabedCache.set(id, sea);
    return sea;
  };

  const getCachedDistillation = (id: string): Distillation | null => {
    if (distCache.has(id)) return distCache.get(id)!;
    const dist = db.getDistillation(id);
    distCache.set(id, dist);
    return dist;
  };

  const preloadRefs = (refs: string[]): void => {
    const toCheck: string[] = [];
    for (const ref of refs) {
      if (!ref || parseDriveSourceRef(ref) || realmIdSet.has(ref)) continue;
      if (
        !recordCache.has(ref) &&
        !seabedCache.has(ref) &&
        !distCache.has(ref)
      ) {
        toCheck.push(ref);
      }
    }
    const unique = Array.from(new Set(toCheck));
    if (unique.length === 0) return;

    const recs = db.getRecordsByIds(unique);
    const foundRecIds = new Set<string>();
    for (const r of recs) {
      recordCache.set(r.id, r);
      foundRecIds.add(r.id);
    }

    const remainingForSea = unique.filter((id) => !foundRecIds.has(id));
    for (const id of remainingForSea) {
      recordCache.set(id, null);
    }
    if (remainingForSea.length === 0) return;

    const seas = db.getSeabedEntriesByIds(remainingForSea);
    const foundSeaIds = new Set<string>();
    for (const s of seas) {
      seabedCache.set(s.id, s);
      foundSeaIds.add(s.id);
    }

    const remainingForDist = remainingForSea.filter(
      (id) => !foundSeaIds.has(id),
    );
    for (const id of remainingForDist) {
      seabedCache.set(id, null);
    }
    if (remainingForDist.length === 0) return;

    const dists = db.getDistillationsByIds(remainingForDist);
    const foundDistIds = new Set<string>();
    for (const d of dists) {
      distCache.set(d.id, d);
      foundDistIds.add(d.id);
    }
    for (const id of remainingForDist) {
      if (!foundDistIds.has(id)) {
        distCache.set(id, null);
      }
    }
  };

  const canSeeRecord = (rec: LedgerRecord): boolean => {
    if (!ledgerSet.has(rec.realmId)) return false;
    const access = resolveAccess({
      realms,
      mounts,
      actor,
      viewerRealmId,
      targetRealmId: rec.realmId,
      assetKind: rec.kind === "rule" ? "rule" : "ledger",
      orgPolicy: scope.policy,
    });
    return access !== "none";
  };

  const canSeeSeabed = (sea: SeabedEntry): boolean => {
    if (!seabedSet.has(sea.realmId)) return false;
    const access = resolveAccess({
      realms,
      mounts,
      actor,
      viewerRealmId,
      targetRealmId: sea.realmId,
      assetKind: "seabed",
      explicitDescendantDive: includeDescendantSeabed,
      orgPolicy: scope.policy,
    });
    return access !== "none";
  };

  const canSeeDistillation = (dist: Distillation): boolean => {
    if (!ledgerSet.has(dist.realmId)) return false;
    const access = resolveAccess({
      realms,
      mounts,
      actor,
      viewerRealmId,
      targetRealmId: dist.realmId,
      assetKind: "ledger",
      orgPolicy: scope.policy,
    });
    return access !== "none";
  };

  const canSeeDriveRealm = (realmId: string): boolean => {
    if (!driveSet.has(realmId)) return false;
    return (
      resolveAccess({
        realms,
        mounts,
        actor,
        viewerRealmId,
        targetRealmId: realmId,
        assetKind: "drive",
        orgPolicy: scope.policy,
      }) !== "none"
    );
  };

  const isRefVisible = (ref: string): boolean => {
    const driveRef = parseDriveSourceRef(ref);
    if (driveRef) {
      return canSeeDriveRealm(driveRef.realmId);
    }
    const rec = getCachedRecord(ref);
    if (rec) {
      if (rec.sensitivity === "secret") return false;
      return canSeeRecord(rec);
    }
    const sea = getCachedSeabed(ref);
    if (sea) {
      if (sea.sensitivity === "secret") return false;
      return canSeeSeabed(sea);
    }
    const dist = getCachedDistillation(ref);
    if (dist) {
      return canSeeDistillation(dist);
    }
    if (realmIdSet.has(ref)) {
      return ledgerSet.has(ref);
    }
    return true;
  };

  const sanitizeRealm = (realm: Realm): Realm => {
    const found = sanitizedRealmsMap.get(realm.id);
    if (found) return { ...found };
    return {
      ...realm,
      parentId: null,
      path: `@mounted/${realm.slug}`,
    };
  };

  const sanitizeRealms = (list: Realm[]): Realm[] => {
    const out: Realm[] = [];
    for (const r of list) {
      const clean = sanitizedRealmsMap.get(r.id);
      if (clean) out.push({ ...clean });
    }
    return out;
  };

  const getSanitizedRealmPath = (realmId: string): string => {
    return sanitizedRealmsMap.get(realmId)?.path ?? "/";
  };

  const sanitizeObjects = (objects: MindObject[]): MindObject[] => {
    if (objects.length === 0) return [];
    const byId = new Map<string, MindObject>();
    for (const o of objects) {
      byId.set(o.id, o);
    }
    const missingParents: string[] = [];
    const evidenceIds: string[] = [];
    for (const o of objects) {
      if (o.parentObjectId && !byId.has(o.parentObjectId)) {
        missingParents.push(o.parentObjectId);
      }
      if (o.stateEvidenceId) {
        evidenceIds.push(o.stateEvidenceId);
      }
    }
    if (missingParents.length > 0) {
      for (const p of db.getObjectsByIds(missingParents)) {
        byId.set(p.id, p);
      }
    }
    if (evidenceIds.length > 0) {
      preloadRefs(evidenceIds);
    }
    const fullReadableLedger = new Set(scope.readableLedgerIds);
    return objects.map((o) => {
      const next: MindObject = { ...o };
      if (next.parentObjectId) {
        const parent = byId.get(next.parentObjectId);
        if (
          !parent ||
          parent.orgId !== scope.orgId ||
          !fullReadableLedger.has(parent.realmId)
        ) {
          next.parentObjectId = null;
        }
      }
      if (next.stateEvidenceId && !isRefVisible(next.stateEvidenceId)) {
        next.stateEvidenceId = null;
      }
      return next;
    });
  };

  const sanitizeObject = (obj: MindObject): MindObject => {
    return sanitizeObjects([obj])[0]!;
  };

  const sanitizeRecord = (rec: LedgerRecord): LedgerRecord => {
    const rawSupersedesIds =
      rec.supersedesIds && rec.supersedesIds.length > 0
        ? rec.supersedesIds
        : rec.supersedesId
          ? [rec.supersedesId]
          : [];
    const visibleSupersedesIds = rawSupersedesIds.filter(isRefVisible);
    return {
      ...rec,
      refs: rec.refs.filter(isRefVisible),
      supersedesId: visibleSupersedesIds[0] ?? null,
      supersedesIds: visibleSupersedesIds,
      supersededById:
        rec.supersededById && isRefVisible(rec.supersededById)
          ? rec.supersededById
          : null,
    };
  };

  const sanitizeSeabed = (sea: SeabedEntry): SeabedEntry => ({
    ...sea,
    sourceRef:
      sea.sourceRef && isRefVisible(sea.sourceRef) ? sea.sourceRef : null,
  });

  const sanitizeDistillation = (dist: Distillation): Distillation => ({
    ...dist,
    sourceIds: dist.sourceIds.filter(isRefVisible),
  });

  const isOrphanSuperseded = (rec: LedgerRecord): boolean =>
    rec.status === "superseded" && rec.supersededById === null;

  const resolveCurrentHeadId = (rec: LedgerRecord): string | null => {
    if (rec.status !== "superseded") return null;
    if (rec.supersededById === null) return null;
    let cur: LedgerRecord | null = rec;
    const visited = new Set<string>([rec.id]);
    while (cur && cur.supersededById && !visited.has(cur.supersededById)) {
      visited.add(cur.supersededById);
      cur = getCachedRecord(cur.supersededById);
    }
    if (!cur || cur.id === rec.id) return null;
    // Redacted chain head means there is NO active current version
    if (cur.status !== "active" || cur.redactedAt !== null) return null;
    if (cur.sensitivity === "secret") return null;
    if (!canSeeRecord(cur)) return null;
    return cur.id;
  };

  const traverseSupersedeDag = (start: LedgerRecord): SupersedeChainResult => {
    const visited = new Set<string>([start.id]);
    const queue: LedgerRecord[] = [start];
    const collected: LedgerRecord[] = [];
    recordCache.set(start.id, start);

    while (queue.length > 0) {
      const node = queue.shift()!;
      collected.push(node);

      const neighborIds: string[] = [];
      const preds =
        node.supersedesIds && node.supersedesIds.length > 0
          ? node.supersedesIds
          : node.supersedesId
            ? [node.supersedesId]
            : [];
      for (const pid of preds) {
        if (!visited.has(pid)) neighborIds.push(pid);
      }
      if (node.supersededById && !visited.has(node.supersededById)) {
        neighborIds.push(node.supersededById);
      }

      if (neighborIds.length > 0) {
        const uncached = neighborIds.filter((id) => !recordCache.has(id));
        if (uncached.length > 0) {
          const fetched = db.getRecordsByIds(uncached);
          const fetchedSet = new Set<string>();
          for (const f of fetched) {
            recordCache.set(f.id, f);
            fetchedSet.add(f.id);
          }
          for (const id of uncached) {
            if (!fetchedSet.has(id)) recordCache.set(id, null);
          }
        }
        for (const nid of neighborIds) {
          if (visited.has(nid)) continue;
          visited.add(nid);
          const next = recordCache.get(nid);
          if (next) queue.push(next);
        }
      }
    }

    const visibleNodes = collected.filter(
      (node) =>
        canSeeRecord(node) &&
        (node.sensitivity !== "secret" || node.id === start.id),
    );

    // Deterministic topological sort (predecessors before successors),
    // breaking ties chronologically: (occurredAt ?? createdAt) ASC, createdAt ASC, id ASC.
    const compareChrono = (a: LedgerRecord, b: LedgerRecord): number => {
      const tA = a.occurredAt ?? a.createdAt;
      const tB = b.occurredAt ?? b.createdAt;
      if (tA !== tB) return tA.localeCompare(tB);
      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }
      return a.id.localeCompare(b.id);
    };

    const visibleMap = new Map(visibleNodes.map((n) => [n.id, n]));
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, Set<string>>();
    for (const n of visibleNodes) {
      inDegree.set(n.id, 0);
      dependents.set(n.id, new Set());
    }
    const addEdge = (fromId: string, toId: string): void => {
      if (fromId === toId) return;
      if (!visibleMap.has(fromId) || !visibleMap.has(toId)) return;
      const deps = dependents.get(fromId)!;
      if (!deps.has(toId)) {
        deps.add(toId);
        inDegree.set(toId, (inDegree.get(toId) ?? 0) + 1);
      }
    };
    for (const n of visibleNodes) {
      const preds =
        n.supersedesIds && n.supersedesIds.length > 0
          ? n.supersedesIds
          : n.supersedesId
            ? [n.supersedesId]
            : [];
      for (const pid of preds) {
        addEdge(pid, n.id);
      }
      if (n.supersededById) {
        addEdge(n.id, n.supersededById);
      }
    }

    const ready = visibleNodes
      .filter((n) => (inDegree.get(n.id) ?? 0) === 0)
      .sort(compareChrono);
    const orderedVisible: LedgerRecord[] = [];
    const emitted = new Set<string>();
    while (ready.length > 0) {
      const curr = ready.shift()!;
      orderedVisible.push(curr);
      emitted.add(curr.id);
      for (const nextId of dependents.get(curr.id) ?? []) {
        const nextDeg = (inDegree.get(nextId) ?? 1) - 1;
        inDegree.set(nextId, nextDeg);
        if (nextDeg === 0) {
          ready.push(visibleMap.get(nextId)!);
          ready.sort(compareChrono);
        }
      }
    }
    if (orderedVisible.length < visibleNodes.length) {
      const remaining = visibleNodes
        .filter((n) => !emitted.has(n.id))
        .sort(compareChrono);
      orderedVisible.push(...remaining);
    }

    const refsToPreload: string[] = [];
    for (const n of orderedVisible) {
      refsToPreload.push(...n.refs);
      if (n.supersedesId) refsToPreload.push(n.supersedesId);
      if (n.supersedesIds) refsToPreload.push(...n.supersedesIds);
      if (n.supersededById) refsToPreload.push(n.supersededById);
    }
    preloadRefs(refsToPreload);

    const sanitizedNodes = orderedVisible.map(sanitizeRecord);

    const orphanSuperseded = isOrphanSuperseded(start);
    let currentHeadId: string | null = null;
    if (!orphanSuperseded) {
      const activeHeads = collected.filter(
        (n) =>
          n.status === "active" &&
          n.supersededById === null &&
          n.redactedAt === null &&
          n.sensitivity !== "secret" &&
          canSeeRecord(n),
      );
      if (activeHeads.length === 1) {
        currentHeadId = activeHeads[0]!.id;
      } else {
        currentHeadId = null;
      }
    }

    return {
      nodes: sanitizedNodes,
      currentHeadId,
      orphanSuperseded,
    };
  };

  return {
    canSeeRecord,
    canSeeSeabed,
    canSeeDistillation,
    canSeeDriveRealm,
    isRefVisible,
    preloadRefs,
    sanitizeRealm,
    sanitizeRealms,
    getSanitizedRealmPath,
    sanitizeObject,
    sanitizeObjects,
    sanitizeRecord,
    sanitizeSeabed,
    sanitizeDistillation,
    isOrphanSuperseded,
    resolveCurrentHeadId,
    traverseSupersedeDag,
  };
}
