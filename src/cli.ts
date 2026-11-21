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
  formatImportVerifyMarkdown,
  formatLsMarkdown,
  formatObjectsMarkdown,
  formatRecallMarkdown,
  formatReplayMarkdown,
  formatTagsMarkdown,
  formatThingsMarkdown,
  formatTreeMarkdown,
  intersectAccessScopes,
  MindError,
  OPAQUE_REALM_NOT_FOUND,
  resolveAccessScope,
  resolveRealmByPath,
  resolveVisibleRealm,
  type AccessScope,
  type Actor,
  type ActorKind,
  type BehaviorClass,
  type DistillationLayer,
  type ImportMappingConfig,
  type LsTargetType,
  type MindEngine,
  type MountScope,
  type Organization,
  type OrgPolicy,
  type Realm,
  type RecordKind,
  type SeabedKind,
  type Sensitivity,
} from "./index.js";

// Handle broken stdout pipes cleanly (e.g. `meru-mind tree | head -n 5`)
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    process.exit(0);
  }
  throw err;
});

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
  "objects",
  "no-objects",
  "focus-boost",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "-L") {
      if (i + 1 < argv.length) {
        flags["depth"] = argv[i + 1]!;
        i += 1;
      } else {
        throw new MindError("INVALID_INPUT", "Flag -L requires a value");
      }
    } else if (token.startsWith("-L=")) {
      flags["depth"] = token.slice(3);
    } else if (token === "-h") {
      flags["help"] = true;
    } else if (token.startsWith("--") && token.length > 2) {
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

function parseDepthFlag(
  flags: Record<string, string | boolean>,
): number | "all" | undefined {
  const raw = flagStr(flags, "depth");
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "all") return "all";
  if (!/^\d+$/.test(trimmed)) {
    throw new MindError(
      "INVALID_INPUT",
      `Flag --depth / -L must be a non-negative integer or "all", got "${raw}"`,
    );
  }
  return Number.parseInt(trimmed, 10);
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

function parseOccurredAtFlag(
  flags: Record<string, string | boolean>,
): string | null | undefined {
  const raw = flagStr(flags, "occurred-at");
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "null") {
    return null;
  }
  return trimmed;
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

function loadMappingFile(mapPath: string): ImportMappingConfig {
  if (!fs.existsSync(mapPath)) {
    throw new MindError("NOT_FOUND", `Mapping JSON file not found: ${mapPath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(mapPath, "utf8")) as ImportMappingConfig;
  } catch (err) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid mapping JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function resolveAdminRealmId(
  engine: MindEngine,
  rawRef: string,
  orgIdFlag?: string,
): string {
  const trimmed = rawRef.trim();
  if (!trimmed.startsWith("/")) {
    return trimmed;
  }
  let orgId = orgIdFlag?.trim() || process.env.MERU_MIND_ORG_ID?.trim();
  if (!orgId) {
    const orgs = engine.ledger.listOrgs();
    if (orgs.length === 1) {
      orgId = orgs[0]!.id;
    } else {
      throw new MindError(
        "INVALID_INPUT",
        `Realm path "${trimmed}" requires --org or MERU_MIND_ORG_ID when multiple organizations exist`,
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

interface SessionContext {
  org: Organization;
  boundViewerRealmId: string;
  effectiveViewerRealmId: string;
  boundScope: AccessScope;
  effectiveScope: AccessScope;
  realms: Realm[];
}

function resolveSessionContext(params: {
  engine: MindEngine;
  flags: Record<string, string | boolean>;
  allowFocus: boolean;
  includeDescendantSeabed?: boolean;
}): SessionContext {
  const { engine, flags, allowFocus, includeDescendantSeabed = false } = params;
  const focusFlag = flagStr(flags, "focus");
  if (!allowFocus && focusFlag !== undefined) {
    throw new MindError(
      "INVALID_INPUT",
      "Flag --focus is only valid on read commands, never on write commands. Pass a positional <targetRealm> instead (e.g. meru-mind write /ops --class conclusion --title \"...\").",
    );
  }

  const envOrgId =
    flagStr(flags, "org")?.trim() || process.env.MERU_MIND_ORG_ID?.trim();
  const envViewerRaw = process.env.MERU_MIND_VIEWER_REALM_ID?.trim();

  let org: Organization | null = null;
  if (envOrgId) {
    org = engine.db.getOrg(envOrgId);
    if (!org) {
      throw new MindError("NOT_FOUND", `Organization not found: ${envOrgId}`);
    }
  } else if (envViewerRaw && !envViewerRaw.startsWith("/")) {
    const vr = engine.db.getRealm(envViewerRaw);
    if (!vr) {
      throw new MindError("NOT_FOUND", OPAQUE_REALM_NOT_FOUND);
    }
    org = engine.db.getOrg(vr.orgId);
    if (!org) {
      throw new MindError("NOT_FOUND", `Organization not found: ${vr.orgId}`);
    }
  } else {
    const orgs = engine.ledger.listOrgs();
    if (orgs.length === 1) {
      org = orgs[0]!;
    } else if (orgs.length === 0) {
      throw new MindError(
        "NOT_FOUND",
        'No organization found in runtime home. Run "meru-mind init" first.',
      );
    } else {
      throw new MindError(
        "INVALID_INPUT",
        "MERU_MIND_ORG_ID (or --org) is required when multiple organizations exist",
      );
    }
  }

  const realms = engine.db.listRealms();
  const orgRealms = realms.filter((r) => r.orgId === org!.id);
  const mounts = engine.db.listMounts();

  let boundViewerRealm: Realm | null = null;
  if (envViewerRaw) {
    boundViewerRealm = envViewerRaw.startsWith("/")
      ? resolveRealmByPath(orgRealms, envViewerRaw)
      : (orgRealms.find((r) => r.id === envViewerRaw) ?? null);
    if (!boundViewerRealm) {
      throw new MindError(
        "NOT_FOUND",
        `Bound MERU_MIND_VIEWER_REALM_ID "${envViewerRaw}" not found in org "${org.id}"`,
      );
    }
  } else if (org.policy === "tree") {
    throw new MindError(
      "INVALID_INPUT",
      `MERU_MIND_VIEWER_REALM_ID is required for 'tree' policy organization "${org.id}". Bind the realm assigned to your current session (e.g. MERU_MIND_VIEWER_REALM_ID=/team/project meru-mind tree; never default to /), or use --as-human on org-admin commands.`,
    );
  } else {
    boundViewerRealm =
      orgRealms.find((r) => r.path === "/") ?? orgRealms[0] ?? null;
    if (!boundViewerRealm) {
      throw new MindError(
        "NOT_FOUND",
        `No realm found in organization "${org.id}"`,
      );
    }
  }

  const boundScope = resolveAccessScope({
    realms,
    mounts,
    viewerRealmId: boundViewerRealm.id,
    orgPolicy: org.policy,
    includeDescendantSeabed,
  });

  if (!focusFlag) {
    return {
      org,
      boundViewerRealmId: boundViewerRealm.id,
      effectiveViewerRealmId: boundViewerRealm.id,
      boundScope,
      effectiveScope: boundScope,
      realms,
    };
  }

  const focusRealm = resolveVisibleRealm({
    realms,
    orgId: org.id,
    ref: focusFlag,
    scope: boundScope,
  });
  const focusScope = resolveAccessScope({
    realms,
    mounts,
    viewerRealmId: focusRealm.id,
    orgPolicy: org.policy,
    includeDescendantSeabed,
  });
  const effectiveScope = intersectAccessScopes(focusScope, boundScope);

  return {
    org,
    boundViewerRealmId: boundViewerRealm.id,
    effectiveViewerRealmId: focusRealm.id,
    boundScope,
    effectiveScope,
    realms,
  };
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

Quickstart (progressive disclosure):
  1. meru-mind tree                     Discover visible realms & objects (-L 1 default)
  2. meru-mind brief /path              Read realm summary, rules, recent conclusions & child counts
  3. meru-mind ls /path | obj:<id> | tag:<type:name>   List entries with copy-pasteable IDs
  4. meru-mind recall "<query>"         Ranked FTS5 + vector search (returns rec_.../sea_... handles)
  5. meru-mind cat <id> | replay <id>   Inspect full entry or surrounding timeline & supersede DAG

Scope Model (Binding vs Target vs Focus):
  MERU_MIND_VIEWER_REALM_ID   Session binding (REQUIRED in 'tree' orgs; defaults to / in 'open' orgs)
  <target>                    Object of the command: realm /path, @mounted/<alias>, realm:<id>, obj:<id|name>, thing:<ref>, tag:<type:name>
  --focus <path|id>           Read-only perspective: narrows scope in 'tree' mode; optional center/hint in 'open' mode (use --focus-boost for intra-band tie-break)

Environment:
  MERU_MIND_HOME              Data directory (default: ~/.meru-mind; override with --home)
  MERU_MIND_ORG_ID            Bound organization ID (auto-resolved when single org exists)
  MERU_MIND_VIEWER_REALM_ID   Bound viewer realm ID or /path (REQUIRED in 'tree' orgs; defaults to / in 'open' orgs)

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
  --org <orgId>             Organization ID
  --focus <path|id>         Read commands only: sub-scope narrowing in 'tree' mode; center/hint in 'open' mode
  --json                    Print stable JSON output (default output is compact Markdown)

Read & Explore Commands:
  tree [target] [-L|--depth <n|all>] [--objects|--no-objects] [--limit <n>] [--focus <realm>]
  ls [target] [--kind <kind>] [--tag <type:name>] [--type realm|object|thing|resource] [--include-superseded] [--include-descendant-seabed] [--limit <n>] [--offset <n>] [--focus <realm>]
      Explicit target prefixes: /path, @mounted/<alias>, realm:<id>, obj:<id|name>, thing:<ref>, tag:<type:name>
  brief [target] [--limit <n>] [--max-children <n>] [--focus <realm>]
  cat <id|drive-path> [--target <realm>] [--include-descendant-seabed] [--focus <realm>]
  recall [query] [--query <text>] [--id <id>] [--thing <id>] [--target <realm>] [--kind <k1,k2>] [--since <iso>] [--until <iso>] [--include-superseded] [--include-descendant-seabed] [--focus <realm>] [--focus-boost] [--limit <n>] [--offset <n>]
  replay <id> [--window <n>] [--include-descendant-seabed] [--focus <realm>]
  changes [target] [--since <seq>] [--limit <n>] [--include-descendant-seabed] [--focus <realm>]

Write Commands (positional <targetRealm> required):
  write <targetRealm> --class rule|conclusion|raw [--kind <kind>] [--title <title>] [--text <text>] [--payload <json>] [--refs <a,b>] [--objects <a,b>] [--tags <type:name,...>] [--supersedes <id1,id2>] [--thing <id>] [--external-ref <ref>] [--source-ref <ref>] [--sensitivity <level>] [--occurred-at <iso|none>] [--idempotency-key <key>] [--as-human]
  drive write <targetRealm> --path <relPath> (--content <text> | --file <path>) [--expected-version <n>] [--message <msg>]
  drive read [target] --path <relPath> [--focus <realm>]
  drive list [target] [--focus <realm>]
  settle <targetRealm> --layer <layer> --period <key> [--narrative <text>] [--sources <a,b>]
  record <targetRealm> --kind <kind> --title <title> [...]      [deprecated alias for 'write --class rule|conclusion'; removal in v0.3.0]
  capture <targetRealm> --kind <kind> --text <text> [...]       [deprecated alias for 'write --class raw'; removal in v0.3.0]

Objects, Things & Tags:
  thing create [targetRealm] --title <title> [--external-ref <ref>] [--dedupe] [--objects <a,b>] [--tags <a,b>] [--sensitivity <level>] [--occurred-at <iso|none>] [--idempotency-key <key>]
  thing list [target] [--external-ref <ref>] [--include-superseded] [--limit <n>] [--offset <n>] [--focus <realm>]
  object create [targetRealm] --kind <kind> --name <name> [--parent <objectId>]
  object list [target] [--parent <objectId>] [--kind <kind>] [--limit <n>] [--focus <realm>]
  object delete --id <objectId>
  object link --entry <entryId> --object <objectId>
  tag list [target] [--prefix <prefix>] [--limit <n>] [--focus <realm>]
  tag add --entry <entryId> --tag <type:name>

Importers & Consistency Verification:
  import-md <file-or-dir> [--target <realm>] [--map <mapping.json>] [--base-dir <dir>] [--source-ref <ref>] [--kind <kind>] [--sensitivity <level>] [--objects <a,b>] [--tags <a,b>] [--sync-embeddings] [--as-human]
  import-jsonl <file.jsonl> --map <mapping.json> [--target <realm>] [--sync-embeddings] [--as-human]
  import-verify --source <file|dir> [--map <mapping.json>] [--base-dir <dir>]

Admin & Maintenance Commands:
  init [--org <name>] [--personal] [--policy open|tree]
  org create --name <name> [--personal] [--policy open|tree]
  org set-policy --org <orgId> --policy open|tree --as-human
  org list
  realm create --org <orgId> --parent <realmId> --slug <slug> --name <name> [--as-human]
  realm list [--limit <n>] [--focus <realm>]
  mount --viewer <realmId|path> --target <realmId|path> [--scope all|ledger|drive] [--as-human]
  unmount --viewer <realmId|path> --target <realmId|path> [--as-human]
  redact --id <entryId> [--reason <text>] --as-human
  sync-embeddings [--batch-size <n>] [--max-items <n>]
  export-slice [target] --out <dir>
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

  // Hard removal of --realm across ALL CLI commands
  if ("realm" in flags) {
    throw new MindError(
      "INVALID_INPUT",
      'Flag "--realm" has been removed. Pass a positional <target> realm path/ID, use "--focus <realm>" on read commands, or set MERU_MIND_VIEWER_REALM_ID for session binding.',
    );
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
    // ---- Bootstrap & Org-Admin Commands (explicit --as-human whitelist permitted without MERU_MIND_VIEWER_REALM_ID) ----

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
          ...orgs.map(
            (o) => `- **${o.name}** (\`${o.id}\`, policy: \`${o.policy}\`)`,
          ),
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
        const orgId = requireFlag(flags, "org");
        const parentRef = requireFlag(flags, "parent");
        const parentId = resolveAdminRealmId(engine, parentRef, orgId);
        const res = engine.ledger.createRealm({
          actor,
          orgId,
          parentId,
          slug: requireFlag(flags, "slug"),
          name: requireFlag(flags, "name"),
        });
        output(res, formatGenericMarkdown("Realm Created", res));
        return;
      }
      if (sub === "list") {
        const ctx = resolveSessionContext({
          engine,
          flags,
          allowFocus: true,
        });
        const allVisible = engine.ledger.listRealms({
          orgId: ctx.org.id,
          viewerRealmId: ctx.effectiveViewerRealmId,
          scopeCeiling: ctx.effectiveScope,
        });
        const limit = parseIntFlag(flags, "limit", { min: 1 }) ?? 50;
        const sliced = allVisible.slice(0, limit);
        const omitted = Math.max(0, allVisible.length - sliced.length);
        const md = [
          `# Realms (${sliced.length}/${allVisible.length}${omitted > 0 ? `, omitted: ${omitted}` : ""})`,
          "",
          ...sliced.map((r) => `- **${r.path}** — ${r.name} (\`${r.id}\`)`),
          ...(omitted > 0 ? [`... and ${omitted} more`] : []),
        ].join("\n");
        output(sliced, md);
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
        viewerRealmId: resolveAdminRealmId(
          engine,
          requireFlag(flags, "viewer"),
          orgFlag,
        ),
        targetRealmId: resolveAdminRealmId(
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
          viewerRealmId: resolveAdminRealmId(
            engine,
            requireFlag(flags, "viewer"),
            orgFlag,
          ),
          targetRealmId: resolveAdminRealmId(
            engine,
            requireFlag(flags, "target"),
            orgFlag,
          ),
        }),
      };
      output(res, formatGenericMarkdown("Realm Unmounted", res));
      return;
    }

    if (cmd === "redact") {
      const envViewer = process.env.MERU_MIND_VIEWER_REALM_ID?.trim();
      const res = engine.ledger.redact({
        actor,
        entryId: requireFlag(flags, "id"),
        reason: flagStr(flags, "reason"),
        viewerRealmId: envViewer
          ? resolveAdminRealmId(engine, envViewer, orgFlag)
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

    if (cmd === "rebuild") {
      const res = await engine.sea.rebuild({
        restoreDrive: !flagBool(flags, "no-restore-drive"),
      });
      output(res, formatGenericMarkdown("Rebuild Completed", res));
      return;
    }

    // ---- Write Commands (Positional <targetRealm> Required; --focus Forbidden) ----

    if (cmd === "write") {
      const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
      const targetArg = sub?.trim();
      if (!targetArg) {
        throw new MindError(
          "INVALID_INPUT",
          "write requires a positional <targetRealm> argument (e.g. meru-mind write /ops --class conclusion ...)",
        );
      }
      const targetRealm = resolveVisibleRealm({
        realms: ctx.realms,
        orgId: ctx.org.id,
        ref: targetArg,
        scope: ctx.boundScope,
      });
      const behaviorClass = requireFlag(flags, "class") as BehaviorClass;
      const occurredAt = parseOccurredAtFlag(flags);

      if (behaviorClass === "raw") {
        const filePath = flagStr(flags, "file");
        const blobContent = filePath ? fs.readFileSync(filePath) : undefined;
        const entry = await engine.ledger.captureSeabed({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmId: targetRealm.id,
          kind: (flagStr(flags, "kind") as SeabedKind | undefined) ?? "message",
          text: flagStr(flags, "text") ?? "",
          topicId: flagStr(flags, "topic"),
          blobContent,
          sourceRef: flagStr(flags, "source-ref"),
          objectIds: parseCsvFlag(flags, "objects"),
          resourceTags: parseCsvFlag(flags, "tags"),
          occurredAt,
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
        const supersedesList = parseCsvFlag(flags, "supersedes");
        const rec = await engine.ledger.appendRecord({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmId: targetRealm.id,
          kind,
          extKind: flagStr(flags, "ext-kind"),
          title: requireFlag(flags, "title"),
          payload: parsePayloadJson(flagStr(flags, "payload")),
          refs: parseCsvFlag(flags, "refs"),
          externalRef: flagStr(flags, "external-ref"),
          sourceRef: flagStr(flags, "source-ref"),
          objectIds: parseCsvFlag(flags, "objects"),
          resourceTags: parseCsvFlag(flags, "tags"),
          supersedesIds: supersedesList.length > 0 ? supersedesList : undefined,
          thingId: flagStr(flags, "thing"),
          occurredAt,
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
      const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
      const targetArg = sub?.trim();
      if (!targetArg) {
        throw new MindError(
          "INVALID_INPUT",
          'capture requires a positional <targetRealm> argument (e.g. meru-mind write /ops --class raw --kind message --text "...")',
        );
      }
      const targetRealm = resolveVisibleRealm({
        realms: ctx.realms,
        orgId: ctx.org.id,
        ref: targetArg,
        scope: ctx.boundScope,
      });
      const filePath = flagStr(flags, "file");
      const blobContent = filePath ? fs.readFileSync(filePath) : undefined;
      const entry = await engine.ledger.captureSeabed({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        targetRealmId: targetRealm.id,
        kind: requireFlag(flags, "kind") as SeabedKind,
        text: flagStr(flags, "text") ?? "",
        topicId: flagStr(flags, "topic"),
        blobContent,
        sourceRef: flagStr(flags, "source-ref"),
        objectIds: parseCsvFlag(flags, "objects"),
        resourceTags: parseCsvFlag(flags, "tags"),
        occurredAt: parseOccurredAtFlag(flags),
        sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
        idempotencyKey: flagStr(flags, "idempotency-key"),
      });
      output(entry, formatGenericMarkdown("Captured [raw]", entry));
      return;
    }

    // Deprecated alias for write --class rule|conclusion (scheduled for removal in v0.3.0)
    if (cmd === "record") {
      const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
      const targetArg = sub?.trim();
      if (!targetArg) {
        throw new MindError(
          "INVALID_INPUT",
          'record requires a positional <targetRealm> argument (e.g. meru-mind write /ops --class conclusion --kind decision --title "...")',
        );
      }
      const targetRealm = resolveVisibleRealm({
        realms: ctx.realms,
        orgId: ctx.org.id,
        ref: targetArg,
        scope: ctx.boundScope,
      });
      const supersedesList = parseCsvFlag(flags, "supersedes");
      const rec = await engine.ledger.appendRecord({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        targetRealmId: targetRealm.id,
        kind: requireFlag(flags, "kind") as RecordKind,
        extKind: flagStr(flags, "ext-kind"),
        title: requireFlag(flags, "title"),
        payload: parsePayloadJson(flagStr(flags, "payload")),
        refs: parseCsvFlag(flags, "refs"),
        externalRef: flagStr(flags, "external-ref"),
        sourceRef: flagStr(flags, "source-ref"),
        objectIds: parseCsvFlag(flags, "objects"),
        resourceTags: parseCsvFlag(flags, "tags"),
        supersedesIds: supersedesList.length > 0 ? supersedesList : undefined,
        thingId: flagStr(flags, "thing"),
        occurredAt: parseOccurredAtFlag(flags),
        sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
        idempotencyKey: flagStr(flags, "idempotency-key"),
      });
      output(rec, formatGenericMarkdown(`Recorded [${rec.kind}]`, rec));
      return;
    }

    // ---- Read & Explore Commands ----

    if (cmd === "tree") {
      const ctx = resolveSessionContext({ engine, flags, allowFocus: true });
      const includeObjects = flagBool(flags, "no-objects")
        ? false
        : flagBool(flags, "objects")
          ? true
          : true;
      const res = engine.sea.tree({
        actor,
        viewerRealmId: ctx.effectiveViewerRealmId,
        target: sub,
        depth: parseDepthFlag(flags),
        includeObjects,
        limit: parseIntFlag(flags, "limit", { min: 1 }),
        scopeCeiling: ctx.effectiveScope,
      });
      output(res, formatTreeMarkdown(res));
      return;
    }

    if (cmd === "ls") {
      const includeDescendantSeabed = flagBool(
        flags,
        "include-descendant-seabed",
      );
      const ctx = resolveSessionContext({
        engine,
        flags,
        allowFocus: true,
        includeDescendantSeabed,
      });
      const target = sub ?? flagStr(flags, "target");
      const res = await engine.sea.ls({
        actor,
        viewerRealmId: ctx.effectiveViewerRealmId,
        target,
        targetType: flagStr(flags, "type") as LsTargetType | undefined,
        kind: flagStr(flags, "kind"),
        tag: flagStr(flags, "tag"),
        includeSuperseded:
          flagBool(flags, "include-superseded") ||
          flagBool(flags, "include-history"),
        includeDescendantSeabed,
        limit: parseIntFlag(flags, "limit", { min: 1 }),
        offset: parseIntFlag(flags, "offset", { min: 0 }),
        scopeCeiling: ctx.effectiveScope,
      });
      output(res, formatLsMarkdown(res));
      return;
    }

    if (cmd === "cat") {
      const includeDescendantSeabed = flagBool(
        flags,
        "include-descendant-seabed",
      );
      const ctx = resolveSessionContext({
        engine,
        flags,
        allowFocus: true,
        includeDescendantSeabed,
      });
      const target = sub ?? flagStr(flags, "id") ?? flagStr(flags, "path");
      if (!target) {
        throw new MindError(
          "INVALID_INPUT",
          "cat requires an entry ID or drive path argument (e.g. meru-mind cat rec_... or meru-mind cat notes.md --target /ops)",
        );
      }
      if (target.trim().startsWith("obj:")) {
        throw new MindError(
          "INVALID_INPUT",
          `Objects cannot be viewed with "cat"; run "meru-mind ls ${target.trim()}" instead.`,
        );
      }
      const res = await engine.sea.cat({
        actor,
        viewerRealmId: ctx.effectiveViewerRealmId,
        target,
        targetRealmRef: flagStr(flags, "target"),
        includeDescendantSeabed,
        scopeCeiling: ctx.effectiveScope,
      });
      output(res, formatCatMarkdown(res));
      return;
    }

    if (cmd === "brief") {
      const ctx = resolveSessionContext({ engine, flags, allowFocus: true });
      const n = parseIntFlag(flags, "limit", { min: 1 });
      const maxChildren = parseIntFlag(flags, "max-children", { min: 1 });
      const res = engine.sea.brief({
        actor,
        viewerRealmId: ctx.effectiveViewerRealmId,
        target: sub,
        scopeCeiling: ctx.effectiveScope,
        budget:
          n || maxChildren
            ? {
                ...(n
                  ? {
                      recentMessages: n,
                      maxQuestions: n,
                      maxActiveThings: n,
                      maxDecisions: n,
                      maxRecentConclusions: n,
                    }
                  : {}),
                ...(maxChildren ? { maxChildSummaries: maxChildren } : {}),
              }
            : undefined,
      });
      output(res, formatBriefMarkdown(res));
      return;
    }

    if (cmd === "recall") {
      const includeDescendantSeabed = flagBool(
        flags,
        "include-descendant-seabed",
      );
      const ctx = resolveSessionContext({
        engine,
        flags,
        allowFocus: true,
        includeDescendantSeabed,
      });
      const limit = parseIntFlag(flags, "limit", { min: 1 });
      const offset = parseIntFlag(flags, "offset", { min: 0 });
      const targetFlag = flagStr(flags, "target");
      const targetRealmId = targetFlag
        ? resolveVisibleRealm({
            realms: ctx.realms,
            orgId: ctx.org.id,
            ref: targetFlag,
            scope: ctx.effectiveScope,
          }).id
        : undefined;
      const kinds = parseCsvFlag(flags, "kind") as RecordKind[];
      const queryText = flagStr(flags, "query") ?? sub;
      const res = await engine.sea.recall({
        actor,
        viewerRealmId: ctx.effectiveViewerRealmId,
        scopeCeiling: ctx.effectiveScope,
        query: queryText,
        id: flagStr(flags, "id"),
        thingId: flagStr(flags, "thing"),
        targetRealmId,
        recordKinds: kinds.length > 0 ? kinds : undefined,
        authorId: flagStr(flags, "author"),
        since: flagStr(flags, "since"),
        until: flagStr(flags, "until"),
        includeSuperseded:
          flagBool(flags, "include-superseded") ||
          flagBool(flags, "include-history"),
        includeDescendantSeabed,
        focusBoost: flagBool(flags, "focus-boost"),
        limit,
        offset,
      });
      output(res, formatRecallMarkdown(res));
      return;
    }

    if (cmd === "replay") {
      const includeDescendantSeabed = flagBool(
        flags,
        "include-descendant-seabed",
      );
      const ctx = resolveSessionContext({
        engine,
        flags,
        allowFocus: true,
        includeDescendantSeabed,
      });
      const entryId = sub ?? flagStr(flags, "id");
      if (!entryId) {
        throw new MindError(
          "INVALID_INPUT",
          "replay requires an entry ID (e.g. meru-mind replay rec_... --window 5)",
        );
      }
      const res = engine.sea.replay({
        actor,
        viewerRealmId: ctx.effectiveViewerRealmId,
        entryId,
        window: parseIntFlag(flags, "window", { min: 1 }),
        includeDescendantSeabed,
        scopeCeiling: ctx.effectiveScope,
      });
      output(res, formatReplayMarkdown(res));
      return;
    }

    if (cmd === "changes") {
      const includeDescendantSeabed = flagBool(
        flags,
        "include-descendant-seabed",
      );
      const ctx = resolveSessionContext({
        engine,
        flags,
        allowFocus: true,
        includeDescendantSeabed,
      });
      const res = engine.sea.changes({
        actor,
        viewerRealmId: ctx.effectiveViewerRealmId,
        target: sub,
        sinceSeq: parseIntFlag(flags, "since", { min: 0 }) ?? 0,
        limit: parseIntFlag(flags, "limit", { min: 1 }),
        includeDescendantSeabed,
        scopeCeiling: ctx.effectiveScope,
      });
      output(res, formatChangesMarkdown(res));
      return;
    }

    // ---- Things, Objects & Tags ----

    if (cmd === "thing") {
      if (sub === "create") {
        const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
        const targetRef = third ?? flagStr(flags, "target");
        const targetRealmId = targetRef
          ? resolveVisibleRealm({
              realms: ctx.realms,
              orgId: ctx.org.id,
              ref: targetRef,
              scope: ctx.boundScope,
            }).id
          : ctx.boundViewerRealmId;
        const rec = await engine.ledger.createThing({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmId,
          title: requireFlag(flags, "title"),
          externalRef: flagStr(flags, "external-ref"),
          payload: parsePayloadJson(flagStr(flags, "payload")),
          refs: parseCsvFlag(flags, "refs"),
          objectIds: parseCsvFlag(flags, "objects"),
          resourceTags: parseCsvFlag(flags, "tags"),
          occurredAt: parseOccurredAtFlag(flags),
          sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
          idempotencyKey: flagStr(flags, "idempotency-key"),
          dedupeByExternalRef: flagBool(flags, "dedupe"),
        });
        output(rec, formatGenericMarkdown("Thing Created", rec));
        return;
      }
      if (sub === "list") {
        const ctx = resolveSessionContext({ engine, flags, allowFocus: true });
        const res = engine.ledger.listThings({
          actor,
          viewerRealmId: ctx.effectiveViewerRealmId,
          targetRealmRef: third ?? flagStr(flags, "target"),
          externalRef: flagStr(flags, "external-ref"),
          includeSuperseded:
            flagBool(flags, "include-superseded") ||
            flagBool(flags, "include-history"),
          limit: parseIntFlag(flags, "limit", { min: 1 }) ?? 50,
          offset: parseIntFlag(flags, "offset", { min: 0 }),
          scopeCeiling: ctx.effectiveScope,
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
      if (sub === "create") {
        const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
        const obj = engine.objects.createObject({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmRef: third ?? flagStr(flags, "target"),
          parentObjectId: flagStr(flags, "parent"),
          kind: requireFlag(flags, "kind"),
          name: requireFlag(flags, "name"),
        });
        output(obj, formatGenericMarkdown("Object Created", obj));
        return;
      }
      if (sub === "list") {
        const ctx = resolveSessionContext({ engine, flags, allowFocus: true });
        const allObjs = engine.objects.listObjects({
          viewerRealmId: ctx.effectiveViewerRealmId,
          realmRef: third ?? flagStr(flags, "target"),
          parentObjectId: flagStr(flags, "parent"),
          kind: flagStr(flags, "kind"),
          scopeCeiling: ctx.effectiveScope,
        });
        const limit = parseIntFlag(flags, "limit", { min: 1 }) ?? 50;
        const sliced = allObjs.slice(0, limit);
        output(sliced, formatObjectsMarkdown(sliced, allObjs.length));
        return;
      }
      if (sub === "delete") {
        const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
        const removed = engine.objects.deleteObject({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          objectId: requireFlag(flags, "id"),
        });
        output({ removed }, formatGenericMarkdown("Object Deleted", { removed }));
        return;
      }
      if (sub === "link") {
        const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
        const link = engine.objects.linkEntryObject({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
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
      if (sub === "list") {
        const includeDescendantSeabed = flagBool(
          flags,
          "include-descendant-seabed",
        );
        const ctx = resolveSessionContext({
          engine,
          flags,
          allowFocus: true,
          includeDescendantSeabed,
        });
        const allTags = engine.objects.listResourceTags({
          viewerRealmId: ctx.effectiveViewerRealmId,
          realmRef: third ?? flagStr(flags, "target"),
          prefix: flagStr(flags, "prefix"),
          includeDescendantSeabed,
          scopeCeiling: ctx.effectiveScope,
        });
        const limit = parseIntFlag(flags, "limit", { min: 1 }) ?? 50;
        const sliced = allTags.slice(0, limit);
        output(sliced, formatTagsMarkdown(sliced, allTags.length));
        return;
      }
      if (sub === "add") {
        const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
        const added = engine.objects.tagEntryResource({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
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

    // ---- Importers & Consistency Verification ----

    if (cmd === "import-md") {
      const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
      const inputPath = sub ?? flagStr(flags, "path") ?? flagStr(flags, "file");
      if (!inputPath) {
        throw new MindError(
          "INVALID_INPUT",
          "import-md requires a Markdown file or directory path",
        );
      }
      const mapPath = flagStr(flags, "map");
      const mapping = mapPath ? loadMappingFile(mapPath) : undefined;
      const res = await engine.importer.importMd({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
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
        mapping,
        syncEmbeddings: flagBool(flags, "sync-embeddings"),
      });
      output(res, formatImportMdMarkdown(res));
      return;
    }

    if (cmd === "import-jsonl") {
      const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
      const jsonlPath = sub ?? flagStr(flags, "path") ?? flagStr(flags, "file");
      if (!jsonlPath) {
        throw new MindError(
          "INVALID_INPUT",
          "import-jsonl requires a JSONL file path",
        );
      }
      const mapping = loadMappingFile(requireFlag(flags, "map"));
      const res = await engine.importer.importJsonl({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        targetRealmRef: flagStr(flags, "target"),
        jsonlPath,
        mapping,
        syncEmbeddings: flagBool(flags, "sync-embeddings"),
      });
      output(res, formatImportJsonlMarkdown(res));
      return;
    }

    if (cmd === "import-verify") {
      const ctx = resolveSessionContext({ engine, flags, allowFocus: true });
      const sourcePath =
        flagStr(flags, "source") ?? sub ?? flagStr(flags, "path");
      if (!sourcePath) {
        throw new MindError(
          "INVALID_INPUT",
          "import-verify requires --source <file|dir>",
        );
      }
      const mapPath = flagStr(flags, "map");
      const mapping = mapPath ? loadMappingFile(mapPath) : undefined;
      const res = engine.importer.verifyImportConsistency({
        viewerRealmId: ctx.effectiveViewerRealmId,
        sourcePath,
        mapping,
        baseDir: flagStr(flags, "base-dir"),
        targetRealmRef: flagStr(flags, "target"),
      });
      output(res, formatImportVerifyMarkdown(res));
      if (!res.passed) {
        process.exitCode = 1;
      }
      return;
    }

    // ---- Shared Drive ----

    if (cmd === "drive") {
      if (sub === "write") {
        const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
        const targetArg = third?.trim();
        if (!targetArg) {
          throw new MindError(
            "INVALID_INPUT",
            'drive write requires a positional <targetRealm> argument (e.g. meru-mind drive write /ops --path notes.md --content "...")',
          );
        }
        const targetRealm = resolveVisibleRealm({
          realms: ctx.realms,
          orgId: ctx.org.id,
          ref: targetArg,
          scope: ctx.boundScope,
        });
        const filePath = flagStr(flags, "file");
        const content = filePath
          ? fs.readFileSync(filePath, "utf8")
          : requireFlag(flags, "content");
        const expectedVersion = parseIntFlag(flags, "expected-version", {
          min: 0,
        });
        const res = await engine.ledger.writeDriveFile({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmId: targetRealm.id,
          relPath: requireFlag(flags, "path"),
          content,
          expectedVersion,
          message: flagStr(flags, "message"),
        });
        output(res, formatGenericMarkdown("Drive File Written", res));
        return;
      }
      if (sub === "read") {
        const ctx = resolveSessionContext({ engine, flags, allowFocus: true });
        const targetRef = third ?? flagStr(flags, "target");
        const targetId = targetRef
          ? resolveVisibleRealm({
              realms: ctx.realms,
              orgId: ctx.org.id,
              ref: targetRef,
              scope: ctx.effectiveScope,
            }).id
          : ctx.effectiveViewerRealmId;
        const res = await engine.ledger.readDriveFile({
          actor,
          viewerRealmId: ctx.effectiveViewerRealmId,
          targetRealmId: targetId,
          relPath: requireFlag(flags, "path"),
          scopeCeiling: ctx.effectiveScope,
        });
        output(res, res ? res.content : "_(not found)_");
        return;
      }
      if (sub === "list") {
        const ctx = resolveSessionContext({ engine, flags, allowFocus: true });
        const targetRef = third ?? flagStr(flags, "target");
        const targetId = targetRef
          ? resolveVisibleRealm({
              realms: ctx.realms,
              orgId: ctx.org.id,
              ref: targetRef,
              scope: ctx.effectiveScope,
            }).id
          : ctx.effectiveViewerRealmId;
        const res = await engine.ledger.listDriveFiles({
          actor,
          viewerRealmId: ctx.effectiveViewerRealmId,
          targetRealmId: targetId,
          scopeCeiling: ctx.effectiveScope,
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

    // ---- Settle & Slice Export ----

    if (cmd === "settle") {
      const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
      const targetArg = sub?.trim();
      if (!targetArg) {
        throw new MindError(
          "INVALID_INPUT",
          "settle requires a positional <targetRealm> argument (e.g. meru-mind settle /ops --layer slice_day --period 2026-11-22)",
        );
      }
      const targetRealm = resolveVisibleRealm({
        realms: ctx.realms,
        orgId: ctx.org.id,
        ref: targetArg,
        scope: ctx.boundScope,
      });
      const sourcesRaw = flagStr(flags, "sources");
      const sourceIds = sourcesRaw
        ? sourcesRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const res = await engine.sea.settle({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        targetRealmId: targetRealm.id,
        layer: requireFlag(flags, "layer") as DistillationLayer,
        periodKey: requireFlag(flags, "period"),
        narrativeMd: flagStr(flags, "narrative"),
        sourceIds,
      });
      output(res, formatGenericMarkdown("Settled Distillation", res));
      return;
    }

    if (cmd === "export-slice") {
      const ctx = resolveSessionContext({ engine, flags, allowFocus: false });
      const targetId = sub
        ? resolveVisibleRealm({
            realms: ctx.realms,
            orgId: ctx.org.id,
            ref: sub,
            scope: ctx.boundScope,
          }).id
        : ctx.boundViewerRealmId;
      const res = await engine.slice.exportSlice({
        actor,
        viewerRealmId: targetId,
        outDir: requireFlag(flags, "out"),
      });
      output(res, formatGenericMarkdown("Slice Exported", res));
      return;
    }

    throw new MindError(
      "INVALID_INPUT",
      `Unknown command: "${cmd}". Run "meru-mind --help" to see available commands.`,
    );
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
