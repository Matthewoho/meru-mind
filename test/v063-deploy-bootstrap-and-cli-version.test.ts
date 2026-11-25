import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  MERU_MIND_VERSION,
  startMindServer,
  type MindServerHandle,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const openServers: MindServerHandle[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v0.6.3 Verified Docker Bootstrap, Public URL Wiring, CLI --version & Zero-Org Guidance", () => {
  it("1. CLI supports --version, -v, and --version --json without opening SQLite", async () => {
    const emptyHome = makeTempDir("meru-v063-ver-");
    const cli = path.resolve("dist/cli.js");

    const { stdout: outLong } = await execFileAsync(process.execPath, [
      cli,
      "--version",
    ], { env: { ...process.env, MERU_MIND_HOME: emptyHome } });
    expect(outLong.trim()).toBe(MERU_MIND_VERSION);

    const { stdout: outShort } = await execFileAsync(process.execPath, [
      cli,
      "-v",
    ], { env: { ...process.env, MERU_MIND_HOME: emptyHome } });
    expect(outShort.trim()).toBe(MERU_MIND_VERSION);

    const { stdout: outJson } = await execFileAsync(process.execPath, [
      cli,
      "--version",
      "--json",
    ], { env: { ...process.env, MERU_MIND_HOME: emptyHome } });
    expect(JSON.parse(outJson)).toEqual({ version: MERU_MIND_VERSION });

    // Must not create a database when merely printing version
    expect(fs.existsSync(path.join(emptyHome, "mind.sqlite"))).toBe(false);
  });

  it("2. Empty store token create emits clear zero-org guidance (never misleading 'multiple organizations exist')", async () => {
    const emptyHome = makeTempDir("meru-v063-empty-org-");
    const cli = path.resolve("dist/cli.js");

    let stderr = "";
    let exitCode = 0;
    try {
      await execFileAsync(
        process.execPath,
        [cli, "token", "create", "--actor-id", "admin", "--kind", "human", "--role", "admin", "--as-human", "--json"],
        { env: { ...process.env, MERU_MIND_HOME: emptyHome } },
      );
    } catch (err) {
      const e = err as { code?: number; stderr?: string };
      exitCode = e.code ?? 1;
      stderr = String(e.stderr ?? "");
    }
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stderr) as { error: string; message: string; try?: string };
    expect(parsed.error).toBe("not_bound");
    expect(parsed.message).toMatch(/No organization found/i);
    expect(parsed.message).not.toMatch(/multiple organizations exist/i);
    expect(parsed.try).toContain("admin init");
  });

  it("3. Public deployment docs & base docker-compose.yml match Dockerfile ENTRYPOINT and set MERU_MIND_PUBLIC_URL", () => {
    const deployDoc = fs.readFileSync(
      path.resolve("docs/deployment-and-frontend.md"),
      "utf8",
    );
    // Must NEVER duplicate `node /app/dist/cli.js` after `docker compose ... run --rm meru-mind`
    expect(deployDoc).not.toMatch(/run\s+--rm\s+meru-mind[\s\\\n]+node\s+\/app\/dist\/cli\.js/);
    expect(deployDoc).toContain("admin init --org");
    expect(deployDoc).toContain("--role admin --as-human");

    const baseCompose = fs.readFileSync(
      path.resolve("deploy/docker-compose.yml"),
      "utf8",
    );
    expect(baseCompose).toContain("MERU_MIND_PUBLIC_URL: https://${MERU_DOMAIN:-localhost}");
    expect(baseCompose).toContain(`ghcr.io/matthewoho/meru-mind:\${MERU_MIND_TAG:-v${MERU_MIND_VERSION}}`);

    const readmeEn = fs.readFileSync(path.resolve("README.md"), "utf8");
    const readmeZh = fs.readFileSync(path.resolve("README.zh-CN.md"), "utf8");
    for (const [name, content] of [["README.md", readmeEn], ["README.zh-CN.md", readmeZh]]) {
      expect(content, `${name} must include verified admin init + --role admin Docker quickstart`).toContain(
        'docker compose -f deploy/docker-compose.yml run --rm meru-mind admin init --org "MyTeam" --policy open',
      );
      expect(content, `${name} must include --role admin token create`).toContain(
        "docker compose -f deploy/docker-compose.yml run --rm meru-mind token create --actor-id admin --kind human --role admin --as-human",
      );
      expect(content, `${name} must reflect current version`).toContain(`v${MERU_MIND_VERSION}`);
    }
  });

  it("4. Non-OIDC POST /v1/invites honors MERU_MIND_PUBLIC_URL instead of falling back to bind host", async () => {
    const prevPublicUrl = process.env.MERU_MIND_PUBLIC_URL;
    process.env.MERU_MIND_PUBLIC_URL = "https://mind.example.com/";
    try {
      const srv = await startMindServer({
        homeDir: makeTempDir("meru-v063-public-url-"),
        host: "127.0.0.1",
        port: 0,
        oidc: false,
        enableVector: false,
        accessLog: false,
      });
      openServers.push(srv);
      const adminTok = srv.createToken({
        actorId: "admin",
        actorKind: "human",
        actorRole: "admin",
      });
      const resp = await fetch(`${srv.url}/v1/invites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminTok.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actorId: "alice",
          actorKind: "human",
          role: "member",
        }),
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { inviteUrl: string };
      expect(body.inviteUrl).toMatch(
        /^https:\/\/mind\.example\.com\/_meru\/oidc\/login\?invite=mm_inv_/,
      );
    } finally {
      if (prevPublicUrl === undefined) delete process.env.MERU_MIND_PUBLIC_URL;
      else process.env.MERU_MIND_PUBLIC_URL = prevPublicUrl;
    }
  });
});
