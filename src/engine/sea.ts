import crypto from "node:crypto";
import { parseSearchQuery } from "../adapters/sqlite-db.js";
import {
  assertAccess,
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
  type LsEntry,
  type LsResult,
  type LsTargetType,
  type MindObject,
  type ObjectTreeNode,
  type OrgPolicy,
  type Realm,
  type RealmMount,
  type RealmTreeNode,
  type RecallItem,
  type RecallQuery,
  type RecallResult,
  type RebuildResult,
  type ReplayResult,
  type SeabedEntry,
  type Sensitivity,
  type SyncEmbeddingsResult,
  type TreeResult,
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

function snippet(text: string, max = 240): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
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

  private distillationHasExcludedSensitivity(
    dist: Distillation | null,
    excludeSensitivities: Sensitivity[],
  ): boolean {
    if (!dist || excludeSensitivities.length === 0) return false;
    const excluded = new Set(excludeSensitivities);
    for (const sid of dist.sourceIds) {
      const rec = this.db.getRecord(sid);
      if (rec && excluded.has(rec.sensitivity)) return true;
      const sea = rec ? null : this.db.getSeabedEntry(sid);
      if (sea && excluded.has(sea.sensitivity)) return true;
    }
    return false;
  }

  // ---- Brief (Boot Surface with Strict Item Budgets & Mandatory Omitted Counts) ----

  brief(params: {
    actor: Actor;
    viewerRealmId: string;
    budget?: BriefBudget;
    scopeCeiling?: AccessScope;
    excludeSensitivities?: Sensitivity[];
  }): BriefOutput {
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const realmsById = new Map(realms.map((r) => [r.id, r]));
    const realm = realmsById.get(params.viewerRealmId);
    if (!realm) {
      throw new MindError(
        "NOT_FOUND",
        `Realm not found: ${params.viewerRealmId}`,
      );
    }

    const orgPolicy = this.getOrgPolicy(realm.orgId);
    const baseScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: realm.id,
      orgPolicy,
      includeDescendantSeabed: false,
    });
    const scope = params.scopeCeiling
      ? intersectAccessScopes(baseScope, params.scopeCeiling)
      : baseScope;

    const excludeSensitivities = params.excludeSensitivities ?? ["secret"];
    const vis = this.buildVisibilityHelpers({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: realm.id,
      scope,
      ledgerRealmIds: scope.readableLedgerIds,
      seabedRealmIds: scope.readableSeabedIds,
      includeDescendantSeabed: false,
    });

    const recentMessagesLimit = clampBudget(params.budget?.recentMessages, 10);
    const maxQuestions = clampBudget(params.budget?.maxQuestions, 5);
    const maxActiveThings = clampBudget(params.budget?.maxActiveThings, 5);
    const maxDecisions = clampBudget(params.budget?.maxDecisions, 5);
    const maxRules = clampBudget(params.budget?.maxRules, 20);
    const maxChildSummaries = clampBudget(params.budget?.maxChildSummaries, 10);

    const canSeeSelfLedger = scope.readableLedgerIds.includes(realm.id);
    const canSeeSelfSeabed = scope.readableSeabedIds.includes(realm.id);

    // 1. Surface: recent messages in self realm (blocked if bound ceiling excludes self seabed)
    const msgRes = canSeeSelfSeabed
      ? this.db.listSeabedEntries({
          realmIds: [realm.id],
          kinds: ["message"],
          excludeSensitivities,
          limit: recentMessagesLimit,
        })
      : { items: [], total: 0 };

    // 2. Upper Ledger: pending human questions (exact SQL COUNT(*)), active things, active decisions
    const selfAndAncestors = [realm.id, ...scope.ancestorIds].filter((id) =>
      scope.readableLedgerIds.includes(id),
    );
    const pendingQuestionsRes = canSeeSelfLedger
      ? this.db.listPendingHumanQuestions({
          realmIds: [realm.id],
          excludeSensitivities,
          limit: maxQuestions,
        })
      : { items: [], total: 0 };

    const thingsRes = canSeeSelfLedger
      ? this.db.listRecords({
          realmIds: [realm.id],
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

    // 3. Middle Mind: realm cognitive card, active rules (titles only), ancestor 1-liners, child summaries
    const rawRealmCard = canSeeSelfLedger
      ? this.db.getLatestDistillation(realm.id, "card_realm")
      : null;
    const realmCard =
      rawRealmCard &&
      !this.distillationHasExcludedSensitivity(
        rawRealmCard,
        excludeSensitivities,
      )
        ? vis.sanitizeDistillation(rawRealmCard)
        : null;

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
      inherited: r.realmId !== realm.id,
      title: r.title,
    }));

    const ancestorSummaries = scope.ancestorIds.map((aid) => {
      const aRealm = realmsById.get(aid)!;
      const rawCard = this.db.getLatestDistillation(aid, "card_realm");
      const card =
        rawCard &&
        !this.distillationHasExcludedSensitivity(rawCard, excludeSensitivities)
          ? rawCard
          : null;
      const summary = card
        ? snippet(card.narrativeMd || JSON.stringify(card.hardFacts), 140)
        : `Ancestor realm "${aRealm.name}" (${aRealm.path})`;
      return {
        realmId: aid,
        realmPath: aRealm.path,
        summary,
      };
    });

    // Parent automatically sees child ledger summaries (without descendant raw chat flood)
    const allChildSummaries: ChildRealmSummary[] = scope.descendantIds.map(
      (cid) => {
        const cRealm = realmsById.get(cid)!;
        const cThings = this.db.listRecords({
          realmIds: [cid],
          kinds: ["thing"],
          includeSuperseded: false,
          excludeSensitivities,
          limit: 1,
        });
        const cDecisions = this.db.listRecords({
          realmIds: [cid],
          kinds: ["decision"],
          includeSuperseded: false,
          excludeSensitivities,
          limit: 1,
        });
        const cPendingQ = this.db.listPendingHumanQuestions({
          realmIds: [cid],
          excludeSensitivities,
          limit: 1,
        }).total;
        const rawCCard = this.db.getLatestDistillation(cid, "card_realm");
        const cCard =
          rawCCard &&
          !this.distillationHasExcludedSensitivity(
            rawCCard,
            excludeSensitivities,
          )
            ? rawCCard
            : null;

        return {
          realmId: cid,
          realmPath: cRealm.path,
          realmName: cRealm.name,
          activeThings: cThings.total,
          pendingQuestions: cPendingQ,
          activeDecisions: cDecisions.total,
          latestCardSummary: cCard ? snippet(cCard.narrativeMd, 120) : null,
        };
      },
    );

    const childSlice = allChildSummaries.slice(0, maxChildSummaries);

    // Exact 3-bucket counts (rules / conclusions / raw) excluding secret entries
    const countsByKind = canSeeSelfLedger
      ? this.db.countRecordsByKind({
          realmIds: [realm.id],
          includeSuperseded: false,
          excludeSensitivities,
        })
      : {};
    let conclusionsCount = 0;
    for (const [k, c] of Object.entries(countsByKind)) {
      if (k !== "rule") conclusionsCount += c;
    }
    const rawTotal = canSeeSelfSeabed
      ? this.db.listSeabedEntries({
          realmIds: [realm.id],
          excludeSensitivities,
          limit: 1,
        }).total
      : 0;

    const generation = this.db.getChangeLogGeneration();
    const currentSeq = this.db.getLatestChangeLogSeq(realm.orgId);
    const cardSeq = realmCard
      ? this.db.getChangeLogSeqForEntity("distillation", realmCard.id)
      : null;
    const changesSinceCard =
      cardSeq !== null
        ? this.db.countChangeLogSince({
            orgId: realm.orgId,
            realmIds: [realm.id],
            sinceSeq: cardSeq,
            generation,
            includeSecret: false,
          })
        : 0;

    return {
      realm,
      generatedAt: new Date().toISOString(),
      buckets: {
        rules: rulesRes.total,
        conclusions: conclusionsCount,
        raw: rawTotal,
      },
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
          totalCount: allChildSummaries.length,
          omittedCount: Math.max(
            0,
            allChildSummaries.length - childSlice.length,
          ),
        },
      },
      drilldownHint:
        "Use recall(id=...) / cat for exact inspection, ls/tree for browsing, replay(id) for occurred_at context, or recall(query=...) for FTS5+vector search.",
    };
  }

  // ---- Recall (4-Stage Pipeline: ID -> Filter -> FTS5 -> sqlite-vec RRF, Strictly Scoped) ----

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

    // Narrow to targetRealmId if specified (never widens visibility!)
    let ledgerRealmIds = scope.readableLedgerIds;
    let seabedRealmIds = scope.readableSeabedIds;
    if (query.targetRealmId) {
      ledgerRealmIds = allowedLedgerSet.has(query.targetRealmId)
        ? [query.targetRealmId]
        : [];
      seabedRealmIds = allowedSeabedSet.has(query.targetRealmId)
        ? [query.targetRealmId]
        : [];
    }

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

    const toRecordItem = (
      rec: LedgerRecord,
      matchedBy: RecallItem["matchedBy"],
      score: number,
    ): RecallItem => {
      const clean = vis.sanitizeRecord(rec);
      const currentHeadId =
        rec.status === "superseded" ? vis.resolveCurrentHeadId(rec) : undefined;
      return {
        id: clean.id,
        behaviorClass: clean.kind === "rule" ? "rule" : "conclusion",
        sourceType: "record",
        kind: clean.kind,
        realmId: clean.realmId,
        status: clean.status,
        title: clean.title,
        snippet: snippet(
          `${clean.title}${Object.keys(clean.payload).length > 0 ? " — " + JSON.stringify(clean.payload) : ""}`,
        ),
        authorId: clean.authorId,
        createdAt: clean.createdAt,
        occurredAt: clean.occurredAt,
        sourceRefs: clean.refs,
        supersedesId: clean.supersedesId,
        supersededById: clean.supersededById,
        ...(rec.status === "superseded" ? { currentHeadId } : {}),
        matchedBy,
        score,
      };
    };

    const toSeabedItem = (
      sea: SeabedEntry,
      matchedBy: RecallItem["matchedBy"],
      score: number,
    ): RecallItem => {
      const clean = vis.sanitizeSeabed(sea);
      return {
        id: clean.id,
        behaviorClass: "raw",
        sourceType: "seabed",
        kind: clean.kind,
        realmId: clean.realmId,
        status: clean.redactedAt ? "retracted" : "evidence",
        title: `${clean.kind}${clean.topicId ? ` (${clean.topicId})` : ""}`,
        snippet: snippet(clean.text),
        authorId: clean.authorId,
        createdAt: clean.createdAt,
        occurredAt: clean.occurredAt,
        sourceRefs: clean.sourceRef ? [clean.sourceRef] : [],
        matchedBy,
        score,
      };
    };

    const toDistillationItem = (
      dist: Distillation,
      matchedBy: RecallItem["matchedBy"],
      score: number,
    ): RecallItem => {
      const clean = vis.sanitizeDistillation(dist);
      return {
        id: clean.id,
        behaviorClass: "conclusion",
        sourceType: "distillation",
        kind: clean.layer,
        realmId: clean.realmId,
        status: clean.status,
        title: `${clean.layer} (${clean.periodKey})`,
        snippet: snippet(clean.narrativeMd || JSON.stringify(clean.hardFacts)),
        authorId: "system",
        createdAt: clean.createdAt,
        occurredAt: clean.createdAt,
        sourceRefs: clean.sourceIds,
        matchedBy,
        score,
      };
    };

    // Stage 1: Direct ID lookup (explicitly allows secret entries if visible in scope)
    if (query.id) {
      const items: RecallItem[] = [];
      const rec = this.db.getRecord(query.id);
      if (rec && vis.canSeeRecord(rec)) {
        items.push(toRecordItem(rec, ["id"], 1));
      }
      const sea = this.db.getSeabedEntry(query.id);
      if (sea && vis.canSeeSeabed(sea)) {
        items.push(toSeabedItem(sea, ["id"], 1));
      }
      const dist = this.db.getDistillation(query.id);
      if (dist && vis.canSeeDistillation(dist)) {
        items.push(toDistillationItem(dist, ["id"], 1));
      }
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
      const items = res.items
        .filter((r) => r.sensitivity !== "secret" && vis.canSeeRecord(r))
        .map((r) => toRecordItem(r, ["id", "filter"], 1));
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

    // Stage 2: Pure structured filter with exact SQL COUNT(*) (zero 500 truncation, excludes secret)
    if (!query.query || !query.query.trim()) {
      const wantRecords =
        !query.seabedKinds || (query.recordKinds && query.recordKinds.length > 0);
      const wantSeabed =
        !query.recordKinds || (query.seabedKinds && query.seabedKinds.length > 0);

      const fetchWindow = offset + limit;
      let totalMatched = 0;
      const combined: RecallItem[] = [];

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
            combined.push(toRecordItem(r, ["filter"], 1));
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
            combined.push(toSeabedItem(s, ["filter"], 0.9));
          }
        }
      }

      combined.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const page = combined.slice(offset, offset + limit);
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

    // Stages 3 & 4: Mixed CJK/English FTS5 + JS Identifier Boundary + Concept Tiers + RRF + Active-First + Open Focus Boost
    const parsedQuery = parseSearchQuery(query.query);
    const candidateLimit = Math.max((offset + limit) * 5, 100);

    const ledgerFts =
      ledgerRealmIds.length > 0
        ? this.db.searchFts({
            query: query.query,
            realmIds: ledgerRealmIds,
            sourceTypes: ["record", "distillation"],
            includeSuperseded,
            limit: candidateLimit,
          })
        : [];
    const seabedFts =
      seabedRealmIds.length > 0
        ? this.db.searchFts({
            query: query.query,
            realmIds: seabedRealmIds,
            sourceTypes: ["seabed"],
            includeSuperseded,
            limit: candidateLimit,
          })
        : [];
    const ftsMatches = [...ledgerFts, ...seabedFts].sort(
      (a, b) => a.rank - b.rank,
    );

    const exactFtsTotal =
      (ledgerRealmIds.length > 0
        ? this.db.countFts({
            query: query.query,
            realmIds: ledgerRealmIds,
            sourceTypes: ["record", "distillation"],
            includeSuperseded,
          })
        : 0) +
      (seabedRealmIds.length > 0
        ? this.db.countFts({
            query: query.query,
            realmIds: seabedRealmIds,
            sourceTypes: ["seabed"],
            includeSuperseded,
          })
        : 0);

    let vectorUsed = false;
    let vecMatches: ReturnType<DbPort["searchVectors"]> = [];
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
        // Filter out orthogonal/unrelated vectors (unit L2 distance >= 1.25 => cosine <= ~0.22)
        vecMatches = [...ledgerVec, ...seabedVec]
          .filter((m) => m.distance <= 1.25)
          .sort((a, b) => a.distance - b.distance);
      }
    }

    // RRF fusion (k = 60)
    const RRF_K = 60;
    const scoreMap = new Map<
      string,
      {
        sourceType: "record" | "seabed" | "distillation";
        rrf: number;
        matchedBy: Set<"fts" | "vector">;
      }
    >();

    ftsMatches.forEach((m, idx) => {
      const entry = scoreMap.get(m.itemId) ?? {
        sourceType: m.sourceType,
        rrf: 0,
        matchedBy: new Set<"fts" | "vector">(),
      };
      entry.rrf += 1 / (RRF_K + idx + 1);
      entry.matchedBy.add("fts");
      scoreMap.set(m.itemId, entry);
    });

    vecMatches.forEach((m, idx) => {
      const entry = scoreMap.get(m.itemId) ?? {
        sourceType: m.sourceType,
        rrf: 0,
        matchedBy: new Set<"fts" | "vector">(),
      };
      entry.rrf += 1 / (RRF_K + idx + 1);
      entry.matchedBy.add("vector");
      scoreMap.set(m.itemId, entry);
    });

    const focusRealmSet = new Set(scope.focusRealmIds);
    let droppedByIdentifierBoundary = false;
    let vectorOnlyHydratedCount = 0;

    const computeRankedScore = (params: {
      entryId?: string;
      orgId?: string;
      titleText: string;
      bodyText: string;
      sourceType: "record" | "seabed" | "distillation";
      status: string;
      realmId: string;
      rrf: number;
      matchedBy: Array<"fts" | "vector">;
    }): number | null => {
      const concepts = parsedQuery.concepts;
      const fullText = `${params.titleText}\n${params.bodyText}`;
      let titleHits = 0;
      let fullHits = 0;
      for (const c of concepts) {
        if (c.matchText(params.titleText)) {
          titleHits += 1;
          fullHits += 1;
        } else if (c.matchText(fullText)) {
          fullHits += 1;
        }
      }

      // JS exact identifier boundary verification:
      // Reject FTS-only false positives where an identifier like "agent-worker"
      // only matched inside a longer token like "agent-worker-bridge".
      const isFtsOnly =
        params.matchedBy.includes("fts") && !params.matchedBy.includes("vector");
      if (parsedQuery.hasIdentifiers && isFtsOnly && fullHits === 0) {
        droppedByIdentifierBoundary = true;
        return null;
      }

      let tier = 0;
      if (concepts.length > 0) {
        if (titleHits === concepts.length) {
          tier = 3;
        } else if (fullHits === concepts.length) {
          tier = 2;
        } else if (fullHits > 0) {
          tier = 1;
        } else {
          tier = 0;
        }
      }

      // Active-first weighting: active conclusion (1.35) > raw seabed (1.0) > superseded (0.55)
      let statusWeight = 1.0;
      if (params.status === "superseded") {
        statusWeight = 0.55;
      } else if (params.status === "retracted") {
        statusWeight = 0.1;
      } else if (params.sourceType === "seabed") {
        statusWeight = 1.0;
      } else {
        statusWeight = 1.35;
      }

      // Normalize rank-1 RRF to 1.0 so statusWeight & open-mode focus boost (+0.35) combine cleanly.
      // In open mode, an entry linked to objects in multiple realms inherits focus boost from any linked object's realm.
      const normRrf = params.rrf * (RRF_K + 1);
      let isOpenFocus = false;
      let isOpenSelf = false;
      if (scope.policy === "open") {
        const derivedRealms =
          params.entryId && params.orgId
            ? [
                params.realmId,
                ...this.db.listObjectRealmIdsForEntry(
                  params.entryId,
                  params.orgId,
                ),
              ]
            : [params.realmId];
        isOpenFocus = derivedRealms.some((rid) => focusRealmSet.has(rid));
        isOpenSelf = derivedRealms.includes(query.viewerRealmId);
      }
      const focusBonus = (isOpenFocus ? 0.35 : 0) + (isOpenSelf ? 0.05 : 0);

      return tier * 10 + normRrf * statusWeight + focusBonus;
    };

    // Hydrate and enforce exact per-asset visibility + sensitivity + structured filters + JS scoring
    const hydrated: RecallItem[] = [];
    for (const [itemId, info] of scoreMap.entries()) {
      const matched = Array.from(info.matchedBy);
      if (info.sourceType === "record") {
        const rec = this.db.getRecord(itemId);
        if (!rec || rec.sensitivity === "secret" || !vis.canSeeRecord(rec)) {
          continue;
        }
        if (rec.status === "retracted" || rec.redactedAt !== null) continue;
        if (!includeSuperseded && rec.status !== "active") continue;
        if (query.thingId && rec.thingId !== query.thingId) continue;
        if (query.recordKinds && !query.recordKinds.includes(rec.kind)) continue;
        if (query.authorId && rec.authorId !== query.authorId) continue;
        if (query.since && rec.createdAt < query.since) continue;
        if (query.until && rec.createdAt > query.until) continue;

        const bodyText = Object.entries(rec.payload)
          .map(
            ([k, v]) =>
              `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
          )
          .join("\n");
        const finalScore = computeRankedScore({
          entryId: rec.id,
          orgId: rec.orgId,
          titleText: rec.title,
          bodyText,
          sourceType: "record",
          status: rec.status,
          realmId: rec.realmId,
          rrf: info.rrf,
          matchedBy: matched,
        });
        if (finalScore === null) continue;
        if (!info.matchedBy.has("fts")) vectorOnlyHydratedCount += 1;
        hydrated.push(toRecordItem(rec, matched, finalScore));
      } else if (info.sourceType === "seabed") {
        if (query.thingId) continue;
        const sea = this.db.getSeabedEntry(itemId);
        if (!sea || sea.sensitivity === "secret" || !vis.canSeeSeabed(sea)) {
          continue;
        }
        if (sea.redactedAt !== null) continue;
        if (query.recordKinds && !query.seabedKinds) continue;
        if (query.seabedKinds && !query.seabedKinds.includes(sea.kind)) continue;
        if (query.authorId && sea.authorId !== query.authorId) continue;
        if (query.since && sea.createdAt < query.since) continue;
        if (query.until && sea.createdAt > query.until) continue;

        const titleText = `${sea.kind}:${sea.topicId ?? sea.realmId}`;
        const finalScore = computeRankedScore({
          entryId: sea.id,
          orgId: sea.orgId,
          titleText,
          bodyText: sea.text,
          sourceType: "seabed",
          status: "evidence",
          realmId: sea.realmId,
          rrf: info.rrf,
          matchedBy: matched,
        });
        if (finalScore === null) continue;
        if (!info.matchedBy.has("fts")) vectorOnlyHydratedCount += 1;
        hydrated.push(toSeabedItem(sea, matched, finalScore));
      } else if (info.sourceType === "distillation") {
        if (query.thingId) continue;
        if (query.authorId && query.authorId !== "system") continue;
        const dist = this.db.getDistillation(itemId);
        if (!dist || !vis.canSeeDistillation(dist)) continue;
        if (dist.status === "retracted") continue;
        if (!includeSuperseded && dist.status !== "active") continue;
        if (query.recordKinds || query.seabedKinds) continue;
        if (query.since && dist.createdAt < query.since) continue;
        if (query.until && dist.createdAt > query.until) continue;

        const titleText = `${dist.layer}:${dist.periodKey}`;
        const finalScore = computeRankedScore({
          titleText,
          bodyText: dist.narrativeMd,
          sourceType: "distillation",
          status: dist.status,
          realmId: dist.realmId,
          rrf: info.rrf,
          matchedBy: matched,
        });
        if (finalScore === null) continue;
        if (!info.matchedBy.has("fts")) vectorOnlyHydratedCount += 1;
        hydrated.push(toDistillationItem(dist, matched, finalScore));
      }
    }

    hydrated.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
      const occA = a.occurredAt ?? a.createdAt;
      const occB = b.occurredAt ?? b.createdAt;
      if (occB !== occA) return occB.localeCompare(occA);
      if (b.createdAt !== a.createdAt) {
        return b.createdAt.localeCompare(a.createdAt);
      }
      return a.id.localeCompare(b.id);
    });

    const hasPostFilter = Boolean(
      query.thingId ||
        query.recordKinds ||
        query.seabedKinds ||
        query.authorId ||
        query.since ||
        query.until ||
        droppedByIdentifierBoundary,
    );
    const totalMatched = hasPostFilter
      ? hydrated.length
      : Math.max(hydrated.length, exactFtsTotal + vectorOnlyHydratedCount);

    const page = hydrated.slice(offset, offset + limit);
    return {
      viewerRealmId: query.viewerRealmId,
      items: page,
      totalMatched,
      omittedCount: Math.max(0, totalMatched - offset - page.length),
      vectorUsed,
      message:
        page.length > 0
          ? `Found ${totalMatched} matching item(s)${vectorUsed ? " (FTS5 + vector hybrid)" : " (FTS5)"}.`
          : "No matching entries found within your visible realm scope.",
    };
  }

  // ---- Scoped Read Views (tree, ls, cat, replay, changes) — All Reusing visibility.ts ----

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

  private buildRealmForest(
    realms: Realm[],
    objects: MindObject[],
  ): RealmTreeNode[] {
    const visibleIds = new Set(realms.map((r) => r.id));
    const objsByRealm = new Map<string, MindObject[]>();
    for (const obj of objects) {
      const arr = objsByRealm.get(obj.realmId) ?? [];
      arr.push(obj);
      objsByRealm.set(obj.realmId, arr);
    }
    const nodeMap = new Map<string, RealmTreeNode>();
    for (const realm of realms) {
      nodeMap.set(realm.id, {
        realm,
        objects: this.buildObjectForest(objsByRealm.get(realm.id) ?? []),
        children: [],
      });
    }
    const roots: RealmTreeNode[] = [];
    for (const realm of realms) {
      const node = nodeMap.get(realm.id)!;
      if (realm.parentId && visibleIds.has(realm.parentId)) {
        nodeMap.get(realm.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  private visibleObjectIdsForEntry(
    entryId: string,
    orgId: string,
    readableLedgerSet: Set<string>,
  ): string[] {
    const ids = this.db.listObjectIdsForEntry(entryId, orgId);
    if (ids.length === 0) return [];
    const out: string[] = [];
    for (const id of ids) {
      const obj = this.db.getObject(id);
      if (obj && obj.orgId === orgId && readableLedgerSet.has(obj.realmId)) {
        out.push(id);
      }
    }
    return out;
  }

  private toLsEntryFromRecord(
    rec: LedgerRecord,
    vis: VisibilityHelpers,
    realmsById: Map<string, Realm>,
    readableLedgerSet: Set<string>,
  ): LsEntry {
    const clean = vis.sanitizeRecord(rec);
    const bodySnippet =
      typeof clean.payload.summary === "string" && clean.payload.summary.trim()
        ? clean.payload.summary
        : typeof clean.payload.body === "string" && clean.payload.body.trim()
          ? clean.payload.body
          : Object.keys(clean.payload).length > 0
            ? JSON.stringify(clean.payload)
            : "";
    return {
      id: clean.id,
      behaviorClass: clean.kind === "rule" ? "rule" : "conclusion",
      sourceType: "record",
      kind: clean.kind,
      extKind: clean.extKind,
      realmId: clean.realmId,
      realmPath: realmsById.get(clean.realmId)?.path ?? "/",
      status: clean.status,
      title: clean.title,
      snippet: snippet(bodySnippet ? `${clean.title} — ${bodySnippet}` : clean.title),
      authorId: clean.authorId,
      confirmedByHuman: clean.confirmedByHuman,
      occurredAt: clean.occurredAt,
      createdAt: clean.createdAt,
      externalRef: clean.externalRef,
      sourceRef: clean.sourceRef,
      refs: clean.refs,
      supersedesId: clean.supersedesId,
      supersededById: clean.supersededById,
      objectIds: this.visibleObjectIdsForEntry(
        clean.id,
        clean.orgId,
        readableLedgerSet,
      ),
      resourceTags: this.db.listResourceTagsForEntry(clean.id, clean.orgId),
    };
  }

  private toLsEntryFromSeabed(
    sea: SeabedEntry,
    vis: VisibilityHelpers,
    realmsById: Map<string, Realm>,
    readableLedgerSet: Set<string>,
  ): LsEntry {
    const clean = vis.sanitizeSeabed(sea);
    return {
      id: clean.id,
      behaviorClass: "raw",
      sourceType: "seabed",
      kind: clean.kind,
      extKind: null,
      realmId: clean.realmId,
      realmPath: realmsById.get(clean.realmId)?.path ?? "/",
      status: clean.redactedAt ? "retracted" : "evidence",
      title: `${clean.kind}${clean.topicId ? ` (${clean.topicId})` : ""}`,
      snippet: snippet(clean.text),
      authorId: clean.authorId,
      confirmedByHuman: clean.authorKind === "human",
      occurredAt: clean.occurredAt,
      createdAt: clean.createdAt,
      externalRef: null,
      sourceRef: clean.sourceRef,
      refs: clean.sourceRef ? [clean.sourceRef] : [],
      supersedesId: null,
      supersededById: null,
      objectIds: this.visibleObjectIdsForEntry(
        clean.id,
        clean.orgId,
        readableLedgerSet,
      ),
      resourceTags: this.db.listResourceTagsForEntry(clean.id, clean.orgId),
    };
  }

  tree(params: {
    actor: Actor;
    viewerRealmId: string;
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

    const visibleRealmSet = new Set<string>([
      ...scope.readableLedgerIds,
      ...scope.readableDriveIds,
      ...scope.readableSeabedIds,
    ]);
    const visibleRealms = realms.filter(
      (r) => r.orgId === org.id && visibleRealmSet.has(r.id),
    );
    const visibleObjects = this.db.listObjects({
      orgId: org.id,
      realmIds: scope.readableLedgerIds,
    });

    return {
      org,
      viewerRealmId: viewerRealm.id,
      realms: visibleRealms,
      objects: visibleObjects,
      realmTree: this.buildRealmForest(visibleRealms, visibleObjects),
      objectTree: this.buildObjectForest(visibleObjects),
    };
  }

  async ls(params: {
    actor: Actor;
    viewerRealmId: string;
    target?: string;
    targetType?: LsTargetType;
    includeSuperseded?: boolean;
    includeDescendantSeabed?: boolean;
    limit?: number;
    offset?: number;
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
    const includeSuperseded = Boolean(params.includeSuperseded);
    const includeDescendantSeabed = Boolean(params.includeDescendantSeabed);
    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
    const offset = Math.max(0, params.offset ?? 0);

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

    const rawTarget = params.target?.trim() || viewerRealm.id;
    let targetType: LsTargetType;
    if (params.targetType) {
      targetType = params.targetType;
    } else if (rawTarget.startsWith("/") || rawTarget.startsWith("realm_")) {
      targetType = "realm";
    } else if (
      rawTarget.startsWith("obj_") ||
      Boolean(this.db.getObject(rawTarget))
    ) {
      targetType = "object";
    } else if (rawTarget.startsWith("thing:")) {
      targetType = "thing";
    } else if (this.db.getRecord(rawTarget)?.kind === "thing") {
      targetType = "thing";
    } else if (rawTarget.includes(":")) {
      targetType = "resource";
    } else {
      targetType = "realm";
    }

    const entriesMap = new Map<string, LsEntry>();
    let resolvedId = rawTarget;
    let driveFiles: LsResult["driveFiles"] | undefined;

    const addRecord = (rec: LedgerRecord | null) => {
      if (!rec) return;
      if (rec.orgId !== viewerRealm.orgId) return;
      if (rec.sensitivity === "secret" || rec.redactedAt !== null) return;
      if (rec.status === "retracted") return;
      if (!includeSuperseded && rec.status !== "active") return;
      if (!vis.canSeeRecord(rec)) return;
      if (!entriesMap.has(rec.id)) {
        entriesMap.set(
          rec.id,
          this.toLsEntryFromRecord(rec, vis, realmsById, readableLedgerSet),
        );
      }
    };

    const addSeabed = (sea: SeabedEntry | null) => {
      if (!sea) return;
      if (sea.orgId !== viewerRealm.orgId) return;
      if (sea.sensitivity === "secret" || sea.redactedAt !== null) return;
      if (!vis.canSeeSeabed(sea)) return;
      if (!entriesMap.has(sea.id)) {
        entriesMap.set(
          sea.id,
          this.toLsEntryFromSeabed(sea, vis, realmsById, readableLedgerSet),
        );
      }
    };

    if (targetType === "realm") {
      const targetRealm = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: rawTarget,
        scope,
      });
      resolvedId = targetRealm.id;

      if (readableLedgerSet.has(targetRealm.id)) {
        const recs = this.db.listRecords({
          realmIds: [targetRealm.id],
          includeSuperseded,
          excludeSensitivities: ["secret"],
          limit: 10_000,
          offset: 0,
        });
        for (const r of recs.items) addRecord(r);
      }
      if (readableSeabedSet.has(targetRealm.id)) {
        const seas = this.db.listSeabedEntries({
          realmIds: [targetRealm.id],
          excludeSensitivities: ["secret"],
          limit: 10_000,
          offset: 0,
        });
        for (const s of seas.items) addSeabed(s);
      }

      // In open mode, also aggregate entries linked via objects belonging to targetRealm
      // (tree mode NEVER amplifies beyond physical realm_id)
      if (scope.policy === "open") {
        const linkedIds = this.db.listEntryIdsByObjectRealm(
          viewerRealm.orgId,
          targetRealm.id,
        );
        for (const eid of linkedIds) {
          const rec = this.db.getRecord(eid);
          if (rec) {
            addRecord(rec);
            continue;
          }
          addSeabed(this.db.getSeabedEntry(eid));
        }
      }

      if (vis.canSeeDriveRealm(targetRealm.id)) {
        driveFiles = await this.drive.listFiles(targetRealm.id);
      }
    } else if (targetType === "object") {
      const obj = this.db.getObject(rawTarget);
      if (
        !obj ||
        obj.orgId !== viewerRealm.orgId ||
        !readableLedgerSet.has(obj.realmId)
      ) {
        throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND);
      }
      resolvedId = obj.id;
      const visibleObjects = this.db.listObjects({
        orgId: viewerRealm.orgId,
        realmIds: scope.readableLedgerIds,
      });
      const objectIds = [
        obj.id,
        ...getDescendantObjectIds(visibleObjects, obj.id),
      ];
      const linkedIds = this.db.listEntryIdsForObjects(
        viewerRealm.orgId,
        objectIds,
      );
      for (const eid of linkedIds) {
        const rec = this.db.getRecord(eid);
        if (rec) {
          addRecord(rec);
          continue;
        }
        addSeabed(this.db.getSeabedEntry(eid));
      }
    } else if (targetType === "thing") {
      const ref = rawTarget.startsWith("thing:")
        ? rawTarget.slice("thing:".length).trim()
        : rawTarget;
      let thingRec = this.db.getRecord(ref);
      if (!thingRec || thingRec.kind !== "thing") {
        const byExt = this.db.findRecordsByExternalRef(
          viewerRealm.orgId,
          ref,
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
        limit: 10_000,
        offset: 0,
      });
      for (const r of recs.items) addRecord(r);
      addRecord(thingRec);
    } else {
      const tag = normalizeResourceTag(rawTarget);
      resolvedId = tag;
      const taggedIds = this.db.listEntryIdsByResourceTag(
        viewerRealm.orgId,
        tag,
      );
      for (const eid of taggedIds) {
        const rec = this.db.getRecord(eid);
        if (rec) {
          addRecord(rec);
          continue;
        }
        addSeabed(this.db.getSeabedEntry(eid));
      }
    }

    const allItems = Array.from(entriesMap.values()).sort((a, b) => {
      if (b.occurredAt !== a.occurredAt) {
        return b.occurredAt.localeCompare(a.occurredAt);
      }
      if (b.createdAt !== a.createdAt) {
        return b.createdAt.localeCompare(a.createdAt);
      }
      return a.id.localeCompare(b.id);
    });
    const totalMatched = allItems.length;
    const page = allItems.slice(offset, offset + limit);

    return {
      targetType,
      target: rawTarget,
      resolvedId,
      viewerRealmId: viewerRealm.id,
      items: page,
      totalMatched,
      omittedCount: Math.max(0, totalMatched - offset - page.length),
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
        realmPath: realmsById.get(parsedDrive.realmId)?.path ?? "/",
      };
    }

    // 2. Exact entry lookup (records / seabed / distillations)
    const rec = this.db.getRecord(target);
    if (rec) {
      if (rec.orgId !== viewerRealm.orgId || !vis.canSeeRecord(rec)) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      const clean = vis.sanitizeRecord(rec);
      return {
        kind: "record",
        behaviorClass: clean.kind === "rule" ? "rule" : "conclusion",
        record: clean,
        realmPath: realmsById.get(clean.realmId)?.path ?? "/",
        objectIds: this.visibleObjectIdsForEntry(
          clean.id,
          clean.orgId,
          readableLedgerSet,
        ),
        resourceTags: this.db.listResourceTagsForEntry(clean.id, clean.orgId),
        currentHeadId: vis.resolveCurrentHeadId(rec),
      };
    }

    const sea = this.db.getSeabedEntry(target);
    if (sea) {
      if (sea.orgId !== viewerRealm.orgId || !vis.canSeeSeabed(sea)) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      const clean = vis.sanitizeSeabed(sea);
      return {
        kind: "seabed",
        behaviorClass: "raw",
        seabed: clean,
        realmPath: realmsById.get(clean.realmId)?.path ?? "/",
        objectIds: this.visibleObjectIdsForEntry(
          clean.id,
          clean.orgId,
          readableLedgerSet,
        ),
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
      const clean = vis.sanitizeDistillation(dist);
      return {
        kind: "distillation",
        behaviorClass: "conclusion",
        distillation: clean,
        realmPath: distRealm.path,
      };
    }

    // 3. Drive relative path (with optional targetRealmRef or "<realmPath>:<relPath>")
    let driveRealm = viewerRealm;
    let relPath = target;
    if (params.targetRealmRef) {
      driveRealm = resolveVisibleRealm({
        realms,
        orgId: viewerRealm.orgId,
        ref: params.targetRealmRef,
        scope,
      });
    } else if (target.startsWith("/") && target.includes(":")) {
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
      realmPath: driveRealm.path,
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
    let anchorOccurredAt: string;
    let anchorBehaviorClass: BehaviorClass;
    let anchorEntry: LsEntry;
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
      anchorBehaviorClass = anchorRec.kind === "rule" ? "rule" : "conclusion";
      anchorEntry = this.toLsEntryFromRecord(
        anchorRec,
        vis,
        realmsById,
        readableLedgerSet,
      );

      // Walk full supersede chain and filter/sanitize via visibility.ts
      let oldest = anchorRec;
      const seen = new Set<string>([oldest.id]);
      while (oldest.supersedesId && !seen.has(oldest.supersedesId)) {
        const prev = this.db.getRecord(oldest.supersedesId);
        if (!prev) break;
        seen.add(prev.id);
        oldest = prev;
      }
      const rawChain: LedgerRecord[] = [oldest];
      let cur = oldest;
      while (cur.supersededById) {
        const next = this.db.getRecord(cur.supersededById);
        if (!next || rawChain.some((c) => c.id === next.id)) break;
        rawChain.push(next);
        cur = next;
      }
      supersedeChain = rawChain
        .filter(
          (node) =>
            vis.canSeeRecord(node) &&
            (node.sensitivity !== "secret" || node.id === anchorRec.id),
        )
        .map((node) => vis.sanitizeRecord(node));
    } else {
      const s = anchorSea!;
      if (s.orgId !== viewerRealm.orgId || !vis.canSeeSeabed(s)) {
        throw new MindError("NOT_FOUND", OPAQUE_ENTRY_NOT_FOUND);
      }
      anchorRealmId = s.realmId;
      anchorOccurredAt = s.occurredAt;
      anchorBehaviorClass = "raw";
      anchorEntry = this.toLsEntryFromSeabed(
        s,
        vis,
        realmsById,
        readableLedgerSet,
      );
    }

    const windowLedgerRealmIds = readableLedgerSet.has(anchorRealmId)
      ? [anchorRealmId]
      : [];
    const windowSeabedRealmIds = readableSeabedSet.has(anchorRealmId)
      ? [anchorRealmId]
      : [];

    const collectWindow = (direction: "before" | "after"): LsEntry[] => {
      const recs =
        windowLedgerRealmIds.length > 0
          ? this.db
              .listRecordsWindow({
                realmIds: windowLedgerRealmIds,
                anchorOccurredAt,
                anchorId: entryId,
                direction,
                limit: windowSize,
                excludeSensitivities: ["secret"],
              })
              .filter((r) => r.sensitivity !== "secret" && vis.canSeeRecord(r))
              .map((r) =>
                this.toLsEntryFromRecord(r, vis, realmsById, readableLedgerSet),
              )
          : [];
      const seas =
        windowSeabedRealmIds.length > 0
          ? this.db
              .listSeabedWindow({
                realmIds: windowSeabedRealmIds,
                anchorOccurredAt,
                anchorId: entryId,
                direction,
                limit: windowSize,
                excludeSensitivities: ["secret"],
              })
              .filter((s) => s.sensitivity !== "secret" && vis.canSeeSeabed(s))
              .map((s) =>
                this.toLsEntryFromSeabed(s, vis, realmsById, readableLedgerSet),
              )
          : [];

      const merged = [...recs, ...seas].sort((a, b) => {
        if (a.occurredAt !== b.occurredAt) {
          return a.occurredAt.localeCompare(b.occurredAt);
        }
        return a.id.localeCompare(b.id);
      });
      return direction === "before"
        ? merged.slice(-windowSize)
        : merged.slice(0, windowSize);
    };

    return {
      anchorId: entryId,
      anchorBehaviorClass,
      anchorRealmId,
      anchorOccurredAt,
      window: windowSize,
      supersedeChain,
      before: collectWindow("before"),
      anchor: anchorEntry,
      after: collectWindow("after"),
    };
  }

  changes(params: {
    actor: Actor;
    viewerRealmId: string;
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

    const ledgerSet = new Set(scope.readableLedgerIds);
    const seabedSet = new Set(scope.readableSeabedIds);
    const candidateRealms = Array.from(
      new Set([...scope.readableLedgerIds, ...scope.readableSeabedIds, "__org__"]),
    );

    const sinceSeq = Math.max(0, params.sinceSeq ?? 0);
    const limit = Math.max(1, Math.min(params.limit ?? 100, 500));

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

    const raw = this.db.listChangeLog({
      orgId: viewerRealm.orgId,
      realmIds: candidateRealms,
      sinceSeq,
      limit: limit * 2,
      includeSecret: false,
    });

    const filtered: ChangeLogEntry[] = [];
    let scannedSeq = sinceSeq;
    for (const entry of raw.entries) {
      scannedSeq = entry.seq;
      if (entry.entityType === "seabed") {
        if (!seabedSet.has(entry.realmId)) continue;
        const sea = this.db.getSeabedEntry(entry.entityId);
        if (sea && (sea.sensitivity === "secret" || !vis.canSeeSeabed(sea))) {
          continue;
        }
      } else if (entry.entityType === "record") {
        if (!ledgerSet.has(entry.realmId)) continue;
        const rec = this.db.getRecord(entry.entityId);
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
        const entryId = entry.entityId.split(":")[0] ?? "";
        const rec = this.db.getRecord(entryId);
        if (rec && (rec.sensitivity === "secret" || !vis.canSeeRecord(rec))) {
          continue;
        }
        const sea = rec ? null : this.db.getSeabedEntry(entryId);
        if (sea && (sea.sensitivity === "secret" || !vis.canSeeSeabed(sea))) {
          continue;
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
        sourceType: "distillation",
        realmId: distillation.realmId,
        status: distillation.status,
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
      const realmsById = new Map(
        this.db.listRealms().map((r) => [r.id, r]),
      );
      const seabed = this.db.listAllSeabedEntries();
      const records = this.db.listAllRecords();
      const distillations = this.db.listAllDistillations();

      const indexOneSync = (item: {
        itemId: string;
        sourceType: "record" | "seabed" | "distillation";
        orgId: string;
        realmId: string;
        status: string;
        title: string;
        body: string;
      }) => {
        this.db.upsertFtsItem({
          itemId: item.itemId,
          sourceType: item.sourceType,
          realmId: item.realmId,
          status: item.status,
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

      for (const s of seabed) {
        if (s.redactedAt !== null || s.sensitivity === "secret") continue;
        const orgId = s.orgId || realmsById.get(s.realmId)?.orgId || "";
        indexOneSync({
          itemId: s.id,
          sourceType: "seabed",
          orgId,
          realmId: s.realmId,
          status: "evidence",
          title: `${s.kind}:${s.topicId ?? s.realmId}`,
          body: s.text,
        });
      }

      for (const r of records) {
        if (
          r.redactedAt !== null ||
          r.sensitivity === "secret" ||
          r.status === "retracted"
        ) {
          continue;
        }
        const orgId = r.orgId || realmsById.get(r.realmId)?.orgId || "";
        const payloadText = Object.entries(r.payload)
          .map(
            ([k, v]) =>
              `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
          )
          .join("\n");
        indexOneSync({
          itemId: r.id,
          sourceType: "record",
          orgId,
          realmId: r.realmId,
          status: r.status,
          title: r.title,
          body: payloadText,
        });
      }

      // Verify distillations against canonical truth
      const existingIds = new Set<string>([
        ...seabed.map((s) => s.id),
        ...records.map((r) => r.id),
        ...distillations.map((d) => d.id),
      ]);
      distillationsVerified = distillations.length;

      for (const d of distillations) {
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
          title: `${d.layer}:${d.periodKey}`,
          body: d.narrativeMd,
        });
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
