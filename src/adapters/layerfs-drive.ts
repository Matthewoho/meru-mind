import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DrivePort, DriveWriteResult } from "../ports.js";
import {
  MindError,
  type DriveFileContent,
  type DriveFileMeta,
} from "../types.js";
import {
  assertSafeIdentifier,
  normalizeSafeRelPath,
} from "./local-drive.js";

/**
 * Minimal structural interface matching the @layerfs/agent SDK.
 * Allows both real LayerFS runtime injection (via dynamic import or LAYERFS_SDK_DIR)
 * and deterministic test harness injection without bundling proprietary binaries.
 */
export interface LayerFSWorkspaceHandle {
  sandbox: string;
  path: string;
}

export interface LayerFSClientLike {
  projectName: string;
  branch: {
    fork(name: string, fromRef?: string): Promise<unknown>;
  };
  sandbox: {
    create(options?: { image?: string }): Promise<{ sandbox: string }>;
    close(sandbox: string): Promise<unknown>;
  };
  workspace: {
    mount(
      sandbox: string,
      branch: string,
    ): Promise<LayerFSWorkspaceHandle>;
    exec(
      ws: LayerFSWorkspaceHandle,
      command: string,
      message?: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    commit(
      ws: LayerFSWorkspaceHandle,
      message: string,
      force?: boolean,
    ): Promise<{ kind: string; commitId?: string }>;
    unmount(
      ws: LayerFSWorkspaceHandle,
      discard?: boolean,
      force?: boolean,
    ): Promise<unknown>;
  };
  close(): Promise<void>;
}

export interface LayerFSRuntimeLike {
  worker: { start(): Promise<unknown> };
  project: {
    list(): Promise<Array<{ name: string; initialized: boolean }>>;
    start_init(
      name: string,
      folder: string,
      options?: Record<string, unknown>,
    ): Promise<{ id: string; ended?: boolean; error?: unknown }>;
    get_init(
      job: { id: string } | string,
    ): Promise<{ id: string; ended: boolean; error?: unknown }>;
  };
  close(): Promise<void>;
}

export interface LayerFSSdkModule {
  LayerFSRuntime?: {
    open(settings: Record<string, unknown>): Promise<LayerFSRuntimeLike>;
  };
  LayerFS: {
    open(projectName: string): Promise<LayerFSClientLike>;
  };
}

export interface LayerFSDriveOptions {
  projectName: string;
  homeDir: string;
  baseBranch?: string;
  sandboxImage?: string;
  /** Optional explicit SDK module path or package name (defaults to LAYERFS_SDK_DIR or "@layerfs/agent") */
  sdkSpecifier?: string;
  /** Optional pre-loaded SDK client for dependency injection / testing */
  client?: LayerFSClientLike;
  /** Optional callback to look up expected version metadata from canonical DB */
  getCanonicalMeta?: (realmId: string, relPath: string) => DriveFileMeta | null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function assertSafeRealmId(realmId: string): void {
  assertSafeIdentifier(realmId, "realmId");
}

async function loadLayerFSSdk(specifier?: string): Promise<LayerFSSdkModule> {
  const envDir = process.env.LAYERFS_SDK_DIR?.trim();
  const target = specifier ?? envDir ?? "@layerfs/agent";
  try {
    const resolved =
      target.startsWith("/") || target.startsWith(".")
        ? pathToFileURL(path.resolve(target)).href
        : target;
    const mod = (await import(resolved)) as unknown as LayerFSSdkModule;
    if (!mod?.LayerFS?.open) {
      throw new Error(`Module "${target}" does not export LayerFS.open`);
    }
    return mod;
  } catch (err) {
    throw new MindError(
      "DRIVE_ERROR",
      `Failed to load LayerFS SDK ("${target}"). Install @layerfs/agent or set LAYERFS_SDK_DIR, or use drive="local". Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * LayerFS-backed MindRealm shared file drive.
 *
 * Design guarantees (aligned with LayerFS physical properties):
 * 1. Entire MindRealm file tree lives inside one LayerFS project under realms/<realmId>/<relPath>.
 * 2. Visibility isolation is NEVER delegated to FUSE; MindRealm VisibilityPolicy gates all reads/writes.
 * 3. Every write commits atomically on LayerFS; if LayerFS returns kind="Conflict" (or expectedVersion
 *    mismatches), writeFile fails fast with MindError("CONFLICT") without overwriting the winner.
 * 4. Because LayerFS storage is disposable on host crashes, Meru Mind mirrors every committed file
 *    into immutable BlobPort + SQLite metadata, enabling full recovery via restoreFromSnapshots().
 */
export class LayerFSDriveAdapter implements DrivePort {
  readonly kind = "layerfs" as const;
  private readonly options: LayerFSDriveOptions;
  private readonly baseBranch: string;
  private runtime: LayerFSRuntimeLike | null = null;
  private client: LayerFSClientLike | null = null;
  private sandboxId: string | null = null;
  private workspace: LayerFSWorkspaceHandle | null = null;
  private readonly versions = new Map<string, DriveFileMeta>();

  constructor(options: LayerFSDriveOptions) {
    this.options = options;
    this.baseBranch = options.baseBranch ?? "main";
    if (options.client) {
      this.client = options.client;
    }
  }

  async init(): Promise<void> {
    if (!this.client) {
      const sdk = await loadLayerFSSdk(this.options.sdkSpecifier);
      if (sdk.LayerFSRuntime) {
        this.runtime = await sdk.LayerFSRuntime.open({
          home: this.options.homeDir,
        });
        await this.runtime.worker.start();
        const projects = await this.runtime.project.list();
        const exists = projects.some(
          (p) => p.name === this.options.projectName && p.initialized,
        );
        if (!exists) {
          const seedDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "meru-mind-lfs-seed-"),
          );
          try {
            fs.mkdirSync(path.join(seedDir, "realms"), { recursive: true });
            fs.writeFileSync(
              path.join(seedDir, "realms", ".gitkeep"),
              "",
              "utf8",
            );
            let job = await this.runtime.project.start_init(
              this.options.projectName,
              seedDir,
            );
            while (!job.ended) {
              await new Promise((r) => setTimeout(r, 150));
              job = await this.runtime.project.get_init(job);
            }
            if (job.error) {
              throw new MindError(
                "DRIVE_ERROR",
                `LayerFS project init failed: ${JSON.stringify(job.error)}`,
              );
            }
          } finally {
            fs.rmSync(seedDir, { recursive: true, force: true });
          }
        }
      }
      this.client = await sdk.LayerFS.open(this.options.projectName);
    }

    if (!this.sandboxId) {
      const created = await this.client.sandbox.create(
        this.options.sandboxImage
          ? { image: this.options.sandboxImage }
          : undefined,
      );
      this.sandboxId = created.sandbox;
    }

    if (!this.workspace) {
      this.workspace = await this.client.workspace.mount(
        this.sandboxId,
        this.baseBranch,
      );
    }
  }

  private ensureReady(): {
    client: LayerFSClientLike;
    ws: LayerFSWorkspaceHandle;
  } {
    if (!this.client || !this.workspace) {
      throw new MindError(
        "DRIVE_ERROR",
        "LayerFSDriveAdapter is not initialized. Call init() first.",
      );
    }
    return { client: this.client, ws: this.workspace };
  }

  private metaKey(realmId: string, relPath: string): string {
    return `${realmId}/${relPath}`;
  }

  private drivePath(realmId: string, relPath: string): string {
    assertSafeRealmId(realmId);
    const safe = normalizeSafeRelPath(relPath);
    return `realms/${realmId}/${safe}`;
  }

  async readFile(
    realmId: string,
    relPath: string,
  ): Promise<DriveFileContent | null> {
    const { client, ws } = this.ensureReady();
    const safe = normalizeSafeRelPath(relPath);
    const fullRel = this.drivePath(realmId, safe);
    const res = await client.workspace.exec(
      ws,
      `if [ -f ${shellQuote(fullRel)} ]; then base64 < ${shellQuote(fullRel)}; else exit 44; fi`,
    );
    if (res.exitCode === 44) {
      return null;
    }
    if (res.exitCode !== 0) {
      throw new MindError(
        "DRIVE_ERROR",
        `LayerFS readFile failed (${res.exitCode}): ${res.stderr}`,
      );
    }
    const content = Buffer.from(res.stdout.replace(/\s+/g, ""), "base64").toString(
      "utf8",
    );
    const sha256 = crypto
      .createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    const known =
      this.versions.get(this.metaKey(realmId, safe)) ??
      this.options.getCanonicalMeta?.(realmId, safe) ??
      null;

    return {
      realmId,
      relPath: safe,
      content,
      sha256: known?.sha256 ?? sha256,
      version: known?.version ?? 1,
      updatedBy: known?.updatedBy ?? "unknown",
      updatedAt: known?.updatedAt ?? new Date(0).toISOString(),
    };
  }

  async listFiles(realmId: string): Promise<DriveFileMeta[]> {
    assertSafeRealmId(realmId);
    const { client, ws } = this.ensureReady();
    const dir = `realms/${realmId}`;
    const res = await client.workspace.exec(
      ws,
      `if [ -d ${shellQuote(dir)} ]; then find ${shellQuote(dir)} -type f | sort; fi`,
    );
    if (res.exitCode !== 0) {
      throw new MindError(
        "DRIVE_ERROR",
        `LayerFS listFiles failed (${res.exitCode}): ${res.stderr}`,
      );
    }
    const lines = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.endsWith("/.gitkeep"));

    const results: DriveFileMeta[] = [];
    for (const line of lines) {
      const prefix = `${dir}/`;
      const relPath = line.startsWith(prefix) ? line.slice(prefix.length) : line;
      const known =
        this.versions.get(this.metaKey(realmId, relPath)) ??
        this.options.getCanonicalMeta?.(realmId, relPath) ??
        null;
      if (known) {
        results.push(known);
      } else {
        const read = await this.readFile(realmId, relPath);
        if (read) {
          results.push({
            realmId: read.realmId,
            relPath: read.relPath,
            sha256: read.sha256,
            version: read.version,
            updatedBy: read.updatedBy,
            updatedAt: read.updatedAt,
          });
        }
      }
    }
    return results;
  }

  async writeFile(params: {
    realmId: string;
    relPath: string;
    content: string;
    authorId: string;
    expectedVersion?: number;
    message?: string;
  }): Promise<DriveWriteResult> {
    const { client, ws } = this.ensureReady();
    const safe = normalizeSafeRelPath(params.relPath);
    const fullRel = this.drivePath(params.realmId, safe);

    const known =
      this.versions.get(this.metaKey(params.realmId, safe)) ??
      this.options.getCanonicalMeta?.(params.realmId, safe) ??
      null;
    const currentVersion = known?.version ?? 0;

    if (
      params.expectedVersion !== undefined &&
      params.expectedVersion !== currentVersion
    ) {
      throw new MindError(
        "CONFLICT",
        `LayerFS write conflict on "${params.realmId}/${safe}": expected version ${params.expectedVersion}, actual version ${currentVersion}.`,
        {
          realmId: params.realmId,
          relPath: safe,
          expectedVersion: params.expectedVersion,
          actualVersion: currentVersion,
        },
      );
    }

    // Snapshot prior file state so a rejected/conflicted commit leaves the workspace clean
    const priorRead = await this.readFile(params.realmId, safe);
    const encoded = Buffer.from(params.content, "utf8").toString("base64");
    const dir = path.posix.dirname(fullRel);
    const writeRes = await client.workspace.exec(
      ws,
      `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(fullRel)}`,
    );
    if (writeRes.exitCode !== 0) {
      throw new MindError(
        "DRIVE_ERROR",
        `LayerFS write exec failed (${writeRes.exitCode}): ${writeRes.stderr}`,
      );
    }

    const commitRes = await client.workspace.commit(
      ws,
      params.message ?? `mind: update ${params.realmId}/${safe}`,
    );

    if (commitRes.kind.toLowerCase() === "conflict") {
      // Roll back the dirty workspace file to the winning state before throwing CONFLICT
      if (priorRead) {
        const priorEncoded = Buffer.from(priorRead.content, "utf8").toString("base64");
        await client.workspace.exec(
          ws,
          `printf %s ${shellQuote(priorEncoded)} | base64 -d > ${shellQuote(fullRel)}`,
        );
      } else {
        await client.workspace.exec(ws, `rm -f ${shellQuote(fullRel)}`);
      }
      throw new MindError(
        "CONFLICT",
        `LayerFS reported a concurrent write conflict on "${params.realmId}/${safe}". Nothing was committed; re-read and retry.`,
        {
          realmId: params.realmId,
          relPath: safe,
          layerfsKind: commitRes.kind,
        },
      );
    }

    const sha256 = crypto
      .createHash("sha256")
      .update(params.content, "utf8")
      .digest("hex");
    const meta: DriveFileMeta = {
      realmId: params.realmId,
      relPath: safe,
      sha256,
      version: currentVersion + 1,
      updatedBy: params.authorId,
      updatedAt: new Date().toISOString(),
    };
    this.versions.set(this.metaKey(params.realmId, safe), meta);
    return { meta, commitId: commitRes.commitId };
  }

  async restoreFromSnapshots(
    snapshots: Array<{ meta: DriveFileMeta; content: string }>,
  ): Promise<number> {
    const { client, ws } = this.ensureReady();
    const clearRes = await client.workspace.exec(ws, `rm -rf realms && mkdir -p realms`);
    if (clearRes.exitCode !== 0) {
      throw new MindError(
        "DRIVE_ERROR",
        `LayerFS restore clear failed: ${clearRes.stderr}`,
      );
    }
    this.versions.clear();

    let count = 0;
    for (const snap of snapshots) {
      const safe = normalizeSafeRelPath(snap.meta.relPath);
      const fullRel = this.drivePath(snap.meta.realmId, safe);
      const dir = path.posix.dirname(fullRel);
      const encoded = Buffer.from(snap.content, "utf8").toString("base64");
      const res = await client.workspace.exec(
        ws,
        `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(fullRel)}`,
      );
      if (res.exitCode !== 0) {
        throw new MindError(
          "DRIVE_ERROR",
          `LayerFS restore file failed for ${fullRel}: ${res.stderr}`,
        );
      }
      this.versions.set(this.metaKey(snap.meta.realmId, safe), snap.meta);
      count += 1;
    }

    if (count > 0) {
      await client.workspace.commit(
        ws,
        `mind: rebuild drive from ${count} canonical snapshots`,
        true,
      );
    }
    return count;
  }

  async close(): Promise<void> {
    if (this.client && this.workspace) {
      try {
        await this.client.workspace.unmount(this.workspace, false, true);
      } catch {
        // ignore unmount errors on shutdown
      }
      this.workspace = null;
    }
    if (this.client && this.sandboxId) {
      try {
        await this.client.sandbox.close(this.sandboxId);
      } catch {
        // ignore sandbox close errors on shutdown
      }
      this.sandboxId = null;
    }
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    if (this.runtime) {
      await this.runtime.close();
      this.runtime = null;
    }
  }
}
