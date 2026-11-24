import crypto from "node:crypto";
import type { DbPort } from "../ports.js";
import {
  MindError,
  type AuthTokenPublic,
  type AuthTokenRecord,
  type Principal,
} from "../types.js";

export const TOKEN_PREFIX = "mm_live_";
export const DEFAULT_SSO_TOKEN_TTL_DAYS = 90;
export const MAX_TOKEN_TTL_DAYS = 365;

function isIsoExpired(expiresAt: string | null, nowMs: number): boolean {
  if (expiresAt === null) return false;
  const parsed = Date.parse(expiresAt);
  // Fail-closed: corrupt/unparseable timestamps are treated as expired
  if (!Number.isFinite(parsed)) return true;
  return parsed <= nowMs;
}

function areAllActorIdentitiesDisabled(
  db: DbPort,
  orgId: string,
  actorId: string,
): boolean {
  const identities = db.listIdentitiesByActor(orgId, actorId);
  if (identities.length === 0) return false;
  return identities.every((id) => id.disabledAt !== null);
}

export function hashAuthToken(plaintextToken: string): string {
  return crypto.createHash("sha256").update(plaintextToken, "utf8").digest("hex");
}

export function generateAuthTokenPlaintext(): string {
  return `${TOKEN_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
}

export function toPublicToken(rec: AuthTokenRecord): AuthTokenPublic {
  return {
    id: rec.id,
    orgId: rec.orgId,
    actorId: rec.actorId,
    actorKind: rec.actorKind,
    actorFamily: rec.actorFamily,
    boundRealmId: rec.boundRealmId,
    label: rec.label,
    createdBy: rec.createdBy,
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    revokedAt: rec.revokedAt,
    lastUsedAt: rec.lastUsedAt,
  };
}

export interface CreateAuthTokenParams {
  db: DbPort;
  orgId: string;
  actorId: string;
  actorKind: "human" | "agent";
  actorFamily?: string | null;
  boundRealmId?: string | null;
  label?: string | null;
  createdBy: string;
  expiresAt?: string | null;
  ttlDays?: number | null;
}

export interface CreateAuthTokenResult {
  /** Plaintext token shown ONCE at creation; never stored in SQLite */
  token: string;
  record: AuthTokenPublic;
}

export function createAuthToken(
  params: CreateAuthTokenParams,
): CreateAuthTokenResult {
  const actorId = params.actorId.trim();
  if (!actorId) {
    throw new MindError("INVALID_INPUT", "Token actorId must not be empty");
  }
  if (params.actorKind !== "human" && params.actorKind !== "agent") {
    throw new MindError(
      "INVALID_INPUT",
      `Token actorKind must be "human" or "agent", got "${String(params.actorKind)}"`,
    );
  }
  const org = params.db.getOrg(params.orgId);
  if (!org) {
    throw new MindError("NOT_FOUND", `Organization not found: ${params.orgId}`);
  }
  let boundRealmId = params.boundRealmId?.trim() || null;
  if (boundRealmId) {
    const realm = boundRealmId.startsWith("/")
      ? params.db.getRealmByPath(params.orgId, boundRealmId)
      : params.db.getRealm(boundRealmId);
    if (!realm || realm.orgId !== params.orgId) {
      throw new MindError(
        "NOT_FOUND",
        `Bound realm "${boundRealmId}" not found in org "${params.orgId}"`,
      );
    }
    boundRealmId = realm.id;
  } else if (org.policy === "tree") {
    const root =
      params.db.getRealmByPath(params.orgId, "/") ??
      params.db.listRealms(params.orgId)[0];
    if (!root) {
      throw new MindError(
        "NOT_FOUND",
        `No realm found in organization "${params.orgId}"`,
      );
    }
    boundRealmId = root.id;
  }

  const plaintext = generateAuthTokenPlaintext();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  let expiresAt: string | null = params.expiresAt ?? null;
  if (!expiresAt && params.ttlDays !== undefined && params.ttlDays !== null) {
    if (typeof params.ttlDays !== "number" || !Number.isFinite(params.ttlDays) || params.ttlDays <= 0) {
      throw new MindError(
        "INVALID_INPUT",
        `Token ttlDays must be a positive number (1..${MAX_TOKEN_TTL_DAYS})`,
      );
    }
    const clampedDays = Math.min(params.ttlDays, MAX_TOKEN_TTL_DAYS);
    expiresAt = new Date(
      nowMs + clampedDays * 24 * 60 * 60 * 1000,
    ).toISOString();
  }
  const id = `tok_${crypto.randomBytes(8).toString("hex")}`;
  const fullRecord: AuthTokenRecord = {
    id,
    orgId: params.orgId,
    tokenHash: hashAuthToken(plaintext),
    actorId,
    actorKind: params.actorKind,
    actorFamily: params.actorFamily?.trim() || null,
    boundRealmId,
    label: params.label?.trim() || null,
    createdBy: params.createdBy,
    createdAt: now,
    expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  };
  params.db.insertToken(fullRecord);
  return {
    token: plaintext,
    record: toPublicToken(fullRecord),
  };
}

export const DEFAULT_TOKEN_TOUCH_THROTTLE_MS = 60_000;
const MAX_THROTTLE_ENTRIES = 2_000;

/**
 * In-memory throttle for `tokens.last_used_at` SQLite updates.
 * Prevents high-frequency heartbeats or MCP bursts from turning read-only traffic
 * into continuous SQLite writes (preserving WAL throughput & DO hibernation).
 */
export class TokenTouchThrottle {
  private readonly lastTouchedMs = new Map<string, number>();

  constructor(private readonly intervalMs = DEFAULT_TOKEN_TOUCH_THROTTLE_MS) {}

  shouldTouch(tokenId: string, nowMs = Date.now()): boolean {
    const prev = this.lastTouchedMs.get(tokenId);
    if (prev !== undefined && nowMs - prev < this.intervalMs) {
      return false;
    }
    if (this.lastTouchedMs.size >= MAX_THROTTLE_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestMs = Infinity;
      for (const [k, v] of this.lastTouchedMs.entries()) {
        if (v < oldestMs) {
          oldestMs = v;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) {
        this.lastTouchedMs.delete(oldestKey);
      }
    }
    this.lastTouchedMs.set(tokenId, nowMs);
    return true;
  }

  clear(): void {
    this.lastTouchedMs.clear();
  }
}

export function resolvePrincipalFromToken(params: {
  db: DbPort;
  plaintextToken: string;
  expectedOrgId: string;
  authKind?: "bearer" | "cookie";
  skipTouchLastUsed?: boolean;
  touchThrottle?: TokenTouchThrottle;
  nowMs?: number;
}): Principal {
  const raw = params.plaintextToken.trim();
  if (!raw) {
    throw new MindError("ACCESS_DENIED", "Missing authentication token");
  }
  const nowMs = params.nowMs ?? Date.now();
  const tokenRec = params.db.getTokenByHash(hashAuthToken(raw));
  if (
    !tokenRec ||
    tokenRec.revokedAt !== null ||
    tokenRec.orgId !== params.expectedOrgId
  ) {
    throw new MindError("ACCESS_DENIED", "Invalid or revoked token");
  }
  if (isIsoExpired(tokenRec.expiresAt, nowMs)) {
    throw new MindError(
      "ACCESS_DENIED",
      "Authentication token has expired. Run 'meru-mind login' to obtain a fresh token.",
      {
        try: "meru-mind login --url <server-url>",
      },
    );
  }
  if (
    params.db.isActorDisabled(tokenRec.orgId, tokenRec.actorId) ||
    areAllActorIdentitiesDisabled(params.db, tokenRec.orgId, tokenRec.actorId)
  ) {
    throw new MindError(
      "ACCESS_DENIED",
      "Actor account has been disabled by an administrator",
    );
  }

  const org = params.db.getOrg(tokenRec.orgId);
  if (!org) {
    throw new MindError("NOT_FOUND", `Organization not found: ${tokenRec.orgId}`);
  }

  let boundRealmId = tokenRec.boundRealmId;
  let boundSource = "token";
  if (!boundRealmId) {
    const root =
      params.db.getRealmByPath(org.id, "/") ?? params.db.listRealms(org.id)[0];
    if (!root) {
      throw new MindError("NOT_FOUND", `No realms in org ${org.id}`);
    }
    boundRealmId = root.id;
    boundSource = org.policy === "open" ? "open-default:/" : "token-root:/";
  }

  if (
    !params.skipTouchLastUsed &&
    (!params.touchThrottle || params.touchThrottle.shouldTouch(tokenRec.id, nowMs))
  ) {
    params.db.touchTokenLastUsed(tokenRec.id, new Date(nowMs).toISOString());
  }

  return {
    tokenId: tokenRec.id,
    orgId: tokenRec.orgId,
    actor: {
      id: tokenRec.actorId,
      kind: tokenRec.actorKind,
      ...(tokenRec.actorFamily ? { family: tokenRec.actorFamily } : {}),
    },
    boundRealmId,
    boundSource,
    authKind: params.authKind ?? "bearer",
  };
}

export function isPrincipalTokenActive(
  db: DbPort,
  principal: Principal,
  nowMs = Date.now(),
): boolean {
  if (
    db.isActorDisabled(principal.orgId, principal.actor.id) ||
    areAllActorIdentitiesDisabled(db, principal.orgId, principal.actor.id)
  ) {
    return false;
  }
  if (!principal.tokenId) return true;
  const rec = db.getToken(principal.tokenId);
  if (!rec || rec.revokedAt !== null || rec.orgId !== principal.orgId) {
    return false;
  }
  if (isIsoExpired(rec.expiresAt, nowMs)) {
    return false;
  }
  return true;
}
