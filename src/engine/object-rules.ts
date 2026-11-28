import { getAncestorIds, getDescendantIds } from "../policy.js";
import type { DbPort } from "../ports.js";
import type {
  AccessScope,
  CardStaleReason,
  Distillation,
  LedgerRecord,
  MindObject,
  ObjectBriefRule,
  ObjectCardFreshness,
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
  const rawRules: LedgerRecord[] = [];
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const page = params.db.listRecords({
      realmIds: governingList,
      kinds: ["rule"],
      includeSuperseded: false,
      excludeSensitivities: ["secret"],
      limit: pageSize,
      offset,
    });
    rawRules.push(...page.items);
    if (page.items.length < pageSize || rawRules.length >= page.total) {
      break;
    }
    offset += page.items.length;
  }

  const allRules = rawRules.filter(
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
 * is governed by ANY active non-redacted non-secret rule, using the exact same governance
 * definition as read-side `collectObjectScopedRules` (L8 object ∪ tag + L9 same-`kind:name`
 * objects inside each target object's governing realms `ancestors(o.realmId) ∪ {o.realmId}`).
 *
 * Used strictly by I4 subtractive write guards (`setObjectState` to inactive, `deleteObject`).
 * - Strictly excludes sibling realms and `secret` rules (zero cross-wall probe or sibling DoS).
 * - Strictly requires governing rules of object `o` to reside in `ancestors(o.realmId) ∪ {o.realmId}`
 *   (prevents child realms from linking a descendant rule directly onto a parent object to DoS-lock it).
 * - Includes L9 same-`kind:name` ancestor objects so `/service:api` rules protect `/b1/service:api`.
 */
export function hasActiveRulesOnObjectHierarchy(params: {
  db: DbPort;
  realms: Realm[];
  orgId: string;
  objectId: string;
  includeAncestors?: boolean;
}): boolean {
  const root = params.db.getObject(params.objectId);
  if (!root || root.orgId !== params.orgId) return false;

  const orgRealms = params.realms.filter((r) => r.orgId === params.orgId);
  const orgRealmsById = new Map(orgRealms.map((r) => [r.id, r]));
  const lineageRealms = new Set<string>([
    root.realmId,
    ...getAncestorIds(orgRealmsById, root.realmId),
    ...getDescendantIds(orgRealms, root.realmId),
  ]);

  const lineageObjects = params.db.listObjects({
    orgId: params.orgId,
    realmIds: Array.from(lineageRealms),
  });
  const byId = new Map(lineageObjects.map((o) => [o.id, o]));
  if (!byId.has(root.id)) {
    byId.set(root.id, root);
  }

  const targetObjIds = new Set<string>([
    root.id,
    ...getDescendantObjectIds(lineageObjects, root.id),
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

  // Group lineage objects by case-folded `(kind, name)` for L9 same-name governance lookup
  // (matches read-side `collectObjectScopedRules` case-insensitive comparison 1-for-1).
  const objectsByKindName = new Map<string, MindObject[]>();
  for (const o of lineageObjects) {
    const key = `${o.kind.toLowerCase()}\0${o.name.toLowerCase()}`;
    let list = objectsByKindName.get(key);
    if (!list) {
      list = [];
      objectsByKindName.set(key, list);
    }
    list.push(o);
  }

  // Map each candidate entryId -> union of governing realms in which a rule would govern at least one target object `o`.
  const allowedRealmsByEntryId = new Map<string, Set<string>>();
  const addCandidates = (entryIds: string[], govRealms: Set<string>): void => {
    for (const eid of entryIds) {
      let allowed = allowedRealmsByEntryId.get(eid);
      if (!allowed) {
        allowed = new Set<string>();
        allowedRealmsByEntryId.set(eid, allowed);
      }
      for (const rid of govRealms) {
        allowed.add(rid);
      }
    }
  };

  for (const oid of targetObjIds) {
    const o = byId.get(oid);
    if (!o) continue;
    const objGovRealms = new Set<string>([
      o.realmId,
      ...getAncestorIds(orgRealmsById, o.realmId),
    ]);

    // L8 + L9 direct object links: `o` itself plus any same-(kind,name) object in `objGovRealms` (case-insensitive)
    const sameNameObjs =
      objectsByKindName.get(`${o.kind.toLowerCase()}\0${o.name.toLowerCase()}`) ??
      [];
    const governingObjIds = new Set<string>([o.id]);
    for (const peer of sameNameObjs) {
      if (objGovRealms.has(peer.realmId)) {
        governingObjIds.add(peer.id);
      }
    }
    addCandidates(
      params.db.listEntryIdsForObjects(params.orgId, Array.from(governingObjIds)),
      objGovRealms,
    );

    // L8 resource-tag matches in `objGovRealms`
    const normTag = tryNormalizeResourceTag(`${o.kind}:${o.name}`);
    if (normTag) {
      addCandidates(
        params.db.listEntryIdsByResourceTag(params.orgId, normTag),
        objGovRealms,
      );
    }
  }

  if (allowedRealmsByEntryId.size === 0) return false;
  const recs = params.db.getRecordsByIds(Array.from(allowedRealmsByEntryId.keys()));
  return recs.some(
    (r) =>
      r.orgId === params.orgId &&
      r.kind === "rule" &&
      r.status === "active" &&
      r.redactedAt === null &&
      r.sensitivity !== "secret" &&
      Boolean(allowedRealmsByEntryId.get(r.id)?.has(r.realmId)),
  );
}

/**
 * Single authoritative entry-ID collector for a real `MindObject` used identically by
 * `settle --layer card_object` and deterministic per-reader `V3` freshness evaluation.
 * Collects entries linked to the object + its visible `within` descendants inside `allowedRealmIds`,
 * unioned with `resource_tags` matching `<kind>:<name>`.
 */
export function collectObjectCardEntryIds(params: {
  db: DbPort;
  orgId: string;
  object: MindObject;
  sanitizedVisibleObjects: MindObject[];
  allowedRealmIds: Set<string>;
}): string[] {
  const objectsInAllowed = params.sanitizedVisibleObjects.filter((o) =>
    params.allowedRealmIds.has(o.realmId),
  );
  const subtreeObjIds = [
    params.object.id,
    ...getDescendantObjectIds(objectsInAllowed, params.object.id),
  ];
  const viaObj = params.db.listEntryIdsForObjects(params.orgId, subtreeObjIds);
  const normTag = tryNormalizeResourceTag(
    `${params.object.kind}:${params.object.name}`,
  );
  const viaTag = normTag
    ? params.db.listEntryIdsByResourceTag(params.orgId, normTag)
    : [];
  return Array.from(new Set([...viaObj, ...viaTag]));
}

/**
 * Matches the EXACT full ECMA-262 horizontal `\s` whitespace set (all non-line-terminator
 * code points matched by JS `/\s/`): ASCII space/tab, NBSP, Ogham space, U+2000..U+200A,
 * narrow NBSP, medium mathematical space, CJK full-width space, and BOM/ZWNBSP.
 * (All line-breaking `\s` characters are normalized to `\n` before per-line classification.)
 */
function isMarkdownSpace(code: number): boolean {
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/**
 * Linear-time O(n) classifier for a single trimmed line body after iteratively peeling arbitrary
 * leading whitespace, blockquote `>`, and CommonMark list markers (`- `, `* `, `+ `, `1. `, `1) `).
 * Zero backtracking regexes — safe against 32 KB adversarial inputs.
 */
function classifyMarkdownHeadingLine(line: string): {
  listMarkers: string[];
  headingKind: "atx" | "setext" | null;
  atxText: string;
} {
  let end = line.length;
  while (end > 0 && isMarkdownSpace(line.charCodeAt(end - 1))) {
    end--;
  }
  let pos = 0;
  const listMarkers: string[] = [];

  while (pos < end) {
    while (pos < end && isMarkdownSpace(line.charCodeAt(pos))) {
      pos++;
    }
    if (pos >= end) break;

    const ch = line.charCodeAt(pos);
    // Blockquote marker `>`
    if (ch === 0x3e /* '>' */) {
      pos++;
      if (pos < end && isMarkdownSpace(line.charCodeAt(pos))) {
        pos++;
      }
      continue;
    }

    // Unordered list marker `-`, `*`, `+` followed by space/tab AND non-empty rest
    if (
      (ch === 0x2d /* '-' */ || ch === 0x2a /* '*' */ || ch === 0x2b /* '+' */) &&
      pos + 1 < end &&
      isMarkdownSpace(line.charCodeAt(pos + 1))
    ) {
      const marker = line[pos]!;
      let next = pos + 1;
      while (next < end && isMarkdownSpace(line.charCodeAt(next))) {
        next++;
      }
      if (next < end) {
        listMarkers.push(marker);
        pos = next;
        continue;
      }
    }

    // Ordered list marker: 1..9 ASCII digits + `.` or `)` followed by space/tab AND non-empty rest
    if (ch >= 0x30 && ch <= 0x39) {
      let d = pos;
      while (d < end && d - pos < 9 && line.charCodeAt(d) >= 0x30 && line.charCodeAt(d) <= 0x39) {
        d++;
      }
      if (
        d > pos &&
        d < end &&
        (line.charCodeAt(d) === 0x2e /* '.' */ || line.charCodeAt(d) === 0x29 /* ')' */) &&
        d + 1 < end &&
        isMarkdownSpace(line.charCodeAt(d + 1))
      ) {
        const marker = line.slice(pos, d + 1);
        let next = d + 1;
        while (next < end && isMarkdownSpace(line.charCodeAt(next))) {
          next++;
        }
        if (next < end) {
          listMarkers.push(marker);
          pos = next;
          continue;
        }
      }
    }

    break;
  }

  if (pos >= end) {
    return { listMarkers, headingKind: null, atxText: "" };
  }

  // Check CommonMark ATX heading: 1..6 `#` followed by end-of-line or space/tab
  if (line.charCodeAt(pos) === 0x23 /* '#' */) {
    let h = pos;
    while (h < end && h - pos < 6 && line.charCodeAt(h) === 0x23) {
      h++;
    }
    if (h === end || isMarkdownSpace(line.charCodeAt(h))) {
      let textStart = h;
      while (textStart < end && isMarkdownSpace(line.charCodeAt(textStart))) {
        textStart++;
      }
      // CommonMark optional closing `#` sequence (must be preceded by space/tab or be entire text)
      let textEnd = end;
      let hashEnd = textEnd;
      while (hashEnd > textStart && line.charCodeAt(hashEnd - 1) === 0x23) {
        hashEnd--;
      }
      if (hashEnd < textEnd && (hashEnd === textStart || isMarkdownSpace(line.charCodeAt(hashEnd - 1)))) {
        textEnd = hashEnd;
        while (textEnd > textStart && isMarkdownSpace(line.charCodeAt(textEnd - 1))) {
          textEnd--;
        }
      }
      return {
        listMarkers,
        headingKind: "atx",
        atxText: line.slice(textStart, textEnd),
      };
    }
  }

  // Check CommonMark Setext underline: non-empty sequence of all `=` OR all `-`
  const firstCode = line.charCodeAt(pos);
  if (firstCode === 0x3d /* '=' */ || firstCode === 0x2d /* '-' */) {
    let allSame = true;
    for (let k = pos + 1; k < end; k++) {
      if (line.charCodeAt(k) !== firstCode) {
        allSame = false;
        break;
      }
    }
    if (allSame) {
      return { listMarkers, headingKind: "setext", atxText: "" };
    }
  }

  return { listMarkers, headingKind: null, atxText: "" };
}

/**
 * Strips leading blockquote markers (`>`) and trailing spaces in O(n) linear time.
 */
function stripLeadingBlockquotesLinear(line: string): string {
  let end = line.length;
  while (end > 0 && isMarkdownSpace(line.charCodeAt(end - 1))) {
    end--;
  }
  let pos = 0;
  while (pos < end) {
    let scan = pos;
    while (scan < end && isMarkdownSpace(line.charCodeAt(scan))) {
      scan++;
    }
    if (scan < end && line.charCodeAt(scan) === 0x3e /* '>' */) {
      pos = scan + 1;
      if (pos < end && isMarkdownSpace(line.charCodeAt(pos))) {
        pos++;
      }
      continue;
    }
    break;
  }
  return line.slice(pos, end);
}

/**
 * Prompt-injection guard for L3 narrative cards (`#7`):
 * - Normalizes ALL ASCII and Unicode line breaks (`\r\n`, lone `\r`, `\u2028`, `\u2029`, `\u0085`, `\v`, `\f`)
 *   and strips NUL bytes before line splitting.
 * - Uses O(n) linear-time container peeling (`classifyMarkdownHeadingLine`, zero regex backtracking)
 *   to demote ATX headings and neutralize Setext underlines at arbitrary container nesting depth.
 * - Enforces an explicit output-invariant post-check on EVERY emitted line body (`classifyMarkdownHeadingLine(outBody)`)
 *   so reconstructed lines (e.g. `- #` -> empty ATX) can NEVER turn back into a Setext underline (`-`) or ATX heading.
 * - Prefixes every line as a flat blockquote (`> ...`) so narrative text produces ZERO CommonMark headings.
 */
export function sanitizeNarrativeForAgent(md: string): string {
  const normalized = md
    .replace(/\r\n?|[\u2028\u2029\u0085\v\f]/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
  if (!normalized) return "> _(empty)_";
  const lines = normalized.split("\n");
  return lines
    .map((rawLine) => {
      const parsed = classifyMarkdownHeadingLine(rawLine);
      const listPrefix =
        parsed.listMarkers.length > 0 ? `${parsed.listMarkers.join(" ")} ` : "";

      let outBody: string;
      if (parsed.headingKind === "atx") {
        // Empty ATX (e.g. `#`, `- #`, `> - ##`) discards listPrefix so it can NEVER become `> -` (Setext H2)!
        outBody = parsed.atxText ? `${listPrefix}**${parsed.atxText}**` : "";
      } else if (parsed.headingKind === "setext") {
        outBody = `${listPrefix}—`;
      } else {
        outBody = stripLeadingBlockquotesLinear(rawLine);
      }

      // Output-invariant post-check: guarantee the emitted line body itself can NEVER parse as ATX or Setext
      if (outBody && classifyMarkdownHeadingLine(outBody).headingKind !== null) {
        outBody = "—";
      }

      return outBody ? `> ${outBody}` : ">";
    })
    .join("\n");
}

/**
 * Deterministic per-reader V3 freshness evaluation for `card_object` distillations.
 *
 * - Computed strictly on-the-fly per reader; NEVER persisted, cached, or emitted in live-pulse/ETag.
 * - Evaluates strictly within `readerVisibleLedgerRealms ∩ dist.hardFacts.basisRealmIds`
 *   so hidden sibling entries never flip a card stale AND wider readers never see false staleness.
 * - Missing or malformed `basisRealmIds` fails safe to `hard_stale`.
 * - Uses the exact same `collectObjectCardEntryIds`, `collectActiveDecisionHeads`, and
 *   `collectObjectScopedRules` (object + upward `within` ancestors ONLY; NO Wall rules; NO `--with`)
 *   that `settle card_object` used at write time.
 */
export function evaluateCardObjectFreshness(params: {
  db: DbPort;
  realms: Realm[];
  orgId: string;
  dist: Distillation;
  object: MindObject;
  scope: AccessScope;
  vis: VisibilityHelpers;
  sanitizedVisibleObjects: MindObject[];
}): ObjectCardFreshness {
  const { db, realms, orgId, dist, object, scope, vis, sanitizedVisibleObjects } =
    params;

  const rawBasis = dist.hardFacts?.basisRealmIds;
  if (
    !Array.isArray(rawBasis) ||
    !rawBasis.every((x) => typeof x === "string")
  ) {
    const msg = "已过时：卡片缺少基线范围信息（需重新 settle）";
    return {
      status: "hard_stale",
      reasons: [
        {
          kind: "missing_basis",
          message: msg,
        },
      ],
      summaryLine: msg,
      addedDecisionIds: [],
      removedDecisionIds: [],
      addedRuleIds: [],
      removedRuleIds: [],
    };
  }

  const readerLedgerSet = new Set(scope.readableLedgerIds);
  const effectiveRealms = new Set(
    rawBasis.filter((rid) => readerLedgerSet.has(rid)),
  );

  const cardEntryIds = collectObjectCardEntryIds({
    db,
    orgId,
    object,
    sanitizedVisibleObjects,
    allowedRealmIds: effectiveRealms,
  });
  const currentDecisions = collectActiveDecisionHeads({
    db,
    orgId,
    entryIds: cardEntryIds,
    vis,
    allowedRealmIds: effectiveRealms,
  });
  const currentRules = collectObjectScopedRules({
    db,
    realms,
    orgId,
    object,
    objectKind: object.kind,
    objectName: object.name,
    scopedRealmId: object.realmId,
    scope,
    vis,
    sanitizedVisibleObjects,
    scopeSource: "object",
    allowedRealmIds: effectiveRealms,
  });

  const baseDecisionIds = Array.isArray(dist.hardFacts?.activeDecisionIds)
    ? dist.hardFacts.activeDecisionIds.filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  const baseRuleIds = Array.isArray(dist.hardFacts?.activeRuleIds)
    ? dist.hardFacts.activeRuleIds.filter(
        (x): x is string => typeof x === "string",
      )
    : [];

  const baseDecisionSet = new Set(baseDecisionIds);
  const baseRuleSet = new Set(baseRuleIds);
  const curDecisionIds = currentDecisions.map((d) => d.id);
  const curRuleIds = currentRules.map((r) => r.id);
  const curDecisionSet = new Set(curDecisionIds);
  const curRuleSet = new Set(curRuleIds);

  const removedDecisionIds = baseDecisionIds.filter(
    (id) => !curDecisionSet.has(id),
  );
  const addedDecisionIds = curDecisionIds.filter(
    (id) => !baseDecisionSet.has(id),
  );
  const removedRuleIds = baseRuleIds.filter((id) => !curRuleSet.has(id));
  const addedRuleIds = curRuleIds.filter((id) => !baseRuleSet.has(id));

  const reasons: CardStaleReason[] = [];
  const hardReasonMsgs: string[] = [];

  for (const id of removedDecisionIds) {
    const rec = db.getRecord(id);
    const headId =
      rec && vis.canSeeRecord(rec) ? vis.resolveCurrentHeadId(rec) : null;
    if (headId) {
      const message = `${id} 已被 ${headId} 取代`;
      reasons.push({
        kind: "decision_superseded",
        entryId: id,
        replacedById: headId,
        message,
      });
      hardReasonMsgs.push(message);
    } else {
      const message = `决定 ${id} 已失效`;
      reasons.push({
        kind: "decision_removed",
        entryId: id,
        replacedById: null,
        message,
      });
      hardReasonMsgs.push(message);
    }
  }

  for (const id of removedRuleIds) {
    const rec = db.getRecord(id);
    const headId =
      rec && vis.canSeeRecord(rec) ? vis.resolveCurrentHeadId(rec) : null;
    const message = headId
      ? `规矩 ${id} 已被 ${headId} 取代`
      : `规矩 ${id} 已失效`;
    reasons.push({
      kind: "rule_removed",
      entryId: id,
      replacedById: headId,
      message,
    });
    hardReasonMsgs.push(message);
  }

  for (const id of addedRuleIds) {
    const message = `新增规矩 ${id}`;
    reasons.push({
      kind: "rule_added",
      entryId: id,
      message,
    });
    hardReasonMsgs.push(message);
  }

  if (addedDecisionIds.length > 0) {
    reasons.push({
      kind: "decision_added",
      count: addedDecisionIds.length,
      message: `其后新增：决定 +${addedDecisionIds.length}`,
    });
  }

  if (
    removedDecisionIds.length > 0 ||
    removedRuleIds.length > 0 ||
    addedRuleIds.length > 0
  ) {
    const preview = hardReasonMsgs.slice(0, 2).join("；");
    const extra =
      hardReasonMsgs.length > 2
        ? ` 等 ${hardReasonMsgs.length} 项变更`
        : "";
    return {
      status: "hard_stale",
      reasons,
      summaryLine: `已过时：${preview}${extra}（需重新 settle）`,
      addedDecisionIds,
      removedDecisionIds,
      addedRuleIds,
      removedRuleIds,
    };
  }

  if (addedDecisionIds.length > 0) {
    return {
      status: "soft_stale",
      reasons,
      summaryLine: `其后新增：决定 +${addedDecisionIds.length}`,
      addedDecisionIds,
      removedDecisionIds,
      addedRuleIds,
      removedRuleIds,
    };
  }

  return {
    status: "fresh",
    reasons: [],
    summaryLine: null,
    addedDecisionIds: [],
    removedDecisionIds: [],
    addedRuleIds: [],
    removedRuleIds: [],
  };
}
