import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MindEngine } from "../index.js";
import { MindError, type Principal } from "../types.js";
import { MARKDOWN_JS_SOURCE } from "./markdown-renderer.js";
import {
  MERMAID_FRAME_HTML_SOURCE,
  MERMAID_FRAME_JS_SOURCE,
} from "./mermaid-frame.js";
import {
  CLIENT_JS_SOURCE,
  DEFAULT_FAVICON_SVG,
  DEFAULT_SHELL_CSS,
  DEFAULT_SHELL_HTML,
  DEFAULT_SHELL_JS,
} from "./ui-assets.js";
import type { OidcManager } from "./oidc.js";
import type { UiSessionManager } from "./ui-auth.js";
import { isOriginAllowed } from "./ws-pump.js";

let cachedMarkedVendorSource: string | null = null;
let cachedMermaidVendorSource: string | null = null;

function loadMarkedVendorSource(): string {
  if (cachedMarkedVendorSource !== null) return cachedMarkedVendorSource;
  const candidates = [
    fileURLToPath(new URL("../vendor/marked.esm.js", import.meta.url)),
    fileURLToPath(new URL("../../dist/vendor/marked.esm.js", import.meta.url)),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      cachedMarkedVendorSource = fs.readFileSync(filePath, "utf8");
      return cachedMarkedVendorSource;
    }
  }
  throw new MindError(
    "NOT_FOUND",
    "Vendored marked.esm.js not found in dist/vendor/marked.esm.js. Run 'pnpm build' first.",
  );
}

function loadMermaidVendorSource(): string {
  if (cachedMermaidVendorSource !== null) return cachedMermaidVendorSource;
  const candidates = [
    fileURLToPath(new URL("../vendor/mermaid.min.js", import.meta.url)),
    fileURLToPath(new URL("../../dist/vendor/mermaid.min.js", import.meta.url)),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      cachedMermaidVendorSource = fs.readFileSync(filePath, "utf8");
      return cachedMermaidVendorSource;
    }
  }
  throw new MindError(
    "NOT_FOUND",
    "Vendored mermaid.min.js not found in dist/vendor/mermaid.min.js. Run 'pnpm build' first.",
  );
}

/**
 * Guardrail #3: Strict server-enforced CSP for all UI shells (default and custom --web-dir).
 */
export const STRICT_UI_CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const SAFE_HOST_HEADER_RE = /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;

function parseSafeOrigin(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    const hostLower = parsed.hostname.toLowerCase();
    if (hostLower === "0.0.0.0" || hostLower === "::" || hostLower === "[::]") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Builds the strict CSP header for `/_meru/mermaid-frame.html`.
 * Always includes `sandbox allow-scripts` so the frame runs in an opaque `null` origin
 * even on direct top-level navigation (`window.open`), and constrains `script-src` strictly
 * to the validated server origin's exact Mermaid bundle paths.
 */
export function buildMermaidFrameCsp(params: {
  req?: IncomingMessage;
  serverUrl?: string;
  publicBaseUrl?: string | null;
  allowedOrigins?: string[];
}): string {
  const origins = new Set<string>();
  const addOrigin = (raw: string | null | undefined) => {
    const safe = parseSafeOrigin(raw);
    if (safe) origins.add(safe);
  };

  const serverOrigin = parseSafeOrigin(params.serverUrl);
  const serverParsed = serverOrigin ? new URL(serverOrigin) : null;
  const serverIsLoopback = Boolean(
    serverParsed && isLoopbackHost(serverParsed.hostname),
  );
  const serverPort = serverParsed
    ? serverParsed.port || (serverParsed.protocol === "https:" ? "443" : "80")
    : null;

  const isMatchingLoopbackAlias = (candidateOrigin: string): boolean => {
    if (!serverParsed || !serverIsLoopback) return false;
    try {
      const cand = new URL(candidateOrigin);
      const candPort = cand.port || (cand.protocol === "https:" ? "443" : "80");
      return (
        cand.protocol === serverParsed.protocol &&
        isLoopbackHost(cand.hostname) &&
        candPort === serverPort
      );
    } catch {
      return false;
    }
  };

  addOrigin(serverOrigin);
  addOrigin(params.publicBaseUrl);
  const allowedList: string[] = [];
  for (const o of params.allowedOrigins ?? []) {
    const safe = parseSafeOrigin(o);
    if (safe) {
      origins.add(safe);
      allowedList.push(safe);
    }
  }

  const rawHost =
    typeof params.req?.headers?.host === "string"
      ? params.req.headers.host.trim()
      : "";
  if (rawHost && SAFE_HOST_HEADER_RE.test(rawHost)) {
    if (allowedList.length > 0) {
      const scheme = params.req && isRequestSecure(params.req) ? "https" : "http";
      const candidate = parseSafeOrigin(`${scheme}://${rawHost}`);
      if (candidate && allowedList.includes(candidate)) {
        origins.add(candidate);
      }
    } else if (params.publicBaseUrl) {
      const pubOrigin = parseSafeOrigin(params.publicBaseUrl);
      const scheme = params.req && isRequestSecure(params.req) ? "https" : "http";
      const candidate = parseSafeOrigin(`${scheme}://${rawHost}`);
      if (candidate && (candidate === pubOrigin || isMatchingLoopbackAlias(candidate))) {
        origins.add(candidate);
      }
    } else if (serverParsed && serverIsLoopback) {
      // Default server without allowedOrigins/publicBaseUrl: never trust X-Forwarded-Proto
      // or arbitrary Host headers; allow only loopback aliases on the exact bound port.
      const candidate = parseSafeOrigin(`${serverParsed.protocol}//${rawHost}`);
      if (candidate && isMatchingLoopbackAlias(candidate)) {
        origins.add(candidate);
      }
    }
  }

  const scriptSources = ["'self'"];
  for (const origin of origins) {
    scriptSources.push(`${origin}/_meru/vendor/mermaid.min.js`);
    scriptSources.push(`${origin}/_meru/mermaid-frame.js`);
  }

  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Guardrail #6: In v0.4, custom `--web-dir` bundles are strictly loopback-only.
 */
export function assertWebDirAllowed(
  webDir: string | undefined,
  host: string,
): string | null {
  if (!webDir?.trim()) return null;
  if (!isLoopbackHost(host)) {
    throw new MindError(
      "INVALID_INPUT",
      `Custom --web-dir is strictly loopback-only in v0.4 (refused for host "${host}"). Bind to 127.0.0.1 or serve the built-in official shell on team servers.`,
      {
        try: `meru-mind serve --host 127.0.0.1 --web-dir ${webDir}`,
      },
    );
  }
  const abs = path.resolve(webDir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new MindError("NOT_FOUND", `Custom --web-dir directory not found: ${abs}`);
  }
  return abs;
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendAsset(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Security-Policy": STRICT_UI_CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

function isRequestSecure(req: IncomingMessage): boolean {
  const fwd = req.headers["x-forwarded-proto"];
  if (typeof fwd === "string" && fwd.split(",")[0]?.trim().toLowerCase() === "https") {
    return true;
  }
  return Boolean((req.socket as { encrypted?: boolean })?.encrypted);
}

export interface UiRouterOptions {
  uiSessions: UiSessionManager;
  webDir: string | null;
  allowedOrigins?: string[];
  oidcManager?: OidcManager | null;
  getServerUrl?: () => string;
  publicBaseUrl?: string | null;
}

/**
 * Handles all `/_meru/*` reserved routes and `/` UI shell serving with ALL 6 v0.4 security guardrails:
 * 1. Weakened Cookie session (enforced in LocalMindSurface)
 * 2. Single-use CLI login code exchange at `/_meru/auth?code=...` (no browser login form)
 * 3. Strict CSP on every HTML/JS/CSS response
 * 4. Reserved `/_meru/*` and `/v1/*` prefixes can NEVER be shadowed by `--web-dir`
 * 5. Any `Service-Worker: script` request returns 404 (prevents origin hijacking)
 * 6. `--web-dir` loopback-only (checked at startup)
 */
export function createUiRouteHandler(options: UiRouterOptions) {
  return async (params: {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    engine: MindEngine;
    orgId: string;
    authenticate: (
      req: IncomingMessage,
      opts?: { allowCookie?: boolean },
    ) => Principal;
  }): Promise<boolean> => {
    const { req, res, url, engine } = params;
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = url.pathname;

    // Guardrail #5: Reject ALL Service Worker registration attempts with 404
    const swHeader = req.headers["service-worker"];
    if (
      typeof swHeader === "string" &&
      swHeader.trim().toLowerCase() === "script"
    ) {
      sendAsset(res, 404, "text/plain; charset=utf-8", "Service workers are disabled on Meru Mind origins.");
      return true;
    }

    // Guardrail #4: Reserved /_meru/* namespace (NEVER shadowed by --web-dir)
    if (pathname === "/_meru/client.js" && method === "GET") {
      sendAsset(res, 200, "application/javascript; charset=utf-8", CLIENT_JS_SOURCE);
      return true;
    }
    if (pathname === "/_meru/markdown.js" && method === "GET") {
      sendAsset(res, 200, "application/javascript; charset=utf-8", MARKDOWN_JS_SOURCE);
      return true;
    }
    if (pathname === "/_meru/vendor/marked.esm.js" && method === "GET") {
      sendAsset(res, 200, "application/javascript; charset=utf-8", loadMarkedVendorSource());
      return true;
    }
    if (pathname === "/_meru/vendor/mermaid.min.js" && method === "GET") {
      const vendorSource = loadMermaidVendorSource();
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(vendorSource);
      return true;
    }
    if (pathname === "/_meru/mermaid-frame.js" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(MERMAID_FRAME_JS_SOURCE);
      return true;
    }
    if (pathname === "/_meru/mermaid-frame.html" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": buildMermaidFrameCsp({
          req,
          serverUrl: options.getServerUrl?.(),
          publicBaseUrl: options.publicBaseUrl,
          allowedOrigins: options.allowedOrigins,
        }),
        "X-Frame-Options": "SAMEORIGIN",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
      });
      res.end(MERMAID_FRAME_HTML_SOURCE);
      return true;
    }
    if ((pathname === "/_meru/shell" || pathname === "/_meru/shell/") && method === "GET") {
      sendAsset(res, 200, "text/html; charset=utf-8", DEFAULT_SHELL_HTML);
      return true;
    }
    if (pathname === "/_meru/shell.css" && method === "GET") {
      sendAsset(res, 200, "text/css; charset=utf-8", DEFAULT_SHELL_CSS);
      return true;
    }
    if (pathname === "/_meru/shell.js" && method === "GET") {
      sendAsset(res, 200, "application/javascript; charset=utf-8", DEFAULT_SHELL_JS);
      return true;
    }
    if ((pathname === "/_meru/favicon.svg" || pathname === "/favicon.ico") && method === "GET") {
      sendAsset(res, 200, "image/svg+xml; charset=utf-8", DEFAULT_FAVICON_SVG);
      return true;
    }
    if (pathname === "/_meru/session" && method === "GET") {
      const principal = options.uiSessions.authenticateRequest(
        req,
        engine.db,
        params.orgId,
      );
      const oidcEnabled = Boolean(options.oidcManager);
      const actorRec = principal
        ? engine.db.getActor(params.orgId, principal.actor.id)
        : null;
      sendAsset(
        res,
        200,
        "application/json; charset=utf-8",
        JSON.stringify(
          principal
            ? {
                authenticated: true,
                actor: {
                  ...principal.actor,
                  role: actorRec?.role ?? "member",
                  ...(actorRec?.displayName
                    ? { displayName: actorRec.displayName }
                    : {}),
                },
                oidcEnabled,
                oidcLoginUrl: oidcEnabled ? "/_meru/oidc/login" : null,
              }
            : {
                authenticated: false,
                oidcEnabled,
                oidcLoginUrl: oidcEnabled ? "/_meru/oidc/login" : null,
              },
        ),
      );
      return true;
    }
    if (
      pathname.startsWith("/_meru/oidc/") ||
      pathname === "/_meru/device" ||
      pathname.startsWith("/_meru/device/")
    ) {
      if (!options.oidcManager) {
        sendAsset(
          res,
          404,
          "application/json; charset=utf-8",
          JSON.stringify({
            error: "not_found",
            message: "OIDC SSO is not configured on this Meru Mind server.",
          }),
        );
        return true;
      }
      const handled = await options.oidcManager.handleRequest({
        req,
        res,
        url,
        db: engine.db,
        orgId: params.orgId,
        uiSessions: options.uiSessions,
        fallbackServerUrl: options.getServerUrl?.() ?? "http://127.0.0.1:3800",
        allowedOrigins: options.allowedOrigins,
      });
      if (handled) return true;
      sendAsset(res, 404, "text/plain; charset=utf-8", "OIDC route not found");
      return true;
    }
    if (pathname === "/_meru/auth" && method === "GET") {
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
        sendAsset(
          res,
          403,
          "text/plain; charset=utf-8",
          "Login code exchange requires top-level browser document navigation.",
        );
        return true;
      }
      const code = url.searchParams.get("code") ?? "";
      const exchanged = options.uiSessions.exchangeLoginCode(code, engine.db);
      const setCookie = options.uiSessions.buildSetCookieHeader(
        exchanged.sessionId,
        exchanged.maxAgeSeconds,
        isRequestSecure(req),
      );
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": setCookie,
        "Cache-Control": "no-store",
        "Content-Security-Policy": STRICT_UI_CSP,
      });
      res.end();
      return true;
    }
    if (pathname === "/_meru/logout" && method === "POST") {
      if (
        (req.headers.origin !== undefined || req.headers.cookie !== undefined) &&
        !isOriginAllowed({
          originHeader: req.headers.origin,
          hostHeader: req.headers.host,
          allowedOrigins: options.allowedOrigins,
        })
      ) {
        sendAsset(
          res,
          403,
          "application/json; charset=utf-8",
          JSON.stringify({
            error: "forbidden",
            message: "Cross-origin or missing-Origin logout rejected",
          }),
        );
        return true;
      }
      options.uiSessions.revokeSessionFromRequest(req);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": options.uiSessions.buildClearCookieHeaders(isRequestSecure(req)),
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    if (pathname.startsWith("/_meru/")) {
      sendAsset(res, 404, "text/plain; charset=utf-8", "Not found in reserved /_meru/ namespace");
      return true;
    }

    if (method !== "GET" && method !== "HEAD") {
      return false;
    }

    // Custom loopback --web-dir static serving (never shadows /_meru/*, /v1/*, /mcp)
    if (options.webDir) {
      const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const candidate = path.resolve(options.webDir, rel);
      const rootWithSep = options.webDir.endsWith(path.sep)
        ? options.webDir
        : options.webDir + path.sep;
      if (
        candidate !== options.webDir &&
        !candidate.startsWith(rootWithSep)
      ) {
        sendAsset(res, 403, "text/plain; charset=utf-8", "Path traversal denied");
        return true;
      }
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const ext = path.extname(candidate).toLowerCase();
        const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
        sendAsset(res, 200, mime, fs.readFileSync(candidate));
        return true;
      }
      // SPA fallback to index.html inside --web-dir if present
      const indexFile = path.join(options.webDir, "index.html");
      if (fs.existsSync(indexFile) && fs.statSync(indexFile).isFile()) {
        sendAsset(res, 200, "text/html; charset=utf-8", fs.readFileSync(indexFile));
        return true;
      }
    }

    // Default fallback: built-in official shell at `/` and SPA deep-link routes (`/<realm>?entry=...`)
    // Never shadows `/_meru/*`, `/v1/*`, `/mcp`, or missing static asset extensions.
    const STATIC_ASSET_EXT_RE =
      /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|json|xml|txt)$/i;
    if (
      pathname === "/" ||
      pathname === "/index.html" ||
      (!pathname.startsWith("/_meru/") &&
        !pathname.startsWith("/v1/") &&
        pathname !== "/mcp" &&
        !STATIC_ASSET_EXT_RE.test(pathname))
    ) {
      sendAsset(res, 200, "text/html; charset=utf-8", DEFAULT_SHELL_HTML);
      return true;
    }

    return false;
  };
}

/**
 * Writes the built-in official Default Shell source files into `targetDir` so users or coding agents
 * can customize them immediately (`meru-mind ui eject <dir>`).
 */
export function ejectDefaultUiShell(targetDir: string): string[] {
  const abs = path.resolve(targetDir);
  fs.mkdirSync(abs, { recursive: true });
  const files: Array<{ name: string; content: string }> = [
    {
      name: "index.html",
      content: DEFAULT_SHELL_HTML.replace("/_meru/shell.css", "./shell.css").replace(
        "/_meru/shell.js",
        "./shell.js",
      ),
    },
    { name: "shell.css", content: DEFAULT_SHELL_CSS },
    { name: "shell.js", content: DEFAULT_SHELL_JS },
  ];
  const written: string[] = [];
  for (const f of files) {
    const out = path.join(abs, f.name);
    fs.writeFileSync(out, f.content, "utf8");
    written.push(out);
  }
  return written;
}
