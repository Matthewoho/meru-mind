import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeVisibleScope,
  createMindEngine,
  parseSearchQuery,
  resolveAccess,
  resolveAccessScope,
  restoreWritablePermissions,
  type Actor,
  type EmbedderPort,
  type MindEngine,
} from "../src/index.js";
import { createMindMcpServer } from "../src/mcp.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliBin = path.join(repoRoot, "dist", "cli.js");
const mcpBin = path.join(repoRoot, "dist", "mcp.js");
const checkOssScript = path.join(repoRoot, "scripts", "check-oss.mjs");

const tempDirs: string[] = [];
const engines: MindEngine[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (engines.length > 0) {
    await engines.pop()!.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    restoreWritablePermissions(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const humanAlice: Actor = { id: "alice", kind: "human" };
const agentWorker: Actor = { id: "worker-1", kind: "agent", family: "gemini" };

function runCli(
  homeDir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): unknown {
  const out = execFileSync(
    process.execPath,
    [cliBin, "--home", homeDir, "--json", ...args],
    { encoding: "utf8", env: extraEnv ? { ...process.env, ...extraEnv } : process.env },
  );
  return JSON.parse(out.trim()) as unknown;
}

function runCliFail(
  homeDir: string,
  args: string[],
  extraEnv?: Record<string, string>,
): { status: number; stderr: string } {
  try {
    execFileSync(
      process.execPath,
      [cliBin, "--home", homeDir, "--json", ...args],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      },
    );
    throw new Error("Expected CLI command to fail");
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string | Buffer };
    return { status: e.status ?? 1, stderr: String(e.stderr ?? "") };
  }
}

function collectFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesRecursive(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

class Deterministic4DimEmbedder implements EmbedderPort {
  readonly dimensions = 4;
  readonly configured = true;

  async embed(text: string): Promise<Float32Array | null> {
    const lower = text.toLowerCase();
    return new Float32Array([
      lower.includes("secret") || lower.includes("redact") ? 1 : 0.1,
      lower.includes("gateway") || lower.includes("支付网关") ? 1 : 0.1,
      lower.includes("confidential") ? 1 : 0.1,
      0.5,
    ]);
  }

  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

describe("Access policy (open|tree), process-bound MCP/CLI, field filtering, sensitivity, FTS5 boundaries & full-chain redact", () => {
  it("1. MCP process-level binding: rejects missing viewer in tree mode, strips actorKind, blocks child @mount & seabed escalation, and isolates cross-org in open mode", async () => {
    const homeDir = makeTempDir("meru-mind-1b-mcp-");
    const setupEngine = await createMindEngine({ homeDir });

    // Tree org: A -> B1 -> C1, A -> B2 -> C2; C2 mounts C1 ("all")
    const { org: treeOrg, rootRealm: A } = setupEngine.ledger.createOrg({
      name: "TreeCorp",
      policy: "tree",
    });
    const B1 = setupEngine.ledger.createRealm({
      actor: humanAlice,
      orgId: treeOrg.id,
      parentId: A.id,
      slug: "b1",
      name: "B1",
    });
    const C1 = setupEngine.ledger.createRealm({
      actor: humanAlice,
      orgId: treeOrg.id,
      parentId: B1.id,
      slug: "c1",
      name: "C1",
    });
    const B2 = setupEngine.ledger.createRealm({
      actor: humanAlice,
      orgId: treeOrg.id,
      parentId: A.id,
      slug: "b2",
      name: "B2",
    });
    const C2 = setupEngine.ledger.createRealm({
      actor: humanAlice,
      orgId: treeOrg.id,
      parentId: B2.id,
      slug: "c2",
      name: "C2",
    });

    // Human mounts C1 onto C2 (B2 does NOT mount C1!)
    setupEngine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: C2.id,
      targetRealmId: C1.id,
      scope: "all",
    });

    const c1Rec = await setupEngine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: C1.id,
      kind: "decision",
      title: "Mounted sibling secret MCP_MOUNT_ESCALATION_991",
    });
    const c1Sea = await setupEngine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: C1.id,
      kind: "message",
      text: "Mounted sibling chat MCP_MOUNT_SEABED_992",
    });
    await setupEngine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: C1.id,
      relPath: "c1-secret.md",
      content: "C1 drive content MCP_MOUNT_DRIVE_993",
    });

    const c2Rec = await setupEngine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: C2.id,
      kind: "decision",
      title: "Child ledger visible to parent MCP_C2_LEDGER_101",
    });
    const c2Sea = await setupEngine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: C2.id,
      kind: "message",
      text: "Child seabed requires explicit dive MCP_C2_SEABED_102",
    });

    // Also create two open orgs to test open-mode MCP zero cross-org leakage
    const { org: openOrg1, rootRealm: o1Root } = setupEngine.ledger.createOrg({
      name: "OpenOne",
      policy: "open",
    });
    const o1Child = setupEngine.ledger.createRealm({
      actor: humanAlice,
      orgId: openOrg1.id,
      parentId: o1Root.id,
      slug: "eng",
      name: "Eng",
    });
    const { org: openOrg2, rootRealm: o2Root } = setupEngine.ledger.createOrg({
      name: "OpenTwo",
      policy: "open",
    });
    const o1Rec = await setupEngine.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: o1Child.id,
      kind: "decision",
      title: "OpenOrg1 decision OPEN_ORG1_CANARY",
    });
    const o2Rec = await setupEngine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: o2Root.id,
      kind: "decision",
      title: "OpenOrg2 decision OPEN_ORG2_CANARY",
    });
    await setupEngine.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: o2Root.id,
      relPath: "org2.md",
      content: "Org2 secret drive",
    });
    await setupEngine.close();

    // A) Starting MCP on a tree org WITHOUT MERU_MIND_VIEWER_REALM_ID MUST fail fast with NOT_BOUND
    await expect(
      createMindMcpServer({ homeDir, orgId: treeOrg.id }),
    ).rejects.toMatchObject({ code: "NOT_BOUND" });

    // B) Tree-mode MCP bound to B2 via real stdio transport
    const treeTransport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpBin],
      env: {
        ...process.env,
        MERU_MIND_HOME: homeDir,
        MERU_MIND_ORG_ID: treeOrg.id,
        MERU_MIND_VIEWER_REALM_ID: B2.id,
        MERU_MIND_ACTOR_ID: "b2-agent",
        MERU_MIND_ACTOR_FAMILY: "claude",
      },
    });
    const treeClient = new Client({ name: "t-client", version: "0.2.0" });
    await treeClient.connect(treeTransport);

    const parseText = (res: Awaited<ReturnType<typeof treeClient.callTool>>) => {
      const content = res.content as Array<{ type: string; text?: string }>;
      return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
    };

    try {
      const { tools } = await treeClient.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "mind_changes",
        "mind_ls",
        "mind_search",
        "mind_show",
        "mind_tree",
        "mind_whoami",
        "mind_write",
      ]);
      // actorKind completely absent from every tool schema, and "rule" absent from mind_write
      for (const t of tools) {
        const props = (t.inputSchema?.properties ?? {}) as Record<string, unknown>;
        expect(props).not.toHaveProperty("actorKind");
      }
      const writeTool = tools.find((t) => t.name === "mind_write")!;
      const kindSchema = (
        writeTool.inputSchema.properties as Record<string, { enum?: string[] }>
      ).kind;
      expect(kindSchema?.enum ?? []).not.toContain("rule");

      // Trying to forge actorKind:"human" or kind:"rule" fails with 4-field forbidden / stays agent
      const ruleTry = await treeClient.callTool({
        name: "mind_write",
        arguments: {
          in: "/b2",
          kind: "rule",
          title: "Forged rule",
          body: "Should be rejected",
          actorKind: "human",
        } as Record<string, unknown>,
      });
      expect(ruleTry.isError).toBe(true);
      const ruleErr = parseText(ruleTry) as { error: string; try?: string };
      expect(ruleErr.error).toBe("forbidden");
      expect(ruleErr.try).toBeTruthy();

      const forgedDecision = parseText(
        await treeClient.callTool({
          name: "mind_write",
          arguments: {
            in: "/b2",
            kind: "decision",
            title: "B2 decision with spoofed actorKind",
            body: "Still recorded as agent.",
            actorKind: "human",
          } as Record<string, unknown>,
        }),
      ) as { authorKind: string; confirmedByHuman: boolean; authorId: string };
      expect(forgedDecision.authorKind).toBe("agent");
      expect(forgedDecision.confirmedByHuman).toBe(false);
      expect(forgedDecision.authorId).toBe("b2-agent");

      // Narrowing search to child C2 MUST intersect scope(C2) ∩ scope(B2):
      // 1) C2's ledger IS visible
      const c2LedgerHit = parseText(
        await treeClient.callTool({
          name: "mind_search",
          arguments: { in: "/b2/c2", query: "MCP_C2_LEDGER_101" },
        }),
      ) as { items: Array<{ id: string }> };
      expect(c2LedgerHit.items.some((i) => i.id === c2Rec.id)).toBe(true);

      // 2) C2's @mount to C1 MUST be blocked (query + direct show + file + history + tree)
      const mountQueryLeak = parseText(
        await treeClient.callTool({
          name: "mind_search",
          arguments: { in: "/b2/c2", query: "MCP_MOUNT_ESCALATION_991" },
        }),
      ) as { items: unknown[] };
      expect(mountQueryLeak.items).toHaveLength(0);

      const mountIdLeak = await treeClient.callTool({
        name: "mind_show",
        arguments: { ref: c1Rec.id },
      });
      expect(mountIdLeak.isError).toBe(true);
      expect(parseText(mountIdLeak).error).toBe("not_found");

      const mountSeabedLeak = await treeClient.callTool({
        name: "mind_show",
        arguments: { ref: c1Sea.id, include_descendant_seabed: true },
      });
      expect(mountSeabedLeak.isError).toBe(true);
      expect(parseText(mountSeabedLeak).error).toBe("not_found");

      const mountDriveRead = await treeClient.callTool({
        name: "mind_show",
        arguments: { ref: `file:/b1/c1/c1-secret.md` },
      });
      expect(mountDriveRead.isError).toBe(true);
      expect(parseText(mountDriveRead).error).toBe("not_found");

      const mountChainRead = await treeClient.callTool({
        name: "mind_show",
        arguments: { ref: c1Rec.id, history: true },
      });
      expect(mountChainRead.isError).toBe(true);
      expect(parseText(mountChainRead).error).toBe("not_found");

      const treeFromB2 = parseText(
        await treeClient.callTool({
          name: "mind_tree",
          arguments: { ref: "/b2/c2", depth: "all" },
        }),
      ) as { realms: Array<{ id: string }> };
      expect(treeFromB2.realms.some((r) => r.id === C1.id)).toBe(false);

      // 3) C2's seabed MUST be blocked when include_descendant_seabed is false (both search & show!)
      const c2SeabedNoDive = parseText(
        await treeClient.callTool({
          name: "mind_search",
          arguments: {
            in: "/b2/c2",
            query: "MCP_C2_SEABED_102",
            include_descendant_seabed: false,
          },
        }),
      ) as { items: unknown[] };
      expect(c2SeabedNoDive.items).toHaveLength(0);

      const c2BriefNoDive = parseText(
        await treeClient.callTool({
          name: "mind_show",
          arguments: { ref: "/b2/c2" },
        }),
      ) as { brief: { surface: { recentMessages: { items: unknown[] } } } };
      expect(c2BriefNoDive.brief.surface.recentMessages.items).toHaveLength(0);

      // Explicit descendant dive allows C2's seabed (still NOT C1's!)
      const c2SeabedWithDive = parseText(
        await treeClient.callTool({
          name: "mind_search",
          arguments: {
            in: "/b2/c2",
            query: "MCP_C2_SEABED_102",
            include_descendant_seabed: true,
          },
        }),
      ) as { items: Array<{ id: string }> };
      expect(c2SeabedWithDive.items.some((i) => i.id === c2Sea.id)).toBe(true);

      // 4) Writing to child C2 from bound parent B2 in tree mode MUST be denied
      const childWrite = await treeClient.callTool({
        name: "mind_write",
        arguments: {
          in: C2.id,
          kind: "decision",
          title: "Unauthorized write into child realm",
          body: "Denied write.",
        },
      });
      expect(childWrite.isError).toBe(true);
      expect(parseText(childWrite).error).toBe("forbidden");
    } finally {
      await treeClient.close();
    }

    // C) Open-mode MCP bound to OpenOne: reads/writes across OpenOne, ZERO cross-org leakage into OpenTwo
    const openTransport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpBin],
      env: {
        ...process.env,
        MERU_MIND_HOME: homeDir,
        MERU_MIND_ORG_ID: openOrg1.id,
        MERU_MIND_ACTOR_ID: "open1-bot",
      },
    });
    const openClient = new Client({ name: "o-client", version: "0.2.0" });
    await openClient.connect(openTransport);

    try {
      const treeOpen = parseText(
        await openClient.callTool({ name: "mind_tree", arguments: {} }),
      ) as { org: { id: string }; realms: Array<{ id: string; orgId: string }> };
      expect(treeOpen.org.id).toBe(openOrg1.id);
      expect(treeOpen.realms.every((r) => r.orgId === openOrg1.id)).toBe(true);
      expect(treeOpen.realms.some((r) => r.id === o2Root.id)).toBe(false);

      // Can read OpenOne's child realm from default root focus
      const ownOrgSearch = parseText(
        await openClient.callTool({
          name: "mind_search",
          arguments: { query: "OPEN_ORG1_CANARY" },
        }),
      ) as { items: Array<{ id: string }> };
      expect(ownOrgSearch.items.some((i) => i.id === o1Rec.id)).toBe(true);

      // Cannot read OpenTwo via query, ID, realm filter, or write
      const crossQuery = parseText(
        await openClient.callTool({
          name: "mind_search",
          arguments: { query: "OPEN_ORG2_CANARY" },
        }),
      ) as { items: unknown[] };
      expect(crossQuery.items).toHaveLength(0);

      const crossId = await openClient.callTool({
        name: "mind_show",
        arguments: { ref: o2Rec.id },
      });
      expect(crossId.isError).toBe(true);
      expect(parseText(crossId).error).toBe("not_found");

      const crossViewer = await openClient.callTool({
        name: "mind_search",
        arguments: { in: o2Root.id, query: "OPEN_ORG2_CANARY" },
      });
      expect(crossViewer.isError).toBe(true);
      expect(parseText(crossViewer).error).toBe("not_found");

      const crossWrite = await openClient.callTool({
        name: "mind_write",
        arguments: {
          in: o2Root.id,
          kind: "decision",
          title: "Cross-org write attempt",
          body: "Should be forbidden.",
        },
      });
      expect(crossWrite.isError).toBe(true);
      expect(parseText(crossWrite).error).toBe("forbidden");
    } finally {
      await openClient.close();
    }
  });

  it("2. CLI defaults to agent actor, rejects --actor-kind human without --as-human, and gates rule/redact/set-policy/tree-ops behind --as-human", () => {
    const homeDir = makeTempDir("meru-mind-1b-cli-");
    const init = runCli(homeDir, [
      "admin",
      "init",
      "--org",
      "CliTreeOrg",
      "--policy",
      "tree",
    ]) as { org: { id: string }; rootRealm: { id: string } };

    const rootEnv = { MERU_MIND_VIEWER_REALM_ID: init.rootRealm.id };

    // --actor-kind human without --as-human is rejected
    const spoofHuman = runCliFail(
      homeDir,
      [
        "--actor-kind",
        "human",
        "rule",
        "add",
        "--in",
        "/",
        "--title",
        "Spoofed human",
        "--body",
        "Should fail",
      ],
      rootEnv,
    );
    expect(spoofHuman.stderr).toContain("--as-human");

    // Default agent rejected on tree createRealm, rule, set-policy, redact
    expect(
      runCliFail(
        homeDir,
        [
          "realm",
          "create",
          "--org",
          init.org.id,
          "--parent",
          init.rootRealm.id,
          "--slug",
          "sub",
          "--name",
          "Sub",
          "--scope",
          "Sub workspace",
        ],
        rootEnv,
      ).stderr,
    ).toContain('"forbidden"');

    expect(
      runCliFail(
        homeDir,
        [
          "rule",
          "add",
          "--in",
          "/",
          "--title",
          "No human flag",
          "--body",
          "Should fail",
        ],
        rootEnv,
      ).stderr,
    ).toContain('"forbidden"');

    expect(
      runCliFail(
        homeDir,
        [
          "org",
          "set-policy",
          "--org",
          init.org.id,
          "--policy",
          "open",
        ],
        rootEnv,
      ).stderr,
    ).toContain('"forbidden"');

    const dec = runCli(
      homeDir,
      [
        "write",
        "--in",
        "/",
        "--kind",
        "decision",
        "--title",
        "Agent decision",
        "--body",
        "Agent decision body.",
      ],
      rootEnv,
    ) as { id: string; authorKind: string };
    expect(dec.authorKind).toBe("agent");

    expect(
      runCliFail(homeDir, ["redact", dec.id], rootEnv).stderr,
    ).toContain('"forbidden"');

    // Explicit --as-human succeeds for all of them (admin whitelist even without MERU_MIND_VIEWER_REALM_ID)
    const sub = runCli(homeDir, [
      "--as-human",
      "realm",
      "create",
      "--org",
      init.org.id,
      "--parent",
      init.rootRealm.id,
      "--slug",
      "sub",
      "--name",
      "Sub",
      "--scope",
      "Sub workspace",
    ]) as { id: string };
    expect(sub.id).toMatch(/^realm_/);

    const rule = runCli(
      homeDir,
      [
        "--as-human",
        "rule",
        "add",
        "--in",
        "/",
        "--title",
        "Human rule",
        "--body",
        "Verified rule body.",
      ],
      rootEnv,
    ) as { id: string; confirmedByHuman: boolean };
    expect(rule.confirmedByHuman).toBe(true);

    const redactRes = runCli(homeDir, [
      "--as-human",
      "redact",
      dec.id,
      "--reason",
      "cli redact",
    ]) as { entryId: string };
    expect(redactRes.entryId).toBe(dec.id);

    const policyRes = runCli(homeDir, [
      "--as-human",
      "org",
      "set-policy",
      "--org",
      init.org.id,
      "--policy",
      "open",
    ]) as { policy: string };
    expect(policyRes.policy).toBe("open");
  });

  it("3. open vs tree full pipeline: resolveAccess, hydration, refs validation, getSupersedeChain, readableDriveIds, tree ops auth, listRealms, and __org__ fallback", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-1b-policy-"),
    });
    engines.push(engine);

    // Open org with two sibling realms
    const { org: openOrg, rootRealm: oRoot } = engine.ledger.createOrg({
      name: "OpenOrg",
      policy: "open",
    });
    // Agents are denied realm topology mutations even in open mode; human succeeds & logs to change_log
    expect(() =>
      engine.ledger.createRealm({
        actor: agentWorker,
        orgId: openOrg.id,
        parentId: oRoot.id,
        slug: "agent-denied",
        name: "Agent Denied",
      }),
    ).toThrow(/Only human actors can create realms/);

    const oA = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: openOrg.id,
      parentId: oRoot.id,
      slug: "a",
      name: "A",
    });
    const oB = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: openOrg.id,
      parentId: oRoot.id,
      slug: "b",
      name: "B",
    });
    expect(() =>
      engine.ledger.mountRealm({
        actor: agentWorker,
        viewerRealmId: oA.id,
        targetRealmId: oB.id,
        scope: "ledger",
      }),
    ).toThrow(/Only human actors can mount realms/);

    const openMount = engine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: oA.id,
      targetRealmId: oB.id,
      scope: "ledger",
    });
    expect(openMount.viewerRealmId).toBe(oA.id);
    expect(() =>
      engine.ledger.unmountRealm({
        actor: agentWorker,
        viewerRealmId: oA.id,
        targetRealmId: oB.id,
      }),
    ).toThrow(/Only human actors can unmount realms/);
    expect(
      engine.ledger.unmountRealm({
        actor: humanAlice,
        viewerRealmId: oA.id,
        targetRealmId: oB.id,
      }),
    ).toBe(true);
    const openLogs = engine.sea.listChangeLog({ orgId: openOrg.id }).entries;
    expect(openLogs.some((e) => e.op === "create_realm")).toBe(true);
    expect(openLogs.some((e) => e.op === "mount_realm")).toBe(true);
    expect(openLogs.some((e) => e.op === "unmount_realm")).toBe(true);

    // Pure computeVisibleScope() remains strict tree even for open org realms
    const allRealms = engine.db.listRealms();
    const pureTreeScope = computeVisibleScope({
      realms: allRealms,
      mounts: [],
      viewerRealmId: oA.id,
    });
    expect(pureTreeScope.readableLedgerIds).not.toContain(oB.id);

    // resolveAccessScope with policy:"open" opens full org & keeps pureTreeScope as focusRealmIds
    const openScope = resolveAccessScope({
      realms: allRealms,
      mounts: [],
      viewerRealmId: oA.id,
      orgPolicy: "open",
    });
    expect(openScope.readableLedgerIds).toContain(oB.id);
    expect(openScope.readableDriveIds).toContain(oB.id);
    expect(openScope.readableSeabedIds).toContain(oB.id);
    expect(openScope.focusRealmIds).toEqual(pureTreeScope.readableLedgerIds);

    // Separate open org must NEVER be accessible
    const { org: otherOpenOrg, rootRealm: otherRoot } = engine.ledger.createOrg({
      name: "OtherOpen",
      policy: "open",
    });
    expect(
      resolveAccess({
        realms: engine.db.listRealms(),
        mounts: [],
        actor: humanAlice,
        viewerRealmId: oA.id,
        targetRealmId: otherRoot.id,
        assetKind: "ledger",
        orgPolicy: "open",
      }),
    ).toBe("none");

    // In open org: oB can read oA's record, cite oA's record in refs, traverse oA's supersede chain,
    // settle citing oA's record, and read oA's drive file
    const oARec1 = await engine.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: oA.id,
      kind: "decision",
      title: "Open sibling v1 OPEN_CHAIN_KEY",
    });
    const oARec2 = await engine.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: oA.id,
      kind: "decision",
      title: "Open sibling v2 OPEN_CHAIN_KEY",
      supersedesId: oARec1.id,
    });
    await engine.ledger.writeDriveFile({
      actor: agentWorker,
      viewerRealmId: oA.id,
      relPath: "shared.md",
      content: "open drive doc",
    });

    const oBRefRec = await engine.ledger.appendRecord({
      actor: agentWorker,
      viewerRealmId: oB.id,
      kind: "finding",
      title: "Cites sibling A in open mode",
      refs: [oARec2.id],
    });
    expect(oBRefRec.refs).toEqual([oARec2.id]);

    const chainFromB = engine.ledger.getSupersedeChain({
      actor: agentWorker,
      viewerRealmId: oB.id,
      recordId: oARec2.id,
    });
    expect(chainFromB.nodes.map((r) => r.id)).toEqual([oARec1.id, oARec2.id]);

    const driveFromB = await engine.ledger.readDriveFile({
      actor: agentWorker,
      viewerRealmId: oB.id,
      targetRealmId: oA.id,
      relPath: "shared.md",
    });
    expect(driveFromB?.content).toBe("open drive doc");

    const settledFromB = await engine.sea.settle({
      actor: agentWorker,
      viewerRealmId: oB.id,
      layer: "slice_shift",
      periodKey: "open-1",
      sourceIds: [oARec2.id],
    });
    expect(settledFromB.sourceIds).toEqual([oARec2.id]);

    // Cross-org ref / drive / supersede chain MUST still fail in open mode
    const otherRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: otherRoot.id,
      kind: "decision",
      title: "Other org private",
    });
    await expect(
      engine.ledger.appendRecord({
        actor: agentWorker,
        viewerRealmId: oB.id,
        kind: "finding",
        title: "Cross org ref attempt",
        refs: [otherRec.id],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(() =>
      engine.ledger.getSupersedeChain({
        actor: agentWorker,
        viewerRealmId: oB.id,
        recordId: otherRec.id,
      }),
    ).toThrow(/not found in visible scope/i);

    // F3 (kills K3): open-mode totalMatched & omittedCount MUST exclude other organizations
    const countToken = "OPEN_COUNT_ISO_TOKEN_7721";
    for (let i = 0; i < 2; i += 1) {
      await engine.ledger.appendRecord({
        actor: agentWorker,
        viewerRealmId: oA.id,
        kind: "claim",
        title: `OpenOrg A claim ${i} ${countToken}`,
      });
      await engine.ledger.appendRecord({
        actor: agentWorker,
        viewerRealmId: oB.id,
        kind: "claim",
        title: `OpenOrg B claim ${i} ${countToken}`,
      });
    }
    for (let i = 0; i < 5; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: otherRoot.id,
        kind: "claim",
        title: `OtherOpen claim ${i} ${countToken}`,
      });
    }
    const openStage2Count = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: oA.id,
      recordKinds: ["claim"],
      limit: 2,
    });
    expect(openStage2Count.items).toHaveLength(2);
    expect(openStage2Count.totalMatched).toBe(4);
    expect(openStage2Count.omittedCount).toBe(2);

    const openFtsCount = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: oA.id,
      query: countToken,
      limit: 2,
    });
    expect(openFtsCount.items).toHaveLength(2);
    expect(openFtsCount.totalMatched).toBe(4);
    expect(openFtsCount.omittedCount).toBe(2);

    // Tree org auth & listRealms tightening
    const { org: treeOrg, rootRealm: tRoot } = engine.ledger.createOrg({
      name: "TreeOrg",
      policy: "tree",
    });
    expect(() =>
      engine.ledger.createRealm({
        actor: agentWorker,
        orgId: treeOrg.id,
        parentId: tRoot.id,
        slug: "illegal",
        name: "Illegal",
      }),
    ).toThrow(/Only human actors/);

    const tA = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: treeOrg.id,
      parentId: tRoot.id,
      slug: "ta",
      name: "TA",
    });
    const tB = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: treeOrg.id,
      parentId: tRoot.id,
      slug: "tb",
      name: "TB",
    });

    expect(() =>
      engine.ledger.mountRealm({
        actor: agentWorker,
        viewerRealmId: tA.id,
        targetRealmId: tB.id,
      }),
    ).toThrow(/Only human actors/);

    engine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: tA.id,
      targetRealmId: tB.id,
    });
    expect(() =>
      engine.ledger.unmountRealm({
        actor: agentWorker,
        viewerRealmId: tA.id,
        targetRealmId: tB.id,
      }),
    ).toThrow(/Only human actors/);
    expect(
      engine.ledger.unmountRealm({
        actor: humanAlice,
        viewerRealmId: tA.id,
        targetRealmId: tB.id,
      }),
    ).toBe(true);

    // listRealms requires orgId, and in tree mode requires viewerRealmId and hides invisible siblings
    expect(() => engine.ledger.listRealms({ orgId: "" })).toThrow(/orgId is required/);
    expect(() => engine.ledger.listRealms({ orgId: treeOrg.id })).toThrow(
      /viewerRealmId is required/,
    );
    const tAVisible = engine.ledger.listRealms({
      orgId: treeOrg.id,
      viewerRealmId: tA.id,
    });
    expect(tAVisible.map((r) => r.id)).toContain(tA.id);
    expect(tAVisible.map((r) => r.id)).toContain(tRoot.id);
    expect(tAVisible.map((r) => r.id)).not.toContain(tB.id);

    // setOrgPolicy on an org with no root realm writes '__org__' instead of ''
    engine.db.insertOrg({
      id: "org_rootless",
      name: "Rootless",
      isPersonalRoot: false,
      policy: "tree",
      createdAt: new Date().toISOString(),
    });
    engine.ledger.setOrgPolicy({
      orgId: "org_rootless",
      policy: "open",
      actor: humanAlice,
    });
    const rootlessLogs = engine.sea.listChangeLog({ orgId: "org_rootless" }).entries;
    expect(rootlessLogs).toHaveLength(1);
    expect(rootlessLogs[0]!.realmId).toBe("__org__");
    expect(otherOpenOrg.id).toBeTruthy();
  });

  it("4. tree-mode full-field leak filtering (refs, sourceRefs, sourceIds, seabed.sourceRef, supersedes*) & >500 exact SQL COUNT(*) omittedCount without secret/sibling leaks", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-1b-filter-"),
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "StrictTree",
      policy: "tree",
    });
    const sibA = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "a",
      name: "A",
    });
    const sibB = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "b",
      name: "B",
    });

    // Temporarily mount sibB onto sibA so sibA can legitimately cite sibB's record,
    // seabed, and drive file, then UNMOUNT sibB to verify every field is stripped on read!
    engine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      targetRealmId: sibB.id,
      scope: "all",
    });

    const bRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibB.id,
      kind: "decision",
      title: "Hidden B record",
    });
    const aVisibleRef = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "decision",
      title: "Visible A ref",
    });
    const aCitingB = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "finding",
      title: "Finding with mixed refs FIELD_LEAK_CHECK",
      refs: [aVisibleRef.id, bRec.id],
    });
    const aSeaWithBDrive = await engine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "message",
      text: "Artifact pointing to B drive FIELD_LEAK_CHECK",
      sourceRef: `drive://${sibB.id}/confidential.md@v1`,
    });
    const aDist = await engine.sea.settle({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      layer: "card_realm",
      periodKey: "2026-11-21",
      narrativeMd: "Card citing B FIELD_LEAK_CHECK",
      sourceIds: [aVisibleRef.id, bRec.id],
    });

    // Now unmount sibB -> sibB is completely invisible to sibA!
    engine.ledger.unmountRealm({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      targetRealmId: sibB.id,
    });

    // Check recall: bRec.id and drive://<sibB>/... MUST be stripped from ALL items
    const recalled = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: sibA.id,
      query: "FIELD_LEAK_CHECK",
    });
    const recItem = recalled.items.find((i) => i.id === aCitingB.id)!;
    expect(recItem.sourceRefs).toEqual([aVisibleRef.id]);
    expect(recItem.sourceRefs).not.toContain(bRec.id);

    const seaItem = recalled.items.find((i) => i.id === aSeaWithBDrive.id)!;
    expect(seaItem.sourceRefs).toEqual([]);

    const distItem = recalled.items.find((i) => i.id === aDist.id)!;
    expect(distItem.sourceRefs).toEqual([aVisibleRef.id]);
    expect(distItem.sourceRefs).not.toContain(bRec.id);

    // Check brief: realmCard.sourceIds and recentMessages.sourceRef are also stripped
    const briefA = engine.sea.brief({ actor: agentWorker, viewerRealmId: sibA.id });
    expect(briefA.middleMind.realmCard?.sourceIds).toEqual([aVisibleRef.id]);
    const briefSea = briefA.surface.recentMessages.items.find(
      (m) => m.id === aSeaWithBDrive.id,
    );
    expect(briefSea?.sourceRef).toBeNull();

    // Check supersedesId / supersededById filtering when linked record is secret (invisible in lists)
    const secretBase = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "decision",
      title: "Secret v1 base",
      sensitivity: "secret",
    });
    const publicV2 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "decision",
      title: "Public v2 SUPERSEDE_FILTER_CHECK",
      supersedesId: secretBase.id,
    });
    const pubBase = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "decision",
      title: "Public v1 SUPERSEDE_FILTER_CHECK",
    });
    await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: sibA.id,
      kind: "decision",
      title: "Secret v2 head",
      supersedesId: pubBase.id,
      sensitivity: "secret",
    });
    const supFiltered = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: sibA.id,
      query: "SUPERSEDE_FILTER_CHECK",
      includeHistory: true,
    });
    const pubV2Item = supFiltered.items.find((i) => i.id === publicV2.id)!;
    expect(pubV2Item.supersedesId).toBeNull();
    const pubBaseItem = supFiltered.items.find((i) => i.id === pubBase.id)!;
    expect(pubBaseItem.supersededById).toBeNull();
    expect(pubBaseItem.currentHeadId).toBeNull();

    // F2 (kills K9): getSupersedeChain uses the single shared sanitizer:
    // B cites descendant C's seabed; X mounts ONLY B's ledger; from X, getSupersedeChain(bRec) MUST strip C's seabed ID from refs!
    const chainOrg = engine.ledger.createOrg({
      name: "ChainSanitizeOrg",
      policy: "tree",
    });
    const realmB = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: chainOrg.org.id,
      parentId: chainOrg.rootRealm.id,
      slug: "b",
      name: "B",
    });
    const realmC = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: chainOrg.org.id,
      parentId: realmB.id,
      slug: "c",
      name: "C",
    });
    const realmX = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: chainOrg.org.id,
      parentId: chainOrg.rootRealm.id,
      slug: "x",
      name: "X",
    });
    const cSeabed = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: realmC.id,
      kind: "evidence",
      text: "Descendant C raw seabed evidence",
    });
    const bVisibleDec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmB.id,
      kind: "decision",
      title: "B base decision",
    });
    const bCitingC = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmB.id,
      kind: "decision",
      title: "B decision citing descendant C seabed",
      refs: [bVisibleDec.id, cSeabed.id],
      supersedesId: bVisibleDec.id,
    });
    engine.ledger.mountRealm({
      actor: humanAlice,
      viewerRealmId: realmX.id,
      targetRealmId: realmB.id,
      scope: "ledger",
    });

    const chainFromX = engine.ledger.getSupersedeChain({
      actor: agentWorker,
      viewerRealmId: realmX.id,
      recordId: bCitingC.id,
    });
    expect(chainFromX.nodes.map((r) => r.id)).toEqual([bVisibleDec.id, bCitingC.id]);
    const sanitizedBInChain = chainFromX.nodes.find((r) => r.id === bCitingC.id)!;
    expect(sanitizedBInChain.refs).toEqual([bVisibleDec.id]);
    expect(sanitizedBInChain.refs).not.toContain(cSeabed.id);

    const recallFromX = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmX.id,
      id: bCitingC.id,
    });
    expect(recallFromX.items[0]!.sourceRefs).toEqual([bVisibleDec.id]);
    expect(recallFromX.items[0]!.sourceRefs).not.toContain(cSeabed.id);

    // Check >500 exact SQL COUNT(*) with zero silent truncation and zero secret/hidden-sibling count leak
    const bulkOrg = engine.ledger.createOrg({ name: "BulkOrg", policy: "tree" });
    const visRealm = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: bulkOrg.org.id,
      parentId: bulkOrg.rootRealm.id,
      slug: "vis",
      name: "Vis",
    });
    const hidRealm = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: bulkOrg.org.id,
      parentId: bulkOrg.rootRealm.id,
      slug: "hid",
      name: "Hid",
    });

    // Insert 525 normal records + 5 secret records in visRealm, plus 40 normal records in hidRealm
    // (Use a single db transaction around inserts? Keep real appendRecord for realistic FTS + SQL)
    const bulkCount = 525;
    for (let i = 0; i < bulkCount; i += 1) {
      await engine.ledger.appendRecord({
        actor: agentWorker,
        viewerRealmId: visRealm.id,
        kind: i < 210 ? "proposal" : "finding",
        title: `Bulk item ${i} BULK_EXACT_COUNT_TOKEN`,
        payload: i < 210 ? { requiresHuman: true } : {},
      });
    }
    for (let i = 0; i < 5; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: visRealm.id,
        kind: "proposal",
        title: `Secret item ${i} BULK_EXACT_COUNT_TOKEN`,
        payload: { requiresHuman: true },
        sensitivity: "secret",
      });
    }
    for (let i = 0; i < 40; i += 1) {
      await engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: hidRealm.id,
        kind: "proposal",
        title: `Hidden sibling ${i} BULK_EXACT_COUNT_TOKEN`,
        payload: { requiresHuman: true },
      });
    }

    // Stage 2 structured recall MUST report exact 525 (NOT truncated at 500, NOT counting 5 secret or 40 hidden!)
    const stage2 = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: visRealm.id,
      recordKinds: ["proposal", "finding"],
      limit: 10,
    });
    expect(stage2.items).toHaveLength(10);
    expect(stage2.totalMatched).toBe(525);
    expect(stage2.omittedCount).toBe(515);

    // Stage 3 FTS recall MUST also report exact 525 via SQL COUNT(*)
    const stage3 = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: visRealm.id,
      query: "BULK_EXACT_COUNT_TOKEN",
      limit: 10,
    });
    expect(stage3.items).toHaveLength(10);
    expect(stage3.totalMatched).toBe(525);
    expect(stage3.omittedCount).toBe(515);

    // Brief pendingQuestions MUST report exact 210 (NOT truncated at 200, NOT counting 5 secret!)
    const bulkBrief = engine.sea.brief({
      actor: agentWorker,
      viewerRealmId: visRealm.id,
      budget: { maxQuestions: 5 },
    });
    expect(bulkBrief.upperLedger.pendingQuestions.items).toHaveLength(5);
    expect(bulkBrief.upperLedger.pendingQuestions.totalCount).toBe(210);
    expect(bulkBrief.upperLedger.pendingQuestions.omittedCount).toBe(205);
  }, 20_000);

  it("5. sensitivity enforcement: secret excluded from FTS/vec/listRecords/thingId/Stage2/brief/exportSlice/change_log (exact ID only); confidential excluded from exportSlice", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-1b-sens-"),
      embedder: new Deterministic4DimEmbedder(),
      vectorDimensions: 4,
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "SensOrg",
      policy: "tree",
    });
    const child = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "app",
      name: "App",
    });

    const thing = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: child.id,
      kind: "thing",
      title: "Credential rotation thing",
    });

    const secretToken = "SECRET_CANARY_XY9988";
    const confToken = "CONFIDENTIAL_CANARY_ZZ7766";
    const pubToken = "INTERNAL_CANARY_AA1122";

    const secretRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: child.id,
      thingId: thing.id,
      kind: "decision",
      title: `Rotate master key ${secretToken}`,
      sensitivity: "secret",
    });
    const secretSea = await engine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: child.id,
      kind: "message",
      text: `Raw secret chat ${secretToken}`,
      sensitivity: "secret",
    });

    const confRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: child.id,
      thingId: thing.id,
      kind: "decision",
      title: `Partner contract pricing ${confToken}`,
      sensitivity: "confidential",
    });
    const confSea = await engine.ledger.captureSeabed({
      actor: humanAlice,
      viewerRealmId: child.id,
      kind: "message",
      text: `Partner margin note ${confToken}`,
      sensitivity: "confidential",
    });

    const normalRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: child.id,
      thingId: thing.id,
      kind: "decision",
      title: `Use HTTP/2 ${pubToken}`,
      sensitivity: "internal",
    });

    // Distillation citing confidential entry should NOT leak into exportSlice
    await engine.sea.settle({
      actor: humanAlice,
      viewerRealmId: child.id,
      layer: "card_realm",
      periodKey: "2026-11-21",
      narrativeMd: `Summary mentioning ${confToken}`,
      sourceIds: [confRec.id, normalRec.id],
    });

    // Trying to settle a secret entry MUST be rejected
    await expect(
      engine.sea.settle({
        actor: humanAlice,
        viewerRealmId: child.id,
        layer: "slice_shift",
        periodKey: "bad-secret",
        sourceIds: [secretRec.id],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // Sync embeddings & rebuild: secret stays out of FTS5 & vec_items
    await engine.sea.syncEmbeddings();

    // 1. Secret hidden from FTS + vector recall
    const secretSearch = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: child.id,
      query: secretToken,
    });
    expect(secretSearch.items.some((i) => i.id === secretRec.id)).toBe(false);
    expect(secretSearch.items.some((i) => i.id === secretSea.id)).toBe(false);

    // 2. Secret hidden from db.listRecords & db.listSeabedEntries
    const listedRecs = engine.db.listRecords({ realmIds: [child.id] });
    expect(listedRecs.items.some((r) => r.id === secretRec.id)).toBe(false);
    const listedSea = engine.db.listSeabedEntries({ realmIds: [child.id] });
    expect(listedSea.items.some((s) => s.id === secretSea.id)).toBe(false);

    // 3. Secret hidden from thingId timeline
    const timeline = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: child.id,
      thingId: thing.id,
    });
    expect(timeline.items.some((i) => i.id === secretRec.id)).toBe(false);
    expect(timeline.items.some((i) => i.id === confRec.id)).toBe(true);
    expect(timeline.items.some((i) => i.id === normalRec.id)).toBe(true);

    // 4. Secret hidden from Stage 2 structured filter
    const stage2 = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: child.id,
      recordKinds: ["decision"],
    });
    expect(stage2.items.some((i) => i.id === secretRec.id)).toBe(false);
    expect(stage2.items.some((i) => i.id === confRec.id)).toBe(true);

    // 5. Secret hidden from brief (confidential IS shown in brief!)
    const brief = engine.sea.brief({ actor: humanAlice, viewerRealmId: child.id });
    const briefStr = JSON.stringify(brief);
    expect(briefStr).not.toContain(secretToken);
    expect(briefStr).not.toContain(secretRec.id);
    expect(briefStr).not.toContain(secretSea.id);
    expect(briefStr).toContain(confToken);

    // 6. Secret hidden from change_log summary
    const changeLog = engine.sea.listChangeLog({ orgId: org.id });
    expect(changeLog.entries.some((e) => e.entityId === secretRec.id)).toBe(false);
    expect(changeLog.entries.some((e) => e.entityId === secretSea.id)).toBe(false);
    expect(changeLog.entries.some((e) => e.entityId === confRec.id)).toBe(true);

    // 7. Secret IS readable by exact ID within visible scope
    const exactRec = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: child.id,
      id: secretRec.id,
    });
    expect(exactRec.items).toHaveLength(1);
    expect(exactRec.items[0]!.id).toBe(secretRec.id);

    const exactSea = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: child.id,
      id: secretSea.id,
    });
    expect(exactSea.items).toHaveLength(1);
    expect(exactSea.items[0]!.id).toBe(secretSea.id);

    // 8. Confidential IS searchable in-org
    const confSearch = await engine.sea.recall({
      actor: humanAlice,
      viewerRealmId: child.id,
      query: confToken,
    });
    expect(confSearch.items.some((i) => i.id === confRec.id)).toBe(true);
    expect(confSearch.items.some((i) => i.id === confSea.id)).toBe(true);

    // 9. BOTH secret AND confidential MUST be 100% absent from exportSlice!
    const sliceDir = makeTempDir("meru-mind-1b-sens-slice-");
    await engine.slice.exportSlice({
      actor: humanAlice,
      viewerRealmId: child.id,
      outDir: sliceDir,
    });
    const allSliceText = collectFilesRecursive(sliceDir)
      .map((p) => fs.readFileSync(p, "utf8"))
      .join("\n");
    expect(allSliceText).toContain(pubToken);
    expect(allSliceText).not.toContain(secretToken);
    expect(allSliceText).not.toContain(secretRec.id);
    expect(allSliceText).not.toContain(confToken);
    expect(allSliceText).not.toContain(confRec.id);
    expect(allSliceText).not.toContain(confSea.id);
  });

  it("6. mixed CJK/English FTS5 + JS identifier boundary + active-first + open focus boost + 1-hop currentHeadId", async () => {
    const engine = await createMindEngine({
      homeDir: makeTempDir("meru-mind-1b-fts-"),
    });
    engines.push(engine);

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "SearchOrg",
      policy: "open",
    });
    const realmAlpha = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "alpha",
      name: "Alpha",
    });
    const realmBeta = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "beta",
      name: "Beta",
    });

    // A) Intact CJK overlapping bigrams + filler bigram filtering + all-filler protection
    const parsedStop = parseSearchQuery("查找一下关于支付网关的相关");
    expect(parsedStop.concepts.length).toBe(1);
    expect(parsedStop.concepts[0]!.terms).toContain("支付");
    expect(parsedStop.concepts[0]!.terms).toContain("网关");
    expect(parsedStop.concepts[0]!.terms).not.toContain("查找");
    expect(parsedStop.concepts[0]!.terms).not.toContain("相关");
    expect(parsedStop.ftsExpression).toContain('"支付"');
    expect(parsedStop.ftsExpression).toContain('"网关"');

    const parsedAllStop = parseSearchQuery("查找一下相关");
    expect(parsedAllStop.concepts.length).toBeGreaterThan(0);
    expect(parsedAllStop.ftsExpression).not.toBeNull();

    const payGateway = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "支付网关接入限流策略",
      payload: { detail: "核心支付网关限流 5000 QPS" },
    });
    const scatteredCjk = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "支持付款的网络关口", // has 支,付,网,关 scattered, NOT contiguous 支付网关
    });

    const cjkHit = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      query: "查找一下关于支付网关的相关",
    });
    expect(cjkHit.items.some((i) => i.id === payGateway.id)).toBe(true);
    expect(cjkHit.items.some((i) => i.id === scatteredCjk.id)).toBe(false);

    // Multi-concept OR + tiering: Tier 3 (all in title) > Tier 2 (all in body) > Tier 1 (partial)
    const tier1Partial = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "支付网关日志归档",
    });
    const tier2Body = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "网关架构说明",
      payload: { detail: "支付网关配合限流策略避免雪崩" },
    });
    const multiConcept = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      query: "支付网关 限流",
    });
    const ids = multiConcept.items.map((i) => i.id);
    expect(ids).toContain(payGateway.id);
    expect(ids).toContain(tier2Body.id);
    expect(ids).toContain(tier1Partial.id);
    expect(ids.indexOf(payGateway.id)).toBeLessThan(ids.indexOf(tier2Body.id));
    expect(ids.indexOf(tier2Body.id)).toBeLessThan(ids.indexOf(tier1Partial.id));

    // B) JS exact identifier boundary: "agent-worker" MUST NOT match "agent-worker-bridge"
    const exactIdent = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "Deploy agent-worker with 4 replicas",
    });
    const longerIdent = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "Deploy agent-worker-bridge with 4 replicas",
    });
    const slashExact = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "Route api/v2/auth through TLS",
    });
    const slashLonger = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "Route api/v2/auth-proxy through TLS",
    });

    const identSearch = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      query: "agent-worker",
    });
    expect(identSearch.items.map((i) => i.id)).toEqual([exactIdent.id]);
    expect(identSearch.items.some((i) => i.id === longerIdent.id)).toBe(false);

    const slashSearch = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      query: "api/v2/auth",
    });
    expect(slashSearch.items.map((i) => i.id)).toEqual([slashExact.id]);
    expect(slashSearch.items.some((i) => i.id === slashLonger.id)).toBe(false);

    const colonExact = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "Connect cache at redis:6379",
    });
    const colonLonger = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "Connect replica at redis:63790",
    });
    const colonSearch = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      query: "redis:6379",
    });
    expect(colonSearch.items.map((i) => i.id)).toEqual([colonExact.id]);
    expect(colonSearch.items.some((i) => i.id === colonLonger.id)).toBe(false);

    // Equal-score tie-break MUST sort by occurredAt DESC (even when inserted earlier)
    const tieNewerOccurred = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "TIEBREAK_OCCURRED_TOKEN",
      occurredAt: "2026-11-21T12:00:00.000Z",
    });
    const tieOlderOccurred = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "TIEBREAK_OCCURRED_TOKEN",
      occurredAt: "2026-11-10T12:00:00.000Z",
    });
    const tieRes = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      query: "TIEBREAK_OCCURRED_TOKEN",
    });
    expect(tieRes.items.map((i) => i.id)).toEqual([
      tieNewerOccurred.id,
      tieOlderOccurred.id,
    ]);

    // C) Open-mode focus boost: default OFF (pure relevance/time tie-break), opt-in focusBoost: true flips identical-quality docs in Alpha vs Beta
    const alphaDoc = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "FOCUS_BOOST_CANARY service config",
      occurredAt: "2026-11-20T10:00:00.000Z",
    });
    const betaDoc = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmBeta.id,
      kind: "decision",
      title: "FOCUS_BOOST_CANARY service config",
      occurredAt: "2026-11-20T10:00:00.000Z",
    });

    const fromAlphaDefault = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      query: "FOCUS_BOOST_CANARY",
    });
    const fromBetaDefault = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmBeta.id,
      query: "FOCUS_BOOST_CANARY",
    });
    expect(fromAlphaDefault.items.map((i) => i.id)).toEqual(
      fromBetaDefault.items.map((i) => i.id),
    );

    const fromAlpha = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      query: "FOCUS_BOOST_CANARY",
      focusBoost: true,
    });
    expect(fromAlpha.items[0]!.id).toBe(alphaDoc.id);
    expect(fromAlpha.items[1]!.id).toBe(betaDoc.id);

    const fromBeta = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmBeta.id,
      query: "FOCUS_BOOST_CANARY",
      focusBoost: true,
    });
    expect(fromBeta.items[0]!.id).toBe(betaDoc.id);
    expect(fromBeta.items[1]!.id).toBe(alphaDoc.id);

    // D) Active conclusion > raw seabed > superseded, plus 1-hop currentHeadId & occurredAt tie-break
    const chainV1 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "RANKING_WEIGHT_TOKEN",
      occurredAt: "2026-11-18T10:00:00.000Z",
    });
    const chainV2 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "RANKING_WEIGHT_TOKEN",
      supersedesId: chainV1.id,
      occurredAt: "2026-11-19T10:00:00.000Z",
    });
    const chainV3 = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: realmAlpha.id,
      kind: "decision",
      title: "RANKING_WEIGHT_TOKEN",
      supersedesId: chainV2.id,
      occurredAt: "2026-11-20T10:00:00.000Z",
    });
    const rawSeabed = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      kind: "message",
      topicId: "RANKING_WEIGHT_TOKEN",
      text: "RANKING_WEIGHT_TOKEN",
      occurredAt: "2026-11-21T10:00:00.000Z",
    });

    const ranked = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      query: "RANKING_WEIGHT_TOKEN",
      includeHistory: true,
    });
    const rankOrder = ranked.items.map((i) => i.id);
    expect(rankOrder.indexOf(chainV3.id)).toBeLessThan(
      rankOrder.indexOf(rawSeabed.id),
    );
    expect(rankOrder.indexOf(rawSeabed.id)).toBeLessThan(
      rankOrder.indexOf(chainV1.id),
    );

    // 1-hop currentHeadId attached to superseded items in BOTH includeHistory and direct ID lookup
    const v1FromHistory = ranked.items.find((i) => i.id === chainV1.id)!;
    expect(v1FromHistory.currentHeadId).toBe(chainV3.id);

    const v1Direct = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      id: chainV1.id,
    });
    expect(v1Direct.items[0]!.currentHeadId).toBe(chainV3.id);

    // Redacting the active chain head sets currentHeadId -> null (no active version)
    engine.ledger.redact({
      actor: humanAlice,
      entryId: chainV3.id,
      reason: "retract head",
    });
    const v1AfterHeadRedact = await engine.sea.recall({
      actor: agentWorker,
      viewerRealmId: realmAlpha.id,
      id: chainV1.id,
    });
    expect(v1AfterHeadRedact.items[0]!.currentHeadId).toBeNull();
  });

  it("7. full-chain redact: human-only, wipes records/seabed/distillations, refcounted blob delete, residualLocations, redacted_blocklist, blocks supersede, and byte-level 0-hit sweep across .sqlite/-wal/-shm/blobs", async () => {
    const homeDir = makeTempDir("meru-mind-1b-redact-");
    const engine = await createMindEngine({
      homeDir,
      embedder: new Deterministic4DimEmbedder(),
      vectorDimensions: 4,
    });

    const { org, rootRealm } = engine.ledger.createOrg({
      name: "RedactOrg",
      policy: "open",
    });

    // Single-token lowercase alphanumeric secrets (no separators) so FTS5 unicode61 indexes
    // each verbatim as one contiguous token; skipping FTS optimize leaves plaintext bytes in .sqlite (kills K7/K7b).
    const secretRecCanary = "zqxjkvbsecrettokenrec9876543210";
    const secretSeaCanary = "zqxjkvbsecretkeysea1122334455";
    const secretBlobCanary = "zqxjkvbsecretblob6677889900";
    const secretDistCanary = "zqxjkvbsecretcard5544332211";
    const secretTagCanary = "zqxjtagsecret778899";

    const targetRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "decision",
      title: `Leaked decision ${secretRecCanary}`,
      payload: { secret: secretRecCanary, sourceRef: "doc://leak/rec.md" },
    });

    // Attach a sensitive resource tag via tagEntryResource (writes change_log too — kills B1)
    engine.objects.tagEntryResource({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      entryId: targetRec.id,
      tag: `secret:${secretTagCanary}`,
    });

    const targetSea = await engine.ledger.captureSeabed({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      kind: "artifact",
      text: `Leaked seabed ${secretSeaCanary}`,
      blobContent: `attachment body ${secretBlobCanary}`,
      sourceRef: "file:///tmp/leak.txt",
      metadata: { leaked: secretSeaCanary },
    });
    expect(targetSea.blobSha256).toBeTruthy();
    const unrefBlobSha = targetSea.blobSha256!;
    expect(engine.blobs.has(unrefBlobSha)).toBe(true);

    // Distillation citing BOTH targetRec and targetSea
    const linkedDist = await engine.sea.settle({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      layer: "card_realm",
      periodKey: "2026-11-21",
      narrativeMd: `Card repeating ${secretDistCanary} and ${secretRecCanary}`,
      sourceIds: [targetRec.id, targetSea.id],
    });
    expect(
      (linkedDist.hardFacts.activeDecisionIds as string[]).includes(targetRec.id),
    ).toBe(true);

    // Sync embeddings so ALL 3 items exist in vec_items & fts_index before redaction
    const synced = await engine.sea.syncEmbeddings();
    expect(synced.indexed).toBe(3);

    // Non-human actor MUST be rejected
    expect(() =>
      engine.ledger.redact({
        actor: agentWorker,
        entryId: targetRec.id,
        reason: "unauthorized",
      }),
    ).toThrow(/Only human actors/);

    // 1. Redact record
    const resRec = engine.ledger.redact({
      actor: humanAlice,
      entryId: targetRec.id,
      reason: "credential leak in record",
    });
    expect(resRec.entityType).toBe("record");
    expect(resRec.retractedDistillationIds).toEqual([linkedDist.id]);
    expect(resRec.blocklistRecorded).toBe(true);
    expect(resRec.walCheckpoint.busy).toBe(0);

    // Verify record wiped & cannot be superseded
    const wipedRec = engine.db.getRecord(targetRec.id)!;
    expect(wipedRec.status).toBe("retracted");
    expect(wipedRec.title).toBe("[REDACTED]");
    expect(wipedRec.payload).toEqual({});
    expect(wipedRec.redactedBy).toBe("alice");
    expect(wipedRec.redactedReason).toBe("credential leak in record");

    await expect(
      engine.ledger.appendRecord({
        actor: humanAlice,
        viewerRealmId: rootRealm.id,
        kind: "decision",
        title: "Attempt to supersede retracted record",
        supersedesId: targetRec.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Verify linked distillation retracted, narrative wiped, hardFacts pruned, removed from FTS/vec
    const wipedDist = engine.db.getDistillation(linkedDist.id)!;
    expect(wipedDist.status).toBe("retracted");
    expect(wipedDist.narrativeMd).toBe("[REDACTED]");
    expect(
      (wipedDist.hardFacts.activeDecisionIds as string[]).includes(targetRec.id),
    ).toBe(false);

    // 2. Redact seabed -> unreferenced blob MUST be deleted from disk
    const resSea = engine.ledger.redact({
      actor: humanAlice,
      entryId: targetSea.id,
      reason: "credential leak in seabed",
    });
    expect(resSea.entityType).toBe("seabed");
    expect(resSea.deletedBlobSha256).toBe(unrefBlobSha);
    expect(engine.blobs.has(unrefBlobSha)).toBe(false);
    expect(resSea.walCheckpoint.busy).toBe(0);

    const wipedSea = engine.db.getSeabedEntry(targetSea.id)!;
    expect(wipedSea.text).toBe("[REDACTED]");
    expect(wipedSea.metadata).toEqual({});
    expect(wipedSea.blobSha256).toBeNull();

    // Verify redacted_blocklist has entries for both
    const blocklist = engine.db.listRedactedBlocklist(org.id);
    expect(blocklist.some((b) => b.sourceRef === "doc://leak/rec.md")).toBe(true);
    expect(
      blocklist.some(
        (b) =>
          b.sourceRef === "file:///tmp/leak.txt" &&
          b.contentSha256 === unrefBlobSha,
      ),
    ).toBe(true);

    // Verify change_log logged both redact ops and NEVER exposes redacted tag plaintext
    const redactLogs = engine.sea
      .listChangeLog({ orgId: org.id })
      .entries.filter((e) => e.op === "redact");
    expect(redactLogs.map((e) => e.entityId).sort()).toEqual(
      [targetRec.id, targetSea.id].sort(),
    );
    const changesAfterRedact = engine.sea.changes({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      sinceSeq: 0,
      limit: 500,
    });
    expect(JSON.stringify(changesAfterRedact)).not.toContain(secretTagCanary);

    // 3. Close ALL connections and perform raw BYTE-LEVEL grep over .sqlite, -wal, -shm, and blobs/
    await engine.close();

    const filesToSweep = [
      path.join(homeDir, "mind.sqlite"),
      path.join(homeDir, "mind.sqlite-wal"),
      path.join(homeDir, "mind.sqlite-shm"),
      ...collectFilesRecursive(path.join(homeDir, "blobs")),
    ].filter((f) => fs.existsSync(f));

    expect(filesToSweep.length).toBeGreaterThan(0);

    const forbiddenNeedles = [
      secretRecCanary,
      secretSeaCanary,
      secretBlobCanary,
      secretDistCanary,
      secretTagCanary,
    ];
    for (const filePath of filesToSweep) {
      const rawBuf = fs.readFileSync(filePath);
      for (const needle of forbiddenNeedles) {
        const idx = rawBuf.indexOf(Buffer.from(needle, "utf8"));
        expect(
          idx,
          `Found leaked plaintext "${needle}" in ${path.basename(filePath)} at byte offset ${idx}`,
        ).toBe(-1);
      }
    }

    // 4. Residual locations & refcount preservation when a drive file still shares the blob,
    //    AND real walCheckpoint.busy === 1 when another reader holds an active read snapshot
    const homeDir2 = makeTempDir("meru-mind-1b-redact-residual-");
    const engine2 = await createMindEngine({ homeDir: homeDir2 });
    engines.push(engine2);
    const { rootRealm: r2 } = engine2.ledger.createOrg({ name: "DriveOrg" });
    const driveWrite = await engine2.ledger.writeDriveFile({
      actor: humanAlice,
      viewerRealmId: r2.id,
      relPath: "notes/leak.md",
      content: "shared drive file body",
    });

    // Open an independent SQLite reader holding a read snapshot so WAL TRUNCATE reports busy = 1
    const { DatabaseSync } = await import("node:sqlite");
    const readerDb = new DatabaseSync(path.join(homeDir2, "mind.sqlite"));
    readerDb.exec("BEGIN;");
    readerDb.prepare("SELECT COUNT(*) FROM records").get();
    let resDriveArtifact;
    try {
      resDriveArtifact = engine2.ledger.redact({
        actor: humanAlice,
        entryId: driveWrite.artifactId,
        reason: "redact artifact only",
      });
    } finally {
      readerDb.exec("ROLLBACK;");
      readerDb.close();
    }

    // Shared blob stays on disk because drive_files still references it, residualLocations reports drive path,
    // and walCheckpoint honestly reports busy = 1 due to the concurrent reader snapshot!
    expect(resDriveArtifact.deletedBlobSha256).toBeNull();
    expect(engine2.blobs.has(driveWrite.meta.sha256)).toBe(true);
    expect(
      resDriveArtifact.residualLocations.some((loc) =>
        loc.includes(`drive://${r2.id}/notes/leak.md`),
      ),
    ).toBe(true);
    expect(resDriveArtifact.walCheckpoint.busy).toBe(1);
  });

  it("8. scripts/check-oss.mjs loads external MERU_MIND_OSS_DENYLIST_FILE to block private terms while skipping cleanly when absent", () => {
    const tmpDir = makeTempDir("meru-mind-1b-oss-");

    // 1. Denylist containing a term that exists in repo MUST fail (exit 1)
    const blockingList = path.join(tmpDir, "block.txt");
    fs.writeFileSync(
      blockingList,
      "# comment line should be ignored\n\nLocalFsDriveAdapter\n",
      "utf8",
    );
    let blockedExit = 0;
    let blockedStderr = "";
    try {
      execFileSync(process.execPath, [checkOssScript], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, MERU_MIND_OSS_DENYLIST_FILE: blockingList },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string | Buffer };
      blockedExit = e.status ?? 1;
      blockedStderr = String(e.stderr ?? "");
    }
    expect(blockedExit).toBe(1);
    expect(blockedStderr).toContain("matched external denylist term");

    // 2. Denylist with comments, blank lines, and a dynamically constructed term absent from repo MUST pass (exit 0)
    const cleanList = path.join(tmpDir, "clean.txt");
    const absentTerm = ["NONEXISTENT", "PRIVATE", "CORP", "TOKEN", "994411"].join(
      "_",
    );
    fs.writeFileSync(
      cleanList,
      `# local private denylist\n\n${absentTerm}\n`,
      "utf8",
    );
    const cleanOut = execFileSync(process.execPath, [checkOssScript], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, MERU_MIND_OSS_DENYLIST_FILE: cleanList },
    });
    expect(cleanOut).toContain("PASSED");
    expect(cleanOut).toContain("1 external denylist term(s) checked");

    // 3. Nonexistent external denylist path MUST pass silently (CI-safe)
    const missingOut = execFileSync(process.execPath, [checkOssScript], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        MERU_MIND_OSS_DENYLIST_FILE: path.join(tmpDir, "does-not-exist.txt"),
      },
    });
    expect(missingOut).toContain("PASSED");
  });
});
