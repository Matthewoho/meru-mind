import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_HARNESS_SESSION_CHARS = 64;
export const MAX_HARNESS_CLIENT_CHARS = 32;
export const PARENT_MAP_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PARENT_MAP_ENTRIES = 500;

export interface HarnessParentMapEntry {
  parent: string;
  updatedAt: number;
}

export interface HarnessParentMapSchema {
  version: 1;
  links: Record<string, HarnessParentMapEntry>;
}

export interface HarnessSessionContext {
  sessionTag: string | null;
  parentSessionTag: string | null;
  clientHint: string | null;
}

export function sanitizeHarnessSessionId(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._:@/-]/g, "")
    .slice(0, MAX_HARNESS_SESSION_CHARS);
  return cleaned || null;
}

export function sanitizeHarnessClientHint(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, MAX_HARNESS_CLIENT_CHARS);
  return cleaned || null;
}

export function resolveParentMapFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.MERU_MIND_PARENT_MAP_FILE?.trim();
  if (override) return path.resolve(override);
  const xdgCache = env.XDG_CACHE_HOME?.trim();
  const base = xdgCache
    ? path.resolve(xdgCache)
    : path.join(os.homedir(), ".cache");
  return path.join(base, "meru-mind", "parent-map.json");
}

function readParentMapSafe(
  filePath: string,
  nowMs: number,
): Record<string, HarnessParentMapEntry> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as
      | Partial<HarnessParentMapSchema>
      | Record<string, unknown>;
    const rawLinks =
      parsed &&
      typeof parsed === "object" &&
      "links" in parsed &&
      parsed.links &&
      typeof parsed.links === "object" &&
      !Array.isArray(parsed.links)
        ? (parsed.links as Record<string, unknown>)
        : parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};

    const valid: Record<string, HarnessParentMapEntry> = Object.create(
      null,
    ) as Record<string, HarnessParentMapEntry>;
    const MAX_FUTURE_SKEW_MS = 60_000;
    for (const [k, v] of Object.entries(rawLinks)) {
      if (k === "version" || k === "links") continue;
      const child = sanitizeHarnessSessionId(k);
      if (!child || !v || typeof v !== "object") continue;
      const rec = v as { parent?: unknown; updatedAt?: unknown };
      const parent = sanitizeHarnessSessionId(
        typeof rec.parent === "string" ? rec.parent : null,
      );
      const updatedAt =
        typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt)
          ? rec.updatedAt
          : NaN;
      if (!parent || parent === child || !Number.isFinite(updatedAt)) continue;
      if (updatedAt > nowMs + MAX_FUTURE_SKEW_MS) continue;
      if (nowMs - updatedAt > PARENT_MAP_TTL_MS) continue;
      valid[child] = { parent, updatedAt };
    }
    return valid;
  } catch {
    return {};
  }
}

/**
 * Records a child -> parent harness session link in `parent-map.json` atomically (`wx` + `0o600`),
 * pruning entries older than 24h and capping at 500 entries.
 * Returns false if inputs are invalid, `child === parent`, or the write fails.
 */
export function recordHarnessParentLink(params: {
  childSessionId: string;
  parentSessionId: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): boolean {
  const child = sanitizeHarnessSessionId(params.childSessionId);
  const parent = sanitizeHarnessSessionId(params.parentSessionId);
  if (!child || !parent || child === parent) {
    return false;
  }
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const filePath = resolveParentMapFilePath(env);
  const dir = path.dirname(filePath);

  let tmpPath: string | null = null;
  try {
    const dirExisted = fs.existsSync(dir);
    if (!dirExisted) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // ignore on platforms without POSIX chmod
      }
    }

    const links = readParentMapSafe(filePath, nowMs);
    links[child] = { parent, updatedAt: nowMs };

    const entries = Object.entries(links);
    if (entries.length > MAX_PARENT_MAP_ENTRIES) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      const trimmed: Record<string, HarnessParentMapEntry> = {};
      for (const [k, v] of entries.slice(0, MAX_PARENT_MAP_ENTRIES)) {
        trimmed[k] = v;
      }
      for (const k of Object.keys(links)) {
        if (!(k in trimmed)) delete links[k];
      }
    }

    const payload: HarnessParentMapSchema = {
      version: 1,
      links,
    };
    tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // ignore
    }
    fs.renameSync(tmpPath, filePath);
    tmpPath = null;
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // ignore
    }
    return true;
  } catch {
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
    }
    return false;
  }
}

/**
 * Looks up a recorded parent session ID from `parent-map.json` safely.
 * Ignores missing, unreadable, corrupt, or expired (>24h) entries without throwing.
 */
export function lookupHarnessParentSession(
  sessionId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): string | null {
  const child = sanitizeHarnessSessionId(sessionId);
  if (!child) return null;
  const filePath = resolveParentMapFilePath(env);
  const links = readParentMapSafe(filePath, nowMs);
  if (!Object.hasOwn(links, child)) return null;
  const entry = links[child];
  if (!entry || entry.parent === child) return null;
  return entry.parent;
}

/**
 * Resolves native coding-harness session, parent-session, and client-hint context from env
 * plus the local `parent-map.json` cache (used by Antigravity, Claude Code, Codex, and OpenCode).
 */
export function resolveHarnessSessionContext(
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): HarnessSessionContext {
  const candidates: Array<{ envKey: string; inferredClient: string | null }> = [
    { envKey: "MERU_MIND_SESSION_ID", inferredClient: null },
    { envKey: "ANTIGRAVITY_CONVERSATION_ID", inferredClient: "antigravity" },
    { envKey: "CLAUDE_SESSION_ID", inferredClient: "claude-code" },
    { envKey: "CODEX_THREAD_ID", inferredClient: "codex" },
    { envKey: "OPENCODE_SESSION_ID", inferredClient: "opencode" },
  ];

  let sessionTag: string | null = null;
  let inferredClient: string | null = null;
  for (const c of candidates) {
    const val = sanitizeHarnessSessionId(env[c.envKey]);
    if (val) {
      if (!sessionTag) {
        sessionTag = val;
      }
      if (!inferredClient && c.inferredClient) {
        inferredClient = c.inferredClient;
      }
      if (sessionTag && inferredClient) break;
    }
  }

  const clientHint =
    sanitizeHarnessClientHint(env.MERU_MIND_CLIENT) ?? inferredClient;

  const explicitParent =
    sanitizeHarnessSessionId(env.MERU_MIND_PARENT_SESSION_ID) ??
    sanitizeHarnessSessionId(env.ANTIGRAVITY_PARENT_CONVERSATION_ID) ??
    sanitizeHarnessSessionId(env.CLAUDE_PARENT_SESSION_ID) ??
    sanitizeHarnessSessionId(env.CODEX_PARENT_THREAD_ID);

  let parentSessionTag =
    explicitParent ??
    (sessionTag ? lookupHarnessParentSession(sessionTag, env, nowMs) : null);

  if (parentSessionTag && sessionTag && parentSessionTag === sessionTag) {
    parentSessionTag = null;
  }

  return {
    sessionTag,
    parentSessionTag,
    clientHint,
  };
}
