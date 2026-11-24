import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMindEngine,
  DEFAULT_ROOT_REALM_SCOPE,
  OPAQUE_ENTRY_NOT_FOUND,
  RemoteMindSurface,
  runRealmDoctor,
  startMindServer,
  type MindServerHandle,
} from "../src/index.js";

const CLI_PATH = path.resolve("dist/cli.js");
const tempDirs: string[] = [];
const openServers: MindServerHandle[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runCli(
  args: string[],
  opts: {
    env?: Record<string, string>;
    cwd?: string;
    input?: string;
    expectFail?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const status = code ?? 1;
      if (status !== 0 && !opts.expectFail) {
        reject(
          new Error(
            `CLI failed (${status}): ${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, status });
    });
    if (opts.input !== undefined) {
      child.stdin.write(opts.input, "utf8");
    }
    child.stdin.end();
  });
}

function httpGetNoRedirect(
  urlStr: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(urlStr, { headers }, (res) => {
      res.resume();
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers }),
      );
    });
    req.on("error", reject);
  });
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.close().catch(() => {});
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v0.5.3 The Realm Method, Tree-Mode Security Fixes, Import Routing & Doctor", () => {
  it("1. Tree-mode security: blocks cross-sibling move pulls, ancestor/mounted pulls, invisible actualRealmId CAS leaks, and ancestor realm mutations", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v053-tree-sec-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const rootAdminTok = srv.createToken({
      actorId: "root-admin",
      actorKind: "human",
    });
    const rootSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: rootAdminTok.token,
    });

    await rootSurf.createRealm({
      parentRef: "/",
      slug: "eng",
      name: "Engineering",
      scope: "Include: engineering. Exclude: finance.",
    });
    await rootSurf.createRealm({
      parentRef: "/eng",
      slug: "billing",
      name: "Billing",
      scope: "Include: billing services. Exclude: payroll.",
    });
    await rootSurf.createRealm({
      parentRef: "/",
      slug: "finance",
      name: "Finance",
      scope: "Include: finance & payroll. Exclude: engineering.",
    });

    const financeRec = await rootSurf.write({
      in: "/finance",
      kind: "finding",
      title: "Secret payroll variance",
      body: "Confidential finance branch record.",
    });
    const engAncestorRec = await rootSurf.write({
      in: "/eng",
      kind: "decision",
      title: "Engineering ancestor decision",
      body: "Owned by /eng, read-only to /eng/billing.",
    });
    const billingRec = await rootSurf.write({
      in: "/eng/billing",
      kind: "finding",
      title: "Billing retry timeout",
      body: "Owned by /eng/billing.",
    });

    // Switch org policy to strict tree mode before testing sub-realm isolation
    await rootSurf.setOrgPolicy({ policy: "tree" });

    const billingHumanTok = await rootSurf.createToken({
      actorId: "billing-lead",
      actorKind: "human",
      boundRealmRef: "/eng/billing",
    });
    const billingSurf = await RemoteMindSurface.connect({
      baseUrl: srv.url,
      token: billingHumanTok.token,
    });

    // 1a. Cross-sibling move MUST fail with opaque NOT_FOUND (same error as nonexistent ID!)
    const siblingResp = await fetch(`${srv.url}/v1/move`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${billingHumanTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entryIds: [financeRec.record.id],
        targetRealmRef: "/eng/billing",
      }),
    });
    expect(siblingResp.status).toBe(404);
    const siblingBody = (await siblingResp.json()) as { message: string };
    expect(siblingBody.message).toBe(OPAQUE_ENTRY_NOT_FOUND);

    const bogusResp = await fetch(`${srv.url}/v1/move`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${billingHumanTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entryIds: ["rec_nonexistent000000"],
        targetRealmRef: "/eng/billing",
      }),
    });
    expect(bogusResp.status).toBe(404);
    expect(((await bogusResp.json()) as { message: string }).message).toBe(
      OPAQUE_ENTRY_NOT_FOUND,
    );

    // 1b. CAS expectedFromRealmRef against invisible sibling MUST return opaque 404, NEVER leak actualRealmId!
    const casProbe = await fetch(`${srv.url}/v1/move`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${billingHumanTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entryIds: [financeRec.record.id],
        expectedFromRealmRef: "/eng/billing",
        targetRealmRef: "/eng/billing",
      }),
    });
    expect(casProbe.status).toBe(404);
    const casProbeText = await casProbe.text();
    expect(casProbeText).not.toContain(financeRec.record.realmId);
    expect(casProbeText).not.toContain("actualRealmId");

    // 1c. Pulling ancestor entry DOWN into /eng/billing MUST return 403 ACCESS_DENIED
    await expect(
      billingSurf.move({
        entryIds: [engAncestorRec.record.id],
        targetRealmRef: "/eng/billing",
      }),
    ).rejects.toThrow(/read-only|outside bound subtree/i);

    // 1d. Pushing own entry UP into ancestor /eng MUST return 403 ACCESS_DENIED
    await expect(
      billingSurf.move({
        entryIds: [billingRec.record.id],
        targetRealmRef: "/eng",
      }),
    ).rejects.toThrow(/outside your bound subtree/i);

    // 1e. Sub-realm human token MUST NOT mutate, archive, or create under ancestor /eng or /
    await expect(billingSurf.archiveRealm({ ref: "/eng" })).rejects.toThrow(
      /outside your bound subtree/i,
    );
    await expect(
      billingSurf.updateRealm({ ref: "/", scope: "Hijacked root scope" }),
    ).rejects.toThrow(/outside your bound subtree/i);
    await expect(
      billingSurf.createRealm({
        parentRef: "/eng",
        slug: "rogue",
        name: "Rogue",
        scope: "Include: rogue. Exclude: none.",
      }),
    ).rejects.toThrow(/outside your bound subtree/i);

    // 1f. Sub-realm human token CAN create/update/archive inside its OWN bound subtree (/eng/billing/*)
    const subChild = await billingSurf.createRealm({
      parentRef: "/eng/billing",
      slug: "invoices",
      name: "Invoices",
      scope: "Include: invoice generation. Exclude: tax filings.",
    });
    expect(subChild.path).toBe("/eng/billing/invoices");
    const updatedChild = await billingSurf.updateRealm({
      ref: "/eng/billing/invoices",
      scope: "Include: invoice PDFs and retries. Exclude: payroll.",
    });
    expect(updatedChild.scope).toBe(
      "Include: invoice PDFs and retries. Exclude: payroll.",
    );

    await billingSurf.close();
    await rootSurf.close();
  });

  it("2. Remote realm set blocks Cookie/agent, remote realm create enforces --scope, and createOrg sets default root constitution scope", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v053-remote-realm-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    // Default root constitution scope is policy-agnostic and non-empty
    const rootRealm = srv.engine.db.getRealmByPath(srv.orgId, "/")!;
    expect(rootRealm.scope).toBe(DEFAULT_ROOT_REALM_SCOPE);
    expect(rootRealm.scope).not.toContain("--in");

    const humanTok = srv.createToken({ actorId: "admin", actorKind: "human" });
    const agentTok = srv.createToken({ actorId: "bot", actorKind: "agent" });

    // Remote CLI realm create WITHOUT --scope MUST fail
    const missingScope = await runCli(
      ["realm", "create", "--parent", "/", "--slug", "ops", "--name", "Ops"],
      {
        env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: humanTok.token },
        expectFail: true,
      },
    );
    expect(missingScope.status).not.toBe(0);
    expect(missingScope.stderr).toMatch(/--scope/i);

    // Remote CLI realm create WITH --scope succeeds
    const createdOut = await runCli(
      [
        "realm",
        "create",
        "--parent",
        "/",
        "--slug",
        "ops",
        "--name",
        "Operations",
        "--scope",
        "Include: infra & releases. Exclude: product specs.",
        "--json",
      ],
      { env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: humanTok.token } },
    );
    expect(JSON.parse(createdOut.stdout).path).toBe("/ops");

    // Remote CLI realm set updates scope cleanly
    const updatedOut = await runCli(
      [
        "realm",
        "set",
        "/ops",
        "--scope",
        "Include: prod infra, rollbacks. Exclude: UI.",
        "--json",
      ],
      { env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: humanTok.token } },
    );
    expect(JSON.parse(updatedOut.stdout).scope).toBe(
      "Include: prod infra, rollbacks. Exclude: UI.",
    );

    // Agent Bearer CANNOT call POST /v1/realms/set
    const agentSet = await fetch(`${srv.url}/v1/realms/set`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentTok.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "/ops", scope: "Agent hijack" }),
    });
    expect(agentSet.status).toBe(403);

    // Weakened browser Cookie CANNOT call POST /v1/realms/set
    const mint = await fetch(`${srv.url}/v1/ui/login-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${humanTok.token}` },
    });
    const { path: authPath } = (await mint.json()) as { path: string };
    const authRes = await httpGetNoRedirect(`${srv.url}${authPath}`, {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    const rawCookie = authRes.headers["set-cookie"];
    const cookiePair = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie ?? "").split(";")[0]!;
    const cookieSet = await fetch(`${srv.url}/v1/realms/set`, {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "/ops", scope: "Cookie hijack" }),
    });
    expect(cookieSet.status).toBe(403);
  });

  it("3. Unified import routing (inbox fallback instead of root /), zero-write --dry-run preview (no lazy /inbox), and batch entry move --ids-file --from", async () => {
    const homeDir = makeTempDir("meru-v053-import-home-");
    const docsDir = makeTempDir("meru-v053-import-docs-");
    const wsDir = makeTempDir("meru-v053-ws-");

    await runCli(["admin", "init", "--org", "CleanOrg", "--policy", "open"], {
      env: { MERU_MIND_HOME: homeDir },
    });
    await runCli(
      [
        "realm",
        "create",
        "--parent",
        "/",
        "--slug",
        "ops",
        "--name",
        "Operations",
        "--scope",
        "Include: ops. Exclude: product.",
        "--as-human",
      ],
      { env: { MERU_MIND_HOME: homeDir } },
    );

    fs.writeFileSync(
      path.join(docsDir, "note1.md"),
      "---\ntitle: Unassigned Note 1\n---\nBody one.",
      "utf8",
    );
    fs.writeFileSync(
      path.join(docsDir, "note2.md"),
      "---\ntitle: Ops Mapped Note\nrealm_tag: infra\n---\nBody two.",
      "utf8",
    );
    fs.writeFileSync(
      path.join(docsDir, "note3.md"),
      "---\ntitle: Unknown Tag Note\nrealm_tag: ghost_team\n---\nBody three.",
      "utf8",
    );

    const mapFile = path.join(docsDir, "map.json");
    fs.writeFileSync(
      mapFile,
      JSON.stringify({
        realmPath: "realm_tag",
        realmMap: { infra: "/ops" },
      }),
      "utf8",
    );

    // 3a. import md --dry-run MUST NOT write SQLite AND MUST NOT lazily create /inbox,
    // while reporting exact planned distribution and unresolved realm values!
    const dryBad = await runCli(
      ["import", "md", docsDir, "--map", mapFile, "--dry-run", "--json"],
      {
        env: { MERU_MIND_HOME: homeDir },
        cwd: wsDir,
        expectFail: true,
      },
    );
    expect(dryBad.status).toBe(1);
    const dryBadJson = JSON.parse(dryBad.stdout) as {
      valid: boolean;
      plannedDefaultRealm: string;
      realmDistribution: Record<string, number>;
      unmatchedRealmValues: Record<string, number>;
      unresolvedRealms: Array<{ rawValue: string; targetRef: string; count: number }>;
    };
    expect(dryBadJson.valid).toBe(false);
    expect(dryBadJson.plannedDefaultRealm).toBe("/inbox");
    expect(dryBadJson.realmDistribution["/ops"]).toBe(1);
    expect(dryBadJson.realmDistribution["/inbox"]).toBe(1);
    expect(dryBadJson.unmatchedRealmValues["ghost_team"]).toBe(1);
    expect(dryBadJson.unresolvedRealms[0]!.rawValue).toBe("ghost_team");

    // Verify /inbox was NOT created by --dry-run!
    const engCheck = await createMindEngine({ homeDir, enableVector: false });
    expect(engCheck.db.getRealmByPath(engCheck.ledger.listOrgs()[0]!.id, "/inbox")).toBeNull();
    await engCheck.close();

    // 3b. Remove bad file and run real import WITHOUT --in -> fallback lands in /inbox (NEVER root /!)
    fs.unlinkSync(path.join(docsDir, "note3.md"));
    await runCli(["import", "md", docsDir, "--map", mapFile, "--json"], {
      env: { MERU_MIND_HOME: homeDir },
      cwd: wsDir,
    });

    const lsRoot = JSON.parse(
      (await runCli(["ls", "/", "--only", "entries", "--json"], {
        env: { MERU_MIND_HOME: homeDir },
      })).stdout,
    ) as { items: Array<{ id: string }> };
    expect(lsRoot.items).toHaveLength(0);

    const lsInbox = JSON.parse(
      (await runCli(["ls", "/inbox", "--only", "entries", "--json"], {
        env: { MERU_MIND_HOME: homeDir },
      })).stdout,
    ) as { items: Array<{ id: string; title: string }> };
    expect(lsInbox.items).toHaveLength(1);
    expect(lsInbox.items[0]!.title).toBe("Unassigned Note 1");

    // 3c. import verify WITHOUT --in passes cleanly against the unified default target
    const verifyOut = await runCli(
      ["import", "verify", "--source", docsDir, "--map", mapFile, "--json"],
      { env: { MERU_MIND_HOME: homeDir }, cwd: wsDir },
    );
    expect(JSON.parse(verifyOut.stdout).passed).toBe(true);

    // 3d. Batch entry move --ids-file - (stdin with # comment) + --from /inbox + --dry-run & commit
    const idToMove = lsInbox.items[0]!.id;
    const stdinList = `# comment line\n${idToMove}\n\n`;
    const moveDry = JSON.parse(
      (await runCli(
        [
          "entry",
          "move",
          "--ids-file",
          "-",
          "--from",
          "/inbox",
          "--to",
          "/ops",
          "--dry-run",
          "--as-human",
          "--json",
        ],
        { env: { MERU_MIND_HOME: homeDir }, input: stdinList },
      )).stdout,
    ) as { dryRun: boolean; moved: Array<{ id: string }> };
    expect(moveDry.dryRun).toBe(true);
    expect(moveDry.moved).toHaveLength(1);

    const moveReal = JSON.parse(
      (await runCli(
        [
          "entry",
          "move",
          "--ids-file",
          "-",
          "--from",
          "/inbox",
          "--to",
          "/ops",
          "--as-human",
          "--json",
        ],
        { env: { MERU_MIND_HOME: homeDir }, input: stdinList },
      )).stdout,
    ) as { dryRun: boolean; moved: Array<{ id: string }> };
    expect(moveReal.dryRun).toBe(false);
    expect(moveReal.moved).toHaveLength(1);

    const lsInboxAfter = JSON.parse(
      (await runCli(["ls", "/inbox", "--only", "entries", "--json"], {
        env: { MERU_MIND_HOME: homeDir },
      })).stdout,
    ) as { items: unknown[] };
    expect(lsInboxAfter.items).toHaveLength(0);
  });

  it("4. Pure-function admin doctor catches root bloat, parent bloat, missing scope, structural type-buckets & zero rules without tree-mode visibility leaks", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v053-doctor-"),
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

    await admin.setOrgPolicy({ policy: "tree" });
    await admin.createRealm({
      parentRef: "/",
      slug: "eng",
      name: "Engineering",
      scope: "Include: eng. Exclude: secret-team.",
    });
    await admin.createRealm({
      parentRef: "/eng",
      slug: "services-bucket",
      name: "Services Bucket",
      scope: "Include: all services. Exclude: none.",
    });
    await admin.createRealm({
      parentRef: "/",
      slug: "secret-team",
      name: "Secret Team",
      // intentionally missing scope in invisible sibling branch!
    });

    // Seed 22 entries directly on root / -> triggers root_direct_bloat + zero_rules_org
    for (let i = 0; i < 22; i += 1) {
      await admin.write({
        in: "/",
        kind: "finding",
        title: `Root misc note #${i}`,
        body: `Body ${i}`,
      });
    }
    // Seed 5 homogeneous objects of kind "service" in /eng/services-bucket -> triggers type_bucket_suspect
    const svcBucket = srv.engine.db.getRealmByPath(srv.orgId, "/eng/services-bucket")!;
    for (let i = 0; i < 5; i += 1) {
      srv.engine.objects.createObject({
        actor: { id: "admin", kind: "human" },
        viewerRealmId: svcBucket.id,
        kind: "service",
        name: `svc-${i}`,
      });
    }

    // Root admin remote CLI `admin doctor` sees root_direct_bloat, missing_scope on /secret-team, type_bucket_suspect, zero_rules_org
    const adminDocOut = JSON.parse(
      (await runCli(["admin", "doctor", "--json"], {
        env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: adminTok.token },
      })).stdout,
    ) as {
      healthy: boolean;
      findings: Array<{ code: string; realmPath: string }>;
    };
    expect(adminDocOut.healthy).toBe(false);
    const adminCodes = adminDocOut.findings.map((f) => `${f.code}:${f.realmPath}`);
    expect(adminCodes).toContain("root_direct_bloat:/");
    expect(adminCodes).toContain("missing_scope:/secret-team");
    expect(adminCodes).toContain("type_bucket_suspect:/eng/services-bucket");
    expect(adminCodes).toContain("zero_rules_org:/");

    // Sub-realm token bound to /eng MUST NOT see /secret-team anywhere in `admin doctor`!
    const engTok = await admin.createToken({
      actorId: "eng-lead",
      actorKind: "human",
      boundRealmRef: "/eng",
    });
    const engDocRaw = (await runCli(["admin", "doctor", "--json"], {
      env: { MERU_MIND_URL: srv.url, MERU_MIND_TOKEN: engTok.token },
    })).stdout;
    expect(engDocRaw).not.toContain("secret-team");
    const engDoc = JSON.parse(engDocRaw) as {
      findings: Array<{ code: string; realmPath: string }>;
    };
    expect(
      engDoc.findings.some((f) => f.code === "type_bucket_suspect" && f.realmPath === "/eng/services-bucket"),
    ).toBe(true);

    // Pure function direct check: after adding a rule on / and removing bloat, healthy === true
    const cleanHome = makeTempDir("meru-v053-clean-doctor-");
    const cleanEng = await createMindEngine({ homeDir: cleanHome, enableVector: false });
    const { org, rootRealm: cleanRoot } = cleanEng.ledger.createOrg({ name: "Healthy" });
    cleanEng.ledger.createRealm({
      actor: { id: "admin", kind: "human" },
      orgId: org.id,
      parentId: cleanRoot.id,
      slug: "ops",
      name: "Ops",
      scope: "Include: ops. Exclude: eng.",
    });
    const cleanTree = cleanEng.sea.tree({
      actor: { id: "admin", kind: "human" },
      viewerRealmId: cleanRoot.id,
      depth: "all",
      includeObjects: true,
    });
    const cleanReport = runRealmDoctor(cleanTree);
    expect(cleanReport.healthy).toBe(true);
    expect(cleanReport.findings).toHaveLength(0);
    await cleanEng.close();
    await admin.close();
  });
});
