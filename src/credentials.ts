import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MindError } from "./types.js";

export interface SavedProfileCredential {
  token: string;
  tokenId: string;
  actorId: string;
  actorKind: "human" | "agent";
  expiresAt: string | null;
  savedAt: string;
}

export interface CredentialsFileSchema {
  version: 1;
  defaultUrl: string | null;
  profiles: Record<string, SavedProfileCredential>;
}

export function normalizeServerUrlKey(rawUrl: string): string {
  return rawUrl.trim().replace(/\/+$/, "");
}

export function resolveCredentialsFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.MERU_MIND_CREDENTIALS_FILE?.trim();
  if (override) return path.resolve(override);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".config");
  return path.join(base, "meru-mind", "credentials");
}

export function readCredentialsFile(
  env: NodeJS.ProcessEnv = process.env,
): CredentialsFileSchema {
  const filePath = resolveCredentialsFilePath(env);
  if (!fs.existsSync(filePath)) {
    return { version: 1, defaultUrl: null, profiles: {} };
  }
  if (process.platform !== "win32") {
    const st = fs.statSync(filePath);
    if ((st.mode & 0o077) !== 0) {
      throw new MindError(
        "ACCESS_DENIED",
        `Credentials file "${filePath}" has overly permissive permissions (${(st.mode & 0o777).toString(8)}); fix with 'chmod 600 ${filePath}'.`,
      );
    }
  }
  let parsed: Partial<CredentialsFileSchema>;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw) as Partial<CredentialsFileSchema>;
  } catch (err) {
    throw new MindError(
      "INVALID_INPUT",
      `Credentials file "${filePath}" is corrupted and cannot be parsed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const profiles: Record<string, SavedProfileCredential> = {};
  if (parsed.profiles && typeof parsed.profiles === "object") {
    for (const [k, v] of Object.entries(parsed.profiles)) {
      if (
        v &&
        typeof v === "object" &&
        typeof v.token === "string" &&
        v.token.trim()
      ) {
        profiles[normalizeServerUrlKey(k)] = {
          token: v.token,
          tokenId: String(v.tokenId ?? ""),
          actorId: String(v.actorId ?? ""),
          actorKind: v.actorKind === "agent" ? "agent" : "human",
          expiresAt: typeof v.expiresAt === "string" ? v.expiresAt : null,
          savedAt: String(v.savedAt ?? ""),
        };
      }
    }
  }
  return {
    version: 1,
    defaultUrl:
      typeof parsed.defaultUrl === "string" && parsed.defaultUrl.trim()
        ? normalizeServerUrlKey(parsed.defaultUrl)
        : null,
    profiles,
  };
}

/**
 * Atomically saves a server profile token into `~/.config/meru-mind/credentials` with `0o600` permissions.
 */
export function saveProfileCredential(params: {
  serverUrl: string;
  credential: SavedProfileCredential;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = params.env ?? process.env;
  const filePath = resolveCredentialsFilePath(env);
  const dir = path.dirname(filePath);
  const dirExisted = fs.existsSync(dir);
  if (!dirExisted) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // ignore on platforms without POSIX chmod
    }
  }

  const key = normalizeServerUrlKey(params.serverUrl);
  const current = readCredentialsFile(env);
  current.profiles[key] = params.credential;
  current.defaultUrl = key;

  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2) + "\n", {
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
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
  return filePath;
}

export function lookupSavedCredential(
  serverUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): SavedProfileCredential | null {
  const key = normalizeServerUrlKey(serverUrl);
  const data = readCredentialsFile(env);
  return data.profiles[key] ?? null;
}
