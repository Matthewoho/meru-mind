import crypto from "node:crypto";
import { resolveVisibleRealm } from "../engine/objects.js";
import { sanitizeRealmsForScope } from "../engine/visibility.js";
import { resolveAccess, resolveAccessScope } from "../policy.js";
import type { DbPort } from "../ports.js";
import {
  MindError,
  type ActivePeerSummary,
  type Principal,
} from "../types.js";

export interface PulseEntry {
  sessionId: string;
  orgId: string;
  realmId: string;
  realmPath: string;
  actorId: string;
  actorKind: "human" | "agent" | "system";
  /** Self-reported client label (e.g. "claude-code", "codex"); never trusted for auth or actorKind */
  clientHint: string | null;
  focus: string[];
  note: string | null;
  /** Server-observed latest safe action in this realm (never populated from confidential/secret entries or read-only realms) */
  activity: string | null;
  lastSeenAt: string;
  /** Seconds elapsed since lastSeenAt relative to server clock `now` */
  ageSeconds: number;
  /** True when registered/refreshed via explicit heartbeat (`POST /v1/pulse`), false for passive observation */
  heartbeat: boolean;
  /** Computed dynamically on read: true when heartbeat-backed and within 90s online window */
  online: boolean;
  /** Computed dynamically on read: true when seen within the 15-minute active-peer window */
  active: boolean;
}

export interface PulseListResult {
  now: string;
  pulses: PulseEntry[];
}

export const MAX_FOCUS_REFS = 3;
export const MAX_FOCUS_ITEM_CHARS = 120;
export const MAX_NOTE_CHARS = 140;
export const MAX_ACTIVITY_CHARS = 96;
export const MAX_SESSION_TAG_CHARS = 64;
export const MAX_CLIENT_HINT_CHARS = 32;
export const MAX_SESSIONS_PER_PRINCIPAL = 16;
export const MAX_TOTAL_SESSIONS = 1_000;
export const ONLINE_WINDOW_MS = 90_000;
export const ACTIVE_PEER_WINDOW_MS = 15 * 60_000;
export const STALE_EVICT_MS = 45 * 60_000;

const CLIENT_HINT_RE = /^[a-zA-Z0-9._-]{1,32}$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const CREDENTIAL_LIKE_RE =
  /(?:mm_live_|sk-[a-z0-9]{10,}|ghp_[a-z0-9]{10,}|github_pat_[a-z0-9_]{10,}|AKIA[0-9A-Z]{12,}|xox[bpas]-[a-z0-9-]+|Bearer\s+[a-z0-9._-]{10,}|-----BEGIN\s+[A-Z ]+KEY-----)/i;

interface StoredPulse {
  compositeKey: string;
  principalNamespace: string;
  externalSessionId: string;
  orgId: string;
  realmId: string;
  actorId: string;
  actorKind: "human" | "agent" | "system";
  clientHint: string | null;
  focus: string[];
  note: string | null;
  activity: string | null;
  heartbeat: boolean;
  lastSeenMs: number;
}

export function sanitizeObservedActivity(raw?: string | null): string | null {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  if (CREDENTIAL_LIKE_RE.test(cleaned)) return null;
  if (cleaned.length <= MAX_ACTIVITY_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_ACTIVITY_CHARS - 1).trimEnd()}…`;
}

export function sanitizeClientHint(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_CLIENT_HINT_CHARS) return null;
  return CLIENT_HINT_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

function normalizeSessionTagStrict(raw?: string | null): string {
  if (raw === undefined || raw === null) return "default";
  const trimmed = String(raw).trim();
  if (!trimmed) return "default";
  if (trimmed.length > MAX_SESSION_TAG_CHARS) {
    throw new MindError(
      "INVALID_INPUT",
      `Pulse sessionId must be <= ${MAX_SESSION_TAG_CHARS} characters (got ${trimmed.length})`,
    );
  }
  if (CONTROL_CHARS_RE.test(trimmed)) {
    throw new MindError(
      "INVALID_INPUT",
      "Pulse sessionId must not contain control characters",
    );
  }
  return trimmed;
}

function normalizeSessionTagSafe(raw?: string | null): string {
  if (!raw) return "default";
  const cleaned = String(raw)
    .trim()
    .replace(/[\x00-\x1f\x7f]+/g, "")
    .slice(0, MAX_SESSION_TAG_CHARS);
  return cleaned || "default";
}

function buildPrincipalNamespace(principal: Principal): string {
  // Include BOTH tokenId AND authKind because browser Cookie sessions reuse the minting Bearer tokenId
  return `${principal.orgId}\0${principal.actor.id}\0${principal.tokenId ?? "none"}\0${principal.authKind}`;
}

/**
 * Ultra-thin in-process MindPulse store (v0.4 + v0.5.4 Fable red-team hardening):
 * - Lives purely in an in-process Map (never written to SQLite, never enters change_log, never backed up)
 * - Principal-namespaced composite keys with process-salted external IDs (zero cross-actor overwrite, zero `tok_` exposure)
 * - Presence follows WRITE permission (`resolveAccess(..., "ledger") === "write"`) — closes tree-mode cross-branch covert channels
 * - Strictly enforces `policy.ts` + `sanitizeRealmsForScope` on read (`@mounted/<alias>` zero path leak)
 * - Write paths NEVER read MindPulse (Invariant #2: zero lock/deadlock semantics)
 * - Zero background timers (Cloudflare DO hibernation safe); ages derived lazily from server `now`
 */
export class MindPulseStore {
  private readonly entries = new Map<string, StoredPulse>();
  private readonly idSalt = crypto.randomBytes(16);

  private toExternalSessionId(compositeKey: string): string {
    const hash = crypto
      .createHmac("sha256", this.idSalt)
      .update(compositeKey, "utf8")
      .digest("hex")
      .slice(0, 16);
    return `ps_${hash}`;
  }

  private buildKey(principal: Principal, normalizedTag: string): {
    principalNamespace: string;
    compositeKey: string;
    externalSessionId: string;
  } {
    const principalNamespace = buildPrincipalNamespace(principal);
    const compositeKey = `${principalNamespace}\0${normalizedTag}`;
    return {
      principalNamespace,
      compositeKey,
      externalSessionId: this.toExternalSessionId(compositeKey),
    };
  }

  private prune(nowMs: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (nowMs - entry.lastSeenMs > STALE_EVICT_MS) {
        this.entries.delete(key);
      }
    }
  }

  private enforceCapacity(principalNamespace: string, incomingKey: string): void {
    if (this.entries.has(incomingKey)) return;

    // 1. Per-principal cap (evict oldest within the same principal namespace)
    let principalCount = 0;
    let oldestPrincipalKey: string | null = null;
    let oldestPrincipalMs = Infinity;
    for (const [k, entry] of this.entries.entries()) {
      if (entry.principalNamespace !== principalNamespace) continue;
      principalCount += 1;
      if (entry.lastSeenMs < oldestPrincipalMs) {
        oldestPrincipalMs = entry.lastSeenMs;
        oldestPrincipalKey = k;
      }
    }
    if (principalCount >= MAX_SESSIONS_PER_PRINCIPAL && oldestPrincipalKey) {
      this.entries.delete(oldestPrincipalKey);
    }

    // 2. Global cap (evict globally oldest)
    while (this.entries.size >= MAX_TOTAL_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestMs = Infinity;
      for (const [k, entry] of this.entries.entries()) {
        if (entry.lastSeenMs < oldestMs) {
          oldestMs = entry.lastSeenMs;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }

  private toPublicEntry(
    stored: StoredPulse,
    realmPath: string,
    nowMs: number,
  ): PulseEntry {
    const ageMs = Math.max(0, nowMs - stored.lastSeenMs);
    return {
      sessionId: stored.externalSessionId,
      orgId: stored.orgId,
      realmId: stored.realmId,
      realmPath,
      actorId: stored.actorId,
      actorKind: stored.actorKind,
      clientHint: stored.clientHint,
      focus: [...stored.focus],
      note: stored.note,
      activity: stored.activity,
      lastSeenAt: new Date(stored.lastSeenMs).toISOString(),
      ageSeconds: Math.floor(ageMs / 1000),
      heartbeat: stored.heartbeat,
      online: stored.heartbeat && ageMs <= ONLINE_WINDOW_MS,
      active: ageMs <= ACTIVE_PEER_WINDOW_MS,
    };
  }

  /**
   * Explicit heartbeat / focus declaration (`POST /v1/pulse`).
   * Enforces write-permission invariant so principals cannot publish notes/focus into read-only realms.
   */
  declare(params: {
    db: DbPort;
    principal: Principal;
    sessionId?: string;
    realmRef?: string;
    focus?: string[];
    note?: string | null;
    clientHint?: string | null;
    nowMs?: number;
  }): PulseEntry {
    const nowMs = params.nowMs ?? Date.now();
    this.prune(nowMs);

    const normalizedTag = normalizeSessionTagStrict(params.sessionId);

    const focusRaw = params.focus ?? [];
    if (!Array.isArray(focusRaw) || focusRaw.length > MAX_FOCUS_REFS) {
      throw new MindError(
        "INVALID_INPUT",
        `Pulse focus accepts at most ${MAX_FOCUS_REFS} references`,
      );
    }
    const focus: string[] = [];
    for (const rawItem of focusRaw) {
      const item = String(rawItem ?? "").trim();
      if (!item) continue;
      if (item.length > MAX_FOCUS_ITEM_CHARS) {
        throw new MindError(
          "INVALID_INPUT",
          `Each pulse focus item must be <= ${MAX_FOCUS_ITEM_CHARS} characters (got ${item.length})`,
        );
      }
      focus.push(item);
    }

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
      throw new MindError(
        "NOT_FOUND",
        `Organization not found: ${params.principal.orgId}`,
      );
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

    // Hard security invariant: Presence follows WRITE permission (prevents tree-mode cross-branch covert channel)
    const access = resolveAccess({
      realms,
      mounts,
      actor: params.principal.actor,
      viewerRealmId: params.principal.boundRealmId,
      targetRealmId: targetRealm.id,
      assetKind: "ledger",
      orgPolicy: org.policy,
    });
    if (access !== "write") {
      throw new MindError(
        "ACCESS_DENIED",
        `Cannot declare pulse in read-only realm "${targetRealm.path}" under "${org.policy}" policy.`,
      );
    }

    const { principalNamespace, compositeKey, externalSessionId } = this.buildKey(
      params.principal,
      normalizedTag,
    );
    const existing = this.entries.get(compositeKey);
    this.enforceCapacity(principalNamespace, compositeKey);

    const clientHint =
      params.clientHint !== undefined
        ? sanitizeClientHint(params.clientHint)
        : (existing?.clientHint ?? null);

    const stored: StoredPulse = {
      compositeKey,
      principalNamespace,
      externalSessionId,
      orgId: org.id,
      realmId: targetRealm.id,
      actorId: params.principal.actor.id,
      actorKind: params.principal.actor.kind,
      clientHint,
      focus,
      note: noteRaw || null,
      activity: existing && existing.realmId === targetRealm.id ? existing.activity : null,
      heartbeat: true,
      lastSeenMs: nowMs,
    };
    this.entries.set(compositeKey, stored);

    const sanitizedMap = sanitizeRealmsForScope(realms, scope);
    const sanitizedPath = sanitizedMap.get(targetRealm.id)?.path ?? targetRealm.path;
    return this.toPublicEntry(stored, sanitizedPath, nowMs);
  }

  /**
   * Passive server-side activity observation invoked STRICTLY AFTER successful MindSurface calls.
   * Never throws into caller flows; enforces write-permission invariant so reading a shared ancestor
   * or @mounted realm in `tree` mode NEVER publishes presence to siblings.
   */
  observe(params: {
    db: DbPort;
    principal: Principal;
    sessionTag?: string | null;
    clientHint?: string | null;
    realmId?: string | null;
    realmRef?: string | null;
    activity?: string | null;
    nowMs?: number;
  }): void {
    const nowMs = params.nowMs ?? Date.now();
    this.prune(nowMs);

    const org = params.db.getOrg(params.principal.orgId);
    if (!org) return;

    const realms = params.db.listRealms();
    const mounts = params.db.listMounts();
    const realmById = new Map(realms.map((r) => [r.id, r]));

    const normalizedTag = normalizeSessionTagSafe(params.sessionTag);
    const { principalNamespace, compositeKey, externalSessionId } = this.buildKey(
      params.principal,
      normalizedTag,
    );
    const existing = this.entries.get(compositeKey);

    let resolvedTargetRealmId: string | null = params.realmId ?? null;
    if (!resolvedTargetRealmId && params.realmRef?.trim()) {
      try {
        const scope = resolveAccessScope({
          realms,
          mounts,
          viewerRealmId: params.principal.boundRealmId,
          orgPolicy: org.policy,
          includeDescendantSeabed: false,
        });
        const targetRealm = resolveVisibleRealm({
          realms,
          orgId: org.id,
          ref: params.realmRef.trim(),
          scope,
        });
        resolvedTargetRealmId = targetRealm.id;
      } catch {
        resolvedTargetRealmId = null;
      }
    }

    const isWritable = (candidateId: string | null | undefined): candidateId is string => {
      if (!candidateId || !realmById.has(candidateId)) return false;
      const access = resolveAccess({
        realms,
        mounts,
        actor: params.principal.actor,
        viewerRealmId: params.principal.boundRealmId,
        targetRealmId: candidateId,
        assetKind: "ledger",
        orgPolicy: org.policy,
      });
      return access === "write";
    };

    const targetWritable = isWritable(resolvedTargetRealmId);
    let nextRealmId: string | null = null;
    if (targetWritable) {
      nextRealmId = resolvedTargetRealmId;
    } else if (isWritable(existing?.realmId)) {
      nextRealmId = existing!.realmId;
    } else if (isWritable(params.principal.boundRealmId)) {
      nextRealmId = params.principal.boundRealmId;
    }
    if (!nextRealmId) return;

    // Security invariant: NEVER attach activity observed from a read-only / @mounted realm
    const safeActivity = targetWritable
      ? sanitizeObservedActivity(params.activity)
      : null;
    const nextActivity =
      safeActivity ??
      (existing && existing.realmId === nextRealmId ? existing.activity : null);

    this.enforceCapacity(principalNamespace, compositeKey);

    const sanitizedHint = sanitizeClientHint(params.clientHint);
    const stored: StoredPulse = {
      compositeKey,
      principalNamespace,
      externalSessionId,
      orgId: org.id,
      realmId: nextRealmId,
      actorId: params.principal.actor.id,
      actorKind: params.principal.actor.kind,
      clientHint: sanitizedHint ?? existing?.clientHint ?? null,
      focus: existing ? [...existing.focus] : [],
      note: existing ? existing.note : null,
      activity: nextActivity,
      heartbeat: existing?.heartbeat ?? false,
      lastSeenMs: nowMs,
    };
    this.entries.set(compositeKey, stored);
  }

  /**
   * Lists visible pulses strictly filtered by `policy.ts` and sanitized via `sanitizeRealmsForScope`
   * so hidden ancestor paths under `@mounted/<alias>` are NEVER exposed.
   */
  listVisibleWithNow(params: {
    db: DbPort;
    principal: Principal;
    nowMs?: number;
  }): PulseListResult {
    const nowMs = params.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    this.prune(nowMs);

    const org = params.db.getOrg(params.principal.orgId);
    if (!org) return { now: nowIso, pulses: [] };
    const realms = params.db.listRealms();
    const mounts = params.db.listMounts();
    const scope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: params.principal.boundRealmId,
      orgPolicy: org.policy,
      includeDescendantSeabed: false,
    });
    const sanitizedMap = sanitizeRealmsForScope(realms, scope);

    const out: PulseEntry[] = [];
    for (const stored of this.entries.values()) {
      if (stored.orgId !== org.id) continue;
      const sanitizedRealm = sanitizedMap.get(stored.realmId);
      if (!sanitizedRealm) continue;
      out.push(this.toPublicEntry(stored, sanitizedRealm.path, nowMs));
    }
    out.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return { now: nowIso, pulses: out };
  }

  listVisible(params: {
    db: DbPort;
    principal: Principal;
    nowMs?: number;
  }): PulseEntry[] {
    return this.listVisibleWithNow(params).pulses;
  }

  /**
   * Lists up to `limit` other active peers (within 15-minute window) in the same realm,
   * strictly scoped via `listVisible` and excluding the caller's own session.
   */
  listActivePeersForRealm(params: {
    db: DbPort;
    principal: Principal;
    realmId: string;
    excludeSessionTag?: string | null;
    nowMs?: number;
    limit?: number;
  }): ActivePeerSummary[] {
    const nowMs = params.nowMs ?? Date.now();
    const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
    const selfTag = normalizeSessionTagSafe(params.excludeSessionTag);
    const { externalSessionId: selfExternalId } = this.buildKey(
      params.principal,
      selfTag,
    );

    const visible = this.listVisible({
      db: params.db,
      principal: params.principal,
      nowMs,
    });

    const peers: ActivePeerSummary[] = [];
    for (const entry of visible) {
      if (entry.realmId !== params.realmId) continue;
      if (entry.sessionId === selfExternalId) continue;
      if (!entry.active) continue;
      peers.push({
        sessionId: entry.sessionId,
        actorId: entry.actorId,
        actorKind: entry.actorKind,
        clientHint: entry.clientHint,
        realmPath: entry.realmPath,
        focus: entry.focus,
        note: entry.note,
        activity: entry.activity,
        lastSeenAt: entry.lastSeenAt,
        ageSeconds: entry.ageSeconds,
        heartbeat: entry.heartbeat,
        online: entry.online,
      });
      if (peers.length >= limit) break;
    }
    return peers;
  }

  /**
   * Idempotently removes ONLY the caller's own session entry (`DELETE /v1/pulse`).
   * Returns identical result whether the session existed or not (zero existence oracle).
   */
  removeForPrincipal(params: {
    principal: Principal;
    sessionId?: string | null;
  }): { ok: true } {
    const normalizedTag = normalizeSessionTagStrict(params.sessionId);
    const { compositeKey } = this.buildKey(params.principal, normalizedTag);
    this.entries.delete(compositeKey);
    return { ok: true };
  }

  /** @deprecated Internal cleanup helper; use `removeForPrincipal` for authenticated callers */
  remove(compositeKey: string): void {
    this.entries.delete(compositeKey);
  }
}
