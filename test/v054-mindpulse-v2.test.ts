import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FOCUS_ITEM_CHARS,
  MAX_SESSIONS_PER_PRINCIPAL,
  MAX_SESSION_TAG_CHARS,
  RemoteMindSurface,
  startMindServer,
  type MindServerHandle,
} from "../src/index.js";

const tempDirs: string[] = [];
const openServers: MindServerHandle[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function mcpCall(params: {
  url: string;
  token: string;
  method: string;
  id: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const rpcBody =
    params.method === "tools/call"
      ? {
          jsonrpc: "2.0",
          id: params.id,
          method: "tools/call",
          params: { name: params.toolName, arguments: params.toolArgs ?? {} },
        }
      : {
          jsonrpc: "2.0",
          id: params.id,
          method: params.method,
          params: {},
        };

  const res = await fetch(`${params.url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(params.headers ?? {}),
    },
    body: JSON.stringify(rpcBody),
  });
  const text = await res.text();
  // Streamable HTTP may reply as SSE (`data: {...}`) or plain JSON
  const dataLine = text
    .split(/\r?\n/)
    .find((l) => l.startsWith("data:"));
  const jsonText = dataLine ? dataLine.slice("data:".length).trim() : text;
  return { status: res.status, body: JSON.parse(jsonText) as Record<string, unknown> };
}

function parseMcpToolJson<T>(rpcBody: Record<string, unknown>): T {
  const result = rpcBody.result as { content?: Array<{ text?: string }> };
  return JSON.parse(result.content![0]!.text!) as T;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (openServers.length > 0) {
    await openServers.pop()!.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v0.5.4 MindPulse v2 — Security Hardening, Unified withLivePulse, Cross-Surface collisionHints & Token Throttle", () => {
  it("1. Tree-mode covert channel blocked: agent in /a cannot declare pulse to /, reading / never exposes /a to /b, and @mounted realmPath is sanitized", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v054-tree-pulse-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    const admin = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: adminTok.token,
    });
    await admin.createRealm({
      parentRef: "/",
      slug: "a",
      name: "Branch A",
      scope: "Include: A. Exclude: B.",
    });
    await admin.createRealm({
      parentRef: "/",
      slug: "b",
      name: "Branch B",
      scope: "Include: B. Exclude: A.",
    });
    await admin.createRealm({
      parentRef: "/",
      slug: "secret-parent",
      name: "Secret Parent",
      scope: "Include: hidden parent. Exclude: others.",
    });
    await admin.createRealm({
      parentRef: "/secret-parent",
      slug: "shared-leaf",
      name: "Shared Leaf",
      scope: "Include: shared leaf. Exclude: parent.",
    });
    await admin.setOrgPolicy({ policy: "tree" });
    await admin.mountRealm({
      viewerRef: "/b",
      targetRef: "/secret-parent/shared-leaf",
      scope: "ledger",
    });

    const tokA = await admin.createToken({
      actorId: "agent-a",
      actorKind: "agent",
      boundRealmRef: "/a",
    });
    const tokB = await admin.createToken({
      actorId: "agent-b",
      actorKind: "agent",
      boundRealmRef: "/b",
    });
    const tokLeaf = await admin.createToken({
      actorId: "agent-leaf",
      actorKind: "agent",
      boundRealmRef: "/secret-parent/shared-leaf",
    });

    // 1a. Agent bound to /a CANNOT declare pulse into read-only ancestor / (closes covert channel!)
    const hijackRoot = await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokA.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        realmRef: "/",
        focus: ["covert:signal"],
        note: "Trying to signal sibling B via root",
      }),
    });
    expect(hijackRoot.status).toBe(403);

    // 1b. Passive observation when /a reads shared ancestor / MUST stay anchored on /a (invisible to /b!)
    const surfA = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: tokA.token,
      sessionId: "a-sess",
      clientHint: "claude-code",
    });
    await surfA.show({ ref: "/" });

    const listBRes = await fetch(`${srv.url}/v1/pulse`, {
      headers: { Authorization: `Bearer ${tokB.token}` },
    });
    expect(listBRes.status).toBe(200);
    const listB = (await listBRes.json()) as {
      now: string;
      pulses: Array<{ actorId: string; realmPath: string; sessionId: string }>;
    };
    expect(listB.now).toBeTruthy();
    expect(listB.pulses.some((p) => p.actorId === "agent-a")).toBe(false);

    // 1c. Mounted realm under hidden ancestor /secret-parent/shared-leaf MUST appear as @mounted/shared-leaf (zero ancestor leak!)
    const leafPulse = await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokLeaf.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ note: "Working in shared leaf" }),
    });
    expect(leafPulse.status).toBe(200);

    const listB2 = (await (
      await fetch(`${srv.url}/v1/pulse`, {
        headers: { Authorization: `Bearer ${tokB.token}` },
      })
    ).json()) as {
      pulses: Array<{ actorId: string; realmPath: string; sessionId: string }>;
    };
    const leafRow = listB2.pulses.find((p) => p.actorId === "agent-leaf");
    expect(leafRow).toBeDefined();
    expect(leafRow!.realmPath).toBe("@mounted/shared-leaf");
    expect(JSON.stringify(listB2)).not.toContain("secret-parent");
    expect(JSON.stringify(listB2)).not.toContain("tok_");

    await surfA.close();
    await admin.close();
  });

  it("2. Cross-principal sessionId isolation, opaque salted IDs (no tok_ leak), idempotent DELETE /v1/pulse, and DoS limits", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v054-pulse-sec-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const tokA = srv.createToken({ actorId: "alice", actorKind: "human" });
    const tokB = srv.createToken({ actorId: "bob", actorKind: "agent" });

    // Alice declares pulse with custom sessionId "shared-tag"
    const resA = await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokA.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: "shared-tag", note: "Alice live" }),
    });
    expect(resA.status).toBe(200);
    const pulseA = (await resA.json()) as { sessionId: string };
    expect(pulseA.sessionId).toMatch(/^ps_[0-9a-f]{16}$/);
    expect(pulseA.sessionId).not.toContain("tok_");
    expect(pulseA.sessionId).not.toContain("alice");

    // Bob sends the exact same sessionId AND Alice's external sessionId -> MUST NOT overwrite Alice!
    await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokB.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: "shared-tag", note: "Bob live" }),
    });
    await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokB.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: pulseA.sessionId, note: "Bob hijack try" }),
    });

    const list1 = (await (
      await fetch(`${srv.url}/v1/pulse`, {
        headers: { Authorization: `Bearer ${tokA.token}` },
      })
    ).json()) as { pulses: Array<{ actorId: string; note: string | null }> };
    expect(list1.pulses.find((p) => p.actorId === "alice")?.note).toBe("Alice live");

    // Bob DELETEs "shared-tag" -> removes ONLY Bob's row, Alice's row stays intact; second DELETE is idempotent!
    const del1 = await fetch(`${srv.url}/v1/pulse`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${tokB.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: "shared-tag" }),
    });
    expect(del1.status).toBe(200);
    expect(await del1.json()).toEqual({ ok: true });

    const del2 = await fetch(`${srv.url}/v1/pulse`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${tokB.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: "nonexistent-session" }),
    });
    expect(del2.status).toBe(200);
    expect(await del2.json()).toEqual({ ok: true });

    const listAfterDel = (await (
      await fetch(`${srv.url}/v1/pulse`, {
        headers: { Authorization: `Bearer ${tokA.token}` },
      })
    ).json()) as { pulses: Array<{ actorId: string }> };
    expect(listAfterDel.pulses.some((p) => p.actorId === "alice")).toBe(true);

    // DoS bounds: oversize sessionId & oversize focus item rejected; per-principal cap evicts oldest
    const tooLongSess = await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokB.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId: "s".repeat(MAX_SESSION_TAG_CHARS + 1) }),
    });
    expect(tooLongSess.status).toBe(400);

    const tooLongFocus = await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokB.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ focus: ["f".repeat(MAX_FOCUS_ITEM_CHARS + 1)] }),
    });
    expect(tooLongFocus.status).toBe(400);

    for (let i = 0; i < MAX_SESSIONS_PER_PRINCIPAL + 5; i += 1) {
      const r = await fetch(`${srv.url}/v1/pulse`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokB.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId: `cap-${i}` }),
      });
      expect(r.status).toBe(200);
    }
    const listCap = (await (
      await fetch(`${srv.url}/v1/pulse`, {
        headers: { Authorization: `Bearer ${tokA.token}` },
      })
    ).json()) as { pulses: Array<{ actorId: string }> };
    const bobCount = listCap.pulses.filter((p) => p.actorId === "bob").length;
    expect(bobCount).toBeLessThanOrEqual(MAX_SESSIONS_PER_PRINCIPAL);
  });

  it("3. Unified withLivePulse via /mcp & REST: passive agent observation, show <realm> activePeers, stateless /mcp collisionHints, and Invariant #2 (write never calls listVisible)", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v054-mcp-pulse-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    const admin = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: adminTok.token,
    });
    await admin.createRealm({
      parentRef: "/",
      slug: "ops",
      name: "Operations",
      scope: "Include: ops. Exclude: product.",
    });

    const botATok = await admin.createToken({ actorId: "bot-claude", actorKind: "agent" });
    const botBTok = await admin.createToken({ actorId: "bot-codex", actorKind: "agent" });

    // Bot A works over stateless /mcp -> mind_show /ops registers passive observation!
    const mcpShowA = await mcpCall({
      url: srv.url,
      token: botATok.token,
      method: "tools/call",
      id: 1,
      toolName: "mind_show",
      toolArgs: { ref: "/ops" },
      headers: {
        "X-Meru-Session-Id": "claude-term-1",
        "X-Meru-Client": "claude-code",
      },
    });
    expect(mcpShowA.status).toBe(200);

    // Bot B calls mind_show /ops over /mcp -> sees Bot A in activePeers!
    const mcpShowB = await mcpCall({
      url: srv.url,
      token: botBTok.token,
      method: "tools/call",
      id: 2,
      toolName: "mind_show",
      toolArgs: { ref: "/ops" },
      headers: {
        "X-Meru-Session-Id": "codex-term-1",
        "X-Meru-Client": "codex",
      },
    });
    expect(mcpShowB.status).toBe(200);
    const showBData = parseMcpToolJson<{
      refType: string;
      activePeers?: Array<{ actorId: string; actorKind: string; clientHint: string | null }>;
    }>(mcpShowB.body);
    expect(showBData.refType).toBe("realm");
    expect(showBData.activePeers?.length).toBe(1);
    expect(showBData.activePeers![0]!.actorId).toBe("bot-claude");
    expect(showBData.activePeers![0]!.actorKind).toBe("agent");
    expect(showBData.activePeers![0]!.clientHint).toBe("claude-code");

    // Invariant #2 check: spy on pulseStore.listVisible during stateless /mcp writes -> MUST be called 0 times!
    const listSpy = vi.spyOn(srv.pulseStore, "listVisible");
    const listWithNowSpy = vi.spyOn(srv.pulseStore, "listVisibleWithNow");

    const writeA = await mcpCall({
      url: srv.url,
      token: botATok.token,
      method: "tools/call",
      id: 3,
      toolName: "mind_write",
      toolArgs: {
        in: "/ops",
        kind: "finding",
        title: "MCP Write A",
        body: "First concurrent update via stateless MCP.",
      },
    });
    const writeAData = parseMcpToolJson<{ id: string }>(writeA.body);

    const writeB = await mcpCall({
      url: srv.url,
      token: botBTok.token,
      method: "tools/call",
      id: 4,
      toolName: "mind_write",
      toolArgs: {
        in: "/ops",
        kind: "finding",
        title: "MCP Write B",
        body: "Second concurrent update via stateless MCP.",
      },
    });
    const writeBData = parseMcpToolJson<{
      id: string;
      collisionHints?: Array<{ entityId: string; actorId: string }>;
    }>(writeB.body);

    // Stateless /mcp write B MUST receive collisionHints referencing Bot A's write!
    expect(writeBData.collisionHints?.some((h) => h.entityId === writeAData.id)).toBe(
      true,
    );
    // Invariant #2 strictly enforced: write path NEVER reads MindPulse!
    expect(listSpy).not.toHaveBeenCalled();
    expect(listWithNowSpy).not.toHaveBeenCalled();

    await admin.close();
  });

  it("4. Token touchLastUsed throttle: pulse heartbeats perform ZERO SQLite touches, and repeated Bearer calls throttle to once per 60s", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v054-touch-throttle-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const tok = srv.createToken({ actorId: "heartbeat-bot", actorKind: "agent" });
    const touchSpy = vi.spyOn(srv.engine.db, "touchTokenLastUsed");

    // 5 consecutive pulse heartbeats + list + delete -> ZERO SQLite last_used_at writes!
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${srv.url}/v1/pulse`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ note: `tick ${i}` }),
      });
      expect(r.status).toBe(200);
    }
    await fetch(`${srv.url}/v1/pulse`, {
      headers: { Authorization: `Bearer ${tok.token}` },
    });
    await fetch(`${srv.url}/v1/pulse`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${tok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(touchSpy).toHaveBeenCalledTimes(0);

    // 5 rapid /v1/whoami calls -> touches SQLite at most ONCE within the 60s window!
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${srv.url}/v1/whoami`, {
        headers: { Authorization: `Bearer ${tok.token}` },
      });
      expect(r.status).toBe(200);
    }
    expect(touchSpy).toHaveBeenCalledTimes(1);
  });
});
