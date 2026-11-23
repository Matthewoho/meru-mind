import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDateLiteralFtsExpr,
  createMindEngine,
  formatLsMarkdown,
  formatSearchMarkdown,
  formatShowMarkdown,
  formatTreeMarkdown,
  parseSearchQuery,
  type Actor,
  type MindEngine,
} from "../src/index.js";

const cliEntry = path.resolve(import.meta.dirname, "../dist/cli.js");
const mcpEntry = path.resolve(import.meta.dirname, "../dist/mcp.js");
const distIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../dist/index.js"),
).href;

const humanAdmin: Actor = { id: "alice", kind: "human" };
const agentWorker: Actor = { id: "worker-a", kind: "agent", family: "claude" };

const tempDirs: string[] = [];
const engines: MindEngine[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runCli(
  homeDir: string,
  args: string[],
  envExtra?: Record<string, string>,
): string {
  return execFileSync(process.execPath, [cliEntry, "--home", homeDir, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...envExtra },
  });
}

function runCliFail(
  homeDir: string,
  args: string[],
  envExtra?: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = runCli(homeDir, args, envExtra);
    throw new Error(`Expected CLI failure, succeeded with: ${stdout}`);
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

afterEach(async () => {
  while (engines.length > 0) {
    const eng = engines.pop()!;
    try {
      await eng.close();
    } catch {
      // ignore close errors
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("V0.2a Causal Entity Lifecycle & Round-3 UX Polish", () => {
  it("1. Migration v7: concurrent upgrade [1..7], is_name=1 backfill skipping empty norm, insertObject auto-alias, zero-inactive byte-identical reads", async () => {
    const homeDir = makeTempDir("meru-v7-mig-");
    const eng = await createMindEngine({ homeDir, enableVector: false });
    const { org, rootRealm } = eng.ledger.createOrg({
      name: "Acme",
      policy: "open",
    });

    const objNormal = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "person",
      name: "alex-chen",
    });
    const objPunctOnly = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "tag",
      name: "---",
    });

    // Verify insertObject auto-inserted is_name = 1 for normal object and skipped empty norm for "---"
    const normalAliases = eng.db.listObjectAliases([objNormal.id]);
    expect(normalAliases).toHaveLength(1);
    expect(normalAliases[0]).toMatchObject({
      objectId: objNormal.id,
      alias: "alex-chen",
      aliasNorm: "alex chen",
      isName: true,
      isExplicit: false,
    });
    expect(eng.db.listObjectAliases([objPunctOnly.id])).toHaveLength(0);

    // Zero-inactive byte-identical check: active MindObject JSON omits all 4 state fields
    const objJson = JSON.parse(JSON.stringify(objNormal)) as Record<
      string,
      unknown
    >;
    expect("state" in objJson).toBe(false);
    expect("stateLabel" in objJson).toBe(false);
    expect("stateSince" in objJson).toBe(false);
    expect("stateEvidenceId" in objJson).toBe(false);

    const rec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Alex Chen owns gateway",
      payload: { body: "Alex Chen maintains gateway routing." },
      occurredAt: "2026-10-20T10:00:00Z",
    });

    // When 0 inactive objects exist, search/ls/show omit `inactive` completely
    const searchRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "gateway",
    });
    expect(searchRes.items).toHaveLength(1);
    expect("inactive" in searchRes.items[0]!).toBe(false);
    expect(formatSearchMarkdown(searchRes)).not.toContain("⚠");

    const lsRes = await eng.sea.ls({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: "/",
    });
    expect("inactive" in lsRes.items[0]!).toBe(false);
    expect("state" in lsRes.objects![0]!).toBe(false);
    expect(formatLsMarkdown(lsRes)).not.toContain("⚠");

    const showRes = await eng.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: rec.id,
    });
    expect(showRes.refType).toBe("entry");
    expect("inactive" in showRes).toBe(false);
    expect(formatShowMarkdown(showRes)).not.toContain("⚠");

    await eng.close();

    // Simulate pre-v7 database (downgrade schema_migrations to v6, drop object_aliases and idx_objects_inactive)
    const dbPath = path.join(homeDir, "mind.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      DROP TABLE IF EXISTS object_aliases;
      DROP INDEX IF EXISTS idx_objects_inactive;
      DELETE FROM schema_migrations WHERE version >= 7;
    `);
    raw.close();

    // Spawn 4 concurrent OS processes hitting Migration v7 at the exact same millisecond
    const workerCode = `
      import readline from "node:readline";
      import { SqliteDb } from ${JSON.stringify(distIndexUrl)};
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      process.stdout.write("READY\\n");
      for await (const line of rl) {
        const { dbPath, goAt } = JSON.parse(line);
        while (Date.now() < goAt) {}
        let db;
        try {
          db = new SqliteDb({ dbPath, enableVector: false });
          const vers = db.listSchemaMigrations().map((m) => m.version);
          if (vers.join(",") !== "1,2,3,4,5,6,7,8") {
            throw new Error("bad versions: " + vers.join(","));
          }
          process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, error: String(err) }) + "\\n");
        } finally {
          try { db?.close(); } catch {}
        }
      }
    `;

    const workers = Array.from({ length: 4 }, () =>
      spawn(process.execPath, ["--input-type=module", "-e", workerCode], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );

    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            w.stdout.once("data", (d) => {
              if (String(d).includes("READY")) resolve();
              else reject(new Error(`Unexpected stdout: ${String(d)}`));
            });
            w.once("error", reject);
          }),
      ),
    );

    const goAt = Date.now() + 80;
    const results = await Promise.all(
      workers.map(
        (w) =>
          new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
            w.stdout.once("data", (d) => {
              resolve(JSON.parse(String(d).trim()));
            });
            w.once("error", reject);
            w.stdin.write(`${JSON.stringify({ dbPath, goAt })}\n`);
          }),
      ),
    );
    for (const w of workers) w.kill();

    expect(results.every((r) => r.ok)).toBe(true);

    // Verify v7 backfill populated alex-chen (is_name=1) and skipped "---"
    const reopened = await createMindEngine({ homeDir, enableVector: false });
    engines.push(reopened);
    expect(reopened.db.listSchemaMigrations().map((m) => m.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(reopened.db.listObjectAliases([objNormal.id])).toHaveLength(1);
    expect(reopened.db.listObjectAliases([objPunctOnly.id])).toHaveLength(0);
    expect(org.id).toBeTruthy();
  });

  it("2. object set & object alias validation: human vs agent --because, superseded rejected, --state active flags, tag/thing NOT_FOUND, change_log entityId, exact affected/aliasHits", async () => {
    const homeDir = makeTempDir("meru-v7-set-");
    const eng = await createMindEngine({ homeDir, enableVector: false });
    engines.push(eng);
    const { rootRealm } = eng.ledger.createOrg({
      name: "Acme",
      policy: "open",
    });

    const personObj = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "person",
      name: "alex-chen",
    });
    const apiObj = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "service",
      name: "legacy-gateway",
    });

    // Evidence records: active, superseded, secret
    const evOld = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "decision",
      title: "Alex departure draft",
      payload: { body: "Draft departure record for Alex Chen." },
      occurredAt: "2026-10-25T10:00:00Z",
    });
    const evActive = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "decision",
      title: "Alex departed 2026-10-26",
      payload: { body: "Confirmed: Alex Chen departed on 2026-10-26." },
      supersedesId: evOld.id,
      occurredAt: "2026-10-26T10:00:00Z",
    });
    const evSecret = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "decision",
      title: "Secret departure",
      payload: { body: "Secret HR note." },
      sensitivity: "secret",
      occurredAt: "2026-10-26T11:00:00Z",
    });

    // Tag-only and thing-only entries (NO objects row)
    await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Tag only ref",
      payload: { body: "Uses tag service:ephemeral" },
      resourceTags: ["service:ephemeral"],
    });
    await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "thing",
      title: "Thing anchor",
      payload: { body: "Thing only" },
      externalRef: "ticket:T-99",
    });

    // Records mentioning api vs payment-api + linked record
    const recLinked = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Gateway alert",
      payload: { body: "Call api for legacy status." },
      objectIds: [apiObj.id],
    });
    await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Payment-API note",
      payload: {
        body: "Use payment-api and api.example.com and api/v2 and api_key.",
      },
    });
    // Link evidence record to personObj too (must be excluded from affected.linked & affected.mentions!)
    eng.objects.linkEntryObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      entryId: evActive.id,
      objectId: personObj.id,
    });
    await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "On-call rotation",
      payload: { body: "Contact Alex Chen for escalation." },
      objectIds: [personObj.id],
    });

    await eng.close();
    engines.pop();

    // 1. Agent without --because -> INVALID_INPUT
    const failNoBecause = runCliFail(homeDir, [
      "object",
      "set",
      "person:alex-chen",
      "--state",
      "inactive",
      "--label",
      "departed",
      "--json",
    ]);
    expect(JSON.parse(failNoBecause.stderr).error).toBe("invalid_input");

    // 2. Superseded --because -> INVALID_INPUT
    const failSuperseded = runCliFail(homeDir, [
      "object",
      "set",
      "person:alex-chen",
      "--state",
      "inactive",
      "--label",
      "departed",
      "--because",
      evOld.id,
      "--json",
    ]);
    expect(JSON.parse(failSuperseded.stderr).error).toBe("invalid_input");

    // 3. Secret --because -> NOT_FOUND
    const failSecret = runCliFail(homeDir, [
      "object",
      "set",
      "person:alex-chen",
      "--state",
      "inactive",
      "--label",
      "departed",
      "--because",
      evSecret.id,
      "--json",
    ]);
    expect(JSON.parse(failSecret.stderr).error).toBe("not_found");

    // 4. Invalid slug & invalid calendar date -> INVALID_INPUT
    const failSlug = runCliFail(homeDir, [
      "object",
      "set",
      "person:alex-chen",
      "--state",
      "inactive",
      "--label",
      "Bad Label!",
      "--because",
      evActive.id,
      "--json",
    ]);
    expect(JSON.parse(failSlug.stderr).error).toBe("invalid_input");

    const failDate = runCliFail(homeDir, [
      "object",
      "set",
      "person:alex-chen",
      "--state",
      "inactive",
      "--label",
      "departed",
      "--since",
      "2026-02-30",
      "--because",
      evActive.id,
      "--json",
    ]);
    expect(JSON.parse(failDate.stderr).error).toBe("invalid_input");

    // 5. Tag-only & thing-only -> NOT_FOUND with try: meru-mind object create ...
    const failTagOnly = runCliFail(homeDir, [
      "object",
      "set",
      "service:ephemeral",
      "--state",
      "inactive",
      "--label",
      "retired",
      "--as-human",
      "--json",
    ]);
    const tagErr = JSON.parse(failTagOnly.stderr);
    expect(tagErr.error).toBe("not_found");
    expect(tagErr.try).toContain("meru-mind object create");

    const failThingOnly = runCliFail(homeDir, [
      "object",
      "set",
      "ticket:T-99",
      "--state",
      "inactive",
      "--label",
      "closed",
      "--as-human",
      "--json",
    ]);
    const thingErr = JSON.parse(failThingOnly.stderr);
    expect(thingErr.error).toBe("not_found");
    expect(thingErr.try).toContain("meru-mind object create");

    // 6. object alias validations: short aliases rejected, multiline rejected, >80 chars rejected, --remove is_name=1 rejected
    for (const badAlias of ["go", "li", "陈", "line1\nline2", "a".repeat(81)]) {
      const f = runCliFail(homeDir, [
        "object",
        "alias",
        "person:alex-chen",
        "--add",
        badAlias,
        "--json",
      ]);
      expect(JSON.parse(f.stderr).error).toBe("invalid_input");
    }

    const failRemoveName = runCliFail(homeDir, [
      "object",
      "alias",
      "person:alex-chen",
      "--remove",
      "alex-chen",
      "--json",
    ]);
    expect(JSON.parse(failRemoveName.stderr).error).toBe("invalid_input");

    // 7. Add explicit alias "api" on service:legacy-gateway & test exact affected + aliasHits
    runCli(homeDir, [
      "object",
      "alias",
      "service:legacy-gateway",
      "--add",
      "api",
      "--json",
    ]);

    const setApiOut = JSON.parse(
      runCli(homeDir, [
        "object",
        "set",
        "service:legacy-gateway",
        "--state",
        "inactive",
        "--label",
        "deprecated",
        "--as-human",
        "--json",
      ]),
    );
    expect(setApiOut.object.state).toBe("inactive");
    expect(setApiOut.object.stateLabel).toBe("deprecated");
    expect(setApiOut.object.stateSince).toBeNull();
    expect(setApiOut.affected.linked).toBe(1);
    // Exact mention matcher: recLinked ("Call api for...") matches; payment-api/api.example.com/api/v2/api_key do NOT!
    expect(setApiOut.affected.mentions).toBe(1);
    expect(setApiOut.aliasHits.api).toBe(1);

    // 8. Agent with valid active --because succeeds; evActive itself excluded from affected counts!
    const setPersonOut = JSON.parse(
      runCli(homeDir, [
        "object",
        "set",
        "person:alex-chen",
        "--state",
        "inactive",
        "--label",
        "departed",
        "--since",
        "2026-10-26",
        "--because",
        evActive.id,
        "--json",
      ]),
    );
    expect(setPersonOut.object.state).toBe("inactive");
    expect(setPersonOut.object.stateLabel).toBe("departed");
    expect(setPersonOut.object.stateSince).toBe("2026-10-26");
    expect(setPersonOut.object.stateEvidenceId).toBe(evActive.id);
    // Only On-call rotation counts (evActive itself is excluded!)
    expect(setPersonOut.affected.linked).toBe(1);
    expect(setPersonOut.affected.mentions).toBe(1);

    // 9. --state active rejects --label / --since / --because
    for (const extra of [
      ["--label", "foo"],
      ["--since", "2026-10-27"],
      ["--because", evActive.id],
    ]) {
      const f = runCliFail(homeDir, [
        "object",
        "set",
        "person:alex-chen",
        "--state",
        "active",
        ...extra,
        "--json",
      ]);
      expect(JSON.parse(f.stderr).error).toBe("invalid_input");
    }

    // 10. Clean --state active resets and omits state fields
    const reactivated = JSON.parse(
      runCli(homeDir, [
        "object",
        "set",
        "person:alex-chen",
        "--state",
        "active",
        "--json",
      ]),
    );
    expect("state" in reactivated.object).toBe(false);
    expect("stateLabel" in reactivated.object).toBe(false);
    expect("stateSince" in reactivated.object).toBe(false);
    expect("stateEvidenceId" in reactivated.object).toBe(false);

    // 11. 32 explicit alias cap enforced
    const add32Args: string[] = [];
    for (let i = 1; i <= 32; i += 1) {
      add32Args.push("--add", `alias-item-${String(i).padStart(2, "0")}`);
    }
    runCli(homeDir, ["object", "alias", "person:alex-chen", ...add32Args, "--json"]);
    const fail33 = runCliFail(homeDir, [
      "object",
      "alias",
      "person:alex-chen",
      "--add",
      "alias-item-33",
      "--json",
    ]);
    expect(JSON.parse(fail33.stderr).error).toBe("invalid_input");

    // 12. Verify change_log stores ONLY object.id (never composite obj:rec)
    const engCheck = await createMindEngine({ homeDir, enableVector: false });
    engines.push(engCheck);
    const changes = engCheck.db.listChangeLog({ limit: 100 }).entries;
    const stateChanges = changes.filter((c) => c.op === "object_state_changed");
    const aliasChanges = changes.filter((c) => c.op === "object_alias_updated");
    expect(stateChanges.length).toBeGreaterThanOrEqual(3);
    expect(aliasChanges.length).toBeGreaterThanOrEqual(2);
    for (const c of [...stateChanges, ...aliasChanges]) {
      expect(c.entityType).toBe("object");
      expect(c.entityId).not.toContain(":");
      expect(c.entityId).not.toContain("rec_");
    }
    expect(recLinked.id).toBeTruthy();
  });

  it("3. Read-time badges on search/ls/show/tree/object-card: connector boundaries, multi-token, single-token exclusion, ambiguity, max-2/+N cap, evidence-self suppression, zero ranking change", async () => {
    const homeDir = makeTempDir("meru-v7-badges-");
    const eng = await createMindEngine({ homeDir, enableVector: false });
    engines.push(eng);
    const { rootRealm } = eng.ledger.createOrg({
      name: "Acme",
      policy: "open",
    });

    const pAlex = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "person",
      name: "alex-chen",
    });
    const sApi = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "service",
      name: "legacy-api",
    });
    const sBilling = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "service",
      name: "billing", // single-token name — must NOT match mentions unless explicitly added as alias
    });
    const pExtra1 = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "person",
      name: "sam-wu",
    });
    const pExtra2 = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "person",
      name: "lin-xiao",
    });
    const pAmb1 = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "person",
      name: "owner-one",
    });
    const pAmb2 = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "person",
      name: "owner-two",
    });
    const sActive = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "service",
      name: "active-svc",
    });

    // Aliases
    eng.objects.updateObjectAliases({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      objectId: pAlex.id,
      add: ["alex", "陈晨"],
    });
    eng.objects.updateObjectAliases({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      objectId: sApi.id,
      add: ["api"],
    });
    eng.objects.updateObjectAliases({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      objectId: pAmb1.id,
      add: ["shared-lead"],
    });
    eng.objects.updateObjectAliases({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      objectId: pAmb2.id,
      add: ["shared-lead"],
    });

    // Evidence record for pAlex
    const evAlex = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "decision",
      title: "Alex Chen departed note",
      payload: { body: "Alex Chen (陈晨) departed on 2026-10-26. badgecheck" },
      objectIds: [pAlex.id],
      occurredAt: "2026-10-26T10:00:00Z",
    });

    // Test entries
    const recDotBoundary = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Handoff note 1",
      payload: { body: "交接给 alex. badgecheck" },
      occurredAt: "2026-10-25T10:00:00Z",
    });
    const recColonBoundary = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Handoff note 2",
      payload: { body: "alex: 好的，给alex吧 badgecheck" },
      occurredAt: "2026-10-24T10:00:00Z",
    });
    const recMultiToken = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Multi-token mention",
      payload: { body: "Owned by Alex Chen (also alex_chen). badgecheck" },
      occurredAt: "2026-10-23T10:00:00Z",
    });
    const recApiFalsePositive = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Modern payment stack",
      payload: {
        body: "Uses payment-api, api.example.com, api/v2, api_key and billing. badgecheck",
      },
      occurredAt: "2026-10-22T10:00:00Z",
    });
    const recAmbiguous = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Ambiguous owner note",
      payload: { body: "Ask shared-lead about deployment. badgecheck" },
      occurredAt: "2026-10-21T10:00:00Z",
    });
    const recThreeInactive = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Three inactive owners",
      payload: { body: "Alex Chen, Sam Wu, and Lin Xiao reviewed this. badgecheck" },
      occurredAt: "2026-10-20T10:00:00Z",
    });

    // Capture search ranking BEFORE marking objects inactive
    const beforeSearch = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "badgecheck",
      limit: 20,
    });
    const beforeOrder = beforeSearch.items.map((it) => it.id);

    // Mark objects inactive
    eng.objects.setObjectState({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      objectId: pAlex.id,
      state: "inactive",
      label: "departed",
      since: "2026-10-26",
      because: evAlex.id,
    });
    eng.objects.setObjectState({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      objectId: sApi.id,
      state: "inactive",
      label: "deprecated",
    });
    eng.objects.setObjectState({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      objectId: sBilling.id,
      state: "inactive",
      label: "retired",
    });
    eng.objects.setObjectState({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      objectId: pExtra1.id,
      state: "inactive",
      label: "departed",
      since: "2026-10-15",
    });
    eng.objects.setObjectState({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      objectId: pExtra2.id,
      state: "inactive",
      label: "departed",
      since: "2026-10-16",
    });
    eng.objects.setObjectState({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      objectId: pAmb1.id,
      state: "inactive",
      label: "departed",
    });

    // Search AFTER marking inactive: ranking MUST be byte-for-byte identical!
    const afterSearch = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "badgecheck",
      limit: 20,
    });
    expect(afterSearch.items.map((it) => it.id)).toEqual(beforeOrder);

    const byId = new Map(afterSearch.items.map((it) => [it.id, it]));

    // Evidence self-suppression!
    expect(byId.get(evAlex.id)?.inactive).toBeUndefined();

    // Latin connector boundary pass ("alex.", "alex: 好的", "给alex吧")
    expect(byId.get(recDotBoundary.id)?.inactive).toEqual([
      "person:alex-chen departed 2026-10-26",
    ]);
    expect(byId.get(recColonBoundary.id)?.inactive).toEqual([
      "person:alex-chen departed 2026-10-26",
    ]);

    // Multi-token object name ("Alex Chen" / "alex_chen") matches automatically
    expect(byId.get(recMultiToken.id)?.inactive).toEqual([
      "person:alex-chen departed 2026-10-26",
    ]);

    // api rejects payment-api / api.example.com / api/v2 / api_key; single-token billing excluded!
    expect(byId.get(recApiFalsePositive.id)?.inactive).toBeUndefined();

    // Ambiguous visible alias skipped!
    expect(byId.get(recAmbiguous.id)?.inactive).toBeUndefined();

    // Max-2 + (+1) cap in Markdown when 3 inactive objects match
    expect(byId.get(recThreeInactive.id)?.inactive).toHaveLength(3);
    const searchMd = formatSearchMarkdown(afterSearch);
    expect(searchMd).toContain("(+1)");

    // show <entry> includes inactive badge on matching entry and omits on evidence record
    const showMatch = await eng.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: recDotBoundary.id,
    });
    expect(showMatch.refType).toBe("entry");
    if (showMatch.refType === "entry") {
      expect(showMatch.inactive).toEqual(["person:alex-chen departed 2026-10-26"]);
    }
    expect(formatShowMarkdown(showMatch)).toContain(
      "⚠ person:alex-chen departed 2026-10-26",
    );

    // show <object> displays State line
    const showObj = await eng.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: "person:alex-chen",
    });
    const showObjMd = formatShowMarkdown(showObj);
    expect(showObjMd).toContain(
      `State**: inactive (departed, since 2026-10-26, evidence: ${evAlex.id})`,
    );

    // tree & ls --only objects append [departed] ONLY on inactive objects
    const treeRes = eng.sea.tree({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      depth: "all",
    });
    const treeMd = formatTreeMarkdown(treeRes);
    expect(treeMd).toContain("`person:alex-chen`");
    expect(treeMd).toContain("[departed]");
    // Active object has no state bracket
    const lsObjs = await eng.sea.ls({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: "/",
      only: "objects",
    });
    const lsObjsMd = formatLsMarkdown(lsObjs);
    expect(lsObjsMd).toContain("`person:alex-chen` [departed]");
    expect(lsObjsMd).toContain("`service:active-svc`");
    expect(lsObjsMd).not.toContain("`service:active-svc` [");
    expect(sActive.id).toBeTruthy();
  });

  it("4. redact() of state_evidence_id preserves state=inactive & state_since, clears label & evidence pointer, logs object_evidence_redacted, reports clearedObjectIds, degrades badge", async () => {
    const homeDir = makeTempDir("meru-v7-redact-");
    const eng = await createMindEngine({ homeDir, enableVector: false });
    engines.push(eng);
    const { rootRealm } = eng.ledger.createOrg({
      name: "Acme",
      policy: "open",
    });

    const pAlex = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      kind: "person",
      name: "alex-chen",
    });
    const ev = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "decision",
      title: "Departure notice",
      payload: { body: "Sensitive HR reason for Alex Chen departure." },
      occurredAt: "2026-10-26T10:00:00Z",
    });
    const workRec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Runbook owner",
      payload: { body: "Runbook owned by Alex Chen." },
      occurredAt: "2026-10-20T10:00:00Z",
    });

    eng.objects.setObjectState({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      objectId: pAlex.id,
      state: "inactive",
      label: "departed",
      since: "2026-10-26",
      because: ev.id,
    });

    // Redact the evidence record
    const redactRes = eng.ledger.redact({
      actor: humanAdmin,
      entryId: ev.id,
      reason: "HR privacy",
    });
    expect(redactRes.clearedObjectIds).toEqual([pAlex.id]);

    // Object stays inactive with stateSince intact, while label & evidenceId are null
    const afterObj = eng.db.getObject(pAlex.id)!;
    expect(afterObj.state).toBe("inactive");
    expect(afterObj.stateSince).toBe("2026-10-26");
    expect(afterObj.stateLabel).toBeNull();
    expect(afterObj.stateEvidenceId).toBeNull();

    // change_log recorded object_evidence_redacted with entityId === object.id
    const cl = eng.db.listChangeLog({ limit: 50 }).entries;
    const evRedacted = cl.find(
      (e) => e.op === "object_evidence_redacted" && e.entityId === pAlex.id,
    );
    expect(evRedacted).toBeDefined();
    expect(evRedacted?.entityType).toBe("object");

    // Badge degrades cleanly to "person:alex-chen inactive 2026-10-26"
    const searchRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "Runbook",
    });
    expect(searchRes.items[0]?.id).toBe(workRec.id);
    expect(searchRes.items[0]?.inactive).toEqual([
      "person:alex-chen inactive 2026-10-26",
    ]);
  });

  it("5. Centralized P0-1 tree-mode isolation across ALL object-returning endpoints & read-time badges (zero hidden-realm leakage)", async () => {
    const homeDir = makeTempDir("meru-v7-p01-");
    const eng = await createMindEngine({ homeDir, enableVector: false });
    engines.push(eng);
    const { org, rootRealm } = eng.ledger.createOrg({
      name: "TreeCorp",
      policy: "tree",
    });

    const alpha = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "alpha",
      name: "Alpha Secret Team",
    });
    const beta = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "beta",
      name: "Beta Public Team",
    });
    const shared = eng.ledger.createRealm({
      actor: humanAdmin,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "shared",
      name: "Shared Services",
    });

    // Mount /shared (ledger) into /beta, NOT /alpha!
    eng.ledger.mountRealm({
      actor: humanAdmin,
      viewerRealmId: beta.id,
      targetRealmId: shared.id,
      scope: "ledger",
    });
    // Also mount /alpha into /shared? No: create evidence in /alpha (visible from root `/` when human sets state on /shared object!)
    const hiddenEvidence = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: alpha.id,
      realmId: alpha.id,
      kind: "decision",
      title: "Alpha confidential incident",
      payload: { body: "Confidential alpha rationale." },
      occurredAt: "2026-10-26T10:00:00Z",
    });

    // Visible object in /beta (so beta has write permission to move/alias it) whose state_evidence_id is in hidden /alpha!
    // Root `/` can read both /alpha and /beta in tree mode, so root human marks /beta's object inactive citing /alpha's record!
    const betaObj = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: beta.id,
      kind: "service",
      name: "beta-gateway",
    });
    const betaParent = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: beta.id,
      kind: "group",
      name: "beta-group",
    });
    eng.objects.updateObjectAliases({
      actor: humanAdmin,
      viewerRealmId: beta.id,
      objectId: betaObj.id,
      add: ["shared-codename"],
    });
    // Temporarily mount /alpha into /beta so /beta can cite alpha's evidence, then revoke mount
    // (simulates mount revocation or open->tree policy hardening after state_evidence_id was stored).
    eng.ledger.mountRealm({
      actor: humanAdmin,
      viewerRealmId: beta.id,
      targetRealmId: alpha.id,
      scope: "ledger",
    });
    eng.objects.setObjectState({
      actor: humanAdmin,
      viewerRealmId: beta.id,
      objectId: betaObj.id,
      state: "inactive",
      label: "deprecated",
      since: "2026-10-26",
      because: hiddenEvidence.id,
    });
    eng.ledger.unmountRealm({
      actor: humanAdmin,
      viewerRealmId: beta.id,
      targetRealmId: alpha.id,
    });

    // Hidden-realm inactive object in /alpha sharing the SAME alias "shared-codename" and another unique alias "alpha-secret-person"
    const alphaHiddenObj = eng.objects.createObject({
      actor: humanAdmin,
      viewerRealmId: alpha.id,
      kind: "person",
      name: "alpha-secret-person",
    });
    eng.objects.updateObjectAliases({
      actor: humanAdmin,
      viewerRealmId: alpha.id,
      objectId: alphaHiddenObj.id,
      add: ["shared-codename", "alpha-only-alias"],
    });
    eng.objects.setObjectState({
      actor: humanAdmin,
      viewerRealmId: alpha.id,
      objectId: alphaHiddenObj.id,
      state: "inactive",
      label: "departed",
      since: "2026-10-20",
    });

    // Record in /beta mentioning BOTH "shared-codename" and "alpha-only-alias"
    const betaRec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: beta.id,
      realmId: beta.id,
      kind: "finding",
      title: "Beta routing note",
      payload: {
        body: "Uses shared-codename and mentions alpha-only-alias in passing.",
      },
      occurredAt: "2026-10-25T10:00:00Z",
    });

    // Verify tree-mode --because visibility check: /beta cannot cite hidden /alpha evidence!
    expect(() =>
      eng.objects.setObjectState({
        actor: agentWorker,
        viewerRealmId: beta.id,
        objectId: betaParent.id,
        state: "inactive",
        label: "deprecated",
        since: "2026-10-26",
        because: hiddenEvidence.id,
      }),
    ).toThrow(/not found|visible/i);

    // Check EVERY object-returning endpoint from viewer = /beta: hiddenEvidence.id MUST NEVER LEAK!
    const fromGetObj = eng.objects.getObject({
      viewerRealmId: beta.id,
      objectId: betaObj.id,
    });
    expect(fromGetObj.stateEvidenceId).toBeNull();

    const fromListObjs = eng.objects.listObjects({ viewerRealmId: beta.id });
    expect(JSON.stringify(fromListObjs)).not.toContain(hiddenEvidence.id);
    expect(JSON.stringify(fromListObjs)).not.toContain(alphaHiddenObj.id);

    const fromMove = eng.objects.moveObject({
      actor: agentWorker,
      viewerRealmId: beta.id,
      objectId: betaObj.id,
      parentObjectId: betaParent.id,
    });
    expect(fromMove.stateEvidenceId).toBeNull();

    const fromAlias = eng.objects.updateObjectAliases({
      actor: agentWorker,
      viewerRealmId: beta.id,
      objectId: betaObj.id,
      add: ["beta-gw"],
    });
    expect(fromAlias.object.stateEvidenceId).toBeNull();

    const fromTree = eng.sea.tree({
      actor: agentWorker,
      viewerRealmId: beta.id,
      depth: "all",
    });
    expect(JSON.stringify(fromTree)).not.toContain(hiddenEvidence.id);
    expect(JSON.stringify(fromTree)).not.toContain(alphaHiddenObj.id);

    const fromShowObj = await eng.sea.show({
      actor: agentWorker,
      viewerRealmId: beta.id,
      ref: "service:beta-gateway",
    });
    expect(JSON.stringify(fromShowObj)).not.toContain(hiddenEvidence.id);
    expect(formatShowMarkdown(fromShowObj)).not.toContain(hiddenEvidence.id);

    const fromLsObjs = await eng.sea.ls({
      actor: agentWorker,
      viewerRealmId: beta.id,
      ref: "/beta",
      only: "objects",
    });
    expect(JSON.stringify(fromLsObjs)).not.toContain(hiddenEvidence.id);
    expect(JSON.stringify(fromLsObjs)).not.toContain(alphaHiddenObj.id);

    // Badges in /beta:
    // 1. alphaHiddenObj does NOT emit badge for "alpha-only-alias"
    // 2. alphaHiddenObj does NOT cause ambiguity for "shared-codename", so betaObj STILL emits its badge!
    const fromSearch = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: beta.id,
      query: "routing",
    });
    expect(fromSearch.items[0]?.id).toBe(betaRec.id);
    expect(fromSearch.items[0]?.inactive).toEqual([
      "service:beta-gateway deprecated 2026-10-26",
    ]);
    expect(JSON.stringify(fromSearch)).not.toContain("alpha-secret-person");
    expect(JSON.stringify(fromSearch)).not.toContain(hiddenEvidence.id);

    const fromLsEntries = await eng.sea.ls({
      actor: agentWorker,
      viewerRealmId: beta.id,
      ref: "/beta",
      only: "entries",
    });
    expect(fromLsEntries.items[0]?.inactive).toEqual([
      "service:beta-gateway deprecated 2026-10-26",
    ]);

    const fromShowEntry = await eng.sea.show({
      actor: agentWorker,
      viewerRealmId: beta.id,
      ref: betaRec.id,
    });
    expect(fromShowEntry.refType).toBe("entry");
    if (fromShowEntry.refType === "entry") {
      expect(fromShowEntry.inactive).toEqual([
        "service:beta-gateway deprecated 2026-10-26",
      ]);
    }

    // Re-setting alphaHiddenObj from /alpha reports 0 mentions/linked from /beta (strict visibility scope!)
    const alphaSetRes = eng.objects.setObjectState({
      actor: humanAdmin,
      viewerRealmId: alpha.id,
      objectId: alphaHiddenObj.id,
      state: "inactive",
      label: "departed",
      since: "2026-10-20",
    });
    expect(alphaSetRes.affected.linked).toBe(0);
    expect(alphaSetRes.affected.mentions).toBe(0);
  });

  it("6. show --chars rename: --limit throws unknown_flag hinting --chars, show --help lists window flags, MCP mind_show uses chars with <= 6000 wire budget", async () => {
    const homeDir = makeTempDir("meru-v7-show-chars-");
    const eng = await createMindEngine({ homeDir, enableVector: false });
    const { rootRealm } = eng.ledger.createOrg({
      name: "Acme",
      policy: "open",
    });

    const bigRec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Long architecture note",
      payload: { body: "Architecture paragraph content. ".repeat(250) },
      occurredAt: "2026-10-20T10:00:00Z",
    });
    await eng.close();

    // show --help documents all window flags
    const helpText = runCli(homeDir, ["show", "--help"]);
    for (const flag of [
      "--chars",
      "--around",
      "--cursor",
      "--full",
      "--history",
      "--context",
    ]) {
      expect(helpText).toContain(flag);
    }
    expect(helpText).not.toContain("--limit");

    // show --limit fails with unknown_flag and try hint mentioning --chars
    const failLimit = runCliFail(homeDir, [
      "show",
      bigRec.id,
      "--limit",
      "600",
      "--json",
    ]);
    const parsedErr = JSON.parse(failLimit.stderr) as {
      error: string;
      message: string;
      try?: string;
    };
    expect(parsedErr.error).toBe("unknown_flag");
    expect(parsedErr.message).toContain("--limit");
    expect(parsedErr.try).toContain(`meru-mind show ${bigRec.id} --chars 600`);

    // show --chars bounds output cleanly
    const okShow = JSON.parse(
      runCli(homeDir, ["show", bigRec.id, "--chars", "600", "--json"]),
    ) as {
      window: { shownChars: number; truncated: boolean };
    };
    expect(okShow.window.truncated).toBe(true);
    expect(okShow.window.shownChars).toBeLessThanOrEqual(600);

    // Live MCP: 7 tools, <= 6000 wire chars, mind_show schema uses chars (not limit)
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpEntry],
      env: { ...process.env, MERU_MIND_HOME: homeDir },
    });
    const client = new Client({ name: "v7-show-chars-mcp", version: "0.2.0" });
    await client.connect(transport);
    try {
      const toolsList = await client.listTools();
      expect(toolsList.tools).toHaveLength(7);
      expect(JSON.stringify(toolsList).length).toBeLessThanOrEqual(6000);
      const showTool = toolsList.tools.find((t) => t.name === "mind_show")!;
      const props = (
        showTool.inputSchema as { properties?: Record<string, unknown> }
      ).properties!;
      expect("chars" in props).toBe(true);
      expect("limit" in props).toBe(false);

      const mcpOk = await client.callTool({
        name: "mind_show",
        arguments: { ref: bigRec.id, chars: 500 },
      });
      expect(mcpOk.isError).toBeFalsy();
      const mcpParsed = JSON.parse(
        (mcpOk.content as Array<{ text: string }>)[0]!.text,
      ) as { window: { shownChars: number; truncated: boolean } };
      expect(mcpParsed.window.truncated).toBe(true);
      expect(mcpParsed.window.shownChars).toBeLessThanOrEqual(500);

      const mcpRealmErr = await client.callTool({
        name: "mind_show",
        arguments: { ref: "/", chars: 500 },
      });
      expect(mcpRealmErr.isError).toBe(true);
      const realmErrObj = JSON.parse(
        (mcpRealmErr.content as Array<{ text: string }>)[0]!.text,
      ) as { error: string; message: string };
      expect(realmErrObj.error).toBe("invalid_input");
      expect(realmErrObj.message).toContain("--chars");
    } finally {
      await client.close();
    }
  });

  it("7. Query-side date concepts: opt-in parsing, >100 occurred_at & body-literal B1 recall, contiguous 10月10日上线 + 日↔号 B2, pure-date overlap dedupe, 查一下10月10日, leap 3月1日, rollover, show --around unchanged", async () => {
    // A) Parser unit assertions: opt-in default, boundaries, calendar validation, space replacement, stopword bypass, mixed padding
    const defaultParsed = parseSearchQuery("10月10日");
    expect("dateConcepts" in defaultParsed).toBe(false);
    expect(defaultParsed.concepts.length).toBeGreaterThan(0);

    const stopwordPure = parseSearchQuery("查一下10月10日", {
      extractDates: true,
    });
    expect(stopwordPure.concepts).toHaveLength(0);
    expect(stopwordPure.dateConcepts?.map((d) => d.label)).toEqual(["10-10"]);

    // Space replacement prevents adjacent CJK fusion ("部署10月10日上线" -> ["部署", "上线"])
    const noFusion = parseSearchQuery("部署10月10日上线", { extractDates: true });
    expect(noFusion.concepts.map((c) => c.raw)).toEqual(["部署", "上线"]);
    expect(noFusion.dateConcepts?.map((d) => d.label)).toEqual(["10-10"]);

    // Sentence-end punctuation relaxed (2026-10-10. / 2026-10-10:) while identifiers are NOT sliced!
    expect(
      parseSearchQuery("2026-10-10. summary", { extractDates: true })
        .dateConcepts?.map((d) => d.label),
    ).toEqual(["2026-10-10"]);
    expect(
      parseSearchQuery("2026-10-10: summary", { extractDates: true })
        .dateConcepts?.map((d) => d.label),
    ).toEqual(["2026-10-10"]);
    for (const nonDateIdent of [
      "backup_2026-10-10",
      "2026-10-10T08:00",
      "file:/ops/2026-10-10.md",
      "2026-02-30",
      "2月30日",
      "4月31日",
    ]) {
      const p = parseSearchQuery(nonDateIdent, { extractDates: true });
      expect(p.dateConcepts).toHaveLength(0);
    }

    // Year-less 2月29日 allowed; year-less 3月1日 includes BOTH 02-28 and 02-29
    const feb29 = parseSearchQuery("2月29日", { extractDates: true });
    expect(feb29.dateConcepts?.map((d) => d.label)).toEqual(["02-29"]);
    const mar1 = parseSearchQuery("3月1日", { extractDates: true });
    expect(mar1.dateConcepts?.[0]?.window.monthDays).toContain("02-28");
    expect(mar1.dateConcepts?.[0]?.window.monthDays).toContain("02-29");

    // Full Chinese date extracted BEFORE month-day
    const cnFull = parseSearchQuery("2026年10月10日", { extractDates: true });
    expect(cnFull.dateConcepts?.map((d) => d.label)).toEqual(["2026-10-10"]);

    // Mixed padding & ISO-T prefix in buildDateLiteralFtsExpr
    const mixedExpr = buildDateLiteralFtsExpr({ year: 2026, month: 3, day: 5 });
    expect(mixedExpr).toContain('"2026 3 05"');
    expect(mixedExpr).toContain('"2026 03 5"');
    expect(mixedExpr).toContain('"2026 03 05t"*');
    expect(mixedExpr).toContain('"3 月 05 日"*');
    expect(mixedExpr).toContain('"3 月 05 号"*');

    // Negative JS checks: 2025年10月10日 rejected for 2026-10-10; 2010-10-05 rejected for 10月10日
    const dc2026 = parseSearchQuery("2026-10-10", { extractDates: true })
      .dateConcepts![0]!;
    expect(dc2026.matchLiteralText("2025年10月10日回溯")).toBe(false);
    expect(dc2026.matchLiteralText("10月10日上线")).toBe(true);
    expect(dc2026.matchLiteralText("2026-10-10T08:00:00Z")).toBe(true);
    expect(dc2026.matchLiteralText("backup_2026-10-10")).toBe(true);
    expect(dc2026.matchLiteralText("2026/10/10")).toBe(true);
    expect(dc2026.matchLiteralText("2026.10.10")).toBe(true);

    const dcMd = stopwordPure.dateConcepts![0]!;
    expect(dcMd.matchLiteralText("2010-10-05 archive")).toBe(false);
    expect(dcMd.matchLiteralText("月度日志总结")).toBe(false);
    expect(dcMd.matchLiteralText("10月10号上线")).toBe(true);

    // B) End-to-end DB recall tests (>100 same-keyword records for P1-1 & B1 + B2 + P1-2 overlap dedupe)
    const homeDir = makeTempDir("meru-v7-dates-");
    const eng = await createMindEngine({ homeDir, enableVector: false });
    engines.push(eng);
    const { rootRealm } = eng.ledger.createOrg({
      name: "Acme",
      policy: "open",
    });

    // Insert 115 decoy records with keyword "deploy" in August 2026 (pushes targets beyond top-100 FTS cap!)
    for (let i = 0; i < 115; i += 1) {
      await eng.ledger.appendRecord({
        actor: humanAdmin,
        viewerRealmId: rootRealm.id,
        realmId: rootRealm.id,
        kind: "finding",
        title: `Deploy deploy deploy batch ${i}`,
        payload: { body: `Routine deploy deploy log entry #${i}.` },
        occurredAt: "2026-08-01T10:00:00Z",
      });
    }

    // Target 1 (P1-1): occurred_at on 2026-10-10, NO date text in title/body!
    const targetOccurred = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "decision",
      title: "Deploy gateway hotfix",
      payload: { body: "Shipped gateway hotfix cleanly." },
      occurredAt: "2026-10-10T10:00:00Z",
    });

    // Target 2 (B1 ISO body-literal): occurred_at 10 days away, body mentions 2026-10-10
    const targetBodyIso = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Deploy retro ISO",
      payload: { body: "Postmortem referencing 2026-10-10 incident." },
      occurredAt: "2026-10-20T10:00:00Z",
    });

    // Target 3 (B1 ISO-T body timestamp): occurred_at 10 days away, body mentions 2026-10-10T08:00:00Z
    const targetBodyIsoT = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Deploy retro timestamp",
      payload: { body: "Trigger fired at 2026-10-10T08:00:00Z." },
      occurredAt: "2026-10-21T10:00:00Z",
    });

    // Target 4 (B1+B2 contiguous "10月10日上线" + 日↔号): occurred_at 10 days away
    const targetBodyCnContig = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Deploy retro CJK",
      payload: { body: "回溯10月10日上线变更的监控指标。" },
      occurredAt: "2026-10-22T10:00:00Z",
    });

    // Negative mismatched year: 2025年10月10日 (must NOT match 2026-10-10 date concept!)
    const targetWrongYear = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Deploy archive 2025",
      payload: { body: "2025年10月10日上线历史记录。" },
      occurredAt: "2025-10-10T10:00:00Z",
    });

    // Mixed query: "deploy 2026-10-10" MUST recall targetOccurred (tier 4!), targetBodyIso, targetBodyIsoT, targetBodyCnContig
    const mixedIso = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "deploy 2026-10-10",
      limit: 10,
    });
    expect(mixedIso.interpretedDates).toEqual(["2026-10-10"]);
    const mixedIsoTopIds = mixedIso.items.slice(0, 5).map((i) => i.id);
    // targetOccurred reaches Tier 4 (occurred_at satisfies titleAllCovered!) -> ranks #1!
    expect(mixedIsoTopIds[0]).toBe(targetOccurred.id);
    expect(mixedIsoTopIds).toContain(targetBodyIso.id);
    expect(mixedIsoTopIds).toContain(targetBodyIsoT.id);
    expect(mixedIsoTopIds).toContain(targetBodyCnContig.id);
    // Wrong year 2025 must NOT rank in top 4 (only satisfies "deploy", not date 2026-10-10)
    expect(mixedIsoTopIds.slice(0, 4)).not.toContain(targetWrongYear.id);

    // Mixed Chinese query with 号 matching body with contiguous 日上线 (B1 + B2!)
    const mixedCn = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "deploy 10月10号",
      limit: 10,
    });
    expect(mixedCn.interpretedDates).toEqual(["10-10"]);
    const mixedCnTopIds = mixedCn.items.slice(0, 5).map((i) => i.id);
    expect(mixedCnTopIds).toContain(targetOccurred.id);
    expect(mixedCnTopIds).toContain(targetBodyCnContig.id);

    // Pure-date union + overlap deduplication + upper-bound timestamp + negative 2010-10-05/月度日志
    const pureOverlapRec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Rollout summary",
      payload: { body: "Completed 10月10日 rollout." },
      occurredAt: "2026-10-10T14:00:00Z", // sits in BOTH window AND literal FTS!
    });
    const pureUpperBoundRec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Late evening follow-up",
      payload: { body: "Post-window check." },
      occurredAt: "2026-10-11T23:00:00Z", // UTC date prefix 2026-10-11 <= 2026-10-11!
    });
    const pureNegRec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "月度日志 2010-10-05",
      payload: { body: "Archived on 2010-10-05 for 月度日志." },
      occurredAt: "2026-05-01T10:00:00Z",
    });

    // Pure-date query via stopword bypass: "查一下10月10日"
    const pureRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "查一下10月10日",
      limit: 20,
    });
    expect(pureRes.interpretedDates).toEqual(["10-10"]);
    expect(formatSearchMarkdown(pureRes)).toContain("dates=`10-10`");
    const pureIds = pureRes.items.map((i) => i.id);
    expect(pureIds).toContain(targetOccurred.id);
    expect(pureIds).toContain(targetBodyCnContig.id);
    expect(pureIds).toContain(pureOverlapRec.id);
    expect(pureIds).toContain(pureUpperBoundRec.id);
    expect(pureIds).not.toContain(pureNegRec.id);
    // Exact deduped totalMatched === returned items length (no double-counting of pureOverlapRec!)
    expect(pureRes.totalMatched).toBe(pureRes.items.length);
    // Window-only hit has matchedBy: ["filter"]
    const windowOnlyHit = pureRes.items.find((i) => i.id === pureUpperBoundRec.id)!;
    expect(windowOnlyHit.matchedBy).toContain("filter");

    // Leap-year 3月1日 window (includes 2024-02-29 AND 2025-02-28) & Dec 31 <-> Jan 1 rollover
    const leapFeb29Rec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Leap day event",
      payload: { body: "Leap day maintenance." },
      occurredAt: "2024-02-29T10:00:00Z",
    });
    const nonLeapFeb28Rec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Feb 28 event",
      payload: { body: "End of February check." },
      occurredAt: "2025-02-28T10:00:00Z",
    });
    const dec31Rec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Year end freeze",
      payload: { body: "New Year freeze active." },
      occurredAt: "2025-12-31T22:00:00Z",
    });

    const mar1Res = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "3月1日",
      limit: 10,
    });
    expect(mar1Res.items.map((i) => i.id)).toContain(leapFeb29Rec.id);
    expect(mar1Res.items.map((i) => i.id)).toContain(nonLeapFeb28Rec.id);

    const jan1Res = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "2026-01-01",
      limit: 10,
    });
    expect(jan1Res.items.map((i) => i.id)).toContain(dec31Rec.id);

    // Two dates in one query: OR'd in candidate passes, scored separately
    const twoDatesRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "2026-01-01 2024-02-29",
      limit: 10,
    });
    expect(twoDatesRes.interpretedDates).toEqual(["2026-01-01", "2024-02-29"]);
    expect(twoDatesRes.items.map((i) => i.id)).toContain(dec31Rec.id);
    expect(twoDatesRes.items.map((i) => i.id)).toContain(leapFeb29Rec.id);

    // show --around "10月10日" remains 100% unchanged (opt-in extractDates=false!)
    const longRec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Long dated log",
      payload: {
        body: `${"Padding section text. ".repeat(220)}关键节点：10月10日完成切换。${"Trailing section text. ".repeat(220)}`,
      },
      occurredAt: "2026-11-01T10:00:00Z",
    });
    const showAroundDate = await eng.sea.show({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      ref: longRec.id,
      around: "10月10日",
      chars: 600,
    });
    expect(showAroundDate.refType).toBe("entry");
    if (showAroundDate.refType === "entry") {
      expect(showAroundDate.window.aroundMatched).toBe(true);
      expect(showAroundDate.content).toContain("10月10日完成切换");
    }

    // ISO-year upper-bound UTC inclusivity: 2026-10-10T23:00:00Z MUST match query "2026-10-10"
    const lateUtcRec = await eng.ledger.appendRecord({
      actor: humanAdmin,
      viewerRealmId: rootRealm.id,
      realmId: rootRealm.id,
      kind: "finding",
      title: "Late UTC deploy note",
      payload: { body: "Deployed late in UTC day." },
      occurredAt: "2026-10-10T23:00:00Z",
    });
    const lateUtcRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "2026-10-10",
      limit: 20,
    });
    expect(lateUtcRes.items.map((i) => i.id)).toContain(lateUtcRec.id);

    // Non-date query stays byte-identical (no interpretedDates key, no dates= header)
    const nonDateRes = await eng.sea.search({
      actor: agentWorker,
      viewerRealmId: rootRealm.id,
      query: "hotfix",
    });
    expect("interpretedDates" in nonDateRes).toBe(false);
    expect(formatSearchMarkdown(nonDateRes)).not.toContain("dates=");
  });
});
