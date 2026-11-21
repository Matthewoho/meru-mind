import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { restoreWritablePermissions } from "../src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliBin = path.join(repoRoot, "dist", "cli.js");
const mcpBin = path.join(repoRoot, "dist", "mcp.js");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    restoreWritablePermissions(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(
  homeDir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): unknown {
  const out = execFileSync(
    process.execPath,
    [cliBin, "--home", homeDir, "--json", ...args],
    { encoding: "utf8", env: { ...process.env, ...extraEnv } },
  );
  return JSON.parse(out.trim()) as unknown;
}

function runCliExpectFail(
  homeDir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [cliBin, "--home", homeDir, "--json", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    throw new Error("Expected CLI command to fail");
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string | Buffer };
    return {
      status: e.status ?? 1,
      stderr: String(e.stderr ?? ""),
    };
  }
}

describe("Real CLI binary and MCP stdio server E2E", () => {
  it("runs full CLI lifecycle with default agent actor and explicit --as-human elevation", () => {
    const homeDir = makeTempDir("meru-mind-cli-");

    const init = runCli(homeDir, ["init", "--org", "Acme"]) as {
      org: { id: string; policy: string };
      rootRealm: { id: string };
    };
    expect(init.org.id).toMatch(/^org_/);
    expect(init.org.policy).toBe("open");

    const eng = runCli(homeDir, [
      "realm",
      "create",
      "--org",
      init.org.id,
      "--parent",
      init.rootRealm.id,
      "--slug",
      "eng",
      "--name",
      "Engineering",
    ]) as { id: string; path: string };
    expect(eng.path).toBe("/eng");

    // Default CLI actor is "agent": writing a rule without --as-human MUST fail
    const deniedRule = runCliExpectFail(homeDir, [
      "record",
      init.rootRealm.id,
      "--kind",
      "rule",
      "--title",
      "All merges require passing CI",
    ]);
    expect(deniedRule.stderr).toContain("RULE_REQUIRES_HUMAN");

    // Explicit --as-human succeeds for rule
    const rule = runCli(homeDir, [
      "--as-human",
      "record",
      init.rootRealm.id,
      "--kind",
      "rule",
      "--title",
      "All merges require passing CI",
    ]) as { id: string; confirmedByHuman: boolean };
    expect(rule.id).toMatch(/^rec_/);
    expect(rule.confirmedByHuman).toBe(true);

    const dec1 = runCli(homeDir, [
      "record",
      eng.id,
      "--kind",
      "decision",
      "--title",
      "Use Node 22 built-in sqlite",
    ]) as { id: string; confirmedByHuman: boolean };
    expect(dec1.confirmedByHuman).toBe(false);

    runCli(homeDir, [
      "capture",
      eng.id,
      "--kind",
      "message",
      "--text",
      "Benchmarked FTS5 and sqlite-vec latency",
    ]);

    runCli(homeDir, [
      "drive",
      "write",
      eng.id,
      "--path",
      "STATE.md",
      "--content",
      "# Engineering Status",
    ]);

    const brief = runCli(homeDir, ["brief", eng.id]) as {
      upperLedger: { activeDecisions: { items: Array<{ id: string }> } };
      middleMind: { rules: { items: Array<{ id: string; inherited: boolean }> } };
    };
    expect(brief.upperLedger.activeDecisions.items[0]?.id).toBe(dec1.id);
    expect(
      brief.middleMind.rules.items.some((r) => r.id === rule.id && r.inherited),
    ).toBe(true);

    const recall = runCli(homeDir, [
      "recall",
      "sqlite-vec",
      "--focus",
      eng.id,
    ]) as { items: Array<{ sourceType: string }> };
    expect(recall.items.length).toBeGreaterThan(0);

    // sync-embeddings CLI subcommand works cleanly (no embedder configured -> 0 processed)
    const syncRes = runCli(homeDir, ["sync-embeddings"]) as {
      processed: number;
      remaining: number;
    };
    expect(syncRes.processed).toBe(0);

    // org set-policy CLI requires --as-human
    const deniedPolicy = runCliExpectFail(homeDir, [
      "org",
      "set-policy",
      "--org",
      init.org.id,
      "--policy",
      "tree",
    ]);
    expect(deniedPolicy.stderr).toContain("ACCESS_DENIED");
    const updatedOrg = runCli(homeDir, [
      "--as-human",
      "org",
      "set-policy",
      "--org",
      init.org.id,
      "--policy",
      "tree",
    ]) as { policy: string };
    expect(updatedOrg.policy).toBe("tree");

    // redact CLI requires --as-human (permitted in tree org without MERU_MIND_VIEWER_REALM_ID)
    const deniedRedact = runCliExpectFail(homeDir, ["redact", "--id", dec1.id]);
    expect(deniedRedact.stderr).toContain("ACCESS_DENIED");
    const redacted = runCli(homeDir, [
      "--as-human",
      "redact",
      "--id",
      dec1.id,
      "--reason",
      "cleanup test",
    ]) as { entryId: string; walCheckpoint: { busy: number } };
    expect(redacted.entryId).toBe(dec1.id);
    expect(typeof redacted.walCheckpoint.busy).toBe("number");

    const sliceDir = makeTempDir("meru-mind-cli-slice-");
    const exported = runCli(
      homeDir,
      ["export-slice", eng.id, "--out", sliceDir],
      { MERU_MIND_VIEWER_REALM_ID: eng.id },
    ) as { fileCount: number };
    expect(exported.fileCount).toBeGreaterThan(0);

    const rebuilt = runCli(homeDir, ["rebuild"]) as {
      ftsIndexed: number;
      driveFilesRestored: number;
    };
    expect(rebuilt.ftsIndexed).toBeGreaterThanOrEqual(2);
    expect(rebuilt.driveFilesRestored).toBe(1);
  });

  it("serves process-bound MCP stdio tools without human/high-risk tools and enforces tree visibility", async () => {
    const homeDir = makeTempDir("meru-mind-mcp-");

    // Provision a 'tree' org + two sibling realms via CLI (--as-human)
    const init = runCli(homeDir, [
      "init",
      "--org",
      "SecureOrg",
      "--policy",
      "tree",
    ]) as { org: { id: string }; rootRealm: { id: string } };
    const alpha = runCli(homeDir, [
      "--as-human",
      "realm",
      "create",
      "--org",
      init.org.id,
      "--parent",
      init.rootRealm.id,
      "--slug",
      "alpha",
      "--name",
      "Alpha",
    ]) as { id: string };
    const beta = runCli(homeDir, [
      "--as-human",
      "realm",
      "create",
      "--org",
      init.org.id,
      "--parent",
      init.rootRealm.id,
      "--slug",
      "beta",
      "--name",
      "Beta",
    ]) as { id: string };

    // Plant a secret canary in alpha via CLI (tree org requires MERU_MIND_VIEWER_REALM_ID)
    runCli(
      homeDir,
      [
        "capture",
        alpha.id,
        "--kind",
        "message",
        "--text",
        "Alpha launch code MCP_ALPHA_409",
      ],
      { MERU_MIND_VIEWER_REALM_ID: alpha.id },
    );

    // Boot MCP server bound to beta in SecureOrg
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpBin],
      env: {
        ...process.env,
        MERU_MIND_HOME: homeDir,
        MERU_MIND_ORG_ID: init.org.id,
        MERU_MIND_VIEWER_REALM_ID: beta.id,
        MERU_MIND_ACTOR_ID: "beta-bot",
        MERU_MIND_ACTOR_FAMILY: "gemini",
      },
    });
    const client = new Client({
      name: "meru-mind-test-client",
      version: "0.2.0",
    });
    await client.connect(transport);

    try {
      const toolsRes = await client.listTools();
      const toolNames = toolsRes.tools.map((t) => t.name);
      expect(toolNames).toContain("mind_brief");
      expect(toolNames).toContain("mind_recall");
      expect(toolNames).toContain("mind_append_record");
      // High-risk and human-only tools MUST NOT exist in MCP
      expect(toolNames).not.toContain("mind_rebuild");
      expect(toolNames).not.toContain("mind_export_slice");
      expect(toolNames).not.toContain("mind_create_realm");
      expect(toolNames).not.toContain("mind_mount_realm");
      expect(toolNames).not.toContain("mind_unmount_realm");
      expect(toolNames).not.toContain("mind_redact");
      expect(toolNames).not.toContain("mind_set_org_policy");

      // Zero MCP tools expose actorKind in their input schema
      for (const tool of toolsRes.tools) {
        const props = (tool.inputSchema?.properties ?? {}) as Record<
          string,
          unknown
        >;
        expect(props).not.toHaveProperty("actorKind");
      }

      const parseText = (res: Awaited<ReturnType<typeof client.callTool>>) => {
        const content = res.content as Array<{ type: string; text?: string }>;
        return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
      };

      // mind_list_realms only returns bound org's visible realms (root + beta; NEVER alpha)
      const listed = parseText(
        await client.callTool({ name: "mind_list_realms", arguments: {} }),
      ) as { realms: Array<{ id: string }> };
      const listedIds = listed.realms.map((r) => r.id);
      expect(listedIds).toContain(beta.id);
      expect(listedIds).not.toContain(alpha.id);

      // Attempting to switch focus to sibling alpha MUST be rejected
      const switchAttempt = await client.callTool({
        name: "mind_recall",
        arguments: {
          focus: alpha.id,
          query: "MCP_ALPHA_409",
        },
      });
      expect(switchAttempt.isError).toBe(true);
      expect(parseText(switchAttempt).error).toBe("ACCESS_DENIED");

      // Normal recall from bound beta returns 0 hits for alpha's canary
      const leakCheck = parseText(
        await client.callTool({
          name: "mind_recall",
          arguments: { query: "MCP_ALPHA_409" },
        }),
      ) as { items: unknown[] };
      expect(leakCheck.items).toHaveLength(0);

      // Writing to bound beta succeeds and is recorded as agent (confirmedByHuman = false)
      const written = parseText(
        await client.callTool({
          name: "mind_append_record",
          arguments: {
            kind: "decision",
            title: "Beta decision MCP_BETA_202",
          },
        }),
      ) as { id: string; authorKind: string; confirmedByHuman: boolean };
      expect(written.id).toMatch(/^rec_/);
      expect(written.authorKind).toBe("agent");
      expect(written.confirmedByHuman).toBe(false);

      const selfCheck = parseText(
        await client.callTool({
          name: "mind_recall",
          arguments: { query: "MCP_BETA_202" },
        }),
      ) as { items: Array<{ id: string }> };
      expect(selfCheck.items.some((i) => i.id === written.id)).toBe(true);
    } finally {
      await client.close();
    }
  });
});
