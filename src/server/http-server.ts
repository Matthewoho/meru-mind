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
  SurfaceCreateRealmInput,
  SurfaceUpdateRealmInput,
  SurfaceCreateTokenInput,
  SurfaceMountRealmInput,
  SurfaceMoveInput,
  SurfaceRawAddInput,
  SurfaceRedactInput,
  SurfaceWriteInput,
} from "../surface.js";
import {
  MindError,
  type LsOnlyFilter,
  type OrgPolicy,
  type Principal,
} from "../types.js";
import { MERU_MIND_VERSION } from "../version.js";
import { createSurfaceMcpServer } from "./mcp-http.js";
import { seedDemoOrg, type DemoSeedSummary } from "./demo-seed.js";
import { withLivePulse } from "./live-pulse.js";
import { MindPulseStore, sanitizeClientHint } from "./pulse.js";
import { ChangeWakeBus } from "./pump.js";
import {
  createAuthToken,
  resolvePrincipalFromToken,
  TokenTouchThrottle,
  type CreateAuthTokenResult,
} from "./tokens.js";
import { UiSessionManager } from "./ui-auth.js";
import { assertWebDirAllowed, createUiRouteHandler } from "./ui-router.js";
import {
  acquireServeWriterLock,
  type ServeWriterLockHandle,
} from "./writer-lock.js";
import { attachPumpWebSocketServer, isOriginAllowed } from "./ws-pump.js";
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
  readonly demoSeed?: DemoSeedSummary;
  readonly httpServer: http.Server;
  createToken(params: {
    actorId: string;
    actorKind: "human" | "agent";
    actorFamily?: string | null;
    boundRealmId?: string | null;
    label?: string | null;
    createdBy?: string;
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
  let detachWs: (() => void) | null = null;

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
    const touchThrottle = new TokenTouchThrottle();
    const uiSessions = new UiSessionManager();
    const builtInUiHandler = createUiRouteHandler({
      uiSessions,
      webDir: resolvedWebDir,
      allowedOrigins: options.allowedOrigins,
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
          try: "Pass Authorization: Bearer <MERU_MIND_TOKEN> or run 'meru-mind ui login'",
        },
      );
    };

    const serverUrlRef = { value: `http://${formatHostForUrl(host)}:${requestedPort}` };

    const extractPulseMeta = (
      req: IncomingMessage,
      workspaceHint: string | null,
    ): { sessionTag: string; clientHint: string | null } => {
      const rawClient = req.headers["x-meru-client"];
      const clientHint = sanitizeClientHint(
        typeof rawClient === "string" ? rawClient : null,
      );
      const rawSession = req.headers["x-meru-session-id"];
      const headerSession =
        typeof rawSession === "string" && rawSession.trim()
          ? rawSession.trim()
          : null;
      if (headerSession) {
        return { sessionTag: headerSession, clientHint };
      }
      if (clientHint || workspaceHint) {
        const fallback = [clientHint ?? "client", workspaceHint ?? ""]
          .filter(Boolean)
          .join(":");
        return { sessionTag: fallback.slice(0, 64), clientHint };
      }
      return { sessionTag: "default", clientHint };
    };

    const createSurface = (
      principal: Principal,
      req: IncomingMessage,
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
      const { sessionTag, clientHint } = extractPulseMeta(req, workspaceHint);
      return withLivePulse(localSurface, {
        db: engine!.db,
        pulseStore,
        principal,
        sessionTag,
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
          const surface = createSurface(principal, req);
          const mcpServer = createSurfaceMcpServer(surface);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          await mcpServer.connect(transport);
          try {
            const parsedBody = await readJsonBody(req);
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
              if (principal.authKind === "cookie") {
                throw new MindError(
                  "ACCESS_DENIED",
                  "Browser Cookie sessions cannot create server backups; use a human Bearer token via CLI.",
                  {
                    try: "MERU_MIND_URL=<url> MERU_MIND_TOKEN=<token> meru-mind admin backup",
                  },
                );
              }
              if (principal.actor.kind !== "human") {
                throw new MindError(
                  "ACCESS_DENIED",
                  "Only human principals can trigger server backups",
                );
              }
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
              const out = pulseStore.listVisibleWithNow({
                db: engine!.db,
                principal,
              });
              sendJson(res, 200, out);
              return;
            }

            if (method === "POST" && pathname === "/v1/pulse") {
              const body = (await readJsonBody(req)) as {
                sessionId?: string;
                realmRef?: string;
                focus?: string[];
                note?: string | null;
                clientHint?: string | null;
              };
              const headerSession =
                typeof req.headers["x-meru-session-id"] === "string" &&
                req.headers["x-meru-session-id"].trim()
                  ? req.headers["x-meru-session-id"].trim()
                  : undefined;
              const headerClient =
                typeof req.headers["x-meru-client"] === "string"
                  ? req.headers["x-meru-client"]
                  : undefined;
              const pulse = pulseStore.declare({
                db: engine!.db,
                principal,
                sessionId: body.sessionId ?? headerSession,
                realmRef: body.realmRef,
                focus: body.focus,
                note: body.note,
                clientHint:
                  body.clientHint !== undefined ? body.clientHint : headerClient,
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
        const payload = toSurfaceError(err, { surface: "cli" });
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
      ...(demoSeed ? { demoSeed } : {}),
      httpServer,
      createToken(params) {
        return createAuthToken({
          db: engine!.db,
          orgId,
          actorId: params.actorId,
          actorKind: params.actorKind,
          actorFamily: params.actorFamily,
          boundRealmId: params.boundRealmId,
          label: params.label,
          createdBy: params.createdBy ?? "serve-bootstrap",
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
    if (engine) {
      await engine.close().catch(() => {});
    }
    lockHandle.release();
    throw err;
  }
}
