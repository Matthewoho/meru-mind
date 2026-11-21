#!/usr/bin/env node
import fs from "node:fs";
import {
  createMindEngine,
  formatBriefMarkdown,
  formatCatMarkdown,
  formatChangesMarkdown,
  formatGenericMarkdown,
  formatImportJsonlMarkdown,
  formatImportMdMarkdown,
  formatLsMarkdown,
  formatObjectsMarkdown,
  formatRecallMarkdown,
  formatReplayMarkdown,
  formatTagsMarkdown,
  formatThingsMarkdown,
  formatTreeMarkdown,
  MindError,
  OPAQUE_REALM_NOT_FOUND,
  resolveRealmByPath,
  type Actor,
  type ActorKind,
  type BehaviorClass,
  type DistillationLayer,
  type JsonlMappingConfig,
  type LsTargetType,
  type MindEngine,
  type MountScope,
  type OrgPolicy,
  type RecordKind,
  type SeabedKind,
  type Sensitivity,
} from "./index.js";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "personal",
  "as-human",
  "include-superseded",
  "include-history",
  "include-descendant-seabed",
  "no-restore-drive",
  "sync-embeddings",
  "dedupe",
  "include-secret",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = true;
          continue;
        }
        if (i + 1 < argv.length) {
          flags[key] = argv[i + 1]!;
          i += 1;
        } else {
          throw new MindError("INVALID_INPUT", `Flag --${key} requires a value`);
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function parseIntFlag(
  flags: Record<string, string | boolean>,
  key: string,
  options?: { min?: number },
): number | undefined {
  const raw = flagStr(flags, key);
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new MindError(
      "INVALID_INPUT",
      `Flag --${key} must be an integer, got "${raw}"`,
    );
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (options?.min !== undefined && parsed < options.min) {
    throw new MindError(
      "INVALID_INPUT",
      `Flag --${key} must be >= ${options.min}, got ${parsed}`,
    );
  }
  return parsed;
}

function flagStr(
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const val = flags[key];
  return typeof val === "string" ? val : undefined;
}

function requireFlag(
  flags: Record<string, string | boolean>,
  key: string,
): string {
  const val = flagStr(flags, key);
  if (!val) {
    throw new MindError("INVALID_INPUT", `Missing required flag --${key}`);
  }
  return val;
}

function flagBool(
  flags: Record<string, string | boolean>,
  key: string,
): boolean {
  return flags[key] === true || flags[key] === "true";
}

function parseCsvFlag(
  flags: Record<string, string | boolean>,
  key: string,
): string[] {
  const raw = flagStr(flags, key);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePayloadJson(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("payload must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid --payload JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function resolveCliRealmId(
  engine: MindEngine,
  rawRef: string,
  orgIdFlag?: string,
): string {
  const trimmed = rawRef.trim();
  if (!trimmed.startsWith("/")) {
    return trimmed;
  }
  let orgId = orgIdFlag?.trim();
  if (!orgId) {
    const orgs = engine.ledger.listOrgs();
    if (orgs.length === 1) {
      orgId = orgs[0]!.id;
    } else {
      throw new MindError(
        "INVALID_INPUT",
        `Realm path "${trimmed}" requires --org when multiple organizations exist`,
      );
    }
  }
  const orgRealms = engine.db.listRealms(orgId);
  const found = resolveRealmByPath(orgRealms, trimmed);
  if (!found) {
    throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
  }
  return found.id;
}

function buildActor(flags: Record<string, string | boolean>): Actor {
  const id = flagStr(flags, "actor") ?? "user";
  const asHuman = flagBool(flags, "as-human");
  const rawKind = flagStr(flags, "actor-kind");
  let kind: ActorKind;

  if (asHuman) {
    if (rawKind && rawKind !== "human") {
      throw new MindError(
        "INVALID_INPUT",
        `Cannot combine --as-human with --actor-kind ${rawKind}`,
      );
    }
    kind = "human";
  } else {
    if (rawKind === "human") {
      throw new MindError(
        "INVALID_INPUT",
        "Human-privileged CLI operations require explicit --as-human",
      );
    }
    kind = (rawKind ?? "agent") as ActorKind;
  }

  if (kind !== "human" && kind !== "agent" && kind !== "system") {
    throw new MindError("INVALID_INPUT", `Invalid --actor-kind: ${kind}`);
  }
  const family = flagStr(flags, "family");
  return { id, kind, ...(family ? { family } : {}) };
}

function printUsage(): void {
  const help = `meru-mind — Scoped visibility (MindRealm) & layered memory/ledger engine (MindSea)

Behavior classes:
  rule         Human-only governance rules (--as-human required)
  conclusion   Structured ledger entries (decision, finding, claim, thing, proposal, verdict)
  raw          Immutable raw entries (message, artifact, evidence, signal)

Global flags:
  --home <dir>              Data directory (default: MERU_MIND_HOME or ~/.meru-mind)
  --drive <local|layerfs>   Drive adapter (default: local)
  --actor <id>              Actor ID (default: user)
  --actor-kind <kind>       agent | system (default: agent; use --as-human for human)
  --as-human                Explicitly elevate actor kind to human (required for rule/redact/set-policy/tree-ops)
  --family <name>           Model family for agent actors (e.g. claude, gemini, deepseek)
  --org <orgId>             Organization ID (for resolving realm paths like /ops/cicd)
  --json                    Print stable JSON output (default output is compact Markdown)

Commands:
  init [--org <name>] [--personal] [--policy open|tree]
  org create --name <name> [--personal] [--policy open|tree]
  org set-policy --org <orgId> --policy open|tree --as-human
  org list
  realm create --org <orgId> --parent <realmId> --slug <slug> --name <name> [--as-human]
  realm list --org <orgId> [--viewer <realmId>]
  mount --viewer <realmId> --target <realmId> [--scope all|ledger|drive] [--as-human]
  unmount --viewer <realmId> --target <realmId> [--as-human]

  write --class rule|conclusion|raw --realm <id|path> [--kind <kind>] [--title <title>] [--text <text>] [--payload <json>] [--refs <a,b>] [--objects <a,b>] [--tags <type:name,...>] [--supersedes <id>] [--thing <id>] [--external-ref <ref>] [--source-ref <ref>] [--sensitivity <level>] [--occurred-at <iso>] [--idempotency-key <key>] [--as-human]
  record --realm <id|path> --kind <kind> --title <title> [...]      [deprecated alias for 'write --class rule|conclusion'; removal in v0.3.0]
  capture --realm <id|path> --kind <kind> --text <text> [...]       [deprecated alias for 'write --class raw'; removal in v0.3.0]
  redact --id <entryId> [--reason <text>] --as-human
  sync-embeddings [--batch-size <n>] [--max-items <n>]

  tree --realm <id|path>
  ls [target] --realm <id|path> [--type realm|object|thing|resource] [--include-superseded] [--include-descendant-seabed] [--limit <n>] [--offset <n>]
  cat <id|drive-path> --realm <id|path> [--target <id|path>] [--include-descendant-seabed]
  brief --realm <id|path> [--limit <n>]
  replay <id> --realm <id|path> [--window <n>] [--include-descendant-seabed]
  changes --realm <id|path> [--since <seq>] [--limit <n>] [--include-descendant-seabed]
  recall --realm <id|path> [--query <text>] [--id <id>] [--thing <id>] [--target <id|path>] [--include-superseded] [--include-descendant-seabed] [--limit <n>]

  thing create --realm <id|path> --title <title> [--external-ref <ref>] [--dedupe] [--objects <a,b>] [--tags <a,b>] [--sensitivity <level>] [--occurred-at <iso>] [--idempotency-key <key>]
  thing list --realm <id|path> [--target <id|path>] [--external-ref <ref>] [--include-superseded] [--limit <n>]
  object create --realm <id|path> [--target <id|path>] --kind <kind> --name <name> [--parent <objectId>]
  object list --realm <id|path> [--target <id|path>] [--parent <objectId>] [--kind <kind>]
  object delete --realm <id|path> --id <objectId>
  object link --realm <id|path> --entry <entryId> --object <objectId>
  tag list --realm <id|path> [--target <id|path>] [--prefix <prefix>]
  tag add --realm <id|path> --entry <entryId> --tag <type:name>

  import-md <file-or-dir> --realm <id|path> [--target <id|path>] [--base-dir <dir>] [--source-ref <ref>] [--kind <kind>] [--sensitivity <level>] [--objects <a,b>] [--tags <a,b>] [--sync-embeddings] [--as-human]
  import-jsonl <file.jsonl> --map <mapping.json> --realm <id|path> [--target <id|path>] [--sync-embeddings] [--as-human]

  drive write --realm <id|path> --path <relPath> (--content <text> | --file <path>) [--expected-version <n>] [--message <msg>]
  drive read --viewer <id|path> [--target <id|path>] --path <relPath>
  drive list --viewer <id|path> [--target <id|path>]
  settle --realm <id|path> --layer <layer> --period <key> [--narrative <text>] [--sources <a,b>]
  export-slice --realm <id|path> --out <dir>
  rebuild [--no-restore-drive]
`;
  process.stdout.write(help);
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, third] = positionals;

  if (!cmd || cmd === "help" || flagBool(flags, "help")) {
    printUsage();
    return;
  }

  const driveMode =
    (flagStr(flags, "drive") as "local" | "layerfs" | undefined) ?? "local";
  const engine = await createMindEngine({
    homeDir: flagStr(flags, "home"),
    driveMode,
  });

  const actor = buildActor(flags);
  const asJson = flagBool(flags, "json");
  const orgFlag = flagStr(flags, "org");

  const output = (data: unknown, markdown?: string) => {
    if (asJson) {
      process.stdout.write(`${JSON.stringify(data)}\n`);
    } else if (markdown !== undefined) {
      process.stdout.write(`${markdown}\n`);
    } else {
      process.stdout.write(`${formatGenericMarkdown(cmd, data)}\n`);
    }
  };

  try {
    if (cmd === "init") {
      const existing = engine.ledger.listOrgs();
      if (existing.length > 0) {
        const rootRealm = engine.db.getRealmByPath(existing[0]!.id, "/");
        const res = {
          initialized: false,
          homeDir: engine.homeDir,
          org: existing[0],
          rootRealm: rootRealm ?? null,
        };
        output(res, formatGenericMarkdown("Initialized (existing)", res));
        return;
      }
      const created = engine.ledger.createOrg({
        name: flagStr(flags, "org") ?? "Personal",
        isPersonalRoot: !flags["personal"] ? true : flagBool(flags, "personal"),
        policy: flagStr(flags, "policy") as OrgPolicy | undefined,
      });
      const res = { initialized: true, homeDir: engine.homeDir, ...created };
      output(res, formatGenericMarkdown("Initialized", res));
      return;
    }

    if (cmd === "org") {
      if (sub === "create") {
        const res = engine.ledger.createOrg({
          name: requireFlag(flags, "name"),
          isPersonalRoot: flagBool(flags, "personal"),
          policy: flagStr(flags, "policy") as OrgPolicy | undefined,
        });
        output(res, formatGenericMarkdown("Organization Created", res));
        return;
      }
      if (sub === "set-policy") {
        const res = engine.ledger.setOrgPolicy({
          orgId: requireFlag(flags, "org"),
          policy: requireFlag(flags, "policy") as OrgPolicy,
          actor,
        });
        output(res, formatGenericMarkdown("Organization Policy Updated", res));
        return;
      }
      if (sub === "list") {
        const orgs = engine.ledger.listOrgs();
        const md = [
          `# Organizations (${orgs.length})`,
          "",
          ...orgs.map((o) => `- **${o.name}** (\`${o.id}\`, policy: \`${o.policy}\`)`),
        ].join("\n");
        output(orgs, md);
        return;
      }
      throw new MindError(
        "INVALID_INPUT",
        `Unknown org subcommand: ${sub ?? ""}`,
      );
    }

    if (cmd === "realm") {
      if (sub === "create") {
        const res = engine.ledger.createRealm({
          actor,
          orgId: requireFlag(flags, "org"),
          parentId: requireFlag(flags, "parent"),
          slug: requireFlag(flags, "slug"),
          name: requireFlag(flags, "name"),
        });
        output(res, formatGenericMarkdown("Realm Created", res));
        return;
      }
      if (sub === "list") {
        const realms = engine.ledger.listRealms({
          orgId: requireFlag(flags, "org"),
          viewerRealmId: flagStr(flags, "viewer"),
        });
        const md = [
          `# Realms (${realms.length})`,
          "",
          ...realms.map((r) => `- **${r.path}** — ${r.name} (\`${r.id}\`)`),
        ].join("\n");
        output(realms, md);
        return;
      }
      throw new MindError(
        "INVALID_INPUT",
        `Unknown realm subcommand: ${sub ?? ""}`,
      );
    }

    if (cmd === "mount") {
      const res = engine.ledger.mountRealm({
        actor,
        viewerRealmId: resolveCliRealmId(
          engine,
          requireFlag(flags, "viewer"),
          orgFlag,
        ),
        targetRealmId: resolveCliRealmId(
          engine,
          requireFlag(flags, "target"),
          orgFlag,
        ),
        scope: (flagStr(flags, "scope") as MountScope | undefined) ?? "all",
      });
      output(res, formatGenericMarkdown("Realm Mounted", res));
      return;
    }

    if (cmd === "unmount") {
      const res = {
        removed: engine.ledger.unmountRealm({
          actor,
          viewerRealmId: resolveCliRealmId(
            engine,
            requireFlag(flags, "viewer"),
            orgFlag,
          ),
          targetRealmId: resolveCliRealmId(
            engine,
            requireFlag(flags, "target"),
            orgFlag,
          ),
        }),
      };
      output(res, formatGenericMarkdown("Realm Unmounted", res));
      return;
    }

    if (cmd === "write") {
      const behaviorClass = requireFlag(flags, "class") as BehaviorClass;
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      const targetFlag = flagStr(flags, "target");
      const targetRealmId = targetFlag
        ? resolveCliRealmId(engine, targetFlag, orgFlag)
        : undefined;

      if (behaviorClass === "raw") {
        const filePath = flagStr(flags, "file");
        const blobContent = filePath ? fs.readFileSync(filePath) : undefined;
        const entry = await engine.ledger.captureSeabed({
          actor,
          viewerRealmId,
          targetRealmId,
          kind: (flagStr(flags, "kind") as SeabedKind | undefined) ?? "message",
          text: flagStr(flags, "text") ?? "",
          topicId: flagStr(flags, "topic"),
          blobContent,
          sourceRef: flagStr(flags, "source-ref"),
          objectIds: parseCsvFlag(flags, "objects"),
          resourceTags: parseCsvFlag(flags, "tags"),
          occurredAt: flagStr(flags, "occurred-at"),
          sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
          idempotencyKey: flagStr(flags, "idempotency-key"),
        });
        output(entry, formatGenericMarkdown("Written [raw]", entry));
        return;
      }

      if (behaviorClass === "rule" || behaviorClass === "conclusion") {
        const kind: RecordKind =
          behaviorClass === "rule"
            ? "rule"
            : ((flagStr(flags, "kind") as RecordKind | undefined) ??
              "decision");
        if (behaviorClass === "conclusion" && kind === "rule") {
          throw new MindError(
            "INVALID_INPUT",
            'Use --class rule (with --as-human) to write a rule',
          );
        }
        const rec = await engine.ledger.appendRecord({
          actor,
          viewerRealmId,
          targetRealmId,
          kind,
          extKind: flagStr(flags, "ext-kind"),
          title: requireFlag(flags, "title"),
          payload: parsePayloadJson(flagStr(flags, "payload")),
          refs: parseCsvFlag(flags, "refs"),
          externalRef: flagStr(flags, "external-ref"),
          sourceRef: flagStr(flags, "source-ref"),
          objectIds: parseCsvFlag(flags, "objects"),
          resourceTags: parseCsvFlag(flags, "tags"),
          supersedesId: flagStr(flags, "supersedes"),
          thingId: flagStr(flags, "thing"),
          occurredAt: flagStr(flags, "occurred-at"),
          sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
          idempotencyKey: flagStr(flags, "idempotency-key"),
        });
        output(
          rec,
          formatGenericMarkdown(`Written [${behaviorClass}/${rec.kind}]`, rec),
        );
        return;
      }

      throw new MindError(
        "INVALID_INPUT",
        `Invalid --class "${String(behaviorClass)}": expected rule, conclusion, or raw`,
      );
    }

    // Deprecated alias for write --class raw (scheduled for removal in v0.3.0)
    if (cmd === "capture") {
      const filePath = flagStr(flags, "file");
      const blobContent = filePath ? fs.readFileSync(filePath) : undefined;
      const entry = await engine.ledger.captureSeabed({
        actor,
        viewerRealmId: resolveCliRealmId(
          engine,
          requireFlag(flags, "realm"),
          orgFlag,
        ),
        kind: requireFlag(flags, "kind") as SeabedKind,
        text: flagStr(flags, "text") ?? "",
        topicId: flagStr(flags, "topic"),
        blobContent,
        sourceRef: flagStr(flags, "source-ref"),
        objectIds: parseCsvFlag(flags, "objects"),
        resourceTags: parseCsvFlag(flags, "tags"),
        occurredAt: flagStr(flags, "occurred-at"),
        sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
        idempotencyKey: flagStr(flags, "idempotency-key"),
      });
      output(entry, formatGenericMarkdown("Captured [raw]", entry));
      return;
    }

    // Deprecated alias for write --class rule|conclusion (scheduled for removal in v0.3.0)
    if (cmd === "record") {
      const rec = await engine.ledger.appendRecord({
        actor,
        viewerRealmId: resolveCliRealmId(
          engine,
          requireFlag(flags, "realm"),
          orgFlag,
        ),
        kind: requireFlag(flags, "kind") as RecordKind,
        extKind: flagStr(flags, "ext-kind"),
        title: requireFlag(flags, "title"),
        payload: parsePayloadJson(flagStr(flags, "payload")),
        refs: parseCsvFlag(flags, "refs"),
        externalRef: flagStr(flags, "external-ref"),
        sourceRef: flagStr(flags, "source-ref"),
        objectIds: parseCsvFlag(flags, "objects"),
        resourceTags: parseCsvFlag(flags, "tags"),
        supersedesId: flagStr(flags, "supersedes"),
        thingId: flagStr(flags, "thing"),
        occurredAt: flagStr(flags, "occurred-at"),
        sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
        idempotencyKey: flagStr(flags, "idempotency-key"),
      });
      output(rec, formatGenericMarkdown(`Recorded [${rec.kind}]`, rec));
      return;
    }

    if (cmd === "redact") {
      const res = engine.ledger.redact({
        actor,
        entryId: requireFlag(flags, "id"),
        reason: flagStr(flags, "reason"),
        viewerRealmId: flagStr(flags, "realm")
          ? resolveCliRealmId(engine, flagStr(flags, "realm")!, orgFlag)
          : undefined,
      });
      output(res, formatGenericMarkdown("Redacted", res));
      return;
    }

    if (cmd === "sync-embeddings") {
      const res = await engine.sea.syncEmbeddings({
        batchSize: parseIntFlag(flags, "batch-size", { min: 1 }),
        maxItems: parseIntFlag(flags, "max-items", { min: 1 }),
      });
      output(res, formatGenericMarkdown("Embeddings Synced", res));
      return;
    }

    if (cmd === "tree") {
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      const res = engine.sea.tree({ actor, viewerRealmId });
      output(res, formatTreeMarkdown(res));
      return;
    }

    if (cmd === "ls") {
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      const target = sub ?? flagStr(flags, "target");
      const res = await engine.sea.ls({
        actor,
        viewerRealmId,
        target,
        targetType: flagStr(flags, "type") as LsTargetType | undefined,
        includeSuperseded:
          flagBool(flags, "include-superseded") ||
          flagBool(flags, "include-history"),
        includeDescendantSeabed: flagBool(flags, "include-descendant-seabed"),
        limit: parseIntFlag(flags, "limit", { min: 1 }),
        offset: parseIntFlag(flags, "offset", { min: 0 }),
      });
      output(res, formatLsMarkdown(res));
      return;
    }

    if (cmd === "cat") {
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      const target = sub ?? flagStr(flags, "id") ?? flagStr(flags, "path");
      if (!target) {
        throw new MindError(
          "INVALID_INPUT",
          "cat requires an entry ID or drive path argument",
        );
      }
      const res = await engine.sea.cat({
        actor,
        viewerRealmId,
        target,
        targetRealmRef: flagStr(flags, "target"),
        includeDescendantSeabed: flagBool(flags, "include-descendant-seabed"),
      });
      output(res, formatCatMarkdown(res));
      return;
    }

    if (cmd === "replay") {
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      const entryId = sub ?? flagStr(flags, "id");
      if (!entryId) {
        throw new MindError("INVALID_INPUT", "replay requires an entry ID");
      }
      const res = engine.sea.replay({
        actor,
        viewerRealmId,
        entryId,
        window: parseIntFlag(flags, "window", { min: 1 }),
        includeDescendantSeabed: flagBool(flags, "include-descendant-seabed"),
      });
      output(res, formatReplayMarkdown(res));
      return;
    }

    if (cmd === "changes") {
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      const res = engine.sea.changes({
        actor,
        viewerRealmId,
        sinceSeq: parseIntFlag(flags, "since", { min: 0 }) ?? 0,
        limit: parseIntFlag(flags, "limit", { min: 1 }),
        includeDescendantSeabed: flagBool(flags, "include-descendant-seabed"),
      });
      output(res, formatChangesMarkdown(res));
      return;
    }

    if (cmd === "thing") {
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      if (sub === "create") {
        const rec = await engine.ledger.createThing({
          actor,
          viewerRealmId,
          targetRealmId: flagStr(flags, "target")
            ? resolveCliRealmId(engine, flagStr(flags, "target")!, orgFlag)
            : undefined,
          title: requireFlag(flags, "title"),
          externalRef: flagStr(flags, "external-ref"),
          payload: parsePayloadJson(flagStr(flags, "payload")),
          refs: parseCsvFlag(flags, "refs"),
          objectIds: parseCsvFlag(flags, "objects"),
          resourceTags: parseCsvFlag(flags, "tags"),
          occurredAt: flagStr(flags, "occurred-at"),
          sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
          idempotencyKey: flagStr(flags, "idempotency-key"),
          dedupeByExternalRef: flagBool(flags, "dedupe"),
        });
        output(rec, formatGenericMarkdown("Thing Created", rec));
        return;
      }
      if (sub === "list") {
        const res = engine.ledger.listThings({
          actor,
          viewerRealmId,
          targetRealmRef: flagStr(flags, "target"),
          externalRef: flagStr(flags, "external-ref"),
          includeSuperseded:
            flagBool(flags, "include-superseded") ||
            flagBool(flags, "include-history"),
          limit: parseIntFlag(flags, "limit", { min: 1 }),
          offset: parseIntFlag(flags, "offset", { min: 0 }),
        });
        output(res, formatThingsMarkdown(res.items, res.total));
        return;
      }
      throw new MindError(
        "INVALID_INPUT",
        `Unknown thing subcommand: ${sub ?? ""}`,
      );
    }

    if (cmd === "object") {
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      if (sub === "create") {
        const obj = engine.objects.createObject({
          actor,
          viewerRealmId,
          targetRealmRef: flagStr(flags, "target"),
          parentObjectId: flagStr(flags, "parent"),
          kind: requireFlag(flags, "kind"),
          name: requireFlag(flags, "name"),
        });
        output(obj, formatGenericMarkdown("Object Created", obj));
        return;
      }
      if (sub === "list") {
        const objs = engine.objects.listObjects({
          viewerRealmId,
          realmRef: flagStr(flags, "target"),
          parentObjectId: flagStr(flags, "parent"),
          kind: flagStr(flags, "kind"),
        });
        output(objs, formatObjectsMarkdown(objs));
        return;
      }
      if (sub === "delete") {
        const removed = engine.objects.deleteObject({
          actor,
          viewerRealmId,
          objectId: requireFlag(flags, "id"),
        });
        output({ removed }, formatGenericMarkdown("Object Deleted", { removed }));
        return;
      }
      if (sub === "link") {
        const link = engine.objects.linkEntryObject({
          actor,
          viewerRealmId,
          entryId: requireFlag(flags, "entry"),
          objectId: requireFlag(flags, "object"),
        });
        output(link, formatGenericMarkdown("Entry Linked to Object", link));
        return;
      }
      throw new MindError(
        "INVALID_INPUT",
        `Unknown object subcommand: ${sub ?? ""}`,
      );
    }

    if (cmd === "tag") {
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      if (sub === "list") {
        const tags = engine.objects.listResourceTags({
          viewerRealmId,
          realmRef: flagStr(flags, "target"),
          prefix: flagStr(flags, "prefix"),
          includeDescendantSeabed: flagBool(flags, "include-descendant-seabed"),
        });
        output(tags, formatTagsMarkdown(tags));
        return;
      }
      if (sub === "add") {
        const added = engine.objects.tagEntryResource({
          actor,
          viewerRealmId,
          entryId: requireFlag(flags, "entry"),
          tag: requireFlag(flags, "tag"),
        });
        output(added, formatGenericMarkdown("Resource Tag Added", added));
        return;
      }
      throw new MindError(
        "INVALID_INPUT",
        `Unknown tag subcommand: ${sub ?? ""}`,
      );
    }

    if (cmd === "import-md") {
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      const inputPath = sub ?? flagStr(flags, "path") ?? flagStr(flags, "file");
      if (!inputPath) {
        throw new MindError(
          "INVALID_INPUT",
          "import-md requires a Markdown file or directory path",
        );
      }
      const res = await engine.importer.importMd({
        actor,
        viewerRealmId,
        targetRealmRef: flagStr(flags, "target"),
        inputPath,
        baseDir: flagStr(flags, "base-dir"),
        sourceRef: flagStr(flags, "source-ref"),
        kind: flagStr(flags, "kind") as RecordKind | undefined,
        extKind: flagStr(flags, "ext-kind"),
        sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
        skipSecret: !flagBool(flags, "include-secret"),
        objectIds: parseCsvFlag(flags, "objects"),
        resourceTags: parseCsvFlag(flags, "tags"),
        syncEmbeddings: flagBool(flags, "sync-embeddings"),
      });
      output(res, formatImportMdMarkdown(res));
      return;
    }

    if (cmd === "import-jsonl") {
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      const jsonlPath = sub ?? flagStr(flags, "path") ?? flagStr(flags, "file");
      if (!jsonlPath) {
        throw new MindError(
          "INVALID_INPUT",
          "import-jsonl requires a JSONL file path",
        );
      }
      const mapPath = requireFlag(flags, "map");
      if (!fs.existsSync(mapPath)) {
        throw new MindError(
          "NOT_FOUND",
          `Mapping JSON file not found: ${mapPath}`,
        );
      }
      let mapping: JsonlMappingConfig;
      try {
        mapping = JSON.parse(
          fs.readFileSync(mapPath, "utf8"),
        ) as JsonlMappingConfig;
      } catch (err) {
        throw new MindError(
          "INVALID_INPUT",
          `Invalid mapping JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const res = await engine.importer.importJsonl({
        actor,
        viewerRealmId,
        targetRealmRef: flagStr(flags, "target"),
        jsonlPath,
        mapping,
        syncEmbeddings: flagBool(flags, "sync-embeddings"),
      });
      output(res, formatImportJsonlMarkdown(res));
      return;
    }

    if (cmd === "drive") {
      if (sub === "write") {
        const filePath = flagStr(flags, "file");
        const content = filePath
          ? fs.readFileSync(filePath, "utf8")
          : requireFlag(flags, "content");
        const expectedVersion = parseIntFlag(flags, "expected-version", {
          min: 0,
        });
        const res = await engine.ledger.writeDriveFile({
          actor,
          viewerRealmId: resolveCliRealmId(
            engine,
            requireFlag(flags, "realm"),
            orgFlag,
          ),
          relPath: requireFlag(flags, "path"),
          content,
          expectedVersion,
          message: flagStr(flags, "message"),
        });
        output(res, formatGenericMarkdown("Drive File Written", res));
        return;
      }
      if (sub === "read") {
        const viewer = resolveCliRealmId(
          engine,
          requireFlag(flags, "viewer"),
          orgFlag,
        );
        const target = flagStr(flags, "target")
          ? resolveCliRealmId(engine, flagStr(flags, "target")!, orgFlag)
          : viewer;
        const res = await engine.ledger.readDriveFile({
          actor,
          viewerRealmId: viewer,
          targetRealmId: target,
          relPath: requireFlag(flags, "path"),
        });
        output(res, res ? res.content : "_(not found)_");
        return;
      }
      if (sub === "list") {
        const viewer = resolveCliRealmId(
          engine,
          requireFlag(flags, "viewer"),
          orgFlag,
        );
        const target = flagStr(flags, "target")
          ? resolveCliRealmId(engine, flagStr(flags, "target")!, orgFlag)
          : viewer;
        const res = await engine.ledger.listDriveFiles({
          actor,
          viewerRealmId: viewer,
          targetRealmId: target,
        });
        const md = [
          `# Drive Files (${res.length})`,
          "",
          ...res.map((f) => `- \`${f.relPath}\` (v${f.version}, ${f.updatedAt})`),
        ].join("\n");
        output(res, md);
        return;
      }
      throw new MindError(
        "INVALID_INPUT",
        `Unknown drive subcommand: ${sub ?? ""}`,
      );
    }

    if (cmd === "brief") {
      const n = parseIntFlag(flags, "limit", { min: 1 });
      const res = engine.sea.brief({
        actor,
        viewerRealmId: resolveCliRealmId(
          engine,
          requireFlag(flags, "realm"),
          orgFlag,
        ),
        budget: n
          ? {
              recentMessages: n,
              maxQuestions: n,
              maxActiveThings: n,
              maxDecisions: n,
            }
          : undefined,
      });
      output(res, formatBriefMarkdown(res));
      return;
    }

    if (cmd === "recall") {
      const limit = parseIntFlag(flags, "limit", { min: 1 });
      const viewerRealmId = resolveCliRealmId(
        engine,
        requireFlag(flags, "realm"),
        orgFlag,
      );
      const targetFlag = flagStr(flags, "target");
      const res = await engine.sea.recall({
        actor,
        viewerRealmId,
        query: flagStr(flags, "query"),
        id: flagStr(flags, "id"),
        thingId: flagStr(flags, "thing"),
        targetRealmId: targetFlag
          ? resolveCliRealmId(engine, targetFlag, orgFlag)
          : undefined,
        includeSuperseded:
          flagBool(flags, "include-superseded") ||
          flagBool(flags, "include-history"),
        includeDescendantSeabed: flagBool(flags, "include-descendant-seabed"),
        limit,
      });
      output(res, formatRecallMarkdown(res));
      return;
    }

    if (cmd === "settle") {
      const sourcesRaw = flagStr(flags, "sources");
      const sourceIds = sourcesRaw
        ? sourcesRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const res = await engine.sea.settle({
        actor,
        viewerRealmId: resolveCliRealmId(
          engine,
          requireFlag(flags, "realm"),
          orgFlag,
        ),
        layer: requireFlag(flags, "layer") as DistillationLayer,
        periodKey: requireFlag(flags, "period"),
        narrativeMd: flagStr(flags, "narrative"),
        sourceIds,
      });
      output(res, formatGenericMarkdown("Settled Distillation", res));
      return;
    }

    if (cmd === "export-slice") {
      const res = await engine.slice.exportSlice({
        actor,
        viewerRealmId: resolveCliRealmId(
          engine,
          requireFlag(flags, "realm"),
          orgFlag,
        ),
        outDir: requireFlag(flags, "out"),
      });
      output(res, formatGenericMarkdown("Slice Exported", res));
      return;
    }

    if (cmd === "rebuild") {
      const res = await engine.sea.rebuild({
        restoreDrive: !flagBool(flags, "no-restore-drive"),
      });
      output(res, formatGenericMarkdown("Rebuild Completed", res));
      return;
    }

    // Prevent unused variable warning for third positional
    void third;
    throw new MindError("INVALID_INPUT", `Unknown command: ${cmd}`);
  } finally {
    await engine.close();
  }
}

main().catch((err: unknown) => {
  if (err instanceof MindError) {
    process.stderr.write(
      `${JSON.stringify({ error: err.code, message: err.message, details: err.details })}\n`,
    );
    process.exit(1);
  }
  process.stderr.write(
    `${JSON.stringify({ error: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) })}\n`,
  );
  process.exit(1);
});
