import fs from "node:fs";
import path from "node:path";
import { MindError } from "../types.js";

export const SERVE_LOCK_FILENAME = "mind.serve.lock";

export interface ServeLockInfo {
  pid: number;
  url: string;
  startedAt: string;
  orgId?: string;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPERM means the process exists and belongs to another user
    return code === "EPERM";
  }
}

export function readLiveServeLock(homeDir: string): ServeLockInfo | null {
  const lockPath = path.join(path.resolve(homeDir), SERVE_LOCK_FILENAME);
  if (!fs.existsSync(lockPath)) return null;
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ServeLockInfo>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.url === "string" &&
      isProcessAlive(parsed.pid)
    ) {
      return {
        pid: parsed.pid,
        url: parsed.url,
        startedAt:
          typeof parsed.startedAt === "string" ? parsed.startedAt : "",
        ...(typeof parsed.orgId === "string" ? { orgId: parsed.orgId } : {}),
      };
    }
  } catch {
    // Unparseable or vanished lock file -> treat as stale
  }
  return null;
}

/**
 * Throws CONFLICT when a live `meru-mind serve` process holds the exclusive writer lock on `homeDir`.
 * Prevents local CLI / stdio MCP processes from opening `mind.sqlite` directly and bypassing Principal auth.
 */
export function assertNoLiveServeLock(homeDir: string): void {
  const live = readLiveServeLock(homeDir);
  if (!live) return;
  throw new MindError(
    "CONFLICT",
    `Store "${path.resolve(homeDir)}" is exclusively locked by running meru-mind serve (pid ${live.pid} at ${live.url}). Direct local SQLite access is blocked while the server is running; connect over HTTP with MERU_MIND_URL and MERU_MIND_TOKEN.`,
    {
      reason: "serve_lock_active",
      pid: live.pid,
      url: live.url,
      try: `MERU_MIND_URL=${live.url} MERU_MIND_TOKEN=<token> meru-mind whoami`,
    },
  );
}

export interface ServeWriterLockHandle {
  readonly lockPath: string;
  readonly info: ServeLockInfo;
  updateInfo(patch: Partial<Pick<ServeLockInfo, "url" | "orgId">>): void;
  release(): void;
}

/**
 * Acquires the single-writer exclusive lock (`<homeDir>/mind.serve.lock`) using O_CREAT | O_EXCL.
 * Automatically reclaims stale locks left by crashed processes whose PID is no longer alive.
 */
export function acquireServeWriterLock(params: {
  homeDir: string;
  url: string;
  orgId?: string;
}): ServeWriterLockHandle {
  const absHome = path.resolve(params.homeDir);
  fs.mkdirSync(absHome, { recursive: true });
  const lockPath = path.join(absHome, SERVE_LOCK_FILENAME);

  const info: ServeLockInfo = {
    pid: process.pid,
    url: params.url,
    startedAt: new Date().toISOString(),
    ...(params.orgId ? { orgId: params.orgId } : {}),
  };
  const payload = JSON.stringify(info, null, 2) + "\n";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, payload, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const cur = fs.readFileSync(lockPath, "utf8");
          const parsed = JSON.parse(cur) as Partial<ServeLockInfo>;
          if (parsed.pid === process.pid) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // already removed
        }
      };
      const updateInfo = (
        patch: Partial<Pick<ServeLockInfo, "url" | "orgId">>,
      ) => {
        if (released) return;
        if (patch.url !== undefined) info.url = patch.url;
        if (patch.orgId !== undefined) info.orgId = patch.orgId;
        fs.writeFileSync(lockPath, JSON.stringify(info, null, 2) + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
      };
      return { lockPath, info, updateInfo, release };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      const live = readLiveServeLock(absHome);
      if (live) {
        throw new MindError(
          "CONFLICT",
          `Another meru-mind serve instance (pid ${live.pid}) already holds the exclusive writer lock on "${absHome}" (${live.url}).`,
          {
            reason: "serve_lock_active",
            pid: live.pid,
            url: live.url,
          },
        );
      }
      // Stale lock from dead process: remove and retry
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // raced with another cleaner
      }
    }
  }

  throw new MindError(
    "CONFLICT",
    `Failed to acquire exclusive writer lock at ${lockPath} after stale-lock recovery.`,
  );
}
