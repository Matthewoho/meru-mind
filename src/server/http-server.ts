import crypto from "node:crypto";
import fs from "node:fs";
import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toSurfaceError } from "../format/errors.js";
import {
  createMindEngine,
  resolveDefaultHomeDir,
  type MindEngine,
} from "../index.js";
import type { EmbedderPort } from "../ports.js";
import { LocalMindSurface } from "../surface-local.js";
import type {
  MindSurface,
  SurfaceAddRuleInput,
  SurfaceCreateObjectInput,
  SurfaceCreateRealmInput,
  SurfaceUpdateRealmInput,
  SurfaceCreateTokenInput,
  SurfaceDeleteObjectInput,
  SurfaceLinkObjectInput,
  SurfaceMountRealmInput,
  SurfaceMoveInput,
  SurfaceMoveObjectInput,
  SurfaceRawAddInput,
  SurfaceRedactInput,
  SurfaceSetObjectStateInput,
  SurfaceUnlinkObjectInput,
  SurfaceUpdateObjectAliasesInput,
  SurfaceWriteInput,
} from "../surface.js";
import {
  MindError,
  type ActorRole,
  type ImportBatchInput,
  type LsOnlyFilter,
  type OidcConfig,
  type OrgPolicy,
  type Principal,
  type TokenWriteScope,
  type VerifyImportInput,
} from "../types.js";
import { MERU_MIND_VERSION } from "../version.js";
import { createSurfaceMcpServer } from "./mcp-http.js";
import { seedDemoOrg, type DemoSeedSummary } from "./demo-seed.js";
import { withLivePulse } from "./live-pulse.js";
import {
  createInvite,
  loadOidcConfigFromEnv,
  OidcManager,
  toPublicInvite,
} from "./oidc.js";
import { MindPulseStore, sanitizeClientHint } from "./pulse.js";
import { ChangeWakeBus } from "./pump.js";
import {
  createAuthToken,
  resolvePrincipalFromToken,
  sanitizeDisplayName,
  TokenTouchThrottle,
  type CreateAuthTokenResult,
} from "./tokens.js";
import { UiSessionManager } from "./ui-auth.js";
import { assertWebDirAllowed, createUiRouteHandler } from "./ui-router.js";
import {
  acquireServeWriterLock,
  type ServeWriterLockHandle,
} from "./writer-lock.js";
import {
  attachPumpWebSocketServer,
  isOriginAllowed,
  type PumpWsHandle,
} from "./ws-pump.js";
import { WorkProviderRegistry } from "../work/registry.js";

export const SERVER_VERSION = MERU_MIND_VERSION;
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

function assertCookieCsrfAllowed(params: {
  req: IncomingMessage;
  method: string;
  principal: Principal;
  allowedOrigins?: string[];
}): void {
  if (params.principal.authKind !== "cookie") return;
  if (
    params.method === "GET" ||
    params.method === "HEAD" ||
    params.method === "OPTIONS"
  ) {
    return;
  }
  const rawCt = params.req.headers["content-type"] ?? "";
  const mediaType = rawCt.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json") {
    throw new MindError(
      "ACCESS_DENIED",
      "Cookie-authenticated write requests require Content-Type: application/json",
    );
  }
  if (
    !isOriginAllowed({
      originHeader: params.req.headers.origin,
      hostHeader: params.req.headers.host,
      allowedOrigins: params.allowedOrigins,
    })
  ) {
    throw new MindError(
      "ACCESS_DENIED",
      "Cross-origin or missing-Origin Cookie write rejected",
    );
  }
}

export interface AccessLogEntry {
  timestamp: string;
  method: string;
  /** Strictly pathname ONLY — query strings are NEVER logged to prevent secret/query leakage */
  pathname: string;
  statusCode: number;
  durationMs: number;
  actorId: string | null;
}

export interface MindServerOptions {
  homeDir?: string;
  host?: string;
  port?: number;
  orgId?: string;
  enableVector?: boolean;
  embedder?: EmbedderPort;
  /** Optional loopback-only custom UI directory (--web-dir). Refused on non-loopback hosts in v0.4. */
  webDir?: string;
  /** Optional explicit WebSocket Origin allowlist (defaults to same-host origin) */
  allowedOrigins?: string[];
  /** Seed demo org with rule-tail sentinel, stored-XSS probe, redacted tombstone, unknown extKind & inbox item */
  demo?: boolean;
  /** Optional custom WorkProviderRegistry (defaults to official Linear + GitHub static registry) */
  workRegistry?: WorkProviderRegistry;
  /**
   * Emit a stateless random UUID `Mcp-Session-Id` response header on `POST /mcp` JSON-RPC `initialize`
   * requests that omit `Mcp-Session-Id`, allowing multi-connection clients to separate MindPulse sessions
   * automatically without server-side session state or 404s. Defaults to true unless disabled here or via
   * `MERU_MIND_MCP_SESSION_HEADER=false`.
   */
  mcpSessionHeader?: boolean;
  /** Optional standard OIDC SSO configuration (defaults to MERU_OIDC_* env vars; pass false to disable) */
  oidc?: OidcConfig | false;
  /** Custom access logger (pass false to disable stderr logging in tests) */
  accessLog?: ((entry: AccessLogEntry) => void) | false;
  /** Optional custom request hook invoked for non-/v1, non-/mcp paths (used by v0.4 Web UI shell) */
  extraRouteHandler?: (params: {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    engine: MindEngine;
    orgId: string;
    wakeBus: ChangeWakeBus;
    authenticate: (
      req: IncomingMessage,
      options?: { allowCookie?: boolean },
    ) => Principal;
    createSurface: (principal: Principal, req: IncomingMessage) => MindSurface;
  }) => Promise<boolean>;
  /** Optional custom Cookie/session principal resolver (used by v0.4 HttpOnly Cookie auth) */
  cookieAuthenticator?: (req: IncomingMessage, orgId: string) => Principal | null;
}

export interface MindServerHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly homeDir: string;
  readonly orgId: string;
  readonly engine: MindEngine;
  readonly wakeBus: ChangeWakeBus;
  readonly pulseStore: MindPulseStore;
  readonly uiSessions: UiSessionManager;
  readonly oidcManager: OidcManager | null;
  readonly demoSeed?: DemoSeedSummary;
  readonly httpServer: http.Server;
  createToken(params: {
    actorId: string;
    actorKind: "human" | "agent";
    actorFamily?: string | null;
    actorRole?: ActorRole;
    boundRealmId?: string | null;
    writeScope?: TokenWriteScope;
    label?: string | null;
    createdBy?: string;
    ttlDays?: number | null;
    expiresAt?: string | null;
  }): CreateAuthTokenResult;
  mintUiLoginCode(principal: Principal): {
    code: string;
    loginUrl: string;
    expiresAt: string;
  };
  close(): Promise<void>;
}

function httpStatusForError(err: unknown): number {
  if (err instanceof MindError) {
    switch (err.code) {
      case "ACCESS_DENIED":
      case "RULE_REQUIRES_HUMAN":
      case "SLICE_VIOLATION":
      case "FORBIDDEN_HOME_PATH":
        return 403;
      case "NOT_FOUND":
        return 404;
      case "CONFLICT":
      case "VERDICT_INVARIANT":
      case "IDEMPOTENCY_MISMATCH":
        return 409;
      default:
        return 400;
    }
  }
  return 500;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(extraHeaders ?? {}),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new MindError(
        "INVALID_INPUT",
        `Request body exceeds ${MAX_JSON_BODY_BYTES} byte limit`,
      );
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MindError("INVALID_INPUT", "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MindError("INVALID_INPUT", "Request JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function parseOptionalInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new MindError("INVALID_INPUT", `Invalid integer parameter: "${raw}"`);
  }
  return n;
}

function parseOptionalBool(raw: string | null): boolean | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const low = raw.trim().toLowerCase();
  if (low === "true" || low === "1") return true;
  if (low === "false" || low === "0") return false;
  throw new MindError("INVALID_INPUT", `Invalid boolean parameter: "${raw}"`);
}

function parseOptionalDepth(raw: string | null): number | "all" | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  if (raw.trim().toLowerCase() === "all") return "all";
  const n = parseOptionalInt(raw);
  if (n === undefined || n < 0) {
    throw new MindError("INVALID_INPUT", `Invalid depth parameter: "${raw}"`);
  }
  return n;
}

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Starts the single-writer Meru Mind HTTP + Streamable HTTP MCP server (`meru-mind serve`).
 * Enforces:
 * - Exclusive writer lock (`<homeDir>/mind.serve.lock`) blocking local direct SQLite bypasses
 * - Single organization per server instance
 * - Hashed token auth with server-authoritative Principal (`actor.kind` fixed at issuance)
 * - Pump Model + Long-Poll (`GET /v1/changes?since=...&wait=25`)
 * - Streamable HTTP MCP (`POST /mcp`) exposing strictly the 7 everyday tools
 * - Redacted access logs (pathname only; never logs query strings, tokens, cookies, or bodies)
 */
export async function startMindServer(
  options: MindServerOptions = {},
): Promise<MindServerHandle> {
  const homeDir = options.homeDir ?? resolveDefaultHomeDir();
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3800;

  // Guardrail #6: validate loopback-only --web-dir BEFORE acquiring lock or opening DB
  const resolvedWebDir = assertWebDirAllowed(options.webDir, host);

  // Acquire exclusive single-writer lock BEFORE opening SQLite
  let lockHandle: ServeWriterLockHandle = acquireServeWriterLock({
    homeDir,
    url: `http://${formatHostForUrl(host)}:${requestedPort}`,
  });

  let engine: MindEngine | null = null;
  let unsubChangeLog: (() => void) | null = null;
  let detachWs: PumpWsHandle | null = null;
  let oidcManager: OidcManager | null = null;

  try {
    engine = await createMindEngine({
      homeDir,
      enableVector: options.enableVector ?? true,
      embedder: options.embedder,
      isServerOwner: true,
    });

    // Enforce single-org per server instance
    const orgs = engine.ledger.listOrgs();
    let orgId: string;
    if (options.orgId) {
      const found = engine.db.getOrg(options.orgId);
      if (!found) {
        throw new MindError("NOT_FOUND", `Organization not found: ${options.orgId}`);
      }
      orgId = found.id;
    } else if (orgs.length === 0) {
      const created = engine.ledger.createOrg({
        name: options.demo ? "Meru Demo" : "Default",
        isPersonalRoot: true,
        policy: "open",
      });
      orgId = created.org.id;
    } else if (orgs.length === 1) {
      orgId = orgs[0]!.id;
    } else {
      throw new MindError(
        "NOT_BOUND",
        `Multiple organizations exist in "${homeDir}"; pass --org <orgId> (Meru Mind serve hosts one organization per instance).`,
      );
    }

    const demoSeed = options.demo
      ? await seedDemoOrg(engine, orgId)
      : undefined;

    const wakeBus = new ChangeWakeBus();
    const workRegistry =
      options.workRegistry ?? WorkProviderRegistry.createDefault();
    const pulseStore = new MindPulseStore();
    const pulseSnapshotPath = path.join(homeDir, "pulse-snapshot.json");
    pulseStore.loadSnapshot(pulseSnapshotPath);
    const touchThrottle = new TokenTouchThrottle();
    const inFlightImportTokens = new Set<string>();
    const uiSessions = new UiSessionManager();
    const resolvedOidcConfig =
      options.oidc === false ? null : (options.oidc ?? loadOidcConfigFromEnv());
    oidcManager = resolvedOidcConfig
      ? new OidcManager(resolvedOidcConfig)
      : null;
    const serverUrlRef = { value: `http://${formatHostForUrl(host)}:${requestedPort}` };
    const configuredPublicBaseUrl = (() => {
      const raw = process.env.MERU_MIND_PUBLIC_URL?.trim();
      if (!raw) return null;
      try {
        const parsed = new URL(raw);
        if (
          (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
          parsed.username ||
          parsed.password
        ) {
          return null;
        }
        return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
      } catch {
        return null;
      }
    })();
    const builtInUiHandler = createUiRouteHandler({
      uiSessions,
      webDir: resolvedWebDir,
      allowedOrigins: options.allowedOrigins,
      oidcManager,
      getServerUrl: () => serverUrlRef.value,
      publicBaseUrl: configuredPublicBaseUrl,
    });

    unsubChangeLog = engine.db.onChangeCommitted((events) =>
      wakeBus.notifyEvents(events),
    );

    const resolveCookiePrincipal = (req: IncomingMessage): Principal | null => {
      if (options.cookieAuthenticator) {
        const custom = options.cookieAuthenticator(req, orgId);
        if (custom) return custom;
      }
      return uiSessions.authenticateRequest(req, engine!.db, orgId);
    };

    const authenticate = (
      req: IncomingMessage,
      authOpts?: { allowCookie?: boolean; skipTouchLastUsed?: boolean },
    ): Principal => {
      const bearer = extractBearerToken(req);
      if (bearer) {
        return resolvePrincipalFromToken({
          db: engine!.db,
          plaintextToken: bearer,
          expectedOrgId: orgId,
          authKind: "bearer",
          skipTouchLastUsed: authOpts?.skipTouchLastUsed,
          touchThrottle,
        });
      }
      if (authOpts?.allowCookie !== false) {
        const cookiePrincipal = resolveCookiePrincipal(req);
        if (cookiePrincipal) {
          return cookiePrincipal;
        }
      }
      throw new MindError(
        "ACCESS_DENIED",
        "Missing or invalid authentication credentials",
        {
          try: "Pass Authorization: Bearer <MERU_MIND_TOKEN> or run 'meru-mind login'",
        },
      );
    };

    const enableMcpSessionHeader =
      options.mcpSessionHeader ??
      !["false", "0", "off", "no"].includes(
        (process.env.MERU_MIND_MCP_SESSION_HEADER ?? "").trim().toLowerCase(),
      );

    const extractPulseMeta = (
      req: IncomingMessage,
      workspaceHint: string | null,
      fallbackSessionId?: string | null,
    ): {
      sessionTag: string;
      parentSessionTag: string | null;
      clientHint: string | null;
    } => {
      const rawClient = req.headers["x-meru-client"];
      const clientHint = sanitizeClientHint(
        typeof rawClient === "string" ? rawClient : null,
      );
      const rawParent = req.headers["x-meru-parent-session-id"];
      const parentSessionTag =
        typeof rawParent === "string" && rawParent.trim()
          ? rawParent.trim()
          : null;
      const rawSession =
        req.headers["x-meru-session-id"] ??
        req.headers["mcp-session-id"] ??
        fallbackSessionId;
      const headerSession =
        typeof rawSession === "string" && rawSession.trim()
          ? rawSession.trim()
          : null;
      if (headerSession) {
        return { sessionTag: headerSession, parentSessionTag, clientHint };
      }
      if (clientHint || workspaceHint) {
        const fallback = [clientHint ?? "client", workspaceHint ?? ""]
          .filter(Boolean)
          .join(":");
        return {
          sessionTag: fallback.slice(0, 64),
          parentSessionTag,
          clientHint,
        };
      }
      return { sessionTag: "default", parentSessionTag, clientHint };
    };

    const createSurface = (
      principal: Principal,
      req: IncomingMessage,
      surfaceOpts?: { fallbackSessionId?: string | null },
    ): MindSurface => {
      const rawHint = req.headers["x-meru-workspace-hint"];
      const workspaceHint =
        typeof rawHint === "string" && rawHint.trim() ? rawHint.trim() : null;
      const localSurface = new LocalMindSurface({
        engine: engine!,
        principal,
        wakeBus,
        workRegistry,
        defaultWorkspaceHint: workspaceHint,
        storeDescriptor: {
          path: serverUrlRef.value,
          localOnly: false,
        },
        ownsEngine: false,
      });
      const { sessionTag, parentSessionTag, clientHint } = extractPulseMeta(
        req,
        workspaceHint,
        surfaceOpts?.fallbackSessionId,
      );
      return withLivePulse(localSurface, {
        db: engine!.db,
        pulseStore,
        principal,
        sessionTag,
        parentSessionTag,
        clientHint,
      });
    };

    const logAccess = (entry: AccessLogEntry): void => {
      if (options.accessLog === false) return;
      if (typeof options.accessLog === "function") {
        options.accessLog(entry);
        return;
      }
      // Strictly log pathname ONLY — NEVER query string, headers, or body
      process.stderr.write(
        `[meru-mind serve] ${entry.method} ${entry.pathname} ${entry.statusCode} ${entry.durationMs}ms actor=${entry.actorId ?? "-"}\n`,
      );
    };

    const httpServer = http.createServer(async (req, res) => {
      const t0 = performance.now();
      const method = (req.method ?? "GET").toUpperCase();
      const rawUrl = req.url ?? "/";
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl, "http://localhost");
      } catch {
        sendJson(res, 400, {
          error: "invalid_input",
          message: "Malformed request URL",
        });
        return;
      }

      const pathname = parsedUrl.pathname;
      let actorId: string | null = null;

      res.on("finish", () => {
        logAccess({
          timestamp: new Date().toISOString(),
          method,
          pathname,
          statusCode: res.statusCode,
          durationMs: Math.round(performance.now() - t0),
          actorId,
        });
      });

      try {
        // Unauthenticated liveness probe (zero org/corpus leakage)
        if (method === "GET" && pathname === "/v1/health") {
          sendJson(res, 200, { ok: true, version: SERVER_VERSION });
          return;
        }

        // Streamable HTTP MCP endpoint (/mcp) — Bearer token auth only, strictly 7 tools, POST only
        if (pathname === "/mcp") {
          if (method !== "POST") {
            sendJson(
              res,
              405,
              {
                error: "invalid_input",
                message: "Streamable HTTP MCP endpoint accepts POST only",
              },
              { Allow: "POST" },
            );
            return;
          }
          const principal = authenticate(req, { allowCookie: false });
          actorId = principal.actor.id;
          const parsedBody = await readJsonBody(req);
          const incomingMcpSession =
            typeof req.headers["mcp-session-id"] === "string"
              ? req.headers["mcp-session-id"].trim()
              : "";
          const isInitializeCall = parsedBody.method === "initialize";
          let issuedMcpSessionId: string | null = null;
          if (enableMcpSessionHeader && isInitializeCall && !incomingMcpSession) {
            issuedMcpSessionId = crypto.randomUUID();
            res.setHeader("Mcp-Session-Id", issuedMcpSessionId);
          }
          const surface = createSurface(principal, req, {
            fallbackSessionId: issuedMcpSessionId,
          });
          const mcpServer = createSurfaceMcpServer(surface);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          await mcpServer.connect(transport);
          try {
            await transport.handleRequest(req, res, parsedBody);
          } finally {
            await transport.close();
            await mcpServer.close();
            await surface.close();
          }
          return;
        }

        // REST API under /v1/*
        if (pathname.startsWith("/v1/")) {
          const isPulseRoute = pathname === "/v1/pulse";
          const principal = authenticate(req, {
            allowCookie: true,
            skipTouchLastUsed: isPulseRoute,
          });
          actorId = principal.actor.id;
          // P0 #3: Enforce JSON Content-Type and same-Origin CSRF boundary on Cookie writes
          assertCookieCsrfAllowed({
            req,
            method,
            principal,
            allowedOrigins: options.allowedOrigins,
          });
          const surface = createSurface(principal, req);
          try {
            const sp = parsedUrl.searchParams;

            if (method === "GET" && pathname === "/v1/whoami") {
              const out = await surface.whoami();
              sendJson(res, 200, out, {
                "X-Meru-Latest-Seq": String(out.latestSeq),
              });
              return;
            }

            // ---- v0.6.1 Editable Profile Display Name (Human Bearer OR Cookie with CSRF check) ----
            if (method === "POST" && pathname === "/v1/me/profile") {
              if (principal.actor.kind !== "human") {
                throw new MindError(
                  "ACCESS_DENIED",
                  "Only human principals can update their profile display name.",
                );
              }
              const body = await readJsonBody(req);
              if (
                !body ||
                typeof body !== "object" ||
                Array.isArray(body) ||
                !("displayName" in body) ||
                (body.displayName !== null && typeof body.displayName !== "string")
              ) {
                throw new MindError(
                  "INVALID_INPUT",
                  "displayName must be a string or null",
                );
              }
              const sanitized = sanitizeDisplayName(body.displayName);
              const updated = engine!.db.setActorDisplayName(
                orgId,
                principal.actor.id,
                sanitized,
              );
              sendJson(res, 200, {
                actorId: principal.actor.id,
                displayName: updated.displayName,
                role: updated.role,
              });
              return;
            }

            if (method === "GET" && pathname === "/v1/tree") {
              const out = await surface.tree({
                ref: sp.get("ref") ?? undefined,
                depth: parseOptionalDepth(sp.get("depth")),
                includeObjects: parseOptionalBool(sp.get("objects")),
                limit: parseOptionalInt(sp.get("limit")),
              });
              sendJson(res, 200, out);
              return;
            }

            if (method === "GET" && pathname === "/v1/ls") {
              const onlyRaw = sp.get("only");
              const only =
                onlyRaw &&
                ["realms", "objects", "entries", "files"].includes(onlyRaw)
                  ? (onlyRaw as LsOnlyFilter)
                  : undefined;
              const out = await surface.ls({
                ref: sp.get("ref") ?? undefined,
                only,
                kind: sp.get("kind") ?? undefined,
                about: sp.get("about") ?? undefined,
                since: sp.get("since") ?? undefined,
                until: sp.get("until") ?? undefined,
                history: parseOptionalBool(sp.get("history")),
                includeDescendantSeabed: parseOptionalBool(
                  sp.get("include_descendant_seabed"),
                ),
                limit: parseOptionalInt(sp.get("limit")),
                cursor: sp.get("cursor") ?? undefined,
              });
              sendJson(res, 200, out);
              return;
            }

            if (method === "GET" && pathname === "/v1/show") {
              const ref = sp.get("ref");
              if (!ref) {
                throw new MindError("INVALID_INPUT", 'Query parameter "ref" is required');
              }
              const out = await surface.show({
                ref,
                around: sp.get("around") ?? undefined,
                cursor: sp.get("cursor") ?? undefined,
                chars: parseOptionalInt(sp.get("chars")),
                full: parseOptionalBool(sp.get("full")),
                history: parseOptionalBool(sp.get("history")),
                context: parseOptionalInt(sp.get("context")),
                includeDescendantSeabed: parseOptionalBool(
                  sp.get("include_descendant_seabed"),
                ),
              });
              sendJson(res, 200, out);
              return;
            }

            if (method === "GET" && pathname === "/v1/search") {
              const query = sp.get("query");
              if (!query) {
                throw new MindError(
                  "INVALID_INPUT",
                  'Query parameter "query" is required',
                );
              }
              const out = await surface.search({
                query,
                in: sp.get("in") ?? undefined,
                about: sp.get("about") ?? undefined,
                kind: sp.get("kind") ?? undefined,
                since: sp.get("since") ?? undefined,
                until: sp.get("until") ?? undefined,
                history: parseOptionalBool(sp.get("history")),
                includeDescendantSeabed: parseOptionalBool(
                  sp.get("include_descendant_seabed"),
                ),
                limit: parseOptionalInt(sp.get("limit")),
                cursor: sp.get("cursor") ?? undefined,
              });
              sendJson(res, 200, out);
              return;
            }

            if (method === "GET" && pathname === "/v1/changes") {
              const ac = new AbortController();
              req.on("close", () => ac.abort());
              const out = await surface.changes({
                sinceSeq: parseOptionalInt(sp.get("since")) ?? 0,
                generation: parseOptionalInt(sp.get("generation")),
                in: sp.get("in") ?? undefined,
                limit: parseOptionalInt(sp.get("limit")) ?? 50,
                includeDescendantSeabed: parseOptionalBool(
                  sp.get("include_descendant_seabed"),
                ),
                waitSeconds: parseOptionalInt(sp.get("wait")) ?? 0,
                signal: ac.signal,
              });
              sendJson(res, 200, out, {
                "X-Meru-Latest-Seq": String(out.latestSeq),
              });
              return;
            }

            const chainMatch = /^\/v1\/entry\/([^/]+)\/chain$/.exec(pathname);
            if (method === "GET" && chainMatch) {
              const entryId = decodeURIComponent(chainMatch[1]!);
              const out = await surface.getEntryChain(entryId);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/write") {
              const body = (await readJsonBody(req)) as unknown as SurfaceWriteInput;
              const lastSeqHeader = req.headers["x-meru-last-read-seq"];
              const parsedHeaderSeq =
                typeof lastSeqHeader === "string"
                  ? Number.parseInt(lastSeqHeader, 10)
                  : undefined;
              const out = await surface.write({
                ...body,
                lastReadSeq:
                  body.lastReadSeq ??
                  (Number.isFinite(parsedHeaderSeq) ? parsedHeaderSeq : undefined),
              });
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/raw") {
              const body = (await readJsonBody(req)) as unknown as SurfaceRawAddInput;
              const out = await surface.rawAdd(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/move") {
              const body = (await readJsonBody(req)) as unknown as SurfaceMoveInput;
              const out = await surface.move(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/rules") {
              const body = (await readJsonBody(req)) as unknown as SurfaceAddRuleInput;
              const out = await surface.addRule(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/redact") {
              const body = (await readJsonBody(req)) as unknown as SurfaceRedactInput;
              const out = await surface.redact(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/realms") {
              const body = (await readJsonBody(req)) as unknown as SurfaceCreateRealmInput;
              const out = await surface.createRealm(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/realms/set") {
              const body = (await readJsonBody(req)) as unknown as SurfaceUpdateRealmInput;
              const out = await surface.updateRealm(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/realms/mount") {
              const body = (await readJsonBody(req)) as unknown as SurfaceMountRealmInput;
              const out = await surface.mountRealm(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/realms/unmount") {
              const body = (await readJsonBody(req)) as {
                viewerRef: string;
                targetRef: string;
              };
              const unmounted = await surface.unmountRealm(body);
              sendJson(res, 200, { unmounted });
              return;
            }

            if (method === "POST" && pathname === "/v1/realms/archive") {
              const body = (await readJsonBody(req)) as { ref: string };
              const out = await surface.archiveRealm(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/realms/unarchive") {
              const body = (await readJsonBody(req)) as { ref: string };
              const out = await surface.unarchiveRealm(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/org/policy") {
              const body = (await readJsonBody(req)) as { policy: OrgPolicy };
              const out = await surface.setOrgPolicy(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "GET" && pathname === "/v1/tokens") {
              const out = await surface.listTokens({
                includeRevoked: parseOptionalBool(sp.get("include_revoked")),
              });
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/tokens") {
              const body = (await readJsonBody(req)) as unknown as SurfaceCreateTokenInput;
              const out = await surface.createToken(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/tokens/revoke") {
              const body = (await readJsonBody(req)) as { tokenId: string };
              const revoked = await surface.revokeToken(body);
              sendJson(res, 200, { revoked });
              return;
            }

            // ---- v0.6.5 Remote Object Lifecycle (/v1/objects/*) with strict runtime validation ----
            const reqBodyStr = (
              body: Record<string, unknown>,
              field: string,
            ): string => {
              const v = body[field];
              if (typeof v !== "string" || !v.trim()) {
                throw new MindError(
                  "INVALID_INPUT",
                  `Field "${field}" must be a non-empty string`,
                );
              }
              return v;
            };
            const optBodyStr = (
              body: Record<string, unknown>,
              field: string,
            ): string | undefined => {
              const v = body[field];
              if (v === undefined) return undefined;
              if (typeof v !== "string") {
                throw new MindError(
                  "INVALID_INPUT",
                  `Field "${field}" must be a string`,
                );
              }
              return v;
            };
            const optBodyNullableStr = (
              body: Record<string, unknown>,
              field: string,
            ): string | null | undefined => {
              const v = body[field];
              if (v === undefined || v === null) return v;
              if (typeof v !== "string") {
                throw new MindError(
                  "INVALID_INPUT",
                  `Field "${field}" must be a string or null`,
                );
              }
              return v;
            };
            const optBodyBool = (
              body: Record<string, unknown>,
              field: string,
            ): boolean | undefined => {
              const v = body[field];
              if (v === undefined) return undefined;
              if (typeof v !== "boolean") {
                throw new MindError(
                  "INVALID_INPUT",
                  `Field "${field}" must be a boolean`,
                );
              }
              return v;
            };
            const optBodyStrArray = (
              body: Record<string, unknown>,
              field: string,
            ): string[] | undefined => {
              const v = body[field];
              if (v === undefined) return undefined;
              if (
                !Array.isArray(v) ||
                !v.every((item) => typeof item === "string")
              ) {
                throw new MindError(
                  "INVALID_INPUT",
                  `Field "${field}" must be an array of strings`,
                );
              }
              return v;
            };
            const optBodyNonNegInt = (
              body: Record<string, unknown>,
              field: string,
            ): number | undefined => {
              const v = body[field];
              if (v === undefined) return undefined;
              if (
                typeof v !== "number" ||
                !Number.isInteger(v) ||
                v < 0
              ) {
                throw new MindError(
                  "INVALID_INPUT",
                  `Field "${field}" must be a non-negative integer`,
                );
              }
              return v;
            };

            if (method === "POST" && pathname === "/v1/objects") {
              const raw = await readJsonBody(req);
              const validated: SurfaceCreateObjectInput = {
                in: optBodyStr(raw, "in"),
                kind: reqBodyStr(raw, "kind"),
                name: reqBodyStr(raw, "name"),
                parentRef: optBodyNullableStr(raw, "parentRef"),
                ifNotExists: optBodyBool(raw, "ifNotExists"),
              };
              const out = await surface.createObject(validated);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/objects/move") {
              const raw = await readJsonBody(req);
              const ref = reqBodyStr(raw, "ref");
              if (!("parentRef" in raw)) {
                throw new MindError(
                  "INVALID_INPUT",
                  'Field "parentRef" is required (string or null)',
                );
              }
              const parentRef = optBodyNullableStr(raw, "parentRef") ?? null;
              const validated: SurfaceMoveObjectInput = { ref, parentRef };
              const out = await surface.moveObject(validated);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/objects/delete") {
              const raw = await readJsonBody(req);
              const validated: SurfaceDeleteObjectInput = {
                ref: reqBodyStr(raw, "ref"),
              };
              const removed = await surface.deleteObject(validated);
              sendJson(res, 200, { removed });
              return;
            }

            if (method === "POST" && pathname === "/v1/objects/link") {
              const raw = await readJsonBody(req);
              const validated: SurfaceLinkObjectInput = {
                entryId: reqBodyStr(raw, "entryId"),
                objectRef: reqBodyStr(raw, "objectRef"),
              };
              const out = await surface.linkObject(validated);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/objects/unlink") {
              const raw = await readJsonBody(req);
              const validated: SurfaceUnlinkObjectInput = {
                entryId: reqBodyStr(raw, "entryId"),
                objectRef: reqBodyStr(raw, "objectRef"),
              };
              const removed = await surface.unlinkObject(validated);
              sendJson(res, 200, { removed });
              return;
            }

            if (method === "POST" && pathname === "/v1/objects/state") {
              const raw = await readJsonBody(req);
              const stateRaw = reqBodyStr(raw, "state");
              if (stateRaw !== "active" && stateRaw !== "inactive") {
                throw new MindError(
                  "INVALID_INPUT",
                  'Field "state" must be "active" or "inactive"',
                );
              }
              const validated: SurfaceSetObjectStateInput = {
                ref: reqBodyStr(raw, "ref"),
                state: stateRaw,
                label: optBodyStr(raw, "label"),
                since: optBodyStr(raw, "since"),
                because: optBodyStr(raw, "because"),
              };
              const out = await surface.setObjectState(validated);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/objects/aliases") {
              const raw = await readJsonBody(req);
              const validated: SurfaceUpdateObjectAliasesInput = {
                ref: reqBodyStr(raw, "ref"),
                add: optBodyStrArray(raw, "add"),
                remove: optBodyStrArray(raw, "remove"),
              };
              const out = await surface.updateObjectAliases(validated);
              sendJson(res, 200, out);
              return;
            }

            // ---- v0.6.5 Unified Online Batch Import & Verification (/v1/import/*) ----
            if (method === "POST" && pathname === "/v1/import/batch") {
              const lockKey =
                principal.tokenId ??
                `${principal.authKind}:${principal.orgId}:${principal.actor.id}`;
              if (inFlightImportTokens.has(lockKey)) {
                throw new MindError(
                  "CONFLICT",
                  "Another import batch is already in flight for this token. Wait for it to finish and retry.",
                  { reason: "import_in_flight" },
                );
              }
              inFlightImportTokens.add(lockKey);
              try {
                const raw = await readJsonBody(req);
                if (!Array.isArray(raw.items)) {
                  throw new MindError(
                    "INVALID_INPUT",
                    'Field "items" must be an array',
                  );
                }
                const validated: ImportBatchInput = {
                  items: raw.items as ImportBatchInput["items"],
                  defaultRealmRef: optBodyStr(raw, "defaultRealmRef"),
                  skipSecret: optBodyBool(raw, "skipSecret"),
                  dryRun: optBodyBool(raw, "dryRun"),
                  relocate: optBodyBool(raw, "relocate"),
                };
                const out = await surface.importBatch(validated);
                sendJson(res, 200, out);
              } finally {
                inFlightImportTokens.delete(lockKey);
              }
              return;
            }

            if (method === "POST" && pathname === "/v1/import/verify") {
              const raw = await readJsonBody(req);
              if (!Array.isArray(raw.items)) {
                throw new MindError(
                  "INVALID_INPUT",
                  'Field "items" must be an array',
                );
              }
              const items: VerifyImportInput["items"] = [];
              for (let idx = 0; idx < raw.items.length; idx += 1) {
                const entry = raw.items[idx];
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                  throw new MindError(
                    "INVALID_INPUT",
                    `items[${idx}] must be an object`,
                  );
                }
                const rec = entry as Record<string, unknown>;
                const sourceRef = reqBodyStr(rec, "sourceRef");
                const targetRaw = reqBodyStr(rec, "target");
                if (targetRaw !== "record" && targetRaw !== "seabed") {
                  throw new MindError(
                    "INVALID_INPUT",
                    `items[${idx}].target must be "record" or "seabed"`,
                  );
                }
                const expectedRealmRef = reqBodyStr(rec, "expectedRealmRef");
                const contentSha256 =
                  typeof rec.contentSha256 === "string"
                    ? rec.contentSha256
                    : (() => {
                        throw new MindError(
                          "INVALID_INPUT",
                          `items[${idx}].contentSha256 must be a string`,
                        );
                      })();
                const byteLength =
                  typeof rec.byteLength === "number" &&
                  Number.isFinite(rec.byteLength) &&
                  rec.byteLength >= 0
                    ? rec.byteLength
                    : (() => {
                        throw new MindError(
                          "INVALID_INPUT",
                          `items[${idx}].byteLength must be a non-negative number`,
                        );
                      })();
                const expectedStatusRaw =
                  rec.expectedStatus === undefined
                    ? "active"
                    : rec.expectedStatus;
                if (
                  expectedStatusRaw !== "active" &&
                  expectedStatusRaw !== "superseded"
                ) {
                  throw new MindError(
                    "INVALID_INPUT",
                    `items[${idx}].expectedStatus must be "active" or "superseded"`,
                  );
                }
                const expectedOccurredAt =
                  optBodyNullableStr(rec, "expectedOccurredAt") ?? null;
                items.push({
                  sourceRef,
                  target: targetRaw,
                  expectedRealmRef,
                  contentSha256,
                  rawContentSha256: optBodyStr(rec, "rawContentSha256"),
                  byteLength,
                  expectedTitle: optBodyStr(rec, "expectedTitle"),
                  expectedStatus: expectedStatusRaw,
                  expectedOccurredAt,
                  secretSkipped: optBodyBool(rec, "secretSkipped"),
                });
              }

              let allExpectedEntries: VerifyImportInput["allExpectedEntries"];
              if (raw.allExpectedEntries !== undefined) {
                if (!Array.isArray(raw.allExpectedEntries)) {
                  throw new MindError(
                    "INVALID_INPUT",
                    'Field "allExpectedEntries" must be an array',
                  );
                }
                allExpectedEntries = raw.allExpectedEntries.map((e, i) => {
                  if (!e || typeof e !== "object" || Array.isArray(e)) {
                    throw new MindError(
                      "INVALID_INPUT",
                      `allExpectedEntries[${i}] must be an object`,
                    );
                  }
                  const o = e as Record<string, unknown>;
                  const t = reqBodyStr(o, "target");
                  if (t !== "record" && t !== "seabed") {
                    throw new MindError(
                      "INVALID_INPUT",
                      `allExpectedEntries[${i}].target must be "record" or "seabed"`,
                    );
                  }
                  return {
                    realmRef: reqBodyStr(o, "realmRef"),
                    target: t,
                    sourceRef: reqBodyStr(o, "sourceRef"),
                  };
                });
              }

              const validated: VerifyImportInput = {
                items,
                checkUnexpectedInRealmRefs: optBodyStrArray(
                  raw,
                  "checkUnexpectedInRealmRefs",
                ),
                allExpectedSourceRefs: optBodyStrArray(
                  raw,
                  "allExpectedSourceRefs",
                ),
                allExpectedEntries,
                allowSkips: optBodyNonNegInt(raw, "allowSkips"),
                totalSourceFiles: optBodyNonNegInt(raw, "totalSourceFiles"),
                excludedCount: optBodyNonNegInt(raw, "excludedCount"),
                unaccountedPaths: optBodyStrArray(raw, "unaccountedPaths"),
              };
              const out = await surface.verifyImport(validated);
              sendJson(res, 200, out);
              return;
            }

            // ---- v0.6.0/v0.6.1 Invitations, Identities & Actor Lifecycle (Root-Realm Human Admin Bearer ONLY) ----
            const assertHumanBearerAdmin = (cliHint: string) => {
              if (principal.authKind === "cookie") {
                throw new MindError(
                  "ACCESS_DENIED",
                  "Browser Cookie sessions cannot perform organization admin actions; use an admin Bearer token via CLI.",
                  { try: cliHint },
                );
              }
              if (principal.actor.kind !== "human") {
                throw new MindError(
                  "ACCESS_DENIED",
                  "Only human admin principals can perform organization admin actions.",
                );
              }
              // R2-P1-2: Fail closed if root realm "/" is missing
              const rootRealm = engine!.db.getRealmByPath(orgId, "/");
              if (!rootRealm || principal.boundRealmId !== rootRealm.id) {
                throw new MindError(
                  "ACCESS_DENIED",
                  "Realm-scoped humans cannot perform organization admin actions; an organization root-realm human admin token is required.",
                  { try: cliHint },
                );
              }
              const actorRec = engine!.db.getActor(orgId, principal.actor.id);
              if (!actorRec || actorRec.role !== "admin") {
                throw new MindError(
                  "ACCESS_DENIED",
                  `Organization admin role is required (actor "${principal.actor.id}" has role "${actorRec?.role ?? "member"}").`,
                  { try: cliHint },
                );
              }
            };

            if (method === "GET" && pathname === "/v1/invites") {
              assertHumanBearerAdmin("meru-mind invite list");
              const invites = engine!.db.listInvites(orgId).map(toPublicInvite);
              sendJson(res, 200, { invites });
              return;
            }

            if (method === "POST" && pathname === "/v1/invites") {
              assertHumanBearerAdmin(
                "meru-mind invite create --actor-id <id> --kind human",
              );
              const body = (await readJsonBody(req)) as {
                actorId?: string;
                actorKind?: "human" | "agent";
                role?: string;
                actorRole?: string;
                boundRealmRef?: string | null;
                ttlHours?: number;
              };
              const rawRole = body.role ?? body.actorRole;
              if (
                rawRole !== undefined &&
                rawRole !== "admin" &&
                rawRole !== "member"
              ) {
                throw new MindError(
                  "INVALID_INPUT",
                  `Invite role must be "admin" or "member"`,
                );
              }
              const publicBase = oidcManager
                ? oidcManager.resolvePublicBaseUrl(
                    req,
                    configuredPublicBaseUrl ?? serverUrlRef.value,
                  )
                : (configuredPublicBaseUrl ?? serverUrlRef.value);
              const created = createInvite({
                db: engine!.db,
                orgId,
                actorId: String(body.actorId ?? ""),
                actorKind: (body.actorKind ?? "human") as "human" | "agent",
                actorRole: (rawRole ?? "member") as ActorRole,
                boundRealmRef: body.boundRealmRef ?? null,
                createdBy: principal.actor.id,
                ttlHours: body.ttlHours,
                publicBaseUrl: publicBase,
              });
              sendJson(res, 200, created);
              return;
            }

            if (method === "POST" && pathname === "/v1/invites/revoke") {
              assertHumanBearerAdmin("meru-mind invite revoke <inviteId>");
              const body = (await readJsonBody(req)) as { inviteId?: string };
              const inviteId = String(body.inviteId ?? "").trim();
              if (!inviteId) {
                throw new MindError("INVALID_INPUT", "inviteId is required");
              }
              const revoked = engine!.db.revokeInvite(
                orgId,
                inviteId,
                new Date().toISOString(),
              );
              sendJson(res, 200, { inviteId, revoked });
              return;
            }

            if (method === "GET" && pathname === "/v1/identities") {
              assertHumanBearerAdmin("meru-mind actor list");
              sendJson(res, 200, {
                actors: engine!.db.listActors(orgId),
                identities: engine!.db.listIdentities(orgId),
                disabledActors: engine!.db.listDisabledActors(orgId),
              });
              return;
            }

            if (method === "POST" && pathname === "/v1/actors/role") {
              assertHumanBearerAdmin(
                "meru-mind actor set-role <actorId> --role admin|member",
              );
              const body = (await readJsonBody(req)) as {
                actorId?: string;
                role?: string;
              };
              const targetActorId = String(body.actorId ?? "").trim();
              if (!targetActorId) {
                throw new MindError("INVALID_INPUT", "actorId is required");
              }
              const targetRole = body.role;
              if (targetRole !== "admin" && targetRole !== "member") {
                throw new MindError(
                  "INVALID_INPUT",
                  'role must be "admin" or "member"',
                );
              }
              if (
                targetRole === "member" &&
                targetActorId.toLowerCase() === principal.actor.id.toLowerCase()
              ) {
                throw new MindError(
                  "INVALID_INPUT",
                  "Cannot demote your own active admin account.",
                );
              }
              const updated = engine!.db.transaction(() => {
                if (targetRole === "member") {
                  const existing = engine!.db.getActor(orgId, targetActorId);
                  if (
                    existing?.role === "admin" &&
                    !engine!.db.isActorDisabled(orgId, targetActorId) &&
                    engine!.db.countActiveAdmins(orgId) <= 1
                  ) {
                    throw new MindError(
                      "CONFLICT",
                      "Cannot demote the last active organization administrator.",
                    );
                  }
                }
                return engine!.db.setActorRole(orgId, targetActorId, targetRole);
              });
              sendJson(res, 200, {
                actorId: updated.actorId,
                role: updated.role,
                displayName: updated.displayName,
                updatedAt: updated.updatedAt,
              });
              return;
            }

            if (method === "POST" && pathname === "/v1/actors/disable") {
              assertHumanBearerAdmin("meru-mind actor disable <actorId>");
              const body = (await readJsonBody(req)) as {
                actorId?: string;
                reason?: string | null;
              };
              const targetActorId = String(body.actorId ?? "").trim();
              if (!targetActorId) {
                throw new MindError("INVALID_INPUT", "actorId is required");
              }
              if (
                targetActorId.toLowerCase() === principal.actor.id.toLowerCase()
              ) {
                throw new MindError(
                  "INVALID_INPUT",
                  "Cannot disable your own active admin actor account.",
                );
              }
              const disabledAt = new Date().toISOString();
              const dbRes = engine!.db.transaction(() => {
                const existing = engine!.db.getActor(orgId, targetActorId);
                if (
                  existing?.role === "admin" &&
                  !engine!.db.isActorDisabled(orgId, targetActorId) &&
                  engine!.db.countActiveAdmins(orgId) <= 1
                ) {
                  throw new MindError(
                    "CONFLICT",
                    "Cannot disable the last active organization administrator.",
                  );
                }
                return engine!.db.disableActor({
                  orgId,
                  actorId: targetActorId,
                  reason:
                    typeof body.reason === "string" && body.reason.trim()
                      ? body.reason.trim()
                      : null,
                  disabledBy: principal.actor.id,
                  disabledAt,
                });
              });
              const revokedSessions = uiSessions.revokeSessionsForActor(
                orgId,
                targetActorId,
              );
              const revokedDeviceTx =
                oidcManager?.revokeDeviceTxForActor(orgId, targetActorId) ?? 0;
              const removedPulses = pulseStore.removeAllForActor(
                orgId,
                targetActorId,
              );
              const closedWebSockets =
                detachWs?.closeForActor(orgId, targetActorId) ?? 0;
              sendJson(res, 200, {
                actorId: targetActorId,
                disabled: true,
                disabledAt,
                revokedTokens: dbRes.revokedTokens,
                revokedAgentTokens: dbRes.revokedAgentTokens,
                revokedInvites: dbRes.revokedInvites,
                disabledIdentities: dbRes.disabledIdentities,
                revokedSessions,
                revokedDeviceTx,
                removedPulses,
                closedWebSockets,
              });
              return;
            }

            if (method === "POST" && pathname === "/v1/actors/enable") {
              assertHumanBearerAdmin("meru-mind actor enable <actorId>");
              const body = (await readJsonBody(req)) as { actorId?: string };
              const targetActorId = String(body.actorId ?? "").trim();
              if (!targetActorId) {
                throw new MindError("INVALID_INPUT", "actorId is required");
              }
              const enabled = engine!.db.enableActor(orgId, targetActorId);
              sendJson(res, 200, { actorId: targetActorId, enabled });
              return;
            }

            if (method === "POST" && pathname === "/v1/ui/login-code") {
              const minted = uiSessions.mintLoginCode(principal);
              const authPath = `/_meru/auth?code=${encodeURIComponent(minted.code)}`;
              const reqHost = req.headers.host?.trim();
              const fwdProto =
                typeof req.headers["x-forwarded-proto"] === "string"
                  ? req.headers["x-forwarded-proto"].split(",")[0]?.trim().toLowerCase()
                  : "";
              const proto =
                fwdProto === "https" || fwdProto === "http" ? fwdProto : "http";
              const publicBase =
                reqHost &&
                !reqHost.startsWith("0.0.0.0") &&
                !reqHost.startsWith("[::]")
                  ? `${proto}://${reqHost}`
                  : serverUrlRef.value;
              sendJson(res, 200, {
                ...minted,
                path: authPath,
                loginUrl: `${publicBase}${authPath}`,
              });
              return;
            }

            if (method === "POST" && pathname === "/v1/admin/backup") {
              assertHumanBearerAdmin(
                "MERU_MIND_URL=<url> MERU_MIND_TOKEN=<token> meru-mind admin backup",
              );
              const body = (await readJsonBody(req)) as { name?: string };
              const rawName =
                typeof body.name === "string" && body.name.trim()
                  ? body.name.trim()
                  : `mind-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
              if (
                rawName.includes("/") ||
                rawName.includes("\\") ||
                rawName.includes("..") ||
                !/^[A-Za-z0-9._-]+$/.test(rawName)
              ) {
                throw new MindError(
                  "INVALID_INPUT",
                  "Backup filename must match [A-Za-z0-9._-]+ without path separators",
                );
              }
              const backupDir = path.join(path.resolve(homeDir), "backups");
              fs.mkdirSync(backupDir, { recursive: true });
              const filename = rawName.endsWith(".sqlite")
                ? rawName
                : `${rawName}.sqlite`;
              const outPath = path.join(backupDir, filename);
              engine!.db.vacuumInto(outPath);
              const stat = fs.statSync(outPath);
              const sha256 = crypto
                .createHash("sha256")
                .update(fs.readFileSync(outPath))
                .digest("hex");
              sendJson(res, 200, {
                backedUp: true,
                filename,
                relativePath: `backups/${filename}`,
                sizeBytes: stat.size,
                sha256,
                createdAt: new Date().toISOString(),
              });
              return;
            }

            if (method === "GET" && pathname === "/v1/pulse") {
              const rawMatches = [
                ...sp.getAll("match"),
                ...sp.getAll("key"),
                ...sp.getAll("focus"),
              ]
                .flatMap((v) => v.split(","))
                .map((v) => v.trim())
                .filter(Boolean);
              const realmRef = sp.get("realm") ?? undefined;
              const rawMode = sp.get("mode");
              const modeFilter =
                rawMode === "observing" || rawMode === "working"
                  ? rawMode
                  : undefined;
              const headerSession =
                typeof req.headers["x-meru-session-id"] === "string" &&
                req.headers["x-meru-session-id"].trim()
                  ? req.headers["x-meru-session-id"].trim()
                  : undefined;
              const excludeSelf = sp.get("excludeSelf") === "true" || sp.get("excludeSelf") === "1";
              const out = pulseStore.listVisibleWithNow({
                db: engine!.db,
                principal,
                matchKeys: rawMatches.length > 0 ? rawMatches : undefined,
                realmRef,
                modeFilter,
                excludeSessionTag: excludeSelf ? headerSession : undefined,
              });
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/pulse") {
              const body = (await readJsonBody(req)) as {
                sessionId?: string;
                parentSessionId?: string | null;
                realmRef?: string;
                focus?: string[];
                keys?: string[];
                note?: string | null;
                clientHint?: string | null;
                mode?: string;
                source?: string;
                event?: string;
              };
              const headerSession =
                typeof req.headers["x-meru-session-id"] === "string" &&
                req.headers["x-meru-session-id"].trim()
                  ? req.headers["x-meru-session-id"].trim()
                  : undefined;
              const headerParent =
                typeof req.headers["x-meru-parent-session-id"] === "string" &&
                req.headers["x-meru-parent-session-id"].trim()
                  ? req.headers["x-meru-parent-session-id"].trim()
                  : undefined;
              const headerClient =
                typeof req.headers["x-meru-client"] === "string"
                  ? req.headers["x-meru-client"]
                  : undefined;

              if (body.event === "session_end") {
                const out = pulseStore.removeForPrincipal({
                  principal,
                  sessionId: body.sessionId ?? headerSession,
                });
                sendJson(res, 200, out);
                return;
              }

              const pulse = pulseStore.declare({
                db: engine!.db,
                principal,
                sessionId: body.sessionId ?? headerSession,
                parentSessionId:
                  body.parentSessionId !== undefined
                    ? body.parentSessionId
                    : headerParent,
                realmRef: body.realmRef,
                focus: body.focus,
                keys: body.keys,
                note: body.note,
                clientHint:
                  body.clientHint !== undefined ? body.clientHint : headerClient,
                mode: body.mode,
                source: body.source,
                event: body.event,
              });
              sendJson(res, 200, pulse);
              return;
            }

            if (method === "DELETE" && pathname === "/v1/pulse") {
              const body = (await readJsonBody(req)) as { sessionId?: string };
              const headerSession =
                typeof req.headers["x-meru-session-id"] === "string" &&
                req.headers["x-meru-session-id"].trim()
                  ? req.headers["x-meru-session-id"].trim()
                  : undefined;
              const querySession = sp.get("sessionId") ?? undefined;
              const out = pulseStore.removeForPrincipal({
                principal,
                sessionId: body.sessionId ?? querySession ?? headerSession,
              });
              sendJson(res, 200, out);
              return;
            }

            if (method === "GET" && pathname === "/v1/work/bindings") {
              const out = await surface.listWorkBindings();
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/work/bindings") {
              const body = (await readJsonBody(req)) as {
                realmRef: string;
                provider: string;
                config: Record<string, unknown>;
              };
              const out = await surface.bindWork(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/work/unbind") {
              const body = (await readJsonBody(req)) as { realmRef: string };
              const unbound = await surface.unbindWork(body);
              sendJson(res, 200, { unbound });
              return;
            }

            if (method === "POST" && pathname === "/v1/work/resolve") {
              const body = (await readJsonBody(req)) as {
                realmRef?: string;
                items: string[];
              };
              const out = await surface.resolveWork(body);
              sendJson(res, 200, out);
              return;
            }

            if (method === "GET" && pathname === "/v1/work/ready") {
              const out = await surface.listReadyWork({
                realmRef: sp.get("ref") ?? undefined,
                limit: parseOptionalInt(sp.get("limit")),
                cursor: sp.get("cursor") ?? undefined,
              });
              sendJson(res, 200, out);
              return;
            }

            sendJson(res, 404, {
              error: "not_found",
              message: `Unknown API route: ${method} ${pathname}`,
            });
            return;
          } finally {
            await surface.close();
          }
        }

        // Optional custom route hook first, then built-in v0.4 1.5-layer UI router (/_meru/* & / & --web-dir)
        if (options.extraRouteHandler) {
          const handled = await options.extraRouteHandler({
            req,
            res,
            url: parsedUrl,
            engine: engine!,
            orgId,
            wakeBus,
            authenticate,
            createSurface,
          });
          if (handled) return;
        }

        const uiHandled = await builtInUiHandler({
          req,
          res,
          url: parsedUrl,
          engine: engine!,
          orgId,
          authenticate,
        });
        if (uiHandled) return;

        sendJson(res, 404, {
          error: "not_found",
          message: `Route not found: ${method} ${pathname}`,
        });
      } catch (err) {
        const status = httpStatusForError(err);
        const payload = toSurfaceError(err, { surface: "cli", remote: true });
        if (status === 403 && !actorId) {
          sendJson(res, 401, payload);
        } else {
          sendJson(res, status, payload);
        }
      }
    });

    detachWs = attachPumpWebSocketServer({
      httpServer,
      db: engine.db,
      wakeBus,
      orgId,
      allowedOrigins: options.allowedOrigins,
      authenticateCookie: resolveCookiePrincipal,
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(requestedPort, host, () => {
        httpServer.removeListener("error", reject);
        resolve();
      });
    });

    const addr = httpServer.address() as AddressInfo;
    const boundPort = addr.port;
    const url = `http://${formatHostForUrl(host)}:${boundPort}`;
    serverUrlRef.value = url;

    // Update lock file in-place with actual bound port and orgId (zero lock-release window)
    lockHandle.updateInfo({ url, orgId });

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      if (detachWs) {
        detachWs();
        detachWs = null;
      }
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
      if (unsubChangeLog) {
        unsubChangeLog();
        unsubChangeLog = null;
      }
      oidcManager?.close();
      try {
        pulseStore.saveSnapshot(pulseSnapshotPath);
      } catch {
        // Disposable shutdown telemetry snapshot — never block server close
      }
      if (engine) {
        await engine.close();
        engine = null;
      }
      lockHandle.release();
    };

    return {
      url,
      host,
      port: boundPort,
      homeDir,
      orgId,
      engine,
      wakeBus,
      pulseStore,
      uiSessions,
      oidcManager,
      ...(demoSeed ? { demoSeed } : {}),
      httpServer,
      createToken(params) {
        return createAuthToken({
          db: engine!.db,
          orgId,
          actorId: params.actorId,
          actorKind: params.actorKind,
          actorFamily: params.actorFamily,
          actorRole: params.actorRole,
          boundRealmId: params.boundRealmId,
          writeScope: params.writeScope,
          label: params.label,
          createdBy: params.createdBy ?? "serve-bootstrap",
          ttlDays: params.ttlDays,
          expiresAt: params.expiresAt,
        });
      },
      mintUiLoginCode(principal) {
        const minted = uiSessions.mintLoginCode(principal);
        return {
          ...minted,
          loginUrl: `${url}/_meru/auth?code=${encodeURIComponent(minted.code)}`,
        };
      },
      close,
    };
  } catch (err) {
    if (detachWs) detachWs();
    if (unsubChangeLog) unsubChangeLog();
    oidcManager?.close();
    if (engine) {
      await engine.close().catch(() => {});
    }
    lockHandle.release();
    throw err;
  }
}
