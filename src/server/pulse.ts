import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveVisibleRealm } from "../engine/objects.js";
import { sanitizeRealmsForScope } from "../engine/visibility.js";
import { resolveAccess, resolveAccessScope } from "../policy.js";
import type { DbPort } from "../ports.js";
import {
  MindError,
  type ActivePeerSummary,
  type Principal,
  type PulseEventKind,
  type PulseMode,
  type PulseSessionState,
  type PulseSource,
} from "../types.js";
import {
  describeTargetKey,
  extractDeterministicKeysFromText,
  MAX_TARGET_KEYS,
  normalizeTargetKeys,
  type PulseTargetKind,
} from "./pulse-keys.js";

export interface PulseEntry {
  sessionId: string;
  /** Optional sanitized explicit session tag for host routing (e.g. orchestrator peer routing); omitted when default */
  sessionTag: string | null;
  /** Same-principal parent external sessionId, when spawned as a sub-session */
  parentSessionId: string | null;
  /** Root session ID of the collaborator tree (same root = collaborator, distinct root = potential collision) */
  rootSessionId: string;
  orgId: string;
  realmId: string;
  realmPath: string;
  actorId: string;
  actorKind: "human" | "agent" | "system";
  /** Self-reported client label (e.g. "claude-code", "codex"); never trusted for auth or actorKind */
  clientHint: string | null;
  focus: string[];
  /** Deterministic normalized work/target keys (`work:linear:ENG-42`, `service:auth`, `branch:repo@fix/x`, `file:a.ts`) */
  keys: string[];
  note: string | null;
  /** Server-observed latest safe action in this realm (never populated from confidential/secret entries or read-only realms) */
  activity: string | null;
  mode: PulseMode;
  state: PulseSessionState;
  source: PulseSource;
  turnEndedAt: string | null;
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

export interface PulseOverlap {
  sessionId: string;
  sessionTag: string | null;
  parentSessionId: string | null;
  rootSessionId: string;
  actorId: string;
  actorKind: "human" | "agent" | "system";
  clientHint: string | null;
  realmPath: string;
  keys: string[];
  matchedKeys: string[];
  matchKind: "key" | "realm";
  mode: PulseMode;
  state: PulseSessionState;
  source: PulseSource;
  activity: string | null;
  note: string | null;
  lastSeenAt: string;
  ageSeconds: number;
  online: boolean;
}

export interface PulseDeclareResult extends PulseEntry {
  /** Overlapping visible peers (excluding self and same-root collaborators), exact key matches ranked first */
  overlaps: PulseOverlap[];
  /** Number of visible active/working peers in the same scope carrying zero deterministic keys (blind-spot indicator) */
  unkeyedPeers: number;
}

export interface InFlightWorkGroup {
  key: string;
  kind: PulseTargetKind;
  label: string;
  realms: string[];
  participants: PulseEntry[];
  /** Distinct rootSessionId count currently in working/active/turn_ended state */
  rootCount: number;
  /** Distinct rootSessionId count actively working (`mode === "working"` and not quiet) */
  workingRoots: number;
  /** True when >= 2 distinct root session trees are concurrently working on the same deterministic key */
  hasCollision: boolean;
  latestSeenAt: string;
}

export interface PulseListResult {
  now: string;
  pulses: PulseEntry[];
  /** Work-first reverse index grouped by deterministic target key (disappears when no session holds it) */
  inFlight: InFlightWorkGroup[];
  /** Visible sessions with zero deterministic keys (powers WebUI "Unkeyed" bucket & blind-spot gauge) */
  unkeyedCount: number;
  /** Populated when `?match=` or `?realm=` pre-dispatch filter is supplied */
  overlaps?: PulseOverlap[];
  unkeyedPeers?: number;
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
export const SILENT_WINDOW_MS = 5 * 60_000;
export const ACTIVE_PEER_WINDOW_MS = 15 * 60_000;
export const STALE_EVICT_MS = 45 * 60_000;
export const TURN_ENDED_EVICT_MS = 24 * 60 * 60_000;

const CLIENT_HINT_RE = /^[a-zA-Z0-9._-]{1,32}$/;
const SAFE_EXPOSED_TAG_RE = /^[a-zA-Z0-9._:@/-]{1,64}$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const CREDENTIAL_LIKE_RE =
  /(?:mm_live_|tok_[a-z0-9]{8,}|sk-[a-z0-9]{10,}|ghp_[a-z0-9]{10,}|github_pat_[a-z0-9_]{10,}|AKIA[0-9A-Z]{12,}|xox[bpas]-[a-z0-9-]+|Bearer\s+[a-z0-9._-]{10,}|-----BEGIN\s+[A-Z ]+KEY-----)/i;

type TurnPhase = "none" | "in_turn" | "turn_ended";

interface StoredPulse {
  compositeKey: string;
  principalNamespace: string;
  sessionTag: string;
  parentSessionTag: string | null;
  externalSessionId: string;
  orgId: string;
  realmId: string;
  actorId: string;
  actorKind: "human" | "agent" | "system";
  clientHint: string | null;
  focus: string[];
  keys: string[];
  note: string | null;
  activity: string | null;
  mode: PulseMode;
  source: PulseSource;
  turnPhase: TurnPhase;
  turnEndedMs: number | null;
  heartbeat: boolean;
  lastSeenMs: number;
}

interface SnapshotPayload {
  version: 1;
  savedAt: string;
  entries: Array<Omit<StoredPulse, "externalSessionId">>;
}

export function sanitizeClientHint(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_CLIENT_HINT_CHARS) return null;
  return CLIENT_HINT_RE.test(trimmed) ? trimmed.toLowerCase() : null;
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

function sanitizeExposedSessionTag(tag: string): string | null {
  if (!tag || tag === "default") return null;
  if (CREDENTIAL_LIKE_RE.test(tag)) return null;
  if (!SAFE_EXPOSED_TAG_RE.test(tag)) return null;
  return tag;
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

function normalizeOptionalParentTag(raw?: string | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_SESSION_TAG_CHARS || CONTROL_CHARS_RE.test(trimmed)) {
    throw new MindError(
      "INVALID_INPUT",
      `Pulse parentSessionId must be <= ${MAX_SESSION_TAG_CHARS} printable characters`,
    );
  }
  return trimmed;
}

function normalizePulseMode(raw?: string | null): PulseMode | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "observing" || raw === "working") return raw;
  throw new MindError(
    "INVALID_INPUT",
    `Invalid pulse mode "${raw}" (expected "observing" or "working")`,
  );
}

function normalizePulseSource(raw?: string | null): PulseSource | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "observed" || raw === "hook" || raw === "host" || raw === "declared") {
    return raw;
  }
  throw new MindError(
    "INVALID_INPUT",
    `Invalid pulse source "${raw}" (expected "observed", "hook", "host", or "declared")`,
  );
}

function normalizePulseEvent(raw?: string | null): PulseEventKind | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (
    raw === "turn_start" ||
    raw === "heartbeat" ||
    raw === "turn_end" ||
    raw === "session_end"
  ) {
    return raw;
  }
  throw new MindError(
    "INVALID_INPUT",
    `Invalid pulse event "${raw}" (expected "turn_start", "heartbeat", "turn_end", or "session_end")`,
  );
}

function buildPrincipalNamespace(principal: Principal): string {
  // Include BOTH tokenId AND authKind because browser Cookie sessions reuse the minting Bearer tokenId
  return `${principal.orgId}\0${principal.actor.id}\0${principal.tokenId ?? "none"}\0${principal.authKind}`;
}

function mergeDeterministicKeys(
  base: ReadonlyArray<string>,
  incoming: ReadonlyArray<string>,
): string[] {
  const out = new Set<string>();
  for (const k of incoming) {
    if (out.size >= MAX_TARGET_KEYS) break;
    out.add(k);
  }
  for (const k of base) {
    if (out.size >= MAX_TARGET_KEYS) break;
    out.add(k);
  }
  return Array.from(out);
}

/**
 * Work-indexed MindPulse v3 engine (RAM-first + disposable shutdown snapshot):
 * - Stores session liveness in memory (zero runtime SQLite writes, zero background timers, DO hibernation safe)
 * - Projects "in-flight work" as a reverse index over deterministic normalized target keys (never a task table!)
 * - Single-threaded handshake (`declare`) writes then computes `overlaps` + `unkeyedPeers` strictly over `listVisible`
 * - Enforces same-principal parent-child collaborator grouping (zero cross-principal parent spoofing)
 * - Presence & keys strictly obey write-permission invariant (zero `tree`-mode cross-branch covert channel / oracle)
 * - Write paths NEVER read MindPulse (Invariant #2: zero lock/deadlock semantics)
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

  private isExpired(entry: StoredPulse, nowMs: number): boolean {
    const ttl =
      entry.turnPhase === "turn_ended" ? TURN_ENDED_EVICT_MS : STALE_EVICT_MS;
    return nowMs - entry.lastSeenMs > ttl;
  }

  private prune(nowMs: number): void {
    for (const [key, entry] of this.entries.entries()) {
      if (this.isExpired(entry, nowMs)) {
        this.entries.delete(key);
      }
    }
  }

  private findSamePrincipalParent(stored: StoredPulse): StoredPulse | null {
    if (!stored.parentSessionTag) return null;
    for (const candidate of this.entries.values()) {
      if (candidate.principalNamespace !== stored.principalNamespace) continue;
      if (candidate.compositeKey === stored.compositeKey) continue;
      if (
        candidate.sessionTag === stored.parentSessionTag ||
        candidate.externalSessionId === stored.parentSessionTag
      ) {
        return candidate;
      }
    }
    return null;
  }

  private resolveTreeLinks(stored: StoredPulse): {
    parentSessionId: string | null;
    rootSessionId: string;
  } {
    const directParent = this.findSamePrincipalParent(stored);
    if (!directParent) {
      return {
        parentSessionId: null,
        rootSessionId: stored.externalSessionId,
      };
    }
    const visited = new Set<string>([stored.compositeKey]);
    let cur: StoredPulse = directParent;
    let depth = 0;
    while (depth < 8) {
      visited.add(cur.compositeKey);
      const next = this.findSamePrincipalParent(cur);
      if (!next || visited.has(next.compositeKey)) {
        break;
      }
      cur = next;
      depth += 1;
    }
    return {
      parentSessionId: directParent.externalSessionId,
      rootSessionId: cur.externalSessionId,
    };
  }

  private computeSessionState(
    stored: StoredPulse,
    ageMs: number,
  ): PulseSessionState {
    if (stored.turnPhase === "turn_ended") {
      return "turn_ended";
    }
    if (stored.turnPhase === "in_turn") {
      return ageMs <= SILENT_WINDOW_MS ? "working" : "silent";
    }
    if (stored.heartbeat && stored.mode === "working" && ageMs <= SILENT_WINDOW_MS) {
      return "working";
    }
    return ageMs <= ACTIVE_PEER_WINDOW_MS ? "active" : "quiet";
  }

  private enforceCapacity(principalNamespace: string, incomingKey: string): void {
    if (this.entries.has(incomingKey)) return;

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
    const { parentSessionId, rootSessionId } = this.resolveTreeLinks(stored);
    const state = this.computeSessionState(stored, ageMs);
    const online =
      stored.heartbeat &&
      stored.turnPhase !== "turn_ended" &&
      ageMs <= ONLINE_WINDOW_MS;
    const active =
      state === "working" ||
      state === "active" ||
      state === "silent" ||
      (state === "turn_ended" && ageMs <= TURN_ENDED_EVICT_MS);

    return {
      sessionId: stored.externalSessionId,
      sessionTag: sanitizeExposedSessionTag(stored.sessionTag),
      parentSessionId,
      rootSessionId,
      orgId: stored.orgId,
      realmId: stored.realmId,
      realmPath,
      actorId: stored.actorId,
      actorKind: stored.actorKind,
      clientHint: stored.clientHint,
      focus: [...stored.focus],
      keys: [...stored.keys],
      note: stored.note,
      activity: stored.activity,
      mode: stored.mode,
      state,
      source: stored.source,
      turnEndedAt:
        stored.turnEndedMs !== null
          ? new Date(stored.turnEndedMs).toISOString()
          : null,
      lastSeenAt: new Date(stored.lastSeenMs).toISOString(),
      ageSeconds: Math.floor(ageMs / 1000),
      heartbeat: stored.heartbeat,
      online,
      active,
    };
  }

  private buildInFlightIndex(pulses: ReadonlyArray<PulseEntry>): {
    inFlight: InFlightWorkGroup[];
    unkeyedCount: number;
  } {
    const byKey = new Map<string, PulseEntry[]>();
    let unkeyedCount = 0;

    for (const p of pulses) {
      if (!p.keys || p.keys.length === 0) {
        unkeyedCount += 1;
        continue;
      }
      for (const key of p.keys) {
        let arr = byKey.get(key);
        if (!arr) {
          arr = [];
          byKey.set(key, arr);
        }
        arr.push(p);
      }
    }

    const groups: InFlightWorkGroup[] = [];
    for (const [key, participants] of byKey.entries()) {
      const { kind, label } = describeTargetKey(key);
      const realms = Array.from(new Set(participants.map((p) => p.realmPath)));
      const roots = new Set<string>();
      const workingRoots = new Set<string>();
      let latestSeenAt = "";
      for (const p of participants) {
        roots.add(p.rootSessionId);
        if (p.mode === "working" && p.state !== "quiet") {
          workingRoots.add(p.rootSessionId);
        }
        if (p.lastSeenAt > latestSeenAt) {
          latestSeenAt = p.lastSeenAt;
        }
      }
      groups.push({
        key,
        kind,
        label,
        realms,
        participants,
        rootCount: roots.size,
        workingRoots: workingRoots.size,
        hasCollision: workingRoots.size >= 2,
        latestSeenAt,
      });
    }

    groups.sort((a, b) => {
      if (a.hasCollision !== b.hasCollision) return a.hasCollision ? -1 : 1;
      if (a.workingRoots !== b.workingRoots) return b.workingRoots - a.workingRoots;
      return b.latestSeenAt.localeCompare(a.latestSeenAt);
    });

    return { inFlight: groups, unkeyedCount };
  }

  private computeOverlaps(params: {
    visible: ReadonlyArray<PulseEntry>;
    matchKeys: ReadonlyArray<string>;
    realmId?: string | null;
    excludeRootSessionId?: string | null;
    excludeSessionId?: string | null;
    modeFilter?: PulseMode;
    limit?: number;
  }): { overlaps: PulseOverlap[]; unkeyedPeers: number } {
    const keySet = new Set(params.matchKeys);
    const limit = Math.max(1, Math.min(params.limit ?? 8, 25));
    const matched: PulseOverlap[] = [];
    let unkeyedPeers = 0;

    for (const entry of params.visible) {
      if (params.excludeSessionId && entry.sessionId === params.excludeSessionId) {
        continue;
      }
      if (
        params.excludeRootSessionId &&
        entry.rootSessionId === params.excludeRootSessionId
      ) {
        continue;
      }
      if (!entry.active) continue;
      if (params.modeFilter && entry.mode !== params.modeFilter) continue;

      const sameRealm = Boolean(params.realmId && entry.realmId === params.realmId);
      if (entry.keys.length === 0) {
        if (!params.realmId || sameRealm) {
          unkeyedPeers += 1;
        }
      }

      const matchedKeys =
        keySet.size > 0 ? entry.keys.filter((k) => keySet.has(k)) : [];

      let matchKind: "key" | "realm" | null = null;
      if (matchedKeys.length > 0) {
        matchKind = "key";
      } else if (
        sameRealm &&
        (entry.mode === "working" || entry.state === "working" || entry.state === "turn_ended")
      ) {
        matchKind = "realm";
      }

      if (!matchKind) continue;
      matched.push({
        sessionId: entry.sessionId,
        sessionTag: entry.sessionTag,
        parentSessionId: entry.parentSessionId,
        rootSessionId: entry.rootSessionId,
        actorId: entry.actorId,
        actorKind: entry.actorKind,
        clientHint: entry.clientHint,
        realmPath: entry.realmPath,
        keys: entry.keys,
        matchedKeys,
        matchKind,
        mode: entry.mode,
        state: entry.state,
        source: entry.source,
        activity: entry.activity,
        note: entry.note,
        lastSeenAt: entry.lastSeenAt,
        ageSeconds: entry.ageSeconds,
        online: entry.online,
      });
    }

    matched.sort((a, b) => {
      if (a.matchKind !== b.matchKind) return a.matchKind === "key" ? -1 : 1;
      if (a.matchedKeys.length !== b.matchedKeys.length) {
        return b.matchedKeys.length - a.matchedKeys.length;
      }
      const aWorking = a.mode === "working" ? 1 : 0;
      const bWorking = b.mode === "working" ? 1 : 0;
      if (aWorking !== bWorking) return bWorking - aWorking;
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    });

    return { overlaps: matched.slice(0, limit), unkeyedPeers };
  }

  /**
   * Explicit handshake / heartbeat (`POST /v1/pulse`).
   * Writes caller session first, then immediately computes visible `overlaps` + `unkeyedPeers`
   * in the same single-threaded handler (guaranteeing linearizable overlap detection with zero locks).
   */
  declare(params: {
    db: DbPort;
    principal: Principal;
    sessionId?: string;
    parentSessionId?: string | null;
    realmRef?: string;
    focus?: string[];
    keys?: string[];
    note?: string | null;
    clientHint?: string | null;
    mode?: PulseMode | string;
    source?: PulseSource | string;
    event?: PulseEventKind | string;
    nowMs?: number;
  }): PulseDeclareResult {
    const nowMs = params.nowMs ?? Date.now();
    this.prune(nowMs);

    const normalizedTag = normalizeSessionTagStrict(params.sessionId);
    const parentSessionTag = normalizeOptionalParentTag(params.parentSessionId);
    const reqMode = normalizePulseMode(params.mode);
    const reqSource = normalizePulseSource(params.source);
    const reqEvent = normalizePulseEvent(params.event);

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

    const keysRaw = params.keys ?? [];
    if (!Array.isArray(keysRaw) || keysRaw.length > MAX_TARGET_KEYS * 2) {
      throw new MindError(
        "INVALID_INPUT",
        `Pulse keys accepts at most ${MAX_TARGET_KEYS * 2} candidate items`,
      );
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
    const sameRealm = existing?.realmId === targetRealm.id;

    // Extract deterministic keys from explicit keys, focus, and note (e.g. `meru-mind@fix/eng-42`)
    const extractedFromNote = noteRaw ? extractDeterministicKeysFromText(noteRaw) : [];
    const candidateKeys = [
      ...keysRaw.map((k) => String(k ?? "")),
      ...focus,
      ...(noteRaw ? [noteRaw.split(" · ")[0] ?? ""] : []),
      ...extractedFromNote,
    ];
    const incomingKeys = normalizeTargetKeys(candidateKeys);
    const nextKeys =
      reqEvent === "turn_start"
        ? incomingKeys
        : sameRealm && existing
          ? mergeDeterministicKeys(existing.keys, incomingKeys)
          : incomingKeys;

    // Derive monotonic turn state & mode
    let nextTurnPhase: TurnPhase = existing?.turnPhase ?? "none";
    let nextTurnEndedMs: number | null = existing?.turnEndedMs ?? null;
    if (reqEvent === "turn_start") {
      nextTurnPhase = "in_turn";
      nextTurnEndedMs = null;
    } else if (reqEvent === "turn_end") {
      nextTurnPhase = "turn_ended";
      nextTurnEndedMs = nowMs;
    } else if (reqEvent === "heartbeat") {
      if (nextTurnPhase !== "in_turn") {
        nextTurnPhase = "in_turn";
      }
      nextTurnEndedMs = null;
    }

    let nextMode: PulseMode;
    if (reqEvent === "turn_start") {
      nextMode = reqMode ?? "observing";
    } else if (reqEvent === "turn_end") {
      nextMode = reqMode ?? existing?.mode ?? "working";
    } else if (reqMode === "working") {
      nextMode = "working";
    } else if (existing?.mode === "working" && sameRealm && reqMode !== "observing") {
      // Monotonic during an active turn: heartbeats never downgrade `working` back to `observing`
      nextMode = "working";
    } else {
      nextMode = reqMode ?? (existing && sameRealm ? existing.mode : "observing");
    }

    const nextSource: PulseSource =
      reqSource ??
      (reqEvent ? "hook" : existing?.source && existing.source !== "observed" ? existing.source : "declared");

    this.enforceCapacity(principalNamespace, compositeKey);

    const clientHint =
      params.clientHint !== undefined
        ? sanitizeClientHint(params.clientHint)
        : (existing?.clientHint ?? null);

    const nextNote =
      params.note !== undefined ? (noteRaw || null) : (sameRealm ? (existing?.note ?? null) : null);

    const stored: StoredPulse = {
      compositeKey,
      principalNamespace,
      sessionTag: normalizedTag,
      parentSessionTag:
        params.parentSessionId !== undefined
          ? parentSessionTag
          : (existing?.parentSessionTag ?? null),
      externalSessionId,
      orgId: org.id,
      realmId: targetRealm.id,
      actorId: params.principal.actor.id,
      actorKind: params.principal.actor.kind,
      clientHint,
      focus: params.focus !== undefined ? focus : (sameRealm && existing ? [...existing.focus] : []),
      keys: nextKeys,
      note: nextNote,
      activity: sameRealm && existing ? existing.activity : null,
      mode: nextMode,
      source: nextSource,
      turnPhase: nextTurnPhase,
      turnEndedMs: nextTurnEndedMs,
      heartbeat: true,
      lastSeenMs: nowMs,
    };
    this.entries.set(compositeKey, stored);

    const sanitizedMap = sanitizeRealmsForScope(realms, scope);
    const sanitizedPath = sanitizedMap.get(targetRealm.id)?.path ?? targetRealm.path;
    const selfEntry = this.toPublicEntry(stored, sanitizedPath, nowMs);

    // Compute visible overlaps strictly inside `listVisible` (zero tree-mode cross-branch oracle)
    const visible = this.listVisible({
      db: params.db,
      principal: params.principal,
      nowMs,
    });
    const { overlaps, unkeyedPeers } = this.computeOverlaps({
      visible,
      matchKeys: selfEntry.keys,
      realmId: stored.realmId,
      excludeSessionId: selfEntry.sessionId,
      excludeRootSessionId: selfEntry.rootSessionId,
    });

    return {
      ...selfEntry,
      overlaps,
      unkeyedPeers,
    };
  }

  /**
   * Passive server-side activity observation invoked STRICTLY AFTER successful MindSurface calls.
   * Never throws into caller flows; enforces write-permission invariant so reading a shared ancestor
   * or @mounted realm in `tree` mode NEVER publishes presence, keys, or activity to siblings.
   */
  observe(params: {
    db: DbPort;
    principal: Principal;
    sessionTag?: string | null;
    parentSessionTag?: string | null;
    clientHint?: string | null;
    realmId?: string | null;
    realmRef?: string | null;
    activity?: string | null;
    keys?: string[];
    mode?: PulseMode;
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

    const sameRealm = existing?.realmId === nextRealmId;

    // Security invariant: NEVER attach activity or keys observed from a read-only / @mounted realm
    const safeActivity = targetWritable
      ? sanitizeObservedActivity(params.activity)
      : null;
    const nextActivity =
      safeActivity ?? (sameRealm && existing ? existing.activity : null);

    const safeIncomingKeys =
      targetWritable && params.keys?.length ? normalizeTargetKeys(params.keys) : [];
    const nextKeys =
      sameRealm && existing
        ? mergeDeterministicKeys(existing.keys, safeIncomingKeys)
        : safeIncomingKeys;

    const nextMode: PulseMode =
      targetWritable && params.mode === "working"
        ? "working"
        : sameRealm && existing
          ? existing.mode
          : "observing";

    const nextParentTag =
      params.parentSessionTag?.trim()
        ? normalizeSessionTagSafe(params.parentSessionTag)
        : (existing?.parentSessionTag ?? null);

    this.enforceCapacity(principalNamespace, compositeKey);

    const sanitizedHint = sanitizeClientHint(params.clientHint);
    const stored: StoredPulse = {
      compositeKey,
      principalNamespace,
      sessionTag: normalizedTag,
      parentSessionTag: nextParentTag,
      externalSessionId,
      orgId: org.id,
      realmId: nextRealmId,
      actorId: params.principal.actor.id,
      actorKind: params.principal.actor.kind,
      clientHint: sanitizedHint ?? existing?.clientHint ?? null,
      focus: existing ? [...existing.focus] : [],
      keys: nextKeys,
      note: existing ? existing.note : null,
      activity: nextActivity,
      mode: nextMode,
      source: existing?.source ?? "observed",
      turnPhase:
        existing?.turnPhase === "turn_ended" ? "in_turn" : (existing?.turnPhase ?? "none"),
      turnEndedMs: null,
      heartbeat: existing?.heartbeat ?? false,
      lastSeenMs: nowMs,
    };
    this.entries.set(compositeKey, stored);
  }

  /**
   * Lists visible pulses strictly filtered by `policy.ts` and sanitized via `sanitizeRealmsForScope`
   * so hidden ancestor paths under `@mounted/<alias>` are NEVER exposed.
   * Also projects the work-first `inFlight` reverse index and optional `?match=` pre-dispatch overlaps.
   */
  listVisibleWithNow(params: {
    db: DbPort;
    principal: Principal;
    matchKeys?: string[];
    realmRef?: string;
    modeFilter?: PulseMode;
    excludeSessionTag?: string | null;
    nowMs?: number;
  }): PulseListResult {
    const nowMs = params.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    this.prune(nowMs);

    const org = params.db.getOrg(params.principal.orgId);
    if (!org) {
      return { now: nowIso, pulses: [], inFlight: [], unkeyedCount: 0 };
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
    const sanitizedMap = sanitizeRealmsForScope(realms, scope);

    const out: PulseEntry[] = [];
    for (const stored of this.entries.values()) {
      if (stored.orgId !== org.id) continue;
      const sanitizedRealm = sanitizedMap.get(stored.realmId);
      if (!sanitizedRealm) continue;
      out.push(this.toPublicEntry(stored, sanitizedRealm.path, nowMs));
    }
    out.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));

    const { inFlight, unkeyedCount } = this.buildInFlightIndex(out);

    const hasFilter = Boolean(
      (params.matchKeys && params.matchKeys.length > 0) ||
        params.realmRef?.trim() ||
        params.modeFilter,
    );
    if (!hasFilter) {
      return { now: nowIso, pulses: out, inFlight, unkeyedCount };
    }

    let filterRealmId: string | null = null;
    if (params.realmRef?.trim()) {
      try {
        const resolved = resolveVisibleRealm({
          realms,
          orgId: org.id,
          ref: params.realmRef.trim(),
          scope,
        });
        filterRealmId = resolved.id;
      } catch {
        // Unresolvable or invisible realm returns empty overlaps (zero existence oracle)
        return {
          now: nowIso,
          pulses: out,
          inFlight,
          unkeyedCount,
          overlaps: [],
          unkeyedPeers: 0,
        };
      }
    }

    let excludeSessionId: string | null = null;
    let excludeRootSessionId: string | null = null;
    if (params.excludeSessionTag) {
      const selfTag = normalizeSessionTagSafe(params.excludeSessionTag);
      const { compositeKey, externalSessionId } = this.buildKey(
        params.principal,
        selfTag,
      );
      excludeSessionId = externalSessionId;
      const selfStored = this.entries.get(compositeKey);
      excludeRootSessionId = selfStored
        ? this.resolveTreeLinks(selfStored).rootSessionId
        : externalSessionId;
    }

    const normalizedMatchKeys = params.matchKeys?.length
      ? normalizeTargetKeys(params.matchKeys)
      : [];
    const { overlaps, unkeyedPeers } = this.computeOverlaps({
      visible: out,
      matchKeys: normalizedMatchKeys,
      realmId: filterRealmId,
      excludeSessionId,
      excludeRootSessionId,
      modeFilter: params.modeFilter,
    });

    return {
      now: nowIso,
      pulses: out,
      inFlight,
      unkeyedCount,
      overlaps,
      unkeyedPeers,
    };
  }

  listVisible(params: {
    db: DbPort;
    principal: Principal;
    nowMs?: number;
  }): PulseEntry[] {
    return this.listVisibleWithNow(params).pulses;
  }

  private toActivePeerSummary(
    entry: PulseEntry,
    matchedKeys?: string[],
  ): ActivePeerSummary {
    return {
      sessionId: entry.sessionId,
      sessionTag: entry.sessionTag,
      parentSessionId: entry.parentSessionId,
      rootSessionId: entry.rootSessionId,
      actorId: entry.actorId,
      actorKind: entry.actorKind,
      clientHint: entry.clientHint,
      realmPath: entry.realmPath,
      focus: entry.focus,
      keys: entry.keys,
      ...(matchedKeys && matchedKeys.length > 0 ? { matchedKeys } : {}),
      note: entry.note,
      activity: entry.activity,
      mode: entry.mode,
      state: entry.state,
      source: entry.source,
      lastSeenAt: entry.lastSeenAt,
      ageSeconds: entry.ageSeconds,
      heartbeat: entry.heartbeat,
      online: entry.online,
    };
  }

  /**
   * Lists up to `limit` other active peers in the same realm,
   * strictly scoped via `listVisible` and excluding self & same-root collaborators.
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
    const { compositeKey, externalSessionId: selfExternalId } = this.buildKey(
      params.principal,
      selfTag,
    );
    const selfStored = this.entries.get(compositeKey);
    const selfRootId = selfStored
      ? this.resolveTreeLinks(selfStored).rootSessionId
      : selfExternalId;

    const visible = this.listVisible({
      db: params.db,
      principal: params.principal,
      nowMs,
    });

    const peers: ActivePeerSummary[] = [];
    for (const entry of visible) {
      if (entry.realmId !== params.realmId) continue;
      if (entry.sessionId === selfExternalId) continue;
      if (entry.rootSessionId === selfRootId) continue;
      if (!entry.active) continue;
      peers.push(this.toActivePeerSummary(entry));
      if (peers.length >= limit) break;
    }
    return peers;
  }

  /**
   * Lists active peers matching a specific deterministic target key (e.g. `show service:auth`),
   * strictly filtered inside `listVisible` so `tree`-mode siblings NEVER leak.
   */
  listActivePeersForTarget(params: {
    db: DbPort;
    principal: Principal;
    targetKey: string;
    excludeSessionTag?: string | null;
    nowMs?: number;
    limit?: number;
  }): ActivePeerSummary[] {
    const normalizedKeys = normalizeTargetKeys([params.targetKey]);
    if (normalizedKeys.length === 0) return [];
    const keySet = new Set(normalizedKeys);
    const nowMs = params.nowMs ?? Date.now();
    const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
    const selfTag = normalizeSessionTagSafe(params.excludeSessionTag);
    const { compositeKey, externalSessionId: selfExternalId } = this.buildKey(
      params.principal,
      selfTag,
    );
    const selfStored = this.entries.get(compositeKey);
    const selfRootId = selfStored
      ? this.resolveTreeLinks(selfStored).rootSessionId
      : selfExternalId;

    const visible = this.listVisible({
      db: params.db,
      principal: params.principal,
      nowMs,
    });

    const peers: ActivePeerSummary[] = [];
    for (const entry of visible) {
      if (entry.sessionId === selfExternalId) continue;
      if (entry.rootSessionId === selfRootId) continue;
      if (!entry.active) continue;
      const matched = entry.keys.filter((k) => keySet.has(k));
      if (matched.length === 0) continue;
      peers.push(this.toActivePeerSummary(entry, matched));
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

  /**
   * Writes a disposable shutdown snapshot so `turn_ended` sessions survive clean server restarts
   * without adding SQLite tables or runtime DB writes. Deleting this file loses zero durable records.
   */
  saveSnapshot(filePath: string, nowMs = Date.now()): void {
    this.prune(nowMs);
    const entries = Array.from(this.entries.values()).map(
      ({ externalSessionId: _omit, ...rest }) => rest,
    );
    const payload: SnapshotPayload = {
      version: 1,
      savedAt: new Date(nowMs).toISOString(),
      entries,
    };
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Reloads non-expired sessions from a previous clean shutdown snapshot.
   * Silently ignores missing or corrupt files (disposable telemetry only).
   */
  loadSnapshot(filePath: string, nowMs = Date.now()): number {
    try {
      if (!fs.existsSync(filePath)) return 0;
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SnapshotPayload>;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return 0;
      let loaded = 0;
      for (const item of parsed.entries) {
        if (
          !item ||
          typeof item.compositeKey !== "string" ||
          typeof item.principalNamespace !== "string" ||
          typeof item.orgId !== "string" ||
          typeof item.realmId !== "string" ||
          typeof item.lastSeenMs !== "number"
        ) {
          continue;
        }
        const restored: StoredPulse = {
          compositeKey: item.compositeKey,
          principalNamespace: item.principalNamespace,
          sessionTag: typeof item.sessionTag === "string" ? item.sessionTag : "default",
          parentSessionTag:
            typeof item.parentSessionTag === "string" ? item.parentSessionTag : null,
          externalSessionId: this.toExternalSessionId(item.compositeKey),
          orgId: item.orgId,
          realmId: item.realmId,
          actorId: typeof item.actorId === "string" ? item.actorId : "unknown",
          actorKind:
            item.actorKind === "human" ||
            item.actorKind === "agent" ||
            item.actorKind === "system"
              ? item.actorKind
              : "agent",
          clientHint: sanitizeClientHint(item.clientHint),
          focus: Array.isArray(item.focus)
            ? item.focus.filter((x): x is string => typeof x === "string").slice(0, MAX_FOCUS_REFS)
            : [],
          keys: Array.isArray(item.keys)
            ? normalizeTargetKeys(
                item.keys.filter((x): x is string => typeof x === "string"),
              )
            : [],
          note: typeof item.note === "string" ? item.note.slice(0, MAX_NOTE_CHARS) : null,
          activity: sanitizeObservedActivity(item.activity),
          mode: item.mode === "working" ? "working" : "observing",
          source:
            item.source === "observed" ||
            item.source === "hook" ||
            item.source === "host" ||
            item.source === "declared"
              ? item.source
              : "declared",
          turnPhase:
            item.turnPhase === "in_turn" || item.turnPhase === "turn_ended"
              ? item.turnPhase
              : "none",
          turnEndedMs: typeof item.turnEndedMs === "number" ? item.turnEndedMs : null,
          heartbeat: Boolean(item.heartbeat),
          lastSeenMs: item.lastSeenMs,
        };
        if (this.isExpired(restored, nowMs)) continue;
        this.enforceCapacity(restored.principalNamespace, restored.compositeKey);
        this.entries.set(restored.compositeKey, restored);
        loaded += 1;
      }
      return loaded;
    } catch {
      return 0;
    }
  }

  /** Test helper / diagnostics */
  size(): number {
    return this.entries.size;
  }
}
