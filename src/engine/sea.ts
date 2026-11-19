import crypto from "node:crypto";
import { assertAccess, computeVisibleScope, resolveAccess } from "../policy.js";
import type {
  BlobPort,
  DbPort,
  DrivePort,
  EmbedderPort,
} from "../ports.js";
import {
  MindError,
  type Actor,
  type BriefBudget,
  type BriefOutput,
  type ChildRealmSummary,
  type Distillation,
  type DistillationLayer,
  type LedgerRecord,
  type RecallItem,
  type RecallQuery,
  type RecallResult,
  type RebuildResult,
  type SeabedEntry,
} from "../types.js";

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

  // ---- Brief (Boot Surface with Strict Item Budgets & Mandatory Omitted Counts) ----

  brief(params: {
    actor: Actor;
    viewerRealmId: string;
    budget?: BriefBudget;
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

    const scope = computeVisibleScope({
      realms,
      mounts,
      viewerRealmId: realm.id,
      includeDescendantSeabed: false,
    });

    const recentMessagesLimit = clampBudget(params.budget?.recentMessages, 10);
    const maxQuestions = clampBudget(params.budget?.maxQuestions, 5);
    const maxActiveThings = clampBudget(params.budget?.maxActiveThings, 5);
    const maxDecisions = clampBudget(params.budget?.maxDecisions, 5);
    const maxRules = clampBudget(params.budget?.maxRules, 20);
    const maxChildSummaries = clampBudget(params.budget?.maxChildSummaries, 10);

    // 1. Surface: recent messages in self realm
    const msgRes = this.db.listSeabedEntries({
      realmIds: [realm.id],
      kinds: ["message"],
      limit: recentMessagesLimit,
    });

    // 2. Upper Ledger: pending human questions, active things, active decisions
    const selfAndAncestors = [realm.id, ...scope.ancestorIds];
    const allProposals = this.db.listRecords({
      realmIds: [realm.id],
      kinds: ["proposal"],
      includeSuperseded: false,
      limit: 200,
    });
    const verdicts = this.db.listRecords({
      realmIds: [realm.id],
      kinds: ["verdict"],
      includeSuperseded: false,
      limit: 500,
    });
    const judgedProposalIds = new Set<string>();
    for (const v of verdicts.items) {
      if (typeof v.payload.proposalId === "string") {
        judgedProposalIds.add(v.payload.proposalId);
      }
      for (const r of v.refs) {
        judgedProposalIds.add(r);
      }
    }
    const pendingQuestionsAll = allProposals.items.filter(
      (p) =>
        p.payload.requiresHuman === true && !judgedProposalIds.has(p.id),
    );
    const pendingQuestions = pendingQuestionsAll.slice(0, maxQuestions);

    const thingsRes = this.db.listRecords({
      realmIds: [realm.id],
      kinds: ["thing"],
      includeSuperseded: false,
      limit: maxActiveThings,
    });

    const decisionsRes = this.db.listRecords({
      realmIds: selfAndAncestors,
      kinds: ["decision"],
      includeSuperseded: false,
      limit: maxDecisions,
    });

    // 3. Middle Mind: realm cognitive card, active rules (titles only), ancestor 1-liners, child summaries
    const realmCard = this.db.getLatestDistillation(realm.id, "card_realm");

    const rulesRes = this.db.listRecords({
      realmIds: selfAndAncestors,
      kinds: ["rule"],
      includeSuperseded: false,
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
      const card = this.db.getLatestDistillation(aid, "card_realm");
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
          limit: 1,
        });
        const cDecisions = this.db.listRecords({
          realmIds: [cid],
          kinds: ["decision"],
          includeSuperseded: false,
          limit: 1,
        });
        const cProps = this.db.listRecords({
          realmIds: [cid],
          kinds: ["proposal"],
          includeSuperseded: false,
          limit: 100,
        });
        const cVerdicts = this.db.listRecords({
          realmIds: [cid],
          kinds: ["verdict"],
          includeSuperseded: false,
          limit: 200,
        });
        const cJudged = new Set<string>();
        for (const v of cVerdicts.items) {
          if (typeof v.payload.proposalId === "string") {
            cJudged.add(v.payload.proposalId);
          }
          for (const r of v.refs) cJudged.add(r);
        }
        const cPendingQ = cProps.items.filter(
          (p) => p.payload.requiresHuman === true && !cJudged.has(p.id),
        ).length;
        const cCard = this.db.getLatestDistillation(cid, "card_realm");

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
          items: msgRes.items,
          totalCount: msgRes.total,
          omittedCount: Math.max(0, msgRes.total - msgRes.items.length),
        },
      },
      upperLedger: {
        pendingQuestions: {
          items: pendingQuestions,
          totalCount: pendingQuestionsAll.length,
          omittedCount: Math.max(
            0,
            pendingQuestionsAll.length - pendingQuestions.length,
          ),
        },
        activeThings: {
          items: thingsRes.items,
          totalCount: thingsRes.total,
          omittedCount: Math.max(0, thingsRes.total - thingsRes.items.length),
        },
        activeDecisions: {
          items: decisionsRes.items,
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
    const includeSuperseded = Boolean(query.includeSuperseded);
    const includeDescendantSeabed = Boolean(query.includeDescendantSeabed);
    const limit = Math.max(1, Math.min(query.limit ?? 20, 200));
    const offset = Math.max(0, query.offset ?? 0);

    const scope = computeVisibleScope({
      realms,
      mounts,
      viewerRealmId: query.viewerRealmId,
      includeDescendantSeabed,
    });

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

    const canSeeRecord = (rec: LedgerRecord): boolean => {
      if (!ledgerRealmIds.includes(rec.realmId)) return false;
      const access = resolveAccess({
        realms,
        mounts,
        actor: query.actor,
        viewerRealmId: query.viewerRealmId,
        targetRealmId: rec.realmId,
        assetKind: rec.kind === "rule" ? "rule" : "ledger",
      });
      return access !== "none";
    };

    const canSeeSeabed = (sea: SeabedEntry): boolean => {
      if (!seabedRealmIds.includes(sea.realmId)) return false;
      const access = resolveAccess({
        realms,
        mounts,
        actor: query.actor,
        viewerRealmId: query.viewerRealmId,
        targetRealmId: sea.realmId,
        assetKind: "seabed",
        explicitDescendantDive: includeDescendantSeabed,
      });
      return access !== "none";
    };

    const canSeeDistillation = (dist: Distillation): boolean => {
      if (!ledgerRealmIds.includes(dist.realmId)) return false;
      const access = resolveAccess({
        realms,
        mounts,
        actor: query.actor,
        viewerRealmId: query.viewerRealmId,
        targetRealmId: dist.realmId,
        assetKind: "ledger",
      });
      return access !== "none";
    };

    const toRecordItem = (
      rec: LedgerRecord,
      matchedBy: RecallItem["matchedBy"],
      score: number,
    ): RecallItem => ({
      id: rec.id,
      sourceType: "record",
      kind: rec.kind,
      realmId: rec.realmId,
      status: rec.status,
      title: rec.title,
      snippet: snippet(
        `${rec.title}${Object.keys(rec.payload).length > 0 ? " — " + JSON.stringify(rec.payload) : ""}`,
      ),
      authorId: rec.authorId,
      createdAt: rec.createdAt,
      sourceRefs: rec.refs,
      supersedesId: rec.supersedesId,
      supersededById: rec.supersededById,
      matchedBy,
      score,
    });

    const toSeabedItem = (
      sea: SeabedEntry,
      matchedBy: RecallItem["matchedBy"],
      score: number,
    ): RecallItem => ({
      id: sea.id,
      sourceType: "seabed",
      kind: sea.kind,
      realmId: sea.realmId,
      status: "evidence",
      title: `${sea.kind}${sea.topicId ? ` (${sea.topicId})` : ""}`,
      snippet: snippet(sea.text),
      authorId: sea.authorId,
      createdAt: sea.createdAt,
      sourceRefs: sea.sourceRef ? [sea.sourceRef] : [],
      matchedBy,
      score,
    });

    const toDistillationItem = (
      dist: Distillation,
      matchedBy: RecallItem["matchedBy"],
      score: number,
    ): RecallItem => ({
      id: dist.id,
      sourceType: "distillation",
      kind: dist.layer,
      realmId: dist.realmId,
      status: dist.status,
      title: `${dist.layer} (${dist.periodKey})`,
      snippet: snippet(dist.narrativeMd || JSON.stringify(dist.hardFacts)),
      authorId: "system",
      createdAt: dist.createdAt,
      sourceRefs: dist.sourceIds,
      matchedBy,
      score,
    });

    // Stage 1: Direct ID lookup
    if (query.id) {
      const items: RecallItem[] = [];
      const rec = this.db.getRecord(query.id);
      if (rec && canSeeRecord(rec)) {
        items.push(toRecordItem(rec, ["id"], 1));
      }
      const sea = this.db.getSeabedEntry(query.id);
      if (sea && canSeeSeabed(sea)) {
        items.push(toSeabedItem(sea, ["id"], 1));
      }
      const dist = this.db.getDistillation(query.id);
      if (dist && canSeeDistillation(dist)) {
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

    // Stage 1b: Direct thingId timeline lookup
    if (query.thingId && !query.query) {
      const res = this.db.listRecords({
        realmIds: ledgerRealmIds,
        thingId: query.thingId,
        kinds: query.recordKinds,
        authorId: query.authorId,
        includeSuperseded,
        since: query.since,
        until: query.until,
        limit,
        offset,
      });
      const items = res.items
        .filter(canSeeRecord)
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

    // Stage 2: Pure structured filter when no free-text query is provided
    if (!query.query || !query.query.trim()) {
      const combined: RecallItem[] = [];
      const wantRecords =
        !query.seabedKinds || (query.recordKinds && query.recordKinds.length > 0);
      const wantSeabed =
        !query.recordKinds || (query.seabedKinds && query.seabedKinds.length > 0);

      if (wantRecords && ledgerRealmIds.length > 0) {
        const recRes = this.db.listRecords({
          realmIds: ledgerRealmIds,
          kinds: query.recordKinds,
          authorId: query.authorId,
          includeSuperseded,
          since: query.since,
          until: query.until,
          limit: 500,
        });
        for (const r of recRes.items) {
          if (canSeeRecord(r)) {
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
          limit: 500,
        });
        for (const s of seaRes.items) {
          if (canSeeSeabed(s)) {
            combined.push(toSeabedItem(s, ["filter"], 0.9));
          }
        }
      }

      combined.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const page = combined.slice(offset, offset + limit);
      return {
        viewerRealmId: query.viewerRealmId,
        items: page,
        totalMatched: combined.length,
        omittedCount: Math.max(0, combined.length - offset - page.length),
        vectorUsed: false,
        message:
          page.length > 0
            ? `Returned ${page.length} of ${combined.length} filtered entries.`
            : "No matching entries found within your visible realm scope.",
      };
    }

    // Stages 3 & 4: Hybrid FTS5 + sqlite-vec Reciprocal Rank Fusion (RRF)
    // Query ledger/distillations and seabed SEPARATELY by their exact allowed realm sets
    // so hidden descendant seabed can NEVER consume Top-K slots for ledger queries.
    const candidateLimit = Math.max(limit * 4, 40);

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
        score: number;
        matchedBy: Set<"fts" | "vector">;
      }
    >();

    ftsMatches.forEach((m, idx) => {
      const entry = scoreMap.get(m.itemId) ?? {
        sourceType: m.sourceType,
        score: 0,
        matchedBy: new Set<"fts" | "vector">(),
      };
      entry.score += 1 / (RRF_K + idx + 1);
      entry.matchedBy.add("fts");
      scoreMap.set(m.itemId, entry);
    });

    vecMatches.forEach((m, idx) => {
      const entry = scoreMap.get(m.itemId) ?? {
        sourceType: m.sourceType,
        score: 0,
        matchedBy: new Set<"fts" | "vector">(),
      };
      entry.score += 1 / (RRF_K + idx + 1);
      entry.matchedBy.add("vector");
      scoreMap.set(m.itemId, entry);
    });

    // Hydrate and enforce exact per-asset visibility + structured filters
    const hydrated: RecallItem[] = [];
    for (const [itemId, info] of scoreMap.entries()) {
      const matched = Array.from(info.matchedBy);
      if (info.sourceType === "record") {
        const rec = this.db.getRecord(itemId);
        if (!rec || !canSeeRecord(rec)) continue;
        if (!includeSuperseded && rec.status !== "active") continue;
        if (query.thingId && rec.thingId !== query.thingId) continue;
        if (query.recordKinds && !query.recordKinds.includes(rec.kind)) continue;
        if (query.authorId && rec.authorId !== query.authorId) continue;
        if (query.since && rec.createdAt < query.since) continue;
        if (query.until && rec.createdAt > query.until) continue;
        hydrated.push(toRecordItem(rec, matched, info.score));
      } else if (info.sourceType === "seabed") {
        if (query.thingId) continue;
        const sea = this.db.getSeabedEntry(itemId);
        if (!sea || !canSeeSeabed(sea)) continue;
        if (query.recordKinds && !query.seabedKinds) continue;
        if (query.seabedKinds && !query.seabedKinds.includes(sea.kind)) continue;
        if (query.authorId && sea.authorId !== query.authorId) continue;
        if (query.since && sea.createdAt < query.since) continue;
        if (query.until && sea.createdAt > query.until) continue;
        hydrated.push(toSeabedItem(sea, matched, info.score));
      } else if (info.sourceType === "distillation") {
        if (query.thingId) continue;
        if (query.authorId && query.authorId !== "system") continue;
        const dist = this.db.getDistillation(itemId);
        if (!dist || !canSeeDistillation(dist)) continue;
        if (!includeSuperseded && dist.status !== "active") continue;
        if (query.recordKinds || query.seabedKinds) continue;
        if (query.since && dist.createdAt < query.since) continue;
        if (query.until && dist.createdAt > query.until) continue;
        hydrated.push(toDistillationItem(dist, matched, info.score));
      }
    }

    hydrated.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.createdAt.localeCompare(a.createdAt);
    });

    const page = hydrated.slice(offset, offset + limit);
    return {
      viewerRealmId: query.viewerRealmId,
      items: page,
      totalMatched: hydrated.length,
      omittedCount: Math.max(0, hydrated.length - offset - page.length),
      vectorUsed,
      message:
        page.length > 0
          ? `Found ${hydrated.length} matching item(s)${vectorUsed ? " (FTS5 + vector hybrid)" : " (FTS5)"}.`
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
    const targetRealmId = params.targetRealmId ?? params.viewerRealmId;
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();

    assertAccess({
      realms,
      mounts,
      actor: params.actor,
      viewerRealmId: params.viewerRealmId,
      targetRealmId,
      assetKind: "ledger",
      required: "write",
    });

    const periodKey = params.periodKey.trim();
    if (!periodKey) {
      throw new MindError("INVALID_INPUT", "periodKey cannot be empty");
    }

    // Compute deterministic hard facts purely from canonical truth
    const activeRecords = this.db.listRecords({
      realmIds: [targetRealmId],
      includeSuperseded: false,
      limit: 1000,
    });
    const recentSeabed = this.db.listSeabedEntries({
      realmIds: [targetRealmId],
      limit: 500,
    });

    const countsByKind: Record<string, number> = {};
    const authors = new Set<string>();
    for (const rec of activeRecords.items) {
      countsByKind[rec.kind] = (countsByKind[rec.kind] ?? 0) + 1;
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
            })
          : "none";
        if (!target || access === "none") {
          throw new MindError(
            "NOT_FOUND",
            `Entry not found in visible scope: ${sid}`,
          );
        }
      }
    } else {
      sourceIds = [
        ...activeRecords.items.slice(0, 50).map((r) => r.id),
        ...recentSeabed.items.slice(0, 50).map((s) => s.id),
      ];
    }

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
      computedAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
    };

    this.db.transaction(() => {
      this.db.insertDistillation(distillation);
      this.db.supersedeActiveDistillations(
        targetRealmId,
        params.layer,
        periodKey,
        distillation.id,
      );
    });

    const indexText = `${distillation.layer} ${distillation.periodKey}\n${distillation.narrativeMd}`;
    this.db.upsertFtsItem({
      itemId: distillation.id,
      sourceType: "distillation",
      realmId: distillation.realmId,
      status: distillation.status,
      title: `${distillation.layer}:${distillation.periodKey}`,
      body: distillation.narrativeMd,
    });

    if (this.db.vecEnabled && this.embedder.configured) {
      const vec = await this.embedder.embed(indexText);
      if (vec) {
        this.db.upsertVectorItem({
          itemId: distillation.id,
          sourceType: "distillation",
          realmId: distillation.realmId,
          status: distillation.status,
          embedding: vec,
        });
      } else {
        this.db.markVectorPending({
          itemId: distillation.id,
          sourceType: "distillation",
          realmId: distillation.realmId,
          status: distillation.status,
          text: indexText,
        });
      }
    } else {
      this.db.markVectorPending({
        itemId: distillation.id,
        sourceType: "distillation",
        realmId: distillation.realmId,
        status: distillation.status,
        text: indexText,
      });
    }

    return distillation;
  }

  // ---- Rebuild (Destroy & Reconstruct All Derived Indexes + Drive from Canonical Truth) ----

  async rebuild(options?: { restoreDrive?: boolean }): Promise<RebuildResult> {
    this.db.clearFtsIndex();
    this.db.clearVectorIndex();

    const seabed = this.db.listAllSeabedEntries();
    const records = this.db.listAllRecords();
    const distillations = this.db.listAllDistillations();

    let ftsIndexed = 0;
    let vectorsIndexed = 0;
    let vectorsPending = 0;

    const indexOne = async (item: {
      itemId: string;
      sourceType: "record" | "seabed" | "distillation";
      realmId: string;
      status: string;
      title: string;
      body: string;
    }) => {
      this.db.upsertFtsItem(item);
      ftsIndexed += 1;
      const text = `${item.title}\n${item.body}`.trim();
      if (!text) return;
      if (this.db.vecEnabled && this.embedder.configured) {
        const vec = await this.embedder.embed(text);
        if (vec) {
          this.db.upsertVectorItem({
            itemId: item.itemId,
            sourceType: item.sourceType,
            realmId: item.realmId,
            status: item.status,
            embedding: vec,
          });
          vectorsIndexed += 1;
          return;
        }
      }
      this.db.markVectorPending({
        itemId: item.itemId,
        sourceType: item.sourceType,
        realmId: item.realmId,
        status: item.status,
        text,
      });
      vectorsPending += 1;
    };

    for (const s of seabed) {
      await indexOne({
        itemId: s.id,
        sourceType: "seabed",
        realmId: s.realmId,
        status: "evidence",
        title: `${s.kind}:${s.topicId ?? s.realmId}`,
        body: s.text,
      });
    }

    for (const r of records) {
      const payloadText = Object.entries(r.payload)
        .map(
          ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
        )
        .join("\n");
      await indexOne({
        itemId: r.id,
        sourceType: "record",
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
    const distillationMismatches: string[] = [];

    for (const d of distillations) {
      const missing = d.sourceIds.filter((id) => !existingIds.has(id));
      if (missing.length > 0) {
        distillationMismatches.push(
          `${d.id}: missing sourceIds [${missing.join(", ")}]`,
        );
      }
      await indexOne({
        itemId: d.id,
        sourceType: "distillation",
        realmId: d.realmId,
        status: d.status,
        title: `${d.layer}:${d.periodKey}`,
        body: d.narrativeMd,
      });
    }

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
      vectorsIndexed,
      vectorsPending,
      driveFilesRestored,
      distillationsVerified: distillations.length,
      distillationMismatches,
    };
  }
}
