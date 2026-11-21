import {
  MindError,
  type AccessLevel,
  type AccessScope,
  type Actor,
  type AssetKind,
  type OrgPolicy,
  type Realm,
  type RealmMount,
  type VisibleScope,
} from "./types.js";

/**
 * Computes the strict ancestor chain of a realm from root down to parent (excluding self).
 */
export function getAncestorIds(
  realmsById: Map<string, Realm>,
  realmId: string,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>([realmId]);
  let current = realmsById.get(realmId);
  while (current && current.parentId) {
    if (visited.has(current.parentId)) {
      throw new MindError(
        "INVALID_INPUT",
        `Cycle detected in realm ancestry at ${current.parentId}`,
      );
    }
    visited.add(current.parentId);
    const parent = realmsById.get(current.parentId);
    if (!parent) {
      break;
    }
    result.unshift(parent.id);
    current = parent;
  }
  return result;
}

/**
 * Computes all strict descendant realm IDs within the same organization.
 */
export function getDescendantIds(
  realms: Realm[],
  realmId: string,
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const realm of realms) {
    if (!realm.parentId) continue;
    const list = childrenByParent.get(realm.parentId) ?? [];
    list.push(realm.id);
    childrenByParent.set(realm.parentId, list);
  }

  const descendants: string[] = [];
  const queue = [...(childrenByParent.get(realmId) ?? [])];
  const visited = new Set<string>([realmId]);

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    descendants.push(id);
    const kids = childrenByParent.get(id);
    if (kids) {
      queue.push(...kids);
    }
  }
  return descendants;
}

/**
 * The single authoritative MindRealm visibility rule.
 * Every entrypoint (CLI, MCP, SDK, slice export, FTS5, sqlite-vec) MUST pass through here.
 *
 * Visibility matrix (for tree A -> B1 -> C1, A -> B2 -> C2):
 * - Cross-organization: always "none"
 * - Self (C2 -> C2):
 *     - rule: "write" for human, "read" for agent/system
 *     - ledger / drive / seabed: "write"
 * - Ancestor (C2 -> A, B2): "read" for all asset kinds
 * - Descendant (B2 -> C2):
 *     - rule / ledger / drive: "read" by default
 *     - seabed: "read" only when explicitDescendantDive=true, else "none"
 * - Explicit @mount (C2 mounts C1): "read" for mounted scopes (never "write")
 * - Sibling / unrelated (C2 -> B1, C1): "none" (completely invisible)
 */
export function resolveAccess(params: {
  realms: Realm[];
  mounts: RealmMount[];
  actor: Actor;
  viewerRealmId: string;
  targetRealmId: string;
  assetKind: AssetKind;
  explicitDescendantDive?: boolean;
  orgPolicy?: OrgPolicy;
}): AccessLevel {
  const {
    realms,
    mounts,
    actor,
    viewerRealmId,
    targetRealmId,
    assetKind,
    explicitDescendantDive = false,
    orgPolicy = "tree",
  } = params;

  const realmsById = new Map(realms.map((r) => [r.id, r]));
  const viewer = realmsById.get(viewerRealmId);
  const target = realmsById.get(targetRealmId);

  if (!viewer || !target) {
    return "none";
  }

  // Organization is a hard boundary; realms and agents never cross orgs (in both open and tree modes).
  if (viewer.orgId !== target.orgId) {
    return "none";
  }

  // In "open" org policy, all realms within the same organization are readable & writable
  // (rules still strictly require human actors; cross-org remains "none").
  if (orgPolicy === "open") {
    if (assetKind === "rule") {
      return actor.kind === "human" ? "write" : "read";
    }
    return "write";
  }

  // 1. Self
  if (viewerRealmId === targetRealmId) {
    if (assetKind === "rule") {
      return actor.kind === "human" ? "write" : "read";
    }
    return "write";
  }

  // 2. Ancestor (inherited read-only)
  const ancestors = getAncestorIds(realmsById, viewerRealmId);
  if (ancestors.includes(targetRealmId)) {
    return "read";
  }

  // 3. Descendant (parent sees ledger/rules/drive by default; seabed only on explicit dive)
  const targetAncestors = getAncestorIds(realmsById, targetRealmId);
  if (targetAncestors.includes(viewerRealmId)) {
    if (assetKind === "seabed") {
      return explicitDescendantDive ? "read" : "none";
    }
    return "read";
  }

  // 4. Explicit read-only @mount
  for (const mount of mounts) {
    if (
      mount.viewerRealmId === viewerRealmId &&
      mount.targetRealmId === targetRealmId
    ) {
      if (mount.scope === "all") {
        return "read";
      }
      if (
        mount.scope === "ledger" &&
        (assetKind === "ledger" || assetKind === "rule")
      ) {
        return "read";
      }
      if (mount.scope === "drive" && assetKind === "drive") {
        return "read";
      }
    }
  }

  // 5. Sibling or unrelated branch: strictly invisible
  return "none";
}

/**
 * Pre-computes all visible realm IDs from a viewer realm for safe SQL/FTS/vector pre-filtering.
 */
export function computeVisibleScope(params: {
  realms: Realm[];
  mounts: RealmMount[];
  viewerRealmId: string;
  includeDescendantSeabed?: boolean;
}): VisibleScope {
  const {
    realms,
    mounts,
    viewerRealmId,
    includeDescendantSeabed = false,
  } = params;
  const realmsById = new Map(realms.map((r) => [r.id, r]));
  const viewer = realmsById.get(viewerRealmId);
  if (!viewer) {
    throw new MindError("NOT_FOUND", `Realm not found: ${viewerRealmId}`);
  }

  const orgRealms = realms.filter((r) => r.orgId === viewer.orgId);
  const orgRealmsById = new Map(orgRealms.map((r) => [r.id, r]));

  const ancestorIds = getAncestorIds(orgRealmsById, viewerRealmId);
  const descendantIds = getDescendantIds(orgRealms, viewerRealmId);

  const mountedLedgerIds: string[] = [];
  const mountedDriveIds: string[] = [];
  const mountedSeabedIds: string[] = [];

  for (const mount of mounts) {
    if (mount.viewerRealmId !== viewerRealmId) continue;
    const target = orgRealmsById.get(mount.targetRealmId);
    if (!target) continue;
    if (mount.scope === "all" || mount.scope === "ledger") {
      mountedLedgerIds.push(target.id);
    }
    if (mount.scope === "all" || mount.scope === "drive") {
      mountedDriveIds.push(target.id);
    }
    if (mount.scope === "all") {
      mountedSeabedIds.push(target.id);
    }
  }

  const dedup = (ids: string[]) => Array.from(new Set(ids));

  const readableLedgerIds = dedup([
    viewerRealmId,
    ...ancestorIds,
    ...descendantIds,
    ...mountedLedgerIds,
  ]);

  const readableDriveIds = dedup([
    viewerRealmId,
    ...ancestorIds,
    ...descendantIds,
    ...mountedDriveIds,
  ]);

  const readableSeabedIds = dedup([
    viewerRealmId,
    ...ancestorIds,
    ...(includeDescendantSeabed ? descendantIds : []),
    ...mountedSeabedIds,
  ]);

  return {
    orgId: viewer.orgId,
    viewerRealmId,
    ancestorIds,
    descendantIds,
    mountedLedgerIds: dedup(mountedLedgerIds),
    mountedDriveIds: dedup(mountedDriveIds),
    mountedSeabedIds: dedup(mountedSeabedIds),
    readableLedgerIds,
    readableDriveIds,
    readableSeabedIds,
  };
}

/**
 * Policy-aware access scope resolution:
 * - "tree": strict V0.1 hard wall from computeVisibleScope()
 * - "open": all realms within the SAME organization are readable (cross-org stays strictly isolated);
 *           computeVisibleScope() is preserved as focusRealmIds for open-mode ranking boost.
 */
export function resolveAccessScope(params: {
  realms: Realm[];
  mounts: RealmMount[];
  viewerRealmId: string;
  orgPolicy?: OrgPolicy;
  includeDescendantSeabed?: boolean;
}): AccessScope {
  const policy = params.orgPolicy ?? "tree";
  const treeScope = computeVisibleScope({
    realms: params.realms,
    mounts: params.mounts,
    viewerRealmId: params.viewerRealmId,
    includeDescendantSeabed: params.includeDescendantSeabed ?? false,
  });

  if (policy === "tree") {
    return {
      ...treeScope,
      policy: "tree",
      focusRealmIds: [...treeScope.readableLedgerIds],
    };
  }

  const orgRealmIds = params.realms
    .filter((r) => r.orgId === treeScope.orgId)
    .map((r) => r.id);

  return {
    ...treeScope,
    policy: "open",
    readableLedgerIds: orgRealmIds,
    readableDriveIds: orgRealmIds,
    readableSeabedIds: orgRealmIds,
    focusRealmIds: [...treeScope.readableLedgerIds],
  };
}

/**
 * Intersects two AccessScopes so narrowing a viewer (e.g. MCP bound viewer -> child realm)
 * can NEVER widen readable ledger, drive, or seabed sets (blocking child @mounts and child seabed bypasses).
 */
export function intersectAccessScopes(
  requested: AccessScope,
  ceiling: AccessScope,
): AccessScope {
  if (requested.orgId !== ceiling.orgId) {
    return {
      ...requested,
      ancestorIds: [],
      descendantIds: [],
      mountedLedgerIds: [],
      mountedDriveIds: [],
      mountedSeabedIds: [],
      readableLedgerIds: [],
      readableDriveIds: [],
      readableSeabedIds: [],
      focusRealmIds: [],
    };
  }
  const ceilLedger = new Set(ceiling.readableLedgerIds);
  const ceilDrive = new Set(ceiling.readableDriveIds);
  const ceilSeabed = new Set(ceiling.readableSeabedIds);

  const filterBy = (ids: string[], allowed: Set<string>) =>
    ids.filter((id) => allowed.has(id));

  return {
    ...requested,
    policy: ceiling.policy,
    ancestorIds: filterBy(requested.ancestorIds, ceilLedger),
    descendantIds: filterBy(requested.descendantIds, ceilLedger),
    mountedLedgerIds: filterBy(requested.mountedLedgerIds, ceilLedger),
    mountedDriveIds: filterBy(requested.mountedDriveIds, ceilDrive),
    mountedSeabedIds: filterBy(requested.mountedSeabedIds, ceilSeabed),
    readableLedgerIds: filterBy(requested.readableLedgerIds, ceilLedger),
    readableDriveIds: filterBy(requested.readableDriveIds, ceilDrive),
    readableSeabedIds: filterBy(requested.readableSeabedIds, ceilSeabed),
    focusRealmIds: filterBy(requested.focusRealmIds, ceilLedger),
  };
}

export function assertAccess(params: {
  realms: Realm[];
  mounts: RealmMount[];
  actor: Actor;
  viewerRealmId: string;
  targetRealmId: string;
  assetKind: AssetKind;
  required: "read" | "write";
  explicitDescendantDive?: boolean;
  orgPolicy?: OrgPolicy;
}): void {
  const actual = resolveAccess(params);
  if (params.required === "write") {
    if (actual !== "write") {
      if (params.assetKind === "rule" && params.actor.kind !== "human") {
        throw new MindError(
          "RULE_REQUIRES_HUMAN",
          `Only human actors can create or modify rules (actor "${params.actor.id}" is "${params.actor.kind}").`,
          {
            actorId: params.actor.id,
            actorKind: params.actor.kind,
            targetRealmId: params.targetRealmId,
          },
        );
      }
      throw new MindError(
        "ACCESS_DENIED",
        `Write access denied for ${params.assetKind} in realm "${params.targetRealmId}" from viewer "${params.viewerRealmId}".`,
        {
          viewerRealmId: params.viewerRealmId,
          targetRealmId: params.targetRealmId,
          assetKind: params.assetKind,
          actual,
        },
      );
    }
    return;
  }

  if (actual === "none") {
    throw new MindError(
      "ACCESS_DENIED",
      `Read access denied for ${params.assetKind} in realm "${params.targetRealmId}" from viewer "${params.viewerRealmId}".`,
      {
        viewerRealmId: params.viewerRealmId,
        targetRealmId: params.targetRealmId,
        assetKind: params.assetKind,
      },
    );
  }
}
