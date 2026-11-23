import { resolveAccessScope } from "../policy.js";
import type { DbPort } from "../ports.js";
import { MindError, type Principal } from "../types.js";
import { resolveVisibleRealm } from "../engine/objects.js";

export interface PulseEntry {
  sessionId: string;
  orgId: string;
  realmId: string;
  realmPath: string;
  actorId: string;
  actorKind: "human" | "agent" | "system";
  focus: string[];
  note: string | null;
  lastSeenAt: string;
  /** Computed dynamically on read (never stored as a column) */
  online: boolean;
}

const MAX_FOCUS_REFS = 3;
const MAX_NOTE_CHARS = 140;
const ONLINE_WINDOW_MS = 90_000;
const STALE_EVICT_MS = 5 * 60_000;

interface StoredPulse {
  sessionId: string;
  orgId: string;
  realmId: string;
  actorId: string;
  actorKind: "human" | "agent" | "system";
  focus: string[];
  note: string | null;
  lastSeenMs: number;
}

/**
 * Ultra-thin in-process MindPulse store (Fable-approved v0.4 + DO hygiene habit #3):
 * - Lives purely in an in-process Map (never written to SQLite, never enters change_log, never backed up)
 * - Declaration-only focus (max 3 refs) + optional note (<= 140 chars) + lastSeenAt
 * - No stored `status` field; `online` is derived at read time from `lastSeenAt`
 * - Write paths NEVER read MindPulse (zero lock/deadlock semantics)
 * - Read path enforces the exact same `policy.ts` visibility boundary (`tree` siblings invisible)
 */
export class MindPulseStore {
  private readonly entries = new Map<string, StoredPulse>();

  private prune(nowMs: number): void {
    for (const [sid, entry] of this.entries.entries()) {
      if (nowMs - entry.lastSeenMs > STALE_EVICT_MS) {
        this.entries.delete(sid);
      }
    }
  }

  declare(params: {
    db: DbPort;
    principal: Principal;
    sessionId?: string;
    realmRef?: string;
    focus?: string[];
    note?: string | null;
    nowMs?: number;
  }): PulseEntry {
    const nowMs = params.nowMs ?? Date.now();
    this.prune(nowMs);

    const focusRaw = params.focus ?? [];
    if (!Array.isArray(focusRaw) || focusRaw.length > MAX_FOCUS_REFS) {
      throw new MindError(
        "INVALID_INPUT",
        `Pulse focus accepts at most ${MAX_FOCUS_REFS} references`,
      );
    }
    const focus = focusRaw
      .map((s) => String(s ?? "").trim())
      .filter(Boolean)
      .slice(0, MAX_FOCUS_REFS);

    const noteRaw =
      params.note !== undefined && params.note !== null
        ? String(params.note).trim()
        : null;
    if (noteRaw && noteRaw.length > MAX_NOTE_CHARS) {
      throw new MindError(
        "INVALID_INPUT",
        `Pulse note must be <= ${MAX_NOTE_CHARS} characters (got ${noteRaw.length})`,
      );
    }

    const org = params.db.getOrg(params.principal.orgId);
    if (!org) {
      throw new MindError("NOT_FOUND", `Organization not found: ${params.principal.orgId}`);
    }
    const realms = params.db.listRealms();
    const mounts = params.db.listMounts();
    const scope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: params.principal.boundRealmId,
      orgPolicy: org.policy,
      includeDescendantSeabed: false,
    });

    const targetRealm = params.realmRef?.trim()
      ? resolveVisibleRealm({
          realms,
          orgId: org.id,
          ref: params.realmRef.trim(),
          scope,
        })
      : realms.find((r) => r.id === params.principal.boundRealmId);
    if (!targetRealm) {
      throw new MindError("NOT_FOUND", "Bound realm not found");
    }

    const sessionId =
      params.sessionId?.trim() ||
      `${params.principal.actor.id}:${params.principal.tokenId ?? params.principal.authKind}`;

    const stored: StoredPulse = {
      sessionId,
      orgId: org.id,
      realmId: targetRealm.id,
      actorId: params.principal.actor.id,
      actorKind: params.principal.actor.kind,
      focus,
      note: noteRaw || null,
      lastSeenMs: nowMs,
    };
    this.entries.set(sessionId, stored);

    return {
      sessionId: stored.sessionId,
      orgId: stored.orgId,
      realmId: stored.realmId,
      realmPath: targetRealm.path,
      actorId: stored.actorId,
      actorKind: stored.actorKind,
      focus: [...stored.focus],
      note: stored.note,
      lastSeenAt: new Date(stored.lastSeenMs).toISOString(),
      online: true,
    };
  }

  listVisible(params: {
    db: DbPort;
    principal: Principal;
    nowMs?: number;
  }): PulseEntry[] {
    const nowMs = params.nowMs ?? Date.now();
    this.prune(nowMs);

    const org = params.db.getOrg(params.principal.orgId);
    if (!org) return [];
    const realms = params.db.listRealms();
    const mounts = params.db.listMounts();
    const scope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: params.principal.boundRealmId,
      orgPolicy: org.policy,
      includeDescendantSeabed: false,
    });
    const visibleLedger = new Set(scope.readableLedgerIds);
    const realmById = new Map(realms.map((r) => [r.id, r]));

    const out: PulseEntry[] = [];
    for (const stored of this.entries.values()) {
      if (stored.orgId !== org.id) continue;
      if (!visibleLedger.has(stored.realmId)) continue;
      const realm = realmById.get(stored.realmId);
      out.push({
        sessionId: stored.sessionId,
        orgId: stored.orgId,
        realmId: stored.realmId,
        realmPath: realm?.path ?? "/",
        actorId: stored.actorId,
        actorKind: stored.actorKind,
        focus: [...stored.focus],
        note: stored.note,
        lastSeenAt: new Date(stored.lastSeenMs).toISOString(),
        online: nowMs - stored.lastSeenMs <= ONLINE_WINDOW_MS,
      });
    }
    out.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return out;
  }

  remove(sessionId: string): void {
    this.entries.delete(sessionId);
  }
}
