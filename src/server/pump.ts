import { getDescendantIds, resolveAccessScope } from "../policy.js";
import type { DbPort } from "../ports.js";
import {
  MindError,
  type AccessScope,
  type ChangeCommittedEvent,
  type Principal,
  type PumpChangeFrame,
} from "../types.js";
import { resolveVisibleRealm } from "../engine/objects.js";
import { resolveChangeAboutFilter } from "../engine/refs.js";
import {
  createVisibilityHelpers,
  filterVisibleChangeFrames,
} from "../engine/visibility.js";
import type { ChangeLogAboutFilter } from "../ports.js";
import { isPrincipalTokenActive } from "./tokens.js";

/**
 * In-memory inverted wakeup bus: realmId -> Set<wakeCallback>.
 * Passes ZERO payload data; strictly wakes subscribed pumps after SQLite COMMIT.
 */
export class ChangeWakeBus {
  private readonly byKey = new Map<string, Set<() => void>>();

  private keyFor(orgId: string, realmId: string): string {
    return `${orgId}:${realmId}`;
  }

  subscribe(
    orgId: string,
    realmIds: Iterable<string>,
    onWake: () => void,
  ): () => void {
    const keys: string[] = [this.keyFor(orgId, "__org__")];
    for (const rid of realmIds) {
      keys.push(this.keyFor(orgId, rid));
    }
    const uniqueKeys = Array.from(new Set(keys));
    for (const key of uniqueKeys) {
      let set = this.byKey.get(key);
      if (!set) {
        set = new Set();
        this.byKey.set(key, set);
      }
      set.add(onWake);
    }
    return () => {
      for (const key of uniqueKeys) {
        const set = this.byKey.get(key);
        if (!set) continue;
        set.delete(onWake);
        if (set.size === 0) {
          this.byKey.delete(key);
        }
      }
    };
  }

  notifyEvents(events: ChangeCommittedEvent[]): void {
    const callbacks = new Set<() => void>();
    for (const ev of events) {
      const k = this.keyFor(ev.orgId, ev.realmId);
      const listeners = this.byKey.get(k);
      if (listeners) {
        for (const fn of listeners) callbacks.add(fn);
      }
      if (ev.realmId !== "__org__") {
        // Also wake org-wide topology listeners only on __org__; normal realm writes wake only subscribed realms
      }
    }
    for (const fn of callbacks) {
      try {
        fn();
      } catch {
        // Never allow a consumer callback failure to disrupt other listeners
      }
    }
  }

  get subscriberKeyCount(): number {
    return this.byKey.size;
  }
}

export interface PumpPollParams {
  sinceSeq: number;
  generation?: number;
  limit?: number;
  realmRef?: string;
  about?: string;
  includeDescendantSeabed?: boolean;
  waitSeconds?: number;
  signal?: AbortSignal;
}

export interface PumpPollResult {
  generation: number;
  topologyVersion: number;
  sinceSeq: number;
  latestSeq: number;
  resetRequired: boolean;
  frames: PumpChangeFrame[];
}

/**
 * Single-cursor Pump Engine (Fable-consensus Pump Model):
 * - Maintains (topoVer, ledgerSet, seabedSet, driveSet) derived strictly from policy.ts
 * - Re-validates Principal token activity AND topologyVersion before every batch
 * - Reads thin, contentless frames directly from SQLite WAL (`change_log`)
 * - Supports both immediate reads (waitSeconds = 0), Long-Poll (v0.3, wait <= 25s), and WS Pump (v0.4)
 */
export class MindPump {
  private cachedTopoVer = -1;
  private cachedScope: AccessScope | null = null;
  private cachedIncludeDescendantSeabed = false;

  constructor(
    private readonly db: DbPort,
    private readonly wakeBus: ChangeWakeBus,
    private readonly principal: Principal,
  ) {}

  private refreshScopeIfNeeded(includeDescendantSeabed: boolean): AccessScope {
    if (!isPrincipalTokenActive(this.db, this.principal)) {
      throw new MindError("ACCESS_DENIED", "Token has been revoked");
    }
    const liveTopoVer = this.db.getTopologyVersion();
    if (
      this.cachedScope &&
      this.cachedTopoVer === liveTopoVer &&
      this.cachedIncludeDescendantSeabed === includeDescendantSeabed
    ) {
      return this.cachedScope;
    }

    const org = this.db.getOrg(this.principal.orgId);
    if (!org) {
      throw new MindError(
        "NOT_FOUND",
        `Organization not found: ${this.principal.orgId}`,
      );
    }
    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    const scope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: this.principal.boundRealmId,
      orgPolicy: org.policy,
      includeDescendantSeabed,
    });
    this.cachedTopoVer = liveTopoVer;
    this.cachedScope = scope;
    this.cachedIncludeDescendantSeabed = includeDescendantSeabed;
    return scope;
  }

  /**
   * Reads a single non-blocking batch of thin change frames strictly respecting (ledgerSet, seabedSet, driveSet).
   */
  readBatch(params: {
    sinceSeq: number;
    generation?: number;
    limit?: number;
    realmRef?: string;
    about?: string;
    includeDescendantSeabed?: boolean;
  }): PumpPollResult {
    const includeDescendantSeabed = Boolean(params.includeDescendantSeabed);
    const scope = this.refreshScopeIfNeeded(includeDescendantSeabed);
    const currentGen = this.db.getChangeLogGeneration();
    const topoVer = this.db.getTopologyVersion();
    const sinceSeq = Math.max(0, Math.floor(params.sinceSeq));
    const limit = Math.max(1, Math.min(params.limit ?? 50, 500));

    if (params.generation !== undefined && params.generation !== currentGen) {
      const latestSeq = this.db.getLatestVisibleChangeLogSeq({
        orgId: this.principal.orgId,
        ledgerRealmIds: scope.readableLedgerIds,
        seabedRealmIds: scope.readableSeabedIds,
        includeSecret: false,
      });
      return {
        generation: currentGen,
        topologyVersion: topoVer,
        sinceSeq,
        latestSeq,
        resetRequired: true,
        frames: [],
      };
    }

    const realms = this.db.listRealms();
    const mounts = this.db.listMounts();
    let filterRealmIds: string[] | undefined;
    let effectiveLedgerIds = scope.readableLedgerIds;
    let effectiveSeabedIds = scope.readableSeabedIds;
    let effectiveDriveIds = scope.readableDriveIds;
    let includeOrgLevel = true;

    if (params.realmRef?.trim()) {
      const target = resolveVisibleRealm({
        realms,
        orgId: this.principal.orgId,
        ref: params.realmRef.trim(),
        scope,
      });
      const orgRealms = realms.filter((r) => r.orgId === this.principal.orgId);
      const subtreeIds = [target.id, ...getDescendantIds(orgRealms, target.id)];
      const subtreeSet = new Set(subtreeIds);
      filterRealmIds = subtreeIds;
      effectiveLedgerIds = scope.readableLedgerIds.filter((id) =>
        subtreeSet.has(id),
      );
      effectiveSeabedIds = scope.readableSeabedIds.filter((id) =>
        subtreeSet.has(id),
      );
      effectiveDriveIds = scope.readableDriveIds.filter((id) =>
        subtreeSet.has(id),
      );
      includeOrgLevel = false;
    }

    const vis = createVisibilityHelpers({
      db: this.db,
      realms,
      mounts,
      actor: this.principal.actor,
      viewerRealmId: this.principal.boundRealmId,
      scope,
      ledgerRealmIds: effectiveLedgerIds,
      seabedRealmIds: effectiveSeabedIds,
      includeDescendantSeabed,
    });

    let aboutFilter: ChangeLogAboutFilter | undefined;
    if (params.about?.trim()) {
      aboutFilter = resolveChangeAboutFilter({
        db: this.db,
        realms,
        orgId: this.principal.orgId,
        aboutRef: params.about.trim(),
        scope,
        vis,
      });
      includeOrgLevel = false;
    }

    const batchSize = Math.min(500, Math.max(limit * 2, 100));
    const MAX_SCAN_BATCHES = 20;
    const collected: PumpChangeFrame[] = [];
    let scanSeq = sinceSeq;
    let resGen = currentGen;
    let resTopoVer = topoVer;

    for (let batch = 0; batch < MAX_SCAN_BATCHES && collected.length < limit; batch++) {
      const raw = this.db.listChangeLogForPump({
        orgId: this.principal.orgId,
        ledgerRealmIds: scope.readableLedgerIds,
        seabedRealmIds: scope.readableSeabedIds,
        driveRealmIds: scope.readableDriveIds,
        sinceSeq: scanSeq,
        limit: batchSize,
        includeSecret: false,
        filterRealmIds,
        aboutFilter,
      });
      resGen = raw.generation;
      resTopoVer = raw.topologyVersion;
      if (raw.frames.length === 0) break;

      const remaining = limit - collected.length;
      const visibleBatch = filterVisibleChangeFrames({
        db: this.db,
        frames: raw.frames,
        vis,
        scope,
        ledgerRealmIds: effectiveLedgerIds,
        seabedRealmIds: effectiveSeabedIds,
        driveRealmIds: effectiveDriveIds,
        includeOrgLevel,
        includeSecret: false,
        limit: remaining,
      });
      collected.push(...visibleBatch);

      const lastRawSeq = raw.frames[raw.frames.length - 1]!.seq;
      if (lastRawSeq <= scanSeq || raw.frames.length < batchSize) {
        break;
      }
      scanSeq = lastRawSeq;
    }

    const latestSeq =
      collected.length > 0
        ? collected[collected.length - 1]!.seq
        : sinceSeq;

    return {
      generation: resGen,
      topologyVersion: resTopoVer,
      sinceSeq,
      latestSeq: Math.max(latestSeq, sinceSeq),
      resetRequired: false,
      frames: collected,
    };
  }

  /**
   * Long-Poll (v0.3): immediately returns if frames or generation reset exist;
   * otherwise sleeps on ChangeWakeBus until notified or `waitSeconds` (max 25s) elapses.
   */
  async poll(params: PumpPollParams): Promise<PumpPollResult> {
    const first = this.readBatch(params);
    const waitSec = Math.max(0, Math.min(params.waitSeconds ?? 0, 25));
    if (
      first.resetRequired ||
      first.frames.length > 0 ||
      waitSec <= 0 ||
      params.signal?.aborted
    ) {
      return first;
    }

    const includeDescendantSeabed = Boolean(params.includeDescendantSeabed);
    const scope = this.refreshScopeIfNeeded(includeDescendantSeabed);
    const watchRealmIds = new Set<string>([
      ...scope.readableLedgerIds,
      ...scope.readableSeabedIds,
      ...scope.readableDriveIds,
    ]);

    return new Promise<PumpPollResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        params.signal?.removeEventListener("abort", onAbort);
      };

      const finish = (result: PumpPollResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        try {
          finish(this.readBatch(params));
        } catch (err) {
          fail(err);
        }
      };

      const onWake = () => {
        if (settled) return;
        try {
          const next = this.readBatch(params);
          if (next.resetRequired || next.frames.length > 0) {
            finish(next);
          } else if (next.topologyVersion !== first.topologyVersion) {
            // Topology changed -> re-subscribe with refreshed scope
            finish(next);
          }
        } catch (err) {
          fail(err);
        }
      };

      unsubscribe = this.wakeBus.subscribe(
        this.principal.orgId,
        watchRealmIds,
        onWake,
      );
      params.signal?.addEventListener("abort", onAbort, { once: true });

      // Double-check after subscribing to close any race between initial read and subscribe
      try {
        const afterSub = this.readBatch(params);
        if (afterSub.resetRequired || afterSub.frames.length > 0) {
          finish(afterSub);
          return;
        }
      } catch (err) {
        fail(err);
        return;
      }

      timer = setTimeout(() => {
        try {
          finish(this.readBatch(params));
        } catch (err) {
          fail(err);
        }
      }, Math.round(waitSec * 1000));
    });
  }

  getVisibleRealmIds(includeDescendantSeabed = false): string[] {
    const scope = this.refreshScopeIfNeeded(includeDescendantSeabed);
    return Array.from(
      new Set([
        ...scope.readableLedgerIds,
        ...scope.readableSeabedIds,
        ...scope.readableDriveIds,
      ]),
    );
  }
}
