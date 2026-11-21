import { resolveAccess } from "../policy.js";
import type { DbPort } from "../ports.js";
import type {
  AccessScope,
  Actor,
  Distillation,
  LedgerRecord,
  Realm,
  RealmMount,
  SeabedEntry,
} from "../types.js";

const DRIVE_SOURCE_REF_RE = /^drive:\/\/([^/]+)\/(.+?)(?:@v\d+)?$/;

export function parseDriveSourceRef(
  sourceRef: string,
): { realmId: string; relPath: string } | null {
  const m = DRIVE_SOURCE_REF_RE.exec(sourceRef.trim());
  if (!m) return null;
  return { realmId: m[1]!, relPath: m[2]! };
}

export interface VisibilityHelpers {
  canSeeRecord(rec: LedgerRecord): boolean;
  canSeeSeabed(sea: SeabedEntry): boolean;
  canSeeDistillation(dist: Distillation): boolean;
  canSeeDriveRealm(realmId: string): boolean;
  isRefVisible(ref: string): boolean;
  sanitizeRecord(rec: LedgerRecord): LedgerRecord;
  sanitizeSeabed(sea: SeabedEntry): SeabedEntry;
  sanitizeDistillation(dist: Distillation): Distillation;
  resolveCurrentHeadId(rec: LedgerRecord): string | null;
}

/**
 * Single shared visibility & field-level reference sanitizer used across
 * LedgerEngine (getSupersedeChain) and SeaEngine (brief, recall).
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
    const rec = db.getRecord(ref);
    if (rec) {
      if (rec.sensitivity === "secret") return false;
      return canSeeRecord(rec);
    }
    const sea = db.getSeabedEntry(ref);
    if (sea) {
      if (sea.sensitivity === "secret") return false;
      return canSeeSeabed(sea);
    }
    const dist = db.getDistillation(ref);
    if (dist) {
      return canSeeDistillation(dist);
    }
    if (realmIdSet.has(ref)) {
      return ledgerSet.has(ref);
    }
    return true;
  };

  const sanitizeRecord = (rec: LedgerRecord): LedgerRecord => ({
    ...rec,
    refs: rec.refs.filter(isRefVisible),
    supersedesId:
      rec.supersedesId && isRefVisible(rec.supersedesId)
        ? rec.supersedesId
        : null,
    supersededById:
      rec.supersededById && isRefVisible(rec.supersededById)
        ? rec.supersededById
        : null,
  });

  const sanitizeSeabed = (sea: SeabedEntry): SeabedEntry => ({
    ...sea,
    sourceRef:
      sea.sourceRef && isRefVisible(sea.sourceRef) ? sea.sourceRef : null,
  });

  const sanitizeDistillation = (dist: Distillation): Distillation => ({
    ...dist,
    sourceIds: dist.sourceIds.filter(isRefVisible),
  });

  const resolveCurrentHeadId = (rec: LedgerRecord): string | null => {
    if (rec.status !== "superseded") return null;
    let cur: LedgerRecord | null = rec;
    const visited = new Set<string>([rec.id]);
    while (cur && cur.supersededById && !visited.has(cur.supersededById)) {
      visited.add(cur.supersededById);
      cur = db.getRecord(cur.supersededById);
    }
    if (!cur || cur.id === rec.id) return null;
    // Redacted chain head means there is NO active current version
    if (cur.status !== "active" || cur.redactedAt !== null) return null;
    if (cur.sensitivity === "secret") return null;
    if (!canSeeRecord(cur)) return null;
    return cur.id;
  };

  return {
    canSeeRecord,
    canSeeSeabed,
    canSeeDistillation,
    canSeeDriveRealm,
    isRefVisible,
    sanitizeRecord,
    sanitizeSeabed,
    sanitizeDistillation,
    resolveCurrentHeadId,
  };
}
