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

function runCli(homeDir: string, args: string[]): unknown {
  const out = execFileSync(
    process.execPath,
    [cliBin, "--home", homeDir, "--json", ...args],
    { encoding: "utf8" },
  );
  return JSON.parse(out.trim()) as unknown;
}

describe("Real CLI binary and MCP stdio server E2E", () => {
  it("runs full CLI lifecycle against real SQLite + blobs on disk", () => {
    const homeDir = makeTempDir("meru-mind-cli-");

    const init = runCli(homeDir, ["init", "--org", "Acme"]) as {
      org: { id: string };
      rootRealm: { id: string };
    };
    expect(init.org.id).toMatch(/^org_/);

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

    const rule = runCli(homeDir, [
      "record",
      "--realm",
      init.rootRealm.id,
      "--kind",
      "rule",
      "--title",
      "All merges require passing CI",
    ]) as { id: string };
    expect(rule.id).toMatch(/^rec_/);

    const dec1 = runCli(homeDir, [
      "record",
      "--realm",
      eng.id,
      "--kind",
      "decision",
      "--title",
      "Use Node 22 built-in sqlite",
    ]) as { id: string };

    runCli(homeDir, [
      "capture",
      "--realm",
      eng.id,
      "--kind",
      "message",
      "--text",
      "Benchmarked FTS5 and sqlite-vec latency",
    ]);

    runCli(homeDir, [
      "drive",
      "write",
      "--realm",
      eng.id,
      "--path",
      "STATE.md",
      "--content",
      "# Engineering Status",
    ]);

    const brief = runCli(homeDir, ["brief", "--realm", eng.id]) as {
      upperLedger: { activeDecisions: { items: Array<{ id: string }> } };
      middleMind: { rules: { items: Array<{ id: string; inherited: boolean }> } };
    };
    expect(brief.upperLedger.activeDecisions.items[0]?.id).toBe(dec1.id);
    expect(brief.middleMind.rules.items.some((r) => r.id === rule.id && r.inherited)).toBe(true);

    const recall = runCli(homeDir, [
      "recall",
      "--realm",
      eng.id,
      "--query",
      "sqlite-vec",
    ]) as { items: Array<{ sourceType: string }> };
    expect(recall.items.length).toBeGreaterThan(0);

    const sliceDir = makeTempDir("meru-mind-cli-slice-");
    const exported = runCli(homeDir, [
      "export-slice",
      "--realm",
      eng.id,
      "--out",
      sliceDir,
    ]) as { fileCount: number };
    expect(exported.fileCount).toBeGreaterThan(0);

    const rebuilt = runCli(homeDir, ["rebuild"]) as {
      ftsIndexed: number;
      driveFilesRestored: number;
    };
    expect(rebuilt.ftsIndexed).toBeGreaterThanOrEqual(3);
    expect(rebuilt.driveFilesRestored).toBe(1);
  });

  it("serves real MCP stdio tools and enforces rule/visibility invariants over MCP", async () => {
    const homeDir = makeTempDir("meru-mind-mcp-");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpBin],
      env: {
        ...process.env,
        MERU_MIND_HOME: homeDir,
      },
    });
    const client = new Client({ name: "meru-mind-test-client", version: "0.1.0" });
    await client.connect(transport);

    try {
      const toolsRes = await client.listTools();
      const toolNames = toolsRes.tools.map((t) => t.name);
      expect(toolNames).toContain("mind_brief");
      expect(toolNames).toContain("mind_recall");
      expect(toolNames).toContain("mind_append_record");
      expect(toolNames).toContain("mind_rebuild");

      const parseText = (res: Awaited<ReturnType<typeof client.callTool>>) => {
        const content = res.content as Array<{ type: string; text?: string }>;
        return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
      };

      const listed = parseText(
        await client.callTool({ name: "mind_list_realms", arguments: {} }),
      ) as {
        orgs: Array<{ id: string }>;
        realms: Array<{ id: string }>;
      };
      const orgId = listed.orgs[0]!.id;
      const rootId = listed.realms[0]!.id;

      // Agent attempting to write a rule over MCP must fail with RULE_REQUIRES_HUMAN
      const forbiddenRule = await client.callTool({
        name: "mind_append_record",
        arguments: {
          viewerRealmId: rootId,
          kind: "rule",
          title: "Unauthorized agent rule",
          actorKind: "agent",
          actorId: "bot-1",
        },
      });
      expect(forbiddenRule.isError).toBe(true);
      expect(parseText(forbiddenRule).error).toBe("RULE_REQUIRES_HUMAN");

      // Create two sibling realms and verify MCP recall isolates them
      const alpha = parseText(
        await client.callTool({
          name: "mind_create_realm",
          arguments: { orgId, parentId: rootId, slug: "alpha", name: "Alpha" },
        }),
      ) as { id: string };
      const beta = parseText(
        await client.callTool({
          name: "mind_create_realm",
          arguments: { orgId, parentId: rootId, slug: "beta", name: "Beta" },
        }),
      ) as { id: string };

      await client.callTool({
        name: "mind_capture_seabed",
        arguments: {
          viewerRealmId: alpha.id,
          kind: "message",
          text: "Alpha secret launch code MCP_ALPHA_409",
        },
      });

      const leakCheck = parseText(
        await client.callTool({
          name: "mind_recall",
          arguments: {
            viewerRealmId: beta.id,
            query: "MCP_ALPHA_409",
          },
        }),
      ) as { items: unknown[] };
      expect(leakCheck.items).toHaveLength(0);

      const selfCheck = parseText(
        await client.callTool({
          name: "mind_recall",
          arguments: {
            viewerRealmId: alpha.id,
            query: "MCP_ALPHA_409",
          },
        }),
      ) as { items: unknown[] };
      expect(selfCheck.items).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
