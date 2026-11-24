import type { DbPort } from "../ports.js";
import type { MindSurface } from "../surface.js";
import type { Principal, ShowResult } from "../types.js";
import type { MindPulseStore } from "./pulse.js";

export interface LivePulseSessionContext {
  db: DbPort;
  pulseStore: MindPulseStore;
  principal: Principal;
  sessionTag: string;
  clientHint: string | null;
}

/**
 * Wraps a `MindSurface` at the single `http-server.ts:createSurface` seam so BOTH
 * REST (`/v1/*`) and Streamable HTTP MCP (`/mcp`) get passive MindPulse observation
 * and `show <realm>` `activePeers` without JSON-RPC sniffing or mutating `LocalMindSurface`.
 *
 * Structural guarantees:
 * - `write()` observes strictly AFTER commit and NEVER reads `pulseStore` (Invariant #2).
 * - `observe()` errors are always swallowed so hot telemetry never breaks or retries commits.
 * - `changes()` long-poll is intentionally excluded (polling is not active work).
 */
export function withLivePulse(
  inner: MindSurface,
  ctx: LivePulseSessionContext,
): MindSurface {
  const safeObserve = (opts?: {
    realmId?: string | null;
    realmRef?: string | null;
    activity?: string | null;
  }): void => {
    try {
      ctx.pulseStore.observe({
        db: ctx.db,
        principal: ctx.principal,
        sessionTag: ctx.sessionTag,
        clientHint: ctx.clientHint,
        realmId: opts?.realmId ?? null,
        realmRef: opts?.realmRef ?? null,
        activity: opts?.activity ?? null,
      });
    } catch {
      // Never allow ephemeral telemetry failures to disrupt committed reads/writes
    }
  };

  const isPublicOrInternal = (sensitivity?: string | null): boolean =>
    sensitivity !== "confidential" && sensitivity !== "secret";

  return {
    get mode() {
      return inner.mode;
    },
    get principal() {
      return inner.principal;
    },

    // `whoami` is a lightweight connection/identity probe (called by RemoteMindSurface.connect);
    // do not register passive domain presence on identity probes alone.
    whoami: () => inner.whoami(),

    async tree(params) {
      const out = await inner.tree(params);
      safeObserve();
      return out;
    },

    async ls(params) {
      const out = await inner.ls(params);
      safeObserve();
      return out;
    },

    async show(params): Promise<ShowResult> {
      const out = await inner.show(params);
      if (out.refType === "realm") {
        safeObserve({ realmId: out.brief.realm.id });
        try {
          const activePeers = ctx.pulseStore.listActivePeersForRealm({
            db: ctx.db,
            principal: ctx.principal,
            realmId: out.brief.realm.id,
            excludeSessionTag: ctx.sessionTag,
            limit: 5,
          });
          if (activePeers.length > 0) {
            return { ...out, activePeers };
          }
        } catch {
          // Swallow peer-lookup errors; return canonical brief cleanly
        }
        return out;
      }
      if (out.refType === "object") {
        safeObserve({
          realmId: out.card.object?.realmId ?? null,
          activity: out.card.object
            ? `inspecting ${out.card.kind}:${out.card.name}`
            : null,
        });
        return out;
      }
      if (out.refType === "entry") {
        const entry = out.entry;
        if (entry.kind === "record") {
          safeObserve({
            realmId: entry.record.realmId,
            activity: isPublicOrInternal(entry.record.sensitivity)
              ? `reading "${entry.record.title}"`
              : null,
          });
        } else if (entry.kind === "seabed") {
          safeObserve({
            realmId: entry.seabed.realmId,
            activity: isPublicOrInternal(entry.seabed.sensitivity)
              ? `reading raw (${entry.seabed.kind})`
              : null,
          });
        } else if (entry.kind === "distillation") {
          safeObserve({
            realmId: entry.distillation.realmId,
            activity: `reading distillation (${entry.distillation.periodKey})`,
          });
        } else {
          safeObserve();
        }
        return out;
      }
      if (out.refType === "file") {
        const baseName = out.file.relPath.split("/").pop() || "file";
        safeObserve({
          realmId: out.file.realmId,
          activity: `reading file:${baseName}`,
        });
        return out;
      }
      safeObserve();
      return out;
    },

    async search(params) {
      const out = await inner.search(params);
      if (params.in?.trim()) {
        safeObserve({
          realmRef: params.in.trim(),
          activity: `searching "${params.query}"`,
        });
      } else {
        safeObserve();
      }
      return out;
    },

    // Long-poll / incremental change reads intentionally do NOT count as active work
    changes: (params) => inner.changes(params),

    async write(params) {
      const out = await inner.write(params);
      // Strictly post-commit and write-only into pulseStore (never calls listVisible)
      safeObserve({
        realmId: out.record.realmId,
        activity: isPublicOrInternal(out.record.sensitivity)
          ? `wrote ${out.record.kind}: "${out.record.title}"`
          : "wrote entry",
      });
      return out;
    },

    async rawAdd(params) {
      const out = await inner.rawAdd(params);
      safeObserve({
        realmId: out.realmId,
        activity: isPublicOrInternal(out.sensitivity)
          ? `added raw (${out.kind})`
          : "added raw entry",
      });
      return out;
    },

    move: (params) => inner.move(params),
    getEntryChain: (entryId) => inner.getEntryChain(entryId),
    addRule: (params) => inner.addRule(params),
    redact: (params) => inner.redact(params),
    createRealm: (params) => inner.createRealm(params),
    updateRealm: (params) => inner.updateRealm(params),
    mountRealm: (params) => inner.mountRealm(params),
    unmountRealm: (params) => inner.unmountRealm(params),
    archiveRealm: (params) => inner.archiveRealm(params),
    unarchiveRealm: (params) => inner.unarchiveRealm(params),
    setOrgPolicy: (params) => inner.setOrgPolicy(params),
    listTokens: (params) => inner.listTokens(params),
    createToken: (params) => inner.createToken(params),
    revokeToken: (params) => inner.revokeToken(params),
    bindWork: (params) => inner.bindWork(params),
    unbindWork: (params) => inner.unbindWork(params),
    listWorkBindings: () => inner.listWorkBindings(),
    resolveWork: (params) => inner.resolveWork(params),
    listReadyWork: (params) => inner.listReadyWork(params),
    close: () => inner.close(),
  };
}
