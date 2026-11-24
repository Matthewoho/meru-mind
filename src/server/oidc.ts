import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as oauth from "oauth4webapi";
import type { DbPort } from "../ports.js";
import {
  MindError,
  type InvitePublic,
  type InviteRecord,
  type OidcConfig,
  type OidcIdentityRecord,
  type Principal,
} from "../types.js";
import {
  createAuthToken,
  DEFAULT_SSO_TOKEN_TTL_DAYS,
  hashAuthToken,
  MAX_TOKEN_TTL_DAYS,
} from "./tokens.js";
import { parseCookieHeader, type UiSessionManager } from "./ui-auth.js";
import { isLoopbackHost } from "./ui-router.js";
import { isOriginAllowed } from "./ws-pump.js";

export const OIDC_TX_COOKIE_PREFIX = "meru_oidc_tx_";
export const OIDC_HOST_TX_COOKIE_PREFIX = "__Host-meru_oidc_tx_";
export const DEVICE_TX_COOKIE_NAME = "meru_device_tx";
export const DEVICE_HOST_TX_COOKIE_NAME = "__Host-meru_device_tx";
export const INVITE_TX_COOKIE_NAME = "meru_invite_tx";
export const INVITE_HOST_TX_COOKIE_NAME = "__Host-meru_invite_tx";
export const INVITE_CODE_PREFIX = "mm_inv_";

const OIDC_TX_TTL_MS = 10 * 60 * 1000;
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const DEVICE_AUTH_TX_TTL_MS = 5 * 60 * 1000;
const INVITE_CONFIRM_TX_TTL_MS = 5 * 60 * 1000;
const DEVICE_MAX_AUTH_AGE_SECONDS = 90;
const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;
const IDP_FETCH_TIMEOUT_MS = 10_000;
const MAX_PENDING_DEVICE_CODES_GLOBAL = 2000;
const MAX_PENDING_DEVICE_PER_IP = 8;
const MAX_DEVICE_CODE_MISSES_PER_TX = 5;
const DEVICE_USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const RESERVED_AUTO_PROVISION_ACTORS = new Set([
  "admin",
  "root",
  "system",
  "owner",
  "anonymous",
  "public",
  "meru",
  "meru-mind",
]);

const MINIMAL_DEVICE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const BOUNCE_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

interface OidcCookiePayload {
  s: string;
  v: string;
  n: string;
  f: "browser" | "device";
  r: string;
  i: string | null;
  d: string | null;
  e: number;
}

interface FreshDeviceAuthTx {
  tokenHash: string;
  csrfToken: string;
  orgId: string;
  issuer: string;
  subject: string;
  actorId: string;
  actorKind: "human" | "agent";
  boundRealmId: string | null;
  userCode: string | null;
  authTimeSec: number;
  failedLookups: number;
  verifiedAtMs: number;
  expiresAtMs: number;
}

interface PendingInviteConfirmTx {
  tokenHash: string;
  csrfToken: string;
  orgId: string;
  issuer: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  inviteCodeHash: string;
  actorId: string;
  actorKind: "human" | "agent";
  boundRealmId: string | null;
  flow: "browser" | "device";
  returnTo: string;
  deviceUserCode: string | null;
  authTimeSec: number | null;
  expiresAtMs: number;
}

interface PendingDeviceCode {
  deviceCodeHash: string;
  userCode: string;
  orgId: string;
  remoteIp: string;
  hostname: string;
  clientLabel: string;
  requestedKind: "human" | "agent";
  status: "pending" | "approved" | "denied";
  /** Ephemeral RAM-only plaintext token; NEVER persisted to SQLite and deleted immediately upon single poll pickup */
  mintedToken: string | null;
  mintedTokenId: string | null;
  approvedActorId: string | null;
  approvedActorKind: "human" | "agent" | null;
  mintedExpiresAt: string | null;
  expiresAtMs: number;
  createdAtMs: number;
  createdAtIso: string;
}

export function loadOidcConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OidcConfig | null {
  const issuer = env.MERU_OIDC_ISSUER?.trim();
  const clientId = env.MERU_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  const clientSecret = env.MERU_OIDC_CLIENT_SECRET?.trim() || null;
  const publicUrl = env.MERU_MIND_PUBLIC_URL?.trim() || null;
  const trustIssuer = ["true", "1", "yes"].includes(
    (env.MERU_OIDC_TRUST_ISSUER ?? "").trim().toLowerCase(),
  );
  const rawTtl = env.MERU_OIDC_TOKEN_TTL_DAYS?.trim();
  const parsedTtl = rawTtl ? Number.parseInt(rawTtl, 10) : NaN;
  const tokenTtlDays =
    Number.isFinite(parsedTtl) && parsedTtl > 0
      ? Math.min(parsedTtl, MAX_TOKEN_TTL_DAYS)
      : DEFAULT_SSO_TOKEN_TTL_DAYS;
  return {
    issuer,
    clientId,
    clientSecret,
    publicUrl,
    trustIssuer,
    tokenTtlDays,
  };
}

export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/";
  const trimmed = raw.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/\\") ||
    trimmed.includes("\\") ||
    /[\r\n\x00-\x1f]/.test(trimmed)
  ) {
    return "/";
  }
  return trimmed;
}

export function hashInviteCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim(), "utf8").digest("hex");
}

export function toPublicInvite(rec: InviteRecord): InvitePublic {
  return {
    id: rec.id,
    orgId: rec.orgId,
    actorId: rec.actorId,
    actorKind: rec.actorKind,
    boundRealmId: rec.boundRealmId,
    createdBy: rec.createdBy,
    expiresAt: rec.expiresAt,
    usedAt: rec.usedAt,
    usedByIssuer: rec.usedByIssuer,
    usedBySubject: rec.usedBySubject,
    revokedAt: rec.revokedAt,
    createdAt: rec.createdAt,
  };
}

export function createInvite(params: {
  db: DbPort;
  orgId: string;
  actorId: string;
  actorKind: "human" | "agent";
  boundRealmRef?: string | null;
  createdBy: string;
  ttlHours?: number;
  publicBaseUrl?: string | null;
}): { code: string; inviteUrl: string | null; record: InvitePublic } {
  const actorId = params.actorId.trim().toLowerCase();
  if (
    !actorId ||
    !/^[a-z0-9._-]{1,64}$/.test(actorId) ||
    /^\.+$/.test(actorId)
  ) {
    throw new MindError(
      "INVALID_INPUT",
      "Invite actorId must match [a-z0-9._-]{1,64} and cannot be '.' or '..'",
    );
  }
  if (params.actorKind !== "human" && params.actorKind !== "agent") {
    throw new MindError(
      "INVALID_INPUT",
      `Invite actorKind must be "human" or "agent"`,
    );
  }
  const org = params.db.getOrg(params.orgId);
  if (!org) {
    throw new MindError("NOT_FOUND", `Organization not found: ${params.orgId}`);
  }
  let boundRealmId: string | null = null;
  if (params.boundRealmRef?.trim()) {
    const raw = params.boundRealmRef.trim();
    const realm = raw.startsWith("/")
      ? params.db.getRealmByPath(params.orgId, raw)
      : params.db.getRealm(raw);
    if (!realm || realm.orgId !== params.orgId) {
      throw new MindError(
        "NOT_FOUND",
        `Bound realm "${raw}" not found in org "${params.orgId}"`,
      );
    }
    boundRealmId = realm.id;
  }

  const ttlHours =
    typeof params.ttlHours === "number" &&
    Number.isFinite(params.ttlHours) &&
    params.ttlHours > 0
      ? Math.min(params.ttlHours, 24 * 30)
      : 72;
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlHours * 60 * 60 * 1000).toISOString();
  const id = `inv_${crypto.randomBytes(8).toString("hex")}`;
  const code = `${INVITE_CODE_PREFIX}${crypto.randomBytes(20).toString("hex")}`;

  const rec: InviteRecord = {
    id,
    orgId: params.orgId,
    codeHash: hashInviteCode(code),
    actorId,
    actorKind: params.actorKind,
    boundRealmId,
    createdBy: params.createdBy,
    expiresAt,
    usedAt: null,
    usedByIssuer: null,
    usedBySubject: null,
    revokedAt: null,
    createdAt,
  };
  params.db.insertInvite(rec);

  const base = params.publicBaseUrl?.trim().replace(/\/+$/, "") || null;
  const inviteUrl = base
    ? `${base}/_meru/oidc/login?invite=${encodeURIComponent(code)}`
    : null;

  return {
    code,
    inviteUrl,
    record: toPublicInvite(rec),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatUserCode(): string {
  const bytes = crypto.randomBytes(8);
  let raw = "";
  for (let i = 0; i < 8; i += 1) {
    raw +=
      DEVICE_USER_CODE_ALPHABET[bytes[i]! % DEVICE_USER_CODE_ALPHABET.length]!;
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function normalizeUserCode(raw: string | null | undefined): string {
  if (!raw) return "";
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 8) return "";
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
}

/**
 * Strictly ASCII [A-Za-z0-9._-] to defeat bidi override, homograph, and control-char phishing.
 */
function sanitizeDeviceMetadata(
  raw: unknown,
  fallback: string,
  maxLen = 48,
): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
  return cleaned || fallback;
}

function deriveActorSlugFromClaims(claims: oauth.IDToken): string | null {
  const preferred =
    typeof claims.preferred_username === "string"
      ? claims.preferred_username.trim()
      : "";
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  const emailLocal = email.includes("@") ? email.split("@")[0]! : "";
  const candidate = (preferred || emailLocal || "").toLowerCase();
  const slug = candidate
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug || /^\.+$/.test(slug) || RESERVED_AUTO_PROVISION_ACTORS.has(slug)) {
    return null;
  }
  return slug;
}

function isRequestSecure(req: IncomingMessage, publicUrl?: string | null): boolean {
  if (publicUrl && publicUrl.startsWith("https://")) {
    return true;
  }
  const fwd = req.headers["x-forwarded-proto"];
  if (
    typeof fwd === "string" &&
    fwd.split(",")[0]?.trim().toLowerCase() === "https"
  ) {
    return true;
  }
  return Boolean((req.socket as { encrypted?: boolean })?.encrypted);
}

function extractClientIp(req: IncomingMessage): string {
  const realIp =
    typeof req.headers["x-real-ip"] === "string"
      ? req.headers["x-real-ip"].trim()
      : "";
  const sockIp = req.socket?.remoteAddress?.trim() ?? "";
  // Only trust X-Real-IP when the direct TCP peer is loopback or RFC1918 reverse proxy (e.g. Caddy)
  const peerIsProxy =
    sockIp === "127.0.0.1" ||
    sockIp === "::1" ||
    sockIp === "::ffff:127.0.0.1" ||
    sockIp.startsWith("10.") ||
    sockIp.startsWith("172.") ||
    sockIp.startsWith("192.168.") ||
    sockIp.startsWith("::ffff:10.") ||
    sockIp.startsWith("::ffff:172.") ||
    sockIp.startsWith("::ffff:192.168.");
  if (realIp && peerIsProxy) {
    return realIp.slice(0, 64);
  }
  return (sockIp || "unknown").slice(0, 64);
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Strict same-origin browser POST check (defeats CSRF and `Origin: null` bypasses):
 * - When `Sec-Fetch-Site` is present, it MUST equal `"same-origin"`.
 * - `Origin` MUST be present, MUST NOT be `"null"`, and MUST pass `isOriginAllowed`.
 */
function isSameOriginBrowserPost(
  req: IncomingMessage,
  allowedOrigins?: string[],
): boolean {
  const secFetchSite =
    typeof req.headers["sec-fetch-site"] === "string"
      ? req.headers["sec-fetch-site"].trim().toLowerCase()
      : "";
  if (secFetchSite && secFetchSite !== "same-origin") {
    return false;
  }
  const origin = req.headers.origin?.trim();
  if (!origin || origin.toLowerCase() === "null") {
    return false;
  }
  return isOriginAllowed({
    originHeader: origin,
    hostHeader: req.headers.host,
    allowedOrigins,
  });
}

async function readFormOrJsonBody(
  req: IncomingMessage,
  options?: { jsonOnly?: boolean; maxBytes?: number },
): Promise<Record<string, string>> {
  const maxBytes = options?.maxBytes ?? 16 * 1024;
  const ct = (req.headers["content-type"] ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (options?.jsonOnly && ct !== "application/json") {
    throw new MindError(
      "INVALID_INPUT",
      "Content-Type must be application/json",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new MindError("INVALID_INPUT", "Request body too large");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  if (ct === "application/json") {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed ?? {})) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      throw new MindError("INVALID_INPUT", "Malformed JSON body");
    }
  }
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    out[k] = v;
  }
  return out;
}

function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  csp: string,
  extraHeaders?: Record<string, string | string[]>,
  referrerPolicy: "no-referrer" | "same-origin" = "no-referrer",
): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": referrerPolicy,
    "Cache-Control": "no-store",
    ...(extraHeaders ?? {}),
  });
  res.end(html);
}

function sendOidcJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function renderMinimalPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Meru Mind</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#eaeef4;color:#14171f;font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;font-size:14px;line-height:1.55}
@media(prefers-color-scheme:dark){body{background:#090b0e;color:#f1f5f9}.card{background:#171b24;border-color:rgba(255,255,255,.14)}.muted{color:#94a3b8}.code-box{background:#11151d;border-color:rgba(255,255,255,.16)}.btn.primary{background:#f1f5f9;color:#090b0e}.btn.secondary{background:transparent;color:#cbd5e1;border-color:rgba(255,255,255,.2)}input.text{background:#11151d;color:#f1f5f9;border-color:rgba(255,255,255,.2)}}
.card{width:min(460px,100%);background:#fff;border:1px solid rgba(20,23,31,.12);border-radius:14px;padding:28px;box-shadow:0 12px 32px rgba(15,23,42,.08)}
h1{margin:0 0 8px;font-size:19px;font-weight:600;letter-spacing:-.02em}
p{margin:0 0 14px}
.muted{color:#525d6e;font-size:13px}
.warn{font-size:12px;opacity:.85;margin-top:8px}
.code-box{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;font-weight:600;letter-spacing:.12em;text-align:center;padding:14px;border-radius:10px;border:1px solid rgba(20,23,31,.14);background:#f5f7fa;margin:14px 0}
.meta{margin:12px 0 18px;font-size:13px;border-top:1px solid rgba(127,127,127,.2);padding-top:12px}
.meta div{display:flex;justify-content:space-between;gap:12px;padding:3px 0}
.meta span:first-child{opacity:.7}
.meta span:last-child{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;text-align:right}
.actions{display:flex;gap:10px;margin-top:18px}
.btn{flex:1;height:38px;border-radius:8px;border:1px solid transparent;font-size:13.5px;font-weight:500;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
.btn.primary{background:#14171f;color:#fff}
.btn.secondary{background:#fff;color:#14171f;border-color:rgba(20,23,31,.2)}
input.text{width:100%;height:40px;padding:0 12px;border-radius:8px;border:1px solid rgba(20,23,31,.2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px}
</style>
</head>
<body><main class="card">${bodyHtml}</main></body>
</html>`;
}

function stateCookieSuffix(state: string): string {
  return crypto.createHash("sha256").update(state, "utf8").digest("hex").slice(0, 12);
}

/**
 * Standard OpenID Connect SSO + Single-Use Invitations + Self-Issued Device-Code Engine (`v0.6.0`).
 *
 * Security invariants:
 * 1. Pure standard OIDC via `oauth4webapi` (zero IdP-specific adapters, never reads `groups`).
 * 2. Identity mapping is strictly keyed by `(org_id, issuer, subject)` — NEVER by `email`.
 * 3. OIDC login transactions are stateless AEAD-encrypted cookies (zero server RAM on anonymous GET).
 * 4. `SameSite=Strict` browser session cookie is delivered via HTTP 200 same-origin bounce page.
 * 5. Invite redemption requires an explicit POST confirmation page (defeats invite-swap CSRF).
 * 6. `/_meru/device` NEVER trusts the UI session cookie, renders ZERO user content, sends
 *    `Referrer-Policy: same-origin` for real-browser same-origin form POSTs, and requires a fresh
 *    `max_age=0` + `prompt=login` + explicit `auth_time` OIDC round-trip + CSRF + code binding.
 * 7. Device-code plaintext tokens exist strictly in RAM until single-use pickup and default to 90d TTL.
 */
export class OidcManager {
  readonly config: OidcConfig;
  private readonly issuerUrl: URL;
  private readonly allowHttpLoopback: boolean;
  private readonly txAeadKey: Buffer;
  private cachedAs: oauth.AuthorizationServer | null = null;
  private cachedAsFetchedAtMs = 0;
  /** Single-use replay table populated ONLY after valid AEAD callback verification */
  private readonly usedOidcStates = new Map<string, number>();
  private readonly deviceCodesByHash = new Map<string, PendingDeviceCode>();
  private readonly deviceHashByUserCode = new Map<string, string>();
  private readonly freshDeviceAuthTx = new Map<string, FreshDeviceAuthTx>();
  private readonly pendingInviteConfirmTx = new Map<
    string,
    PendingInviteConfirmTx
  >();

  constructor(config: OidcConfig) {
    let parsedIssuer: URL;
    try {
      parsedIssuer = new URL(config.issuer.trim());
    } catch {
      throw new MindError(
        "INVALID_INPUT",
        `Invalid MERU_OIDC_ISSUER URL: "${config.issuer}"`,
      );
    }
    const isLoopbackHttp =
      parsedIssuer.protocol === "http:" && isLoopbackHost(parsedIssuer.hostname);
    if (parsedIssuer.protocol !== "https:" && !isLoopbackHttp) {
      throw new MindError(
        "INVALID_INPUT",
        `MERU_OIDC_ISSUER must use https:// (got "${parsedIssuer.origin}"); http:// is permitted only on loopback for local testing.`,
      );
    }
    if (!config.clientId?.trim()) {
      throw new MindError("INVALID_INPUT", "MERU_OIDC_CLIENT_ID is required");
    }
    let normalizedPublicUrl: string | null = null;
    if (config.publicUrl?.trim()) {
      let parsedPub: URL;
      try {
        parsedPub = new URL(config.publicUrl.trim());
      } catch {
        throw new MindError(
          "INVALID_INPUT",
          `Invalid MERU_MIND_PUBLIC_URL: "${config.publicUrl}"`,
        );
      }
      const pubLoopback =
        parsedPub.protocol === "http:" && isLoopbackHost(parsedPub.hostname);
      if (parsedPub.protocol !== "https:" && !pubLoopback) {
        throw new MindError(
          "INVALID_INPUT",
          `MERU_MIND_PUBLIC_URL must use https:// for non-loopback hosts (got "${parsedPub.origin}")`,
        );
      }
      normalizedPublicUrl = parsedPub.href.replace(/\/+$/, "");
    }
    const ttlDays =
      typeof config.tokenTtlDays === "number" &&
      Number.isFinite(config.tokenTtlDays) &&
      config.tokenTtlDays > 0
        ? Math.min(config.tokenTtlDays, MAX_TOKEN_TTL_DAYS)
        : DEFAULT_SSO_TOKEN_TTL_DAYS;
    this.config = {
      ...config,
      issuer: parsedIssuer.href.replace(/\/+$/, ""),
      clientId: config.clientId.trim(),
      clientSecret: config.clientSecret?.trim() || null,
      publicUrl: normalizedPublicUrl,
      trustIssuer: Boolean(config.trustIssuer),
      tokenTtlDays: ttlDays,
    };
    this.issuerUrl = new URL(this.config.issuer);
    this.allowHttpLoopback = isLoopbackHttp;
    this.txAeadKey = crypto.randomBytes(32);
  }

  private sealOidcPayload(payload: OidcCookiePayload): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.txAeadKey, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64url");
  }

  private openOidcPayload(sealed: string): OidcCookiePayload | null {
    try {
      const buf = Buffer.from(sealed, "base64url");
      if (buf.length < 12 + 16 + 2) return null;
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const ciphertext = buf.subarray(28);
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.txAeadKey,
        iv,
      );
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
      const parsed = JSON.parse(plain) as Partial<OidcCookiePayload>;
      if (
        typeof parsed.s !== "string" ||
        typeof parsed.v !== "string" ||
        typeof parsed.n !== "string" ||
        (parsed.f !== "browser" && parsed.f !== "device") ||
        typeof parsed.r !== "string" ||
        typeof parsed.e !== "number"
      ) {
        return null;
      }
      return {
        s: parsed.s,
        v: parsed.v,
        n: parsed.n,
        f: parsed.f,
        r: parsed.r,
        i: typeof parsed.i === "string" ? parsed.i : null,
        d: typeof parsed.d === "string" ? parsed.d : null,
        e: parsed.e,
      };
    } catch {
      return null;
    }
  }

  private prune(db?: DbPort, nowMs = Date.now()): void {
    for (const [k, exp] of this.usedOidcStates.entries()) {
      if (exp <= nowMs) this.usedOidcStates.delete(k);
    }
    for (const [k, v] of this.freshDeviceAuthTx.entries()) {
      if (v.expiresAtMs <= nowMs) this.freshDeviceAuthTx.delete(k);
    }
    for (const [k, v] of this.pendingInviteConfirmTx.entries()) {
      if (v.expiresAtMs <= nowMs) this.pendingInviteConfirmTx.delete(k);
    }
    const nowIso = new Date(nowMs).toISOString();
    for (const [k, v] of this.deviceCodesByHash.entries()) {
      if (v.expiresAtMs <= nowMs) {
        // Revoke any approved token that was never picked up by the CLI before expiry
        if (db && v.status === "approved" && v.mintedTokenId) {
          try {
            db.revokeToken(v.orgId, v.mintedTokenId, nowIso);
          } catch {
            // ignore best-effort cleanup
          }
        }
        v.mintedToken = null;
        this.deviceCodesByHash.delete(k);
        if (this.deviceHashByUserCode.get(v.userCode) === k) {
          this.deviceHashByUserCode.delete(v.userCode);
        }
      }
    }
  }

  private async getAuthorizationServer(): Promise<oauth.AuthorizationServer> {
    const now = Date.now();
    if (this.cachedAs && now - this.cachedAsFetchedAtMs < DISCOVERY_CACHE_TTL_MS) {
      return this.cachedAs;
    }
    const opts: oauth.DiscoveryRequestOptions = {
      signal: AbortSignal.timeout(IDP_FETCH_TIMEOUT_MS),
      ...(this.allowHttpLoopback ? { [oauth.allowInsecureRequests]: true } : {}),
    };
    const resp = await oauth.discoveryRequest(this.issuerUrl, opts);
    const as = await oauth.processDiscoveryResponse(this.issuerUrl, resp);
    this.cachedAs = as;
    this.cachedAsFetchedAtMs = now;
    return as;
  }

  private buildClient(): { client: oauth.Client; clientAuth: oauth.ClientAuth } {
    const client: oauth.Client = {
      client_id: this.config.clientId,
    };
    if (this.config.clientSecret) {
      const supported = this.cachedAs?.token_endpoint_auth_methods_supported;
      if (
        Array.isArray(supported) &&
        !supported.includes("client_secret_basic") &&
        supported.includes("client_secret_post")
      ) {
        return {
          client,
          clientAuth: oauth.ClientSecretPost(this.config.clientSecret),
        };
      }
      return {
        client,
        clientAuth: oauth.ClientSecretBasic(this.config.clientSecret),
      };
    }
    return { client, clientAuth: oauth.None() };
  }

  resolvePublicBaseUrl(req: IncomingMessage, fallbackServerUrl: string): string {
    if (this.config.publicUrl) return this.config.publicUrl;
    const reqHost = req.headers.host?.trim();
    if (
      reqHost &&
      !reqHost.startsWith("0.0.0.0") &&
      !reqHost.startsWith("[::]")
    ) {
      const proto = isRequestSecure(req, this.config.publicUrl)
        ? "https"
        : "http";
      return `${proto}://${reqHost}`;
    }
    return fallbackServerUrl.replace(/\/+$/, "");
  }

  private resolveBoundRealmIdForOrg(
    db: DbPort,
    orgId: string,
    preferredRealmId: string | null,
  ): { boundRealmId: string; boundSource: string } {
    const org = db.getOrg(orgId);
    if (!org) {
      throw new MindError("NOT_FOUND", `Organization not found: ${orgId}`);
    }
    if (preferredRealmId) {
      const realm = db.getRealm(preferredRealmId);
      if (realm && realm.orgId === orgId) {
        return { boundRealmId: realm.id, boundSource: "oidc-identity" };
      }
    }
    const root = db.getRealmByPath(orgId, "/") ?? db.listRealms(orgId)[0];
    if (!root) {
      throw new MindError("NOT_FOUND", `No realms found in org ${orgId}`);
    }
    return {
      boundRealmId: root.id,
      boundSource: org.policy === "open" ? "open-default:/" : "oidc-root:/",
    };
  }

  private buildTxCookie(
    name: string,
    value: string,
    pathAttr: string,
    sameSite: "Lax" | "Strict",
    maxAgeSeconds: number,
    isSecure: boolean,
  ): string {
    const effectivePath = name.startsWith("__Host-") ? "/" : pathAttr;
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      "HttpOnly",
      `SameSite=${sameSite}`,
      `Path=${effectivePath}`,
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (isSecure || name.startsWith("__Host-")) parts.push("Secure");
    return parts.join("; ");
  }

  revokeDeviceTxForActor(orgId: string, actorId: string): number {
    const targetLower = actorId.trim().toLowerCase();
    let removed = 0;
    for (const [k, v] of this.freshDeviceAuthTx.entries()) {
      if (v.orgId === orgId && v.actorId.toLowerCase() === targetLower) {
        this.freshDeviceAuthTx.delete(k);
        removed += 1;
      }
    }
    for (const [k, v] of this.pendingInviteConfirmTx.entries()) {
      if (v.orgId === orgId && v.actorId.toLowerCase() === targetLower) {
        this.pendingInviteConfirmTx.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  private readFreshDeviceAuthTx(
    req: IncomingMessage,
    orgId: string,
    isSecure: boolean,
    nowMs = Date.now(),
  ): FreshDeviceAuthTx | null {
    const cookies = parseCookieHeader(req.headers.cookie);
    const rawTok = isSecure
      ? cookies[DEVICE_HOST_TX_COOKIE_NAME]
      : (cookies[DEVICE_HOST_TX_COOKIE_NAME] ?? cookies[DEVICE_TX_COOKIE_NAME]);
    if (!rawTok) return null;
    const hash = hashAuthToken(rawTok);
    const tx = this.freshDeviceAuthTx.get(hash);
    if (!tx || tx.expiresAtMs <= nowMs || tx.orgId !== orgId) {
      if (tx) this.freshDeviceAuthTx.delete(hash);
      return null;
    }
    return tx;
  }

  private readPendingInviteConfirmTx(
    req: IncomingMessage,
    orgId: string,
    isSecure: boolean,
    nowMs = Date.now(),
  ): PendingInviteConfirmTx | null {
    const cookies = parseCookieHeader(req.headers.cookie);
    const rawTok = isSecure
      ? cookies[INVITE_HOST_TX_COOKIE_NAME]
      : (cookies[INVITE_HOST_TX_COOKIE_NAME] ?? cookies[INVITE_TX_COOKIE_NAME]);
    if (!rawTok) return null;
    const hash = hashAuthToken(rawTok);
    const tx = this.pendingInviteConfirmTx.get(hash);
    if (!tx || tx.expiresAtMs <= nowMs || tx.orgId !== orgId) {
      if (tx) this.pendingInviteConfirmTx.delete(hash);
      return null;
    }
    return tx;
  }

  private issuePostAuthResponse(params: {
    res: ServerResponse;
    db: DbPort;
    orgId: string;
    uiSessions: UiSessionManager;
    identity: OidcIdentityRecord;
    flow: "browser" | "device";
    returnTo: string;
    deviceUserCode: string | null;
    authTimeSec: number | null;
    isSecure: boolean;
    extraClearCookies: string[];
  }): void {
    const {
      res,
      db,
      orgId,
      uiSessions,
      identity,
      flow,
      returnTo,
      deviceUserCode,
      authTimeSec,
      isSecure,
      extraClearCookies,
    } = params;

    if (flow === "device") {
      if (typeof authTimeSec !== "number" || !Number.isFinite(authTimeSec)) {
        throw new MindError(
          "ACCESS_DENIED",
          "Fresh IdP authentication (auth_time) is required to approve CLI device login.",
        );
      }
      const deviceTxToken = crypto.randomBytes(24).toString("hex");
      const deviceTxHash = hashAuthToken(deviceTxToken);
      const csrfToken = crypto.randomBytes(18).toString("hex");
      this.freshDeviceAuthTx.set(deviceTxHash, {
        tokenHash: deviceTxHash,
        csrfToken,
        orgId,
        issuer: identity.issuer,
        subject: identity.subject,
        actorId: identity.actorId,
        actorKind: identity.actorKind,
        boundRealmId: identity.boundRealmId,
        userCode: deviceUserCode,
        authTimeSec,
        failedLookups: 0,
        verifiedAtMs: Date.now(),
        expiresAtMs: Date.now() + DEVICE_AUTH_TX_TTL_MS,
      });
      const deviceCookieName = isSecure
        ? DEVICE_HOST_TX_COOKIE_NAME
        : DEVICE_TX_COOKIE_NAME;
      const deviceCookie = this.buildTxCookie(
        deviceCookieName,
        deviceTxToken,
        "/_meru/device",
        "Strict",
        Math.floor(DEVICE_AUTH_TX_TTL_MS / 1000),
        isSecure,
      );
      const nextDeviceUrl = deviceUserCode
        ? `/_meru/device?code=${encodeURIComponent(deviceUserCode)}`
        : "/_meru/device";
      const bounceHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(nextDeviceUrl)}"><title>Continuing to Device Verification — Meru Mind</title></head><body><p>Verified. <a href="${escapeHtml(nextDeviceUrl)}">Continue to device confirmation</a>.</p></body></html>`;
      sendHtml(
        res,
        200,
        bounceHtml,
        BOUNCE_HTML_CSP,
        { "Set-Cookie": [...extraClearCookies, deviceCookie] },
        "same-origin",
      );
      return;
    }

    const { boundRealmId, boundSource } = this.resolveBoundRealmIdForOrg(
      db,
      orgId,
      identity.boundRealmId,
    );
    const principal: Principal = {
      tokenId: null,
      orgId,
      actor: {
        id: identity.actorId,
        kind: identity.actorKind,
      },
      boundRealmId,
      boundSource,
      authKind: "cookie",
    };
    const createdSession = uiSessions.createSessionForPrincipal(principal, db);
    const sessionCookie = uiSessions.buildSetCookieHeader(
      createdSession.sessionId,
      createdSession.maxAgeSeconds,
      isSecure,
    );
    const safeReturnTo = sanitizeReturnTo(returnTo);
    const bounceHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtml(safeReturnTo)}"><title>Signed In — Meru Mind</title></head><body><p>Signed in as ${escapeHtml(identity.actorId)}. <a href="${escapeHtml(safeReturnTo)}">Continue to Meru Mind</a>.</p></body></html>`;
    sendHtml(
      res,
      200,
      bounceHtml,
      BOUNCE_HTML_CSP,
      { "Set-Cookie": [...extraClearCookies, sessionCookie] },
      "no-referrer",
    );
  }

  /**
   * Handles `/_meru/oidc/*` and `/_meru/device*` routes. Returns true when handled.
   */
  async handleRequest(params: {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    db: DbPort;
    orgId: string;
    uiSessions: UiSessionManager;
    fallbackServerUrl: string;
    allowedOrigins?: string[];
  }): Promise<boolean> {
    const { req, res, url, db, orgId, uiSessions, fallbackServerUrl } = params;
    const pathname = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    const isSecure = isRequestSecure(req, this.config.publicUrl);
    const publicBase = this.resolvePublicBaseUrl(req, fallbackServerUrl);
    const redirectUri = `${publicBase}/_meru/oidc/callback`;

    this.prune(db);

    // ---- 1. Start OIDC Authorization Code + PKCE Login (STATELESS AEAD cookie — zero server RAM!) ----
    if (pathname === "/_meru/oidc/login" && method === "GET") {
      // Block subresource fetches such as <img src="/_meru/oidc/login"> in browsers
      const fetchMode =
        typeof req.headers["sec-fetch-mode"] === "string"
          ? req.headers["sec-fetch-mode"].trim().toLowerCase()
          : "";
      const fetchDest =
        typeof req.headers["sec-fetch-dest"] === "string"
          ? req.headers["sec-fetch-dest"].trim().toLowerCase()
          : "";
      if (
        (fetchMode && fetchMode !== "navigate") ||
        (fetchDest && fetchDest !== "document")
      ) {
        sendHtml(
          res,
          403,
          renderMinimalPage(
            "Forbidden",
            "<h1>Top-level browser navigation required</h1>",
          ),
          BOUNCE_HTML_CSP,
        );
        return true;
      }

      const as = await this.getAuthorizationServer();
      if (!as.authorization_endpoint) {
        throw new MindError(
          "INVALID_INPUT",
          "OIDC provider discovery metadata is missing authorization_endpoint",
        );
      }

      const flow: "browser" | "device" =
        url.searchParams.get("flow") === "device" ? "device" : "browser";
      const returnTo = sanitizeReturnTo(url.searchParams.get("return_to"));
      const inviteCode = url.searchParams.get("invite")?.trim() || null;
      const secFetchSite =
        typeof req.headers["sec-fetch-site"] === "string"
          ? req.headers["sec-fetch-site"].trim().toLowerCase()
          : "";
      // Anti-phishing: cross-site links cannot prefill a device code
      const deviceUserCode =
        flow === "device" && secFetchSite !== "cross-site"
          ? normalizeUserCode(url.searchParams.get("code")) || null
          : null;

      const state = oauth.generateRandomState();
      const nonce = oauth.generateRandomNonce();
      const codeVerifier = oauth.generateRandomCodeVerifier();
      const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

      const sealedCookieVal = this.sealOidcPayload({
        s: state,
        v: codeVerifier,
        n: nonce,
        f: flow,
        r: returnTo,
        i: inviteCode,
        d: deviceUserCode,
        e: Date.now() + OIDC_TX_TTL_MS,
      });

      const authUrl = new URL(as.authorization_endpoint);
      authUrl.searchParams.set("client_id", this.config.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid email profile");
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("nonce", nonce);
      if (flow === "device") {
        // Security invariant: CLI device authorization ALWAYS demands fresh IdP authentication
        authUrl.searchParams.set("max_age", "0");
        authUrl.searchParams.set("prompt", "login");
      }

      const cookiePrefix = isSecure
        ? OIDC_HOST_TX_COOKIE_PREFIX
        : OIDC_TX_COOKIE_PREFIX;
      const txCookieName = `${cookiePrefix}${stateCookieSuffix(state)}`;
      const txCookie = this.buildTxCookie(
        txCookieName,
        sealedCookieVal,
        "/_meru/oidc",
        "Lax",
        Math.floor(OIDC_TX_TTL_MS / 1000),
        isSecure,
      );
      res.writeHead(302, {
        Location: authUrl.href,
        "Set-Cookie": txCookie,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end();
      return true;
    }

    // ---- 2. OIDC Callback (AEAD cookie verification + single-use state + PKCE + nonce + explicit auth_time) ----
    if (pathname === "/_meru/oidc/callback" && method === "GET") {
      const stateParam = url.searchParams.get("state") ?? "";
      const suffix = stateParam ? stateCookieSuffix(stateParam) : "";
      const hostCookieName = `${OIDC_HOST_TX_COOKIE_PREFIX}${suffix}`;
      const plainCookieName = `${OIDC_TX_COOKIE_PREFIX}${suffix}`;
      const clearOidcCookies: string[] = [];
      if (suffix) {
        clearOidcCookies.push(
          this.buildTxCookie(
            isSecure ? hostCookieName : plainCookieName,
            "",
            "/_meru/oidc",
            "Lax",
            0,
            isSecure,
          ),
        );
      }

      const cookies = parseCookieHeader(req.headers.cookie);
      const sealedCookie = suffix
        ? isSecure
          ? cookies[hostCookieName]
          : (cookies[hostCookieName] ?? cookies[plainCookieName])
        : undefined;
      const tx = sealedCookie ? this.openOidcPayload(sealedCookie) : null;

      if (
        !tx ||
        !stateParam ||
        !constantTimeEqualHex(tx.s, stateParam) ||
        tx.e <= Date.now() ||
        this.usedOidcStates.has(stateParam)
      ) {
        sendHtml(
          res,
          400,
          renderMinimalPage(
            "Sign-in Expired",
            "<h1>Sign-in session expired or invalid</h1><p class='muted'>Please start sign-in again from Meru Mind.</p><div class='actions'><a class='btn primary' href='/'>Return to Meru Mind</a></div>",
          ),
          BOUNCE_HTML_CSP,
          clearOidcCookies.length > 0
            ? { "Set-Cookie": clearOidcCookies }
            : undefined,
        );
        return true;
      }

      // Single-use replay protection: record ONLY AFTER valid AEAD cookie verification!
      this.usedOidcStates.set(stateParam, tx.e);

      try {
        const as = await this.getAuthorizationServer();
        const { client, clientAuth } = this.buildClient();
        const callbackParams = oauth.validateAuthResponse(
          as,
          client,
          url.searchParams,
          tx.s,
        );
        const tokenResp = await oauth.authorizationCodeGrantRequest(
          as,
          client,
          clientAuth,
          callbackParams,
          redirectUri,
          tx.v,
          {
            signal: AbortSignal.timeout(IDP_FETCH_TIMEOUT_MS),
            ...(this.allowHttpLoopback
              ? { [oauth.allowInsecureRequests]: true }
              : {}),
          },
        );
        const tokenResult = await oauth.processAuthorizationCodeResponse(
          as,
          client,
          tokenResp,
          {
            expectedNonce: tx.n,
            requireIdToken: true,
            maxAge: tx.f === "device" ? DEVICE_MAX_AUTH_AGE_SECONDS : undefined,
          },
        );
        const claims = oauth.getValidatedIdTokenClaims(tokenResult);
        if (!claims || typeof claims.sub !== "string" || !claims.sub.trim()) {
          throw new MindError(
            "ACCESS_DENIED",
            "OIDC ID token is missing subject (sub) claim.",
          );
        }
        const verifiedIssuer = String(claims.iss || as.issuer).replace(
          /\/+$/,
          "",
        );
        const verifiedSubject = claims.sub.trim();
        const authTimeSec =
          typeof claims.auth_time === "number" && Number.isFinite(claims.auth_time)
            ? claims.auth_time
            : null;

        // Explicit strict auth_time check for fresh device-code approval (reject if missing OR stale!)
        if (tx.f === "device") {
          if (authTimeSec === null) {
            throw new MindError(
              "ACCESS_DENIED",
              "Your OIDC provider did not return an auth_time claim. Fresh authentication is required to approve CLI logins.",
            );
          }
          const ageSec = Math.floor(Date.now() / 1000) - authTimeSec;
          if (ageSec > DEVICE_MAX_AUTH_AGE_SECONDS || ageSec < -60) {
            throw new MindError(
              "ACCESS_DENIED",
              "Fresh IdP authentication is required to approve CLI device login.",
            );
          }
        }

        const nowIso = new Date().toISOString();
        const email =
          typeof claims.email === "string" ? claims.email.trim() || null : null;
        const displayName =
          typeof claims.name === "string"
            ? claims.name.trim() || null
            : typeof claims.preferred_username === "string"
              ? claims.preferred_username.trim() || null
              : null;

        // 1. Strict (orgId, issuer, subject) lookup — NEVER match by email!
        const existing = db.getIdentityBySubject(
          orgId,
          verifiedIssuer,
          verifiedSubject,
        );
        if (existing) {
          if (
            existing.disabledAt !== null ||
            db.isActorDisabled(orgId, existing.actorId)
          ) {
            throw new MindError(
              "ACCESS_DENIED",
              "This account has been disabled by an administrator.",
            );
          }
          db.updateIdentityProfile({
            id: existing.id,
            email,
            displayName,
            updatedAt: nowIso,
          });
          const updated: OidcIdentityRecord = {
            ...existing,
            email,
            displayName,
            updatedAt: nowIso,
          };
          // P1-4: If an already-linked user clicked an invite link, explicitly notify them that the invite was NOT used!
          if (tx.i && tx.f === "browser") {
            const { boundRealmId, boundSource } = this.resolveBoundRealmIdForOrg(
              db,
              orgId,
              updated.boundRealmId,
            );
            const principal: Principal = {
              tokenId: null,
              orgId,
              actor: { id: updated.actorId, kind: updated.actorKind },
              boundRealmId,
              boundSource,
              authKind: "cookie",
            };
            const sess = uiSessions.createSessionForPrincipal(principal, db);
            const sessionCookie = uiSessions.buildSetCookieHeader(
              sess.sessionId,
              sess.maxAgeSeconds,
              isSecure,
            );
            sendHtml(
              res,
              200,
              renderMinimalPage(
                "Account Already Linked",
                `<h1>Already linked to Meru Mind</h1>
                 <p class="muted">Your SSO identity is already linked as <strong>${escapeHtml(updated.actorId)}</strong>. This invite link was <strong>not</strong> consumed.</p>
                 <div class="actions"><a class="btn primary" href="${escapeHtml(sanitizeReturnTo(tx.r))}">Continue to Meru Mind</a></div>`,
              ),
              BOUNCE_HTML_CSP,
              { "Set-Cookie": [...clearOidcCookies, sessionCookie] },
            );
            return true;
          }

          this.issuePostAuthResponse({
            res,
            db,
            orgId,
            uiSessions,
            identity: updated,
            flow: tx.f,
            returnTo: tx.r,
            deviceUserCode: tx.d,
            authTimeSec,
            isSecure,
            extraClearCookies: clearOidcCookies,
          });
          return true;
        }

        // 2. Invite-based onboarding — render explicit POST confirmation page (defeats invite-swap CSRF!)
        if (tx.i) {
          const codeHash = hashInviteCode(tx.i);
          const preview = db.getInviteByHash(orgId, codeHash);
          if (
            !preview ||
            preview.usedAt !== null ||
            preview.revokedAt !== null ||
            Date.parse(preview.expiresAt) <= Date.now()
          ) {
            throw new MindError(
              "ACCESS_DENIED",
              "Invite code is invalid, expired, revoked, or has already been used.",
            );
          }
          if (db.isActorDisabled(orgId, preview.actorId)) {
            throw new MindError(
              "ACCESS_DENIED",
              "This account has been disabled by an administrator.",
            );
          }

          const realmPath = preview.boundRealmId
            ? (db.getRealm(preview.boundRealmId)?.path ?? preview.boundRealmId)
            : "/";
          const inviteTxToken = crypto.randomBytes(24).toString("hex");
          const inviteTxHash = hashAuthToken(inviteTxToken);
          const csrfToken = crypto.randomBytes(18).toString("hex");
          this.pendingInviteConfirmTx.set(inviteTxHash, {
            tokenHash: inviteTxHash,
            csrfToken,
            orgId,
            issuer: verifiedIssuer,
            subject: verifiedSubject,
            email,
            displayName,
            inviteCodeHash: codeHash,
            actorId: preview.actorId,
            actorKind: preview.actorKind,
            boundRealmId: preview.boundRealmId,
            flow: tx.f,
            returnTo: tx.r,
            deviceUserCode: tx.d,
            authTimeSec,
            expiresAtMs: Date.now() + INVITE_CONFIRM_TX_TTL_MS,
          });
          const inviteCookieName = isSecure
            ? INVITE_HOST_TX_COOKIE_NAME
            : INVITE_TX_COOKIE_NAME;
          const inviteCookie = this.buildTxCookie(
            inviteCookieName,
            inviteTxToken,
            "/_meru/oidc/invite-confirm",
            "Strict",
            Math.floor(INVITE_CONFIRM_TX_TTL_MS / 1000),
            isSecure,
          );
          const confirmBody = `<h1>Confirm Invitation</h1>
            <p class="muted">Confirm you want to link your SSO identity to this Meru Mind account.</p>
            <div class="meta">
              <div><span>Actor</span><span>${escapeHtml(preview.actorId)} (${escapeHtml(preview.actorKind)})</span></div>
              <div><span>Realm Scope</span><span>${escapeHtml(realmPath)}</span></div>
              <div><span>Invited By</span><span>${escapeHtml(preview.createdBy)}</span></div>
            </div>
            <div class="actions">
              <form method="POST" action="/_meru/oidc/invite-confirm" style="flex:1;display:flex">
                <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
                <input type="hidden" name="decision" value="cancel">
                <button class="btn secondary" type="submit">Cancel</button>
              </form>
              <form method="POST" action="/_meru/oidc/invite-confirm" style="flex:1;display:flex">
                <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
                <input type="hidden" name="decision" value="accept">
                <button class="btn primary" type="submit">Accept &amp; Join</button>
              </form>
            </div>`;
          sendHtml(
            res,
            200,
            renderMinimalPage("Confirm Invitation", confirmBody),
            MINIMAL_DEVICE_CSP,
            { "Set-Cookie": [...clearOidcCookies, inviteCookie] },
            "same-origin",
          );
          return true;
        }

        // 3. Dedicated-IdP auto-provision ONLY when explicitly opted-in via MERU_OIDC_TRUST_ISSUER=true
        if (this.config.trustIssuer) {
          const slug = deriveActorSlugFromClaims(claims);
          if (!slug) {
            throw new MindError(
              "ACCESS_DENIED",
              "Cannot auto-provision an actor ID from your SSO profile; ask an administrator for an invite link.",
            );
          }
          // Security invariant: NEVER hijack an existing/reserved/pending/historical actorId!
          if (db.isActorIdClaimedInOrg(orgId, slug)) {
            throw new MindError(
              "ACCESS_DENIED",
              "An account with this name already exists under another identity or credential. Ask an administrator for an explicit invite link.",
            );
          }
          const created: OidcIdentityRecord = {
            id: `oid_${crypto.randomBytes(8).toString("hex")}`,
            orgId,
            issuer: verifiedIssuer,
            subject: verifiedSubject,
            actorId: slug,
            actorKind: "human",
            boundRealmId: null,
            email,
            displayName,
            disabledAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          db.insertIdentity(created);
          this.issuePostAuthResponse({
            res,
            db,
            orgId,
            uiSessions,
            identity: created,
            flow: tx.f,
            returnTo: tx.r,
            deviceUserCode: tx.d,
            authTimeSec,
            isSecure,
            extraClearCookies: clearOidcCookies,
          });
          return true;
        }

        // 4. Uninvited unknown (iss, sub): reject with clear re-bind/invite guidance
        throw new MindError(
          "ACCESS_DENIED",
          "Your SSO identity is not linked to an account in this organization. If the identity provider was changed or you are a new member, ask an administrator for an invite link ('meru-mind invite create').",
        );
      } catch (err) {
        const isMindErr = err instanceof MindError;
        const msg = isMindErr
          ? err.message
          : "Unable to verify SSO sign-in. Please retry or contact an administrator.";
        const status =
          isMindErr && err.code === "ACCESS_DENIED" ? 403 : 400;
        sendHtml(
          res,
          status,
          renderMinimalPage(
            "Sign-in Rejected",
            `<h1>Unable to complete SSO sign-in</h1><p class="muted">${escapeHtml(msg)}</p><div class="actions"><a class="btn primary" href="/">Back to Meru Mind</a></div>`,
          ),
          BOUNCE_HTML_CSP,
          clearOidcCookies.length > 0
            ? { "Set-Cookie": clearOidcCookies }
            : undefined,
        );
        return true;
      }
    }

    // ---- 2b. Explicit Invite Redemption Confirmation POST (defeats invite-swap CSRF) ----
    if (pathname === "/_meru/oidc/invite-confirm" && method === "POST") {
      if (!isSameOriginBrowserPost(req, params.allowedOrigins)) {
        sendHtml(
          res,
          403,
          renderMinimalPage(
            "Forbidden",
            "<h1>Cross-origin request rejected</h1>",
          ),
          MINIMAL_DEVICE_CSP,
        );
        return true;
      }
      const pendingTx = this.readPendingInviteConfirmTx(req, orgId, isSecure);
      const clearInviteCookie = this.buildTxCookie(
        isSecure ? INVITE_HOST_TX_COOKIE_NAME : INVITE_TX_COOKIE_NAME,
        "",
        "/_meru/oidc/invite-confirm",
        "Strict",
        0,
        isSecure,
      );
      if (!pendingTx) {
        sendHtml(
          res,
          401,
          renderMinimalPage(
            "Confirmation Expired",
            "<h1>Invitation confirmation expired</h1><p class='muted'>Please open your invite link again.</p>",
          ),
          MINIMAL_DEVICE_CSP,
          { "Set-Cookie": clearInviteCookie },
        );
        return true;
      }

      const body = await readFormOrJsonBody(req);
      const submittedCsrf = (body.csrf ?? "").trim();
      if (
        !submittedCsrf ||
        !constantTimeEqualHex(submittedCsrf, pendingTx.csrfToken)
      ) {
        sendHtml(
          res,
          403,
          renderMinimalPage(
            "Forbidden",
            "<h1>Invalid confirmation token</h1>",
          ),
          MINIMAL_DEVICE_CSP,
        );
        return true;
      }

      // Single-use confirmation cookie: consume immediately
      this.pendingInviteConfirmTx.delete(pendingTx.tokenHash);

      if ((body.decision ?? "").trim().toLowerCase() !== "accept") {
        sendHtml(
          res,
          200,
          renderMinimalPage(
            "Invitation Cancelled",
            "<h1>Invitation cancelled</h1><p class='muted'>No account was linked. You may close this tab.</p>",
          ),
          MINIMAL_DEVICE_CSP,
          { "Set-Cookie": clearInviteCookie },
        );
        return true;
      }

      const bound = db.consumeInviteAndBindIdentity({
        orgId,
        codeHash: pendingTx.inviteCodeHash,
        nowIso: new Date().toISOString(),
        identityId: `oid_${crypto.randomBytes(8).toString("hex")}`,
        issuer: pendingTx.issuer,
        subject: pendingTx.subject,
        email: pendingTx.email,
        displayName: pendingTx.displayName,
      });
      if (!bound) {
        sendHtml(
          res,
          403,
          renderMinimalPage(
            "Invite Invalid",
            "<h1>Unable to redeem invitation</h1><p class='muted'>Invite code is invalid, expired, revoked, already used, or the account is disabled.</p>",
          ),
          MINIMAL_DEVICE_CSP,
          { "Set-Cookie": clearInviteCookie },
        );
        return true;
      }

      this.issuePostAuthResponse({
        res,
        db,
        orgId,
        uiSessions,
        identity: bound,
        flow: pendingTx.flow,
        returnTo: pendingTx.returnTo,
        deviceUserCode: pendingTx.deviceUserCode,
        authTimeSec: pendingTx.authTimeSec,
        isSecure,
        extraClearCookies: [clearInviteCookie],
      });
      return true;
    }

    // ---- 3. Self-Issued Device-Code Start (JSON-only, no Origin/cross-site, per-IP quota!) ----
    if (pathname === "/_meru/device/start" && method === "POST") {
      // Block browser cross-site / form-based abuse (CLI never sends Origin)
      const secFetchSite =
        typeof req.headers["sec-fetch-site"] === "string"
          ? req.headers["sec-fetch-site"].trim().toLowerCase()
          : "";
      if (req.headers.origin !== undefined || secFetchSite === "cross-site") {
        sendOidcJson(res, 403, {
          error: "forbidden",
          message: "Device login start is restricted to non-browser CLI clients.",
        });
        return true;
      }
      const ct = (req.headers["content-type"] ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (ct !== "application/json") {
        sendOidcJson(res, 415, {
          error: "invalid_input",
          message: "Content-Type must be application/json",
        });
        return true;
      }

      const remoteIp = extractClientIp(req);
      let ipPendingCount = 0;
      for (const entry of this.deviceCodesByHash.values()) {
        if (entry.remoteIp === remoteIp && entry.status === "pending") {
          ipPendingCount += 1;
        }
      }
      if (
        ipPendingCount >= MAX_PENDING_DEVICE_PER_IP ||
        this.deviceCodesByHash.size >= MAX_PENDING_DEVICE_CODES_GLOBAL
      ) {
        sendOidcJson(res, 429, {
          error: "invalid_input",
          message:
            "Too many pending device login sessions from this source; wait for existing codes to complete or expire.",
        });
        return true;
      }

      const body = await readFormOrJsonBody(req, { jsonOnly: true });
      const hostname = sanitizeDeviceMetadata(body.hostname, "unknown-host", 64);
      const clientLabel = sanitizeDeviceMetadata(
        body.clientLabel,
        "meru-mind-cli",
        48,
      );
      const rawKind = (body.kind ?? "human").trim().toLowerCase();
      if (rawKind !== "human" && rawKind !== "agent") {
        sendOidcJson(res, 400, {
          error: "invalid_input",
          message: 'Device login kind must be "human" or "agent"',
        });
        return true;
      }
      const requestedKind: "human" | "agent" = rawKind;

      const deviceCode = crypto.randomBytes(32).toString("hex");
      const deviceCodeHash = hashAuthToken(deviceCode);
      let userCode = formatUserCode();
      while (this.deviceHashByUserCode.has(userCode)) {
        userCode = formatUserCode();
      }
      const nowMs = Date.now();
      this.deviceCodesByHash.set(deviceCodeHash, {
        deviceCodeHash,
        userCode,
        orgId,
        remoteIp,
        hostname,
        clientLabel,
        requestedKind,
        status: "pending",
        mintedToken: null,
        mintedTokenId: null,
        approvedActorId: null,
        approvedActorKind: null,
        mintedExpiresAt: null,
        createdAtMs: nowMs,
        createdAtIso: new Date(nowMs).toISOString(),
        expiresAtMs: nowMs + DEVICE_CODE_TTL_MS,
      });
      this.deviceHashByUserCode.set(userCode, deviceCodeHash);

      const verificationUri = `${publicBase}/_meru/device`;
      const verificationUriComplete = `${verificationUri}?code=${encodeURIComponent(userCode)}`;
      sendOidcJson(res, 200, {
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete,
        expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
        interval: 2,
      });
      return true;
    }

    // ---- 4. Self-Issued Device-Code Poll (single-use RAM pickup, immediate wipe) ----
    if (pathname === "/_meru/device/poll" && method === "POST") {
      const body = await readFormOrJsonBody(req);
      const rawDeviceCode = (body.deviceCode ?? "").trim();
      if (!rawDeviceCode) {
        sendOidcJson(res, 400, {
          error: "invalid_input",
          message: "deviceCode is required",
        });
        return true;
      }
      const hash = hashAuthToken(rawDeviceCode);
      const entry = this.deviceCodesByHash.get(hash);
      if (!entry || entry.orgId !== orgId || entry.expiresAtMs <= Date.now()) {
        if (entry) {
          if (entry.status === "approved" && entry.mintedTokenId) {
            try {
              db.revokeToken(entry.orgId, entry.mintedTokenId, new Date().toISOString());
            } catch {
              // ignore
            }
          }
          entry.mintedToken = null;
          this.deviceCodesByHash.delete(hash);
          this.deviceHashByUserCode.delete(entry.userCode);
        }
        sendOidcJson(res, 200, { status: "expired_token" });
        return true;
      }
      if (entry.status === "pending") {
        sendOidcJson(res, 200, {
          status: "authorization_pending",
          interval: 2,
        });
        return true;
      }
      if (entry.status === "denied") {
        this.deviceCodesByHash.delete(hash);
        this.deviceHashByUserCode.delete(entry.userCode);
        sendOidcJson(res, 200, { status: "access_denied" });
        return true;
      }
      // Approved: deliver plaintext token ONCE and immediately wipe from RAM!
      const payload = {
        status: "approved",
        token: entry.mintedToken,
        tokenId: entry.mintedTokenId,
        actorId: entry.approvedActorId,
        actorKind: entry.approvedActorKind,
        expiresAt: entry.mintedExpiresAt,
        orgId: entry.orgId,
      };
      entry.mintedToken = null;
      this.deviceCodesByHash.delete(hash);
      this.deviceHashByUserCode.delete(entry.userCode);
      sendOidcJson(res, 200, payload);
      return true;
    }

    // ---- 5. Minimal Server-Rendered Device Confirmation Page (NEVER trusts UI cookie, Referrer-Policy: same-origin!) ----
    if (pathname === "/_meru/device" && method === "GET") {
      const secFetchSite =
        typeof req.headers["sec-fetch-site"] === "string"
          ? req.headers["sec-fetch-site"].trim().toLowerCase()
          : "";
      // Anti-phishing: cross-site links cannot prefill the code automatically
      const rawCode =
        secFetchSite === "cross-site" ? null : url.searchParams.get("code");
      const userCode = normalizeUserCode(rawCode);
      const freshTx = this.readFreshDeviceAuthTx(req, orgId, isSecure);

      // NEVER inspect meru_session / __Host-meru_session here!
      if (!freshTx) {
        const ssoStartUrl = userCode
          ? `/_meru/oidc/login?flow=device&code=${encodeURIComponent(userCode)}`
          : "/_meru/oidc/login?flow=device";
        // P1-5: Manual code form submits same-origin GET /_meru/device (NOT /_meru/oidc/login which 302s cross-origin under form-action 'self'!)
        const bodyHtml = userCode
          ? `<h1>Verify CLI Login</h1>
             <p class="muted">Confirm code below matches your terminal, then complete a fresh SSO sign-in.</p>
             <div class="code-box">${escapeHtml(userCode)}</div>
             <div class="actions"><a class="btn primary" href="${escapeHtml(ssoStartUrl)}">Verify with SSO</a></div>`
          : `<h1>Verify CLI Login</h1>
             <p class="muted">Enter the 8-character code displayed in your terminal, then verify with SSO.</p>
             <form method="GET" action="/_meru/device">
               <input class="text" type="text" name="code" placeholder="ABCD-1234" required autocomplete="off">
               <div class="actions"><button class="btn primary" type="submit">Continue</button></div>
             </form>`;
        sendHtml(
          res,
          200,
          renderMinimalPage("Verify CLI Login", bodyHtml),
          MINIMAL_DEVICE_CSP,
          undefined,
          "same-origin",
        );
        return true;
      }

      // If freshTx is already bound to a specific userCode, URL param MUST NOT override it!
      if (freshTx.userCode && userCode && freshTx.userCode !== userCode) {
        sendHtml(
          res,
          403,
          renderMinimalPage(
            "Code Mismatch",
            "<h1>Verification code mismatch</h1><p class='muted'>The URL code does not match the device code you verified with SSO.</p>",
          ),
          MINIMAL_DEVICE_CSP,
          undefined,
          "same-origin",
        );
        return true;
      }

      const effectiveCode = freshTx.userCode || userCode || "";
      if (!effectiveCode) {
        const bodyHtml = `<h1>Enter Device Code</h1>
          <p class="muted">Signed in as <strong>${escapeHtml(freshTx.actorId)}</strong>. Enter the code from your terminal:</p>
          <form method="GET" action="/_meru/device">
            <input class="text" type="text" name="code" placeholder="ABCD-1234" required autocomplete="off">
            <div class="actions"><button class="btn primary" type="submit">Continue</button></div>
          </form>`;
        sendHtml(
          res,
          200,
          renderMinimalPage("Enter Device Code", bodyHtml),
          MINIMAL_DEVICE_CSP,
          undefined,
          "same-origin",
        );
        return true;
      }

      const deviceHash = this.deviceHashByUserCode.get(effectiveCode);
      const pending = deviceHash
        ? this.deviceCodesByHash.get(deviceHash)
        : undefined;
      if (
        !pending ||
        pending.status !== "pending" ||
        pending.expiresAtMs <= Date.now()
      ) {
        freshTx.failedLookups += 1;
        if (freshTx.failedLookups >= MAX_DEVICE_CODE_MISSES_PER_TX) {
          this.freshDeviceAuthTx.delete(freshTx.tokenHash);
        }
        sendHtml(
          res,
          404,
          renderMinimalPage(
            "Invalid Device Code",
            `<h1>Code not found or expired</h1><p class="muted">Code <strong>${escapeHtml(effectiveCode)}</strong> is invalid or expired. Re-run <code>meru-mind login</code> in your terminal.</p>`,
          ),
          MINIMAL_DEVICE_CSP,
          undefined,
          "same-origin",
        );
        return true;
      }

      const bodyHtml = `<h1>Authorize CLI Device</h1>
        <p class="muted">Verify this code matches the terminal where you ran <code>meru-mind login</code>.</p>
        <div class="code-box">${escapeHtml(pending.userCode)}</div>
        <div class="meta">
          <div><span>Account</span><span>${escapeHtml(freshTx.actorId)} (${escapeHtml(freshTx.actorKind)})</span></div>
          <div><span>Request IP</span><span>${escapeHtml(pending.remoteIp)}</span></div>
          <div><span>Requested At</span><span>${escapeHtml(pending.createdAtIso)}</span></div>
          <div><span>Host (self-reported)</span><span>${escapeHtml(pending.hostname)}</span></div>
          <div><span>Client (self-reported)</span><span>${escapeHtml(pending.clientLabel)}</span></div>
          <div><span>Token Kind</span><span>${escapeHtml(pending.requestedKind)} (${this.config.tokenTtlDays}d)</span></div>
        </div>
        <p class="muted warn">Host and client labels are self-reported by the CLI and unverified. Only approve if you started this command yourself.</p>
        <div class="actions">
          <form method="POST" action="/_meru/device/deny" style="flex:1;display:flex">
            <input type="hidden" name="code" value="${escapeHtml(pending.userCode)}">
            <input type="hidden" name="csrf" value="${escapeHtml(freshTx.csrfToken)}">
            <button class="btn secondary" type="submit">Deny</button>
          </form>
          <form method="POST" action="/_meru/device/approve" style="flex:1;display:flex">
            <input type="hidden" name="code" value="${escapeHtml(pending.userCode)}">
            <input type="hidden" name="csrf" value="${escapeHtml(freshTx.csrfToken)}">
            <button class="btn primary" type="submit">Approve Device</button>
          </form>
        </div>`;
      // P0-1: Referrer-Policy: same-origin ensures real Chromium sends Origin: <same-origin> (NOT Origin: null) on form POST!
      sendHtml(
        res,
        200,
        renderMinimalPage("Authorize CLI Device", bodyHtml),
        MINIMAL_DEVICE_CSP,
        undefined,
        "same-origin",
      );
      return true;
    }

    // ---- 6. Explicit Device Approve / Deny (STRICTLY requires fresh meru_device_tx + same-origin POST!) ----
    if (
      (pathname === "/_meru/device/approve" ||
        pathname === "/_meru/device/deny") &&
      method === "POST"
    ) {
      if (!isSameOriginBrowserPost(req, params.allowedOrigins)) {
        sendHtml(
          res,
          403,
          renderMinimalPage(
            "Forbidden",
            "<h1>Cross-origin request rejected</h1>",
          ),
          MINIMAL_DEVICE_CSP,
        );
        return true;
      }

      // CRITICAL SECURITY INVARIANT: ONLY accept fresh meru_device_tx cookie (NEVER UI session cookie!)
      const freshTx = this.readFreshDeviceAuthTx(req, orgId, isSecure);
      if (!freshTx) {
        sendHtml(
          res,
          401,
          renderMinimalPage(
            "Fresh Verification Required",
            "<h1>Fresh SSO verification required</h1><p class='muted'>Browser UI sessions cannot approve CLI tokens directly. Please verify with SSO again.</p>",
          ),
          MINIMAL_DEVICE_CSP,
        );
        return true;
      }

      const body = await readFormOrJsonBody(req);
      const submittedCsrf = (body.csrf ?? "").trim();
      const userCode = normalizeUserCode(body.code);
      if (
        !submittedCsrf ||
        !constantTimeEqualHex(submittedCsrf, freshTx.csrfToken) ||
        !userCode ||
        (freshTx.userCode && freshTx.userCode !== userCode)
      ) {
        sendHtml(
          res,
          403,
          renderMinimalPage(
            "Invalid Request",
            "<h1>Invalid confirmation token or code mismatch</h1>",
          ),
          MINIMAL_DEVICE_CSP,
        );
        return true;
      }

      // Single-use fresh verification cookie: consume and clear immediately!
      this.freshDeviceAuthTx.delete(freshTx.tokenHash);
      const clearDeviceTx = this.buildTxCookie(
        isSecure ? DEVICE_HOST_TX_COOKIE_NAME : DEVICE_TX_COOKIE_NAME,
        "",
        "/_meru/device",
        "Strict",
        0,
        isSecure,
      );

      const identityNow = db.getIdentityBySubject(
        orgId,
        freshTx.issuer,
        freshTx.subject,
      );
      if (
        db.isActorDisabled(orgId, freshTx.actorId) ||
        (identityNow && identityNow.disabledAt !== null)
      ) {
        sendHtml(
          res,
          403,
          renderMinimalPage(
            "Account Disabled",
            "<h1>Account disabled</h1><p class='muted'>This account has been disabled by an administrator.</p>",
          ),
          MINIMAL_DEVICE_CSP,
          { "Set-Cookie": clearDeviceTx },
        );
        return true;
      }

      const deviceHash = this.deviceHashByUserCode.get(userCode);
      const pending = deviceHash
        ? this.deviceCodesByHash.get(deviceHash)
        : undefined;
      if (
        !pending ||
        pending.orgId !== orgId ||
        pending.status !== "pending" ||
        pending.expiresAtMs <= Date.now()
      ) {
        sendHtml(
          res,
          404,
          renderMinimalPage(
            "Expired Code",
            "<h1>Device code invalid or expired</h1>",
          ),
          MINIMAL_DEVICE_CSP,
          { "Set-Cookie": clearDeviceTx },
        );
        return true;
      }

      if (pathname === "/_meru/device/deny") {
        pending.status = "denied";
        sendHtml(
          res,
          200,
          renderMinimalPage(
            "Device Denied",
            "<h1>CLI authorization denied</h1><p class='muted'>You may close this tab.</p>",
          ),
          MINIMAL_DEVICE_CSP,
          { "Set-Cookie": clearDeviceTx },
        );
        return true;
      }

      // Prevent privilege escalation: an agent-bound identity can NEVER mint a human token!
      if (freshTx.actorKind === "agent" && pending.requestedKind === "human") {
        sendHtml(
          res,
          403,
          renderMinimalPage(
            "Forbidden",
            "<h1>Insufficient role</h1><p class='muted'>Agent identities cannot mint human tokens.</p>",
          ),
          MINIMAL_DEVICE_CSP,
          { "Set-Cookie": clearDeviceTx },
        );
        return true;
      }

      const ttlDays = this.config.tokenTtlDays ?? DEFAULT_SSO_TOKEN_TTL_DAYS;
      const minted = createAuthToken({
        db,
        orgId,
        actorId: freshTx.actorId,
        actorKind: pending.requestedKind,
        boundRealmId: freshTx.boundRealmId,
        label: `device:${pending.hostname}:${pending.clientLabel}`.slice(0, 80),
        createdBy: `oidc-device:${freshTx.actorId}`,
        ttlDays,
      });
      if (!minted.record.expiresAt) {
        throw new MindError(
          "INVALID_INPUT",
          "Device-minted tokens must always have an expiration date",
        );
      }

      pending.status = "approved";
      pending.mintedToken = minted.token;
      pending.mintedTokenId = minted.record.id;
      pending.approvedActorId = minted.record.actorId;
      pending.approvedActorKind = minted.record.actorKind;
      pending.mintedExpiresAt = minted.record.expiresAt;

      sendHtml(
        res,
        200,
        renderMinimalPage(
          "Device Authorized",
          `<h1>Device authorized</h1><p class="muted">Issued a ${ttlDays}-day <code>${escapeHtml(minted.record.actorKind)}</code> token for <strong>${escapeHtml(pending.hostname)}</strong>. Return to your terminal — you may close this tab.</p>`,
        ),
        MINIMAL_DEVICE_CSP,
        { "Set-Cookie": clearDeviceTx },
      );
      return true;
    }

    return false;
  }
}
