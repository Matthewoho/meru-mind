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
  type BriefBudget,
  type BriefOutput,
  type ChangeLogEntry,
  type ChildRealmSummary,
  type Distillation,
  type DistillationLayer,
  type LedgerRecord,
  type OrgPolicy,
  type Realm,
  type RealmMount,
  type RecallItem,
  type RecallQuery,
  type RecallResult,
  type RebuildResult,
  type SeabedEntry,
  type Sensitivity,
  type SyncEmbeddingsResult,
} from "../types.js";
import {
  createVisibilityHelpers,
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

    return {
      realm,
      generatedAt: new Date().toISOString(),
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
        "Use recall(id=...) for exact record/chain inspection, recall(query=...) for FTS5+vector search, or recall(targetRealmId=..., includeDescendantSeabed=true) to read child seabed.",
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

      // Normalize rank-1 RRF to 1.0 so statusWeight & open-mode focus boost (+0.35) combine cleanly
      const normRrf = params.rrf * (RRF_K + 1);
      const isOpenFocus =
        scope.policy === "open" && focusRealmSet.has(params.realmId);
      const isOpenSelf =
        scope.policy === "open" && params.realmId === query.viewerRealmId;
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
