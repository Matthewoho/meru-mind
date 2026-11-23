import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DbPort } from "../ports.js";
import { MindError, type Principal } from "../types.js";
import { isPrincipalTokenActive } from "./tokens.js";

export const UI_SESSION_COOKIE_NAME = "meru_session";
const LOGIN_CODE_TTL_MS = 60_000;
const COOKIE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface PendingLoginCode {
  code: string;
  principal: Principal;
  expiresAtMs: number;
}

interface ActiveCookieSession {
  sessionId: string;
  principal: Principal;
  expiresAtMs: number;
}

export function parseCookieHeader(
  header: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

/**
 * Manages 60-second single-use CLI login codes and weakened HttpOnly browser Cookie sessions.
 * - Long-lived tokens NEVER enter browser DOM inputs or URLs.
 * - Exchanged Cookie sessions ALWAYS carry `authKind: "cookie"`, enforcing read + reversible verbs only.
 */
export class UiSessionManager {
  private readonly pendingCodes = new Map<string, PendingLoginCode>();
  private readonly sessions = new Map<string, ActiveCookieSession>();

  private prune(nowMs: number): void {
    for (const [k, v] of this.pendingCodes.entries()) {
      if (v.expiresAtMs <= nowMs) this.pendingCodes.delete(k);
    }
    for (const [k, v] of this.sessions.entries()) {
      if (v.expiresAtMs <= nowMs) this.sessions.delete(k);
    }
  }

  /**
   * Mints a 60-second single-use CLI login code tied to an authenticated Bearer Principal.
   */
  mintLoginCode(
    principal: Principal,
    nowMs = Date.now(),
  ): { code: string; expiresAt: string } {
    this.prune(nowMs);
    if (principal.authKind === "cookie") {
      throw new MindError(
        "ACCESS_DENIED",
        "Browser Cookie sessions cannot mint new login codes; run 'meru-mind ui login' with a Bearer token.",
      );
    }
    const code = `mm_code_${crypto.randomBytes(18).toString("hex")}`;
    const expiresAtMs = nowMs + LOGIN_CODE_TTL_MS;
    this.pendingCodes.set(code, {
      code,
      principal: {
        ...principal,
        authKind: "cookie",
      },
      expiresAtMs,
    });
    return {
      code,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /**
   * Atomically consumes a single-use login code and returns a new HttpOnly session ID.
   */
  exchangeLoginCode(
    code: string,
    db: DbPort,
    nowMs = Date.now(),
  ): { sessionId: string; principal: Principal; maxAgeSeconds: number } {
    this.prune(nowMs);
    const trimmed = code.trim();
    const pending = this.pendingCodes.get(trimmed);
    // Always delete immediately (strict single-use!)
    this.pendingCodes.delete(trimmed);

    if (!pending || pending.expiresAtMs <= nowMs) {
      throw new MindError(
        "ACCESS_DENIED",
        "Login code is invalid, expired, or already used. Run 'meru-mind ui login' to generate a fresh code.",
      );
    }
    if (!isPrincipalTokenActive(db, pending.principal)) {
      throw new MindError(
        "ACCESS_DENIED",
        "Underlying token has been revoked",
      );
    }

    const sessionId = `msid_${crypto.randomBytes(24).toString("hex")}`;
    const expiresAtMs = nowMs + COOKIE_SESSION_TTL_MS;
    const cookiePrincipal: Principal = {
      ...pending.principal,
      authKind: "cookie",
    };
    this.sessions.set(sessionId, {
      sessionId,
      principal: cookiePrincipal,
      expiresAtMs,
    });
    return {
      sessionId,
      principal: cookiePrincipal,
      maxAgeSeconds: Math.floor(COOKIE_SESSION_TTL_MS / 1000),
    };
  }

  /**
   * Resolves a weakened Cookie Principal from an incoming HTTP/WS request.
   * Re-checks live token revocation in SQLite on every call.
   */
  authenticateRequest(
    req: IncomingMessage,
    db: DbPort,
    expectedOrgId: string,
    nowMs = Date.now(),
  ): Principal | null {
    this.prune(nowMs);
    const cookies = parseCookieHeader(req.headers.cookie);
    const sid = cookies[UI_SESSION_COOKIE_NAME];
    if (!sid) return null;
    const sess = this.sessions.get(sid);
    if (!sess || sess.expiresAtMs <= nowMs) {
      this.sessions.delete(sid);
      return null;
    }
    if (sess.principal.orgId !== expectedOrgId) {
      return null;
    }
    if (!isPrincipalTokenActive(db, sess.principal)) {
      this.sessions.delete(sid);
      return null;
    }
    return sess.principal;
  }

  revokeSessionFromRequest(req: IncomingMessage): void {
    const cookies = parseCookieHeader(req.headers.cookie);
    const sid = cookies[UI_SESSION_COOKIE_NAME];
    if (sid) {
      this.sessions.delete(sid);
    }
  }

  buildSetCookieHeader(
    sessionId: string,
    maxAgeSeconds: number,
    isSecure: boolean,
  ): string {
    const parts = [
      `${UI_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (isSecure) parts.push("Secure");
    return parts.join("; ");
  }

  buildClearCookieHeader(): string {
    return `${UI_SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
}
