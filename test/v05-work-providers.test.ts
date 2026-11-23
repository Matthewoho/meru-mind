import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_DIST = path.resolve("dist/cli.js");
import {
  createMindEngine,
  DeliveryRetryWorker,
  GitHubWorkProvider,
  LinearWorkProvider,
  LocalMindSurface,
  RemoteMindSurface,
  startMindServer,
  validateWorkBindingConfig,
  WorkProviderRegistry,
  type MindEngine,
  type MindServerHandle,
  type WorkItemSnapshot,
  type WorkProvider,
  type WorkRef,
} from "../src/index.js";

const tempDirs: string[] = [];
const openEngines: MindEngine[] = [];
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
  while (openEngines.length > 0) {
    await openEngines.pop()!.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/**
 * Reusable WorkProvider Contract Test Suite:
 * Every official provider (Linear & GitHub) MUST pass the exact same invariants.
 */
async function runWorkProviderContract(fixture: {
  provider: WorkProvider;
  binding: Record<string, unknown>;
  validRef: WorkRef;
  validKey: string;
  validUrl: string;
  outOfScopeRef: WorkRef;
  goneRef: WorkRef;
  getPostedComments: () => string[];
}) {
  const { provider, binding } = fixture;
  const ctx = {
    principalId: "alice",
    realmId: "realm_1",
    deadlineMs: Date.now() + 5000,
  };

  // 1. Pure offline parseLocator across WorkRef, display key, URL, and invalid input
  expect(provider.parseLocator(fixture.validRef)?.provider).toBe(provider.id);
  expect(provider.parseLocator(fixture.validKey)?.provider).toBe(provider.id);
  expect(provider.parseLocator(fixture.validUrl)?.provider).toBe(provider.id);
  expect(provider.parseLocator("not-a-valid-work-locator-xyz")).toBeNull();

  // 2. Scoped resolve: valid -> WorkItemSnapshot(fetchedAt), outOfScope -> { outOfScope: true }, gone -> { gone: true }
  const outcomes = await provider.resolve(
    [fixture.validRef, fixture.outOfScopeRef, fixture.goneRef],
    binding,
    ctx,
  );
  expect(outcomes).toHaveLength(3);
  const first = outcomes[0] as WorkItemSnapshot;
  expect(first.ref).toBe(fixture.validRef);
  expect(first.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(["triage", "backlog", "unstarted", "started", "completed", "canceled"]).toContain(
    first.statusType,
  );
  expect(outcomes[1]).toEqual({ input: fixture.outOfScopeRef, outOfScope: true });
  expect(outcomes[2]).toEqual({ input: fixture.goneRef, gone: true });

  // 3. listReady returns unblocked items only
  const ready = await provider.listReady(binding, { limit: 10 }, ctx);
  expect(ready.items.length).toBeGreaterThanOrEqual(1);
  expect(ready.items.every((i) => !i.title.includes("BLOCKED_TASK"))).toBe(true);

  // 4. Idempotent annotate: title + backlink ONLY by default; duplicate call returns same externalId
  expect(provider.capabilities.annotate).toBe(true);
  const note = {
    idempotencyKey: `idem-${provider.id}-001`,
    title: "Architecture decision linked",
    backlink: "https://mind.example.com/show/rec_123",
  };
  const ann1 = await provider.annotate!(fixture.validRef, note, binding, ctx);
  const ann2 = await provider.annotate!(fixture.validRef, note, binding, ctx);
  expect(ann1.externalId).toBe(ann2.externalId);
  expect(fixture.getPostedComments()).toHaveLength(1);
  expect(fixture.getPostedComments()[0]).toContain(note.title);
  expect(fixture.getPostedComments()[0]).toContain(note.backlink);

  // Out-of-scope annotate MUST be rejected
  await expect(
    provider.annotate!(fixture.outOfScopeRef, note, binding, ctx),
  ).rejects.toThrow(/outside/i);
}

describe("v0.5 WorkProvider SSOT Contract, Official Linear & GitHub Providers, Circuit Breaker & Deliveries Worker", () => {
  it("1. Official LinearWorkProvider & GitHubWorkProvider BOTH pass the identical reusable WorkProvider contract suite", async () => {
    // --- Mock Linear GraphQL server (in-memory fetchImpl) ---
    const linearComments: Array<{ id: string; body: string }> = [];
    const linearFetch: typeof fetch = async (_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body ?? "{}")) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (query.includes("query ResolveIssue") || query.includes("query CheckAnnotate")) {
        const id = String(variables.id);
        if (id === "uuid-eng-101") {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  id: "uuid-eng-101",
                  identifier: "ENG-101",
                  title: "Ship v0.5 WorkProvider",
                  url: "https://linear.app/acme/issue/ENG-101",
                  trashed: false,
                  team: { id: "team-eng", key: "ENG" },
                  state: { name: "Todo", type: "unstarted" },
                  assignee: { id: "u1", name: "Alice" },
                  comments: { nodes: linearComments },
                },
              },
            }),
            { status: 200 },
          );
        }
        if (id === "uuid-sec-999") {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  id: "uuid-sec-999",
                  identifier: "SEC-999",
                  title: "Private security team issue",
                  url: "https://linear.app/acme/issue/SEC-999",
                  trashed: false,
                  team: { id: "team-sec", key: "SEC" },
                  state: { name: "In Progress", type: "started" },
                  comments: { nodes: [] },
                },
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: { issue: null } }), { status: 200 });
      }
      if (query.includes("query ListReadyIssues")) {
        return new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: "uuid-eng-101",
                    identifier: "ENG-101",
                    title: "Ship v0.5 WorkProvider",
                    url: "https://linear.app/acme/issue/ENG-101",
                    trashed: false,
                    team: { id: "team-eng", key: "ENG" },
                    state: { name: "Todo", type: "unstarted" },
                    relations: { nodes: [] },
                  },
                  {
                    id: "uuid-eng-102",
                    identifier: "ENG-102",
                    title: "BLOCKED_TASK waiting on DB",
                    url: "https://linear.app/acme/issue/ENG-102",
                    trashed: false,
                    team: { id: "team-eng", key: "ENG" },
                    state: { name: "Todo", type: "unstarted" },
                    relations: {
                      nodes: [
                        { type: "blocked_by", relatedIssue: { state: { type: "started" } } },
                      ],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200 },
        );
      }
      if (query.includes("mutation CreateComment")) {
        const id = `lin_cmt_${linearComments.length + 1}`;
        linearComments.push({ id, body: String(variables.body) });
        return new Response(
          JSON.stringify({ data: { commentCreate: { success: true, comment: { id } } } }),
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 500 });
    };

    const linearProvider = new LinearWorkProvider({
      fetchImpl: linearFetch,
      env: { TEST_LINEAR_KEY: "test-linear-secret-runtime-only" },
    });

    await runWorkProviderContract({
      provider: linearProvider,
      binding: { apiKeyRef: "env:TEST_LINEAR_KEY", teamKey: "ENG" },
      validRef: "work:linear:uuid-eng-101",
      validKey: "ENG-101",
      validUrl: "https://linear.app/acme/issue/ENG-101/ship-v05",
      outOfScopeRef: "work:linear:uuid-sec-999",
      goneRef: "work:linear:uuid-missing-404",
      getPostedComments: () => linearComments.map((c) => c.body),
    });

    // --- Mock GitHub REST API (in-memory fetchImpl) ---
    const ghComments: Array<{ id: number; body: string }> = [];
    const ghFetch: typeof fetch = async (url, init) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.endsWith("/repos/acme/app/issues/42") && method === "GET") {
        return new Response(
          JSON.stringify({
            number: 42,
            title: "Ship GitHub WorkProvider",
            state: "open",
            html_url: "https://github.com/acme/app/issues/42",
            labels: [{ name: "ready" }],
            assignee: { id: 7, login: "bob" },
          }),
          { status: 200 },
        );
      }
      if (u.endsWith("/repos/acme/app/issues/999") && method === "GET") {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      if (u.includes("/repos/acme/app/issues?state=open") && method === "GET") {
        return new Response(
          JSON.stringify([
            {
              number: 42,
              title: "Ship GitHub WorkProvider",
              state: "open",
              html_url: "https://github.com/acme/app/issues/42",
              labels: [],
            },
            {
              number: 43,
              title: "BLOCKED_TASK waiting on vendor",
              state: "open",
              html_url: "https://github.com/acme/app/issues/43",
              labels: [{ name: "blocked" }],
            },
          ]),
          { status: 200 },
        );
      }
      if (u.includes("/repos/acme/app/issues/42/comments") && method === "GET") {
        return new Response(JSON.stringify(ghComments), { status: 200 });
      }
      if (u.endsWith("/repos/acme/app/issues/42/comments") && method === "POST") {
        const bodyObj = JSON.parse(String(init?.body ?? "{}")) as { body: string };
        const id = 500 + ghComments.length + 1;
        ghComments.push({ id, body: bodyObj.body });
        return new Response(JSON.stringify({ id }), { status: 201 });
      }
      return new Response("Not Found", { status: 404 });
    };

    const ghProvider = new GitHubWorkProvider({
      fetchImpl: ghFetch,
      env: { TEST_GH_TOKEN: "test-gh-secret-runtime-only" },
    });

    await runWorkProviderContract({
      provider: ghProvider,
      binding: { tokenRef: "env:TEST_GH_TOKEN", owner: "acme", repo: "app" },
      validRef: "work:github:acme/app#42",
      validKey: "acme/app#42",
      validUrl: "https://github.com/acme/app/issues/42",
      outOfScopeRef: "work:github:otherorg/private#1",
      goneRef: "work:github:acme/app#999",
      getPostedComments: () => ghComments.map((c) => c.body),
    });
  });

  it("2. work_bindings blocks plaintext secrets, inherits along realm subtree, degrades cleanly with circuit breaker, and keeps MCP strictly at 7 tools", async () => {
    // Plaintext secret in work_bindings.config_json MUST be rejected
    const fakeLinearKey = ["lin", "api", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    expect(() => validateWorkBindingConfig({ apiKeyRef: fakeLinearKey })).toThrow(
      /plaintext credential/i,
    );
    expect(() => validateWorkBindingConfig({ apiKey: "raw-unprefixed-key" })).toThrow(
      /env:VAR_NAME/i,
    );
    expect(() =>
      validateWorkBindingConfig({ apiKeyRef: "env:LINEAR_API_KEY", teamKey: "ENG" }),
    ).not.toThrow();

    // Failing provider to test graceful degradation + circuit breaker short-circuit
    let fetchCalls = 0;
    const flakyReg = new WorkProviderRegistry({
      failureThreshold: 3,
      cooldownMs: 60_000,
    });
    flakyReg.register(
      new LinearWorkProvider({
        env: { TEST_FLAKY_KEY: "runtime-key" },
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error("upstream 503 outage");
        },
      }),
    );

    const homeDir = makeTempDir("meru-v05-srv-");
    const srv = await startMindServer({
      homeDir,
      port: 0,
      enableVector: false,
      accessLog: false,
      workRegistry: flakyReg,
    });
    openServers.push(srv);

    const humanTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    const agentTok = srv.createToken({ actorId: "bot", actorKind: "agent" });
    const admin = await RemoteMindSurface.connect({ baseUrl: srv.url, token: humanTok.token });
    const bot = await RemoteMindSurface.connect({ baseUrl: srv.url, token: agentTok.token });

    const eng = await admin.createRealm({ parentRef: "/", slug: "eng", name: "Eng" });
    const sub = await admin.createRealm({ parentRef: eng.path, slug: "api", name: "API" });

    // Agent cannot bind work providers; human binds on /eng
    await expect(
      bot.bindWork({
        realmRef: eng.path,
        provider: "linear",
        config: { apiKeyRef: "env:TEST_FLAKY_KEY", teamKey: "ENG" },
      }),
    ).rejects.toThrow(/human/i);

    await admin.bindWork({
      realmRef: eng.path,
      provider: "linear",
      config: { apiKeyRef: "env:TEST_FLAKY_KEY", teamKey: "ENG" },
    });

    // Subtree inheritance: /eng/api inherits /eng's Linear binding and degrades cleanly to "status unavailable"
    for (let i = 0; i < 3; i += 1) {
      const degraded = await bot.listReadyWork({ realmRef: sub.path });
      expect(degraded.unavailable).toBe(true);
      if (degraded.unavailable) {
        expect(degraded.reason).toContain("status unavailable");
      }
    }
    expect(fetchCalls).toBe(3);

    // 4th call hits OPEN circuit breaker immediately (0 additional fetch calls!)
    const openBreaker = await bot.listReadyWork({ realmRef: sub.path });
    expect(openBreaker.unavailable).toBe(true);
    if (openBreaker.unavailable) {
      expect(openBreaker.reason).toContain("circuit breaker open");
    }
    expect(fetchCalls).toBe(3);

    // Core writes STILL succeed seamlessly while external provider is down!
    const coreWrite = await bot.write({
      in: sub.path,
      kind: "finding",
      title: "Core memory unaffected by Linear outage",
      body: "Single source of truth architecture isolates provider failures.",
    });
    expect(coreWrite.record.id).toMatch(/^rec_/);

    // Verify MCP Streamable HTTP STILL exposes STRICTLY 7 tools (zero task tools!)
    const mcpRes = await fetch(`${srv.url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentTok.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await mcpRes.text();
    const dataLine = text.split(/\r?\n/).find((l) => l.startsWith("data: "));
    const mcpJson = JSON.parse(dataLine ? dataLine.slice(6) : text) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(mcpJson.result.tools).toHaveLength(7);
  });

  it("3. Outbox DeliveryRetryWorker retries transient errors with exponential backoff, advances consumer_cursors, and dead-letters exhausted rows", async () => {
    const homeDir = makeTempDir("meru-v05-deliv-");
    const engine = await createMindEngine({ homeDir, enableVector: false });
    openEngines.push(engine);

    let flakyAttempts = 0;
    const worker = new DeliveryRetryWorker(engine.db, {
      consumer: "work-linear-annotate",
      maxAttempts: 3,
      baseBackoffMs: 1000,
      handler: async (deliv) => {
        if (deliv.seq === 101) {
          flakyAttempts += 1;
          if (flakyAttempts < 2) throw new Error("transient 502");
          return;
        }
        if (deliv.seq === 102) {
          throw new Error("permanent 400 bad payload");
        }
      },
    });

    const t0 = new Date("2026-11-24T00:00:00.000Z");
    expect(worker.enqueue(101, t0)).toBe(true);
    expect(worker.enqueue(101, t0)).toBe(false); // Idempotent PK (consumer, seq)
    expect(worker.enqueue(102, t0)).toBe(true);

    // Attempt 1 at t0: both fail and schedule retry at t0 + 1000ms
    const r1 = await worker.drainDue({ now: t0 });
    expect(r1).toEqual({ processed: 2, succeeded: 0, retried: 2, dead: 0 });

    // Before backoff elapses (t0 + 500ms): 0 due
    const rEarly = await worker.drainDue({ now: new Date(t0.getTime() + 500) });
    expect(rEarly.processed).toBe(0);

    // Attempt 2 at t0 + 1500ms: seq 101 succeeds (advances consumer_cursor to 101), seq 102 retries (+2000ms)
    const r2 = await worker.drainDue({ now: new Date(t0.getTime() + 1500) });
    expect(r2).toEqual({ processed: 2, succeeded: 1, retried: 1, dead: 0 });
    expect(engine.db.getConsumerCursor("work-linear-annotate")?.seq).toBe(101);

    // Attempt 3 at t0 + 5000ms: seq 102 exhausts maxAttempts=3 -> transitions to dead
    const r3 = await worker.drainDue({ now: new Date(t0.getTime() + 5000) });
    expect(r3).toEqual({ processed: 1, succeeded: 0, retried: 0, dead: 1 });

    // Subsequent drains skip dead rows cleanly
    const r4 = await worker.drainDue({ now: new Date(t0.getTime() + 60000) });
    expect(r4.processed).toBe(0);

    // Verify weakened Cookie surface blocks bindWork
    const { org, rootRealm } = engine.ledger.createOrg({ name: "CookieCheck", policy: "open" });
    const cookieSurf = new LocalMindSurface({
      engine,
      principal: {
        tokenId: null,
        orgId: org.id,
        actor: { id: "alice", kind: "human" },
        boundRealmId: rootRealm.id,
        boundSource: "cookie",
        authKind: "cookie",
      },
    });
    await expect(
      cookieSurf.bindWork({
        realmRef: "/",
        provider: "linear",
        config: { apiKeyRef: "env:LINEAR_API_KEY" },
      }),
    ).rejects.toThrow(/browser Cookie session/i);
  });

  it("4. CLI work bind/list/unbind works locally (--as-human) and remotely (--url/--token) while rejecting plaintext secrets", async () => {
    const homeDir = makeTempDir("meru-v05-cli-");
    const runCli = async (args: string[], env: Record<string, string> = {}) =>
      execFileAsync(process.execPath, [CLI_DIST, ...args], {
        env: { ...process.env, ...env },
      });

    // Local init + work bind/list/unbind
    await runCli(["admin", "init", "--home", homeDir, "--org", "CliWork", "--policy", "open"]);
    const bindLocal = await runCli([
      "work",
      "bind",
      "--home",
      homeDir,
      "--in",
      "/",
      "--provider",
      "github",
      "--repo",
      "acme/api",
      "--token-env",
      "GITHUB_TOKEN",
      "--as-human",
      "--json",
    ]);
    const boundObj = JSON.parse(bindLocal.stdout) as { provider: string; config: Record<string, unknown> };
    expect(boundObj.provider).toBe("github");
    expect(boundObj.config.owner).toBe("acme");
    expect(boundObj.config.repo).toBe("api");
    expect(boundObj.config.tokenRef).toBe("env:GITHUB_TOKEN");

    // Plaintext secret rejected via CLI
    const fakeSecret = ["ghp", "1234567890abcdefghijklmnopqrstuvwxyz"].join("_");
    await expect(
      runCli([
        "work",
        "bind",
        "--home",
        homeDir,
        "--in",
        "/",
        "--provider",
        "github",
        "--config",
        JSON.stringify({ tokenRef: fakeSecret }),
        "--as-human",
      ]),
    ).rejects.toThrow();

    // Remote CLI against live server
    const srv = await startMindServer({
      homeDir,
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);
    const adminTok = srv.createToken({ actorId: "admin", actorKind: "human" });

    const listRemote = await runCli(["work", "list", "--url", srv.url, "--token", adminTok.token, "--json"]);
    const bindings = JSON.parse(listRemote.stdout) as Array<{ provider: string }>;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.provider).toBe("github");

    const unbindRemote = await runCli([
      "work",
      "unbind",
      "--in",
      "/",
      "--url",
      srv.url,
      "--token",
      adminTok.token,
      "--json",
    ]);
    expect(JSON.parse(unbindRemote.stdout)).toMatchObject({ realmRef: "/", unbound: true });
  });
});
