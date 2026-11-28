import { normalizeSafeRelPath } from "../adapters/local-drive.js";
import type { ChangeLogAboutFilter, DbPort } from "../ports.js";
import {
  MindError,
  type AccessScope,
  type MindObject,
  type Realm,
} from "../types.js";
import {
  getDescendantObjectIds,
  normalizeResourceTag,
  OPAQUE_OBJECT_NOT_FOUND,
  resolveVisibleRealm,
} from "./objects.js";
import {
  parseDriveSourceRef,
  sanitizeRealmsForScope,
  type VisibilityHelpers,
} from "./visibility.js";

export const OPAQUE_FILE_NOT_FOUND = "File not found in visible scope";

const ENTRY_ID_RE = /^(rec|sea|dist)_[A-Za-z0-9_-]+$/;
const OBJECT_ID_RE = /^obj_[A-Za-z0-9_-]+$/;
const REALM_ID_RE = /^realm_[A-Za-z0-9_-]+$/;
const OBJECT_TAG_RE = /^([a-z][a-z0-9_-]*):([^\s]+)$/i;
const OBJECT_KIND_RE = /^[a-z][a-z0-9_-]*$/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * Returns true iff `<kind>:<name>` (and `/<realm>/<kind>:<name>`) cleanly round-trips
 * through `parseRefSyntax` without whitespace, control characters, slash collapsing,
 * or reserved prefix collision (`file:`, `drive://`).
 * Allows valid real-world names such as `repo:org/name`, `host:redis:6379`, `person:a@b.com`,
 * `service:api/v2`, `release:v1.2`, and Unicode/CJK names without whitespace.
 */
export function isRoundTrippableObjectRef(kind: string, name: string): boolean {
  if (!OBJECT_KIND_RE.test(kind) || kind === "file") {
    return false;
  }
  if (
    !name ||
    /\s/.test(name) ||
    CONTROL_CHAR_RE.test(name) ||
    name.includes("//") ||
    name.endsWith("/")
  ) {
    return false;
  }
  try {
    const bare = parseRefSyntax(`${kind}:${name}`);
    if (
      bare.kind !== "object" ||
      bare.objectKind !== kind ||
      bare.objectName !== name
    ) {
      return false;
    }
    const qualified = parseRefSyntax(`/r/${kind}:${name}`);
    if (
      qualified.kind !== "object" ||
      qualified.objectKind !== kind ||
      qualified.objectName !== name
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function assertValidObjectRefParts(kind: string, name: string): void {
  if (!OBJECT_KIND_RE.test(kind) || kind === "file") {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid object kind "${kind}". Kind must match /^[a-z][a-z0-9_-]*$/ and cannot be reserved "file".`,
      {
        try: 'meru-mind object create --in /ops --kind service --name api-gateway',
      },
    );
  }
  if (!isRoundTrippableObjectRef(kind, name)) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid object name "${name}" for kind "${kind}". Names cannot contain whitespace, control characters, "//", trailing "/", or collide with reserved ref prefixes.`,
      {
        try: `meru-mind object create --in /ops --kind ${kind} --name example-name`,
      },
    );
  }
}

export type ParsedRef =
  | {
      kind: "realm";
      raw: string;
      realmRef: string;
    }
  | {
      kind: "object";
      raw: string;
      objectId?: string;
      realmRef?: string;
      objectKind?: string;
      objectName?: string;
      normalizedTag?: string;
    }
  | {
      kind: "entry";
      raw: string;
      entryId: string;
    }
  | {
      kind: "file";
      raw: string;
      fileTarget: string;
      legacyDrive?: { realmId: string; relPath: string };
    };

function assertSafeFileTarget(target: string): void {
  if (target.includes("\0")) {
    throw new MindError(
      "INVALID_INPUT",
      "Invalid file reference: null byte is not allowed",
    );
  }
  if (target.includes("\\")) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid file reference "${target}": backslashes are not allowed`,
    );
  }
  const segments = target.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid file reference "${target}": path traversal segment "${seg}" is not allowed`,
      );
    }
  }
}

export function parseRefSyntax(rawInput: string): ParsedRef {
  const raw = rawInput.trim();
  if (!raw || /\s/.test(raw)) {
    throw new MindError(
      "INVALID_REF",
      `Invalid reference "${rawInput}". Expected /realm, @mounted/<alias>, <kind>:<name>, rec_.../sea_..., or file:/<realm>/<path>.`,
      { try: "meru-mind tree /" },
    );
  }

  // Legacy stored drive:// URI
  const legacyDrive = parseDriveSourceRef(raw);
  if (legacyDrive) {
    assertSafeFileTarget(legacyDrive.relPath);
    return {
      kind: "file",
      raw,
      fileTarget: legacyDrive.relPath,
      legacyDrive,
    };
  }

  // Canonical file: reference
  if (/^file:/i.test(raw)) {
    const rest = raw.slice(5);
    if (!rest) {
      throw new MindError(
        "INVALID_REF",
        `Invalid file reference "${raw}". Expected file:/<realm-path>/<rel-path> or file:@mounted/<alias>/<rel-path>.`,
        { try: "meru-mind ls --only files" },
      );
    }
    assertSafeFileTarget(rest);
    if (!rest.startsWith("/") && !/^@mounted\//i.test(rest)) {
      throw new MindError(
        "INVALID_REF",
        `Invalid file reference "${raw}". File ref must start with file:/ or file:@mounted/<alias>/.`,
        { try: "meru-mind show file:/readme.md" },
      );
    }
    return {
      kind: "file",
      raw,
      fileTarget: rest,
    };
  }

  // Exact entry IDs
  if (ENTRY_ID_RE.test(raw)) {
    return { kind: "entry", raw, entryId: raw };
  }

  // Exact object IDs
  if (OBJECT_ID_RE.test(raw)) {
    return { kind: "object", raw, objectId: raw };
  }

  // Exact realm IDs
  if (REALM_ID_RE.test(raw)) {
    return { kind: "realm", raw, realmRef: raw };
  }

  // @mounted/<alias> or @mounted/<alias>/<kind>:<name>
  if (/^@mounted\//i.test(raw)) {
    const parts = raw.split("/");
    if (parts.length < 2 || !parts[1]) {
      throw new MindError(
        "INVALID_REF",
        `Invalid mounted realm reference "${raw}". Expected @mounted/<alias>.`,
        { try: "meru-mind tree" },
      );
    }
    if (parts.length === 2) {
      if (parts[1]!.includes(":")) {
        throw new MindError(
          "INVALID_REF",
          `Invalid mounted realm reference "${raw}". Expected @mounted/<alias> or @mounted/<alias>/<kind>:<name>.`,
          { try: "meru-mind tree" },
        );
      }
      return { kind: "realm", raw, realmRef: raw };
    }
    const afterAlias = parts.slice(2).join("/");
    if (afterAlias.includes(":")) {
      const m = OBJECT_TAG_RE.exec(afterAlias);
      if (!m) {
        throw new MindError(
          "INVALID_REF",
          `Invalid realm-qualified object reference "${raw}". Expected @mounted/<alias>/<kind>:<name>.`,
          { try: "meru-mind tree" },
        );
      }
      const objectKind = m[1]!.toLowerCase();
      if (objectKind === "file") {
        throw new MindError(
          "INVALID_INPUT",
          'Prefix "file:" is reserved for file:<path> references; use file:@mounted/<alias>/<rel-path>',
          { try: `meru-mind show file:${parts[0]}/${parts[1]}/${m[2]}` },
        );
      }
      const objectName = m[2]!;
      return {
        kind: "object",
        raw,
        realmRef: `${parts[0]}/${parts[1]}`,
        objectKind,
        objectName,
        normalizedTag: `${objectKind}:${objectName}`,
      };
    }
    return { kind: "realm", raw, realmRef: raw };
  }

  // Slash path: either /realm/path OR realm-qualified /<realmPath>/<kind>:<name>
  if (raw.startsWith("/")) {
    const collapsed = raw.replace(/\/+/g, "/");
    if (collapsed === "/") {
      return { kind: "realm", raw, realmRef: "/" };
    }
    const stripped = collapsed.replace(/\/+$/, "");
    const segments = stripped.slice(1).split("/");
    const colonIdx = segments.findIndex((seg) => seg.includes(":"));
    if (colonIdx !== -1) {
      const realmRef =
        colonIdx === 0 ? "/" : `/${segments.slice(0, colonIdx).join("/")}`;
      const objPart = segments.slice(colonIdx).join("/");
      const m = OBJECT_TAG_RE.exec(objPart);
      if (!m) {
        throw new MindError(
          "INVALID_REF",
          `Invalid realm-qualified object reference "${raw}". Expected /<realmPath>/<kind>:<name>.`,
          { try: "meru-mind tree /" },
        );
      }
      const objectKind = m[1]!.toLowerCase();
      if (objectKind === "file") {
        throw new MindError(
          "INVALID_INPUT",
          'Prefix "file:" is reserved for file:<path> references; use file:/<realm>/<rel-path>',
          { try: `meru-mind show file:${realmRef === "/" ? "" : realmRef}/${m[2]}` },
        );
      }
      const objectName = m[2]!;
      return {
        kind: "object",
        raw,
        realmRef,
        objectKind,
        objectName,
        normalizedTag: `${objectKind}:${objectName}`,
      };
    }
    return { kind: "realm", raw, realmRef: stripped };
  }

  // Unqualified unified object <kind>:<name>
  const tagMatch = OBJECT_TAG_RE.exec(raw);
  if (tagMatch) {
    const objectKind = tagMatch[1]!.toLowerCase();
    const objectName = tagMatch[2]!;
    return {
      kind: "object",
      raw,
      objectKind,
      objectName,
      normalizedTag: `${objectKind}:${objectName}`,
    };
  }

  throw new MindError(
    "INVALID_REF",
    `Invalid reference "${raw}". Expected /realm, @mounted/<alias>, <kind>:<name>, rec_.../sea_..., or file:/<realm>/<path>.`,
    { try: "meru-mind tree /" },
  );
}

export function formatCanonicalFileRef(
  sanitizedRealmPath: string,
  relPath: string,
): string {
  const cleanRel = relPath.replace(/^\/+/, "");
  if (sanitizedRealmPath === "/") {
    return `file:/${cleanRel}`;
  }
  return `file:${sanitizedRealmPath}/${cleanRel}`;
}

export function formatStoredSourceRef(
  sourceRef: string | null,
  getSanitizedRealmPath: (realmId: string) => string,
): string | null {
  if (!sourceRef) return null;
  const parsed = parseDriveSourceRef(sourceRef);
  if (!parsed) return sourceRef;
  return formatCanonicalFileRef(
    getSanitizedRealmPath(parsed.realmId),
    parsed.relPath,
  );
}

export function formatRealmQualifiedObjectRef(
  sanitizedRealmPath: string,
  kind: string,
  name: string,
): string {
  const prefix = sanitizedRealmPath === "/" ? "" : sanitizedRealmPath;
  return `${prefix}/${kind}:${name}`;
}

export function computeDuplicateObjectKeys(objects: MindObject[]): Set<string> {
  const counts = new Map<string, Set<string>>();
  for (const obj of objects) {
    const key = `${obj.kind.toLowerCase()}:${obj.name.toLowerCase()}`;
    const realms = counts.get(key) ?? new Set<string>();
    realms.add(obj.realmId);
    counts.set(key, realms);
  }
  const dups = new Set<string>();
  for (const [key, realms] of counts.entries()) {
    if (realms.size >= 2) {
      dups.add(key);
    }
  }
  return dups;
}

export function formatCanonicalObjectRef(
  obj: MindObject,
  sanitizedRealmPath: string,
  duplicateKeys: Set<string>,
): string {
  const normalizedKind = obj.kind.toLowerCase();
  if (!isRoundTrippableObjectRef(normalizedKind, obj.name)) {
    return obj.id;
  }
  const key = `${normalizedKind}:${obj.name.toLowerCase()}`;
  if (duplicateKeys.has(key)) {
    return formatRealmQualifiedObjectRef(sanitizedRealmPath, obj.kind, obj.name);
  }
  return `${obj.kind}:${obj.name}`;
}

/**
 * Resolves a canonical `file:/<realm-path>/<rel-path>` or `file:@mounted/<alias>/<rel-path>`
 * reference using longest matching visible realm prefix in `scope.readableDriveIds`.
 * Traversal segments (`..`, `.`) and null bytes throw `INVALID_INPUT`; hidden or missing
 * realms return opaque `NOT_FOUND`.
 */
export function resolveFileRef(params: {
  realms: Realm[];
  orgId: string;
  ref: string;
  scope: AccessScope;
}): { realm: Realm; relPath: string; canonicalRef: string } {
  const parsed = parseRefSyntax(params.ref);
  if (parsed.kind !== "file") {
    throw new MindError(
      "INVALID_REF",
      `Expected file reference (file:/<realm>/<rel-path>), got "${params.ref}"`,
      { try: "meru-mind show file:/readme.md" },
    );
  }

  const orgRealms = params.realms.filter((r) => r.orgId === params.orgId);
  const sanitizedMap = sanitizeRealmsForScope(orgRealms, params.scope);
  const readableDriveSet = new Set(params.scope.readableDriveIds);

  if (parsed.legacyDrive) {
    const clean = sanitizedMap.get(parsed.legacyDrive.realmId);
    if (!clean || !readableDriveSet.has(clean.id)) {
      throw new MindError("NOT_FOUND", OPAQUE_FILE_NOT_FOUND);
    }
    const relPath = normalizeSafeRelPath(parsed.legacyDrive.relPath);
    return {
      realm: clean,
      relPath,
      canonicalRef: formatCanonicalFileRef(clean.path, relPath),
    };
  }

  const target = parsed.fileTarget;
  assertSafeFileTarget(target);

  if (/^@mounted\//i.test(target)) {
    const parts = target.split("/");
    if (parts.length < 3 || !parts[1] || !parts.slice(2).join("/")) {
      throw new MindError(
        "INVALID_REF",
        `Invalid mounted file reference "${params.ref}". Expected file:@mounted/<alias>/<rel-path>.`,
        { try: "meru-mind tree" },
      );
    }
    const mountPrefix = `${parts[0]}/${parts[1]}`.toLowerCase();
    const rawRel = parts.slice(2).join("/");
    let matched: Realm | null = null;
    for (const clean of sanitizedMap.values()) {
      if (!readableDriveSet.has(clean.id)) continue;
      if (clean.path.toLowerCase() === mountPrefix) {
        matched = clean;
        break;
      }
    }
    if (!matched) {
      throw new MindError("NOT_FOUND", OPAQUE_FILE_NOT_FOUND);
    }
    const relPath = normalizeSafeRelPath(rawRel);
    return {
      realm: matched,
      relPath,
      canonicalRef: formatCanonicalFileRef(matched.path, relPath),
    };
  }

  // Slash path: match LONGEST visible sanitized realm path prefix within readableDriveIds
  if (!target.startsWith("/") || target.endsWith("/")) {
    throw new MindError(
      "INVALID_REF",
      `Invalid file reference "${params.ref}". Expected file:/<realm-path>/<rel-path>.`,
      { try: "meru-mind show file:/readme.md" },
    );
  }
  const collapsed = target.replace(/\/+/g, "/");
  const lowerCollapsed = collapsed.toLowerCase();

  let bestRealm: Realm | null = null;
  let bestPrefixLen = -1;
  let bestRel = "";

  for (const clean of sanitizedMap.values()) {
    if (!readableDriveSet.has(clean.id)) continue;
    if (!clean.path.startsWith("/")) continue; // @mounted/* cannot be matched by real slash path
    if (clean.path === "/") {
      const rel = collapsed.slice(1);
      if (rel && 1 > bestPrefixLen) {
        bestPrefixLen = 1;
        bestRealm = clean;
        bestRel = rel;
      }
    } else {
      const prefixWithSlash = `${clean.path.toLowerCase()}/`;
      if (lowerCollapsed.startsWith(prefixWithSlash)) {
        const rel = collapsed.slice(clean.path.length + 1);
        if (rel && clean.path.length > bestPrefixLen) {
          bestPrefixLen = clean.path.length;
          bestRealm = clean;
          bestRel = rel;
        }
      }
    }
  }

  if (!bestRealm || !bestRel) {
    throw new MindError("NOT_FOUND", OPAQUE_FILE_NOT_FOUND);
  }

  const relPath = normalizeSafeRelPath(bestRel);
  return {
    realm: bestRealm,
    relPath,
    canonicalRef: formatCanonicalFileRef(bestRealm.path, relPath),
  };
}

export interface UnifiedObjectResolution {
  canonicalRef: string;
  objectKind: string;
  objectName: string;
  object: MindObject | null;
  realmPath: string | null;
  scopedRealmId: string | null;
  ledgerRealmIds: string[];
  seabedRealmIds: string[];
  entryIds: string[];
  thingEntryIds?: string[];
  countsBySource: {
    viaObject: number;
    viaTag: number;
    viaThing: number;
  };
}

/**
 * Resolves a unified object reference (`<kind>:<name>`, `/<realm>/<kind>:<name>`, or `obj_...`)
 * for reads (`show`, `ls`, `search --about`).
 *
 * - Strictly enforces `scope.readableLedgerIds` / `scope.readableSeabedIds`
 * - Hidden objects NEVER trigger `AMBIGUOUS_REF` and NEVER appear in `candidates`
 * - Realm-qualified reads scope strictly to the target realm's object + physically stored tags/things
 */
export function resolveUnifiedObjectRead(params: {
  db: DbPort;
  realms: Realm[];
  orgId: string;
  parsed: Extract<ParsedRef, { kind: "object" }>;
  scope: AccessScope;
  vis: VisibilityHelpers;
  verb: "show" | "ls" | "search";
  allowEmpty?: boolean;
}): UnifiedObjectResolution {
  const { db, realms, orgId, parsed, scope, vis, verb } = params;
  const readableLedgerSet = new Set(scope.readableLedgerIds);
  const readableSeabedSet = new Set(scope.readableSeabedIds);

  const allVisibleObjects = vis.sanitizeObjects(
    db.listObjects({
      orgId,
      realmIds: scope.readableLedgerIds,
    }),
  );

  const filterVisibleEntryIds = (
    rawIds: string[],
    restrictRealmId: string | null,
  ): string[] => {
    const unique = Array.from(new Set(rawIds));
    if (unique.length === 0) return [];
    const recs = db.getRecordsByIds(unique);
    const foundRecIds = new Set(recs.map((r) => r.id));
    const remainingForSea = unique.filter((id) => !foundRecIds.has(id));
    const seas =
      remainingForSea.length > 0 ? db.getSeabedEntriesByIds(remainingForSea) : [];

    const visible = new Set<string>();
    for (const r of recs) {
      if (
        r.orgId === orgId &&
        (!restrictRealmId || r.realmId === restrictRealmId) &&
        readableLedgerSet.has(r.realmId) &&
        r.sensitivity !== "secret" &&
        r.redactedAt === null &&
        r.status !== "retracted" &&
        vis.canSeeRecord(r)
      ) {
        visible.add(r.id);
      }
    }
    for (const s of seas) {
      if (
        s.orgId === orgId &&
        (!restrictRealmId || s.realmId === restrictRealmId) &&
        readableSeabedSet.has(s.realmId) &&
        s.sensitivity !== "secret" &&
        s.redactedAt === null &&
        vis.canSeeSeabed(s)
      ) {
        visible.add(s.id);
      }
    }
    return Array.from(visible);
  };

  // Case 1: Exact obj_... ID
  if (parsed.objectId) {
    const obj = allVisibleObjects.find((o) => o.id === parsed.objectId) ?? null;
    if (!obj) {
      throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
    }
    const objIds = [obj.id, ...getDescendantObjectIds(allVisibleObjects, obj.id)];
    const visibleObjectEntryIds = filterVisibleEntryIds(
      db.listEntryIdsForObjects(orgId, objIds),
      null,
    );
    const dupKeys = computeDuplicateObjectKeys(allVisibleObjects);
    const rPath = vis.getSanitizedRealmPath(obj.realmId);
    const canonicalRef = formatCanonicalObjectRef(obj, rPath, dupKeys);
    return {
      canonicalRef,
      objectKind: obj.kind,
      objectName: obj.name,
      object: obj,
      realmPath: rPath,
      scopedRealmId: null,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      entryIds: visibleObjectEntryIds,
      countsBySource: {
        viaObject: visibleObjectEntryIds.length,
        viaTag: 0,
        viaThing: 0,
      },
    };
  }

  const objectKind = parsed.objectKind!;
  const objectName = parsed.objectName!;
  const normalizedTag = normalizeResourceTag(`${objectKind}:${objectName}`);

  let scopedRealm: Realm | null = null;
  if (parsed.realmRef) {
    scopedRealm = resolveVisibleRealm({
      realms,
      orgId,
      ref: parsed.realmRef,
      scope,
    });
  }

  const matchingObjects = allVisibleObjects.filter((o) => {
    if (scopedRealm && o.realmId !== scopedRealm.id) return false;
    return (
      o.kind.toLowerCase() === objectKind &&
      o.name.toLowerCase() === objectName.toLowerCase()
    );
  });

  // Unqualified ambiguity check strictly over visible objects in distinct realms
  if (!scopedRealm && matchingObjects.length >= 2) {
    const distinctRealmIds = new Set(matchingObjects.map((o) => o.realmId));
    if (distinctRealmIds.size >= 2) {
      const candidates = matchingObjects
        .map((o) =>
          formatRealmQualifiedObjectRef(
            vis.getSanitizedRealmPath(o.realmId),
            o.kind,
            o.name,
          ),
        )
        .sort();
      const firstCand = candidates[0]!;
      const tryCmd =
        verb === "search"
          ? `meru-mind search "<query>" --about ${firstCand}`
          : `meru-mind ${verb} ${firstCand}`;
      throw new MindError(
        "AMBIGUOUS_REF",
        `Object "${objectKind}:${objectName}" exists in ${candidates.length} visible realms`,
        {
          candidates,
          try: tryCmd,
        },
      );
    }
  }

  const matchedObject = matchingObjects[0] ?? null;

  // 1. Entries via entry_objects (visible object + visible descendants), filtered strictly to caller's visible scope
  let objectEntryIds: string[] = [];
  if (matchedObject) {
    const objIds = [
      matchedObject.id,
      ...getDescendantObjectIds(allVisibleObjects, matchedObject.id),
    ];
    objectEntryIds = filterVisibleEntryIds(
      db.listEntryIdsForObjects(orgId, objIds),
      null,
    );
  }

  // 2. Entries via resource_tags, filtered strictly to caller's visible scope (and scopedRealm when qualified)
  const rawTagEntryIds = db.listEntryIdsByResourceTag(orgId, normalizedTag);
  const filteredTagEntryIds = filterVisibleEntryIds(
    rawTagEntryIds,
    scopedRealm ? scopedRealm.id : null,
  );

  // 3. Entries via records WHERE kind='thing' matching external_ref
  const thingLedgerRealmIds = scopedRealm
    ? readableLedgerSet.has(scopedRealm.id)
      ? [scopedRealm.id]
      : []
    : scope.readableLedgerIds;

  const thingCandidates = [
    ...db.findRecordsByExternalRef(
      orgId,
      normalizedTag,
      thingLedgerRealmIds,
      ["secret"],
    ),
    ...(objectKind === "thing"
      ? db.findRecordsByExternalRef(
          orgId,
          objectName,
          thingLedgerRealmIds,
          ["secret"],
        )
      : []),
  ].filter(
    (r) =>
      r.orgId === orgId &&
      r.kind === "thing" &&
      r.status === "active" &&
      r.redactedAt === null &&
      r.sensitivity !== "secret" &&
      readableLedgerSet.has(r.realmId) &&
      vis.canSeeRecord(r),
  );

  const thingEntryIdSet = new Set<string>();
  const seenThingIds = new Set<string>();
  for (const t of thingCandidates) {
    thingEntryIdSet.add(t.id);
    const tid = t.thingId ?? t.id;
    if (!seenThingIds.has(tid)) {
      seenThingIds.add(tid);
      const linked = db.listRecords({
        realmIds: thingLedgerRealmIds,
        thingId: tid,
        includeSuperseded: false,
        excludeSensitivities: ["secret"],
        limit: 500,
        offset: 0,
      });
      for (const r of linked.items) {
        if (
          r.orgId === orgId &&
          r.sensitivity !== "secret" &&
          r.redactedAt === null &&
          r.status !== "retracted" &&
          readableLedgerSet.has(r.realmId) &&
          vis.canSeeRecord(r)
        ) {
          thingEntryIdSet.add(r.id);
        }
      }
    }
  }

  const combinedEntryIds = Array.from(
    new Set([...objectEntryIds, ...filteredTagEntryIds, ...thingEntryIdSet]),
  );

  // Verify at least one visible non-secret non-redacted entry exists if there is no object row
  let visibleCount = 0;
  if (!matchedObject && combinedEntryIds.length > 0) {
    const check = db.lsEntriesByIdsUnified({
      orgId,
      entryIds: combinedEntryIds,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      includeSuperseded: true,
      excludeSensitivities: ["secret"],
      limit: 1,
      offset: 0,
    });
    visibleCount = check.total;
  }

  if (!matchedObject && visibleCount === 0 && !params.allowEmpty) {
    throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
  }

  const realmPath = scopedRealm
    ? scopedRealm.path
    : matchedObject
      ? vis.getSanitizedRealmPath(matchedObject.realmId)
      : null;

  const canonicalRef = scopedRealm
    ? formatRealmQualifiedObjectRef(
        scopedRealm.path,
        matchedObject?.kind ?? objectKind,
        matchedObject?.name ?? objectName,
      )
    : matchedObject
      ? `${matchedObject.kind}:${matchedObject.name}`
      : normalizedTag;

  return {
    canonicalRef,
    objectKind: matchedObject?.kind ?? objectKind,
    objectName: matchedObject?.name ?? objectName,
    object: matchedObject,
    realmPath,
    scopedRealmId: scopedRealm?.id ?? null,
    ledgerRealmIds: scope.readableLedgerIds,
    seabedRealmIds: scope.readableSeabedIds,
    entryIds: combinedEntryIds,
    thingEntryIds: Array.from(thingEntryIdSet),
    countsBySource: {
      viaObject: objectEntryIds.length,
      viaTag: filteredTagEntryIds.length,
      viaThing: thingEntryIdSet.size,
    },
  };
}

/**
 * Resolves repeatable `--about <objRef>` / `about[]` arguments on write paths:
 * 1. Unique visible `object` -> `objectIds`
 * 2. Ambiguous across >= 2 visible objects -> `AMBIGUOUS_REF` with visible `candidates` + `try`
 * 3. Matching visible active `thing` -> `thingId` + `<kind>:<name>` resource tag
 * 4. Valid `<type>:<name>` with no object row -> `resourceTags`
 * 5. `file:` prefix -> `INVALID_INPUT`; invalid format -> `INVALID_REF`
 */
export function resolveAboutRefsForWrite(params: {
  db: DbPort;
  realms: Realm[];
  orgId: string;
  about: string[];
  scope: AccessScope;
  vis: VisibilityHelpers;
}): {
  objectIds: string[];
  resourceTags: string[];
  thingId?: string;
} {
  const { db, realms, orgId, about, scope, vis } = params;
  const objectIds: string[] = [];
  const resourceTags: string[] = [];
  let thingId: string | undefined;

  if (about.length === 0) {
    return { objectIds, resourceTags };
  }

  const allVisibleObjects = vis.sanitizeObjects(
    db.listObjects({
      orgId,
      realmIds: scope.readableLedgerIds,
    }),
  );

  for (const raw of about) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const parsed = parseRefSyntax(trimmed);
    if (parsed.kind === "file") {
      throw new MindError(
        "INVALID_INPUT",
        'Prefix "file:" is reserved for files and cannot be used with --about',
        { try: 'meru-mind write --in /ops --title "..." --body "..." --about service:api' },
      );
    }
    if (parsed.kind !== "object") {
      throw new MindError(
        "INVALID_REF",
        `Invalid --about reference "${raw}": expected "<kind>:<name>", "/<realm>/<kind>:<name>", or "obj_..."`,
        { try: 'meru-mind write --in /ops --title "..." --body "..." --about service:api' },
      );
    }

    if (parsed.objectId) {
      const obj = allVisibleObjects.find((o) => o.id === parsed.objectId);
      if (!obj) {
        throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
      }
      objectIds.push(obj.id);
      continue;
    }

    const objectKind = parsed.objectKind!;
    const objectName = parsed.objectName!;
    const normalizedTag = normalizeResourceTag(`${objectKind}:${objectName}`);

    let scopedRealm: Realm | null = null;
    if (parsed.realmRef) {
      scopedRealm = resolveVisibleRealm({
        realms,
        orgId,
        ref: parsed.realmRef,
        scope,
      });
    }

    const matches = allVisibleObjects.filter((o) => {
      if (scopedRealm && o.realmId !== scopedRealm.id) return false;
      return (
        o.kind.toLowerCase() === objectKind &&
        o.name.toLowerCase() === objectName.toLowerCase()
      );
    });

    if (!scopedRealm && matches.length >= 2) {
      const distinctRealms = new Set(matches.map((m) => m.realmId));
      if (distinctRealms.size >= 2) {
        const candidates = matches
          .map((m) =>
            formatRealmQualifiedObjectRef(
              vis.getSanitizedRealmPath(m.realmId),
              m.kind,
              m.name,
            ),
          )
          .sort();
        throw new MindError(
          "AMBIGUOUS_REF",
          `Object "${objectKind}:${objectName}" exists in ${candidates.length} visible realms`,
          {
            candidates,
            try: `meru-mind write --in <realm> --title "<title>" --body "<body>" --about ${candidates[0]}`,
          },
        );
      }
    }

    if (matches.length >= 1) {
      objectIds.push(matches[0]!.id);
      continue;
    }

    // Check matching visible active thing record
    const thingRealms = scopedRealm ? [scopedRealm.id] : scope.readableLedgerIds;
    const thingMatches = [
      ...db.findRecordsByExternalRef(orgId, normalizedTag, thingRealms, ["secret"]),
      ...(objectKind === "thing"
        ? db.findRecordsByExternalRef(orgId, objectName, thingRealms, ["secret"])
        : []),
    ].filter(
      (r) =>
        r.kind === "thing" &&
        r.status === "active" &&
        r.redactedAt === null &&
        r.sensitivity !== "secret" &&
        vis.canSeeRecord(r),
    );

    if (thingMatches.length > 0) {
      if (!thingId) {
        thingId = thingMatches[0]!.thingId ?? thingMatches[0]!.id;
      }
      resourceTags.push(normalizedTag);
      continue;
    }

    // Otherwise attach valid <type>:<name> resource tag
    resourceTags.push(normalizedTag);
  }

  return {
    objectIds: Array.from(new Set(objectIds)).sort(),
    resourceTags: Array.from(new Set(resourceTags)).sort(),
    ...(thingId ? { thingId } : {}),
  };
}

/**
 * Resolves `changes --about <objRef>` into a SQL-pushable `ChangeLogAboutFilter`.
 * Uses the exact same visibility-checked resolver as `show`/`ls`/`search` so hidden vs
 * nonexistent objects return byte-identical opaque `NOT_FOUND` errors (`V9` / `L3`).
 */
export function resolveChangeAboutFilter(params: {
  db: DbPort;
  realms: Realm[];
  orgId: string;
  aboutRef: string;
  scope: AccessScope;
  vis: VisibilityHelpers;
}): ChangeLogAboutFilter {
  const trimmed = params.aboutRef.trim();
  const parsed = parseRefSyntax(trimmed);
  if (parsed.kind !== "object") {
    throw new MindError(
      "INVALID_REF",
      `Invalid --about reference "${params.aboutRef}": expected <kind>:<name>, /<realm>/<kind>:<name>, or obj_...`,
      { try: "meru-mind changes --since 0 --about service:api" },
    );
  }
  const resolved = resolveUnifiedObjectRead({
    db: params.db,
    realms: params.realms,
    orgId: params.orgId,
    parsed,
    scope: params.scope,
    vis: params.vis,
    verb: "show",
    allowEmpty: false,
  });

  let objectIds: string[] = [];
  if (resolved.object) {
    const allVisibleObjects = params.vis.sanitizeObjects(
      params.db.listObjects({
        orgId: params.orgId,
        realmIds: params.scope.readableLedgerIds,
      }),
    );
    objectIds = [
      resolved.object.id,
      ...getDescendantObjectIds(allVisibleObjects, resolved.object.id),
    ];
  }

  let resourceTag: string | null = null;
  try {
    resourceTag = normalizeResourceTag(
      `${resolved.objectKind}:${resolved.objectName}`,
    );
  } catch {
    resourceTag = null;
  }

  return {
    objectIds,
    resourceTag,
    scopedRealmId: resolved.scopedRealmId,
    thingEntryIds: resolved.thingEntryIds ?? [],
  };
}
