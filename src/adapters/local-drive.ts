import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DrivePort, DriveWriteResult } from "../ports.js";
import {
  MindError,
  type DriveFileContent,
  type DriveFileMeta,
} from "../types.js";

interface StoredDriveMeta {
  version: number;
  sha256: string;
  updatedBy: string;
  updatedAt: string;
}

export function normalizeSafeRelPath(relPath: string): string {
  if (typeof relPath !== "string" || /[\x00-\x1f]/.test(relPath)) {
    throw new MindError(
      "INVALID_INPUT",
      `Drive path contains forbidden control characters or null bytes`,
    );
  }
  const cleaned = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.endsWith("/")) {
    throw new MindError("INVALID_INPUT", `Invalid drive path: "${relPath}"`);
  }
  const segments = cleaned.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      throw new MindError(
        "INVALID_INPUT",
        `Path traversal or empty segment is forbidden in drive path: "${relPath}"`,
      );
    }
  }
  return segments.join("/");
}

export function assertSafeIdentifier(id: string, label = "realmId"): void {
  if (
    !id ||
    id === "." ||
    id === ".." ||
    id.includes("..") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)
  ) {
    throw new MindError("INVALID_INPUT", `Invalid ${label}: "${id}"`);
  }
}

function assertSafeRealmId(realmId: string): void {
  assertSafeIdentifier(realmId, "realmId");
}

/**
 * Local filesystem DrivePort adapter with optimistic version conflict detection.
 * Zero-Docker local drive adapter backed by SQLite + immutable blob mirrors.
 */
export class LocalFsDriveAdapter implements DrivePort {
  readonly kind = "local" as const;
  private readonly rootDir: string;
  private readonly filesDir: string;
  private readonly metaDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.filesDir = path.join(rootDir, "realms");
    this.metaDir = path.join(rootDir, ".meta");
  }

  async init(): Promise<void> {
    fs.mkdirSync(this.filesDir, { recursive: true });
    fs.mkdirSync(this.metaDir, { recursive: true });
  }

  private filePath(realmId: string, relPath: string): string {
    assertSafeRealmId(realmId);
    const safe = normalizeSafeRelPath(relPath);
    return path.join(this.filesDir, realmId, safe);
  }

  private metaPath(realmId: string, relPath: string): string {
    assertSafeRealmId(realmId);
    const safe = normalizeSafeRelPath(relPath);
    return path.join(this.metaDir, realmId, `${safe}.json`);
  }

  private readStoredMeta(
    realmId: string,
    relPath: string,
  ): StoredDriveMeta | null {
    const mp = this.metaPath(realmId, relPath);
    if (!fs.existsSync(mp)) return null;
    return JSON.parse(fs.readFileSync(mp, "utf8")) as StoredDriveMeta;
  }

  async readFile(
    realmId: string,
    relPath: string,
  ): Promise<DriveFileContent | null> {
    const safe = normalizeSafeRelPath(relPath);
    const fp = this.filePath(realmId, safe);
    if (!fs.existsSync(fp)) return null;
    const content = fs.readFileSync(fp, "utf8");
    const stored = this.readStoredMeta(realmId, safe);
    const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
    return {
      realmId,
      relPath: safe,
      content,
      sha256: stored?.sha256 ?? sha256,
      version: stored?.version ?? 1,
      updatedBy: stored?.updatedBy ?? "unknown",
      updatedAt: stored?.updatedAt ?? new Date(0).toISOString(),
    };
  }

  async listFiles(realmId: string): Promise<DriveFileMeta[]> {
    assertSafeRealmId(realmId);
    const realmRoot = path.join(this.filesDir, realmId);
    if (!fs.existsSync(realmRoot)) return [];

    const results: DriveFileMeta[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const relPath = path
            .relative(realmRoot, full)
            .split(path.sep)
            .join("/");
          const stored = this.readStoredMeta(realmId, relPath);
          const content = fs.readFileSync(full, "utf8");
          const sha256 =
            stored?.sha256 ??
            crypto.createHash("sha256").update(content, "utf8").digest("hex");
          results.push({
            realmId,
            relPath,
            sha256,
            version: stored?.version ?? 1,
            updatedBy: stored?.updatedBy ?? "unknown",
            updatedAt: stored?.updatedAt ?? new Date(0).toISOString(),
          });
        }
      }
    };
    walk(realmRoot);
    results.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return results;
  }

  private async withFileLock<T>(
    realmId: string,
    relPath: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const lockDir = path.join(this.rootDir, ".locks");
    fs.mkdirSync(lockDir, { recursive: true });
    const lockKey = crypto
      .createHash("sha256")
      .update(`${realmId}/${relPath}`)
      .digest("hex");
    const lockPath = path.join(lockDir, `${lockKey}.lock`);

    const deadline = Date.now() + 5000;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(fd, `${process.pid}:${Date.now()}`, "utf8");
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code !== "EEXIST") throw err;
        // Clean stale lock older than 30 seconds
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 30_000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new MindError(
            "CONFLICT",
            `Timed out waiting for drive write lock on "${realmId}/${relPath}"`,
          );
        }
        await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 15)));
      }
    }

    try {
      return await fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
    }
  }

  async writeFile(params: {
    realmId: string;
    relPath: string;
    content: string;
    authorId: string;
    expectedVersion?: number;
    message?: string;
  }): Promise<DriveWriteResult> {
    const safe = normalizeSafeRelPath(params.relPath);
    assertSafeRealmId(params.realmId);

    return this.withFileLock(params.realmId, safe, () => {
      const fp = this.filePath(params.realmId, safe);
      const mp = this.metaPath(params.realmId, safe);

      const existing = this.readStoredMeta(params.realmId, safe);
      const currentVersion = existing?.version ?? 0;

      if (
        params.expectedVersion !== undefined &&
        params.expectedVersion !== currentVersion
      ) {
        throw new MindError(
          "CONFLICT",
          `Drive write conflict on "${params.realmId}/${safe}": expected version ${params.expectedVersion}, actual version ${currentVersion}. Re-read before writing.`,
          {
            realmId: params.realmId,
            relPath: safe,
            expectedVersion: params.expectedVersion,
            actualVersion: currentVersion,
          },
        );
      }

      const sha256 = crypto
        .createHash("sha256")
        .update(params.content, "utf8")
        .digest("hex");
      const nextVersion = currentVersion + 1;
      const updatedAt = new Date().toISOString();

      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.mkdirSync(path.dirname(mp), { recursive: true });

      const nonce = crypto.randomBytes(6).toString("hex");
      const tmpFile = `${fp}.tmp.${process.pid}.${nonce}`;
      fs.writeFileSync(tmpFile, params.content, "utf8");
      fs.renameSync(tmpFile, fp);

      const stored: StoredDriveMeta = {
        version: nextVersion,
        sha256,
        updatedBy: params.authorId,
        updatedAt,
      };
      const tmpMeta = `${mp}.tmp.${process.pid}.${nonce}`;
      fs.writeFileSync(tmpMeta, JSON.stringify(stored, null, 2), "utf8");
      fs.renameSync(tmpMeta, mp);

      return {
        meta: {
          realmId: params.realmId,
          relPath: safe,
          sha256,
          version: nextVersion,
          updatedBy: params.authorId,
          updatedAt,
        },
      };
    });
  }

  async restoreFromSnapshots(
    snapshots: Array<{ meta: DriveFileMeta; content: string }>,
  ): Promise<number> {
    fs.rmSync(this.filesDir, { recursive: true, force: true });
    fs.rmSync(this.metaDir, { recursive: true, force: true });
    await this.init();

    let count = 0;
    for (const snap of snapshots) {
      const safe = normalizeSafeRelPath(snap.meta.relPath);
      const fp = this.filePath(snap.meta.realmId, safe);
      const mp = this.metaPath(snap.meta.realmId, safe);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.mkdirSync(path.dirname(mp), { recursive: true });
      fs.writeFileSync(fp, snap.content, "utf8");
      const stored: StoredDriveMeta = {
        version: snap.meta.version,
        sha256: snap.meta.sha256,
        updatedBy: snap.meta.updatedBy,
        updatedAt: snap.meta.updatedAt,
      };
      fs.writeFileSync(mp, JSON.stringify(stored, null, 2), "utf8");
      count += 1;
    }
    return count;
  }

  async close(): Promise<void> {
    // Nothing to release for local filesystem adapter
  }
}
