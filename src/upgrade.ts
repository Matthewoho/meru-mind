import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MindError } from "./types.js";
import { MERU_MIND_VERSION } from "./version.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_RELEASES_API_URL =
  "https://api.github.com/repos/Matthewoho/meru-mind/releases/latest";

const ALLOWED_RELEASE_URL_PREFIX =
  "https://github.com/Matthewoho/meru-mind/releases/";
const MAX_HTTP_RESPONSE_BYTES = 256 * 1024;
const EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export type InstallMode = "container" | "git" | "unknown";

export interface InstallInfo {
  mode: InstallMode;
  rootDir: string | null;
  scriptPath: string;
}

export interface RemoteServerVersionInfo {
  url: string;
  version: string | null;
  updateAvailable: boolean | null;
  error?: string;
}

export interface UpgradeCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  updateAvailable: boolean | null;
  install: InstallInfo;
  recommendedCommands: string[];
  remoteServer?: RemoteServerVersionInfo;
  checkError?: string;
}

export interface UpgradeRunResult {
  upgraded: boolean;
  checkOnly: boolean;
  upToDate: boolean;
  inContainer: boolean;
  mode: InstallMode;
  previousVersion: string;
  newVersion: string | null;
  latestVersion: string | null;
  latestTag: string | null;
  releaseUrl: string | null;
  instructions: string[];
  commandsRun: string[];
  message: string;
  remoteServer?: RemoteServerVersionInfo;
  checkError?: string;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = async (file, args, options) => {
  const res = await execFileAsync(file, args, {
    cwd: options?.cwd,
    encoding: "utf8",
    maxBuffer: EXEC_MAX_BUFFER_BYTES,
  });
  return {
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
};

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function sanitizeInlineText(raw: string, maxLen = 200): string {
  return raw
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function parseSemver(raw: string): ParsedSemver | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  const m =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      cleaned,
    );
  if (!m) return null;
  return {
    major: Number.parseInt(m[1]!, 10),
    minor: Number.parseInt(m[2]!, 10),
    patch: Number.parseInt(m[3]!, 10),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

function sanitizeReleaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\s\x00-\x1f\x7f]/.test(trimmed)) return null;
  if (!trimmed.startsWith(ALLOWED_RELEASE_URL_PREFIX)) return null;
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      !parsed.href.startsWith(ALLOWED_RELEASE_URL_PREFIX)
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Compares two SemVer strings (stripping optional leading `v`, handling pre-releases conservatively).
 * Returns -1 if a < b, 0 if equal (or unparseable), and 1 if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  const aHasPre = pa.prerelease.length > 0;
  const bHasPre = pb.prerelease.length > 0;
  if (!aHasPre && !bHasPre) return 0;
  if (!aHasPre && bHasPre) return 1;
  if (aHasPre && !bHasPre) return -1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const ai = pa.prerelease[i];
    const bi = pb.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const an = Number.parseInt(ai, 10);
      const bn = Number.parseInt(bi, 10);
      return an < bn ? -1 : 1;
    }
    if (aNum !== bNum) return aNum ? -1 : 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

export interface DetectInstallModeOptions {
  scriptPath?: string;
  fsExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  env?: NodeJS.ProcessEnv;
}

function defaultScriptPath(): string {
  const raw = process.argv[1] || fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(raw);
  } catch {
    return path.resolve(raw);
  }
}

export function detectInstallMode(
  options: DetectInstallModeOptions = {},
): InstallInfo {
  const env = options.env ?? process.env;
  const fsExists = options.fsExists ?? ((p: string) => fs.existsSync(p));
  const readFile =
    options.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const scriptPath = options.scriptPath ?? defaultScriptPath();

  // 1. Container detection (Docker, Podman, Kubernetes cgroup v1/v2 — NEVER self-upgrade inside a container)
  if (
    env.MERU_MIND_IN_CONTAINER === "1" ||
    Boolean(env.KUBERNETES_SERVICE_HOST?.trim()) ||
    fsExists("/.dockerenv") ||
    fsExists("/run/.containerenv")
  ) {
    return { mode: "container", rootDir: null, scriptPath };
  }
  try {
    const cgroup = readFile("/proc/1/cgroup");
    if (/docker|containerd|kubepods|podman/i.test(cgroup)) {
      return { mode: "container", rootDir: null, scriptPath };
    }
  } catch {
    // non-Linux or unreadable /proc/1/cgroup
  }

  // 2. Walk up from scriptPath to find this package's package.json (and check for sibling .git)
  let pkgRoot: string | null = null;
  let cur = path.dirname(path.resolve(scriptPath));
  const fsRoot = path.parse(cur).root;
  while (cur && cur !== fsRoot) {
    const pkgJsonPath = path.join(cur, "package.json");
    if (fsExists(pkgJsonPath)) {
      try {
        const parsed = JSON.parse(readFile(pkgJsonPath)) as { name?: string };
        if (parsed.name === "@meru-mind/core") {
          pkgRoot = cur;
          if (fsExists(path.join(cur, ".git"))) {
            return { mode: "git", rootDir: cur, scriptPath };
          }
          break;
        }
      } catch {
        // ignore invalid package.json
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // Do NOT auto-install from npmjs.org unless/until an official registry release is explicitly published & owned.
  return { mode: "unknown", rootDir: pkgRoot, scriptPath };
}

function recommendedCommandsForMode(mode: InstallMode): string[] {
  switch (mode) {
    case "container":
      return [
        "meru-mind admin backup",
        "docker compose pull meru-mind && docker compose up -d meru-mind",
      ];
    case "git":
      return [
        "git fetch --tags && git pull --ff-only && pnpm install --frozen-lockfile && pnpm build",
      ];
    default:
      return [
        "git fetch --tags && git pull --ff-only && pnpm install --frozen-lockfile && pnpm build",
        "docker compose pull meru-mind && docker compose up -d meru-mind",
      ];
  }
}

async function readResponseTextBounded(
  res: Response,
  maxBytes: number,
): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`Response exceeded ${maxBytes} byte limit`);
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Response exceeded ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function fetchJsonWithLimits(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes = MAX_HTTP_RESPONSE_BYTES,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        // ignore cancel error
      }
      return { ok: false, status: res.status, data: null };
    }
    const text = await readResponseTextBounded(res, maxBytes);
    const data: unknown = JSON.parse(text);
    return { ok: true, status: res.status, data };
  } finally {
    // Timer remains active across BOTH headers and body read
    clearTimeout(timer);
  }
}

export interface CheckForUpgradeOptions {
  currentVersion?: string;
  remoteUrl?: string | null;
  releasesApiUrl?: string;
  fetchImpl?: typeof fetch;
  installInfo?: InstallInfo;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export async function checkForUpgrade(
  options: CheckForUpgradeOptions = {},
): Promise<UpgradeCheckResult> {
  const env = options.env ?? process.env;
  const currentVersion = (options.currentVersion ?? MERU_MIND_VERSION).trim();
  const install = options.installInfo ?? detectInstallMode({ env });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const releasesApiUrl =
    options.releasesApiUrl?.trim() ||
    env.MERU_MIND_RELEASES_API_URL?.trim() ||
    DEFAULT_RELEASES_API_URL;

  let latestTag: string | null = null;
  let latestVersion: string | null = null;
  let releaseUrl: string | null = null;
  let publishedAt: string | null = null;
  let updateAvailable: boolean | null = null;
  let checkError: string | undefined;

  try {
    const res = await fetchJsonWithLimits(
      fetchImpl,
      releasesApiUrl,
      {
        method: "GET",
        headers: {
          "User-Agent": `meru-mind-cli/${currentVersion}`,
          Accept: "application/vnd.github+json",
        },
      },
      timeoutMs,
    );
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        checkError = `GitHub Releases API rate limit exceeded (HTTP ${res.status}). Retry later or check releases manually.`;
      } else {
        checkError = `GitHub Releases API returned HTTP ${res.status}.`;
      }
    } else if (res.data && typeof res.data === "object" && !Array.isArray(res.data)) {
      const data = res.data as {
        tag_name?: unknown;
        html_url?: unknown;
        published_at?: unknown;
      };
      const rawTag =
        typeof data.tag_name === "string" ? data.tag_name.trim() : "";
      if (!rawTag) {
        checkError = "GitHub Releases API response did not include tag_name.";
      } else if (
        !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(rawTag) ||
        !parseSemver(rawTag)
      ) {
        checkError = "GitHub Releases API returned an invalid semver tag_name.";
      } else {
        latestTag = rawTag;
        latestVersion = rawTag.replace(/^v/i, "");
        releaseUrl = sanitizeReleaseUrl(data.html_url);
        const rawPublished =
          typeof data.published_at === "string" ? data.published_at.trim() : "";
        publishedAt =
          rawPublished && Number.isFinite(Date.parse(rawPublished))
            ? rawPublished
            : null;
        updateAvailable = compareSemver(currentVersion, latestVersion) < 0;
      }
    } else {
      checkError = "GitHub Releases API returned a non-object JSON payload.";
    }
  } catch (err) {
    const msg = sanitizeInlineText(
      err instanceof Error ? err.message : String(err),
    );
    checkError = `Unable to reach release feed (${msg}).`;
  }

  let remoteServer: RemoteServerVersionInfo | undefined;
  const cleanRemoteUrl = options.remoteUrl?.trim().replace(/\/+$/, "");
  if (cleanRemoteUrl) {
    const safeUrlDisplay = sanitizeInlineText(cleanRemoteUrl, 200);
    try {
      const healthRes = await fetchJsonWithLimits(
        fetchImpl,
        `${cleanRemoteUrl}/v1/health`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
        },
        timeoutMs,
      );
      if (!healthRes.ok) {
        remoteServer = {
          url: safeUrlDisplay,
          version: null,
          updateAvailable: null,
          error: `Health endpoint returned HTTP ${healthRes.status}.`,
        };
      } else if (
        healthRes.data &&
        typeof healthRes.data === "object" &&
        !Array.isArray(healthRes.data)
      ) {
        const health = healthRes.data as { version?: unknown };
        const rawVer =
          typeof health.version === "string"
            ? health.version.trim().replace(/^v/i, "")
            : "";
        const srvVer =
          rawVer &&
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(rawVer) &&
          parseSemver(rawVer)
            ? rawVer
            : null;
        remoteServer = {
          url: safeUrlDisplay,
          version: srvVer,
          updateAvailable:
            srvVer && latestVersion
              ? compareSemver(srvVer, latestVersion) < 0
              : null,
          ...(rawVer && !srvVer
            ? { error: "Remote server returned an invalid semver version." }
            : {}),
        };
      } else {
        remoteServer = {
          url: safeUrlDisplay,
          version: null,
          updateAvailable: null,
          error: "Health endpoint returned a non-object JSON payload.",
        };
      }
    } catch (err) {
      const msg = sanitizeInlineText(
        err instanceof Error ? err.message : String(err),
      );
      remoteServer = {
        url: safeUrlDisplay,
        version: null,
        updateAvailable: null,
        error: `Unable to reach remote server health endpoint (${msg}).`,
      };
    }
  }

  return {
    currentVersion,
    latestVersion,
    latestTag,
    releaseUrl,
    publishedAt,
    updateAvailable,
    install,
    recommendedCommands: recommendedCommandsForMode(install.mode),
    ...(remoteServer ? { remoteServer } : {}),
    ...(checkError ? { checkError } : {}),
  };
}

export interface RunUpgradeOptions extends CheckForUpgradeOptions {
  checkOnly?: boolean;
  execFileImpl?: ExecFileFn;
  readFile?: (p: string) => string;
}

export async function runUpgrade(
  options: RunUpgradeOptions = {},
): Promise<UpgradeRunResult> {
  const checkOnly = Boolean(options.checkOnly);
  const execFileImpl = options.execFileImpl ?? defaultExecFile;
  const readFile =
    options.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));

  const check = await checkForUpgrade(options);
  const previousVersion = check.currentVersion;
  const mode = check.install.mode;
  const inContainer = mode === "container";

  if (checkOnly) {
    const upToDate = check.updateAvailable === false;
    const message = check.checkError
      ? `Upgrade check failed: ${check.checkError}`
      : upToDate
        ? `Already up to date (v${previousVersion}).`
        : `Update available: v${previousVersion} -> v${check.latestVersion} (${mode}).`;
    return {
      upgraded: false,
      checkOnly: true,
      upToDate,
      inContainer,
      mode,
      previousVersion,
      newVersion: null,
      latestVersion: check.latestVersion,
      latestTag: check.latestTag,
      releaseUrl: check.releaseUrl,
      instructions: check.recommendedCommands,
      commandsRun: [],
      message,
      ...(check.remoteServer ? { remoteServer: check.remoteServer } : {}),
      ...(check.checkError ? { checkError: check.checkError } : {}),
    };
  }

  // Container guard runs BEFORE any mutation — NEVER self-upgrade inside a container
  if (inContainer) {
    return {
      upgraded: false,
      checkOnly: false,
      upToDate: check.updateAvailable === false,
      inContainer: true,
      mode: "container",
      previousVersion,
      newVersion: null,
      latestVersion: check.latestVersion,
      latestTag: check.latestTag,
      releaseUrl: check.releaseUrl,
      instructions: [
        "meru-mind admin backup",
        "docker compose pull meru-mind && docker compose up -d meru-mind",
      ],
      commandsRun: [],
      message:
        "Running inside a container: refusing in-place self-upgrade. Run `docker compose pull` on the host instead.",
      ...(check.remoteServer ? { remoteServer: check.remoteServer } : {}),
      ...(check.checkError ? { checkError: check.checkError } : {}),
    };
  }

  if (check.checkError && !check.latestVersion) {
    return {
      upgraded: false,
      checkOnly: false,
      upToDate: false,
      inContainer: false,
      mode,
      previousVersion,
      newVersion: null,
      latestVersion: null,
      latestTag: null,
      releaseUrl: null,
      instructions: check.recommendedCommands,
      commandsRun: [],
      message: `Unable to check latest release: ${check.checkError}`,
      ...(check.remoteServer ? { remoteServer: check.remoteServer } : {}),
      checkError: check.checkError,
    };
  }

  if (
    check.latestVersion &&
    compareSemver(previousVersion, check.latestVersion) >= 0
  ) {
    return {
      upgraded: false,
      checkOnly: false,
      upToDate: true,
      inContainer: false,
      mode,
      previousVersion,
      newVersion: previousVersion,
      latestVersion: check.latestVersion,
      latestTag: check.latestTag,
      releaseUrl: check.releaseUrl,
      instructions: [],
      commandsRun: [],
      message: `Already up to date (v${previousVersion}).`,
      ...(check.remoteServer ? { remoteServer: check.remoteServer } : {}),
    };
  }

  if (mode === "git") {
    const rootDir = check.install.rootDir;
    if (!rootDir) {
      throw new MindError(
        "INVALID_INPUT",
        "Detected git install mode without a valid package root directory.",
      );
    }
    const statusRes = await execFileImpl("git", ["status", "--porcelain"], {
      cwd: rootDir,
    });
    if (statusRes.stdout.trim().length > 0) {
      throw new MindError(
        "CONFLICT",
        "Refusing to upgrade dirty git checkout; commit or stash changes first.",
      );
    }
    const commandsRun: string[] = [];
    const steps: Array<[string, string[]]> = [
      ["git", ["fetch", "--tags"]],
      ["git", ["pull", "--ff-only"]],
      ["pnpm", ["install", "--frozen-lockfile"]],
      ["pnpm", ["build"]],
    ];
    for (const [bin, args] of steps) {
      await execFileImpl(bin, args, { cwd: rootDir });
      commandsRun.push(`${bin} ${args.join(" ")}`);
    }
    let newVersion: string | null = null;
    try {
      const pkg = JSON.parse(
        readFile(path.join(rootDir, "package.json")),
      ) as { version?: unknown };
      if (
        typeof pkg.version === "string" &&
        parseSemver(pkg.version.trim())
      ) {
        newVersion = pkg.version.trim().replace(/^v/i, "");
      }
    } catch {
      newVersion = null;
    }
    return {
      upgraded: true,
      checkOnly: false,
      upToDate: false,
      inContainer: false,
      mode: "git",
      previousVersion,
      newVersion,
      latestVersion: check.latestVersion,
      latestTag: check.latestTag,
      releaseUrl: check.releaseUrl,
      instructions: [],
      commandsRun,
      message: newVersion
        ? `Upgraded git checkout from v${previousVersion} to v${newVersion}.`
        : `Completed git pull and rebuild from v${previousVersion} (could not read updated package.json version).`,
      ...(check.remoteServer ? { remoteServer: check.remoteServer } : {}),
    };
  }

  return {
    upgraded: false,
    checkOnly: false,
    upToDate: false,
    inContainer: false,
    mode: "unknown",
    previousVersion,
    newVersion: null,
    latestVersion: check.latestVersion,
    latestTag: check.latestTag,
    releaseUrl: check.releaseUrl,
    instructions: recommendedCommandsForMode("unknown"),
    commandsRun: [],
    message:
      "Automatic self-upgrade is only supported for local git checkouts; update from git or pull the official GHCR Docker image instead.",
    ...(check.remoteServer ? { remoteServer: check.remoteServer } : {}),
  };
}

export function formatUpgradeMarkdown(res: UpgradeRunResult): string {
  const lines: string[] = [];
  lines.push(`# Meru Mind Upgrade`);
  lines.push(
    `- CLI version: v${res.previousVersion}${res.upgraded && res.newVersion ? ` -> v${res.newVersion}` : ""}`,
  );
  lines.push(
    `- Latest release: ${res.latestVersion ? `v${res.latestVersion}` : "unavailable"}${res.releaseUrl ? ` (${res.releaseUrl})` : ""}`,
  );
  lines.push(`- Install mode: ${res.mode}`);
  if (res.remoteServer) {
    const srvStatus = res.remoteServer.error
      ? `error (${res.remoteServer.error})`
      : `v${res.remoteServer.version ?? "unknown"}${res.remoteServer.updateAvailable === true ? " (update available)" : res.remoteServer.updateAvailable === false ? " (up to date)" : ""}`;
    lines.push(`- Remote server (${res.remoteServer.url}): ${srvStatus}`);
  }
  lines.push(`- Status: ${res.message}`);
  if (res.commandsRun.length > 0) {
    lines.push("");
    lines.push("Commands executed:");
    for (const c of res.commandsRun) {
      lines.push(`  $ ${c}`);
    }
  }
  if (res.instructions.length > 0) {
    lines.push("");
    lines.push("Recommended commands:");
    for (const cmd of res.instructions) {
      lines.push(`  $ ${cmd}`);
    }
  }
  return lines.join("\n");
}
