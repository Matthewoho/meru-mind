import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MindEngine } from "../index.js";
import { MindError, type Principal } from "../types.js";
import { MARKDOWN_JS_SOURCE } from "./markdown-renderer.js";
import {
  CLIENT_JS_SOURCE,
  DEFAULT_FAVICON_SVG,
  DEFAULT_SHELL_CSS,
  DEFAULT_SHELL_HTML,
  DEFAULT_SHELL_JS,
} from "./ui-assets.js";
import type { UiSessionManager } from "./ui-auth.js";
import { isOriginAllowed } from "./ws-pump.js";

let cachedMarkedVendorSource: string | null = null;

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

/**
 * Guardrail #3: Strict server-enforced CSP for all UI shells (default and custom --web-dir).
 */
export const STRICT_UI_CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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
      sendAsset(
        res,
        200,
        "application/json; charset=utf-8",
        JSON.stringify(
          principal
            ? { authenticated: true, actor: principal.actor }
            : { authenticated: false },
        ),
      );
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

    // Default fallback: built-in official shell at `/`
    if (pathname === "/" || pathname === "/index.html") {
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
