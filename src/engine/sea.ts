import crypto from "node:crypto";
import {
  CJK_COVERAGE_THRESHOLD,
  parseSearchQuery,
  type DateConcept,
  type SearchConcept,
} from "../adapters/sqlite-db.js";
import { createInactiveBadgeResolver } from "../format/inactive-badges.js";
import {
  buildCanonicalEntryContent,
  buildRecordFtsBody,
  buildSnippet,
  buildSnippetWithMeta,
  DEFAULT_SHOW_LIMIT,
  extractReadableText,
  MAX_SHOW_LIMIT,
  windowText,
} from "../format/snippet.js";
import {
  assertAccess,
  getDescendantIds,
  intersectAccessScopes,
  isRealmEffectivelyArchived,
  resolveAccess,
  resolveAccessScope,
} from "../policy.js";
import type {
  BlobPort,
  DbPort,
  DrivePort,
  EmbedderPort,
  UnifiedEntryRef,
} from "../ports.js";
import {
  MindError,
  type AccessScope,
  type Actor,
  type BehaviorClass,
  type BriefBudget,
  type BriefOutput,
  type CatResult,
  type ChangeLogEntry,
  type ChangesResult,
  type ChildRealmSummary,
  type Distillation,
  type DistillationLayer,
  type LedgerRecord,
  type LedgerRecordSummary,
  type LsDriveFileItem,
  type LsEntry,
  type LsObjectSummary,
  type LsOnlyFilter,
  type LsResult,
  type LsTargetType,
  type MindObject,
  type ObjectCard,
  type ObjectTreeNode,
  type OrgPolicy,
  type Realm,
  type RealmMount,
  type RealmTreeCounts,
  type RealmTreeNode,
  type RecallItem,
  type RecallQuery,
  type RecallResult,
  type RebuildResult,
  type RecordKind,
  type ReplayResult,
  type SeabedEntry,
  type SeabedKind,
  type SearchResult,
  type Sensitivity,
  type ShowContextResult,
  type ShowResult,
  type ShowSupersedeChainResult,
  type ShowWindow,
  type SyncEmbeddingsResult,
  type TreeResult,
  type WhoamiResult,
} from "../types.js";
import {
  getDescendantObjectIds,
  normalizeResourceTag,
  OPAQUE_ENTRY_NOT_FOUND,
  OPAQUE_OBJECT_NOT_FOUND,
  OPAQUE_REALM_NOT_FOUND,
  resolveVisibleRealm,
} from "./objects.js";
import {
  computeDuplicateObjectKeys,
  formatCanonicalFileRef,
  formatCanonicalObjectRef,
  formatStoredSourceRef,
  OPAQUE_FILE_NOT_FOUND,
  parseRefSyntax,
  resolveFileRef,
  resolveUnifiedObjectRead,
} from "./refs.js";
import {
  createVisibilityHelpers,
  parseDriveSourceRef,
  type VisibilityHelpers,
} from "./visibility.js";

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

const VALID_DISTILLATION_LAYERS = new Set<string>([
  "slice_shift",
  "slice_day",
  "slice_week",
  "slice_month",
  "card_realm",
  "card_person",
  "card_progress",
]);

const NON_RULE_RECORD_KINDS: RecordKind[] = [
  "thing",
  "claim",
  "proposal",
  "verdict",
  "finding",
  "decision",
];

const VALID_RECORD_KINDS_SET = new Set<string>([
  "thing",
  "claim",
  "proposal",
  "verdict",
  "finding",
  "decision",
  "rule",
]);

const VALID_SEABED_KINDS_SET = new Set<string>([
  "message",
  "artifact",
  "evidence",
  "signal",
]);

function parseNumericCursor(cursor?: string): number {
  if (cursor === undefined || cursor === null || cursor.trim() === "") return 0;
  if (!/^\d+$/.test(cursor.trim())) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid cursor "${cursor}": expected non-negative integer offset`,
    );
  }
  return Number.parseInt(cursor.trim(), 10);
}

function clampBudget(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new MindError(
      "INVALID_INPUT",
      `Budget limit must be a positive integer, got ${value}`,
    );
  }
  return Math.min(value, 200);
}

export class SeaEngine {
  constructor(
    private readonly db: DbPort,
    private readonly blobs: BlobPort,
    private readonly drive: DrivePort,
    private readonly embedder: EmbedderPort,
  ) {}

  private getOrgPolicy(orgId: string | undefined): OrgPolicy {
    if (!orgId) return "tree";
    return this.db.getOrg(orgId)?.policy ?? "tree";
  }

  private buildVisibilityHelpers(params: {
    realms: Realm[];
    mounts: RealmMount[];
    actor: Actor;
    viewerRealmId: string;
    scope: AccessScope;
    ledgerRealmIds: string[];
    seabedRealmIds: string[];
    includeDescendantSeabed: boolean;
  }): VisibilityHelpers {
    return createVisibilityHelpers({
      db: this.db,
      ...params,
    });
  }

  private filterDistillationsBySensitivity(
    dists: Distillation[],
    excludeSensitivities: Sensitivity[],
  ): Set<string> {
    const blocked = new Set<string>();
    if (dists.length === 0 || excludeSensitivities.length === 0) return blocked;
    const excluded = new Set(excludeSensitivities);
    const allSourceIds: string[] = [];
    for (const d of dists) {
      allSourceIds.push(...d.sourceIds);
    }
    const uniqueIds = Array.from(new Set(allSourceIds));
    if (uniqueIds.length === 0) return blocked;

    const secretIds = new Set<string>();
    const recs = this.db.getRecordsByIds(uniqueIds);
    const foundRecIds = new Set<string>();
    for (const r of recs) {
      foundRecIds.add(r.id);
      if (excluded.has(r.sensitivity)) secretIds.add(r.id);
    }
    const remaining = uniqueIds.filter((id) => !foundRecIds.has(id));
    if (remaining.length > 0) {
      const seas = this.db.getSeabedEntriesByIds(remaining);
      for (const s of seas) {
        if (excluded.has(s.sensitivity)) secretIds.add(s.id);
      }
    }
    for (const d of dists) {
      if (d.sourceIds.some((sid) => secretIds.has(sid))) {
        blocked.add(d.id);
      }
    }
    return blocked;
  }

  // ---- Brief (Kind Histogram, occurred_at Recency, Batch GROUP BY SQL, Bounded Child Summaries) ----

  brief(params: {
    actor: Actor;
    viewerRealmId: string;
    target?: string;
    budget?: BriefBudget;
    scopeCeiling?: AccessScope;
    excludeSensitivities?: Sensitivity[];
  }): BriefOutput {
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const realmsById = new Map(realms.map((r) => [r.id, r]));
    const viewerRealm = realmsById.get(params.viewerRealmId);
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

    const targetRealm = params.target
      ? resolveVisibleRealm({
          realms,
          orgId: viewerRealm.orgId,
          ref: params.target,
          scope,
        })
      : viewerRealm;

    // For brief center on targetRealm, compute ancestor/descendant view bounded by effective scope
    const centerScope =
      targetRealm.id === viewerRealm.id
        ? scope
        : intersectAccessScopes(
            resolveAccessScope({
              realms,
              mounts,
              viewerRealmId: targetRealm.id,
              orgPolicy,
              includeDescendantSeabed: false,
            }),
            scope,
          );

    const excludeSensitivities = params.excludeSensitivities ?? ["secret"];
    const vis = this.buildVisibilityHelpers({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: viewerRealm.id,
      scope,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      includeDescendantSeabed: false,
    });

    const sanitizedCenterRealm = vis.sanitizeRealm(targetRealm);

    const recentMessagesLimit = clampBudget(params.budget?.recentMessages, 10);
    const maxQuestions = clampBudget(params.budget?.maxQuestions, 5);
    const maxActiveThings = clampBudget(params.budget?.maxActiveThings, 5);
    const maxDecisions = clampBudget(params.budget?.maxDecisions, 5);
    const maxRecentConclusions = clampBudget(
      params.budget?.maxRecentConclusions,
      10,
    );
    const maxRules = clampBudget(params.budget?.maxRules, 20);
    const maxChildSummaries = clampBudget(params.budget?.maxChildSummaries, 20);

    const canSeeSelfLedger = scope.readableLedgerIds.includes(targetRealm.id);
    const canSeeSelfSeabed = scope.readableSeabedIds.includes(targetRealm.id);

    // 1. Surface: recent messages in target realm
    const msgRes = canSeeSelfSeabed
      ? this.db.listSeabedEntries({
          realmIds: [targetRealm.id],
          kinds: ["message"],
          excludeSensitivities,
          limit: recentMessagesLimit,
        })
      : { items: [], total: 0 };

    // 2. Upper Ledger: pending questions, active things, active decisions, recent conclusions (occurred_at DESC)
    const selfAndAncestors = [targetRealm.id, ...centerScope.ancestorIds].filter(
      (id) => scope.readableLedgerIds.includes(id),
    );
    const pendingQuestionsRes = canSeeSelfLedger
      ? this.db.listPendingHumanQuestions({
          realmIds: [targetRealm.id],
          excludeSensitivities,
          limit: maxQuestions,
        })
      : { items: [], total: 0 };

    const thingsRes = canSeeSelfLedger
      ? this.db.listRecords({
          realmIds: [targetRealm.id],
          kinds: ["thing"],
          includeSuperseded: false,
          excludeSensitivities,
          limit: maxActiveThings,
        })
      : { items: [], total: 0 };

    const decisionsRes = this.db.listRecords({
      realmIds: selfAndAncestors,
      kinds: ["decision"],
      includeSuperseded: false,
      excludeSensitivities,
      limit: maxDecisions,
    });

    const recentConclusionsRes = canSeeSelfLedger
      ? this.db.listRecords({
          realmIds: [targetRealm.id],
          kinds: NON_RULE_RECORD_KINDS,
          includeSuperseded: false,
          excludeSensitivities,
          limit: maxRecentConclusions,
        })
      : { items: [], total: 0 };

    const rulesRes = this.db.listRecords({
      realmIds: selfAndAncestors,
      kinds: ["rule"],
      includeSuperseded: false,
      excludeSensitivities,
      limit: maxRules,
    });
    const ruleSummaries = rulesRes.items.map((r) => ({
      id: r.id,
      realmId: r.realmId,
      inherited: r.realmId !== targetRealm.id,
      title: r.title,
    }));

    // 3. Batch fetch cognitive cards for self + ancestors + capped visible descendants (1 query!)
    const visibleDescendants = centerScope.descendantIds.filter((id) =>
      scope.readableLedgerIds.includes(id),
    );
    const totalChildRealmsCount = visibleDescendants.length;
    const cappedDescendantIds = visibleDescendants.slice(0, maxChildSummaries);
    const omittedChildRealmsCount = Math.max(
      0,
      totalChildRealmsCount - cappedDescendantIds.length,
    );

    const cardRealmIds = Array.from(
      new Set([
        ...(canSeeSelfLedger ? [targetRealm.id] : []),
        ...centerScope.ancestorIds.filter((id) =>
          scope.readableLedgerIds.includes(id),
        ),
        ...cappedDescendantIds,
      ]),
    );
    const latestCardsMap = this.db.getLatestDistillationsByRealms(
      cardRealmIds,
      "card_realm",
    );
    const blockedDistIds = this.filterDistillationsBySensitivity(
      Array.from(latestCardsMap.values()),
      excludeSensitivities,
    );
    const getSafeCard = (rid: string): Distillation | null => {
      const card = latestCardsMap.get(rid) ?? null;
      if (!card || blockedDistIds.has(card.id)) return null;
      return card;
    };

    const rawRealmCard = canSeeSelfLedger ? getSafeCard(targetRealm.id) : null;

    // Preload all refs across brief items in 1 batched pass (O(1) queries)
    const refsToPreload: string[] = [];
    for (const r of [
      ...pendingQuestionsRes.items,
      ...thingsRes.items,
      ...decisionsRes.items,
      ...recentConclusionsRes.items,
    ]) {
      refsToPreload.push(...r.refs);
      if (r.supersedesId) refsToPreload.push(r.supersedesId);
      if (r.supersedesIds) refsToPreload.push(...r.supersedesIds);
      if (r.supersededById) refsToPreload.push(r.supersededById);
    }
    for (const m of msgRes.items) {
      if (m.sourceRef) refsToPreload.push(m.sourceRef);
    }
    if (rawRealmCard) {
      refsToPreload.push(...rawRealmCard.sourceIds);
    }
    vis.preloadRefs(refsToPreload);

    const realmCard = rawRealmCard ? vis.sanitizeDistillation(rawRealmCard) : null;

    const ancestorSummaries = centerScope.ancestorIds
      .filter((aid) => scope.readableLedgerIds.includes(aid))
      .map((aid) => {
        const aRealm = vis.sanitizeRealm(realmsById.get(aid)!);
        const card = getSafeCard(aid);
        const summary = card
          ? buildSnippet({
              text: card.narrativeMd || JSON.stringify(card.hardFacts),
              maxLen: 140,
            })
          : `Ancestor realm "${aRealm.name}" (${aRealm.path})`;
        return {
          realmId: aid,
          realmPath: aRealm.path,
          summary,
        };
      });

    // Batch GROUP BY counts for capped child summaries (ZERO per-child N+1 loops!)
    const childRecordCounts =
      cappedDescendantIds.length > 0
        ? this.db.countActiveRecordsByRealm({
            realmIds: cappedDescendantIds,
            excludeSensitivities,
          })
        : new Map();
    const childPendingCounts =
      cappedDescendantIds.length > 0
        ? this.db.countPendingQuestionsByRealm({
            realmIds: cappedDescendantIds,
            excludeSensitivities,
          })
        : new Map();
    const childObjectCounts =
      cappedDescendantIds.length > 0
        ? this.db.countObjectsByRealm({
            orgId: targetRealm.orgId,
            realmIds: cappedDescendantIds,
          })
        : new Map<string, number>();

    const childSlice: ChildRealmSummary[] = cappedDescendantIds.map((cid) => {
      const cRealm = vis.sanitizeRealm(realmsById.get(cid)!);
      const counts = childRecordCounts.get(cid);
      const cCard = getSafeCard(cid);
      return {
        realmId: cid,
        realmPath: cRealm.path,
        realmName: cRealm.name,
        activeRules: counts?.rules ?? 0,
        activeConclusions: counts?.conclusions ?? 0,
        activeObjects: childObjectCounts.get(cid) ?? 0,
        activeThings: counts?.things ?? 0,
        pendingQuestions: childPendingCounts.get(cid) ?? 0,
        activeDecisions: counts?.decisions ?? 0,
        latestCardSummary: cCard
          ? buildSnippet({ text: cCard.narrativeMd, maxLen: 120 })
          : null,
      };
    });

    // Exact kind histogram & 3-bucket counts (rules / conclusions / raw) excluding secret entries
    const kindHistogram = canSeeSelfLedger
      ? this.db.countRecordsByKind({
          realmIds: [targetRealm.id],
          includeSuperseded: false,
          excludeSensitivities,
        })
      : {};
    let conclusionsCount = 0;
    for (const [k, c] of Object.entries(kindHistogram)) {
      if (k !== "rule") conclusionsCount += c;
    }
    const rawTotal = canSeeSelfSeabed
      ? (this.db
          .countSeabedByRealm({
            realmIds: [targetRealm.id],
            excludeSensitivities,
          })
          .get(targetRealm.id) ?? 0)
      : 0;

    const generation = this.db.getChangeLogGeneration();
    const currentSeq = this.db.getLatestChangeLogSeq(targetRealm.orgId);
    const cardSeq = realmCard
      ? this.db.getChangeLogSeqForEntity("distillation", realmCard.id)
      : null;
    const changesSinceCard =
      cardSeq !== null
        ? this.db.countChangeLogSince({
            orgId: targetRealm.orgId,
            realmIds: [targetRealm.id],
            sinceSeq: cardSeq,
            generation,
            includeSecret: false,
          })
        : 0;

    const targetRealmArchived = isRealmEffectivelyArchived(
      realms,
      targetRealm.id,
    );

    return {
      realm: sanitizedCenterRealm,
      ...(targetRealmArchived ? { realmArchived: true } : {}),
      generatedAt: new Date().toISOString(),
      kindHistogram,
      buckets: {
        rules: rulesRes.total,
        conclusions: conclusionsCount,
        raw: rawTotal,
      },
      recentConclusions: {
        items: recentConclusionsRes.items.map(vis.sanitizeRecord),
        totalCount: recentConclusionsRes.total,
        omittedCount: Math.max(
          0,
          recentConclusionsRes.total - recentConclusionsRes.items.length,
        ),
      },
      omittedChildRealmsCount,
      surface: {
        recentMessages: {
          items: msgRes.items.map(vis.sanitizeSeabed),
          totalCount: msgRes.total,
          omittedCount: Math.max(0, msgRes.total - msgRes.items.length),
        },
      },
      upperLedger: {
        pendingQuestions: {
          items: pendingQuestionsRes.items.map(vis.sanitizeRecord),
          totalCount: pendingQuestionsRes.total,
          omittedCount: Math.max(
            0,
            pendingQuestionsRes.total - pendingQuestionsRes.items.length,
          ),
        },
        activeThings: {
          items: thingsRes.items.map(vis.sanitizeRecord),
          totalCount: thingsRes.total,
          omittedCount: Math.max(0, thingsRes.total - thingsRes.items.length),
        },
        activeDecisions: {
          items: decisionsRes.items.map(vis.sanitizeRecord),
          totalCount: decisionsRes.total,
          omittedCount: Math.max(
            0,
            decisionsRes.total - decisionsRes.items.length,
          ),
        },
      },
      middleMind: {
        realmCard,
        realmCardMeta: {
          cardSeq,
          changesSinceCard,
          currentSeq,
          generation,
        },
        rules: {
          items: ruleSummaries,
          totalCount: rulesRes.total,
          omittedCount: Math.max(0, rulesRes.total - ruleSummaries.length),
        },
        ancestorSummaries,
        childSummaries: {
          items: childSlice,
          totalCount: totalChildRealmsCount,
          omittedCount: omittedChildRealmsCount,
        },
      },
      drilldownHint:
        "Use recall / cat for exact inspection, ls/tree for browsing, replay <id> for timeline context, or recall <query> for FTS5+vector search.",
    };
  }

  // ---- Recall (4-Stage Pipeline: ID -> Filter -> Staged FTS5 + Vector -> Strict Lexicographic Rank) ----

  async recall(query: RecallQuery): Promise<RecallResult> {
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const includeSuperseded = Boolean(
      query.includeSuperseded || query.includeHistory,
    );
    const includeDescendantSeabed = Boolean(query.includeDescendantSeabed);
    const limit = Math.max(1, Math.min(query.limit ?? 20, 200));
    const offset = Math.max(0, query.offset ?? 0);

    const viewerRealm = realms.find((r) => r.id === query.viewerRealmId);
    const orgPolicy = this.getOrgPolicy(viewerRealm?.orgId);

    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: query.viewerRealmId,
      orgPolicy,
      includeDescendantSeabed,
    });
    const scope = query.scopeCeiling
      ? intersectAccessScopes(baseScope, query.scopeCeiling)
      : baseScope;

    const allowedLedgerSet = new Set(scope.readableLedgerIds);
    const allowedSeabedSet = new Set(scope.readableSeabedIds);

    // Narrow to targetRealmId or realmIdsFilter if specified (never widens visibility!)
    let ledgerRealmIds = scope.readableLedgerIds;
    let seabedRealmIds = scope.readableSeabedIds;
    if (query.realmIdsFilter) {
      const filterSet = new Set(query.realmIdsFilter);
      ledgerRealmIds = ledgerRealmIds.filter((id) => filterSet.has(id));
      seabedRealmIds = seabedRealmIds.filter((id) => filterSet.has(id));
    }
    if (query.targetRealmId) {
      ledgerRealmIds = ledgerRealmIds.includes(query.targetRealmId)
        ? [query.targetRealmId]
        : [];
      seabedRealmIds = seabedRealmIds.includes(query.targetRealmId)
        ? [query.targetRealmId]
        : [];
    }
    const allowedEntrySet =
      query.allowedEntryIds !== undefined
        ? new Set(query.allowedEntryIds)
        : null;

    const vis = this.buildVisibilityHelpers({
      realms,
      mounts,
      actor: query.actor,
      viewerRealmId: query.viewerRealmId,
      scope,
      ledgerRealmIds,
      seabedRealmIds,
      includeDescendantSeabed,
    });

    const orgRealmsForArchive = viewerRealm
      ? realms.filter((r) => r.orgId === viewerRealm.orgId)
      : [];
    const archivedRealmIds = new Set<string>(
      orgRealmsForArchive
        .filter((r) => isRealmEffectivelyArchived(orgRealmsForArchive, r.id))
        .map((r) => r.id),
    );

    const toRecordItem = (
      rec: LedgerRecord,
      matchedBy: RecallItem["matchedBy"],
      score: number,
      concepts?: SearchConcept[],
      passage?: { text: string; start: number; end: number; totalLen: number },
    ): RecallItem => {
      const clean = vis.sanitizeRecord(rec);
      const isSuperseded = rec.status === "superseded";
      const currentHeadId = isSuperseded
        ? vis.resolveCurrentHeadId(rec)
        : undefined;
      const orphanSuperseded = isSuperseded
        ? vis.isOrphanSuperseded(rec)
        : undefined;
      const snippetMeta = passage
        ? buildSnippetWithMeta({
            title: clean.title,
            text: passage.text,
            concepts,
          })
        : buildSnippetWithMeta({
            title: clean.title,
            payload: clean.payload,
            concepts,
          });
      let snippet = snippetMeta.snippet;
      if (passage && snippet) {
        if (passage.start > 0 && !snippet.startsWith("...")) {
          snippet = `...${snippet}`;
        }
        if (passage.end < passage.totalLen && !snippet.endsWith("...")) {
          snippet = `${snippet}...`;
        }
      }
      const canonical = buildCanonicalEntryContent({
        kind: "record",
        payload: clean.payload,
      });
      const contentChars =
        canonical.length > 0 ? canonical.length : clean.title.length;
      return {
        id: clean.id,
        behaviorClass: clean.kind === "rule" ? "rule" : "conclusion",
        sourceType: "record",
        kind: clean.kind,
        ...(clean.extKind ? { extKind: clean.extKind } : {}),
        realmId: clean.realmId,
        realmPath: vis.getSanitizedRealmPath(clean.realmId),
        status: clean.status,
        title: clean.title,
        snippet,
        contentChars,
        shownChars: snippet.length,
        truncated: snippetMeta.truncated || Boolean(passage),
        authorId: clean.authorId,
        createdAt: clean.createdAt,
        occurredAt: clean.occurredAt,
        sourceRefs: clean.refs,
        supersedesId: clean.supersedesId,
        supersedesIds: clean.supersedesIds,
        supersededById: clean.supersededById,
        ...(isSuperseded ? { currentHeadId, orphanSuperseded } : {}),
        ...(archivedRealmIds.has(clean.realmId) ? { realmArchived: true } : {}),
        matchedBy,
        score,
      };
    };

    const toSeabedItem = (
      sea: SeabedEntry,
      matchedBy: RecallItem["matchedBy"],
      score: number,
      concepts?: SearchConcept[],
      passage?: { text: string; start: number; end: number; totalLen: number },
    ): RecallItem => {
      const clean = vis.sanitizeSeabed(sea);
      const snippetMeta = buildSnippetWithMeta({
        text: passage ? passage.text : clean.text,
        concepts,
      });
      let snippet = snippetMeta.snippet;
      if (passage && snippet) {
        if (passage.start > 0 && !snippet.startsWith("...")) {
          snippet = `...${snippet}`;
        }
        if (passage.end < passage.totalLen && !snippet.endsWith("...")) {
          snippet = `${snippet}...`;
        }
      }
      return {
        id: clean.id,
        behaviorClass: "raw",
        sourceType: "seabed",
        kind: clean.kind,
        realmId: clean.realmId,
        realmPath: vis.getSanitizedRealmPath(clean.realmId),
        status: clean.redactedAt ? "retracted" : "evidence",
        title: `${clean.kind}${clean.topicId ? ` (${clean.topicId})` : ""}`,
        snippet,
        contentChars: clean.text.length,
        shownChars: snippet.length,
        truncated: snippetMeta.truncated || Boolean(passage),
        authorId: clean.authorId,
        createdAt: clean.createdAt,
        occurredAt: clean.occurredAt,
        sourceRefs: clean.sourceRef
          ? [
              formatStoredSourceRef(
                clean.sourceRef,
                vis.getSanitizedRealmPath,
              ) ?? clean.sourceRef,
            ]
          : [],
        ...(archivedRealmIds.has(clean.realmId) ? { realmArchived: true } : {}),
        matchedBy,
        score,
      };
    };

    const toDistillationItem = (
      dist: Distillation,
      matchedBy: RecallItem["matchedBy"],
      score: number,
      concepts?: SearchConcept[],
      passage?: { text: string; start: number; end: number; totalLen: number },
    ): RecallItem => {
      const clean = vis.sanitizeDistillation(dist);
      const canonical = clean.narrativeMd || JSON.stringify(clean.hardFacts);
      const snippetMeta = buildSnippetWithMeta({
        text: passage ? passage.text : canonical,
        concepts,
      });
      let snippet = snippetMeta.snippet;
      if (passage && snippet) {
        if (passage.start > 0 && !snippet.startsWith("...")) {
          snippet = `...${snippet}`;
        }
        if (passage.end < passage.totalLen && !snippet.endsWith("...")) {
          snippet = `${snippet}...`;
        }
      }
      return {
        id: clean.id,
        behaviorClass: "conclusion",
        sourceType: "distillation",
        kind: clean.layer,
        realmId: clean.realmId,
        realmPath: vis.getSanitizedRealmPath(clean.realmId),
        status: clean.status,
        title: `${clean.layer} (${clean.periodKey})`,
        snippet,
        contentChars: canonical.length,
        shownChars: snippet.length,
        truncated: snippetMeta.truncated || Boolean(passage),
        authorId: "system",
        createdAt: clean.createdAt,
        occurredAt: clean.createdAt,
        sourceRefs: clean.sourceIds,
        ...(archivedRealmIds.has(clean.realmId) ? { realmArchived: true } : {}),
        matchedBy,
        score,
      };
    };

    const compareRecencyDesc = (
      a: { occurredAt: string | null; createdAt: string; id: string },
      b: { occurredAt: string | null; createdAt: string; id: string },
    ): number => {
      const hasA = a.occurredAt !== null ? 1 : 0;
      const hasB = b.occurredAt !== null ? 1 : 0;
      if (hasB !== hasA) return hasB - hasA;
      if (a.occurredAt !== null && b.occurredAt !== null && b.occurredAt !== a.occurredAt) {
        return b.occurredAt.localeCompare(a.occurredAt);
      }
      if (b.createdAt !== a.createdAt) {
        return b.createdAt.localeCompare(a.createdAt);
      }
      return b.id.localeCompare(a.id);
    };

    const annotateRecallPage = (items: RecallItem[]): RecallItem[] => {
      if (items.length === 0 || !viewerRealm) return items;
      const resolver = createInactiveBadgeResolver(
        this.db,
        viewerRealm.orgId,
        scope.readableLedgerIds,
      );
      if (!resolver) return items;
      const objIdsByEntry = this.db.listObjectIdsByEntryIds(
        viewerRealm.orgId,
        items.map((it) => it.id),
      );
      for (const it of items) {
        const badges = resolver.resolveForItem({
          itemId: it.id,
          linkedObjectIds: objIdsByEntry.get(it.id) ?? [],
          text: `${it.title}\n${it.snippet}`,
        });
        if (badges.length > 0) {
          it.inactive = badges;
        }
      }
      return items;
    };

    // Stage 1: Direct ID lookup (explicitly allows secret entries if visible in scope)
    if (query.id) {
      const items: RecallItem[] = [];
      const rec = this.db.getRecord(query.id);
      if (rec && vis.canSeeRecord(rec)) {
        vis.preloadRefs([
          ...rec.refs,
          ...(rec.supersedesId ? [rec.supersedesId] : []),
          ...(rec.supersedesIds ?? []),
          ...(rec.supersededById ? [rec.supersededById] : []),
        ]);
        items.push(toRecordItem(rec, ["id"], 1));
      }
      const sea = this.db.getSeabedEntry(query.id);
      if (sea && vis.canSeeSeabed(sea)) {
        if (sea.sourceRef) vis.preloadRefs([sea.sourceRef]);
        items.push(toSeabedItem(sea, ["id"], 1));
      }
      const dist = this.db.getDistillation(query.id);
      if (dist && vis.canSeeDistillation(dist)) {
        vis.preloadRefs(dist.sourceIds);
        items.push(toDistillationItem(dist, ["id"], 1));
      }
      annotateRecallPage(items);
      return {
        viewerRealmId: query.viewerRealmId,
        items,
        totalMatched: items.length,
        omittedCount: 0,
        vectorUsed: false,
        message:
          items.length > 0
            ? `Resolved exact entry ${query.id}.`
            : "No matching entries found within your visible realm scope.",
      };
    }

    // Stage 1b: Direct thingId timeline lookup (excludes secret in SQL + JS)
    if (query.thingId && !query.query) {
      const res = this.db.listRecords({
        realmIds: ledgerRealmIds,
        thingId: query.thingId,
        kinds: query.recordKinds,
        authorId: query.authorId,
        includeSuperseded,
        since: query.since,
        until: query.until,
        excludeSensitivities: ["secret"],
        limit,
        offset,
      });
      const visible = res.items.filter(
        (r) => r.sensitivity !== "secret" && vis.canSeeRecord(r),
      );
      const refsToPreload: string[] = [];
      for (const r of visible) {
        refsToPreload.push(...r.refs);
        if (r.supersedesId) refsToPreload.push(r.supersedesId);
        if (r.supersedesIds) refsToPreload.push(...r.supersedesIds);
        if (r.supersededById) refsToPreload.push(r.supersededById);
      }
      vis.preloadRefs(refsToPreload);
      const items = annotateRecallPage(
        visible.map((r) => toRecordItem(r, ["id", "filter"], 1)),
      );
      return {
        viewerRealmId: query.viewerRealmId,
        items,
        totalMatched: res.total,
        omittedCount: Math.max(0, res.total - offset - items.length),
        vectorUsed: false,
        message:
          items.length > 0
            ? `Found ${res.total} ledger record(s) for thing ${query.thingId}.`
            : "No matching entries found within your visible realm scope.",
      };
    }

    // Stage 2: Pure structured filter with exact SQL COUNT(*) (excludes secret, filters occurred_at)
    if (!query.query || !query.query.trim()) {
      const wantRecords =
        !query.seabedKinds || (query.recordKinds && query.recordKinds.length > 0);
      const wantSeabed =
        !query.recordKinds || (query.seabedKinds && query.seabedKinds.length > 0);

      const fetchWindow = offset + limit;
      let totalMatched = 0;
      const rawRecs: LedgerRecord[] = [];
      const rawSeas: SeabedEntry[] = [];

      if (wantRecords && ledgerRealmIds.length > 0) {
        const recRes = this.db.listRecords({
          realmIds: ledgerRealmIds,
          kinds: query.recordKinds,
          authorId: query.authorId,
          includeSuperseded,
          since: query.since,
          until: query.until,
          excludeSensitivities: ["secret"],
          limit: fetchWindow,
          offset: 0,
        });
        totalMatched += recRes.total;
        for (const r of recRes.items) {
          if (r.sensitivity !== "secret" && vis.canSeeRecord(r)) {
            rawRecs.push(r);
          }
        }
      }

      if (wantSeabed && seabedRealmIds.length > 0) {
        const seaRes = this.db.listSeabedEntries({
          realmIds: seabedRealmIds,
          kinds: query.seabedKinds,
          authorId: query.authorId,
          since: query.since,
          until: query.until,
          excludeSensitivities: ["secret"],
          limit: fetchWindow,
          offset: 0,
        });
        totalMatched += seaRes.total;
        for (const s of seaRes.items) {
          if (s.sensitivity !== "secret" && vis.canSeeSeabed(s)) {
            rawSeas.push(s);
          }
        }
      }

      const refsToPreload: string[] = [];
      for (const r of rawRecs) {
        refsToPreload.push(...r.refs);
        if (r.supersedesId) refsToPreload.push(r.supersedesId);
        if (r.supersedesIds) refsToPreload.push(...r.supersedesIds);
        if (r.supersededById) refsToPreload.push(r.supersededById);
      }
      for (const s of rawSeas) {
        if (s.sourceRef) refsToPreload.push(s.sourceRef);
      }
      vis.preloadRefs(refsToPreload);

      const combined: RecallItem[] = [
        ...rawRecs.map((r) => toRecordItem(r, ["filter"], 1)),
        ...rawSeas.map((s) => toSeabedItem(s, ["filter"], 0.9)),
      ];
      combined.sort(compareRecencyDesc);
      const page = annotateRecallPage(combined.slice(offset, offset + limit));
      return {
        viewerRealmId: query.viewerRealmId,
        items: page,
        totalMatched,
        omittedCount: Math.max(0, totalMatched - offset - page.length),
        vectorUsed: false,
        message:
          page.length > 0
            ? `Returned ${page.length} of ${totalMatched} filtered entries.`
            : "No matching entries found within your visible realm scope.",
      };
    }

    // Stages 3 & 4: Comparable Staged FTS5 (Pass 1 AND + Pass 2 OR via unified fts_docs) + Vector + Strict Total-Order Lexicographic Rank
    if (allowedEntrySet && allowedEntrySet.size === 0) {
      return {
        viewerRealmId: query.viewerRealmId,
        items: [],
        totalMatched: 0,
        omittedCount: 0,
        vectorUsed: false,
        message: "No matching entries found within your visible realm scope.",
      };
    }

    const parsedQuery = parseSearchQuery(query.query, { extractDates: true });
    const dateConcepts = parsedQuery.dateConcepts ?? [];
    const hasDates = dateConcepts.length > 0;
    const isPureDateQuery = hasDates && parsedQuery.concepts.length === 0;
    const candidateLimit = Math.max((offset + limit) * 5, 100);

    const pass1Map = new Map<
      string,
      { sourceType: "record" | "seabed" | "distillation"; rank: number }
    >();
    const pass2Map = new Map<
      string,
      { sourceType: "record" | "seabed" | "distillation"; rank: number }
    >();
    const dateWindowMap = new Map<
      string,
      { sourceType: "record" | "seabed" | "distillation" }
    >();

    let sqlTotal = 0;
    let ftsCapped = false;

    const dateWindows = hasDates ? dateConcepts.map((d) => d.window) : [];
    const combinedDateLiteralExpr = hasDates
      ? dateConcepts.length === 1
        ? dateConcepts[0]!.ftsLiteralExpr
        : dateConcepts.map((d) => `(${d.ftsLiteralExpr})`).join(" OR ")
      : null;

    if (isPureDateQuery) {
      // Pure date-only query: union structured occurred_at ±1 day window WITH literal date phrase FTS
      const windowRes = this.db.listEntriesByDateWindow({
        dateWindows,
        ledgerRealmIds,
        seabedRealmIds,
        includeSuperseded,
        recordKinds: query.recordKinds,
        seabedKinds: query.seabedKinds,
        since: query.since,
        until: query.until,
        allowedEntryIds: query.allowedEntryIds,
        perBucketLimit: candidateLimit,
      });
      for (const m of windowRes.rows) {
        dateWindowMap.set(m.itemId, { sourceType: m.sourceType });
      }

      const literalRes = combinedDateLiteralExpr
        ? this.db.searchFtsUnified({
            ftsExpression: combinedDateLiteralExpr,
            ledgerRealmIds,
            seabedRealmIds,
            includeSuperseded,
            recordKinds: query.recordKinds,
            seabedKinds: query.seabedKinds,
            since: query.since,
            until: query.until,
            allowedEntryIds: query.allowedEntryIds,
            perBucketLimit: candidateLimit,
          })
        : { rows: [], total: 0, ledgerCount: 0, seabedCount: 0 };
      for (const m of literalRes.rows) {
        pass1Map.set(m.itemId, { sourceType: m.sourceType, rank: m.rank });
      }

      // Deduplicate overlap in totalMatched via inclusion-exclusion (exact even above perBucketLimit)
      let overlapCount = 0;
      if (windowRes.total > 0 && literalRes.total > 0 && combinedDateLiteralExpr) {
        if (
          windowRes.total === windowRes.rows.length &&
          literalRes.total === literalRes.rows.length
        ) {
          for (const id of dateWindowMap.keys()) {
            if (pass1Map.has(id)) overlapCount += 1;
          }
        } else {
          overlapCount = this.db.searchFtsUnified({
            ftsExpression: combinedDateLiteralExpr,
            dateWindows,
            ledgerRealmIds,
            seabedRealmIds,
            includeSuperseded,
            recordKinds: query.recordKinds,
            seabedKinds: query.seabedKinds,
            since: query.since,
            until: query.until,
            allowedEntryIds: query.allowedEntryIds,
            perBucketLimit: 1,
          }).total;
        }
      }
      sqlTotal = Math.max(0, windowRes.total + literalRes.total - overlapCount);
      ftsCapped =
        windowRes.total > windowRes.rows.length ||
        literalRes.total > literalRes.rows.length;
    } else {
      // Pass 1: All-concept AND (single unified SQL statement over fts_index + fts_docs)
      const pass1Res = parsedQuery.ftsAndExpression
        ? this.db.searchFtsUnified({
            ftsExpression: parsedQuery.ftsAndExpression,
            ledgerRealmIds,
            seabedRealmIds,
            includeSuperseded,
            recordKinds: query.recordKinds,
            seabedKinds: query.seabedKinds,
            since: query.since,
            until: query.until,
            allowedEntryIds: query.allowedEntryIds,
            perBucketLimit: candidateLimit,
          })
        : { rows: [], total: 0, ledgerCount: 0, seabedCount: 0 };
      for (const m of pass1Res.rows) {
        pass1Map.set(m.itemId, { sourceType: m.sourceType, rank: m.rank });
      }

      // Pass 2: Broad partial OR (only run separately when distinct from Pass 1)
      const hasDistinctPass2 =
        parsedQuery.ftsOrExpression !== null &&
        parsedQuery.ftsOrExpression !== parsedQuery.ftsAndExpression;
      const pass2Res =
        hasDistinctPass2 && parsedQuery.ftsOrExpression
          ? this.db.searchFtsUnified({
              ftsExpression: parsedQuery.ftsOrExpression,
              ledgerRealmIds,
              seabedRealmIds,
              includeSuperseded,
              recordKinds: query.recordKinds,
              seabedKinds: query.seabedKinds,
              since: query.since,
              until: query.until,
              allowedEntryIds: query.allowedEntryIds,
              perBucketLimit: candidateLimit,
            })
          : pass1Res;
      if (hasDistinctPass2) {
        for (const m of pass2Res.rows) {
          pass2Map.set(m.itemId, { sourceType: m.sourceType, rank: m.rank });
        }
      }

      // Mixed query with date concepts: run supplemental Date-Window Pass AND Literal-Date Pass,
      // merging insert-if-absent so Pass 2's BM25 rank is never overwritten.
      if (hasDates && parsedQuery.ftsOrExpression) {
        const dateTargetMap = hasDistinctPass2 ? pass2Map : pass1Map;
        const dateWindowFtsRes = this.db.searchFtsUnified({
          ftsExpression: parsedQuery.ftsOrExpression,
          dateWindows,
          ledgerRealmIds,
          seabedRealmIds,
          includeSuperseded,
          recordKinds: query.recordKinds,
          seabedKinds: query.seabedKinds,
          since: query.since,
          until: query.until,
          allowedEntryIds: query.allowedEntryIds,
          perBucketLimit: candidateLimit,
        });
        for (const m of dateWindowFtsRes.rows) {
          if (!dateTargetMap.has(m.itemId)) {
            dateTargetMap.set(m.itemId, {
              sourceType: m.sourceType,
              rank: m.rank,
            });
          }
        }

        if (combinedDateLiteralExpr) {
          const dateLiteralFtsRes = this.db.searchFtsUnified({
            ftsExpression: `(${parsedQuery.ftsOrExpression}) AND (${combinedDateLiteralExpr})`,
            ledgerRealmIds,
            seabedRealmIds,
            includeSuperseded,
            recordKinds: query.recordKinds,
            seabedKinds: query.seabedKinds,
            since: query.since,
            until: query.until,
            allowedEntryIds: query.allowedEntryIds,
            perBucketLimit: candidateLimit,
          });
          for (const m of dateLiteralFtsRes.rows) {
            if (!dateTargetMap.has(m.itemId)) {
              dateTargetMap.set(m.itemId, {
                sourceType: m.sourceType,
                rank: m.rank,
              });
            }
          }
        }
      }

      // Exact SQL total from Pass 2 (OR) when Pass 2 executes, else from Pass 1
      sqlTotal = pass2Res.total;
      ftsCapped =
        pass2Res.total > pass2Res.rows.length ||
        pass1Res.total > pass1Res.rows.length;
    }

    let vectorUsed = false;
    const vecMap = new Map<
      string,
      { sourceType: "record" | "seabed" | "distillation"; cosine: number }
    >();
    if (this.db.vecEnabled && this.embedder.configured) {
      const qVec = await this.embedder.embed(query.query);
      if (qVec) {
        vectorUsed = true;
        const ledgerVec =
          ledgerRealmIds.length > 0
            ? this.db.searchVectors({
                embedding: qVec,
                realmIds: ledgerRealmIds,
                sourceTypes: ["record", "distillation"],
                includeSuperseded,
                limit: candidateLimit,
              })
            : [];
        const seabedVec =
          seabedRealmIds.length > 0
            ? this.db.searchVectors({
                embedding: qVec,
                realmIds: seabedRealmIds,
                sourceTypes: ["seabed"],
                includeSuperseded,
                limit: candidateLimit,
              })
            : [];
        for (const m of [...ledgerVec, ...seabedVec]) {
          // Filter out orthogonal/unrelated vectors (unit L2 distance >= 1.25 => cosine <= ~0.22)
          if (m.distance > 1.25) continue;
          const cosine = Math.max(-1, Math.min(1, 1 - (m.distance * m.distance) / 2));
          const prev = vecMap.get(m.itemId);
          if (!prev || cosine > prev.cosine) {
            vecMap.set(m.itemId, { sourceType: m.sourceType, cosine });
          }
        }
      }
    }

    // Collect unique candidate IDs by sourceType for O(1) batched hydration
    const recordCandIds: string[] = [];
    const seabedCandIds: string[] = [];
    const distCandIds: string[] = [];
    const candidateSourceMap = new Map<
      string,
      "record" | "seabed" | "distillation"
    >();

    for (const [id, info] of pass1Map.entries()) {
      candidateSourceMap.set(id, info.sourceType);
    }
    for (const [id, info] of pass2Map.entries()) {
      if (!candidateSourceMap.has(id)) {
        candidateSourceMap.set(id, info.sourceType);
      }
    }
    for (const [id, info] of dateWindowMap.entries()) {
      if (!candidateSourceMap.has(id)) {
        candidateSourceMap.set(id, info.sourceType);
      }
    }
    for (const [id, info] of vecMap.entries()) {
      if (!candidateSourceMap.has(id)) {
        candidateSourceMap.set(id, info.sourceType);
      }
    }

    for (const [id, sourceType] of candidateSourceMap.entries()) {
      if (sourceType === "record") recordCandIds.push(id);
      else if (sourceType === "seabed") seabedCandIds.push(id);
      else distCandIds.push(id);
    }

    const hydratedRecords = new Map(
      this.db.getRecordsByIds(recordCandIds).map((r) => [r.id, r]),
    );
    const hydratedSeabed = new Map(
      this.db.getSeabedEntriesByIds(seabedCandIds).map((s) => [s.id, s]),
    );
    const hydratedDists = new Map(
      this.db.getDistillationsByIds(distCandIds).map((d) => [d.id, d]),
    );

    type MatchSource = "pass1" | "pass2" | "vector" | "filter";
    interface RankedCandidate {
      id: string;
      sourceType: "record" | "seabed" | "distillation";
      record?: LedgerRecord;
      seabed?: SeabedEntry;
      distillation?: Distillation;
      realmId: string;
      occurredAt: string | null;
      createdAt: string;
      matchedBy: Array<"filter" | "fts" | "vector">;
      coverageTier: number;
      coverageRatioBand: number;
      lexicalMatchFlag: number;
      statusPriority: number;
      matchSource: MatchSource;
      rawRelevance: number;
      relevanceBand: number;
      isOlderSameObjectSibling: number;
      focusFlag: number;
      objectIds: string[];
      bestPassage?: { text: string; start: number; end: number; totalLen: number };
    }

    const PASSAGE_WINDOW_CHARS = 2000;
    const PASSAGE_STRIDE_CHARS = 1000;
    const PASSAGE_DATE_LEFT_PAD = 8;

    const concepts = parsedQuery.concepts;
    const totalConceptCount = concepts.length + dateConcepts.length;
    let ftsRejectedByJsCount = 0;
    let vectorOnlyHydratedCount = 0;

    const evaluateCandidate = (params: {
      id: string;
      sourceType: "record" | "seabed" | "distillation";
      record?: LedgerRecord;
      seabed?: SeabedEntry;
      distillation?: Distillation;
      realmId: string;
      status: string;
      occurredAt: string | null;
      createdAt: string;
      titleText: string;
      bodyText: string;
    }): RankedCandidate | null => {
      const p1 = pass1Map.get(params.id);
      const p2 = pass2Map.get(params.id);
      const vec = vecMap.get(params.id);
      const inDateWindow = dateWindowMap.has(params.id);
      const hasFts = Boolean(p1 || p2);
      const hasVector = Boolean(vec);

      // Pre-compute lowercased title & body ONCE per candidate
      const titleLower = params.titleText.toLowerCase();
      const bodyLower = params.bodyText.toLowerCase();

      // Title coverage & occurredAt date matches apply globally across all passages
      const titleScores: number[] = [];
      let textTitleAllCovered = concepts.length > 0;
      for (const c of concepts) {
        const threshold = c.isCjk ? CJK_COVERAGE_THRESHOLD : 1.0;
        const ts = c.scoreText(params.titleText, titleLower);
        titleScores.push(ts);
        if (ts < threshold) {
          textTitleAllCovered = false;
        }
      }

      const dateTitleHits: boolean[] = [];
      let dateTitleAllSatisfied = hasDates;
      if (hasDates) {
        for (const dc of dateConcepts) {
          const occHit = dc.matchOccurredAt(params.occurredAt);
          const titleHit = occHit || dc.matchLiteralText(params.titleText);
          dateTitleHits.push(titleHit);
          if (!titleHit) {
            dateTitleAllSatisfied = false;
          }
        }
      }

      let textFullAllCovered = concepts.length > 0;
      let scoreSum = 0;
      let dateSatisfiedCount = 0;
      let dateAllSatisfied = hasDates;
      let bestPassage:
        | { text: string; start: number; end: number; totalLen: number }
        | undefined;

      const bodyLen = params.bodyText.length;
      if (bodyLen <= PASSAGE_WINDOW_CHARS) {
        const fullText = `${params.titleText}\n${params.bodyText}`;
        const fullLower = `${titleLower}\n${bodyLower}`;
        for (const c of concepts) {
          const threshold = c.isCjk ? CJK_COVERAGE_THRESHOLD : 1.0;
          const fullScore = c.scoreText(fullText, fullLower);
          if (fullScore < threshold) {
            textFullAllCovered = false;
          }
          scoreSum += fullScore;
        }
        if (hasDates) {
          for (let j = 0; j < dateConcepts.length; j += 1) {
            const dc = dateConcepts[j]!;
            const fullHit =
              dateTitleHits[j]! || dc.matchLiteralText(params.bodyText);
            if (fullHit) {
              dateSatisfiedCount += 1;
            } else {
              dateAllSatisfied = false;
            }
          }
        }
      } else {
        // Fixed-stride overlapping local-passage evaluation (W=2000, stride=1000, threshold=W).
        // Pre-filter concepts absent from the entire body and reuse title scores to avoid redundant
        // per-window regex allocations on multi-hundred-KB documents (exact same mathematical result).
        let baseTitleScoreSum = 0;
        let baseTitleCoveredCount = 0;
        let baseTitleLexAll = concepts.length > 0;
        const activeBodyConcepts: Array<{
          concept: SearchConcept;
          threshold: number;
          titleScore: number;
          needsTitleUnion: boolean;
        }> = [];
        for (let i = 0; i < concepts.length; i += 1) {
          const c = concepts[i]!;
          const threshold = c.isCjk ? CJK_COVERAGE_THRESHOLD : 1.0;
          const ts = titleScores[i]!;
          if (ts >= 1.0) {
            baseTitleScoreSum += ts;
            baseTitleCoveredCount += 1;
            continue;
          }
          // When activeBodyDates is empty, the branch-and-bound indexOf pass below
          // already discovers absent concepts in a single pass without scanning bodyLower twice.
          if (hasDates && c.scoreText(params.bodyText, bodyLower) === 0) {
            baseTitleScoreSum += ts;
            if (ts >= threshold) {
              baseTitleCoveredCount += 1;
            } else {
              baseTitleLexAll = false;
            }
            continue;
          }
          activeBodyConcepts.push({
            concept: c,
            threshold,
            titleScore: ts,
            needsTitleUnion: ts > 0 && c.isCjk,
          });
        }

        const activeBodyDates: DateConcept[] = [];
        let baseDateCount = 0;
        let baseDateAll = hasDates;
        if (hasDates) {
          for (let j = 0; j < dateConcepts.length; j += 1) {
            if (dateTitleHits[j]!) {
              baseDateCount += 1;
            } else if (dateConcepts[j]!.matchLiteralText(params.bodyText)) {
              activeBodyDates.push(dateConcepts[j]!);
            } else {
              baseDateAll = false;
            }
          }
        }

        if (activeBodyConcepts.length === 0 && activeBodyDates.length === 0) {
          textFullAllCovered = baseTitleLexAll;
          scoreSum = baseTitleScoreSum;
          dateSatisfiedCount = baseDateCount;
          dateAllSatisfied = baseDateAll;
        } else {
          const needTitleUnion = activeBodyConcepts.some((a) => a.needsTitleUnion);
          const titlePrefix = needTitleUnion ? `${params.titleText}\n` : "";
          const titleLowerPrefix = needTitleUnion ? `${titleLower}\n` : "";
          const numWindows = Math.max(
            1,
            Math.ceil((bodyLen - PASSAGE_WINDOW_CHARS) / PASSAGE_STRIDE_CHARS) +
              1,
          );
          let bestAllCovered = -1;
          let bestTotalScore = -1;
          let bestLexCoveredCount = -1;
          let bestStart = 0;
          let bestEnd = Math.min(bodyLen, PASSAGE_WINDOW_CHARS);

          const evaluateWindow = (w: number): void => {
            const start = w * PASSAGE_STRIDE_CHARS;
            const end = Math.min(bodyLen, start + PASSAGE_WINDOW_CHARS);
            const slice = params.bodyText.slice(start, end);
            const sliceLower = bodyLower.slice(start, end);
            // P2-1: pad 1 word-character on left/right for non-CJK boundary regexes so a
            // window cut mid-word (e.g. "config|uration") never fabricates a false word boundary.
            const leftWordPad =
              start > 0 && /[A-Za-z0-9_:/-]/.test(params.bodyText[start - 1]!)
                ? params.bodyText[start - 1]!
                : "";
            const rightWordPad =
              end < bodyLen && /[A-Za-z0-9_:/-]/.test(params.bodyText[end]!)
                ? params.bodyText[end]!
                : "";
            const boundarySlice =
              leftWordPad || rightWordPad
                ? `${leftWordPad}${slice}${rightWordPad}`
                : slice;
            const winText = needTitleUnion ? titlePrefix + slice : slice;
            const winLower = needTitleUnion ? titleLowerPrefix + sliceLower : sliceLower;

            let winLexAll = baseTitleLexAll;
            let winScoreSum = baseTitleScoreSum;
            let winLexCoveredCount = baseTitleCoveredCount;
            for (let k = 0; k < activeBodyConcepts.length; k += 1) {
              const ac = activeBodyConcepts[k]!;
              const s = ac.needsTitleUnion
                ? ac.concept.scoreText(winText, winLower)
                : Math.max(
                    ac.titleScore,
                    ac.concept.isCjk
                      ? ac.concept.scoreText(slice, sliceLower)
                      : ac.concept.scoreText(boundarySlice),
                  );
              if (s >= ac.threshold) {
                winLexCoveredCount += 1;
              } else {
                winLexAll = false;
              }
              winScoreSum += s;
            }

            let winDateCount = baseDateCount;
            let winDateAll = baseDateAll;
            if (activeBodyDates.length > 0) {
              // P2-2: prepend ONLY an immediately preceding "YYYY年" prefix before `start`
              // so a split year-prefix ("2025年|10月10日") is preserved without dragging a
              // separate date from the pad region into this window.
              let dateSlice = slice;
              if (start > 0) {
                const lookBack = params.bodyText.slice(
                  Math.max(0, start - PASSAGE_DATE_LEFT_PAD),
                  start,
                );
                const yearPrefixMatch = /(\d{4}\s*年\s*)$/.exec(lookBack);
                if (yearPrefixMatch) {
                  dateSlice = yearPrefixMatch[1]! + slice;
                }
              }
              for (let j = 0; j < activeBodyDates.length; j += 1) {
                if (activeBodyDates[j]!.matchLiteralText(dateSlice)) {
                  winDateCount += 1;
                } else {
                  winDateAll = false;
                }
              }
            }

            const winFullAll =
              concepts.length > 0 && hasDates
                ? winLexAll && winDateAll
                : concepts.length > 0
                  ? winLexAll
                  : hasDates
                    ? winDateAll
                    : false;
            const winAllFlag = winFullAll ? 1 : 0;
            const winTotalScore = winScoreSum + winDateCount;

            if (
              winAllFlag > bestAllCovered ||
              (winAllFlag === bestAllCovered && winTotalScore > bestTotalScore) ||
              (winAllFlag === bestAllCovered &&
                winTotalScore === bestTotalScore &&
                winLexCoveredCount > bestLexCoveredCount) ||
              (winAllFlag === bestAllCovered &&
                winTotalScore === bestTotalScore &&
                winLexCoveredCount === bestLexCoveredCount &&
                start < bestStart)
            ) {
              bestAllCovered = winAllFlag;
              bestTotalScore = winTotalScore;
              bestLexCoveredCount = winLexCoveredCount;
              textFullAllCovered = winLexAll;
              scoreSum = winScoreSum;
              dateSatisfiedCount = winDateCount;
              dateAllSatisfied = winDateAll;
              bestStart = start;
              bestEnd = end;
            }
          };

          if (!needTitleUnion && activeBodyDates.length === 0 && numWindows > 4) {
            // Exact branch-and-bound pre-filter: mark windows containing >=1 term per active concept
            // via SIMD indexOf (jumping past already-marked blocks), then evaluate highest-hit buckets first.
            const winHits = new Uint16Array(numWindows);
            const winSeen = new Int32Array(numWindows).fill(-1);
            let maxHits = 0;
            for (let k = 0; k < activeBodyConcepts.length; k += 1) {
              const terms = activeBodyConcepts[k]!.concept.terms;
              for (let ti = 0; ti < terms.length; ti += 1) {
                const needle = terms[ti]!.toLowerCase();
                if (!needle) continue;
                const nLen = needle.length;
                let pos = bodyLower.indexOf(needle, 0);
                while (pos !== -1) {
                  const wMax = Math.min(
                    numWindows - 1,
                    Math.floor(pos / PASSAGE_STRIDE_CHARS),
                  );
                  const wMin = Math.max(
                    0,
                    Math.ceil(
                      (pos + nLen - PASSAGE_WINDOW_CHARS) / PASSAGE_STRIDE_CHARS,
                    ),
                  );
                  for (let w = wMin; w <= wMax; w += 1) {
                    if (winSeen[w] !== k) {
                      winSeen[w] = k;
                      const nh = winHits[w]! + 1;
                      winHits[w] = nh;
                      if (nh > maxHits) maxHits = nh;
                    }
                  }
                  if (wMax >= numWindows - 1) break;
                  const nextFrom = (wMax + 1) * PASSAGE_STRIDE_CHARS;
                  if (nextFrom >= bodyLen) break;
                  pos = bodyLower.indexOf(needle, nextFrom);
                }
              }
            }

            if (maxHits === 0) {
              evaluateWindow(0);
            } else {
              for (let h = maxHits; h >= 1; h -= 1) {
                const upperScore = baseTitleScoreSum + h;
                if (bestTotalScore > upperScore) break;
                if (
                  bestTotalScore >= upperScore &&
                  (bestAllCovered === 1 ||
                    baseTitleCoveredCount + h < concepts.length)
                ) {
                  break;
                }
                let bucketSaturated = false;
                for (let w = 0; w < numWindows; w += 1) {
                  if (winHits[w] === h) {
                    evaluateWindow(w);
                    if (
                      bestTotalScore >= upperScore &&
                      bestLexCoveredCount >= baseTitleCoveredCount + h
                    ) {
                      bucketSaturated = true;
                      break;
                    }
                  }
                }
                if (bucketSaturated) break;
              }
            }
          } else {
            for (let w = 0; w < numWindows; w += 1) {
              evaluateWindow(w);
            }
          }

          if (bestTotalScore > 0) {
            bestPassage = {
              text: params.bodyText.slice(bestStart, bestEnd),
              start: bestStart,
              end: bestEnd,
              totalLen: bodyLen,
            };
          }
        }
      }

      const dateSatisfied = dateSatisfiedCount > 0;
      const hasFilterDate = inDateWindow && dateSatisfied;
      const hasLexicalOrDate = hasFts || hasFilterDate;

      const matchedBy: Array<"filter" | "fts" | "vector"> = [];
      if (hasFilterDate) matchedBy.push("filter");
      if (hasFts) matchedBy.push("fts");
      if (hasVector) matchedBy.push("vector");

      const titleAllCovered =
        concepts.length > 0 && hasDates
          ? textTitleAllCovered && dateTitleAllSatisfied
          : concepts.length > 0
            ? textTitleAllCovered
            : hasDates
              ? dateTitleAllSatisfied
              : false;
      const fullAllCovered =
        concepts.length > 0 && hasDates
          ? textFullAllCovered && dateAllSatisfied
          : concepts.length > 0
            ? textFullAllCovered
            : hasDates
              ? dateAllSatisfied
              : false;
      const coverageRatio =
        totalConceptCount > 0
          ? (scoreSum + dateSatisfiedCount) / totalConceptCount
          : 0;

      // Reject FTS-only false positives where identifier, lexical, or date terms scored 0 in JS
      if (
        hasFts &&
        !hasVector &&
        !hasFilterDate &&
        totalConceptCount > 0 &&
        coverageRatio === 0
      ) {
        ftsRejectedByJsCount += 1;
        return null;
      }

      // Compute coverageTier, coverageRatioBand, lexicalMatchFlag, and comparable matchSource/rawRelevance.
      // SQLite bm25() returns NEGATIVE numbers (more negative = more relevant), so positive magnitude = -rank.
      let coverageTier = 0;
      let coverageRatioBand = 0;
      let lexicalMatchFlag = 0;
      let matchSource: MatchSource = "vector";
      let rawRelevance = vec ? vec.cosine : 0;

      const p1Magnitude = p1 ? Math.max(0, -p1.rank) : null;
      const p2Magnitude = p2 ? Math.max(0, -p2.rank) : null;

      if (hasLexicalOrDate && titleAllCovered) {
        coverageTier = 4;
        coverageRatioBand = 10;
        lexicalMatchFlag = hasFts ? 1 : 0;
        if (p1Magnitude !== null) {
          matchSource = "pass1";
          rawRelevance = p1Magnitude;
        } else if (p2Magnitude !== null) {
          matchSource = "pass2";
          rawRelevance = p2Magnitude;
        } else {
          matchSource = "filter";
          rawRelevance = 0;
        }
      } else if (hasLexicalOrDate && fullAllCovered) {
        coverageTier = 3;
        coverageRatioBand = 10;
        lexicalMatchFlag = hasFts ? 1 : 0;
        if (p1Magnitude !== null) {
          matchSource = "pass1";
          rawRelevance = p1Magnitude;
        } else if (p2Magnitude !== null) {
          matchSource = "pass2";
          rawRelevance = p2Magnitude;
        } else {
          matchSource = "filter";
          rawRelevance = 0;
        }
      } else if (hasLexicalOrDate && coverageRatio >= 0.5) {
        coverageTier = 2;
        coverageRatioBand = Math.round(coverageRatio * 10);
        lexicalMatchFlag = hasFts ? 1 : 0;
        if (p2Magnitude !== null) {
          matchSource = "pass2";
          rawRelevance = p2Magnitude;
        } else if (p1Magnitude !== null) {
          matchSource = "pass1";
          rawRelevance = p1Magnitude;
        } else {
          matchSource = "filter";
          rawRelevance = 0;
        }
      } else if (hasVector && vec!.cosine >= 0.75) {
        // High-confidence semantic hit (pure vector-only or weak-lexical hybrid) placed in Tier 2
        coverageTier = 2;
        coverageRatioBand = vec!.cosine >= 0.85 ? 10 : 8;
        lexicalMatchFlag = hasFts && coverageRatio > 0 ? 1 : 0;
        matchSource = "vector";
        rawRelevance = vec!.cosine;
      } else if (hasLexicalOrDate && coverageRatio > 0) {
        coverageTier = 1;
        coverageRatioBand = Math.round(coverageRatio * 10);
        lexicalMatchFlag = hasFts ? 1 : 0;
        if (p2Magnitude !== null) {
          matchSource = "pass2";
          rawRelevance = p2Magnitude;
        } else if (p1Magnitude !== null) {
          matchSource = "pass1";
          rawRelevance = p1Magnitude;
        } else {
          matchSource = "filter";
          rawRelevance = 0;
        }
      } else if (hasVector) {
        coverageTier = 0;
        coverageRatioBand = 0;
        lexicalMatchFlag = 0;
        matchSource = "vector";
        rawRelevance = vec!.cosine;
      } else {
        return null;
      }

      let statusPriority = 2;
      if (params.status === "superseded") {
        statusPriority = 1;
      } else if (params.status === "retracted") {
        statusPriority = 0;
      } else if (params.sourceType === "seabed") {
        statusPriority = 2;
      } else {
        statusPriority = 3;
      }

      if (!hasFts && !hasFilterDate && hasVector) {
        vectorOnlyHydratedCount += 1;
      }

      return {
        id: params.id,
        sourceType: params.sourceType,
        record: params.record,
        seabed: params.seabed,
        distillation: params.distillation,
        realmId: params.realmId,
        occurredAt: params.occurredAt,
        createdAt: params.createdAt,
        matchedBy,
        coverageTier,
        coverageRatioBand,
        lexicalMatchFlag,
        statusPriority,
        matchSource,
        rawRelevance,
        relevanceBand: 1,
        isOlderSameObjectSibling: 0,
        focusFlag: 0,
        objectIds: [],
        bestPassage,
      };
    };

    const candidates: RankedCandidate[] = [];

    for (const [itemId, sourceType] of candidateSourceMap.entries()) {
      const isSqlCountedCandidate =
        pass1Map.has(itemId) || pass2Map.has(itemId) || dateWindowMap.has(itemId);
      const rejectIfFts = () => {
        if (isSqlCountedCandidate) ftsRejectedByJsCount += 1;
      };
      if (allowedEntrySet && !allowedEntrySet.has(itemId)) {
        rejectIfFts();
        continue;
      }
      if (sourceType === "record") {
        const rec = hydratedRecords.get(itemId);
        if (!rec || rec.sensitivity === "secret" || !vis.canSeeRecord(rec)) {
          rejectIfFts();
          continue;
        }
        if (rec.status === "retracted" || rec.redactedAt !== null) {
          rejectIfFts();
          continue;
        }
        if (!includeSuperseded && rec.status !== "active") {
          rejectIfFts();
          continue;
        }
        if (query.thingId && rec.thingId !== query.thingId) {
          rejectIfFts();
          continue;
        }
        if (query.seabedKinds && !query.recordKinds) {
          rejectIfFts();
          continue;
        }
        if (query.recordKinds && !query.recordKinds.includes(rec.kind)) {
          rejectIfFts();
          continue;
        }
        if (query.authorId && rec.authorId !== query.authorId) {
          rejectIfFts();
          continue;
        }
        if (query.since && (rec.occurredAt === null || rec.occurredAt < query.since)) {
          rejectIfFts();
          continue;
        }
        if (query.until && (rec.occurredAt === null || rec.occurredAt > query.until)) {
          rejectIfFts();
          continue;
        }

        const bodyText = buildRecordFtsBody(rec.payload);
        const cand = evaluateCandidate({
          id: rec.id,
          sourceType: "record",
          record: rec,
          realmId: rec.realmId,
          status: rec.status,
          occurredAt: rec.occurredAt,
          createdAt: rec.createdAt,
          titleText: rec.title,
          bodyText,
        });
        if (cand) candidates.push(cand);
      } else if (sourceType === "seabed") {
        if (query.thingId) {
          rejectIfFts();
          continue;
        }
        const sea = hydratedSeabed.get(itemId);
        if (!sea || sea.sensitivity === "secret" || !vis.canSeeSeabed(sea)) {
          rejectIfFts();
          continue;
        }
        if (sea.redactedAt !== null) {
          rejectIfFts();
          continue;
        }
        if (query.recordKinds && !query.seabedKinds) {
          rejectIfFts();
          continue;
        }
        if (query.seabedKinds && !query.seabedKinds.includes(sea.kind)) {
          rejectIfFts();
          continue;
        }
        if (query.authorId && sea.authorId !== query.authorId) {
          rejectIfFts();
          continue;
        }
        if (query.since && (sea.occurredAt === null || sea.occurredAt < query.since)) {
          rejectIfFts();
          continue;
        }
        if (query.until && (sea.occurredAt === null || sea.occurredAt > query.until)) {
          rejectIfFts();
          continue;
        }

        const titleText = `${sea.kind}:${sea.topicId ?? sea.realmId}`;
        const cand = evaluateCandidate({
          id: sea.id,
          sourceType: "seabed",
          seabed: sea,
          realmId: sea.realmId,
          status: "evidence",
          occurredAt: sea.occurredAt,
          createdAt: sea.createdAt,
          titleText,
          bodyText: sea.text,
        });
        if (cand) candidates.push(cand);
      } else {
        if (query.thingId) {
          rejectIfFts();
          continue;
        }
        if (query.authorId && query.authorId !== "system") {
          rejectIfFts();
          continue;
        }
        const dist = hydratedDists.get(itemId);
        if (!dist || !vis.canSeeDistillation(dist)) {
          rejectIfFts();
          continue;
        }
        if (dist.status === "retracted") {
          rejectIfFts();
          continue;
        }
        if (!includeSuperseded && dist.status !== "active") {
          rejectIfFts();
          continue;
        }
        if (query.recordKinds || query.seabedKinds) {
          rejectIfFts();
          continue;
        }
        if (query.since && dist.createdAt < query.since) {
          rejectIfFts();
          continue;
        }
        if (query.until && dist.createdAt > query.until) {
          rejectIfFts();
          continue;
        }

        const titleText = `${dist.layer}:${dist.periodKey}`;
        const cand = evaluateCandidate({
          id: dist.id,
          sourceType: "distillation",
          distillation: dist,
          realmId: dist.realmId,
          status: dist.status,
          occurredAt: dist.createdAt,
          createdAt: dist.createdAt,
          titleText,
          bodyText: dist.narrativeMd,
        });
        if (cand) candidates.push(cand);
      }
    }

    // Step A: Compute comparable relevanceBand strictly within each (coverageTier, matchSource) group
    const groupBest = new Map<string, number>();
    for (const c of candidates) {
      const key = `${c.coverageTier}:${c.matchSource}`;
      const prev = groupBest.get(key);
      if (prev === undefined || c.rawRelevance > prev) {
        groupBest.set(key, c.rawRelevance);
      }
    }
    for (const c of candidates) {
      const best = groupBest.get(`${c.coverageTier}:${c.matchSource}`) ?? 0;
      if (c.matchSource === "vector") {
        const gap = best - c.rawRelevance;
        c.relevanceBand = gap <= 0.05 ? 3 : gap <= 0.12 ? 2 : 1;
      } else {
        if (best <= 0) {
          c.relevanceBand = 3;
        } else if (c.rawRelevance >= best * 0.85) {
          c.relevanceBand = 3;
        } else if (c.rawRelevance >= best * 0.6) {
          c.relevanceBand = 2;
        } else {
          c.relevanceBand = 1;
        }
      }
    }

    // Step B: Batch fetch objectIds for pre-computed unary isOlderSameObjectSibling (1-2 SQL queries)
    const entryCandidateIds = candidates
      .filter((c) => c.sourceType !== "distillation")
      .map((c) => c.id);
    if (entryCandidateIds.length > 0 && viewerRealm) {
      const objMap = this.db.listObjectIdsByEntryIds(
        viewerRealm.orgId,
        entryCandidateIds,
      );
      const allObjIds = Array.from(
        new Set(Array.from(objMap.values()).flat()),
      );
      const visibleObjSet = new Set(
        this.db
          .getObjectsByIds(allObjIds)
          .filter(
            (o) =>
              o.orgId === viewerRealm.orgId &&
              allowedLedgerSet.has(o.realmId),
          )
          .map((o) => o.id),
      );
      for (const c of candidates) {
        const rawObjs = objMap.get(c.id) ?? [];
        c.objectIds = rawObjs.filter((oid) => visibleObjSet.has(oid));
      }
    }

    // Pre-compute unary isOlderSameObjectSibling within each exact
    // (coverageTier, coverageRatioBand, lexicalMatchFlag, statusPriority, relevanceBand) bucket
    const buckets = new Map<string, RankedCandidate[]>();
    for (const c of candidates) {
      const bKey = `${c.coverageTier}:${c.coverageRatioBand}:${c.lexicalMatchFlag}:${c.statusPriority}:${c.relevanceBand}`;
      const list = buckets.get(bKey) ?? [];
      list.push(c);
      buckets.set(bKey, list);
    }

    for (const bucket of buckets.values()) {
      const newestByObj = new Map<
        string,
        { occurredAt: string; createdAt: string; id: string }
      >();
      for (const c of bucket) {
        if (c.occurredAt === null || c.objectIds.length === 0) continue;
        for (const oid of c.objectIds) {
          const cur = newestByObj.get(oid);
          if (
            !cur ||
            compareRecencyDesc(
              { occurredAt: c.occurredAt, createdAt: c.createdAt, id: c.id },
              cur,
            ) < 0
          ) {
            newestByObj.set(oid, {
              occurredAt: c.occurredAt,
              createdAt: c.createdAt,
              id: c.id,
            });
          }
        }
      }
      for (const c of bucket) {
        if (c.objectIds.length === 0) {
          c.isOlderSameObjectSibling = 0;
          continue;
        }
        let hasStrictlyNewerSibling = false;
        for (const oid of c.objectIds) {
          const newest = newestByObj.get(oid);
          if (!newest) continue;
          if (
            c.occurredAt === null ||
            compareRecencyDesc(newest, {
              occurredAt: c.occurredAt,
              createdAt: c.createdAt,
              id: c.id,
            }) < 0
          ) {
            hasStrictlyNewerSibling = true;
            break;
          }
        }
        c.isOlderSameObjectSibling = hasStrictlyNewerSibling ? 1 : 0;
      }
    }

    // Step C: Optional opt-in intra-band focus tie-breaker (DEFAULT OFF)
    const focusBoostEnabled = query.focusBoost === true;
    if (focusBoostEnabled && viewerRealm) {
      const focusRealmSet = new Set(scope.focusRealmIds);
      const objRealmMap =
        scope.policy === "open" && entryCandidateIds.length > 0
          ? this.db.listObjectRealmIdsByEntryIds(
              viewerRealm.orgId,
              entryCandidateIds,
            )
          : new Map<string, string[]>();
      for (const c of candidates) {
        const derivedRealms =
          scope.policy === "open"
            ? [c.realmId, ...(objRealmMap.get(c.id) ?? [])]
            : [c.realmId];
        c.focusFlag = derivedRealms.some((rid) => focusRealmSet.has(rid))
          ? 1
          : 0;
      }
    }

    // Step D: Strict total-order lexicographic sort (every key is unary; id breaks final ties)
    candidates.sort((a, b) => {
      if (b.coverageTier !== a.coverageTier) return b.coverageTier - a.coverageTier;
      if (b.coverageRatioBand !== a.coverageRatioBand) {
        return b.coverageRatioBand - a.coverageRatioBand;
      }
      if (b.lexicalMatchFlag !== a.lexicalMatchFlag) {
        return b.lexicalMatchFlag - a.lexicalMatchFlag;
      }
      if (b.statusPriority !== a.statusPriority) {
        return b.statusPriority - a.statusPriority;
      }
      if (b.relevanceBand !== a.relevanceBand) {
        return b.relevanceBand - a.relevanceBand;
      }
      if (a.isOlderSameObjectSibling !== b.isOlderSameObjectSibling) {
        return a.isOlderSameObjectSibling - b.isOlderSameObjectSibling;
      }
      if (b.focusFlag !== a.focusFlag) return b.focusFlag - a.focusFlag;
      return compareRecencyDesc(a, b);
    });

    const hasJsPostFilter = Boolean(
      query.thingId || query.authorId || ftsRejectedByJsCount > 0,
    );
    const totalMatched = !hasJsPostFilter
      ? Math.max(candidates.length, sqlTotal + vectorOnlyHydratedCount)
      : !ftsCapped
        ? candidates.length
        : Math.max(
            candidates.length,
            sqlTotal + vectorOnlyHydratedCount - ftsRejectedByJsCount,
          );

    const pageCandidates = candidates.slice(offset, offset + limit);

    // Preload refs ONLY for the returned page (O(1) SQL queries)
    const pageRefs: string[] = [];
    for (const c of pageCandidates) {
      if (c.record) {
        pageRefs.push(...c.record.refs);
        if (c.record.supersedesId) pageRefs.push(c.record.supersedesId);
        if (c.record.supersedesIds) pageRefs.push(...c.record.supersedesIds);
        if (c.record.supersededById) pageRefs.push(c.record.supersededById);
      } else if (c.seabed) {
        if (c.seabed.sourceRef) pageRefs.push(c.seabed.sourceRef);
      } else if (c.distillation) {
        pageRefs.push(...c.distillation.sourceIds);
      }
    }
    vis.preloadRefs(pageRefs);

    const computeDisplayScore = (c: RankedCandidate): number =>
      c.coverageTier * 1000 +
      c.coverageRatioBand * 20 +
      c.lexicalMatchFlag * 10 +
      c.statusPriority * 4 +
      c.relevanceBand -
      c.isOlderSameObjectSibling * 0.5 +
      c.focusFlag * 0.1;

    const page: RecallItem[] = annotateRecallPage(
      pageCandidates.map((c) => {
        const displayScore = computeDisplayScore(c);
        if (c.record) {
          return toRecordItem(
            c.record,
            c.matchedBy,
            displayScore,
            concepts,
            c.bestPassage,
          );
        }
        if (c.seabed) {
          return toSeabedItem(
            c.seabed,
            c.matchedBy,
            displayScore,
            concepts,
            c.bestPassage,
          );
        }
        return toDistillationItem(
          c.distillation!,
          c.matchedBy,
          displayScore,
          concepts,
          c.bestPassage,
        );
      }),
    );

    return {
      viewerRealmId: query.viewerRealmId,
      items: page,
      totalMatched,
      omittedCount: Math.max(0, totalMatched - offset - page.length),
      vectorUsed,
      ...(hasDates
        ? { interpretedDates: dateConcepts.map((d) => d.label) }
        : {}),
      message:
        page.length > 0
          ? `Found ${totalMatched} matching item(s)${vectorUsed ? " (FTS5 + vector hybrid)" : " (FTS5)"}.`
          : "No matching entries found within your visible realm scope.",
    };
  }

  // ---- Scoped Read Views (tree, ls, cat, replay, changes) — All Reusing visibility.ts & Batch SQL ----

  private buildObjectForest(objects: MindObject[]): ObjectTreeNode[] {
    const visibleIds = new Set(objects.map((o) => o.id));
    const nodeMap = new Map<string, ObjectTreeNode>();
    for (const obj of objects) {
      nodeMap.set(obj.id, { object: obj, children: [] });
    }
    const roots: ObjectTreeNode[] = [];
    for (const obj of objects) {
      const node = nodeMap.get(obj.id)!;
      if (obj.parentObjectId && visibleIds.has(obj.parentObjectId)) {
        nodeMap.get(obj.parentObjectId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  private hydrateLsPage(params: {
    orgId: string;
    refs: UnifiedEntryRef[];
    vis: VisibilityHelpers;
    readableLedgerSet: Set<string>;
  }): LsEntry[] {
    if (params.refs.length === 0) return [];
    const recIds = params.refs
      .filter((r) => r.sourceType === "record")
      .map((r) => r.id);
    const seaIds = params.refs
      .filter((r) => r.sourceType === "seabed")
      .map((r) => r.id);

    const recsMap = new Map(
      this.db.getRecordsByIds(recIds).map((r) => [r.id, r]),
    );
    const seasMap = new Map(
      this.db.getSeabedEntriesByIds(seaIds).map((s) => [s.id, s]),
    );

    const allEntryIds = params.refs.map((r) => r.id);
    const objIdsByEntry = this.db.listObjectIdsByEntryIds(
      params.orgId,
      allEntryIds,
    );
    const tagsByEntry = this.db.listResourceTagsByEntryIds(
      params.orgId,
      allEntryIds,
    );

    const allLinkedObjIds = Array.from(
      new Set(Array.from(objIdsByEntry.values()).flat()),
    );
    const visibleObjSet = new Set(
      this.db
        .getObjectsByIds(allLinkedObjIds)
        .filter(
          (o) =>
            o.orgId === params.orgId &&
            params.readableLedgerSet.has(o.realmId),
        )
        .map((o) => o.id),
    );

    const refsToPreload: string[] = [];
    for (const r of recsMap.values()) {
      refsToPreload.push(...r.refs);
      if (r.supersedesId) refsToPreload.push(r.supersedesId);
      if (r.supersedesIds) refsToPreload.push(...r.supersedesIds);
      if (r.supersededById) refsToPreload.push(r.supersededById);
    }
    for (const s of seasMap.values()) {
      if (s.sourceRef) refsToPreload.push(s.sourceRef);
    }
    params.vis.preloadRefs(refsToPreload);

    const inactiveResolver = createInactiveBadgeResolver(
      this.db,
      params.orgId,
      Array.from(params.readableLedgerSet),
    );

    const out: LsEntry[] = [];
    for (const ref of params.refs) {
      const objectIds = (objIdsByEntry.get(ref.id) ?? []).filter((oid) =>
        visibleObjSet.has(oid),
      );
      const resourceTags = tagsByEntry.get(ref.id) ?? [];

      if (ref.sourceType === "record") {
        const rec = recsMap.get(ref.id);
        if (!rec || rec.sensitivity === "secret" || !params.vis.canSeeRecord(rec)) {
          continue;
        }
        const clean = params.vis.sanitizeRecord(rec);
        const bodyText = extractReadableText(clean.payload);
        const snippet = buildSnippet({
          title: clean.title,
          text: bodyText ? `${clean.title} — ${bodyText}` : clean.title,
        });
        const inactive = inactiveResolver
          ? inactiveResolver.resolveForItem({
              itemId: clean.id,
              linkedObjectIds: objectIds,
              text: `${clean.title}\n${snippet}`,
            })
          : [];
        out.push({
          id: clean.id,
          behaviorClass: clean.kind === "rule" ? "rule" : "conclusion",
          sourceType: "record",
          kind: clean.kind,
          extKind: clean.extKind,
          realmId: clean.realmId,
          realmPath: params.vis.getSanitizedRealmPath(clean.realmId),
          status: clean.status,
          title: clean.title,
          snippet,
          authorId: clean.authorId,
          confirmedByHuman: clean.confirmedByHuman,
          occurredAt: clean.occurredAt,
          createdAt: clean.createdAt,
          externalRef: clean.externalRef,
          sourceRef: clean.sourceRef,
          refs: clean.refs,
          supersedesId: clean.supersedesId,
          supersedesIds: clean.supersedesIds,
          supersededById: clean.supersededById,
          objectIds,
          resourceTags,
          ...(inactive.length > 0 ? { inactive } : {}),
        });
      } else {
        const sea = seasMap.get(ref.id);
        if (!sea || sea.sensitivity === "secret" || !params.vis.canSeeSeabed(sea)) {
          continue;
        }
        const clean = params.vis.sanitizeSeabed(sea);
        const canonicalSourceRef = formatStoredSourceRef(
          clean.sourceRef,
          params.vis.getSanitizedRealmPath,
        );
        const title = `${clean.kind}${clean.topicId ? ` (${clean.topicId})` : ""}`;
        const snippet = buildSnippet({ text: clean.text });
        const inactive = inactiveResolver
          ? inactiveResolver.resolveForItem({
              itemId: clean.id,
              linkedObjectIds: objectIds,
              text: `${title}\n${snippet}`,
            })
          : [];
        out.push({
          id: clean.id,
          behaviorClass: "raw",
          sourceType: "seabed",
          kind: clean.kind,
          extKind: null,
          realmId: clean.realmId,
          realmPath: params.vis.getSanitizedRealmPath(clean.realmId),
          status: clean.redactedAt ? "retracted" : "evidence",
          title,
          snippet,
          authorId: clean.authorId,
          confirmedByHuman: clean.authorKind === "human",
          occurredAt: clean.occurredAt,
          createdAt: clean.createdAt,
          externalRef: null,
          sourceRef: canonicalSourceRef,
          refs: canonicalSourceRef ? [canonicalSourceRef] : [],
          supersedesId: null,
          supersedesIds: [],
          supersededById: null,
          objectIds,
          resourceTags,
          ...(inactive.length > 0 ? { inactive } : {}),
        });
      }
    }
    return out;
  }

  tree(params: {
    actor: Actor;
    viewerRealmId: string;
    target?: string;
    depth?: number | "all";
    includeObjects?: boolean;
    includeArchived?: boolean;
    limit?: number;
    scopeCeiling?: AccessScope;
  }): TreeResult {
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const org = this.db.getOrg(viewerRealm.orgId);
    if (!org) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }

    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy: org.policy,
      includeDescendantSeabed: false,
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    const vis = this.buildVisibilityHelpers({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: viewerRealm.id,
      scope,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      includeDescendantSeabed: false,
    });

    const targetRealm = params.target
      ? resolveVisibleRealm({
          realms,
          orgId: org.id,
          ref: params.target,
          scope,
        })
      : vis.sanitizeRealm(viewerRealm);

    const depth = params.depth ?? 1;
    const includeObjects = params.includeObjects ?? true;
    const lineLimit = Math.max(1, Math.min(params.limit ?? 60, 500));

    const orgRealms = realms.filter((r) => r.orgId === org.id);
    const effectivelyArchivedIds = new Set<string>(
      orgRealms
        .filter((r) => isRealmEffectivelyArchived(orgRealms, r.id))
        .map((r) => r.id),
    );
    const allVisibleRealms = vis.sanitizeRealms(orgRealms);
    const visibleArchivedIds = new Set<string>(
      allVisibleRealms
        .filter((r) => effectivelyArchivedIds.has(r.id))
        .map((r) => r.id),
    );
    const effectiveIncludeArchived =
      Boolean(params.includeArchived) ||
      (Boolean(params.target) && visibleArchivedIds.has(targetRealm.id));
    const visibleRealms = effectiveIncludeArchived
      ? allVisibleRealms
      : allVisibleRealms.filter((r) => !visibleArchivedIds.has(r.id));
    const hiddenArchivedCount = effectiveIncludeArchived
      ? 0
      : visibleArchivedIds.size;
    const visibleRealmIds = new Set(visibleRealms.map((r) => r.id));

    const rawObjects = this.db.listObjects({
      orgId: org.id,
      realmIds: scope.readableLedgerIds,
    });
    const visibleObjects = vis.sanitizeObjects(rawObjects);

    // Batch GROUP BY aggregate queries (3-4 SQL queries TOTAL regardless of DB size!)
    const readableLedgerSet = new Set(scope.readableLedgerIds);
    const readableSeabedSet = new Set(scope.readableSeabedIds);

    const recCounts = this.db.countActiveRecordsByRealm({
      realmIds: scope.readableLedgerIds,
      excludeSensitivities: ["secret"],
    });
    const seaCounts = this.db.countSeabedByRealm({
      realmIds: scope.readableSeabedIds,
      excludeSensitivities: ["secret"],
    });
    const objCounts = this.db.countObjectsByRealm({
      orgId: org.id,
      realmIds: scope.readableLedgerIds,
    });
    const linkedCounts =
      scope.policy === "open"
        ? this.db.countLinkedEntriesByObjectRealm({
            orgId: org.id,
            realmIds: scope.readableLedgerIds,
            excludeSensitivities: ["secret"],
          })
        : new Map<string, number>();

    // Build visible parent -> visible children adjacency using SANITIZED parentId
    const childrenByParent = new Map<string, Realm[]>();
    for (const r of visibleRealms) {
      if (r.parentId && visibleRealmIds.has(r.parentId)) {
        const list = childrenByParent.get(r.parentId) ?? [];
        list.push(r);
        childrenByParent.set(r.parentId, list);
      }
    }

    // Subtree rollups allowed ONLY on self + visible descendants in tree mode (and all realms in open mode).
    // Ancestors & @mounted realms expose direct-only counts (subtree* = null).
    const rollupEligibleSet =
      scope.policy === "open"
        ? visibleRealmIds
        : new Set<string>([viewerRealm.id, ...scope.descendantIds]);

    const subtreeMemo = new Map<
      string,
      {
        rules: number;
        conclusions: number;
        raw: number | null;
        objects: number;
      }
    >();

    const computeSubtree = (
      realmId: string,
      visited = new Set<string>(),
    ): {
      rules: number;
      conclusions: number;
      raw: number | null;
      objects: number;
    } => {
      if (subtreeMemo.has(realmId)) return subtreeMemo.get(realmId)!;
      if (visited.has(realmId)) {
        return { rules: 0, conclusions: 0, raw: null, objects: 0 };
      }
      visited.add(realmId);
      const rc = recCounts.get(realmId);
      let rules = readableLedgerSet.has(realmId) ? (rc?.rules ?? 0) : 0;
      let conclusions = readableLedgerSet.has(realmId)
        ? (rc?.conclusions ?? 0)
        : 0;
      let raw: number | null = readableSeabedSet.has(realmId)
        ? (seaCounts.get(realmId) ?? 0)
        : null;
      let objects = readableLedgerSet.has(realmId)
        ? (objCounts.get(realmId) ?? 0)
        : 0;

      for (const child of childrenByParent.get(realmId) ?? []) {
        const sub = computeSubtree(child.id, visited);
        rules += sub.rules;
        conclusions += sub.conclusions;
        objects += sub.objects;
        if (raw === null || sub.raw === null) {
          raw = null;
        } else {
          raw += sub.raw;
        }
      }
      const res = { rules, conclusions, raw, objects };
      subtreeMemo.set(realmId, res);
      return res;
    };

    const countsByRealm = new Map<string, RealmTreeCounts>();
    for (const r of visibleRealms) {
      const rc = recCounts.get(r.id);
      const directRules = readableLedgerSet.has(r.id) ? (rc?.rules ?? 0) : 0;
      const directConclusions = readableLedgerSet.has(r.id)
        ? (rc?.conclusions ?? 0)
        : 0;
      const directRaw = readableSeabedSet.has(r.id)
        ? (seaCounts.get(r.id) ?? 0)
        : null;
      const directObjects = readableLedgerSet.has(r.id)
        ? (objCounts.get(r.id) ?? 0)
        : 0;
      const childRealmsCount = (childrenByParent.get(r.id) ?? []).length;

      const allowRollup = rollupEligibleSet.has(r.id);
      const sub = allowRollup ? computeSubtree(r.id) : null;

      countsByRealm.set(r.id, {
        directRules,
        directConclusions,
        directRaw,
        directObjects,
        subtreeRules: sub ? sub.rules : null,
        subtreeConclusions: sub ? sub.conclusions : null,
        subtreeRaw: sub ? sub.raw : null,
        subtreeObjects: sub ? sub.objects : null,
        linkedViaObjects:
          scope.policy === "open" ? (linkedCounts.get(r.id) ?? 0) : null,
        childRealmsCount,
      });
    }

    const objsByRealm = new Map<string, MindObject[]>();
    if (includeObjects) {
      for (const obj of visibleObjects) {
        const arr = objsByRealm.get(obj.realmId) ?? [];
        arr.push(obj);
        objsByRealm.set(obj.realmId, arr);
      }
    }

    const buildNode = (realm: Realm, currentDepth: number): RealmTreeNode => {
      const canExpand = depth === "all" || currentDepth < depth;
      const childRealms = canExpand ? (childrenByParent.get(realm.id) ?? []) : [];
      return {
        realm,
        counts: countsByRealm.get(realm.id)!,
        objects: includeObjects
          ? this.buildObjectForest(objsByRealm.get(realm.id) ?? [])
          : [],
        children: childRealms.map((c) => buildNode(c, currentDepth + 1)),
        ...(effectivelyArchivedIds.has(realm.id)
          ? { effectivelyArchived: true }
          : {}),
      };
    };

    let realmTree: RealmTreeNode[];
    if (params.target) {
      const rootNode = visibleRealms.find((r) => r.id === targetRealm.id);
      realmTree = rootNode ? [buildNode(rootNode, 0)] : [];
    } else {
      const rootRealms = visibleRealms.filter(
        (r) => !r.parentId || !visibleRealmIds.has(r.parentId),
      );
      realmTree = rootRealms.map((r) => buildNode(r, 0));
    }

    return {
      org,
      viewerRealmId: viewerRealm.id,
      targetRealmId: targetRealm.id,
      depth,
      includeObjects,
      lineLimit,
      realms: visibleRealms,
      objects: includeObjects ? visibleObjects : [],
      realmTree,
      objectTree: includeObjects ? this.buildObjectForest(visibleObjects) : [],
      ...(hiddenArchivedCount > 0 ? { hiddenArchivedCount } : {}),
    };
  }

  async ls(params: {
    actor: Actor;
    viewerRealmId: string;
    ref?: string;
    target?: string;
    targetType?: LsTargetType;
    only?: LsOnlyFilter;
    kind?: string;
    kinds?: string[];
    tag?: string;
    about?: string;
    since?: string;
    until?: string;
    history?: boolean;
    includeSuperseded?: boolean;
    includeDescendantSeabed?: boolean;
    limit?: number;
    offset?: number;
    cursor?: string;
    scopeCeiling?: AccessScope;
  }): Promise<LsResult> {
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const realmsById = new Map(realms.map((r) => [r.id, r]));
    const viewerRealm = realmsById.get(params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const orgPolicy = this.getOrgPolicy(viewerRealm.orgId);
    const includeSuperseded = Boolean(
      params.includeSuperseded || params.history,
    );
    const includeDescendantSeabed = Boolean(params.includeDescendantSeabed);
    const limit = Math.max(1, Math.min(params.limit ?? 20, 200));
    const offset =
      params.cursor !== undefined
        ? parseNumericCursor(params.cursor)
        : Math.max(0, params.offset ?? 0);

    const onlyFilter = params.only;
    if (
      onlyFilter !== undefined &&
      onlyFilter !== "realms" &&
      onlyFilter !== "objects" &&
      onlyFilter !== "entries" &&
      onlyFilter !== "files"
    ) {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid --only filter "${String(onlyFilter)}". Allowed: realms, objects, entries, files`,
      );
    }

    const kindList = Array.from(
      new Set(
        [
          ...(params.kinds ?? []),
          ...(params.kind
            ? params.kind
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : []),
        ].map((k) => k.toLowerCase()),
      ),
    );
    for (const k of kindList) {
      if (!VALID_RECORD_KINDS_SET.has(k) && !VALID_SEABED_KINDS_SET.has(k)) {
        throw new MindError(
          "INVALID_INPUT",
          `Invalid kind filter "${k}". Allowed record kinds: decision, finding, claim, proposal, verdict, thing, rule; raw kinds: message, artifact, evidence, signal`,
        );
      }
    }

    const tagFilter = params.tag?.trim()
      ? normalizeResourceTag(params.tag.trim())
      : undefined;

    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed,
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    const readableLedgerSet = new Set(scope.readableLedgerIds);
    const readableSeabedSet = new Set(scope.readableSeabedIds);

    const vis = this.buildVisibilityHelpers({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: viewerRealm.id,
      scope,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      includeDescendantSeabed,
    });

    const rawTarget = (params.ref ?? params.target)?.trim() || viewerRealm.id;

    // Support both legacy explicit SDK prefixes (realm:, obj:, thing:, tag:)
    // AND the canonical 4-shape V0.2a-Surface ref grammar (/realm, @mounted/alias, <kind>:<name>, /realm/<kind>:<name>, obj_..., rec_.../sea_..., file:...).
    let targetType: LsTargetType | "unified_object";
    let normalizedRef = rawTarget;
    let parsedUnifiedObj: Extract<
      ReturnType<typeof parseRefSyntax>,
      { kind: "object" }
    > | null = null;

    if (params.targetType) {
      targetType = params.targetType;
      if (targetType === "realm" && normalizedRef.startsWith("realm:")) {
        normalizedRef = normalizedRef.slice("realm:".length).trim();
      } else if (targetType === "object" && normalizedRef.startsWith("obj:")) {
        normalizedRef = normalizedRef.slice("obj:".length).trim();
      } else if (targetType === "thing" && normalizedRef.startsWith("thing:")) {
        normalizedRef = normalizedRef.slice("thing:".length).trim();
      } else if (targetType === "resource" && normalizedRef.startsWith("tag:")) {
        normalizedRef = normalizedRef.slice("tag:".length).trim();
      }
    } else if (rawTarget.startsWith("realm:")) {
      targetType = "realm";
      normalizedRef = rawTarget.slice("realm:".length).trim();
    } else if (rawTarget.startsWith("obj:")) {
      targetType = "object";
      normalizedRef = rawTarget.slice("obj:".length).trim();
    } else if (rawTarget.startsWith("tag:")) {
      targetType = "resource";
      normalizedRef = rawTarget.slice("tag:".length).trim();
    } else {
      const parsed = parseRefSyntax(rawTarget);
      if (parsed.kind === "entry" || parsed.kind === "file") {
        throw new MindError(
          "NOT_LISTABLE",
          `Reference "${rawTarget}" is a ${parsed.kind} and cannot be listed with ls`,
          { try: `meru-mind show ${rawTarget}` },
        );
      }
      if (parsed.kind === "realm") {
        targetType = "realm";
        normalizedRef = parsed.realmRef;
      } else {
        targetType = "unified_object";
        parsedUnifiedObj = parsed;
      }
    }

    // Optional --about unified object filter when listing a realm
    let aboutEntryIdsFilter: string[] | undefined;
    if (params.about?.trim()) {
      const aboutParsed = parseRefSyntax(params.about.trim());
      if (aboutParsed.kind !== "object") {
        throw new MindError(
          "INVALID_REF",
          `Invalid --about reference "${params.about}": expected <kind>:<name>, /<realm>/<kind>:<name>, or obj_...`,
          { try: `meru-mind ls ${rawTarget} --about service:api` },
        );
      }
      const aboutResolved = resolveUnifiedObjectRead({
        db: this.db,
        realms,
        orgId: viewerRealm.orgId,
        parsed: aboutParsed,
        scope,
        vis,
        verb: "ls",
        allowEmpty: true,
      });
      aboutEntryIdsFilter = aboutResolved.entryIds;
    }

    let resolvedId = normalizedRef;
    let displayTarget = rawTarget;
    let targetRealmArchived = false;
    let driveFiles: LsDriveFileItem[] | undefined;
    let subRealms: LsResult["subRealms"] | undefined;
    let objectsList: LsObjectSummary[] | undefined;
    let unifiedRes: { rows: UnifiedEntryRef[]; total: number } = {
      rows: [],
      total: 0,
    };

    if (targetType === "realm") {
      const targetRealm = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: normalizedRef,
        scope,
      });
      resolvedId = targetRealm.id;
      displayTarget = targetRealm.path;
      targetRealmArchived = isRealmEffectivelyArchived(realms, targetRealm.id);

      const wantEntries = !onlyFilter || onlyFilter === "entries";
      const wantRealms = !onlyFilter || onlyFilter === "realms";
      const wantObjects = !onlyFilter || onlyFilter === "objects";
      const wantFiles = !onlyFilter || onlyFilter === "files";

      if (wantEntries) {
        unifiedRes = this.db.lsRealmEntriesUnified({
          orgId: viewerRealm.orgId,
          targetRealmId: targetRealm.id,
          includePhysicalLedger: readableLedgerSet.has(targetRealm.id),
          includePhysicalSeabed: readableSeabedSet.has(targetRealm.id),
          includeObjectLinkedOpenMode: scope.policy === "open",
          includeSuperseded,
          kinds: kindList.length > 0 ? kindList : undefined,
          tag: tagFilter,
          since: params.since,
          until: params.until,
          entryIdsFilter: aboutEntryIdsFilter,
          excludeSensitivities: ["secret"],
          limit,
          offset,
        });
      }

      if (wantRealms) {
        const orgRealms = realms.filter((r) => r.orgId === viewerRealm.orgId);
        const visibleSanitizedRealms = vis.sanitizeRealms(orgRealms);
        subRealms = visibleSanitizedRealms
          .filter((r) => r.parentId === targetRealm.id)
          .map((r) => ({
            id: r.id,
            path: r.path,
            name: r.name,
            slug: r.slug,
          }));
      }

      if (wantObjects && readableLedgerSet.has(targetRealm.id)) {
        const allVisObjs = vis.sanitizeObjects(
          this.db.listObjects({
            orgId: viewerRealm.orgId,
            realmIds: scope.readableLedgerIds,
          }),
        );
        const dupKeys = computeDuplicateObjectKeys(allVisObjs);
        objectsList = allVisObjs
          .filter((o) => o.realmId === targetRealm.id)
          .map((o) => ({
            id: o.id,
            ref: formatCanonicalObjectRef(o, targetRealm.path, dupKeys),
            kind: o.kind,
            name: o.name,
            realmId: o.realmId,
            realmPath: targetRealm.path,
            parentObjectId: o.parentObjectId,
            ...(o.state && o.state !== "active"
              ? {
                  state: o.state,
                  stateLabel: o.stateLabel ?? null,
                  stateSince: o.stateSince ?? null,
                }
              : {}),
          }));
      }

      if (wantFiles && vis.canSeeDriveRealm(targetRealm.id)) {
        const rawFiles = await this.drive.listFiles(targetRealm.id);
        driveFiles = rawFiles.map((f) => ({
          ...f,
          ref: formatCanonicalFileRef(targetRealm.path, f.relPath),
          realmPath: targetRealm.path,
        }));
      }
    } else if (targetType === "unified_object" && parsedUnifiedObj) {
      const resolved = resolveUnifiedObjectRead({
        db: this.db,
        realms,
        orgId: viewerRealm.orgId,
        parsed: parsedUnifiedObj,
        scope,
        vis,
        verb: "ls",
      });
      resolvedId = resolved.object?.id ?? resolved.canonicalRef;
      displayTarget = resolved.canonicalRef;
      let candidateIds = resolved.entryIds;
      if (aboutEntryIdsFilter !== undefined) {
        const allowSet = new Set(aboutEntryIdsFilter);
        candidateIds = candidateIds.filter((id) => allowSet.has(id));
      }
      unifiedRes = this.db.lsEntriesByIdsUnified({
        orgId: viewerRealm.orgId,
        entryIds: candidateIds,
        ledgerRealmIds: resolved.ledgerRealmIds,
        seabedRealmIds: resolved.seabedRealmIds,
        includeSuperseded,
        kinds: kindList.length > 0 ? kindList : undefined,
        tag: tagFilter,
        since: params.since,
        until: params.until,
        excludeSensitivities: ["secret"],
        limit,
        offset,
      });
    } else if (targetType === "object") {
      const visibleObjects = vis.sanitizeObjects(
        this.db.listObjects({
          orgId: viewerRealm.orgId,
          realmIds: scope.readableLedgerIds,
        }),
      );
      const obj =
        visibleObjects.find((o) => o.id === normalizedRef) ??
        visibleObjects.find(
          (o) =>
            o.name.toLowerCase() === normalizedRef.toLowerCase() ||
            `${o.kind}:${o.name}`.toLowerCase() === normalizedRef.toLowerCase(),
        ) ??
        null;
      if (!obj) {
        throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
      }
      resolvedId = obj.id;
      const objectIds = [
        obj.id,
        ...getDescendantObjectIds(visibleObjects, obj.id),
      ];
      const linkedIds = this.db.listEntryIdsForObjects(
        viewerRealm.orgId,
        objectIds,
      );
      unifiedRes = this.db.lsEntriesByIdsUnified({
        orgId: viewerRealm.orgId,
        entryIds: linkedIds,
        ledgerRealmIds: scope.readableLedgerIds,
        seabedRealmIds: scope.readableSeabedIds,
        includeSuperseded,
        kinds: kindList.length > 0 ? kindList : undefined,
        tag: tagFilter,
        since: params.since,
        until: params.until,
        excludeSensitivities: ["secret"],
        limit,
        offset,
      });
    } else if (targetType === "thing") {
      let thingRec = this.db.getRecord(normalizedRef);
      if (!thingRec || thingRec.kind !== "thing") {
        const byExt = this.db.findRecordsByExternalRef(
          viewerRealm.orgId,
          normalizedRef,
          scope.readableLedgerIds,
          ["secret"],
        );
        thingRec = byExt.find((r) => r.kind === "thing") ?? null;
      }
      if (
        !thingRec ||
        thingRec.orgId !== viewerRealm.orgId ||
        thingRec.sensitivity === "secret" ||
        !vis.canSeeRecord(thingRec)
      ) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      resolvedId = thingRec.thingId ?? thingRec.id;
      const recs = this.db.listRecords({
        realmIds: scope.readableLedgerIds,
        thingId: resolvedId,
        includeSuperseded,
        excludeSensitivities: ["secret"],
        limit: 500,
        offset: 0,
      });
      const candidateIds = Array.from(
        new Set([thingRec.id, ...recs.items.map((r) => r.id)]),
      );
      unifiedRes = this.db.lsEntriesByIdsUnified({
        orgId: viewerRealm.orgId,
        entryIds: candidateIds,
        ledgerRealmIds: scope.readableLedgerIds,
        seabedRealmIds: [],
        includeSuperseded,
        kinds: kindList.length > 0 ? kindList : undefined,
        tag: tagFilter,
        since: params.since,
        until: params.until,
        excludeSensitivities: ["secret"],
        limit,
        offset,
      });
    } else {
      const tag = normalizeResourceTag(normalizedRef);
      resolvedId = tag;
      const taggedIds = this.db.listEntryIdsByResourceTag(
        viewerRealm.orgId,
        tag,
      );
      unifiedRes = this.db.lsEntriesByIdsUnified({
        orgId: viewerRealm.orgId,
        entryIds: taggedIds,
        ledgerRealmIds: scope.readableLedgerIds,
        seabedRealmIds: scope.readableSeabedIds,
        includeSuperseded,
        kinds: kindList.length > 0 ? kindList : undefined,
        tag: tagFilter,
        since: params.since,
        until: params.until,
        excludeSensitivities: ["secret"],
        limit,
        offset,
      });
    }

    const page = this.hydrateLsPage({
      orgId: viewerRealm.orgId,
      refs: unifiedRes.rows,
      vis,
      readableLedgerSet,
    });
    const omittedCount = Math.max(0, unifiedRes.total - offset - page.length);

    return {
      targetType: targetType === "unified_object" ? "object" : targetType,
      target: displayTarget,
      resolvedId,
      viewerRealmId: viewerRealm.id,
      ...(targetRealmArchived ? { realmArchived: true } : {}),
      ...(onlyFilter ? { only: onlyFilter } : {}),
      items: page,
      totalMatched: unifiedRes.total,
      omittedCount,
      nextCursor: omittedCount > 0 ? String(offset + page.length) : null,
      ...(subRealms !== undefined ? { subRealms } : {}),
      ...(objectsList !== undefined ? { objects: objectsList } : {}),
      ...(driveFiles !== undefined ? { driveFiles } : {}),
    };
  }

  async cat(params: {
    actor: Actor;
    viewerRealmId: string;
    target: string;
    targetRealmRef?: string;
    includeDescendantSeabed?: boolean;
    scopeCeiling?: AccessScope;
  }): Promise<CatResult> {
    const target = params.target.trim();
    if (!target) {
      throw new MindError("INVALID_INPUT", "cat target cannot be empty");
    }
    if (target.startsWith("obj:")) {
      throw new MindError(
        "INVALID_INPUT",
        `Objects cannot be viewed with "cat"; run "meru-mind ls ${target}" instead.`,
      );
    }
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const realmsById = new Map(realms.map((r) => [r.id, r]));
    const viewerRealm = realmsById.get(params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const orgPolicy = this.getOrgPolicy(viewerRealm.orgId);

    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed: Boolean(params.includeDescendantSeabed),
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    const readableLedgerSet = new Set(scope.readableLedgerIds);
    const vis = this.buildVisibilityHelpers({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: viewerRealm.id,
      scope,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      includeDescendantSeabed: Boolean(params.includeDescendantSeabed),
    });

    const visibleObjectIds = (entryId: string, orgId: string): string[] => {
      const ids = this.db.listObjectIdsForEntry(entryId, orgId);
      if (ids.length === 0) return [];
      return this.db
        .getObjectsByIds(ids)
        .filter((o) => o.orgId === orgId && readableLedgerSet.has(o.realmId))
        .map((o) => o.id);
    };

    // 1. drive://<realmId>/<relPath> URI
    const parsedDrive = parseDriveSourceRef(target);
    if (parsedDrive) {
      if (!vis.canSeeDriveRealm(parsedDrive.realmId)) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      const file = await this.drive.readFile(
        parsedDrive.realmId,
        parsedDrive.relPath,
      );
      if (!file) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      return {
        kind: "drive",
        behaviorClass: "raw",
        file,
        realmPath: vis.getSanitizedRealmPath(parsedDrive.realmId),
      };
    }

    // 2. Exact entry lookup (records / seabed / distillations)
    const rec = this.db.getRecord(target);
    if (rec) {
      if (rec.orgId !== viewerRealm.orgId || !vis.canSeeRecord(rec)) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      vis.preloadRefs([
        ...rec.refs,
        ...(rec.supersedesId ? [rec.supersedesId] : []),
        ...(rec.supersedesIds ?? []),
        ...(rec.supersededById ? [rec.supersededById] : []),
      ]);
      const clean = vis.sanitizeRecord(rec);
      return {
        kind: "record",
        behaviorClass: clean.kind === "rule" ? "rule" : "conclusion",
        record: clean,
        realmPath: vis.getSanitizedRealmPath(clean.realmId),
        objectIds: visibleObjectIds(clean.id, clean.orgId),
        resourceTags: this.db.listResourceTagsForEntry(clean.id, clean.orgId),
        currentHeadId: vis.resolveCurrentHeadId(rec),
        orphanSuperseded: vis.isOrphanSuperseded(rec),
      };
    }

    const sea = this.db.getSeabedEntry(target);
    if (sea) {
      if (sea.orgId !== viewerRealm.orgId || !vis.canSeeSeabed(sea)) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      if (sea.sourceRef) vis.preloadRefs([sea.sourceRef]);
      const clean = vis.sanitizeSeabed(sea);
      return {
        kind: "seabed",
        behaviorClass: "raw",
        seabed: clean,
        realmPath: vis.getSanitizedRealmPath(clean.realmId),
        objectIds: visibleObjectIds(clean.id, clean.orgId),
        resourceTags: this.db.listResourceTagsForEntry(clean.id, clean.orgId),
      };
    }

    const dist = this.db.getDistillation(target);
    if (dist) {
      const distRealm = realmsById.get(dist.realmId);
      if (
        !distRealm ||
        distRealm.orgId !== viewerRealm.orgId ||
        !vis.canSeeDistillation(dist)
      ) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      vis.preloadRefs(dist.sourceIds);
      const clean = vis.sanitizeDistillation(dist);
      return {
        kind: "distillation",
        behaviorClass: "conclusion",
        distillation: clean,
        realmPath: vis.getSanitizedRealmPath(distRealm.id),
      };
    }

    // 3. Drive relative path (with optional targetRealmRef or "<realmPath>:<relPath>")
    let driveRealm = vis.sanitizeRealm(viewerRealm);
    let relPath = target;
    if (params.targetRealmRef) {
      driveRealm = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: params.targetRealmRef,
        scope,
      });
    } else if (
      (target.startsWith("/") || target.toLowerCase().startsWith("@mounted/")) &&
      target.includes(":")
    ) {
      const colonIdx = target.indexOf(":");
      const realmPart = target.slice(0, colonIdx);
      const pathPart = target.slice(colonIdx + 1);
      driveRealm = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: realmPart,
        scope,
      });
      relPath = pathPart;
    }

    if (!vis.canSeeDriveRealm(driveRealm.id)) {
      throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
    }
    const file = await this.drive.readFile(driveRealm.id, relPath);
    if (!file) {
      throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
    }
    return {
      kind: "drive",
      behaviorClass: "raw",
      file,
      realmPath: vis.getSanitizedRealmPath(driveRealm.id),
    };
  }

  replay(params: {
    actor: Actor;
    viewerRealmId: string;
    entryId: string;
    window?: number;
    includeDescendantSeabed?: boolean;
    scopeCeiling?: AccessScope;
  }): ReplayResult {
    const entryId = params.entryId.trim();
    if (!entryId) {
      throw new MindError("INVALID_INPUT", "entryId is required for replay");
    }
    const windowSize = Math.max(1, Math.min(params.window ?? 10, 100));

    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const realmsById = new Map(realms.map((r) => [r.id, r]));
    const viewerRealm = realmsById.get(params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const orgPolicy = this.getOrgPolicy(viewerRealm.orgId);

    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed: Boolean(params.includeDescendantSeabed),
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    const readableLedgerSet = new Set(scope.readableLedgerIds);
    const readableSeabedSet = new Set(scope.readableSeabedIds);

    const vis = this.buildVisibilityHelpers({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: viewerRealm.id,
      scope,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      includeDescendantSeabed: Boolean(params.includeDescendantSeabed),
    });

    const anchorRec = this.db.getRecord(entryId);
    const anchorSea = anchorRec ? null : this.db.getSeabedEntry(entryId);
    if (!anchorRec && !anchorSea) {
      throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
    }

    let anchorRealmId: string;
    let anchorOccurredAt: string | null;
    let anchorCreatedAt: string;
    let anchorBehaviorClass: BehaviorClass;
    let anchorRef: UnifiedEntryRef;
    let supersedeChain: LedgerRecord[] = [];

    if (anchorRec) {
      if (
        anchorRec.orgId !== viewerRealm.orgId ||
        !vis.canSeeRecord(anchorRec)
      ) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      anchorRealmId = anchorRec.realmId;
      anchorOccurredAt = anchorRec.occurredAt;
      anchorCreatedAt = anchorRec.createdAt;
      anchorBehaviorClass = anchorRec.kind === "rule" ? "rule" : "conclusion";
      anchorRef = {
        id: anchorRec.id,
        sourceType: "record",
        occurredAt: anchorRec.occurredAt,
        createdAt: anchorRec.createdAt,
      };
      supersedeChain = vis.traverseSupersedeDag(anchorRec).nodes;
    } else {
      const s = anchorSea!;
      if (s.orgId !== viewerRealm.orgId || !vis.canSeeSeabed(s)) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      anchorRealmId = s.realmId;
      anchorOccurredAt = s.occurredAt;
      anchorCreatedAt = s.createdAt;
      anchorBehaviorClass = "raw";
      anchorRef = {
        id: s.id,
        sourceType: "seabed",
        occurredAt: s.occurredAt,
        createdAt: s.createdAt,
      };
    }

    const timeBasis: "occurred_at" | "created_at" =
      anchorOccurredAt !== null ? "occurred_at" : "created_at";
    const anchorTime = anchorOccurredAt ?? anchorCreatedAt;

    const windowLedgerRealmIds = readableLedgerSet.has(anchorRealmId)
      ? [anchorRealmId]
      : [];
    const windowSeabedRealmIds = readableSeabedSet.has(anchorRealmId)
      ? [anchorRealmId]
      : [];

    const collectWindowRefs = (direction: "before" | "after"): UnifiedEntryRef[] => {
      const recs =
        windowLedgerRealmIds.length > 0
          ? this.db
              .listRecordsWindow({
                realmIds: windowLedgerRealmIds,
                anchorTime,
                anchorId: entryId,
                direction,
                timeBasis,
                limit: windowSize,
                excludeSensitivities: ["secret"],
              })
              .filter((r) => r.sensitivity !== "secret" && vis.canSeeRecord(r))
              .map<UnifiedEntryRef>((r) => ({
                id: r.id,
                sourceType: "record",
                occurredAt: r.occurredAt,
                createdAt: r.createdAt,
              }))
          : [];
      const seas =
        windowSeabedRealmIds.length > 0
          ? this.db
              .listSeabedWindow({
                realmIds: windowSeabedRealmIds,
                anchorTime,
                anchorId: entryId,
                direction,
                timeBasis,
                limit: windowSize,
                excludeSensitivities: ["secret"],
              })
              .filter((s) => s.sensitivity !== "secret" && vis.canSeeSeabed(s))
              .map<UnifiedEntryRef>((s) => ({
                id: s.id,
                sourceType: "seabed",
                occurredAt: s.occurredAt,
                createdAt: s.createdAt,
              }))
          : [];

      const merged = [...recs, ...seas].sort((a, b) => {
        const tA = timeBasis === "occurred_at" ? (a.occurredAt ?? a.createdAt) : a.createdAt;
        const tB = timeBasis === "occurred_at" ? (b.occurredAt ?? b.createdAt) : b.createdAt;
        if (tA !== tB) return tA.localeCompare(tB);
        return a.id.localeCompare(b.id);
      });
      return direction === "before"
        ? merged.slice(-windowSize)
        : merged.slice(0, windowSize);
    };

    const beforeRefs = collectWindowRefs("before");
    const afterRefs = collectWindowRefs("after");
    const hydratedAll = this.hydrateLsPage({
      orgId: viewerRealm.orgId,
      refs: [...beforeRefs, anchorRef, ...afterRefs],
      vis,
      readableLedgerSet,
    });
    const hydratedById = new Map(hydratedAll.map((e) => [e.id, e]));

    const anchorEntry = hydratedById.get(entryId)!;
    const before = beforeRefs
      .map((r) => hydratedById.get(r.id))
      .filter((e): e is LsEntry => Boolean(e));
    const after = afterRefs
      .map((r) => hydratedById.get(r.id))
      .filter((e): e is LsEntry => Boolean(e));

    return {
      anchorId: entryId,
      anchorBehaviorClass,
      anchorRealmId,
      anchorOccurredAt,
      timeBasis,
      window: windowSize,
      supersedeChain,
      before,
      anchor: anchorEntry,
      after,
    };
  }

  changes(params: {
    actor: Actor;
    viewerRealmId: string;
    in?: string;
    target?: string;
    sinceSeq?: number;
    limit?: number;
    includeDescendantSeabed?: boolean;
    scopeCeiling?: AccessScope;
  }): ChangesResult {
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
      includeDescendantSeabed: Boolean(params.includeDescendantSeabed),
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    let ledgerRealmIds = scope.readableLedgerIds;
    let seabedRealmIds = scope.readableSeabedIds;
    let includeOrgLevel = true;
    const realmFilterRef = (params.in ?? params.target)?.trim();
    if (realmFilterRef) {
      const targetRealm = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: realmFilterRef,
        scope,
      });
      const orgRealms = realms.filter((r) => r.orgId === viewerRealm.orgId);
      const subtreeSet = new Set<string>([
        targetRealm.id,
        ...getDescendantIds(orgRealms, targetRealm.id),
      ]);
      ledgerRealmIds = scope.readableLedgerIds.filter((id) =>
        subtreeSet.has(id),
      );
      seabedRealmIds = scope.readableSeabedIds.filter((id) =>
        subtreeSet.has(id),
      );
      includeOrgLevel = false;
    }

    const ledgerSet = new Set(ledgerRealmIds);
    const seabedSet = new Set(seabedRealmIds);
    const candidateRealms = Array.from(
      new Set([
        ...ledgerRealmIds,
        ...seabedRealmIds,
        ...(includeOrgLevel ? ["__org__"] : []),
      ]),
    );

    const sinceSeq = Math.max(0, params.sinceSeq ?? 0);
    const limit = Math.max(1, Math.min(params.limit ?? 50, 500));

    const vis = this.buildVisibilityHelpers({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: viewerRealm.id,
      scope,
      ledgerRealmIds,
      seabedRealmIds,
      includeDescendantSeabed: Boolean(params.includeDescendantSeabed),
    });

    const raw = this.db.listChangeLog({
      orgId: viewerRealm.orgId,
      realmIds: candidateRealms,
      sinceSeq,
      limit: limit * 2,
      includeSecret: false,
    });

    // Batch preload records, seabed, and objects referenced in raw change_log entries
    const checkEntryIds: string[] = [];
    const checkObjectIds: string[] = [];
    for (const entry of raw.entries) {
      if (entry.entityType === "record" || entry.entityType === "seabed") {
        checkEntryIds.push(entry.entityId);
      } else if (entry.entityType === "resource_tag") {
        checkEntryIds.push(entry.entityId.split(":")[0] ?? entry.entityId);
      } else if (entry.entityType === "entry_object") {
        const [eid, oid] = entry.entityId.split(":");
        if (eid) checkEntryIds.push(eid);
        if (oid) checkObjectIds.push(oid);
      }
    }
    const recsMap = new Map(
      this.db.getRecordsByIds(checkEntryIds).map((r) => [r.id, r]),
    );
    const seasMap = new Map(
      this.db.getSeabedEntriesByIds(checkEntryIds).map((s) => [s.id, s]),
    );
    const objsMap = new Map(
      this.db.getObjectsByIds(checkObjectIds).map((o) => [o.id, o]),
    );

    const filtered: ChangeLogEntry[] = [];
    let scannedSeq = sinceSeq;
    for (const entry of raw.entries) {
      scannedSeq = entry.seq;
      if (entry.entityType === "seabed") {
        if (!seabedSet.has(entry.realmId)) continue;
        const sea = seasMap.get(entry.entityId);
        if (sea && (sea.sensitivity === "secret" || !vis.canSeeSeabed(sea))) {
          continue;
        }
      } else if (entry.entityType === "record") {
        if (!ledgerSet.has(entry.realmId)) continue;
        const rec = recsMap.get(entry.entityId);
        if (rec && (rec.sensitivity === "secret" || !vis.canSeeRecord(rec))) {
          continue;
        }
      } else if (
        entry.entityType === "entry_object" ||
        entry.entityType === "resource_tag"
      ) {
        if (!ledgerSet.has(entry.realmId) && !seabedSet.has(entry.realmId)) {
          continue;
        }
        const [entryId = "", objId] = entry.entityId.split(":");
        const rec = recsMap.get(entryId);
        if (rec && (rec.sensitivity === "secret" || !vis.canSeeRecord(rec))) {
          continue;
        }
        const sea = rec ? undefined : seasMap.get(entryId);
        if (sea && (sea.sensitivity === "secret" || !vis.canSeeSeabed(sea))) {
          continue;
        }
        if (entry.entityType === "entry_object" && objId) {
          const obj = objsMap.get(objId);
          if (obj && !scope.readableLedgerIds.includes(obj.realmId)) {
            continue;
          }
        }
      } else if (entry.realmId !== "__org__" && !ledgerSet.has(entry.realmId)) {
        continue;
      }

      filtered.push(entry);
      if (filtered.length >= limit) break;
    }

    // Cursor semantics:
    // - When raw batch had rows, advance strictly to the last scanned row in this batch
    //   (never jumping to org-wide maxSeq, which would skip subsequent visible changes or leak hidden activity).
    // - When raw batch was empty, keep sinceSeq unchanged.
    const latestSeq = raw.entries.length > 0 ? scannedSeq : sinceSeq;

    return {
      generation: raw.generation,
      sinceSeq,
      latestSeq,
      entries: filtered,
    };
  }

  // ---- Everyday Surface Methods (whoami, show, search) ----

  whoami(params: {
    actor: Actor;
    viewerRealmId: string;
    boundSource: string;
    storePath: string;
    scopeCeiling?: AccessScope;
  }): WhoamiResult {
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const org = this.db.getOrg(viewerRealm.orgId);
    if (!org) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }

    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy: org.policy,
      includeDescendantSeabed: false,
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    const vis = this.buildVisibilityHelpers({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: viewerRealm.id,
      scope,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      includeDescendantSeabed: false,
    });

    const sanitizedBound = vis.sanitizeRealm(viewerRealm);
    const orgRealms = realms.filter((r) => r.orgId === org.id);
    const visibleRealms = vis.sanitizeRealms(orgRealms);

    const recCounts = this.db.countActiveRecordsByRealm({
      realmIds: scope.readableLedgerIds,
      excludeSensitivities: ["secret"],
    });
    let rulesCount = 0;
    let conclusionsCount = 0;
    for (const c of recCounts.values()) {
      rulesCount += c.rules;
      conclusionsCount += c.conclusions;
    }

    const seaCounts = this.db.countSeabedByRealm({
      realmIds: scope.readableSeabedIds,
      excludeSensitivities: ["secret"],
    });
    let rawCount = 0;
    for (const c of seaCounts.values()) {
      rawCount += c;
    }

    const objCounts = this.db.countObjectsByRealm({
      orgId: org.id,
      realmIds: scope.readableLedgerIds,
    });
    let objectsCount = 0;
    for (const c of objCounts.values()) {
      objectsCount += c;
    }

    const filesCount = this.db.listDriveFilesMeta(scope.readableDriveIds).length;

    const latestSeq = this.db.getLatestVisibleChangeLogSeq({
      orgId: org.id,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      includeSecret: false,
    });

    const migrations = this.db.listSchemaMigrations();
    const schemaVersion = migrations.reduce(
      (max, m) => (m.version > max ? m.version : max),
      0,
    );

    const inboxRealm = orgRealms.find((r) => r.path === "/inbox");
    const inboxInfo =
      inboxRealm && scope.readableLedgerIds.includes(inboxRealm.id)
        ? (() => {
            const rc = recCounts.get(inboxRealm.id);
            const activeEntries =
              (rc?.rules ?? 0) +
              (rc?.conclusions ?? 0) +
              (seaCounts.get(inboxRealm.id) ?? 0);
            return {
              realmId: inboxRealm.id,
              path: inboxRealm.path,
              activeEntries,
            };
          })()
        : undefined;

    return {
      org: {
        id: org.id,
        name: org.name,
        policy: org.policy,
      },
      actor: params.actor,
      bound: {
        realmId: sanitizedBound.id,
        realmPath: sanitizedBound.path,
        realmName: sanitizedBound.name,
        source: params.boundSource,
      },
      read: {
        policy: org.policy,
        ledgerRealms: scope.readableLedgerIds.length,
        driveRealms: scope.readableDriveIds.length,
        seabedRealms: scope.readableSeabedIds.length,
      },
      write: {
        allowed:
          org.policy === "open"
            ? "any realm in org (rules human-only)"
            : `${sanitizedBound.path} (self only; rules human-only)`,
        canWriteRules: params.actor.kind === "human",
        canRedact: params.actor.kind === "human",
      },
      store: {
        path: params.storePath,
        localOnly: true,
      },
      corpus: {
        realms: visibleRealms.length,
        objects: objectsCount,
        rules: rulesCount,
        conclusions: conclusionsCount,
        raw: rawCount,
        files: filesCount,
      },
      latestSeq,
      version: "0.2.0",
      schemaVersion,
      ...(inboxInfo ? { inbox: inboxInfo } : {}),
      next:
        org.policy === "open"
          ? "meru-mind tree /"
          : `meru-mind tree ${sanitizedBound.path}`,
    };
  }

  async show(params: {
    actor: Actor;
    viewerRealmId: string;
    ref: string;
    history?: boolean;
    context?: number;
    around?: string;
    cursor?: string;
    chars?: number;
    full?: boolean;
    includeDescendantSeabed?: boolean;
    scopeCeiling?: AccessScope;
  }): Promise<ShowResult> {
    if (
      params.context !== undefined &&
      (!Number.isInteger(params.context) || params.context < 0)
    ) {
      throw new MindError(
        "INVALID_INPUT",
        `--context must be a non-negative integer, got ${String(params.context)}`,
      );
    }
    if (
      params.chars !== undefined &&
      (!Number.isInteger(params.chars) ||
        params.chars < 1 ||
        params.chars > MAX_SHOW_LIMIT)
    ) {
      throw new MindError(
        "INVALID_INPUT",
        `--chars must be an integer between 1 and ${MAX_SHOW_LIMIT}, got ${String(params.chars)}`,
      );
    }

    const aroundTrimmed = params.around?.trim() || undefined;
    const hasWindowFlags = Boolean(
      params.around !== undefined ||
        params.cursor !== undefined ||
        params.chars !== undefined ||
        params.full === true,
    );

    const parsed = parseRefSyntax(params.ref);
    if ((parsed.kind === "realm" || parsed.kind === "object") && hasWindowFlags) {
      throw new MindError(
        "INVALID_INPUT",
        "--around/--cursor/--chars/--full are only supported when showing an entry (rec_/sea_) or file (file:...)",
      );
    }
    if (aroundTrimmed && params.cursor !== undefined) {
      throw new MindError(
        "INVALID_INPUT",
        "Use either --around or --cursor, not both",
      );
    }

    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const orgPolicy = this.getOrgPolicy(viewerRealm.orgId);
    const includeDescendantSeabed = Boolean(params.includeDescendantSeabed);

    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed,
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    const vis = this.buildVisibilityHelpers({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: viewerRealm.id,
      scope,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      includeDescendantSeabed,
    });

    // 1. Realm -> brief
    if (parsed.kind === "realm") {
      const brief = this.brief({
        actor: params.actor,
        viewerRealmId: viewerRealm.id,
        target: parsed.realmRef,
        scopeCeiling: scope,
      });
      return {
        refType: "realm",
        ref: brief.realm.path,
        brief,
      };
    }

    // 2. Unified Object -> object card with top 5 recent entries
    if (parsed.kind === "object") {
      const resolved = resolveUnifiedObjectRead({
        db: this.db,
        realms,
        orgId: viewerRealm.orgId,
        parsed,
        scope,
        vis,
        verb: "show",
      });
      const unifiedRes = this.db.lsEntriesByIdsUnified({
        orgId: viewerRealm.orgId,
        entryIds: resolved.entryIds,
        ledgerRealmIds: resolved.ledgerRealmIds,
        seabedRealmIds: resolved.seabedRealmIds,
        includeSuperseded: Boolean(params.history),
        excludeSensitivities: ["secret"],
        limit: 5,
        offset: 0,
      });
      const recentEntries = this.hydrateLsPage({
        orgId: viewerRealm.orgId,
        refs: unifiedRes.rows,
        vis,
        readableLedgerSet: new Set(scope.readableLedgerIds),
      });
      const card: ObjectCard = {
        ref: resolved.canonicalRef,
        kind: resolved.objectKind,
        name: resolved.objectName,
        object: resolved.object,
        realmPath: resolved.realmPath,
        counts: {
          total: unifiedRes.total,
          viaObject: resolved.countsBySource.viaObject,
          viaTag: resolved.countsBySource.viaTag,
          viaThing: resolved.countsBySource.viaThing,
        },
        recentEntries,
        try: `meru-mind ls ${resolved.canonicalRef}`,
      };
      return {
        refType: "object",
        ref: resolved.canonicalRef,
        card,
      };
    }

    const aroundConcepts = aroundTrimmed
      ? parseSearchQuery(aroundTrimmed).concepts
      : undefined;
    const effectiveLimit = params.chars ?? DEFAULT_SHOW_LIMIT;
    const isFull = Boolean(params.full);

    // 3. File -> canonical file: read with longest visible realm prefix + version-pinned windowing
    if (parsed.kind === "file") {
      let fileCursorVer: number | undefined;
      let cursorOffset: number | undefined;
      if (params.cursor !== undefined) {
        const match = /^v(\d+):(\d+)$/.exec(params.cursor.trim());
        if (!match) {
          throw new MindError(
            "INVALID_INPUT",
            `Invalid file cursor "${params.cursor}": expected v<version>:<offset>`,
          );
        }
        fileCursorVer = Number.parseInt(match[1]!, 10);
        cursorOffset = Number.parseInt(match[2]!, 10);
      }

      const resolvedFile = resolveFileRef({
        realms,
        orgId: viewerRealm.orgId,
        ref: params.ref,
        scope,
      });
      if (!vis.canSeeDriveRealm(resolvedFile.realm.id)) {
        throw new MindError("NOT_FOUND", OPAQUE_FILE_NOT_FOUND);
      }
      const file = await this.drive.readFile(
        resolvedFile.realm.id,
        resolvedFile.relPath,
      );
      if (!file) {
        throw new MindError("NOT_FOUND", OPAQUE_FILE_NOT_FOUND);
      }
      if (fileCursorVer !== undefined && fileCursorVer !== file.version) {
        throw new MindError(
          "CONFLICT",
          `File changed since cursor was issued (cursor v${fileCursorVer}, current v${file.version})`,
          { try: `meru-mind show ${resolvedFile.canonicalRef}` },
        );
      }

      const win = windowText({
        text: buildCanonicalEntryContent({ kind: "file", content: file.content }),
        around: aroundTrimmed,
        aroundConcepts,
        cursorOffset,
        limit: effectiveLimit,
        full: isFull,
      });
      const showWindow: ShowWindow = {
        start: win.start,
        end: win.end,
        total: win.total,
        shownChars: win.shownChars,
        truncated: win.truncated,
        nextCursor:
          win.nextOffset !== null ? `v${file.version}:${win.nextOffset}` : null,
        ...(aroundTrimmed
          ? { around: aroundTrimmed, aroundMatched: win.aroundMatched }
          : {}),
      };
      return {
        refType: "file",
        ref: resolvedFile.canonicalRef,
        realmPath: resolvedFile.realm.path,
        file: { ...file, content: win.slice },
        window: showWindow,
      };
    }

    // 4. Entry -> bounded canonical window + optional bounded history DAG + optional bounded context replay window
    let entryCursorOffset: number | undefined;
    if (params.cursor !== undefined) {
      const trimmedCursor = params.cursor.trim();
      if (!/^\d+$/.test(trimmedCursor)) {
        throw new MindError(
          "INVALID_INPUT",
          `Invalid cursor "${params.cursor}": expected a non-negative integer offset`,
        );
      }
      entryCursorOffset = Number.parseInt(trimmedCursor, 10);
      if (!Number.isSafeInteger(entryCursorOffset) || entryCursorOffset < 0) {
        throw new MindError(
          "INVALID_INPUT",
          `Invalid cursor "${params.cursor}": offset out of range`,
        );
      }
    }

    const catRes = await this.cat({
      actor: params.actor,
      viewerRealmId: viewerRealm.id,
      target: parsed.entryId,
      includeDescendantSeabed,
      scopeCeiling: scope,
    });

    // Normalize drive:// sourceRef to canonical file:... for verbatim round-trip
    if (catRes.kind === "seabed" && catRes.seabed.sourceRef) {
      catRes.seabed = {
        ...catRes.seabed,
        sourceRef: formatStoredSourceRef(
          catRes.seabed.sourceRef,
          vis.getSanitizedRealmPath,
        ),
      };
    }

    const canonicalContent =
      catRes.kind === "record"
        ? buildCanonicalEntryContent({
            kind: "record",
            payload: catRes.record.payload,
          })
        : catRes.kind === "seabed"
          ? buildCanonicalEntryContent({
              kind: "seabed",
              text: catRes.seabed.text,
            })
          : catRes.kind === "distillation"
            ? buildCanonicalEntryContent({
                kind: "distillation",
                narrativeMd: catRes.distillation.narrativeMd,
              })
            : buildCanonicalEntryContent({
                kind: "file",
                content: catRes.file.content,
              });

    const win = windowText({
      text: canonicalContent,
      around: aroundTrimmed,
      aroundConcepts,
      cursorOffset: entryCursorOffset,
      limit: effectiveLimit,
      full: isFull,
    });
    const showWindow: ShowWindow = {
      start: win.start,
      end: win.end,
      total: win.total,
      shownChars: win.shownChars,
      truncated: win.truncated,
      nextCursor: win.nextOffset !== null ? String(win.nextOffset) : null,
      ...(aroundTrimmed
        ? { around: aroundTrimmed, aroundMatched: win.aroundMatched }
        : {}),
    };

    // Enforce strict JSON/MCP boundedness across ALL 4 content types
    let boundedEntry: CatResult = catRes;
    if (catRes.kind === "record") {
      if (
        !isFull &&
        (showWindow.truncated ||
          params.cursor !== undefined ||
          JSON.stringify(catRes.record.payload).length > effectiveLimit)
      ) {
        boundedEntry = {
          ...catRes,
          record: { ...catRes.record, payload: {} },
        };
      }
    } else if (catRes.kind === "seabed") {
      boundedEntry = {
        ...catRes,
        seabed: { ...catRes.seabed, text: win.slice },
      };
    } else if (catRes.kind === "distillation") {
      boundedEntry = {
        ...catRes,
        distillation: { ...catRes.distillation, narrativeMd: win.slice },
      };
    } else if (catRes.kind === "drive") {
      boundedEntry = {
        ...catRes,
        file: { ...catRes.file, content: win.slice },
      };
    }

    const isContinuation = params.cursor !== undefined && showWindow.start > 0;
    const toRecordSummary = (r: LedgerRecord): LedgerRecordSummary => ({
      id: r.id,
      realmId: r.realmId,
      kind: r.kind,
      status: r.status,
      title: r.title,
      occurredAt: r.occurredAt,
      createdAt: r.createdAt,
      authorId: r.authorId,
      authorKind: r.authorKind,
      sensitivity: r.sensitivity,
      supersedesId: r.supersedesId,
      supersedesIds: r.supersedesIds,
      supersededById: r.supersededById,
    });
    const capContextEntry = (e: LsEntry): LsEntry =>
      !isFull && e.snippet.length > 500
        ? {
            ...e,
            snippet: `${e.snippet.slice(0, 500)}... [+${e.snippet.length - 500} chars]`,
          }
        : e;

    let historyResult: ShowSupersedeChainResult | undefined;
    if (!isContinuation && params.history && catRes.kind === "record") {
      const rawRec = this.db.getRecord(parsed.entryId);
      if (rawRec && vis.canSeeRecord(rawRec)) {
        const dag = vis.traverseSupersedeDag(rawRec);
        historyResult = {
          nodes: dag.nodes.map(toRecordSummary),
          currentHeadId: dag.currentHeadId,
          orphanSuperseded: dag.orphanSuperseded,
        };
      }
    }

    let contextResult: ShowContextResult | undefined;
    if (
      !isContinuation &&
      params.context !== undefined &&
      params.context > 0 &&
      (catRes.kind === "record" || catRes.kind === "seabed")
    ) {
      const rawReplay = this.replay({
        actor: params.actor,
        viewerRealmId: viewerRealm.id,
        entryId: parsed.entryId,
        window: params.context,
        includeDescendantSeabed,
        scopeCeiling: scope,
      });
      contextResult = {
        ...rawReplay,
        supersedeChain: rawReplay.supersedeChain.map(toRecordSummary),
        before: rawReplay.before.map(capContextEntry),
        anchor: capContextEntry(rawReplay.anchor),
        after: rawReplay.after.map(capContextEntry),
      };
    }

    const inactiveResolver = createInactiveBadgeResolver(
      this.db,
      viewerRealm.orgId,
      scope.readableLedgerIds,
    );
    let inactiveBadges: string[] = [];
    if (inactiveResolver) {
      const linkedObjectIds =
        catRes.kind === "record" || catRes.kind === "seabed"
          ? catRes.objectIds
          : [];
      const entryTitle =
        catRes.kind === "record"
          ? catRes.record.title
          : catRes.kind === "seabed"
            ? `${catRes.seabed.kind}${catRes.seabed.topicId ? ` (${catRes.seabed.topicId})` : ""}`
            : catRes.kind === "distillation"
              ? `${catRes.distillation.layer} (${catRes.distillation.periodKey})`
              : catRes.file.relPath;
      inactiveBadges = inactiveResolver.resolveForItem({
        itemId: parsed.entryId,
        linkedObjectIds,
        text: `${entryTitle}\n${win.slice}`,
      });
    }

    return {
      refType: "entry",
      ref: parsed.entryId,
      entry: boundedEntry,
      content: win.slice,
      window: showWindow,
      ...(historyResult ? { history: historyResult } : {}),
      ...(contextResult ? { context: contextResult } : {}),
      ...(inactiveBadges.length > 0 ? { inactive: inactiveBadges } : {}),
    };
  }

  async search(params: {
    actor: Actor;
    viewerRealmId: string;
    query: string;
    in?: string;
    about?: string;
    kind?: string;
    kinds?: string[];
    since?: string;
    until?: string;
    history?: boolean;
    includeDescendantSeabed?: boolean;
    limit?: number;
    cursor?: string;
    scopeCeiling?: AccessScope;
  }): Promise<SearchResult> {
    const queryText = params.query?.trim() ?? "";
    if (!queryText) {
      throw new MindError(
        "INVALID_INPUT",
        "search requires a non-empty <query> string",
        { try: 'meru-mind search "keyword"' },
      );
    }

    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const viewerRealm = realms.find((r) => r.id === params.viewerRealmId);
    if (!viewerRealm) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    const orgPolicy = this.getOrgPolicy(viewerRealm.orgId);
    const includeDescendantSeabed = Boolean(params.includeDescendantSeabed);

    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: viewerRealm.id,
      orgPolicy,
      includeDescendantSeabed,
    });
    const boundScope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    let effectiveScope = boundScope;
    let realmIdsFilter: string[] | undefined;
    let inDisplay: string | undefined;

    if (params.in?.trim()) {
      const targetRealm = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: params.in.trim(),
        scope: boundScope,
      });
      inDisplay = targetRealm.path;
      const orgRealms = realms.filter((r) => r.orgId === viewerRealm.orgId);
      const subtreeIds = [
        targetRealm.id,
        ...getDescendantIds(orgRealms, targetRealm.id),
      ];
      if (orgPolicy === "tree") {
        const inScope = resolveAccessScope({
          realms,
          mounts,
          viewerRealmId: targetRealm.id,
          orgPolicy: "tree",
          includeDescendantSeabed,
        });
        effectiveScope = intersectAccessScopes(inScope, boundScope);
      }
      realmIdsFilter = subtreeIds;
    }

    const vis = this.buildVisibilityHelpers({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: viewerRealm.id,
      scope: effectiveScope,
      ledgerRealmIds: effectiveScope.readableLedgerIds,
      seabedRealmIds: effectiveScope.readableSeabedIds,
      includeDescendantSeabed,
    });

    let allowedEntryIds: string[] | undefined;
    let aboutDisplay: string | undefined;
    if (params.about?.trim()) {
      const parsedAbout = parseRefSyntax(params.about.trim());
      if (parsedAbout.kind !== "object") {
        throw new MindError(
          "INVALID_REF",
          `Invalid --about reference "${params.about}": expected <kind>:<name>, /<realm>/<kind>:<name>, or obj_...`,
          { try: `meru-mind search "${queryText}" --about service:api` },
        );
      }
      const resolved = resolveUnifiedObjectRead({
        db: this.db,
        realms,
        orgId: viewerRealm.orgId,
        parsed: parsedAbout,
        scope: effectiveScope,
        vis,
        verb: "search",
        allowEmpty: true,
      });
      allowedEntryIds = resolved.entryIds;
      aboutDisplay = resolved.canonicalRef;
    }

    const rawKinds = Array.from(
      new Set(
        [
          ...(params.kinds ?? []),
          ...(params.kind
            ? params.kind
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : []),
        ].map((k) => k.toLowerCase()),
      ),
    );
    const recordKinds: RecordKind[] = [];
    const seabedKinds: SeabedKind[] = [];
    for (const k of rawKinds) {
      if (VALID_RECORD_KINDS_SET.has(k)) {
        recordKinds.push(k as RecordKind);
      } else if (VALID_SEABED_KINDS_SET.has(k)) {
        seabedKinds.push(k as SeabedKind);
      } else {
        throw new MindError(
          "INVALID_INPUT",
          `Invalid kind filter "${k}". Allowed record kinds: decision, finding, claim, proposal, verdict, thing, rule; raw kinds: message, artifact, evidence, signal`,
        );
      }
    }

    const limit = Math.max(1, Math.min(params.limit ?? 10, 200));
    const offset = parseNumericCursor(params.cursor);

    const recallRes = await this.recall({
      actor: params.actor,
      viewerRealmId: viewerRealm.id,
      scopeCeiling: effectiveScope,
      realmIdsFilter,
      allowedEntryIds,
      query: queryText,
      recordKinds: recordKinds.length > 0 ? recordKinds : undefined,
      seabedKinds: seabedKinds.length > 0 ? seabedKinds : undefined,
      since: params.since,
      until: params.until,
      includeHistory: Boolean(params.history),
      includeDescendantSeabed,
      focusBoost: false,
      limit,
      offset,
    });

    return {
      ...recallRes,
      query: queryText,
      ...(inDisplay ? { in: inDisplay } : {}),
      ...(aboutDisplay ? { about: aboutDisplay } : {}),
      nextCursor:
        recallRes.omittedCount > 0 ? String(offset + recallRes.items.length) : null,
    };
  }

  // ---- Settle / Compact (Deterministic Hard Facts + Cited Narrative) ----

  async settle(params: {
    actor: Actor;
    viewerRealmId: string;
    targetRealmId?: string;
    layer: DistillationLayer;
    periodKey: string;
    narrativeMd?: string;
    sourceIds?: string[];
  }): Promise<Distillation> {
    if (!VALID_DISTILLATION_LAYERS.has(params.layer)) {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid distillation layer: "${String(params.layer)}"`,
      );
    }
    const periodKey = params.periodKey.trim();
    if (!periodKey) {
      throw new MindError("INVALID_INPUT", "periodKey cannot be empty");
    }
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;

    return this.db.transaction(() => {
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
        assetKind: "ledger",
        required: "write",
        orgPolicy,
      });

      const targetRealm = realms.find((r) => r.id === targetRealmId)!;

      // Compute deterministic hard facts purely from canonical truth (excluding secret)
      const countsByKind = this.db.countRecordsByKind({
        realmIds: [targetRealmId],
        includeSuperseded: false,
        excludeSensitivities: ["secret"],
      });
      const activeRecords = this.db.listRecords({
        realmIds: [targetRealmId],
        includeSuperseded: false,
        excludeSensitivities: ["secret"],
        limit: 1000,
      });
      const recentSeabed = this.db.listSeabedEntries({
        realmIds: [targetRealmId],
        excludeSensitivities: ["secret"],
        limit: 500,
      });

      const authors = new Set<string>();
      for (const rec of activeRecords.items) {
        authors.add(rec.authorId);
      }
      for (const sea of recentSeabed.items) {
        authors.add(sea.authorId);
      }

      const activeDecisionIds = activeRecords.items
        .filter((r) => r.kind === "decision")
        .map((r) => r.id);
      const activeRuleIds = activeRecords.items
        .filter((r) => r.kind === "rule")
        .map((r) => r.id);
      const activeThingIds = activeRecords.items
        .filter((r) => r.kind === "thing")
        .map((r) => r.id);

      // Validate caller-supplied sourceIds or collect canonical defaults
      let sourceIds: string[];
      if (params.sourceIds && params.sourceIds.length > 0) {
        sourceIds = Array.from(new Set(params.sourceIds));
        for (const sid of sourceIds) {
          const rec = this.db.getRecord(sid);
          const sea = rec ? null : this.db.getSeabedEntry(sid);
          const dist = rec || sea ? null : this.db.getDistillation(sid);
          const target = rec ?? sea ?? dist;
          const access = target
            ? resolveAccess({
                realms,
                mounts,
                actor: params.actor,
                viewerRealmId: params.viewerRealmId,
                targetRealmId: target.realmId,
                assetKind: sea ? "seabed" : "ledger",
                explicitDescendantDive: true,
                orgPolicy,
              })
            : "none";
          if (!target || access === "none") {
            throw new MindError(
              "NOT_FOUND",
              `Entry not found in visible scope: ${sid}`,
            );
          }
          if (
            (rec && rec.sensitivity === "secret") ||
            (sea && sea.sensitivity === "secret")
          ) {
            throw new MindError(
              "INVALID_INPUT",
              `Secret entry "${sid}" cannot be included in a searchable distillation`,
            );
          }
        }
      } else {
        sourceIds = [
          ...activeRecords.items.slice(0, 50).map((r) => r.id),
          ...recentSeabed.items.slice(0, 50).map((s) => s.id),
        ];
      }

      const now = new Date().toISOString();
      const hardFacts: Record<string, unknown> = {
        realmId: targetRealmId,
        layer: params.layer,
        periodKey,
        activeRecordCount: activeRecords.total,
        seabedEntryCount: recentSeabed.total,
        countsByKind,
        activeDecisionIds,
        activeRuleIds,
        activeThingIds,
        participants: Array.from(authors).sort(),
        computedAt: now,
      };

      const defaultNarrative = [
        `Realm snapshot (${params.layer} / ${periodKey}):`,
        `- Active things: ${activeThingIds.length}`,
        `- Active decisions: ${activeDecisionIds.length}${activeDecisionIds.length > 0 ? ` [${activeDecisionIds.slice(0, 5).join(", ")}]` : ""}`,
        `- Active rules: ${activeRuleIds.length}`,
        `- Seabed entries: ${recentSeabed.total}`,
      ].join("\n");

      const distillation: Distillation = {
        id: makeId("dist"),
        realmId: targetRealmId,
        layer: params.layer,
        periodKey,
        status: "active",
        hardFacts,
        narrativeMd: params.narrativeMd?.trim() || defaultNarrative,
        sourceIds,
        createdAt: now,
      };

      this.db.insertDistillation(distillation);
      this.db.supersedeActiveDistillations(
        targetRealmId,
        params.layer,
        periodKey,
        distillation.id,
      );

      const title = `${distillation.layer}:${distillation.periodKey}`;
      this.db.upsertFtsItem({
        itemId: distillation.id,
        orgId: targetRealm.orgId,
        sourceType: "distillation",
        realmId: distillation.realmId,
        status: distillation.status,
        kind: distillation.layer,
        occurredAt: distillation.createdAt,
        title,
        body: distillation.narrativeMd,
      });

      const indexText = `${title}\n${distillation.narrativeMd}`.trim();
      if (indexText) {
        this.db.markVectorPending({
          itemId: distillation.id,
          sourceType: "distillation",
          orgId: targetRealm.orgId,
          realmId: distillation.realmId,
          status: distillation.status,
          text: indexText,
          queuedAt: now,
        });
      }

      this.db.appendChangeLog({
        orgId: targetRealm.orgId,
        realmId: distillation.realmId,
        entityType: "distillation",
        entityId: distillation.id,
        op: "settle",
        actorId: params.actor.id,
        createdAt: now,
      });

      return distillation;
    });
  }

  // ---- Batch Embedding Sync (Off-Write-Path, Race-Safe 3-Point Recheck) ----

  async syncEmbeddings(options?: {
    batchSize?: number;
    maxItems?: number;
  }): Promise<SyncEmbeddingsResult> {
    if (!this.db.vecEnabled || !this.embedder.configured) {
      return {
        processed: 0,
        indexed: 0,
        skipped: 0,
        failed: 0,
        remaining: this.db.countPendingVectors(),
      };
    }

    const batchSize = Math.max(1, Math.min(options?.batchSize ?? 64, 512));
    const maxItems = options?.maxItems ?? Number.POSITIVE_INFINITY;

    let processed = 0;
    let indexed = 0;
    let skipped = 0;
    let failed = 0;
    let failedOffset = 0;

    while (processed < maxItems) {
      const limit = Math.min(batchSize, maxItems - processed);
      const batch = this.db.listPendingVectors(limit, failedOffset);
      if (batch.length === 0) break;

      const texts = batch.map((item) => item.text);
      let vectors: Array<Float32Array | null>;
      if (typeof this.embedder.embedBatch === "function") {
        try {
          const out = await this.embedder.embedBatch(texts);
          vectors = batch.map((_, idx) => out[idx] ?? null);
        } catch {
          vectors = batch.map(() => null);
        }
      } else {
        vectors = await Promise.all(
          texts.map((t) => this.embedder.embed(t).catch(() => null)),
        );
      }

      // Write back inside BEGIN IMMEDIATE with strict 3-point per-item recheck:
      // 1) vec_pending row still exists
      // 2) canonical row still exists, not redacted, not secret, not retracted
      // 3) use live status from canonical row when writing vec_items, then delete vec_pending
      this.db.transaction(() => {
        for (let i = 0; i < batch.length; i += 1) {
          const pending = batch[i]!;
          const vec = vectors[i] ?? null;
          processed += 1;

          const stillPending = this.db.getPendingVector(pending.itemId);
          if (
            !stillPending ||
            stillPending.queuedAt !== pending.queuedAt ||
            stillPending.text !== pending.text
          ) {
            skipped += 1;
            continue;
          }

          let liveStatus: string | null = null;
          let liveRealmId: string | null = null;

          if (pending.sourceType === "record") {
            const rec = this.db.getRecord(pending.itemId);
            if (
              !rec ||
              rec.redactedAt !== null ||
              rec.sensitivity === "secret" ||
              rec.status === "retracted"
            ) {
              this.db.deletePendingVector(pending.itemId);
              skipped += 1;
              continue;
            }
            liveStatus = rec.status;
            liveRealmId = rec.realmId;
          } else if (pending.sourceType === "seabed") {
            const sea = this.db.getSeabedEntry(pending.itemId);
            if (
              !sea ||
              sea.redactedAt !== null ||
              sea.sensitivity === "secret"
            ) {
              this.db.deletePendingVector(pending.itemId);
              skipped += 1;
              continue;
            }
            liveStatus = "evidence";
            liveRealmId = sea.realmId;
          } else {
            const dist = this.db.getDistillation(pending.itemId);
            if (!dist || (dist.status as string) === "retracted") {
              this.db.deletePendingVector(pending.itemId);
              skipped += 1;
              continue;
            }
            liveStatus = dist.status;
            liveRealmId = dist.realmId;
          }

          if (!vec) {
            failed += 1;
            failedOffset += 1;
            continue;
          }

          this.db.upsertVectorItem({
            itemId: pending.itemId,
            sourceType: pending.sourceType,
            realmId: liveRealmId,
            status: liveStatus,
            embedding: vec,
          });
          indexed += 1;
        }
      });
    }

    return {
      processed,
      indexed,
      skipped,
      failed,
      remaining: this.db.countPendingVectors(),
    };
  }

  // ---- Change Log Helpers ----

  listChangeLog(params?: {
    orgId?: string;
    realmIds?: string[];
    sinceSeq?: number;
    limit?: number;
    includeSecret?: boolean;
  }): { generation: number; entries: ChangeLogEntry[] } {
    return this.db.listChangeLog(params);
  }

  resetChangeLog(): { generation: number; clearedCount: number } {
    return this.db.resetChangeLog();
  }

  // ---- Rebuild (Destroy & Reconstruct Derived Indexes + Drive; Preserves change_log & generation) ----

  async rebuild(options?: { restoreDrive?: boolean }): Promise<RebuildResult> {
    let ftsIndexed = 0;
    let distillationsVerified = 0;
    const distillationMismatches: string[] = [];

    this.db.transaction(() => {
      // Rebuild NEVER clears change_log or bumps change_log_generation.
      this.db.clearFtsIndex();
      this.db.clearVectorIndex();

      const now = new Date().toISOString();
      const BATCH = 500;
      const realmsById = new Map(
        this.db.listRealms().map((r) => [r.id, r]),
      );

      const indexOneSync = (item: {
        itemId: string;
        sourceType: "record" | "seabed" | "distillation";
        orgId: string;
        realmId: string;
        status: string;
        kind: string;
        occurredAt: string | null;
        title: string;
        body: string;
      }) => {
        this.db.upsertFtsItem({
          itemId: item.itemId,
          orgId: item.orgId,
          sourceType: item.sourceType,
          realmId: item.realmId,
          status: item.status,
          kind: item.kind,
          occurredAt: item.occurredAt,
          title: item.title,
          body: item.body,
        });
        ftsIndexed += 1;
        const text = `${item.title}\n${item.body}`.trim();
        if (!text) return;
        this.db.markVectorPending({
          itemId: item.itemId,
          sourceType: item.sourceType,
          orgId: item.orgId,
          realmId: item.realmId,
          status: item.status,
          text,
          queuedAt: now,
        });
      };

      // 1) Stream seabed entries in keyset batches (zero full-table RAM spike)
      let lastSeaId = "";
      while (true) {
        const batch = this.db.listSeabedEntriesBatch(lastSeaId, BATCH);
        if (batch.length === 0) break;
        for (const s of batch) {
          if (s.redactedAt !== null || s.sensitivity === "secret") continue;
          const orgId = s.orgId || realmsById.get(s.realmId)?.orgId || "";
          indexOneSync({
            itemId: s.id,
            sourceType: "seabed",
            orgId,
            realmId: s.realmId,
            status: "evidence",
            kind: s.kind,
            occurredAt: s.occurredAt,
            title: `${s.kind}:${s.topicId ?? s.realmId}`,
            body: s.text,
          });
        }
        lastSeaId = batch[batch.length - 1]!.id;
        if (batch.length < BATCH) break;
      }

      // 2) Stream records in keyset batches using shared buildRecordFtsBody
      let lastRecId = "";
      while (true) {
        const batch = this.db.listRecordsBatch(lastRecId, BATCH);
        if (batch.length === 0) break;
        for (const r of batch) {
          if (
            r.redactedAt !== null ||
            r.sensitivity === "secret" ||
            r.status === "retracted"
          ) {
            continue;
          }
          const orgId = r.orgId || realmsById.get(r.realmId)?.orgId || "";
          const payloadText = buildRecordFtsBody(r.payload);
          indexOneSync({
            itemId: r.id,
            sourceType: "record",
            orgId,
            realmId: r.realmId,
            status: r.status,
            kind: r.kind,
            occurredAt: r.occurredAt,
            title: r.title,
            body: payloadText,
          });
        }
        lastRecId = batch[batch.length - 1]!.id;
        if (batch.length < BATCH) break;
      }

      // 3) Verify distillations against lightweight ID-only canonical set (zero payload materialization)
      const existingIds = this.db.listAllCanonicalIds();
      let lastDistId = "";
      while (true) {
        const batch = this.db.listDistillationsBatch(lastDistId, BATCH);
        if (batch.length === 0) break;
        distillationsVerified += batch.length;
        for (const d of batch) {
          const missing = d.sourceIds.filter((id) => !existingIds.has(id));
          if (missing.length > 0) {
            distillationMismatches.push(
              `${d.id}: missing sourceIds [${missing.join(", ")}]`,
            );
          }
          if ((d.status as string) === "retracted") continue;
          const orgId = realmsById.get(d.realmId)?.orgId ?? "";
          indexOneSync({
            itemId: d.id,
            sourceType: "distillation",
            orgId,
            realmId: d.realmId,
            status: d.status,
            kind: d.layer,
            occurredAt: d.createdAt,
            title: `${d.layer}:${d.periodKey}`,
            body: d.narrativeMd,
          });
        }
        lastDistId = batch[batch.length - 1]!.id;
        if (batch.length < BATCH) break;
      }
    });

    const syncRes = await this.syncEmbeddings();

    // Restore DrivePort from canonical SQLite drive_files + BlobPort snapshots
    let driveFilesRestored = 0;
    if (options?.restoreDrive !== false) {
      const allRealms = this.db.listRealms().map((r) => r.id);
      const metas = this.db.listDriveFilesMeta(allRealms);
      const snapshots: Array<{ meta: (typeof metas)[number]; content: string }> =
        [];
      for (const meta of metas) {
        const content = this.blobs.getText(meta.sha256);
        if (content !== null) {
          snapshots.push({ meta, content });
        }
      }
      driveFilesRestored = await this.drive.restoreFromSnapshots(snapshots);
    }

    return {
      ftsIndexed,
      vectorsIndexed: syncRes.indexed,
      vectorsPending: syncRes.remaining,
      driveFilesRestored,
      distillationsVerified,
      distillationMismatches,
    };
  }
}
