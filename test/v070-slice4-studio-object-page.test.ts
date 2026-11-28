import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SHELL_CSS,
  DEFAULT_SHELL_HTML,
  DEFAULT_SHELL_JS,
  startMindServer,
  STRICT_UI_CSP,
  type Actor,
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

describe("v0.7.0 Commit 4: Studio Center Object Page, Linear SVG Signal Bar, L3 Freshness UI & URL Back-Nav", () => {
  it("1. Keeps UI shell assets synchronized, valid JS, zero raw HTML sinks, zero emojis, and enforces Center Object Page & URL back-nav contracts", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve("scripts/generate-ui-assets.mjs"),
      "--check",
    ]);
    expect(stdout).toContain("in sync");

    expect(() =>
      new vm.Script(DEFAULT_SHELL_JS.replace(/^import\s+.*$/gm, "")),
    ).not.toThrow();

    expect(DEFAULT_SHELL_JS).not.toMatch(
      /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML\s*\(|document\.write\s*\(/,
    );
    expect(DEFAULT_SHELL_JS).not.toMatch(
      /createElement\s*\(\s*["']select["']\s*\)/,
    );
    expect(DEFAULT_SHELL_JS).not.toMatch(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    );

    // Center Object Page core elements & V1–V7 markers
    for (const marker of [
      "center-object-page",
      "object-page-header",
      "object-crumb-realm",
      "object-inspector-toggle",
      "object-signal-bar",
      "signal-rules-btn",
      "signal-pending-btn",
      "signal-peers-btn",
      "object-rules-panel",
      "object-pending-decisions",
      "object-active-decisions",
      "object-decisions-expand",
      "object-narrative-card",
      "narrative-nonbinding-tag",
      "card-freshness-badge",
      "hard-stale-banner",
      "hard-stale-expand-btn",
      "include_stale_narrative",
      "object-relations",
      "object-record-stream",
      "object-load-more-entries",
      "entry-object-chip",
      "buildObjectPage",
    ]) {
      expect(DEFAULT_SHELL_JS).toContain(marker);
    }

    for (const cssCls of [
      ".object-page-canvas",
      ".object-signal-bar",
      ".signal-pill",
      ".object-rules-panel",
      ".object-narrative-section",
      ".freshness-badge",
      ".hard-stale-banner",
      ".entry-object-chip",
    ]) {
      expect(DEFAULT_SHELL_CSS).toContain(cssCls);
    }

    // Default inspector collapsed when opening an Object Page
    expect(DEFAULT_SHELL_JS).toContain(
      "async function selectObjectByRef(objRef, openInspector = false",
    );

    // URL preservation: ?object= and ?entry= can coexist (no else-if drop)
    expect(DEFAULT_SHELL_JS).not.toMatch(
      /sp\.set\("entry"[\s\S]{0,160}else if\s*\(state\.selectedObject\?\.ref\)/,
    );

    // Cookie session safety: zero settle or rule link/unlink mutation calls in Studio shell
    expect(DEFAULT_SHELL_JS).not.toContain("/v1/settle");
    expect(DEFAULT_SHELL_JS).not.toContain("client.settle");
    expect(DEFAULT_SHELL_JS).not.toContain("/v1/objects/link");
    expect(DEFAULT_SHELL_JS).not.toContain("/v1/objects/unlink");
  });

  it("2. Serves deep-link /<realm>?object=... with strict CSP, enforces Cookie 403 on POST /v1/settle, and returns visibility-scoped objectRefs without sibling leaks", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v070-studio-obj-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const engine = srv.engine;
    const org = engine.db.listOrgs()[0]!;
    const rootRealm = engine.db.getRealmByPath(org.id, "/")!;
    // Switch to tree policy for sibling isolation verification
    engine.db.updateOrgPolicy(org.id, "tree");

    const humanAlice: Actor = { id: "alice", kind: "human" };
    const agentB2: Actor = { id: "agent-b2", kind: "agent" };

    const b1 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "b1",
      name: "Branch B1",
    });
    const b2 = engine.ledger.createRealm({
      actor: humanAlice,
      orgId: org.id,
      parentId: rootRealm.id,
      slug: "b2",
      name: "Branch B2",
    });

    const parentObj = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "project",
      name: "platform",
    });
    const apiObj = engine.objects.createObject({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      kind: "service",
      name: "api",
      parentObjectId: parentObj.id,
    });
    const secretB2Obj = engine.objects.createObject({
      actor: agentB2,
      viewerRealmId: b2.id,
      kind: "service",
      name: "b2-secret-svc",
    });

    const rootRec = await engine.ledger.appendRecord({
      actor: humanAlice,
      viewerRealmId: rootRealm.id,
      targetRealmId: rootRealm.id,
      kind: "decision",
      title: "Use strict rate limits on API",
      payload: { body: "Enforce 100 rps per tenant." },
      objectIds: [apiObj.id],
    });
    // Also link secret B2 object to a B2 record (must never leak to B1!)
    await engine.ledger.appendRecord({
      actor: agentB2,
      viewerRealmId: b2.id,
      targetRealmId: b2.id,
      kind: "finding",
      title: "B2_SECRET_TITLE_SHOULD_NOT_LEAK",
      payload: { body: "Private B2 note" },
      objectIds: [apiObj.id, secretB2Obj.id],
    });

    // SPA deep-link serves official shell with strict CSP
    const deepRes = await fetch(`${srv.url}/b1?object=service:api`);
    expect(deepRes.status).toBe(200);
    expect(deepRes.headers.get("content-security-policy")).toBe(STRICT_UI_CSP);
    expect(await deepRes.text()).toBe(DEFAULT_SHELL_HTML);

    // Exchange single-use login code for B1 human Cookie session
    const b1Tok = srv.createToken({
      actorId: "b1-human",
      actorKind: "human",
      boundRealmId: b1.id,
    });
    const mintRes = await fetch(`${srv.url}/v1/ui/login-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${b1Tok.token}` },
    });
    expect(mintRes.status).toBe(200);
    const login = (await mintRes.json()) as { code: string };
    const authRes = await new Promise<{ status: number; setCookie: string }>((resolve, reject) => {
      const req = http.get(
        `${srv.url}/_meru/auth?code=${encodeURIComponent(login.code)}`,
        {
          headers: {
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
        },
        (res) => {
          res.resume();
          const sc = Array.isArray(res.headers["set-cookie"])
            ? res.headers["set-cookie"][0] ?? ""
            : res.headers["set-cookie"] ?? "";
          resolve({ status: res.statusCode ?? 0, setCookie: sc });
        },
      );
      req.on("error", reject);
    });
    expect(authRes.status).toBe(302);
    const cookie = authRes.setCookie.split(";")[0]!;
    expect(cookie).toContain("meru_session=");

    // Cookie session POST /v1/settle MUST return 403
    const settleRes = await fetch(`${srv.url}/v1/settle`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: srv.url,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        layer: "card_object",
        about: "service:api",
        narrativeMd: "Attempt via cookie",
      }),
    });
    expect(settleRes.status).toBe(403);

    // B1 reader fetching GET /v1/show?ref=service:api sees parentRef + rootRec, ZERO B2 titles/objects
    const showObjRes = await fetch(
      `${srv.url}/v1/show?ref=${encodeURIComponent("service:api")}`,
      { headers: { Cookie: cookie } },
    );
    expect(showObjRes.status).toBe(200);
    const showObjText = await showObjRes.text();
    expect(showObjText).not.toContain("B2_SECRET_TITLE_SHOULD_NOT_LEAK");
    expect(showObjText).not.toContain("b2-secret-svc");
    const showObjJson = JSON.parse(showObjText) as {
      refType: string;
      card: {
        ref: string;
        parentRef?: string;
        activeDecisions: { items: Array<{ id: string }> };
      };
    };
    expect(showObjJson.refType).toBe("object");
    expect(showObjJson.card.parentRef).toBe("project:platform");
    expect(showObjJson.card.activeDecisions.items.map((x) => x.id)).toContain(
      rootRec.id,
    );

    // GET /v1/ls?ref=service:api returns objectRefs for visible apiObj only
    const lsObjRes = await fetch(
      `${srv.url}/v1/ls?ref=${encodeURIComponent("service:api")}`,
      { headers: { Cookie: cookie } },
    );
    expect(lsObjRes.status).toBe(200);
    const lsObjJson = (await lsObjRes.json()) as {
      items: Array<{ id: string; objectRefs?: Array<{ ref: string }> }>;
    };
    const rootItem = lsObjJson.items.find((i) => i.id === rootRec.id);
    expect(rootItem?.objectRefs?.map((o) => o.ref)).toEqual(["service:api"]);

    // GET /v1/show?ref=<rec_id> returns objectRefs for visible apiObj only
    const showRecRes = await fetch(
      `${srv.url}/v1/show?ref=${encodeURIComponent(rootRec.id)}`,
      { headers: { Cookie: cookie } },
    );
    expect(showRecRes.status).toBe(200);
    const showRecJson = (await showRecRes.json()) as {
      entry: { objectRefs?: Array<{ ref: string }> };
    };
    expect(showRecJson.entry.objectRefs?.map((o) => o.ref)).toEqual([
      "service:api",
    ]);
  });
});
