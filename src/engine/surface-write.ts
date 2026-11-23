import {
  findEffectiveArchivedRealm,
  isRealmEffectivelyArchived,
} from "../policy.js";
import type { DbPort } from "../ports.js";
import {
  MindError,
  type AccessScope,
  type Actor,
  type LedgerRecord,
  type OrgPolicy,
  type Realm,
  type RealmMount,
  type RecordKind,
  type Sensitivity,
  type WriteRouteSource,
} from "../types.js";
import {
  buildWriteRecordPayload,
  computePayloadHash,
  REDACTED_CONTENT_BLOCKED_MSG,
  REDACTED_CONTENT_TRY_HINT,
} from "./content-hash.js";
import type { LedgerEngine } from "./ledger.js";
import { resolveRealmByPath, resolveVisibleRealm } from "./objects.js";
import { resolveAboutRefsForWrite } from "./refs.js";
import type { SeaEngine } from "./sea.js";
import { assertNoAccidentalSecret } from "./secret-guard.js";
import { createVisibilityHelpers } from "./visibility.js";

export interface RelatedActiveEcho {
  id: string;
  kind: RecordKind;
  realmPath: string;
  title: string;
  occurredAt: string | null;
}

export interface ResolveWriteTargetParams {
  db: DbPort;
  ledger: LedgerEngine;
  realms: Realm[];
  mounts: RealmMount[];
  scope: AccessScope;
  orgId: string;
  orgPolicy: OrgPolicy;
  actor: Actor;
  viewerRealmId: string;
  /** True when viewerRealmId came from an explicit binding (MERU_MIND_VIEWER_REALM_ID or explicit option), NOT implicit open-default:/ */
  isExplicitlyBound: boolean;
  /** Explicit --in / MCP `in` parameter, if supplied */
  explicitIn?: string | null;
  /** Optional validated workspace marker ref (open mode only, discovered strictly at process entry) */
  workspaceMarkerRef?: string | null;
  /** Optional --about references used for Tier-3 unanimous non-root object-owner voting */
  about?: string[];
}

export interface ResolvedWriteTarget {
  realm: Realm;
  routedBy: WriteRouteSource;
  /** Refreshed realm list (updated if Tier-4 lazily created /inbox) */
  realms: Realm[];
}

/**
 * Deterministic 4-tier write target routing shared by CLI `write`, CLI `raw add`, and MCP `mind_write`:
 * 1. Explicit `--in` / MCP `in` (strict resolution; never silently falls back).
 * 2. Explicitly bound realm (`MERU_MIND_VIEWER_REALM_ID` / explicit option), OR in `open` mode a validated
 *    workspace marker (`.meru-mind-realm`). Implicit `open-default:/` is NEVER treated as a write binding.
 * 3. Unanimous `--about` existing-object owner vote (ignoring objects owned by `/` or archived realms).
 * 4. Lazy `/inbox` fallback in `open` mode via `ledger.ensureInboxRealm()`.
 */
export function resolveWriteTargetRealm(
  params: ResolveWriteTargetParams,
): ResolvedWriteTarget {
  const orgRealms = params.realms.filter((r) => r.orgId === params.orgId);

  // Tier 1: Explicit --in / MCP in
  const explicitIn = params.explicitIn?.trim();
  if (explicitIn) {
    const realm = resolveVisibleRealm({
      realms: params.realms,
      orgId: params.orgId,
      ref: explicitIn,
      scope: params.scope,
    });
    return { realm, routedBy: "explicit", realms: params.realms };
  }

  // Tier 2a: Explicitly bound realm (always set in tree mode; opt-in in open mode)
  if (params.isExplicitlyBound) {
    const bound = orgRealms.find((r) => r.id === params.viewerRealmId);
    if (!bound) {
      throw new MindError("NOT_FOUND", "Bound realm not found in visible scope");
    }
    return { realm: bound, routedBy: "bound", realms: params.realms };
  }

  // Tier 2b: Hardened workspace marker (.meru-mind-realm), open mode ONLY
  const markerRef = params.workspaceMarkerRef?.trim();
  if (params.orgPolicy === "open" && markerRef) {
    const markerRealm = markerRef.startsWith("/")
      ? resolveRealmByPath(orgRealms, markerRef)
      : (orgRealms.find((r) => r.id === markerRef) ?? null);
    if (!markerRealm) {
      throw new MindError(
        "NOT_FOUND",
        `Workspace marker realm "${markerRef}" not found in organization "${params.orgId}"`,
        { try: "meru-mind tree /" },
      );
    }
    const archivedBy = findEffectiveArchivedRealm(orgRealms, markerRealm.id);
    if (archivedBy) {
      throw new MindError(
        "CONFLICT",
        `Workspace marker realm "${markerRealm.path}" is archived (via "${archivedBy.path}") and frozen for writes.`,
        {
          reason: "realm_archived",
          targetRealmId: markerRealm.id,
          archivedRealmId: archivedBy.id,
          try: `meru-mind realm unarchive ${archivedBy.path} --as-human`,
        },
      );
    }
    return {
      realm: markerRealm,
      routedBy: "workspace_marker",
      realms: params.realms,
    };
  }

  // Tier 3: Unanimous --about object-owner vote (ignoring "/" and effectively archived realms)
  if (params.about && params.about.length > 0) {
    const vis = createVisibilityHelpers({
      db: params.db,
      realms: params.realms,
      mounts: params.mounts,
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      scope: params.scope,
    });
    const resolvedAbout = resolveAboutRefsForWrite({
      db: params.db,
      realms: params.realms,
      orgId: params.orgId,
      about: params.about,
      scope: params.scope,
      vis,
    });
    if (resolvedAbout.objectIds.length > 0) {
      const objs = params.db.getObjectsByIds(resolvedAbout.objectIds);
      const candidateRealms = new Map<string, Realm>();
      for (const obj of objs) {
        const owner = orgRealms.find((r) => r.id === obj.realmId);
        if (!owner) continue;
        if (owner.path === "/") continue;
        if (isRealmEffectivelyArchived(orgRealms, owner.id)) continue;
        candidateRealms.set(owner.id, owner);
      }
      if (candidateRealms.size === 1) {
        const [onlyRealm] = candidateRealms.values();
        return { realm: onlyRealm!, routedBy: "about", realms: params.realms };
      }
    }
  }

  // Tier 4: Lazy /inbox fallback in open mode
  if (params.orgPolicy === "open") {
    const inbox = params.ledger.ensureInboxRealm(params.orgId);
    const refreshedRealms = params.db.listRealms();
    return { realm: inbox, routedBy: "inbox", realms: refreshedRealms };
  }

  throw new MindError(
    "NOT_BOUND",
    "Target realm could not be determined; pass --in <realm> or bind MERU_MIND_VIEWER_REALM_ID.",
    { try: "MERU_MIND_VIEWER_REALM_ID=/team/project meru-mind whoami" },
  );
}

export const EVERYDAY_WRITE_KINDS = new Set<string>([
  "decision",
  "finding",
  "claim",
  "proposal",
  "verdict",
]);

const VALID_SENSITIVITIES = new Set<string>([
  "public",
  "internal",
  "confidential",
  "secret",
]);

export interface SurfaceWriteParams {
  db: DbPort;
  ledger: LedgerEngine;
  realms: Realm[];
  mounts: RealmMount[];
  scope: AccessScope;
  actor: Actor;
  viewerRealmId: string;
  targetRealmId: string;
  title: string;
  body: string;
  kind?: string;
  extKind?: string | null;
  about?: string[];
  supersedes?: string[];
  because?: string[];
  occurredAt?: string | null;
  sensitivity?: Sensitivity;
  explicitIdempotencyKey?: string;
  /** Human-only CLI override; NEVER exposed in MCP */
  allowRedactedReingest?: boolean;
  /** Optional clock override for deterministic bucket tests */
  now?: Date;
}

/**
 * Shared everyday conclusion write path for CLI `write` and MCP `mind_write`.
 * Enforces:
 * - Rejects `kind: "rule"` with `RULE_REQUIRES_HUMAN` (wire `forbidden`)
 * - Single canonical payload shape via `buildWriteRecordPayload()`
 * - Unified `--about` resolution (`objects` / `thing` / `resourceTags` / `AMBIGUOUS_REF`)
 * - Full-field auto-idempotency with 1-minute UTC bucket when `occurredAt` is omitted
 * - `superseded` hit derives `:after:<headOrId>` for clean `A -> B -> A` rollback
 * - `retracted` hit immediately throws `ACCESS_DENIED` (wire `forbidden`), NEVER derives `:after:`
 */
export async function writeEverydayConclusion(
  params: SurfaceWriteParams,
): Promise<LedgerRecord> {
  const rawKind = (params.kind ?? "finding").trim().toLowerCase();
  if (rawKind === "rule") {
    throw new MindError(
      "RULE_REQUIRES_HUMAN",
      'Rules cannot be written via everyday write; rules are human-only.',
      {
        try: 'meru-mind rule add --in / --title "<title>" --body "<body>" --as-human',
      },
    );
  }
  if (!EVERYDAY_WRITE_KINDS.has(rawKind)) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid write kind "${params.kind}". Allowed kinds: decision, finding, claim, proposal, verdict`,
      {
        try: 'meru-mind write --in /ops --kind finding --title "<title>" --body "<body>"',
      },
    );
  }
  const kind = rawKind as RecordKind;

  const sensitivity: Sensitivity = params.sensitivity ?? "internal";
  if (!VALID_SENSITIVITIES.has(sensitivity)) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid sensitivity "${String(sensitivity)}". Allowed: public, internal, confidential, secret`,
    );
  }

  const title = params.title.trim();
  if (!title) {
    throw new MindError("INVALID_INPUT", "Record title cannot be empty");
  }
  const body = params.body.trim();
  if (!body) {
    throw new MindError("INVALID_INPUT", "Record body cannot be empty");
  }

  assertNoAccidentalSecret({
    texts: [title, body],
    sensitivity,
    surfaceHint:
      'Remove the credential value or re-run with --sensitivity secret',
  });

  const targetRealm = params.realms.find((r) => r.id === params.targetRealmId);
  if (!targetRealm) {
    throw new MindError("NOT_FOUND", "Realm not found in visible scope");
  }

  const vis = createVisibilityHelpers({
    db: params.db,
    realms: params.realms,
    mounts: params.mounts,
    actor: params.actor,
    viewerRealmId: params.viewerRealmId,
    scope: params.scope,
    includeDescendantSeabed: false,
  });

  const resolvedAbout = resolveAboutRefsForWrite({
    db: params.db,
    realms: params.realms,
    orgId: targetRealm.orgId,
    about: params.about ?? [],
    scope: params.scope,
    vis,
  });

  const supersedesIds = Array.from(
    new Set((params.supersedes ?? []).map((s) => s.trim()).filter(Boolean)),
  ).sort();
  const becauseRefs = Array.from(
    new Set((params.because ?? []).map((s) => s.trim()).filter(Boolean)),
  ).sort();

  // Single canonical payload construction (Rule 2)
  const payload = buildWriteRecordPayload(body);

  const allowHumanOverride =
    params.allowRedactedReingest === true && params.actor.kind === "human";

  let idempotencyKey = params.explicitIdempotencyKey?.trim() || undefined;
  if (!idempotencyKey) {
    const nowIso = (params.now ?? new Date()).toISOString();
    const timeSlot =
      params.occurredAt === undefined
        ? `bucket:${nowIso.slice(0, 16)}`
        : params.occurredAt === null
          ? "null"
          : params.occurredAt.trim();

    const baseHash = computePayloadHash({
      orgId: targetRealm.orgId,
      targetRealmId: params.targetRealmId,
      kind,
      extKind: params.extKind?.trim() || null,
      title,
      payload,
      objectIds: resolvedAbout.objectIds,
      resourceTags: resolvedAbout.resourceTags,
      thingId: resolvedAbout.thingId ?? null,
      supersedesIds,
      refs: becauseRefs,
      sensitivity,
      timeSlot,
    });

    let candidateKey = `auto:v1:${baseHash}`;
    const visitedKeys = new Set<string>();

    while (!visitedKeys.has(candidateKey)) {
      visitedKeys.add(candidateKey);
      const existing = params.db.getIdempotencyKey(
        targetRealm.orgId,
        candidateKey,
      );
      if (!existing) {
        break;
      }
      if (existing.targetTable !== "records") {
        break;
      }
      const existingRec = params.db.getRecord(existing.targetId);
      if (!existingRec) {
        break;
      }
      if (existingRec.status === "retracted" || existingRec.redactedAt !== null) {
        if (allowHumanOverride) {
          candidateKey = `auto:v1:${baseHash}:human-override:${existingRec.id}`;
          continue;
        }
        throw new MindError("ACCESS_DENIED", REDACTED_CONTENT_BLOCKED_MSG, {
          reason: "redacted_blocklist",
          try: REDACTED_CONTENT_TRY_HINT,
        });
      }
      if (existingRec.status === "superseded") {
        // Walk forward along superseded_by_id to find the current chain head (or existingRec.id)
        let cur = existingRec;
        const visitedIds = new Set<string>([cur.id]);
        while (cur.supersededById && !visitedIds.has(cur.supersededById)) {
          visitedIds.add(cur.supersededById);
          const next = params.db.getRecord(cur.supersededById);
          if (!next) break;
          cur = next;
        }
        candidateKey = `auto:v1:${baseHash}:after:${cur.id}`;
        continue;
      }
      // Active record: reuse candidateKey so appendRecord returns it idempotently
      break;
    }

    idempotencyKey = candidateKey;
  }

  return params.ledger.appendRecord({
    actor: params.actor,
    viewerRealmId: params.viewerRealmId,
    targetRealmId: params.targetRealmId,
    thingId: resolvedAbout.thingId,
    kind,
    extKind: params.extKind,
    title,
    payload,
    refs: becauseRefs,
    objectIds: resolvedAbout.objectIds,
    resourceTags: resolvedAbout.resourceTags,
    supersedesIds: supersedesIds.length > 0 ? supersedesIds : undefined,
    occurredAt: params.occurredAt,
    sensitivity,
    idempotencyKey,
    allowRedactedReingest: allowHumanOverride,
  });
}

/**
 * Neutral write-time echo: after an interactive write without explicit `--supersedes`,
 * runs a fast lexical recall on the new record's title and returns up to 3 potentially
 * related active entries for context (zero LLM, non-blocking, never fires on secrets).
 */
export async function findRelatedActiveForEcho(params: {
  sea: SeaEngine;
  actor: Actor;
  viewerRealmId: string;
  newRecord: LedgerRecord;
  scopeCeiling?: AccessScope;
  limit?: number;
}): Promise<RelatedActiveEcho[]> {
  if (
    params.newRecord.supersedesIds.length > 0 ||
    params.newRecord.sensitivity === "secret" ||
    !params.newRecord.title.trim()
  ) {
    return [];
  }
  const maxItems = Math.max(1, Math.min(params.limit ?? 3, 5));
  try {
    const res = await params.sea.recall({
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      query: params.newRecord.title,
      scopeCeiling: params.scopeCeiling,
      includeSuperseded: false,
      limit: maxItems + 3,
    });
    const out: RelatedActiveEcho[] = [];
    for (const item of res.items) {
      if (item.sourceType !== "record") continue;
      if (item.id === params.newRecord.id) continue;
      if (item.status !== "active") continue;
      if (item.kind === "rule" && params.newRecord.kind !== "rule") continue;
      out.push({
        id: item.id,
        kind: item.kind as RecordKind,
        realmPath: item.realmPath ?? "/",
        title: item.title,
        occurredAt: item.occurredAt,
      });
      if (out.length >= maxItems) break;
    }
    return out;
  } catch {
    // Non-blocking best-effort echo: never fail a committed write
    return [];
  }
}
