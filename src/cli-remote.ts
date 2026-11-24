import fs from "node:fs";
import {
  formatChangesMarkdown,
  formatDoctorMarkdown,
  formatGenericMarkdown,
  formatLsMarkdown,
  formatSearchMarkdown,
  formatShowMarkdown,
  formatTreeMarkdown,
  formatWhoamiMarkdown,
  MindError,
  RemoteMindSurface,
  runRealmDoctor,
  type LsOnlyFilter,
  type MountScope,
  type OrgPolicy,
  type SeabedKind,
  type Sensitivity,
} from "./index.js";

export interface RemoteCliDispatchParams {
  baseUrl: string;
  token: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  multiFlags: Record<string, string[]>;
  workspaceHint: string | null;
  output: (data: unknown, markdown?: string) => void;
}

function str(
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function reqStr(
  flags: Record<string, string | boolean>,
  key: string,
  cmdLabel: string,
): string {
  const v = str(flags, key);
  if (!v) {
    throw new MindError(
      "INVALID_INPUT",
      `Missing required flag --${key} for "${cmdLabel}"`,
    );
  }
  return v;
}

function bool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

function multi(multiFlags: Record<string, string[]>, key: string): string[] {
  return (multiFlags[key] ?? []).map((s) => s.trim()).filter(Boolean);
}

function intFlag(
  flags: Record<string, string | boolean>,
  key: string,
): number | undefined {
  const raw = str(flags, key);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) {
    throw new MindError("INVALID_INPUT", `Flag --${key} must be an integer`);
  }
  return n;
}

/**
 * Dispatches CLI commands to a remote `meru-mind serve` instance through `RemoteMindSurface`.
 * Strictly forbids `--as-human` (remote actor identity is fixed by the server token).
 */
export async function runRemoteCliCommand(
  params: RemoteCliDispatchParams,
): Promise<void> {
  const { baseUrl, token, positionals, flags, multiFlags, workspaceHint, output } =
    params;

  if (bool(flags, "as-human") || str(flags, "actor-kind")) {
    throw new MindError(
      "INVALID_INPUT",
      "--as-human and --actor-kind are local-only and cannot be used against a remote server. Remote actor identity is fixed by your server token.",
      {
        try: `MERU_MIND_URL=${baseUrl} MERU_MIND_TOKEN=<human-token> meru-mind ${positionals.join(" ")}`,
      },
    );
  }

  const [cmd, sub, third] = positionals;
  const surface = await RemoteMindSurface.connect({
    baseUrl,
    token,
    workspaceHint,
  });

  try {
    if (cmd === "whoami") {
      const res = await surface.whoami();
      output(res, formatWhoamiMarkdown(res));
      return;
    }

    if (cmd === "tree") {
      const depthRaw = str(flags, "depth");
      const depth: number | "all" | undefined =
        depthRaw === undefined
          ? undefined
          : depthRaw.toLowerCase() === "all"
            ? "all"
            : Number.parseInt(depthRaw, 10);
      const res = await surface.tree({
        ref: sub,
        depth,
        includeObjects: bool(flags, "no-objects") ? false : true,
        limit: intFlag(flags, "limit"),
      });
      output(res, formatTreeMarkdown(res));
      return;
    }

    if (cmd === "ls") {
      const res = await surface.ls({
        ref: sub,
        only: str(flags, "only") as LsOnlyFilter | undefined,
        kind: str(flags, "kind"),
        about: str(flags, "about"),
        since: str(flags, "since"),
        until: str(flags, "until"),
        history: bool(flags, "history"),
        includeDescendantSeabed: bool(flags, "include-descendant-seabed"),
        limit: intFlag(flags, "limit"),
        cursor: str(flags, "cursor"),
      });
      output(res, formatLsMarkdown(res));
      return;
    }

    if (cmd === "show") {
      if (!sub?.trim()) {
        throw new MindError("INVALID_REF", "show requires a <ref> argument");
      }
      const res = await surface.show({
        ref: sub.trim(),
        around: str(flags, "around"),
        cursor: str(flags, "cursor"),
        chars: intFlag(flags, "chars"),
        full: bool(flags, "full"),
        history: bool(flags, "history"),
        context: intFlag(flags, "context"),
        includeDescendantSeabed: bool(flags, "include-descendant-seabed"),
      });
      output(res, formatShowMarkdown(res));
      return;
    }

    if (cmd === "search") {
      const query = positionals.slice(1).join(" ").trim();
      if (!query) {
        throw new MindError("INVALID_INPUT", "search requires a <query>");
      }
      const res = await surface.search({
        query,
        in: str(flags, "in"),
        about: str(flags, "about"),
        kind: str(flags, "kind"),
        since: str(flags, "since"),
        until: str(flags, "until"),
        history: bool(flags, "history"),
        includeDescendantSeabed: bool(flags, "include-descendant-seabed"),
        limit: intFlag(flags, "limit"),
        cursor: str(flags, "cursor"),
      });
      output(res, formatSearchMarkdown(res));
      return;
    }

    if (cmd === "changes") {
      const res = await surface.changes({
        sinceSeq: intFlag(flags, "since") ?? 0,
        in: str(flags, "in") ?? sub,
        limit: intFlag(flags, "limit"),
        includeDescendantSeabed: bool(flags, "include-descendant-seabed"),
        waitSeconds: intFlag(flags, "wait"),
      });
      output(res, formatChangesMarkdown(res));
      return;
    }

    if (cmd === "write") {
      const rawOcc = str(flags, "occurred-at");
      const occurredAt =
        rawOcc === undefined
          ? undefined
          : rawOcc === "none" || rawOcc === "null"
            ? null
            : rawOcc;
      const res = await surface.write({
        in: str(flags, "in"),
        title: reqStr(flags, "title", "write"),
        body: reqStr(flags, "body", "write"),
        kind: str(flags, "kind"),
        about: multi(multiFlags, "about"),
        supersedes: multi(multiFlags, "supersedes"),
        because: multi(multiFlags, "because"),
        occurredAt,
        sensitivity: str(flags, "sensitivity") as Sensitivity | undefined,
        idempotencyKey: str(flags, "idempotency-key"),
        workspaceHint,
      });
      output(
        {
          ...res.record,
          routedBy: res.routedBy,
          ...(res.relatedActive ? { relatedActive: res.relatedActive } : {}),
          ...(res.collisionHints ? { collisionHints: res.collisionHints } : {}),
        },
        formatGenericMarkdown(
          `Written [${res.record.kind}] (routed: ${res.routedBy})`,
          res,
        ),
      );
      return;
    }

    if (cmd === "entry" && sub === "move") {
      const idsFromPos = positionals.slice(2).map((s) => s.trim()).filter(Boolean);
      const idsFile = str(flags, "ids-file");
      const idsFromFile: string[] = [];
      if (idsFile) {
        const raw =
          idsFile === "-"
            ? fs.readFileSync(0, "utf8")
            : fs.readFileSync(idsFile, "utf8");
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          for (const tok of trimmed.split(/\s+/)) {
            if (tok) idsFromFile.push(tok);
          }
        }
      }
      const entryIds = Array.from(new Set([...idsFromPos, ...idsFromFile]));
      if (entryIds.length === 0) {
        throw new MindError(
          "INVALID_INPUT",
          "entry move requires one or more <entryId> arguments or --ids-file <path|->",
        );
      }
      const targetRealmRef = reqStr(flags, "to", "entry move");
      const expectedFromRealmRef = str(flags, "from");
      const dryRun = bool(flags, "dry-run");
      const BATCH_SIZE = 250;
      const allMoved: Array<{
        id: string;
        entityType: "record" | "seabed";
        fromRealmId: string;
        fromRealmPath: string;
        toRealmId: string;
        toRealmPath: string;
        chainExpanded?: boolean;
      }> = [];
      const seenMovedIds = new Set<string>();
      const seenSkippedIds = new Set<string>();
      const allSkipped: string[] = [];
      let targetRealmId = "";
      let targetRealmPath = "";
      let batches = 0;
      for (let i = 0; i < entryIds.length; i += BATCH_SIZE) {
        const chunk = entryIds.slice(i, i + BATCH_SIZE);
        const part = await surface.move({
          entryIds: chunk,
          targetRealmRef,
          expectedFromRealmRef,
          dryRun,
        });
        targetRealmId = part.targetRealmId;
        targetRealmPath = part.targetRealmPath;
        for (const item of part.moved) {
          if (!seenMovedIds.has(item.id)) {
            seenMovedIds.add(item.id);
            allMoved.push(item);
          }
        }
        for (const id of part.skippedAlreadyInTargetIds) {
          if (!seenMovedIds.has(id) && !seenSkippedIds.has(id)) {
            seenSkippedIds.add(id);
            allSkipped.push(id);
          }
        }
        batches += 1;
      }
      const merged = {
        dryRun,
        targetRealmId,
        targetRealmPath,
        moved: allMoved,
        skippedAlreadyInTargetIds: allSkipped,
        ...(batches > 1 ? { batches } : {}),
      };
      output(merged, formatGenericMarkdown("Moved Entries", merged));
      return;
    }

    if (cmd === "rule" && sub === "add") {
      const res = await surface.addRule({
        in: reqStr(flags, "in", "rule add"),
        title: reqStr(flags, "title", "rule add"),
        body: reqStr(flags, "body", "rule add"),
        supersedes: multi(multiFlags, "supersedes"),
        because: multi(multiFlags, "because"),
        idempotencyKey: str(flags, "idempotency-key"),
      });
      output(res, formatGenericMarkdown("Rule Added", res));
      return;
    }

    if (cmd === "redact") {
      if (!sub?.trim()) {
        throw new MindError("INVALID_REF", "redact requires <entryId>");
      }
      const res = await surface.redact({
        entryId: sub.trim(),
        reason: str(flags, "reason"),
      });
      output(res, formatGenericMarkdown("Redacted", res));
      return;
    }

    if (cmd === "raw" && sub === "add") {
      const res = await surface.rawAdd({
        in: str(flags, "in"),
        kind: (str(flags, "kind") ?? "message") as SeabedKind,
        text: reqStr(flags, "text", "raw add"),
        topicId: str(flags, "topic"),
        sourceRef: str(flags, "source-ref"),
        sensitivity: str(flags, "sensitivity") as Sensitivity | undefined,
        idempotencyKey: str(flags, "idempotency-key"),
        workspaceHint,
      });
      output(res, formatGenericMarkdown("Raw Entry Added", res));
      return;
    }

    if (cmd === "realm") {
      if (sub === "create") {
        const res = await surface.createRealm({
          parentRef: str(flags, "parent") ?? "/",
          slug: reqStr(flags, "slug", "realm create"),
          name: reqStr(flags, "name", "realm create"),
          scope: reqStr(flags, "scope", "realm create"),
        });
        output(res, formatGenericMarkdown("Realm Created", res));
        return;
      }
      if (sub === "set") {
        if (!third?.trim()) {
          throw new MindError("INVALID_INPUT", "Missing <realmRef> for 'realm set'", {
            try: 'meru-mind realm set /ops --scope "Include: ... Exclude: ..."',
          });
        }
        const res = await surface.updateRealm({
          ref: third.trim(),
          name: str(flags, "name"),
          scope: str(flags, "scope"),
        });
        output(res, formatGenericMarkdown("Realm Updated", res));
        return;
      }
      if (sub === "mount") {
        const res = await surface.mountRealm({
          viewerRef: reqStr(flags, "viewer", "realm mount"),
          targetRef: reqStr(flags, "target", "realm mount"),
          scope: str(flags, "scope") as MountScope | undefined,
        });
        output(res, formatGenericMarkdown("Realm Mounted", res));
        return;
      }
      if (sub === "unmount") {
        const unmounted = await surface.unmountRealm({
          viewerRef: reqStr(flags, "viewer", "realm unmount"),
          targetRef: reqStr(flags, "target", "realm unmount"),
        });
        output({ unmounted }, formatGenericMarkdown("Realm Unmounted", { unmounted }));
        return;
      }
      if (sub === "archive") {
        if (!third?.trim()) {
          throw new MindError("INVALID_REF", "realm archive requires <realm>");
        }
        const res = await surface.archiveRealm({ ref: third.trim() });
        output(res, formatGenericMarkdown("Realm Archived", res));
        return;
      }
      if (sub === "unarchive") {
        if (!third?.trim()) {
          throw new MindError("INVALID_REF", "realm unarchive requires <realm>");
        }
        const res = await surface.unarchiveRealm({ ref: third.trim() });
        output(res, formatGenericMarkdown("Realm Unarchived", res));
        return;
      }
    }

    if (cmd === "org" && sub === "set-policy") {
      const res = await surface.setOrgPolicy({
        policy: reqStr(flags, "policy", "org set-policy") as OrgPolicy,
      });
      output(res, formatGenericMarkdown("Organization Policy Updated", res));
      return;
    }

    if (cmd === "token") {
      if (sub === "create") {
        const res = await surface.createToken({
          actorId: reqStr(flags, "actor-id", "token create"),
          actorKind: reqStr(flags, "kind", "token create") as "human" | "agent",
          actorFamily: str(flags, "family"),
          boundRealmRef: str(flags, "in"),
          label: str(flags, "label"),
        });
        output(
          res,
          formatGenericMarkdown(
            "Token Created (plaintext shown ONCE — store securely)",
            res,
          ),
        );
        return;
      }
      if (sub === "list") {
        const res = await surface.listTokens({
          includeRevoked: bool(flags, "all"),
        });
        output(res, formatGenericMarkdown("Auth Tokens", res));
        return;
      }
      if (sub === "revoke") {
        if (!third?.trim()) {
          throw new MindError("INVALID_INPUT", "token revoke requires <tokenId>");
        }
        const revoked = await surface.revokeToken({ tokenId: third.trim() });
        output({ tokenId: third.trim(), revoked }, formatGenericMarkdown("Token Revoked", { tokenId: third.trim(), revoked }));
        return;
      }
    }

    if (cmd === "work") {
      if (sub === "bind") {
        let config: Record<string, unknown> = {};
        const rawConfig = str(flags, "config");
        if (rawConfig) {
          try {
            const parsed = JSON.parse(rawConfig) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("must be a JSON object");
            }
            config = parsed as Record<string, unknown>;
          } catch (err) {
            throw new MindError(
              "INVALID_INPUT",
              `Invalid --config JSON: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        const provider = reqStr(flags, "provider", "work bind");
        const team = str(flags, "team");
        const project = str(flags, "project");
        const repo = str(flags, "repo");
        const tokenEnv = str(flags, "token-env");
        if (team) config.teamKey = team;
        if (project) config.projectSlug = project;
        if (repo) {
          const slash = repo.indexOf("/");
          if (slash > 0 && slash < repo.length - 1) {
            config.owner = repo.slice(0, slash);
            config.repo = repo.slice(slash + 1);
          } else {
            config.repo = repo;
          }
        }
        if (tokenEnv) {
          const envRef = tokenEnv.startsWith("env:")
            ? tokenEnv
            : `env:${tokenEnv}`;
          if (provider === "linear") {
            config.apiKeyRef = envRef;
          } else {
            config.tokenRef = envRef;
          }
        }
        const res = await surface.bindWork({
          realmRef: reqStr(flags, "in", "work bind"),
          provider,
          config,
        });
        output(res, formatGenericMarkdown("Work Provider Bound", res));
        return;
      }
      if (sub === "unbind") {
        const realmRef = reqStr(flags, "in", "work unbind");
        const unbound = await surface.unbindWork({ realmRef });
        output({ realmRef, unbound }, formatGenericMarkdown("Work Provider Unbound", { realmRef, unbound }));
        return;
      }
      if (sub === "list") {
        const bindings = await surface.listWorkBindings();
        output(bindings, formatGenericMarkdown("Work Provider Bindings", bindings));
        return;
      }
      if (sub === "ready") {
        const res = await surface.listReadyWork({
          realmRef: str(flags, "in"),
          limit: intFlag(flags, "limit"),
          cursor: str(flags, "cursor"),
        });
        output(res, formatGenericMarkdown("Ready Work Items", res));
        return;
      }
      if (sub === "resolve") {
        const items = positionals.slice(2).filter(Boolean);
        if (items.length === 0) {
          throw new MindError(
            "INVALID_INPUT",
            "work resolve requires one or more <itemRef> arguments",
          );
        }
        const res = await surface.resolveWork({
          realmRef: str(flags, "in"),
          items,
        });
        output(res, formatGenericMarkdown("Resolved Work Items", res));
        return;
      }
    }

    if (cmd === "admin" && sub === "doctor") {
      const treeRes = await surface.tree({
        depth: "all",
        includeObjects: true,
      });
      const report = runRealmDoctor(treeRes);
      output(report, formatDoctorMarkdown(report));
      return;
    }

    if (cmd === "admin" && sub === "backup") {
      const targetUrl = `${baseUrl.replace(/\/+$/, "")}/v1/admin/backup`;
      const name = str(flags, "name");
      const resp = await fetch(targetUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(name ? { name } : {}),
      });
      const text = await resp.text();
      let payload: Record<string, unknown> = {};
      if (text) {
        try {
          payload = JSON.parse(text) as Record<string, unknown>;
        } catch {
          payload = { message: text };
        }
      }
      if (!resp.ok) {
        throw new MindError(
          resp.status === 401 || resp.status === 403 ? "ACCESS_DENIED" : "INVALID_INPUT",
          typeof payload.message === "string"
            ? payload.message
            : `Remote backup failed (HTTP ${resp.status})`,
        );
      }
      output(payload, formatGenericMarkdown("Online Server Backup Created", payload));
      return;
    }

    throw new MindError(
      "UNKNOWN_COMMAND",
      `Command "${positionals.join(" ")}" is not supported in remote HTTP mode`,
      { try: "meru-mind --help" },
    );
  } finally {
    await surface.close();
  }
}
