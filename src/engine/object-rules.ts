import { getAncestorIds } from "../policy.js";
import type { DbPort } from "../ports.js";
import type {
  AccessScope,
  LedgerRecord,
  MindObject,
  ObjectBriefRule,
  Realm,
  ScopedRuleSource,
} from "../types.js";
import { buildSnippet } from "../format/snippet.js";
import { getDescendantObjectIds, normalizeResourceTag } from "./objects.js";
import {
  computeDuplicateObjectKeys,
  formatCanonicalObjectRef,
} from "./refs.js";
import type { VisibilityHelpers } from "./visibility.js";

/**
 * Safely normalizes a `<kind>:<name>` string into a resource tag, returning `null`
 * for legacy object names containing whitespace or characters invalid in `resource_tags`.
 */
export function tryNormalizeResourceTag(raw: string): string | null {
  try {
    return normalizeResourceTag(raw);
  } catch {
    return null;
  }
}

/**
 * Walks `parentObjectId` upward starting from `startObj` strictly over visibility-sanitized objects
 * (`vis.sanitizeObjects(...)`, which already nulls out any parent outside `scope.readableLedgerIds`).
 * Stops immediately if a parent is hidden/missing, guarded by a `visited` cycle set.
 */
export function walkVisibleWithinAncestors(
  sanitizedVisibleObjects: MindObject[],
  startObj: MindObject,
): MindObject[] {
  const byId = new Map(sanitizedVisibleObjects.map((o) => [o.id, o]));
  const chain: MindObject[] = [];
  const visited = new Set<string>();
  let cur: MindObject | undefined = byId.get(startObj.id) ?? startObj;
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    chain.push(cur);
    if (!cur.parentObjectId) break;
    const parent = byId.get(cur.parentObjectId);
    if (!parent) break;
    cur = parent;
  }
  return chain;
}

/**
 * Extracts clean readable text body from a rule record for display in object briefs.
 */
export function extractRuleBodyText(rec: LedgerRecord): string {
  if (typeof rec.payload.body === "string" && rec.payload.body.trim()) {
    return rec.payload.body.trim();
  }
  if (typeof rec.payload.summary === "string" && rec.payload.summary.trim()) {
    return rec.payload.summary.trim();
  }
  return buildSnippet({ text: JSON.stringify(rec.payload), maxLen: 240 });
}

function compareRuleOrder(a: LedgerRecord, b: LedgerRecord): number {
  const tA = a.occurredAt ?? a.createdAt;
  const tB = b.occurredAt ?? b.createdAt;
  if (tA !== tB) return tB.localeCompare(tA);
  if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return a.id.localeCompare(b.id);
}

export function compareEntriesDesc(a: LedgerRecord, b: LedgerRecord): number {
  const tA = a.occurredAt ?? a.createdAt;
  const tB = b.occurredAt ?? b.createdAt;
  if (tA !== tB) return tB.localeCompare(tA);
  if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return b.id.localeCompare(a.id);
}

/**
 * Returns the set of visible governing realm IDs (targetRealm + visible realm ancestors)
 * intersected with `allowedRealmIds` (or `scope.readableLedgerIds`).
 */
export function computeGoverningRealmIds(params: {
  realms: Realm[];
  orgId: string;
  targetRealmId: string;
  scope: AccessScope;
  allowedRealmIds?: Set<string>;
}): Set<string> {
  const orgRealmsById = new Map(
    params.realms
      .filter((r) => r.orgId === params.orgId)
      .map((r) => [r.id, r]),
  );
  const readableSet =
    params.allowedRealmIds ?? new Set(params.scope.readableLedgerIds);
  const out = new Set<string>();
  if (readableSet.has(params.targetRealmId)) {
    out.add(params.targetRealmId);
  }
  for (const aid of getAncestorIds(orgRealmsById, params.targetRealmId)) {
    if (readableSet.has(aid)) {
      out.add(aid);
    }
  }
  return out;
}

/**
 * Classifies a list of active visible rules into Wall rules (no bound objects/tags, OR all bound
 * objects are invisible to the reader so rules never vanish) vs Scoped Object/Tag rules.
 */
export function classifyRulesForViewer(params: {
  db: DbPort;
  orgId: string;
  rules: LedgerRecord[];
  visibleObjectsById: Map<string, MindObject>;
  duplicateObjectKeys: Set<string>;
  vis: VisibilityHelpers;
}): {
  wallRules: LedgerRecord[];
  scopedRules: Array<{ rule: LedgerRecord; objectRefs: string[] }>;
} {
  if (params.rules.length === 0) {
    return { wallRules: [], scopedRules: [] };
  }
  const ruleIds = params.rules.map((r) => r.id);
  const objIdsByEntry = params.db.listObjectIdsByEntryIds(params.orgId, ruleIds);
  const tagsByEntry = params.db.listResourceTagsByEntryIds(params.orgId, ruleIds);

  const wallRules: LedgerRecord[] = [];
  const scopedRules: Array<{ rule: LedgerRecord; objectRefs: string[] }> = [];

  for (const rule of params.rules) {
    const rawObjIds = objIdsByEntry.get(rule.id) ?? [];
    const rawTags = tagsByEntry.get(rule.id) ?? [];

    const visibleRefs: string[] = [];
    for (const oid of rawObjIds) {
      const obj = params.visibleObjectsById.get(oid);
      if (obj) {
        const rPath = params.vis.getSanitizedRealmPath(obj.realmId);
        visibleRefs.push(
          formatCanonicalObjectRef(obj, rPath, params.duplicateObjectKeys),
        );
      }
    }
    for (const tag of rawTags) {
      visibleRefs.push(tag);
    }
    const dedupRefs = Array.from(new Set(visibleRefs)).sort();

    // If rule has NO bound objects/tags, OR had bound objects that are ALL invisible to this reader,
    // surface it under wallRules so an active rule NEVER silently vanishes!
    if (dedupRefs.length === 0) {
      wallRules.push(rule);
    } else {
      scopedRules.push({ rule, objectRefs: dedupRefs });
    }
  }

  return { wallRules, scopedRules };
}

/**
 * Collects Wall rules (realm-level rules without visible object/tag bindings) governing `targetRealmId`.
 */
export function collectWallRules(params: {
  db: DbPort;
  realms: Realm[];
  orgId: string;
  targetRealmId: string;
  scope: AccessScope;
  vis: VisibilityHelpers;
  sanitizedVisibleObjects: MindObject[];
  allowedRealmIds?: Set<string>;
}): ObjectBriefRule[] {
  const governing = computeGoverningRealmIds({
    realms: params.realms,
    orgId: params.orgId,
    targetRealmId: params.targetRealmId,
    scope: params.scope,
    allowedRealmIds: params.allowedRealmIds,
  });
  if (governing.size === 0) return [];

  const governingList = Array.from(governing);
  const allRules = params.db
    .listRecords({
      realmIds: governingList,
      kinds: ["rule"],
      includeSuperseded: false,
      excludeSensitivities: ["secret"],
      limit: 5000,
    })
    .items.filter(
      (r) =>
        r.orgId === params.orgId &&
        r.kind === "rule" &&
        r.status === "active" &&
        r.redactedAt === null &&
        r.sensitivity !== "secret" &&
        governing.has(r.realmId) &&
        params.vis.canSeeRecord(r),
    );

  const visibleObjectsById = new Map(
    params.sanitizedVisibleObjects.map((o) => [o.id, o]),
  );
  const dupKeys = computeDuplicateObjectKeys(params.sanitizedVisibleObjects);
  const { wallRules } = classifyRulesForViewer({
    db: params.db,
    orgId: params.orgId,
    rules: allRules,
    visibleObjectsById,
    duplicateObjectKeys: dupKeys,
    vis: params.vis,
  });

  wallRules.sort(compareRuleOrder);
  return wallRules.map((r) => {
    const realmPath = params.vis.getSanitizedRealmPath(r.realmId);
    return {
      id: r.id,
      realmId: r.realmId,
      realmPath,
      title: r.title,
      body: extractRuleBodyText(r),
      scopeSource: "realm",
      sourceRef: realmPath,
      occurredAt: r.occurredAt,
      createdAt: r.createdAt,
    };
  });
}

/**
 * Single authoritative collector for object-scoped rules (object + upward `within` ancestors ONLY;
 * NO Wall rules, NO `--with`).
 *
 * Shared identically by:
 * - `show <object>` (primary object & each `--with` object)
 * - `settle --layer card_object` (`hardFacts.activeRuleIds`)
 * - Deterministic per-reader `V3` freshness computation
 *
 * Enforces L8 (object ∪ tag union) and L9 (same-`kind:name` visible objects within governing realms),
 * strictly bounded to each object's governing realms (object's realm + visible realm ancestors)
 * intersected with `allowedRealmIds` when supplied.
 */
export function collectObjectScopedRules(params: {
  db: DbPort;
  realms: Realm[];
  orgId: string;
  object: MindObject | null;
  objectKind: string;
  objectName: string;
  scopedRealmId?: string | null;
  scope: AccessScope;
  vis: VisibilityHelpers;
  sanitizedVisibleObjects: MindObject[];
  scopeSource?: ScopedRuleSource;
  allowedRealmIds?: Set<string>;
  /** Optional explicit governing realm set override (e.g. target record's realm + ancestors for I3 write echo) */
  governingRealmOverride?: Set<string>;
}): ObjectBriefRule[] {
  const { db, realms, orgId, scope, vis, sanitizedVisibleObjects } = params;
  const scopeSource: ScopedRuleSource = params.scopeSource ?? "object";
  const dupKeys = computeDuplicateObjectKeys(sanitizedVisibleObjects);
  const effectiveReadableSet =
    params.allowedRealmIds ?? new Set(scope.readableLedgerIds);

  const ruleMap = new Map<string, { rec: LedgerRecord; sourceRef: string }>();

  const considerCandidateIds = (
    candidateIds: string[],
    governing: Set<string>,
    sourceRef: string,
  ): void => {
    const unique = Array.from(new Set(candidateIds));
    if (unique.length === 0 || governing.size === 0) return;
    const recs = db.getRecordsByIds(unique);
    for (const r of recs) {
      if (
        r.orgId !== orgId ||
        r.kind !== "rule" ||
        r.status !== "active" ||
        r.redactedAt !== null ||
        r.sensitivity === "secret" ||
        !governing.has(r.realmId) ||
        !vis.canSeeRecord(r)
      ) {
        continue;
      }
      if (!ruleMap.has(r.id)) {
        ruleMap.set(r.id, { rec: r, sourceRef });
      }
    }
  };

  if (params.object) {
    const ancestorChain = walkVisibleWithinAncestors(
      sanitizedVisibleObjects,
      params.object,
    );
    for (const node of ancestorChain) {
      const governing =
        params.governingRealmOverride ??
        computeGoverningRealmIds({
          realms,
          orgId,
          targetRealmId: node.realmId,
          scope,
          allowedRealmIds: effectiveReadableSet,
        });
      if (governing.size === 0) continue;

      const nodeRealmPath = vis.getSanitizedRealmPath(node.realmId);
      const sourceRef = formatCanonicalObjectRef(node, nodeRealmPath, dupKeys);
      const normTag = tryNormalizeResourceTag(`${node.kind}:${node.name}`);

      // L9: Include this object AND any visible same-kind:name objects inside its governing realms
      const sameNameObjIds = sanitizedVisibleObjects
        .filter(
          (o) =>
            o.id === node.id ||
            (governing.has(o.realmId) &&
              o.kind.toLowerCase() === node.kind.toLowerCase() &&
              o.name.toLowerCase() === node.name.toLowerCase()),
        )
        .map((o) => o.id);

      const viaObjIds = db.listEntryIdsForObjects(orgId, sameNameObjIds);
      // L8: Include rules bound via resource_tags matching kind:name (skip when legacy name has spaces)
      const viaTagIds = normTag
        ? db.listEntryIdsByResourceTag(orgId, normTag)
        : [];
      considerCandidateIds([...viaObjIds, ...viaTagIds], governing, sourceRef);
    }
  } else {
    // Tag-only object ref (no real MindObject row)
    const normTag = tryNormalizeResourceTag(
      `${params.objectKind}:${params.objectName}`,
    );
    if (normTag) {
      const governing =
        params.governingRealmOverride ??
        (params.scopedRealmId
          ? computeGoverningRealmIds({
              realms,
              orgId,
              targetRealmId: params.scopedRealmId,
              scope,
              allowedRealmIds: effectiveReadableSet,
            })
          : effectiveReadableSet);
      const viaTagIds = db.listEntryIdsByResourceTag(orgId, normTag);
      considerCandidateIds(viaTagIds, governing, normTag);
    }
  }

  return Array.from(ruleMap.values())
    .sort((a, b) => compareRuleOrder(a.rec, b.rec))
    .map(({ rec, sourceRef }) => ({
      id: rec.id,
      realmId: rec.realmId,
      realmPath: vis.getSanitizedRealmPath(rec.realmId),
      title: rec.title,
      body: extractRuleBodyText(rec),
      scopeSource,
      sourceRef,
      occurredAt: rec.occurredAt,
      createdAt: rec.createdAt,
    }));
}

/**
 * Single authoritative collector for visible active decision chain heads on an object.
 * Shared identically by `show <object>`, `settle card_object`, and `V3` freshness.
 */
export function collectActiveDecisionHeads(params: {
  db: DbPort;
  orgId: string;
  entryIds: string[];
  vis: VisibilityHelpers;
  allowedRealmIds: Set<string>;
}): LedgerRecord[] {
  const unique = Array.from(new Set(params.entryIds));
  if (unique.length === 0 || params.allowedRealmIds.size === 0) return [];
  return params.db
    .getRecordsByIds(unique)
    .filter(
      (r) =>
        r.orgId === params.orgId &&
        r.kind === "decision" &&
        r.status === "active" &&
        r.supersededById === null &&
        r.redactedAt === null &&
        r.sensitivity !== "secret" &&
        params.allowedRealmIds.has(r.realmId) &&
        params.vis.canSeeRecord(r),
    )
    .sort(compareEntriesDesc);
}

/**
 * Checks whether an object (or any of its `within` descendants, and optionally `within` ancestors)
 * carries ANY active non-redacted rule across the org. Used strictly by I4 subtractive write guards
 * (`setObjectState` to inactive, `deleteObject`) so agents cannot evade rules in any realm.
 */
export function hasActiveRulesOnObjectHierarchy(params: {
  db: DbPort;
  orgId: string;
  objectId: string;
  includeAncestors?: boolean;
}): boolean {
  const allOrgObjects = params.db.listObjects({ orgId: params.orgId });
  const byId = new Map(allOrgObjects.map((o) => [o.id, o]));
  const root = byId.get(params.objectId);
  if (!root) return false;

  const targetObjIds = new Set<string>([
    root.id,
    ...getDescendantObjectIds(allOrgObjects, root.id),
  ]);

  if (params.includeAncestors) {
    const visited = new Set<string>([root.id]);
    let cur: MindObject | undefined = root;
    while (cur?.parentObjectId && !visited.has(cur.parentObjectId)) {
      visited.add(cur.parentObjectId);
      const parent = byId.get(cur.parentObjectId);
      if (!parent) break;
      targetObjIds.add(parent.id);
      cur = parent;
    }
  }

  const candidateEntryIds = new Set<string>(
    params.db.listEntryIdsForObjects(params.orgId, Array.from(targetObjIds)),
  );
  for (const oid of targetObjIds) {
    const o = byId.get(oid);
    if (!o) continue;
    const normTag = tryNormalizeResourceTag(`${o.kind}:${o.name}`);
    if (!normTag) continue;
    for (const eid of params.db.listEntryIdsByResourceTag(params.orgId, normTag)) {
      candidateEntryIds.add(eid);
    }
  }

  if (candidateEntryIds.size === 0) return false;
  const recs = params.db.getRecordsByIds(Array.from(candidateEntryIds));
  return recs.some(
    (r) =>
      r.orgId === params.orgId &&
      r.kind === "rule" &&
      r.status === "active" &&
      r.redactedAt === null,
  );
}
