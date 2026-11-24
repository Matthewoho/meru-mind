import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractDeterministicKeysFromText,
  MindPulseStore,
  normalizeDeterministicKey,
  normalizeTargetKeys,
  RemoteMindSurface,
  startMindServer,
  type InFlightWorkGroup,
  type MindServerHandle,
  type PulseDeclareResult,
  type PulseListResult,
} from "../src/index.js";

const openServers: MindServerHandle[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (openServers.length > 0) {
    const srv = openServers.pop()!;
    await srv.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("v0.5.6 MindPulse v3 — Work-Indexed Push Radar, Session State Machine & Hooks", () => {
  it("1. Deterministic key normalization reuses parseLocator, extracts embedded branch issue keys, and rejects freeform/false-positive strings", () => {
    expect(
      normalizeDeterministicKey("https://linear.app/acme/issue/eng-42/fix-login"),
    ).toBe("work:linear:ENG-42");
    expect(normalizeDeterministicKey("ENG-42")).toBe("work:linear:ENG-42");
    expect(normalizeDeterministicKey("issue:ENG-42")).toBe("work:linear:ENG-42");

    expect(
      normalizeDeterministicKey("https://github.com/Matthewoho/meru-mind/pull/18"),
    ).toBe("work:github:matthewoho/meru-mind#18");
    expect(normalizeDeterministicKey("Matthewoho/meru-mind#18")).toBe(
      "work:github:matthewoho/meru-mind#18",
    );

    expect(normalizeDeterministicKey("service:auth")).toBe("service:auth");
    expect(normalizeDeterministicKey("alert:4044")).toBe("alert:4044");
    expect(normalizeDeterministicKey("file:pulse.ts")).toBe("file:pulse.ts");
    expect(normalizeDeterministicKey("file:../etc/passwd")).toBeNull();

    // Default branches and freeform slugs are NOT matchable keys
    expect(normalizeDeterministicKey("meru-mind@main")).toBeNull();
    expect(normalizeDeterministicKey("fixing login bug")).toBeNull();
    expect(normalizeDeterministicKey("/projects/meru")).toBeNull();

    // Branch containing issue key yields BOTH branch key and canonical Linear key
    expect(normalizeTargetKeys(["meru-mind@fix/eng-42-auth"])).toEqual([
      "branch:meru-mind@fix/eng-42-auth",
      "work:linear:ENG-42",
    ]);

    // Text extractor ignores UTF-8 / SHA-256 / HTTP-2 / NODE-22 false positives
    const extracted = extractDeterministicKeysFromText(
      "Fix ENG-42 using UTF-8, SHA-256, HTTP-2 on NODE-22 and check service:auth + alert:4044",
    );
    expect(extracted).toContain("work:linear:ENG-42");
    expect(extracted).toContain("service:auth");
    expect(extracted).toContain("alert:4044");
    expect(extracted.some((k) => k.includes("UTF") || k.includes("SHA") || k.includes("HTTP") || k.includes("NODE"))).toBe(false);
  });

  it("2. Primary proof case + tree-mode negative control + same-principal parent collaborator anti-spoof", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v056-radar-"),
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
      slug: "eng",
      name: "Engineering",
      scope: "Include: eng.",
    });
    await admin.createRealm({
      parentRef: "/",
      slug: "a",
      name: "Branch A",
      scope: "Include: A.",
    });
    await admin.createRealm({
      parentRef: "/",
      slug: "b",
      name: "Branch B",
      scope: "Include: B.",
    });

    const tokA = await admin.createToken({
      actorId: "alice",
      actorKind: "agent",
      boundRealmRef: "/eng",
    });
    const tokB = await admin.createToken({
      actorId: "bob",
      actorKind: "agent",
      boundRealmRef: "/eng",
    });
    const tokUnkeyed = await admin.createToken({
      actorId: "charlie",
      actorKind: "agent",
      boundRealmRef: "/eng",
    });

    // Charlie is unkeyed in /eng (creates a visible blind-spot count)
    await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokUnkeyed.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: "charlie-1",
        realmRef: "/eng",
        note: "exploring codebase",
      }),
    });

    // Alice works on branch `meru-mind@fix/eng-42-auth` (zero manual Linear registration!)
    const aliceRes = (await (
      await fetch(`${srv.url}/v1/pulse`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokA.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "alice-main",
          realmRef: "/eng",
          clientHint: "claude-code",
          note: "meru-mind@fix/eng-42-auth · auth.ts",
          mode: "working",
          source: "hook",
          event: "heartbeat",
        }),
      })
    ).json()) as PulseDeclareResult;
    expect(aliceRes.keys).toContain("work:linear:ENG-42");
    expect(aliceRes.state).toBe("working");

    // Alice spawns a sub-session (`parentSessionId: "alice-main"`) on the SAME task -> collaborator, NOT collision!
    const aliceChildRes = (await (
      await fetch(`${srv.url}/v1/pulse`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokA.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "alice-sub-1",
          parentSessionId: "alice-main",
          realmRef: "/eng",
          clientHint: "claude-code",
          keys: ["ENG-42"],
          mode: "working",
          source: "hook",
          event: "heartbeat",
        }),
      })
    ).json()) as PulseDeclareResult;
    expect(aliceChildRes.parentSessionId).toBe(aliceRes.sessionId);
    expect(aliceChildRes.rootSessionId).toBe(aliceRes.sessionId);
    expect(aliceChildRes.overlaps.length).toBe(0);

    // Pre-dispatch check before Bob joins -> workingRoots is STILL 1 (parent+child share 1 root), hasCollision === false
    const preList = (await (
      await fetch(`${srv.url}/v1/pulse?match=ENG-42&mode=working`, {
        headers: { Authorization: `Bearer ${adminTok.token}` },
      })
    ).json()) as PulseListResult;
    const eng42Group = preList.inFlight.find(
      (g: InFlightWorkGroup) => g.key === "work:linear:ENG-42",
    );
    expect(eng42Group).toBeDefined();
    expect(eng42Group!.participants.length).toBe(2);
    expect(eng42Group!.workingRoots).toBe(1);
    expect(eng42Group!.hasCollision).toBe(false);
    expect(preList.overlaps?.length).toBe(2);

    // Bob tries to spoof `parentSessionId: "alice-main"` from a DIFFERENT principal -> strictly ignored, sees Alice's overlap!
    const bobRes = (await (
      await fetch(`${srv.url}/v1/pulse`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokB.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "bob-1",
          parentSessionId: "alice-main",
          realmRef: "/eng",
          clientHint: "codex",
          keys: ["https://linear.app/acme/issue/ENG-42/auth-timeout"],
          mode: "working",
          source: "hook",
          event: "turn_start",
        }),
      })
    ).json()) as PulseDeclareResult;
    expect(bobRes.parentSessionId).toBeNull();
    expect(bobRes.overlaps.some((o) => o.actorId === "alice" && o.matchedKeys.includes("work:linear:ENG-42"))).toBe(true);
    expect(bobRes.overlaps.some((o) => o.sessionTag === "alice-main")).toBe(true);
    expect(bobRes.unkeyedPeers).toBe(1);

    // In-flight index now flags `hasCollision === true` (2 independent roots working on ENG-42)
    const postList = (await (
      await fetch(`${srv.url}/v1/pulse`, {
        headers: { Authorization: `Bearer ${adminTok.token}` },
      })
    ).json()) as PulseListResult;
    const eng42After = postList.inFlight.find((g) => g.key === "work:linear:ENG-42");
    expect(eng42After!.workingRoots).toBe(2);
    expect(eng42After!.hasCollision).toBe(true);

    // Tree-mode negative control: isolated sibling /a working on ENG-99 is COMPLETELY invisible to /b
    await admin.setOrgPolicy({ policy: "tree" });
    const tokBranchA = await admin.createToken({
      actorId: "sib-a",
      actorKind: "agent",
      boundRealmRef: "/a",
    });
    const tokBranchB = await admin.createToken({
      actorId: "sib-b",
      actorKind: "agent",
      boundRealmRef: "/b",
    });

    // Baseline response for /b BEFORE /a exists
    const bBefore = (await (
      await fetch(`${srv.url}/v1/pulse?match=ENG-99`, {
        headers: { Authorization: `Bearer ${tokBranchB.token}` },
      })
    ).json()) as PulseListResult;

    // Now /a works on ENG-99
    await fetch(`${srv.url}/v1/pulse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokBranchA.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: "a-secret",
        realmRef: "/a",
        keys: ["ENG-99"],
        mode: "working",
        event: "heartbeat",
      }),
    });

    const bAfter = (await (
      await fetch(`${srv.url}/v1/pulse?match=ENG-99`, {
        headers: { Authorization: `Bearer ${tokBranchB.token}` },
      })
    ).json()) as PulseListResult;
    expect(bAfter.overlaps).toEqual(bBefore.overlaps);
    expect(bAfter.unkeyedPeers).toBe(bBefore.unkeyedPeers);
    expect(bAfter.inFlight).toEqual(bBefore.inFlight);

    await admin.close();
  });

  it("3. Session state machine (working -> silent -> turn_ended 24h), disposable shutdown snapshot reload, and show <object> activePeers", async () => {
    const homeDir = makeTempDir("meru-v056-snapshot-");
    const srv1 = await startMindServer({
      homeDir,
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });

    const adminTok = srv1.createToken({ actorId: "admin", actorKind: "human" });
    const admin = await RemoteMindSurface.connect({
      baseUrl: srv1.url,
      token: adminTok.token,
    });
    await admin.write({
      in: "/",
      kind: "decision",
      title: "Auth timeout baseline",
      body: "Service auth uses 30s timeout.",
      about: ["service:auth"],
    });

    const tokWorker = await admin.createToken({
      actorId: "worker-1",
      actorKind: "agent",
    });
    const tokViewer = await admin.createToken({
      actorId: "worker-2",
      actorKind: "agent",
    });

    // Worker 1 declares working on service:auth then transitions to `turn_ended` (paused overnight)
    await fetch(`${srv1.url}/v1/pulse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokWorker.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: "overnight-1",
        clientHint: "claude-code",
        keys: ["service:auth", "ENG-77"],
        note: "waiting on review",
        mode: "working",
        event: "turn_end",
        source: "hook",
      }),
    });

    // Worker 2 calls `show service:auth` -> sees Worker 1 in activePeers!
    const viewer = await RemoteMindSurface.connect({
      baseUrl: srv1.url,
      token: tokViewer.token,
      sessionId: "viewer-2",
      clientHint: "codex",
    });
    const objShow = await viewer.show({ ref: "service:auth" });
    expect(objShow.refType).toBe("object");
    if (objShow.refType === "object") {
      expect(objShow.activePeers?.some((p) => p.actorId === "worker-1" && p.state === "turn_ended")).toBe(true);
    }

    await viewer.close();
    await admin.close();
    await srv1.close();

    // Snapshot file exists cleanly on shutdown
    const snapPath = path.join(homeDir, "pulse-snapshot.json");
    expect(fs.existsSync(snapPath)).toBe(true);

    // Restart server on the same homeDir -> `turn_ended` session survives restart!
    const srv2 = await startMindServer({
      homeDir,
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv2);

    const afterRestart = (await (
      await fetch(`${srv2.url}/v1/pulse?match=ENG-77`, {
        headers: { Authorization: `Bearer ${adminTok.token}` },
      })
    ).json()) as PulseListResult;
    expect(afterRestart.overlaps?.some((o) => o.actorId === "worker-1" && o.state === "turn_ended")).toBe(true);

    // Unit clock test on MindPulseStore: `working` -> `silent` after 6m, `turn_ended` stays alive at 12h, expires past 24h
    const store = new MindPulseStore();
    const principal = {
      tokenId: "tok_test",
      orgId: srv2.orgId,
      actor: { id: "clock-bot", kind: "agent" as const },
      boundRealmId: srv2.engine.db.listRealms()[0]!.id,
      boundSource: "token" as const,
      authKind: "bearer" as const,
    };
    const t0 = 1_700_000_000_000;
    store.declare({
      db: srv2.engine.db,
      principal,
      sessionId: "turn-active",
      keys: ["ENG-10"],
      event: "turn_start",
      mode: "working",
      nowMs: t0,
    });
    store.declare({
      db: srv2.engine.db,
      principal,
      sessionId: "turn-paused",
      keys: ["ENG-11"],
      event: "turn_end",
      mode: "working",
      nowMs: t0,
    });

    const at6m = store.listVisible({ db: srv2.engine.db, principal, nowMs: t0 + 6 * 60_000 });
    expect(at6m.find((p) => p.sessionTag === "turn-active")?.state).toBe("silent");
    expect(at6m.find((p) => p.sessionTag === "turn-paused")?.state).toBe("turn_ended");

    const at12h = store.listVisible({ db: srv2.engine.db, principal, nowMs: t0 + 12 * 3600_000 });
    expect(at12h.find((p) => p.sessionTag === "turn-active")).toBeUndefined();
    expect(at12h.find((p) => p.sessionTag === "turn-paused")?.state).toBe("turn_ended");

    const at25h = store.listVisible({ db: srv2.engine.db, principal, nowMs: t0 + 25 * 3600_000 });
    expect(at25h.length).toBe(0);
  });

  it("4. Real harness hook scripts end-to-end: silent when quiet, framed overlap injection on UserPromptSubmit, delta suppression, auto-working on Edit, and turn-stop", async () => {
    const srv = await startMindServer({
      homeDir: makeTempDir("meru-v056-hooks-"),
      host: "127.0.0.1",
      port: 0,
      enableVector: false,
      accessLog: false,
    });
    openServers.push(srv);

    const tokA = srv.createToken({ actorId: "matthew", actorKind: "agent" });
    const tokB = srv.createToken({ actorId: "teammate", actorKind: "agent" });

    const workDir = makeTempDir("meru-v056-hook-repo-");
    fs.writeFileSync(path.join(workDir, ".meru-mind-realm"), "/\n", "utf8");
    const hooksDir = path.resolve(process.cwd(), "examples/hooks");

    const runHook = (
      script: string,
      token: string,
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
              MERU_MIND_TOKEN: token,
              MERU_MIND_CLIENT: "claude-code",
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

    const sidA = `hook-a-${Date.now()}`;
    const sidB = `hook-b-${Date.now()}`;

    // 1. Session A starts on ENG-88 -> quiet (0 stdout bytes!)
    const outA1 = await runHook("prompt-check.sh", tokA.token, {
      session_id: sidA,
      cwd: workDir,
      prompt: "Please fix ENG-88 auth timeout",
    });
    expect(outA1).toBe("");

    // 2. Session A edits auth.ts -> heartbeat.sh automatically promotes to `working` + adds `file:auth.ts`, stays quiet
    const outA2 = await runHook("heartbeat.sh", tokA.token, {
      session_id: sidA,
      cwd: workDir,
      tool_name: "Edit",
      tool_input: { file_path: path.join(workDir, "src/auth.ts") },
    });
    expect(outA2).toBe("");

    // 3. Session B receives a prompt mentioning ENG-88 -> BEFORE first tool call, gets framed `<mindpulse-radar>` naming matthew!
    const outB1 = await runHook("prompt-check.sh", tokB.token, {
      session_id: sidB,
      cwd: workDir,
      prompt: "帮我查一下 ENG-88 登录超时",
    });
    expect(outB1).toContain('<mindpulse-radar type="untrusted-peer-data">');
    expect(outB1).toContain("matthew");
    expect(outB1).toContain("work:linear:ENG-88");

    // 4. Session B repeats prompt-check with unchanged overlap -> delta suppression outputs 0 bytes!
    const outB2 = await runHook("prompt-check.sh", tokB.token, {
      session_id: sidB,
      cwd: workDir,
      prompt: "继续看看 ENG-88",
    });
    expect(outB2).toBe("");

    // 5. Session A stops turn -> transitions cleanly to `turn_ended`
    await runHook("turn-stop.sh", tokA.token, { session_id: sidA, cwd: workDir });
    const afterStop = (await (
      await fetch(`${srv.url}/v1/pulse`, {
        headers: { Authorization: `Bearer ${tokA.token}` },
      })
    ).json()) as PulseListResult;
    expect(
      afterStop.pulses.some((p) => p.sessionTag === sidA && p.state === "turn_ended"),
    ).toBe(true);

    // 6. Clean sign-off via session-end.sh
    await runHook("session-end.sh", tokA.token, { session_id: sidA, cwd: workDir });
    await runHook("session-end.sh", tokB.token, { session_id: sidB, cwd: workDir });
    const afterEnd = (await (
      await fetch(`${srv.url}/v1/pulse`, {
        headers: { Authorization: `Bearer ${tokA.token}` },
      })
    ).json()) as PulseListResult;
    expect(afterEnd.pulses.length).toBe(0);
  });
});
