#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import {
  buildWriteRecordPayload,
  createAuthToken,
  createInvite,
  createMindEngine,
  discoverWorkspaceRealmMarker,
  ejectDefaultUiShell,
  exportRecordsAsMarkdown,
  findRelatedActiveForEcho,
  formatChangesMarkdown,
  formatDoctorMarkdown,
  formatExportMdMarkdown,
  formatGenericMarkdown,
  formatImportDryRunMarkdown,
  formatImportJsonlMarkdown,
  formatImportMdMarkdown,
  formatImportVerifyMarkdown,
  formatLsMarkdown,
  formatSearchMarkdown,
  formatShowMarkdown,
  formatSurfaceErrorText,
  formatTreeMarkdown,
  formatUpgradeMarkdown,
  formatWhoamiMarkdown,
  isRealmEffectivelyArchived,
  LocalMindSurface,
  lookupSavedCredential,
  MERU_MIND_VERSION,
  MindError,
  OPAQUE_OBJECT_NOT_FOUND,
  OPAQUE_REALM_NOT_FOUND,
  parseRefSyntax,
  resolveAboutRefsForWrite,
  resolveAccessScope,
  resolveFileRef,
  resolveRealmByPath,
  resolveUnifiedObjectRead,
  resolveVisibleRealm,
  resolveWriteTargetRealm,
  runRealmDoctor,
  runUpgrade,
  saveProfileCredential,
  startMindServer,
  toPublicInvite,
  toPublicToken,
  toSurfaceError,
  writeEverydayConclusion,
  type AccessScope,
  type Actor,
  type ActorKind,
  type ActorRole,
  type DistillationLayer,
  type ImportMappingConfig,
  type LsOnlyFilter,
  type MindEngine,
  type MountScope,
  type ObjectState,
  type Organization,
  type OrgPolicy,
  type Realm,
  type RecordKind,
  type SeabedKind,
  type Sensitivity,
} from "./index.js";
import { runRemoteCliCommand } from "./cli-remote.js";
import { createVisibilityHelpers } from "./engine/visibility.js";

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
  multiFlags: Record<string, string[]>;
}

const GLOBAL_FLAGS = new Set([
  "home",
  "url",
  "token",
  "drive",
  "actor",
  "actor-kind",
  "as-human",
  "family",
  "org",
  "json",
  "help",
  "version",
]);

const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "version",
  "personal",
  "as-human",
  "init-token",
  "include-confidential",
  "demo",
  "history",
  "full",
  "include-descendant-seabed",
  "no-restore-drive",
  "sync-embeddings",
  "include-secret",
  "objects",
  "no-objects",
  "all",
  "dry-run",
  "check",
  // Legacy boolean flags parsed without swallowing the next token so UNKNOWN_FLAG reports cleanly
  "include-superseded",
  "include-history",
  "focus-boost",
  "dedupe",
]);

const REMOVED_COMMAND_HINTS: Record<string, string> = {
  recall: 'meru-mind search "<query>"',
  cat: "meru-mind show <ref>",
  brief: "meru-mind show <realm>",
  replay: "meru-mind show <entryId> --context 5",
  record: 'meru-mind write --in <realm> --title "<title>" --body "<body>"',
  capture: 'meru-mind raw add --in <realm> --kind message --text "<text>"',
  drive:
    'meru-mind show file:/<realm>/<path>  (or meru-mind file write file:/<realm>/<path> --content "...")',
  mount: "meru-mind realm mount --viewer <realm> --target <realm> --as-human",
  unmount:
    "meru-mind realm unmount --viewer <realm> --target <realm> --as-human",
  thing: "meru-mind show thing:<ref>  (or meru-mind ls thing:<ref>)",
  tag: "meru-mind ls <type>:<name>  (or meru-mind write --about <type>:<name>)",
  "import-md": "meru-mind import md <file-or-dir>",
  "import-jsonl":
    "meru-mind import jsonl <file.jsonl> --map <mapping.json>",
  "import-verify": "meru-mind import verify --source <file|dir>",
  init: "meru-mind admin init",
  "sync-embeddings": "meru-mind admin sync-embeddings",
  rebuild: "meru-mind admin rebuild",
  "export-slice": "meru-mind admin export-slice --out <dir>",
  // Intuitive guesses
  status: "meru-mind whoami",
  inspect: "meru-mind show <ref>",
  log: "meru-mind changes",
  add: 'meru-mind write --in <realm> --title "<title>" --body "<body>"',
  find: 'meru-mind search "<query>"',
  grep: 'meru-mind search "<query>"',
  query: 'meru-mind search "<query>"',
  list: "meru-mind ls",
  get: "meru-mind show <ref>",
  read: "meru-mind show <ref>",
  view: "meru-mind show <ref>",
};

const REMOVED_FLAG_HINTS: Record<string, string> = {
  realm: "Use --in <realm>, positional <ref>, or MERU_MIND_VIEWER_REALM_ID",
  type: "Use --only realms|objects|entries|files (or typed ref <kind>:<name>)",
  target: "Use --in <realm> or positional <ref>",
  focus: "Use --in <realm> to scope reads (or set MERU_MIND_VIEWER_REALM_ID)",
  "focus-boost":
    "Focus tie-breaking is SDK-only; use 'meru-mind search \"<query>\" --in <realm>'",
  offset: "Use --cursor <cursor> returned by the previous page",
  tag: "Use --about <type>:<name>",
  tags: "Use repeatable --about <type>:<name>",
  class:
    "Use 'meru-mind write' (conclusions), 'meru-mind rule add --as-human' (rules), or 'meru-mind raw add' (raw)",
  "include-superseded": "Use --history",
  "include-history": "Use --history",
  window: "Use 'meru-mind show <entryId> --context <N>'",
  refs: "Use repeatable --because <ref>",
};

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const multiFlags: Record<string, string[]> = {};

  const recordFlag = (key: string, value: string | boolean) => {
    flags[key] = value;
    if (typeof value === "string") {
      const arr = multiFlags[key] ?? [];
      arr.push(value);
      multiFlags[key] = arr;
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token === "-L") {
      if (i + 1 < argv.length) {
        recordFlag("depth", argv[i + 1]!);
        i += 1;
      } else {
        throw new MindError("INVALID_INPUT", "Flag -L requires a value", {
          try: "meru-mind tree / -L 2",
        });
      }
    } else if (token.startsWith("-L=")) {
      recordFlag("depth", token.slice(3));
    } else if (token === "-h") {
      recordFlag("help", true);
    } else if (token === "-v") {
      recordFlag("version", true);
    } else if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        recordFlag(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const key = token.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          recordFlag(key, true);
          continue;
        }
        if (i + 1 < argv.length) {
          recordFlag(key, argv[i + 1]!);
          i += 1;
        } else {
          throw new MindError(
            "INVALID_INPUT",
            `Flag --${key} requires a value`,
            { try: "meru-mind --help" },
          );
        }
      }
    } else if (token.startsWith("-") && token.length > 1) {
      throw new MindError("UNKNOWN_FLAG", `Unknown short flag "${token}"`, {
        try: "meru-mind --help",
      });
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags, multiFlags };
}

function assertAllowedFlags(
  flags: Record<string, string | boolean>,
  allowed: Iterable<string>,
  cmdLabel: string,
): void {
  const allowSet = new Set([...GLOBAL_FLAGS, ...allowed]);
  for (const key of Object.keys(flags)) {
    if (!allowSet.has(key)) {
      const hint = REMOVED_FLAG_HINTS[key];
      throw new MindError(
        "UNKNOWN_FLAG",
        `Unknown flag "--${key}" for "${cmdLabel}"`,
        {
          try: hint ?? `meru-mind ${cmdLabel} --help`,
        },
      );
    }
  }
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
  cmdLabel: string,
): string {
  const val = flagStr(flags, key);
  if (!val) {
    throw new MindError(
      "INVALID_INPUT",
      `Missing required flag --${key} for "${cmdLabel}"`,
      { try: `meru-mind ${cmdLabel} --help` },
    );
  }
  return val;
}

function flagBool(
  flags: Record<string, string | boolean>,
  key: string,
): boolean {
  if (!BOOLEAN_FLAGS.has(key)) {
    throw new Error(
      `Internal CLI error: boolean flag "--${key}" is not registered in BOOLEAN_FLAGS`,
    );
  }
  return flags[key] === true || flags[key] === "true";
}

function flagMulti(
  multiFlags: Record<string, string[]>,
  key: string,
): string[] {
  return (multiFlags[key] ?? []).map((s) => s.trim()).filter(Boolean);
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
  if (
    !trimmed ||
    trimmed.toLowerCase() === "none" ||
    trimmed.toLowerCase() === "null"
  ) {
    return null;
  }
  return trimmed;
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

// ---- Two-Level --help (Top-level <= 30 lines; Per-command detailed help) ----

const TOP_LEVEL_HELP = `meru-mind — Scoped memory & ledger CLI (7 everyday verbs + typed refs)

START HERE:
  meru-mind whoami                     Show org, actor, bound realm, counts & next step
  meru-mind tree /                     Browse visible realms & objects (-L 1 default)
  meru-mind ls <ref>                   List a realm or entries about an object
  meru-mind show <ref>                 Inspect any realm, object, entry, or file
  meru-mind search "<words>"           Ranked full-text + vector search

REFS (any ref printed in output can be pasted back as input):
  /path | @mounted/<alias>             Realm (e.g. /, /ops/cicd, @mounted/shared)
  <kind>:<name> | /<realm>/<k>:<n>     Object (e.g. service:api, /ops/service:api)
  rec_... | sea_...                    Entry ID
  file:/<realm>/<rel-path>             Shared drive file (e.g. file:/ops/sop.md)

READ [read]:
  whoami | tree [ref] | ls [ref] | show <ref> | search <query> | changes

RECORD [write]:
  write [--in <realm>] --title T --body B [--kind decision|finding|claim|proposal|verdict]
        [--about <obj>]... [--supersedes <entry>]... [--because <ref>]...
        [--occurred-at <iso|none>] [--sensitivity public|internal|confidential|secret]

MANAGE [write / human] (experimental: file, raw, settle):
  realm | entry | object | file | rule | raw | redact | settle | import | serve | ui | token | work | org | admin | upgrade

OUTPUT:
  Markdown capped with next-page --cursor; pass --json for JSON; errors include try:.

HELP:  meru-mind <command> --help
`;

const COMMAND_HELP: Record<string, string> = {
  whoami: `Risk: read
When to use: Check bound org, actor, realm visibility, visible corpus counts, latestSeq, and next step.
Usage: meru-mind whoami [--json] [--org <orgId>]
Flags:
  --json     Output JSON
  --org      Explicit organization ID
Examples:
  meru-mind whoami
  MERU_MIND_VIEWER_REALM_ID=/eng/api meru-mind whoami --json
`,
  tree: `Risk: read
When to use: Discover visible realms, mounted realms (@mounted/<alias>), objects, and counts.
Usage: meru-mind tree [ref] [-L|--depth <n|all>] [--objects|--no-objects] [--all] [--limit <n>]
Flags:
  -L, --depth <n|all>    Expansion depth (default: 1; 0 = target only; all = unlimited)
  --objects/--no-objects Include object hierarchy (default: true)
  --all                  Include archived realms (default: hidden with count footer)
  --limit <n>            Max Markdown output lines (default: 60)
Examples:
  meru-mind tree /
  meru-mind tree /ops -L 2 --no-objects
`,
  ls: `Risk: read
When to use: List sub-realms, objects, entries, and files in a realm, or all entries about an object.
Usage: meru-mind ls [ref] [--only realms|objects|entries|files] [--kind <k1,k2>] [--about <obj>] [--since <iso>] [--until <iso>] [--history] [--include-descendant-seabed] [--limit <n>] [--cursor <c>]
Flags:
  --only <type>          Filter output to realms, objects, entries, or files
  --kind <k1,k2>         Comma-separated record/raw kinds
  --about <objRef>       Filter realm entries by unified object ref (<kind>:<name>)
  --since / --until      ISO timestamps filtering occurred_at (excludes undated)
  --history              Include superseded entries
  --limit <n>            Page size (default: 20, max: 200)
  --cursor <c>           Pagination cursor from previous page
Examples:
  meru-mind ls /ops --only files
  meru-mind ls service:payment-api --limit 10
  meru-mind ls /ops/service:api --history
`,
  show: `Risk: read
When to use: Inspect any ref verbatim: /realm (brief), kind:name (object card), rec_/sea_ (entry), or file:/realm/path.
Usage: meru-mind show <ref> [--around "<words>"] [--cursor <cursor>] [--chars <N>] [--full] [--history] [--context <N>] [--include-descendant-seabed]
Flags:
  --chars <N>            Character window size (default: 3500, max: 200000)
  --around "<words>"     Center window around matching query words
  --cursor <cursor>      Pagination cursor from previous window footer
  --full                 Show full content without window truncation
  --history              Include supersede DAG history (on record entries)
  --context <N>          Include ±N timeline replay window (integer >= 0)
  --include-descendant-seabed  Include descendant raw seabed in context
Examples:
  meru-mind show /ops/cicd
  meru-mind show service:payment-api
  meru-mind show rec_0123456789abcdef --chars 1200 --history --context 5
  meru-mind show file:/ops/cicd/sop.md
`,
  search: `Risk: read
When to use: Ranked full-text (CJK-bigram FTS5) and vector search across visible memory.
Usage: meru-mind search <query> [--in <realm>] [--about <obj>] [--kind <k1,k2>] [--since <iso>] [--until <iso>] [--history] [--include-descendant-seabed] [--limit <n>] [--cursor <c>]
Flags:
  --in <realm>           Narrow search to visible realm subtree (tree: scope(in) ∩ scope(bound))
  --about <objRef>       Restrict to entries linked/tagged to unified object ref
  --kind <k1,k2>         Filter by record/raw kinds
  --since / --until      Filter by declared occurred_at ISO range
  --history              Include superseded entries
  --limit <n>            Page size (default: 10, max: 200)
  --cursor <c>           Pagination cursor
Examples:
  meru-mind search "deployment rollback"
  meru-mind search "latency" --in /ops --about service:api --limit 5
`,
  changes: `Risk: read
When to use: Poll incremental visible change log entries after a sequence number.
Usage: meru-mind changes [--since <seq>] [--in <realm>] [--limit <n>] [--include-descendant-seabed]
Flags:
  --since <seq>          Return changes with seq > value (default: 0)
  --in <realm>           SQL-pushed realm subtree filter
  --limit <n>            Max entries per page (default: 50, max: 500)
Examples:
  meru-mind changes --since 0
  meru-mind changes --since 42 --in /ops --limit 20
`,
  write: `Risk: write
When to use: Record a conclusion (finding, decision, claim, proposal, verdict). Rules require 'meru-mind rule add --as-human'.
Usage: meru-mind write [--in <realm>] --title <T> --body <B> [--kind <k>] [--about <obj>]... [--supersedes <id>]... [--because <ref>]... [--occurred-at <iso|none>] [--sensitivity <level>] [--idempotency-key <key>]
Routing (when --in is omitted): bound realm / .meru-mind-realm -> unanimous --about owner -> /inbox (open mode).
Flags:
  --in <realm>           Optional target writable realm (/path or realm_...); auto-routed if omitted
  --title <text>         Short conclusion title [required]
  --body <text>          Conclusion details [required]
  --kind <kind>          decision|finding|claim|proposal|verdict (default: finding; rule forbidden)
  --about <objRef>       Repeatable unified object ref (<kind>:<name>, /<realm>/<k>:<n>, obj_...)
  --supersedes <entryId> Repeatable active record ID(s) to supersede atomically
  --because <ref>        Repeatable evidence/entry reference IDs
  --occurred-at <iso|none> Declared ISO timestamp or 'none' for undated (default: now)
  --sensitivity <level>  public|internal|confidential|secret (default: internal)
  --idempotency-key <k>  Explicit idempotency key (default: auto-idempotent per 1-minute UTC bucket;
                         retries straddling a :59/:00 minute boundary create a second entry unless
                         explicit --occurred-at or --idempotency-key is supplied)
Examples:
  meru-mind write --in /ops --kind decision --title "Use WAL mode" --body "Enabled SQLite WAL."
  meru-mind write --title "API timeout" --body "Raised timeout to 30s" --about service:api
`,
  realm: `Risk: high-risk-write (all realm mutations require --as-human in both open and tree orgs)
When to use: Create, scope, archive/unarchive, list, or mount realms (slug is immutable; name & scope are mutable).
Usage:
  meru-mind realm create [--org <orgId>] --parent <realm> --slug <slug> --name <name> --scope <scope> --as-human
  meru-mind realm set <realmRef> [--name <name>] [--scope <scope>] --as-human
  meru-mind realm archive <realmRef> --as-human
  meru-mind realm unarchive <realmRef> --as-human
  meru-mind realm list [--all] [--limit <n>]
  meru-mind realm mount --viewer <realm> --target <realm> [--scope all|ledger|drive] --as-human
  meru-mind realm unmount --viewer <realm> --target <realm> --as-human
Examples:
  meru-mind realm create --parent / --slug ops --name "Operations" --scope "Include: releases, alerts. Exclude: product specs." --as-human
  meru-mind realm set /ops --scope "Include: prod deploys, rollbacks. Exclude: CI flakes." --as-human
  meru-mind realm archive /old-project --as-human
`,
  entry: `Risk: high-risk-write (requires --as-human)
When to use: Move misplaced ledger/raw entries (e.g. triaging /inbox or evacuating an archived realm) in-place without breaking history.
Usage:
  meru-mind entry move <entryId>... --to <realmRef> [--from <realmRef>] [--ids-file <path|->] [--dry-run] [--org <orgId>] --as-human
Examples:
  meru-mind entry move rec_0123456789abcdef --to /ops --as-human
  meru-mind entry move --ids-file ids.txt --from / --to /ops --dry-run --as-human
`,
  object: `Risk: write
When to use: Create, reparent, delete, link, unlink, set lifecycle state, or manage aliases on structured objects (kind "file" is reserved).
Usage:
  meru-mind object create [--in <realm>] --kind <kind> --name <name> [--parent <objRef>]
  meru-mind object move <objRef> --parent <parentObjRef|none>
  meru-mind object delete <objRef>
  meru-mind object link <entryId> <objRef>
  meru-mind object unlink <entryId> <objRef>
  meru-mind object set <objRef> --state inactive --label <slug> [--since YYYY-MM-DD] [--because <rec_id>]
  meru-mind object set <objRef> --state active
  meru-mind object alias <objRef> [--add <text>]... [--remove <text>]...
Examples:
  meru-mind object create --in /ops --kind service --name payment-api
  meru-mind object set service:payment-api --state inactive --label deprecated --since 2026-10-26 --because rec_0123456789abcdef
  meru-mind object alias service:payment-api --add "Payment API"
`,
  file: `Risk: write [experimental]
When to use: Write a versioned file to a MindRealm shared drive (experimental; use 'meru-mind show file:...' to read).
Usage:
  meru-mind file write <file:/realm/relPath> (--content <text> | --file <localPath>) [--expected-version <n>] [--message <msg>]
Examples:
  meru-mind file write file:/ops/sop.md --content "# SOP" --message "Initial draft"
  meru-mind file write file:/ops/sop.md --file ./sop.md --expected-version 1
`,
  rule: `Risk: high-risk-write (human-only; --as-human required)
When to use: Add a governance rule inherited by descendant realms.
Usage:
  meru-mind rule add --in <realm> --title <T> --body <B> [--about <obj>]... [--supersedes <id>]... [--because <ref>]... [--occurred-at <iso|none>] [--sensitivity <level>] --as-human
Examples:
  meru-mind rule add --in / --title "Require CI" --body "All merges must pass CI." --as-human
`,
  raw: `Risk: write [experimental]
When to use: Append immutable raw seabed entries (messages, artifacts, evidence, signals) from scripts/collectors (experimental).
Usage:
  meru-mind raw add --in <realm> --kind <message|artifact|evidence|signal> --text <T> [--topic <id>] [--file <localPath>] [--source-ref <ref>] [--about <obj>]... [--occurred-at <iso|none>] [--sensitivity <level>] [--idempotency-key <key>]
Examples:
  meru-mind raw add --in /ops --kind message --text "Deploy started"
  meru-mind raw add --in /ops --kind evidence --text "Benchmark log" --about service:api
`,
  redact: `Risk: high-risk-write (human-only; --as-human required; irreversible byte purge)
When to use: Permanently withdraw a record or seabed entry, purge indexes/blobs, and block exact re-ingestion.
Usage:
  meru-mind redact <entryId> [--reason <text>] --as-human
Examples:
  meru-mind redact rec_0123456789abcdef --reason "secret leaked" --as-human
`,
  settle: `Risk: write [experimental]
When to use: Create a deterministic distillation slice or cognitive card for a realm (experimental).
Usage:
  meru-mind settle --in <realm> --layer <layer> --period <key> [--narrative <text>] [--sources <a,b>]
Examples:
  meru-mind settle --in /ops --layer card_realm --period 2026-11-22
`,
  import: `Risk: write
When to use: Import Markdown or JSONL corpora and verify DB consistency against sources.
Usage:
  meru-mind import md <file-or-dir> [--in <realm>] [--map <mapping.json>] [--base-dir <dir>] [--source-ref <ref>] [--kind <kind>] [--sensitivity <level>] [--about <obj>]... [--include-secret] [--sync-embeddings] [--dry-run] [--as-human]
  meru-mind import jsonl <file.jsonl> --map <mapping.json> [--in <realm>] [--sync-embeddings] [--dry-run] [--as-human]
  meru-mind import verify --source <file|dir> [--in <realm>] [--map <mapping.json>] [--base-dir <dir>]
Examples:
  meru-mind import md ./notes --in /ops
  meru-mind import jsonl ./events.jsonl --map ./map.json --in /ops
  meru-mind import verify --source ./notes
`,
  org: `Risk: high-risk-write (set-policy requires --as-human)
When to use: List organizations, create a new organization, or switch policy between open and tree.
Usage:
  meru-mind org list
  meru-mind org create --name <name> [--personal] [--policy open|tree]
  meru-mind org set-policy --org <orgId> --policy open|tree --as-human
Examples:
  meru-mind org list
  meru-mind org set-policy --org org_123 --policy tree --as-human
`,
  admin: `Risk: high-risk-write
When to use: Initialize a store, take atomic VACUUM INTO backups, sync pending embeddings, rebuild derived indexes/drive, or export a read-only slice.
Usage:
  meru-mind admin init [--org <name>] [--personal] [--policy open|tree]
  meru-mind admin doctor
  meru-mind admin backup --out <file.sqlite>
  meru-mind admin sync-embeddings [--batch-size <n>] [--max-items <n>]
  meru-mind admin rebuild [--no-restore-drive]
  meru-mind admin export-slice [--in <realm>] --out <dir>
  meru-mind admin export-md <out-dir> [--in <realm>] [--include-confidential] [--dry-run]
Examples:
  meru-mind admin init --org "Acme" --policy open
  meru-mind admin backup --out ./backups/mind-snapshot.sqlite
`,
  serve: `Risk: write (starts single-writer HTTP + WebSocket + Streamable HTTP MCP + Web Governance UI server)
When to use: Serve one organization over HTTP (/v1/*), Pump WS (/v1/ws), Streamable HTTP MCP (/mcp), and the composable Web UI (/).
Usage:
  meru-mind serve [--host 127.0.0.1] [--port 3800] [--org <orgId>] [--init-token] [--demo] [--web-dir <dir>] [--origin <origin>]
Flags:
  --host <addr>      Bind address (default: 127.0.0.1)
  --port <port>      Listen port (default: 3800)
  --init-token       If no active tokens exist, mint and print one bootstrap human admin token once
  --demo             Seed demo realms, 12 rules (with sentinel), XSS probe, supersede chain, redacted tombstone & inbox item
  --web-dir <dir>    Serve custom UI bundle on loopback hosts only (/_meru/* and /v1/* stay reserved)
  --origin <origin>  Explicit WebSocket Origin allowlist (repeatable)
Examples:
  meru-mind serve --demo --host 127.0.0.1 --port 3800
  meru-mind serve --host 127.0.0.1 --port 3800 --web-dir ./my-ui
`,
  ui: `Risk: read / write (CLI helper for browser login codes and ejecting the official shell)
When to use: Mint a 60-second single-use browser login URL or eject the built-in official shell for custom UI authoring.
Usage:
  meru-mind ui login --url <serverUrl> --token <humanToken>
  meru-mind ui eject <targetDir>
Examples:
  MERU_MIND_URL=http://127.0.0.1:3800 MERU_MIND_TOKEN=mm_live_... meru-mind ui login
  meru-mind ui eject ./my-custom-ui
`,
  token: `Risk: high-risk-write (human-only)
When to use: Issue, list, or revoke hashed authentication tokens for meru-mind serve.
Usage:
  meru-mind token create --actor-id <id> --kind human|agent [--role member|admin] [--in <realm>] [--family <model>] [--label <text>] [--as-human]
  meru-mind token list [--all] [--as-human]
  meru-mind token revoke <tokenId> [--as-human]
Examples:
  meru-mind token create --actor-id claude-ci --kind agent --in /ops --as-human
  meru-mind token list --as-human
`,
  login: `Risk: write (authenticates CLI/SSH machine via self-issued OIDC device-code flow; saves 0600 credentials)
When to use: Sign in to an OIDC-enabled meru-mind serve instance without copying tokens manually (works over SSH/headless).
Usage:
  meru-mind login --url <serverUrl> [--kind human|agent] [--label <name>] [--timeout <seconds>]
Examples:
  meru-mind login --url https://mind.example.com
  meru-mind login --url https://mind.example.com --kind agent --label claude-code
`,
  invite: `Risk: high-risk-write (human-admin-only)
When to use: Create, list, or revoke single-use OIDC onboarding invite codes bound to an actorId.
Usage:
  meru-mind invite create --actor-id <id> [--kind human|agent] [--role member|admin] [--in <realm>] [--ttl-hours <n>] [--as-human]
  meru-mind invite list [--as-human]
  meru-mind invite revoke <inviteId> [--as-human]
Examples:
  meru-mind invite create --actor-id alice --kind human --as-human
  MERU_MIND_URL=https://mind.example.com MERU_MIND_TOKEN=<admin-token> meru-mind invite create --actor-id alice --role member
`,
  actor: `Risk: high-risk-write (human-admin-only)
When to use: List actors & OIDC identities, change actor roles (admin|member), or immediately disable/enable an actor.
Usage:
  meru-mind actor list [--as-human]
  meru-mind actor set-role <actorId> --role admin|member [--as-human]
  meru-mind actor disable <actorId> [--reason <text>] [--as-human]
  meru-mind actor enable <actorId> [--as-human]
Examples:
  meru-mind actor set-role alice --role admin --as-human
  meru-mind actor disable alice --reason "offboarded" --as-human
`,
  work: `Risk: read (list/ready/resolve) / high-risk-write (bind/unbind, human-only)
When to use: Bind a realm to an external WorkProvider SSOT (linear or github) using env-var token refs only, or query live ready/resolved items without duplicating task tables in mind-core.
Usage:
  meru-mind work bind --in <realm> --provider linear|github [--config '<json>'] [--team <key>] [--project <slug>] [--repo <owner/name>] [--token-env <VAR>] [--as-human]
  meru-mind work unbind --in <realm> [--as-human]
  meru-mind work list
  meru-mind work ready [--in <realm>] [--limit <n>] [--cursor <c>]
  meru-mind work resolve <itemRef...> [--in <realm>]
Examples:
  meru-mind work bind --in /ops --provider linear --team OPS --token-env LINEAR_API_KEY --as-human
  meru-mind work bind --in /eng --provider github --repo acme/api --token-env GITHUB_TOKEN --as-human
  meru-mind work ready --in /ops
  meru-mind work resolve OPS-42 --in /ops
`,
  upgrade: `Risk: read (--check) / local-git-update (git checkout only; refuses self-upgrade inside containers)
When to use: Check for new Meru Mind releases (CLI and optional remote server /v1/health) and safely upgrade local git installs (containers print host docker compose pull steps).
Usage:
  meru-mind upgrade [--check] [--url <serverUrl>] [--json]
  meru-mind update [--check] [--url <serverUrl>] [--json]
Flags:
  --check            Check latest release and print recommended upgrade commands without modifying anything
  --url <serverUrl>  Also query <serverUrl>/v1/health to compare remote server version side-by-side
  --json             Output structured JSON result
Examples:
  meru-mind upgrade --check
  meru-mind upgrade --check --url https://mind.example.com --json
  meru-mind upgrade
`,
  update: `Alias for "meru-mind upgrade".
Usage:
  meru-mind update [--check] [--url <serverUrl>] [--json]
See: meru-mind upgrade --help
`,
};

function printHelp(cmd?: string): void {
  if (cmd && cmd in COMMAND_HELP) {
    process.stdout.write(COMMAND_HELP[cmd]!);
    return;
  }
  process.stdout.write(TOP_LEVEL_HELP);
}

// ---- Session & Identity Resolution ----

function resolveAdminOrgId(
  engine: MindEngine,
  orgIdFlag?: string,
): string {
  const explicit = orgIdFlag?.trim() || process.env.MERU_MIND_ORG_ID?.trim();
  if (explicit) return explicit;
  const orgs = engine.ledger.listOrgs();
  if (orgs.length === 1) return orgs[0]!.id;
  if (orgs.length === 0) {
    throw new MindError(
      "NOT_BOUND",
      "No organization found in this store. Run 'meru-mind admin init' first.",
      { try: 'meru-mind admin init --org "MyTeam" --policy open' },
    );
  }
  throw new MindError(
    "NOT_BOUND",
    "Organization ID (--org or MERU_MIND_ORG_ID) is required when multiple organizations exist",
    { try: "meru-mind org list" },
  );
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
  const orgId = resolveAdminOrgId(engine, orgIdFlag);
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
  boundSource: string;
  boundScope: AccessScope;
  realms: Realm[];
}

function resolveSessionContext(params: {
  engine: MindEngine;
  flags: Record<string, string | boolean>;
  includeDescendantSeabed?: boolean;
}): SessionContext {
  const { engine, flags, includeDescendantSeabed = false } = params;
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
        'No organization found in runtime home. Run "meru-mind admin init" first.',
        { try: "meru-mind admin init" },
      );
    } else {
      throw new MindError(
        "NOT_BOUND",
        "MERU_MIND_ORG_ID (or --org) is required when multiple organizations exist",
        { try: "meru-mind org list" },
      );
    }
  }

  const realms = engine.db.listRealms();
  const orgRealms = realms.filter((r) => r.orgId === org!.id);
  const mounts = engine.db.listMounts();

  let boundViewerRealm: Realm | null = null;
  let boundSource = "open-default:/";
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
    boundSource = "MERU_MIND_VIEWER_REALM_ID";
  } else if (org.policy === "tree") {
    throw new MindError(
      "NOT_BOUND",
      `MERU_MIND_VIEWER_REALM_ID is required for 'tree' policy organization "${org.id}". Bind your assigned realm before running commands.`,
      {
        try: "MERU_MIND_VIEWER_REALM_ID=/team/project meru-mind whoami",
      },
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

  return {
    org,
    boundViewerRealmId: boundViewerRealm.id,
    boundSource,
    boundScope,
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
        { try: "Pass --as-human instead of --actor-kind human" },
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

function resolveSingleObjectIdForManage(params: {
  engine: MindEngine;
  ctx: SessionContext;
  actor: Actor;
  rawRef: string;
}): string {
  const parsed = parseRefSyntax(params.rawRef);
  if (parsed.kind !== "object") {
    throw new MindError(
      "INVALID_REF",
      `Expected object reference (<kind>:<name>, /<realm>/<kind>:<name>, or obj_...), got "${params.rawRef}"`,
      { try: "meru-mind ls --only objects" },
    );
  }
  const vis = createVisibilityHelpers({
    db: params.engine.db,
    realms: params.ctx.realms,
    mounts: params.engine.db.listMounts(),
    actor: params.actor,
    viewerRealmId: params.ctx.boundViewerRealmId,
    scope: params.ctx.boundScope,
  });
  const resolved = resolveUnifiedObjectRead({
    db: params.engine.db,
    realms: params.ctx.realms,
    orgId: params.ctx.org.id,
    parsed,
    scope: params.ctx.boundScope,
    vis,
    verb: "show",
  });
  if (!resolved.object) {
    throw new MindError("NOT_FOUND", OPAQUE_OBJECT_NOT_FOUND, {
      try: `meru-mind object create --kind ${resolved.objectKind} --name ${resolved.objectName}`,
    });
  }
  return resolved.object.id;
}

// ---- Main CLI Entrypoint ----

async function main(): Promise<void> {
  const { positionals, flags, multiFlags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, third, fourth] = positionals;

  if (flagBool(flags, "version") && !cmd) {
    if (flagBool(flags, "json")) {
      process.stdout.write(`${JSON.stringify({ version: MERU_MIND_VERSION })}\n`);
    } else {
      process.stdout.write(`${MERU_MIND_VERSION}\n`);
    }
    return;
  }

  if (!cmd || cmd === "help") {
    printHelp(sub);
    return;
  }
  if (flagBool(flags, "help")) {
    printHelp(cmd);
    return;
  }

  // Reject removed legacy commands & intuitive guesses with exact replacement in `try:`
  if (cmd in REMOVED_COMMAND_HINTS) {
    throw new MindError(
      "UNKNOWN_COMMAND",
      `Command "${cmd}" is not part of the CLI surface`,
      { try: REMOVED_COMMAND_HINTS[cmd]! },
    );
  }

  const KNOWN_COMMANDS = new Set([
    "whoami",
    "tree",
    "ls",
    "show",
    "search",
    "changes",
    "write",
    "realm",
    "entry",
    "object",
    "file",
    "rule",
    "raw",
    "redact",
    "settle",
    "import",
    "serve",
    "ui",
    "login",
    "token",
    "invite",
    "actor",
    "work",
    "org",
    "admin",
    "upgrade",
    "update",
  ]);
  if (!KNOWN_COMMANDS.has(cmd)) {
    throw new MindError("UNKNOWN_COMMAND", `Unknown command "${cmd}"`, {
      try: "meru-mind --help",
    });
  }

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

  // Discover hardened `.meru-mind-realm` marker strictly at CLI process entrypoint.
  // Invalid markers fail only on routed writes (never breaking read commands).
  let workspaceMarkerRef: string | null = null;
  let workspaceMarkerError: unknown = null;
  try {
    workspaceMarkerRef =
      discoverWorkspaceRealmMarker(process.cwd())?.ref ?? null;
  } catch (err) {
    workspaceMarkerError = err;
  }

  // `meru-mind login` runs the self-issued OIDC device-code flow (SSH/headless safe) and saves 0600 credentials.
  if (cmd === "login") {
    assertAllowedFlags(flags, ["kind", "label", "timeout"], "login");
    const targetUrl = (
      flagStr(flags, "url") ?? process.env.MERU_MIND_URL?.trim()
    )?.trim().replace(/\/+$/, "");
    if (!targetUrl) {
      throw new MindError(
        "INVALID_INPUT",
        "login requires --url <serverUrl> or MERU_MIND_URL",
        { try: "meru-mind login --url https://mind.example.com" },
      );
    }
    let parsedTargetUrl: URL;
    try {
      parsedTargetUrl = new URL(targetUrl);
    } catch {
      throw new MindError("INVALID_INPUT", `Invalid --url: "${targetUrl}"`);
    }
    const targetIsLoopback =
      parsedTargetUrl.hostname === "127.0.0.1" ||
      parsedTargetUrl.hostname === "localhost" ||
      parsedTargetUrl.hostname === "::1" ||
      parsedTargetUrl.hostname === "[::1]";
    if (parsedTargetUrl.protocol !== "https:" && !(parsedTargetUrl.protocol === "http:" && targetIsLoopback)) {
      throw new MindError(
        "INVALID_INPUT",
        `Refusing insecure login URL "${parsedTargetUrl.origin}": remote servers must use https:// (http:// is allowed only on loopback).`,
      );
    }
    const kindRaw = (flagStr(flags, "kind") ?? "human").trim().toLowerCase();
    if (kindRaw !== "human" && kindRaw !== "agent") {
      throw new MindError("INVALID_INPUT", '--kind must be "human" or "agent"');
    }
    const clientLabel = flagStr(flags, "label") ?? "meru-mind-cli";
    const timeoutSec = Math.min(600, parseIntFlag(flags, "timeout", { min: 5 }) ?? 300);

    const startResp = await fetch(`${targetUrl}/_meru/device/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        hostname: os.hostname(),
        clientLabel,
        kind: kindRaw,
      }),
    });
    const startBody = (await startResp.json()) as {
      deviceCode?: string;
      userCode?: string;
      verificationUri?: string;
      verificationUriComplete?: string;
      interval?: number;
      expiresIn?: number;
      message?: string;
    };
    if (!startResp.ok || !startBody.deviceCode || !startBody.userCode) {
      throw new MindError(
        startResp.status === 404 ? "NOT_FOUND" : "INVALID_INPUT",
        startBody.message ?? `Device login start failed (HTTP ${startResp.status})`,
      );
    }

    // Print instructions immediately to stderr so stdout stays pure JSON when `--json` is used
    process.stderr.write(
      [
        `Open this URL in any browser to authorize this terminal:`,
        `  ${startBody.verificationUriComplete ?? startBody.verificationUri}`,
        `Verification code: ${startBody.userCode}`,
        `Waiting for fresh SSO approval...`,
        "",
      ].join("\n"),
    );

    const pollIntervalMs = Math.max(250, Math.min(5000, (startBody.interval ?? 2) * 1000));
    const deadlineMs = Date.now() + Math.min(timeoutSec, startBody.expiresIn ?? 600) * 1000;
    while (Date.now() < deadlineMs) {
      await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, 400)));
      const pollResp = await fetch(`${targetUrl}/_meru/device/poll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ deviceCode: startBody.deviceCode }),
      });
      const pollBody = (await pollResp.json()) as {
        status?: string;
        token?: string;
        tokenId?: string;
        actorId?: string;
        actorKind?: "human" | "agent";
        expiresAt?: string | null;
        orgId?: string;
        message?: string;
      };
      if (pollBody.status === "authorization_pending") {
        continue;
      }
      if (pollBody.status === "access_denied") {
        throw new MindError("ACCESS_DENIED", "Device login was denied in browser");
      }
      if (pollBody.status === "expired_token") {
        throw new MindError("ACCESS_DENIED", "Device login code expired; run 'meru-mind login' again");
      }
      if (pollBody.status === "approved" && pollBody.token) {
        const credentialsPath = saveProfileCredential({
          serverUrl: targetUrl,
          credential: {
            token: pollBody.token,
            tokenId: pollBody.tokenId ?? "",
            actorId: pollBody.actorId ?? "",
            actorKind: pollBody.actorKind === "agent" ? "agent" : "human",
            expiresAt: pollBody.expiresAt ?? null,
            savedAt: new Date().toISOString(),
          },
        });
        const result = {
          authenticated: true,
          url: targetUrl,
          actorId: pollBody.actorId,
          actorKind: pollBody.actorKind,
          tokenId: pollBody.tokenId,
          expiresAt: pollBody.expiresAt,
          credentialsPath,
        };
        output(
          result,
          [
            `Signed in to ${targetUrl} as ${pollBody.actorId} (${pollBody.actorKind}).`,
            `Saved credentials (0600): ${credentialsPath}`,
            pollBody.expiresAt ? `Expires: ${pollBody.expiresAt}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        return;
      }
      throw new MindError(
        "INVALID_INPUT",
        pollBody.message ?? `Unexpected device poll status: ${String(pollBody.status)}`,
      );
    }
    throw new MindError("ACCESS_DENIED", "Timed out waiting for device login approval");
  }

  // `meru-mind upgrade` (alias `update`) works without opening local SQLite directly.
  if (cmd === "upgrade" || cmd === "update") {
    assertAllowedFlags(flags, ["check"], cmd);
    const checkOnly = flagBool(flags, "check");
    const remoteUrl =
      flagStr(flags, "url")?.trim() ||
      process.env.MERU_MIND_URL?.trim() ||
      null;
    const res = await runUpgrade({
      checkOnly,
      remoteUrl,
    });
    output(res, formatUpgradeMarkdown(res));
    return;
  }

  // `meru-mind ui eject <dir>` and `meru-mind ui login` work without opening local SQLite directly.
  if (cmd === "ui") {
    if (sub === "eject") {
      assertAllowedFlags(flags, [], "ui eject");
      if (!third?.trim()) {
        throw new MindError("INVALID_INPUT", "ui eject requires a <targetDir> path", {
          try: "meru-mind ui eject ./my-ui",
        });
      }
      const files = ejectDefaultUiShell(third.trim());
      output(
        { ejected: true, targetDir: third.trim(), files },
        formatGenericMarkdown("Ejected Official Default Shell (imports /_meru/client.js)", {
          targetDir: third.trim(),
          files,
          next: `meru-mind serve --demo --host 127.0.0.1 --web-dir ${third.trim()}`,
        }),
      );
      return;
    }
    if (sub === "login") {
      assertAllowedFlags(flags, [], "ui login");
      const targetUrl = (
        flagStr(flags, "url") ??
        process.env.MERU_MIND_URL?.trim() ??
        "http://127.0.0.1:3800"
      ).replace(/\/+$/, "");
      const targetToken = (
        flagStr(flags, "token")?.trim() ||
        process.env.MERU_MIND_TOKEN?.trim() ||
        lookupSavedCredential(targetUrl)?.token?.trim() ||
        ""
      );
      if (!targetToken) {
        throw new MindError(
          "ACCESS_DENIED",
          "ui login requires --token or MERU_MIND_TOKEN (human Bearer token)",
          { try: `MERU_MIND_URL=${targetUrl} MERU_MIND_TOKEN=<token> meru-mind ui login` },
        );
      }
      const resp = await fetch(`${targetUrl}/v1/ui/login-code`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${targetToken}`,
          Accept: "application/json",
        },
      });
      const body = (await resp.json()) as {
        code?: string;
        path?: string;
        loginUrl?: string;
        expiresAt?: string;
        message?: string;
      };
      if (!resp.ok || !body.code) {
        throw new MindError(
          resp.status === 401 || resp.status === 403 ? "ACCESS_DENIED" : "INVALID_INPUT",
          body.message ?? `Failed to mint login code (HTTP ${resp.status})`,
        );
      }
      // P0 #2: Always assemble public loginUrl from the CLI's reachable targetUrl,
      // never trusting an internal bind address (e.g., 0.0.0.0:3800 inside Docker).
      const resolvedLoginUrl = `${targetUrl}/_meru/auth?code=${encodeURIComponent(body.code)}`;
      output(
        { ...body, loginUrl: resolvedLoginUrl },
        [
          "One-time browser login URL (valid 60s, single-use, HttpOnly Cookie):",
          `  ${resolvedLoginUrl}`,
        ].join("\n"),
      );
      return;
    }
    throw new MindError("UNKNOWN_COMMAND", `Unknown ui subcommand "${sub ?? ""}"`, {
      try: "meru-mind ui --help",
    });
  }

  // `meru-mind serve` owns the exclusive writer lock itself before opening SQLite.
  if (cmd === "serve") {
    assertAllowedFlags(
      flags,
      ["host", "port", "init-token", "demo", "web-dir", "origin"],
      "serve",
    );
    const host = flagStr(flags, "host") ?? "127.0.0.1";
    const port = parseIntFlag(flags, "port", { min: 0 }) ?? 3800;
    const isDemo = flagBool(flags, "demo");
    const allowedOrigins = flagMulti(multiFlags, "origin");
    const srv = await startMindServer({
      homeDir: flagStr(flags, "home"),
      host,
      port,
      orgId: orgFlag,
      demo: isDemo,
      webDir: flagStr(flags, "web-dir"),
      allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
    });
    let bootstrapToken: string | null = null;
    let demoLoginUrl: string | null = null;
    if (flagBool(flags, "init-token") || isDemo) {
      const existing = srv.engine.db.listTokens(srv.orgId, false);
      if (existing.length === 0) {
        const minted = srv.createToken({
          actorId: flagStr(flags, "actor") ?? (isDemo ? "demo-lead" : "admin"),
          actorKind: "human",
          label: isDemo ? "demo-human" : "bootstrap-admin",
          createdBy: "serve-init",
        });
        bootstrapToken = minted.token;
        if (isDemo) {
          const root = srv.engine.db.getRealmByPath(srv.orgId, "/")!;
          demoLoginUrl = srv.mintUiLoginCode({
            tokenId: minted.record.id,
            orgId: srv.orgId,
            actor: { id: minted.record.actorId, kind: "human" },
            boundRealmId: root.id,
            boundSource: "demo",
            authKind: "bearer",
          }).loginUrl;
        }
      }
    }
    const startPayload = {
      url: srv.url,
      orgId: srv.orgId,
      homeDir: srv.homeDir,
      mcpEndpoint: `${srv.url}/mcp`,
      wsEndpoint: `${srv.url.replace(/^http/, "ws")}/v1/ws`,
      officialShellUrl: `${srv.url}/_meru/shell`,
      ...(bootstrapToken
        ? {
            bootstrapToken,
            note: "Save this human admin token now; plaintext is shown ONCE.",
          }
        : {}),
      ...(demoLoginUrl ? { demoLoginUrl } : {}),
    };
    output(
      startPayload,
      [
        `Meru Mind server listening at ${srv.url} (org: ${srv.orgId})`,
        `  UI:   ${srv.url}/   (official fallback: ${srv.url}/_meru/shell)`,
        `  REST: ${srv.url}/v1/whoami`,
        `  WS:   ${srv.url.replace(/^http/, "ws")}/v1/ws`,
        `  MCP:  ${srv.url}/mcp`,
        ...(bootstrapToken
          ? [`  Admin Token (shown ONCE): ${bootstrapToken}`]
          : []),
        ...(demoLoginUrl
          ? [`  Demo 60s Login URL: ${demoLoginUrl}`]
          : []),
      ].join("\n"),
    );
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        srv
          .close()
          .catch(() => {})
          .finally(() => resolve());
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    return;
  }

  // Remote HTTP mode (--url / MERU_MIND_URL): route through RemoteMindSurface and never touch local SQLite.
  const remoteUrl = (
    flagStr(flags, "url") ?? process.env.MERU_MIND_URL?.trim()
  )?.trim();
  if (remoteUrl) {
    const remoteToken = (
      flagStr(flags, "token")?.trim() ||
      process.env.MERU_MIND_TOKEN?.trim() ||
      lookupSavedCredential(remoteUrl)?.token?.trim() ||
      ""
    );
    if (!remoteToken) {
      throw new MindError(
        "ACCESS_DENIED",
        "Remote mode (--url / MERU_MIND_URL) requires --token, MERU_MIND_TOKEN, or saved credentials from 'meru-mind login'",
        { try: `meru-mind login --url ${remoteUrl}` },
      );
    }
    await runRemoteCliCommand({
      baseUrl: remoteUrl,
      token: remoteToken,
      positionals,
      flags,
      multiFlags,
      workspaceHint: workspaceMarkerRef,
      output,
    });
    return;
  }

  const engine = await createMindEngine({
    homeDir: flagStr(flags, "home"),
  });

  const actor = buildActor(flags);

  try {
    // ======== EVERYDAY 7 VERBS ========

    if (cmd === "whoami") {
      assertAllowedFlags(flags, [], "whoami");
      const ctx = resolveSessionContext({ engine, flags });
      const res = engine.sea.whoami({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        boundSource: ctx.boundSource,
        storePath: engine.homeDir,
        scopeCeiling: ctx.boundScope,
      });
      output(res, formatWhoamiMarkdown(res));
      return;
    }

    if (cmd === "tree") {
      assertAllowedFlags(
        flags,
        ["depth", "objects", "no-objects", "all", "limit"],
        "tree",
      );
      const ctx = resolveSessionContext({ engine, flags });
      const includeObjects = flagBool(flags, "no-objects") ? false : true;
      const res = engine.sea.tree({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        target: sub,
        depth: parseDepthFlag(flags),
        includeObjects,
        includeArchived: flagBool(flags, "all"),
        limit: parseIntFlag(flags, "limit", { min: 1 }),
        scopeCeiling: ctx.boundScope,
      });
      output(res, formatTreeMarkdown(res));
      return;
    }

    if (cmd === "ls") {
      assertAllowedFlags(
        flags,
        [
          "only",
          "kind",
          "about",
          "since",
          "until",
          "history",
          "include-descendant-seabed",
          "limit",
          "cursor",
        ],
        "ls",
      );
      const includeDescendantSeabed = flagBool(
        flags,
        "include-descendant-seabed",
      );
      const ctx = resolveSessionContext({
        engine,
        flags,
        includeDescendantSeabed,
      });
      const res = await engine.sea.ls({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        ref: sub,
        only: flagStr(flags, "only") as LsOnlyFilter | undefined,
        kind: flagStr(flags, "kind"),
        about: flagStr(flags, "about"),
        since: flagStr(flags, "since"),
        until: flagStr(flags, "until"),
        history: flagBool(flags, "history"),
        includeDescendantSeabed,
        limit: parseIntFlag(flags, "limit", { min: 1 }),
        cursor: flagStr(flags, "cursor"),
        scopeCeiling: ctx.boundScope,
      });
      output(res, formatLsMarkdown(res));
      return;
    }

    if (cmd === "show") {
      if ("limit" in flags) {
        const refHint = sub?.trim() || "<ref>";
        const nHint =
          typeof flags["limit"] === "string" ? flags["limit"] : "<N>";
        throw new MindError(
          "UNKNOWN_FLAG",
          "show does not accept --limit (which counts items on search/ls)",
          { try: `meru-mind show ${refHint} --chars ${nHint}` },
        );
      }
      assertAllowedFlags(
        flags,
        [
          "around",
          "cursor",
          "chars",
          "full",
          "history",
          "context",
          "include-descendant-seabed",
        ],
        "show",
      );
      const includeDescendantSeabed = flagBool(
        flags,
        "include-descendant-seabed",
      );
      const ctx = resolveSessionContext({
        engine,
        flags,
        includeDescendantSeabed,
      });
      if (!sub?.trim()) {
        throw new MindError(
          "INVALID_REF",
          "show requires a <ref> argument (/realm, kind:name, rec_.../sea_..., or file:/realm/path)",
          { try: "meru-mind show /" },
        );
      }
      const res = await engine.sea.show({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        ref: sub,
        around: flagStr(flags, "around"),
        cursor: flagStr(flags, "cursor"),
        chars: parseIntFlag(flags, "chars", { min: 1 }),
        full: flagBool(flags, "full") ? true : undefined,
        history: flagBool(flags, "history"),
        context: parseIntFlag(flags, "context", { min: 0 }),
        includeDescendantSeabed,
        scopeCeiling: ctx.boundScope,
      });
      output(res, formatShowMarkdown(res));
      return;
    }

    if (cmd === "search") {
      assertAllowedFlags(
        flags,
        [
          "in",
          "about",
          "kind",
          "since",
          "until",
          "history",
          "include-descendant-seabed",
          "limit",
          "cursor",
        ],
        "search",
      );
      const includeDescendantSeabed = flagBool(
        flags,
        "include-descendant-seabed",
      );
      const ctx = resolveSessionContext({
        engine,
        flags,
        includeDescendantSeabed,
      });
      const queryText = positionals.slice(1).join(" ").trim();
      if (!queryText) {
        throw new MindError(
          "INVALID_INPUT",
          'search requires a <query> argument (e.g. meru-mind search "deployment")',
          { try: 'meru-mind search "keyword"' },
        );
      }
      const res = await engine.sea.search({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        query: queryText,
        in: flagStr(flags, "in"),
        about: flagStr(flags, "about"),
        kind: flagStr(flags, "kind"),
        since: flagStr(flags, "since"),
        until: flagStr(flags, "until"),
        history: flagBool(flags, "history"),
        includeDescendantSeabed,
        limit: parseIntFlag(flags, "limit", { min: 1 }),
        cursor: flagStr(flags, "cursor"),
        scopeCeiling: ctx.boundScope,
      });
      output(res, formatSearchMarkdown(res));
      return;
    }

    if (cmd === "changes") {
      assertAllowedFlags(
        flags,
        ["since", "in", "limit", "include-descendant-seabed"],
        "changes",
      );
      const includeDescendantSeabed = flagBool(
        flags,
        "include-descendant-seabed",
      );
      const ctx = resolveSessionContext({
        engine,
        flags,
        includeDescendantSeabed,
      });
      const res = engine.sea.changes({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        in: flagStr(flags, "in") ?? sub,
        sinceSeq: parseIntFlag(flags, "since", { min: 0 }) ?? 0,
        limit: parseIntFlag(flags, "limit", { min: 1 }),
        includeDescendantSeabed,
        scopeCeiling: ctx.boundScope,
      });
      output(res, formatChangesMarkdown(res));
      return;
    }

    if (cmd === "write") {
      assertAllowedFlags(
        flags,
        [
          "in",
          "title",
          "body",
          "kind",
          "about",
          "supersedes",
          "because",
          "occurred-at",
          "sensitivity",
          "idempotency-key",
        ],
        "write",
      );
      const ctx = resolveSessionContext({ engine, flags });
      const mounts = engine.db.listMounts();
      const explicitIn = flagStr(flags, "in");
      const isExplicitlyBound = ctx.boundSource === "MERU_MIND_VIEWER_REALM_ID";
      if (
        !explicitIn &&
        !isExplicitlyBound &&
        ctx.org.policy === "open" &&
        workspaceMarkerError
      ) {
        throw workspaceMarkerError;
      }
      const aboutRefs = flagMulti(multiFlags, "about");
      const routed = resolveWriteTargetRealm({
        db: engine.db,
        ledger: engine.ledger,
        realms: ctx.realms,
        mounts,
        scope: ctx.boundScope,
        orgId: ctx.org.id,
        orgPolicy: ctx.org.policy,
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        isExplicitlyBound,
        explicitIn,
        workspaceMarkerRef,
        about: aboutRefs,
      });
      const effectiveScope =
        routed.routedBy === "inbox"
          ? resolveAccessScope({
              realms: routed.realms,
              mounts,
              viewerRealmId: ctx.boundViewerRealmId,
              orgPolicy: ctx.org.policy,
              includeDescendantSeabed: false,
            })
          : ctx.boundScope;
      const rec = await writeEverydayConclusion({
        db: engine.db,
        ledger: engine.ledger,
        realms: routed.realms,
        mounts,
        scope: effectiveScope,
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        targetRealmId: routed.realm.id,
        title: requireFlag(flags, "title", "write"),
        body: requireFlag(flags, "body", "write"),
        kind: flagStr(flags, "kind"),
        about: aboutRefs,
        supersedes: flagMulti(multiFlags, "supersedes"),
        because: flagMulti(multiFlags, "because"),
        occurredAt: parseOccurredAtFlag(flags),
        sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
        explicitIdempotencyKey: flagStr(flags, "idempotency-key"),
        allowRedactedReingest: flagBool(flags, "as-human"),
      });
      const relatedActive = await findRelatedActiveForEcho({
        sea: engine.sea,
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        newRecord: rec,
        scopeCeiling: effectiveScope,
      });
      const payloadOut = {
        ...rec,
        realmPath: routed.realm.path,
        routedBy: routed.routedBy,
        ...(relatedActive.length > 0 ? { relatedActive } : {}),
      };
      const baseMd = formatGenericMarkdown(
        `Written [${rec.kind}] -> \`${routed.realm.path}\` (routed: ${routed.routedBy})`,
        payloadOut,
      );
      const echoFooter =
        relatedActive.length > 0
          ? "\n\nRelated active entries (context only; if this supersedes one, re-run with `--supersedes <id>`):\n" +
            relatedActive
              .map(
                (r) =>
                  `- [${r.kind}] \`${r.id}\` ${r.title} (${r.realmPath}${r.occurredAt ? ` @ ${r.occurredAt.slice(0, 10)}` : ""})`,
              )
              .join("\n")
          : "";
      output(payloadOut, `${baseMd}${echoFooter}`);
      return;
    }

    // ======== MANAGEMENT / STRUCTURE / HUMAN-ONLY NOUN-VERB COMMANDS ========

    if (cmd === "admin") {
      if (sub === "init") {
        assertAllowedFlags(flags, ["personal", "policy"], "admin init");
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
          isPersonalRoot: !flags["personal"]
            ? true
            : flagBool(flags, "personal"),
          policy: flagStr(flags, "policy") as OrgPolicy | undefined,
        });
        const res = { initialized: true, homeDir: engine.homeDir, ...created };
        output(res, formatGenericMarkdown("Initialized", res));
        return;
      }
      if (sub === "doctor") {
        assertAllowedFlags(flags, [], "admin doctor");
        const ctx = resolveSessionContext({ engine, flags });
        const treeRes = engine.sea.tree({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          depth: "all",
          includeObjects: true,
          scopeCeiling: ctx.boundScope,
        });
        const report = runRealmDoctor(treeRes, engine.db.getStorageBloatStats());
        output(report, formatDoctorMarkdown(report));
        return;
      }
      if (sub === "backup") {
        assertAllowedFlags(flags, ["out"], "admin backup");
        const outPath = requireFlag(flags, "out", "admin backup");
        engine.db.vacuumInto(outPath);
        const res = { backedUp: true, outPath };
        output(res, formatGenericMarkdown("Atomic Backup Created (VACUUM INTO)", res));
        return;
      }
      if (sub === "sync-embeddings") {
        assertAllowedFlags(
          flags,
          ["batch-size", "max-items"],
          "admin sync-embeddings",
        );
        const res = await engine.sea.syncEmbeddings({
          batchSize: parseIntFlag(flags, "batch-size", { min: 1 }),
          maxItems: parseIntFlag(flags, "max-items", { min: 1 }),
        });
        output(res, formatGenericMarkdown("Embeddings Synced", res));
        return;
      }
      if (sub === "rebuild") {
        assertAllowedFlags(flags, ["no-restore-drive"], "admin rebuild");
        const res = await engine.sea.rebuild({
          restoreDrive: !flagBool(flags, "no-restore-drive"),
        });
        output(res, formatGenericMarkdown("Rebuild Completed", res));
        return;
      }
      if (sub === "export-slice") {
        assertAllowedFlags(flags, ["in", "out"], "admin export-slice");
        const ctx = resolveSessionContext({ engine, flags });
        const inRef = flagStr(flags, "in") ?? third;
        const targetId = inRef
          ? resolveVisibleRealm({
              realms: ctx.realms,
              orgId: ctx.org.id,
              ref: inRef,
              scope: ctx.boundScope,
            }).id
          : ctx.boundViewerRealmId;
        const res = await engine.slice.exportSlice({
          actor,
          viewerRealmId: targetId,
          outDir: requireFlag(flags, "out", "admin export-slice"),
        });
        output(res, formatGenericMarkdown("Slice Exported", res));
        return;
      }
      if (sub === "export-md") {
        assertAllowedFlags(
          flags,
          ["in", "out", "include-confidential", "dry-run"],
          "admin export-md",
        );
        const ctx = resolveSessionContext({ engine, flags });
        const outDir = flagStr(flags, "out") ?? third;
        if (!outDir) {
          throw new MindError(
            "INVALID_INPUT",
            "Missing output directory for 'admin export-md <out-dir>'",
            { try: "meru-mind admin export-md ./export-wiki --dry-run" },
          );
        }
        const res = exportRecordsAsMarkdown({
          db: engine.db,
          viewerRealmId: ctx.boundViewerRealmId,
          outDir,
          targetRealmRef: flagStr(flags, "in"),
          includeConfidential: flagBool(flags, "include-confidential"),
          dryRun: flagBool(flags, "dry-run"),
        });
        output(res, formatExportMdMarkdown(res));
        return;
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown admin subcommand "${sub ?? ""}"`,
        { try: "meru-mind admin --help" },
      );
    }

    if (cmd === "token") {
      if (actor.kind !== "human") {
        throw new MindError(
          "ACCESS_DENIED",
          `Local token management requires --as-human (actor "${actor.id}" is "${actor.kind}")`,
          { try: "meru-mind token list --as-human" },
        );
      }
      const orgId = resolveAdminOrgId(engine, orgFlag);
      if (sub === "create") {
        assertAllowedFlags(
          flags,
          ["actor-id", "kind", "role", "in", "family", "label"],
          "token create",
        );
        const targetActorId = requireFlag(flags, "actor-id", "token create");
        const targetKind = requireFlag(flags, "kind", "token create") as
          | "human"
          | "agent";
        const boundRealmInput = flagStr(flags, "in");
        const rawRole = flagStr(flags, "role");
        if (
          rawRole !== undefined &&
          rawRole !== "admin" &&
          rawRole !== "member"
        ) {
          throw new MindError(
            "INVALID_INPUT",
            `Flag --role must be "admin" or "member", got "${rawRole}"`,
          );
        }
        const rootRealm = engine.db.getRealmByPath(orgId, "/");
        const isRootInput =
          !boundRealmInput?.trim() ||
          boundRealmInput.trim() === "/" ||
          (rootRealm !== null && boundRealmInput.trim() === rootRealm.id);
        const existingActor = engine.db.getActor(orgId, targetActorId);
        // Preserve local bootstrap behavior: local --as-human token create for a brand-new root-realm human
        // defaults to admin unless --role is explicitly passed (never elevating an existing member silently).
        const resolvedRole: ActorRole | undefined =
          (rawRole as ActorRole | undefined) ??
          (targetKind === "human" && isRootInput && !existingActor
            ? "admin"
            : undefined);
        const minted = createAuthToken({
          db: engine.db,
          orgId,
          actorId: targetActorId,
          actorKind: targetKind,
          actorFamily: flagStr(flags, "family"),
          actorRole: resolvedRole,
          boundRealmId: boundRealmInput,
          label: flagStr(flags, "label"),
          createdBy: actor.id,
        });
        output(
          minted,
          formatGenericMarkdown(
            "Token Created (plaintext shown ONCE — store securely)",
            minted,
          ),
        );
        return;
      }
      if (sub === "list") {
        assertAllowedFlags(flags, ["all"], "token list");
        const tokens = engine.db
          .listTokens(orgId, flagBool(flags, "all"))
          .map(toPublicToken);
        output(tokens, formatGenericMarkdown("Auth Tokens", tokens));
        return;
      }
      if (sub === "revoke") {
        assertAllowedFlags(flags, [], "token revoke");
        if (!third?.trim()) {
          throw new MindError("INVALID_INPUT", "token revoke requires <tokenId>", {
            try: "meru-mind token revoke tok_... --as-human",
          });
        }
        const revoked = engine.db.revokeToken(
          orgId,
          third.trim(),
          new Date().toISOString(),
        );
        const res = { tokenId: third.trim(), revoked };
        output(res, formatGenericMarkdown("Token Revoked", res));
        return;
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown token subcommand "${sub ?? ""}"`,
        { try: "meru-mind token --help" },
      );
    }

    if (cmd === "invite") {
      if (actor.kind !== "human") {
        throw new MindError(
          "ACCESS_DENIED",
          `Local invite management requires --as-human (actor "${actor.id}" is "${actor.kind}")`,
          { try: "meru-mind invite list --as-human" },
        );
      }
      const orgId = resolveAdminOrgId(engine, orgFlag);
      if (sub === "create") {
        assertAllowedFlags(
          flags,
          ["actor-id", "kind", "role", "in", "ttl-hours"],
          "invite create",
        );
        const rawRole = flagStr(flags, "role") ?? "member";
        if (rawRole !== "admin" && rawRole !== "member") {
          throw new MindError(
            "INVALID_INPUT",
            `Flag --role must be "admin" or "member", got "${rawRole}"`,
          );
        }
        const created = createInvite({
          db: engine.db,
          orgId,
          actorId: requireFlag(flags, "actor-id", "invite create"),
          actorKind: (flagStr(flags, "kind") ?? "human") as "human" | "agent",
          actorRole: rawRole,
          boundRealmRef: flagStr(flags, "in") ?? null,
          createdBy: actor.id,
          ttlHours: parseIntFlag(flags, "ttl-hours", { min: 1 }),
          publicBaseUrl: process.env.MERU_MIND_PUBLIC_URL?.trim() || null,
        });
        output(created, formatGenericMarkdown("Invite Created (code shown ONCE)", created));
        return;
      }
      if (sub === "list") {
        assertAllowedFlags(flags, [], "invite list");
        const invites = engine.db.listInvites(orgId).map(toPublicInvite);
        output({ invites }, formatGenericMarkdown("Invites", { invites }));
        return;
      }
      if (sub === "revoke") {
        assertAllowedFlags(flags, [], "invite revoke");
        if (!third?.trim()) {
          throw new MindError("INVALID_INPUT", "invite revoke requires <inviteId>", {
            try: "meru-mind invite revoke inv_... --as-human",
          });
        }
        const revoked = engine.db.revokeInvite(
          orgId,
          third.trim(),
          new Date().toISOString(),
        );
        const res = { inviteId: third.trim(), revoked };
        output(res, formatGenericMarkdown("Invite Revoked", res));
        return;
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown invite subcommand "${sub ?? ""}"`,
        { try: "meru-mind invite --help" },
      );
    }

    if (cmd === "actor") {
      if (actor.kind !== "human") {
        throw new MindError(
          "ACCESS_DENIED",
          `Local actor management requires --as-human (actor "${actor.id}" is "${actor.kind}")`,
          { try: "meru-mind actor list --as-human" },
        );
      }
      const orgId = resolveAdminOrgId(engine, orgFlag);
      if (sub === "list") {
        assertAllowedFlags(flags, [], "actor list");
        const res = {
          actors: engine.db.listActors(orgId),
          identities: engine.db.listIdentities(orgId),
          disabledActors: engine.db.listDisabledActors(orgId),
        };
        output(res, formatGenericMarkdown("Actors, SSO Identities & Disabled Actors", res));
        return;
      }
      if (sub === "set-role") {
        assertAllowedFlags(flags, ["role"], "actor set-role");
        if (!third?.trim()) {
          throw new MindError(
            "INVALID_INPUT",
            "actor set-role requires <actorId> --role admin|member",
            {
              try: "meru-mind actor set-role alice --role admin --as-human",
            },
          );
        }
        const targetActorId = third.trim();
        const rawRole = requireFlag(flags, "role", "actor set-role");
        if (rawRole !== "admin" && rawRole !== "member") {
          throw new MindError(
            "INVALID_INPUT",
            `Flag --role must be "admin" or "member", got "${rawRole}"`,
          );
        }
        const updated = engine.db.transaction(() => {
          if (rawRole === "member") {
            const existing = engine.db.getActor(orgId, targetActorId);
            if (
              existing?.role === "admin" &&
              !engine.db.isActorDisabled(orgId, targetActorId) &&
              engine.db.countActiveAdmins(orgId) <= 1
            ) {
              throw new MindError(
                "CONFLICT",
                "Cannot demote the last active organization administrator.",
              );
            }
          }
          return engine.db.setActorRole(orgId, targetActorId, rawRole);
        });
        const res = {
          actorId: updated.actorId,
          role: updated.role,
          displayName: updated.displayName,
          updatedAt: updated.updatedAt,
        };
        output(res, formatGenericMarkdown("Actor Role Updated", res));
        return;
      }
      if (sub === "disable") {
        assertAllowedFlags(flags, ["reason"], "actor disable");
        if (!third?.trim()) {
          throw new MindError("INVALID_INPUT", "actor disable requires <actorId>", {
            try: "meru-mind actor disable alice --as-human",
          });
        }
        const targetActorId = third.trim();
        const disabledAt = new Date().toISOString();
        const dbRes = engine.db.transaction(() => {
          const existing = engine.db.getActor(orgId, targetActorId);
          if (
            existing?.role === "admin" &&
            !engine.db.isActorDisabled(orgId, targetActorId) &&
            engine.db.countActiveAdmins(orgId) <= 1
          ) {
            throw new MindError(
              "CONFLICT",
              "Cannot disable the last active organization administrator.",
            );
          }
          return engine.db.disableActor({
            orgId,
            actorId: targetActorId,
            reason: flagStr(flags, "reason") ?? null,
            disabledBy: actor.id,
            disabledAt,
          });
        });
        const res = { actorId: targetActorId, disabled: true, disabledAt, ...dbRes };
        output(res, formatGenericMarkdown("Actor Disabled", res));
        return;
      }
      if (sub === "enable") {
        assertAllowedFlags(flags, [], "actor enable");
        if (!third?.trim()) {
          throw new MindError("INVALID_INPUT", "actor enable requires <actorId>", {
            try: "meru-mind actor enable alice --as-human",
          });
        }
        const enabled = engine.db.enableActor(orgId, third.trim());
        const res = { actorId: third.trim(), enabled };
        output(res, formatGenericMarkdown("Actor Enabled", res));
        return;
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown actor subcommand "${sub ?? ""}"`,
        { try: "meru-mind actor --help" },
      );
    }

    if (cmd === "work") {
      const ctx = resolveSessionContext({ engine, flags });
      const surface = new LocalMindSurface({
        engine,
        principal: {
          tokenId: null,
          orgId: ctx.org.id,
          actor,
          boundRealmId: ctx.boundViewerRealmId,
          boundSource: ctx.boundSource,
          authKind: "local",
        },
        ownsEngine: false,
      });
      try {
        if (sub === "bind") {
          assertAllowedFlags(
            flags,
            ["in", "provider", "config", "team", "project", "repo", "token-env"],
            "work bind",
          );
          let config: Record<string, unknown> = {};
          const rawConfig = flagStr(flags, "config");
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
          const provider = requireFlag(flags, "provider", "work bind");
          const team = flagStr(flags, "team");
          const project = flagStr(flags, "project");
          const repo = flagStr(flags, "repo");
          const tokenEnv = flagStr(flags, "token-env");
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
            realmRef: requireFlag(flags, "in", "work bind"),
            provider,
            config,
          });
          output(res, formatGenericMarkdown("Work Provider Bound", res));
          return;
        }
        if (sub === "unbind") {
          assertAllowedFlags(flags, ["in"], "work unbind");
          const realmRef = requireFlag(flags, "in", "work unbind");
          const unbound = await surface.unbindWork({ realmRef });
          output({ realmRef, unbound }, formatGenericMarkdown("Work Provider Unbound", { realmRef, unbound }));
          return;
        }
        if (sub === "list") {
          assertAllowedFlags(flags, [], "work list");
          const bindings = await surface.listWorkBindings();
          output(bindings, formatGenericMarkdown("Work Provider Bindings", bindings));
          return;
        }
        if (sub === "ready") {
          assertAllowedFlags(flags, ["in", "limit", "cursor"], "work ready");
          const res = await surface.listReadyWork({
            realmRef: flagStr(flags, "in"),
            limit: parseIntFlag(flags, "limit", { min: 1 }),
            cursor: flagStr(flags, "cursor"),
          });
          output(res, formatGenericMarkdown("Ready Work Items", res));
          return;
        }
        if (sub === "resolve") {
          assertAllowedFlags(flags, ["in"], "work resolve");
          const items = positionals.slice(2).filter(Boolean);
          if (items.length === 0) {
            throw new MindError(
              "INVALID_INPUT",
              "work resolve requires one or more <itemRef> arguments",
              { try: "meru-mind work resolve OPS-42 --in /ops" },
            );
          }
          const res = await surface.resolveWork({
            realmRef: flagStr(flags, "in"),
            items,
          });
          output(res, formatGenericMarkdown("Resolved Work Items", res));
          return;
        }
        throw new MindError(
          "UNKNOWN_COMMAND",
          `Unknown work subcommand "${sub ?? ""}"`,
          { try: "meru-mind work --help" },
        );
      } finally {
        await surface.close();
      }
    }

    if (cmd === "org") {
      if (sub === "list") {
        assertAllowedFlags(flags, [], "org list");
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
      if (sub === "create") {
        assertAllowedFlags(flags, ["name", "personal", "policy"], "org create");
        const res = engine.ledger.createOrg({
          name: requireFlag(flags, "name", "org create"),
          isPersonalRoot: flagBool(flags, "personal"),
          policy: flagStr(flags, "policy") as OrgPolicy | undefined,
        });
        output(res, formatGenericMarkdown("Organization Created", res));
        return;
      }
      if (sub === "set-policy") {
        assertAllowedFlags(flags, ["policy"], "org set-policy");
        const res = engine.ledger.setOrgPolicy({
          orgId: requireFlag(flags, "org", "org set-policy"),
          policy: requireFlag(flags, "policy", "org set-policy") as OrgPolicy,
          actor,
        });
        output(res, formatGenericMarkdown("Organization Policy Updated", res));
        return;
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown org subcommand "${sub ?? ""}"`,
        { try: "meru-mind org --help" },
      );
    }

    if (cmd === "realm") {
      if (sub === "create") {
        assertAllowedFlags(
          flags,
          ["parent", "slug", "name", "scope"],
          "realm create",
        );
        const orgId = resolveAdminOrgId(engine, orgFlag);
        const parentRef = requireFlag(flags, "parent", "realm create");
        const parentId = resolveAdminRealmId(engine, parentRef, orgId);
        const scope = requireFlag(flags, "scope", "realm create");
        const res = engine.ledger.createRealm({
          actor,
          orgId,
          parentId,
          slug: requireFlag(flags, "slug", "realm create"),
          name: requireFlag(flags, "name", "realm create"),
          scope,
        });
        output(res, formatGenericMarkdown("Realm Created", res));
        return;
      }
      if (sub === "set") {
        assertAllowedFlags(flags, ["name", "scope"], "realm set");
        const realmRef = third?.trim();
        if (!realmRef) {
          throw new MindError(
            "INVALID_INPUT",
            "Missing <realmRef> for 'realm set'",
            {
              try: 'meru-mind realm set /ops --scope "Include: ... Exclude: ..." --as-human',
            },
          );
        }
        const orgId = resolveAdminOrgId(engine, orgFlag);
        const realmId = resolveAdminRealmId(engine, realmRef, orgId);
        const res = engine.ledger.updateRealm({
          actor,
          orgId,
          realmId,
          name: flagStr(flags, "name"),
          scope: flagStr(flags, "scope"),
        });
        output(res, formatGenericMarkdown("Realm Updated", res));
        return;
      }
      if (sub === "archive") {
        assertAllowedFlags(flags, [], "realm archive");
        const realmRef = third?.trim();
        if (!realmRef) {
          throw new MindError(
            "INVALID_INPUT",
            "Missing <realmRef> for 'realm archive'",
            { try: "meru-mind realm archive /old-project --as-human" },
          );
        }
        const orgId = resolveAdminOrgId(engine, orgFlag);
        const realmId = resolveAdminRealmId(engine, realmRef, orgId);
        const res = engine.ledger.archiveRealm({ actor, orgId, realmId });
        output(res, formatGenericMarkdown("Realm Archived", res));
        return;
      }
      if (sub === "unarchive") {
        assertAllowedFlags(flags, [], "realm unarchive");
        const realmRef = third?.trim();
        if (!realmRef) {
          throw new MindError(
            "INVALID_INPUT",
            "Missing <realmRef> for 'realm unarchive'",
            { try: "meru-mind realm unarchive /old-project --as-human" },
          );
        }
        const orgId = resolveAdminOrgId(engine, orgFlag);
        const realmId = resolveAdminRealmId(engine, realmRef, orgId);
        const res = engine.ledger.unarchiveRealm({ actor, orgId, realmId });
        output(res, formatGenericMarkdown("Realm Unarchived", res));
        return;
      }
      if (sub === "list") {
        assertAllowedFlags(flags, ["all", "limit"], "realm list");
        const ctx = resolveSessionContext({ engine, flags });
        const includeArchived = flagBool(flags, "all");
        const rawOrgRealms = engine.db.listRealms(ctx.org.id);
        const archivedIds = new Set(
          rawOrgRealms
            .filter((r) => isRealmEffectivelyArchived(rawOrgRealms, r.id))
            .map((r) => r.id),
        );
        const allVisible = engine.ledger.listRealms({
          orgId: ctx.org.id,
          viewerRealmId: ctx.boundViewerRealmId,
          scopeCeiling: ctx.boundScope,
        });
        const hiddenArchived = includeArchived
          ? 0
          : allVisible.filter((r) => archivedIds.has(r.id)).length;
        const filtered = includeArchived
          ? allVisible
          : allVisible.filter((r) => !archivedIds.has(r.id));
        const limit = parseIntFlag(flags, "limit", { min: 1 }) ?? 50;
        const sliced = filtered.slice(0, limit);
        const omitted = Math.max(0, filtered.length - sliced.length);
        const md = [
          `# Realms (${sliced.length}/${filtered.length}${omitted > 0 ? `, omitted: ${omitted}` : ""})`,
          "",
          ...sliced.map((r) => {
            const arch = archivedIds.has(r.id) ? " [archived]" : "";
            const sc = r.scope ? ` | ${r.scope}` : "";
            return `- **${r.path}** — ${r.name}${arch} (\`${r.id}\`)${sc}`;
          }),
          ...(omitted > 0 ? [`... and ${omitted} more`] : []),
          ...(hiddenArchived > 0
            ? [
                "",
                `_(${hiddenArchived} archived realm(s) hidden; pass --all to show)_`,
              ]
            : []),
        ].join("\n");
        output(sliced, md);
        return;
      }
      if (sub === "mount") {
        assertAllowedFlags(
          flags,
          ["viewer", "target", "scope"],
          "realm mount",
        );
        const res = engine.ledger.mountRealm({
          actor,
          viewerRealmId: resolveAdminRealmId(
            engine,
            requireFlag(flags, "viewer", "realm mount"),
            orgFlag,
          ),
          targetRealmId: resolveAdminRealmId(
            engine,
            requireFlag(flags, "target", "realm mount"),
            orgFlag,
          ),
          scope: (flagStr(flags, "scope") as MountScope | undefined) ?? "all",
        });
        output(res, formatGenericMarkdown("Realm Mounted", res));
        return;
      }
      if (sub === "unmount") {
        assertAllowedFlags(flags, ["viewer", "target"], "realm unmount");
        const res = {
          removed: engine.ledger.unmountRealm({
            actor,
            viewerRealmId: resolveAdminRealmId(
              engine,
              requireFlag(flags, "viewer", "realm unmount"),
              orgFlag,
            ),
            targetRealmId: resolveAdminRealmId(
              engine,
              requireFlag(flags, "target", "realm unmount"),
              orgFlag,
            ),
          }),
        };
        output(res, formatGenericMarkdown("Realm Unmounted", res));
        return;
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown realm subcommand "${sub ?? ""}"`,
        { try: "meru-mind realm --help" },
      );
    }

    if (cmd === "entry") {
      if (sub === "move") {
        assertAllowedFlags(
          flags,
          ["to", "from", "ids-file", "dry-run"],
          "entry move",
        );
        const idsFromPos = positionals.slice(2).map((s) => s.trim()).filter(Boolean);
        const idsFile = flagStr(flags, "ids-file");
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
            "Missing <entryId>... or --ids-file <path|-> for 'entry move'",
            {
              try: "meru-mind entry move <entryId> --to /ops --as-human",
            },
          );
        }
        const ctx = resolveSessionContext({ engine, flags });
        const toRef = requireFlag(flags, "to", "entry move");
        const fromRef = flagStr(flags, "from");
        const dryRun = flagBool(flags, "dry-run");
        const surface = new LocalMindSurface({
          engine,
          principal: {
            tokenId: null,
            orgId: ctx.org.id,
            actor,
            boundRealmId: ctx.boundViewerRealmId,
            boundSource: ctx.boundSource,
            authKind: "local",
          },
          ownsEngine: false,
        });
        try {
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
              targetRealmRef: toRef,
              expectedFromRealmRef: fromRef,
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
          const mdLines = [
            `# Entry Move${merged.dryRun ? " (Dry Run)" : ""}: -> \`${merged.targetRealmPath}\``,
            `- Moved: ${merged.moved.length}${batches > 1 ? ` (${batches} batches)` : ""}`,
            `- Skipped (already in target): ${merged.skippedAlreadyInTargetIds.length}`,
            ...merged.moved.slice(0, 50).map(
              (m) =>
                `- \`${m.id}\` (${m.entityType}): \`${m.fromRealmPath}\` -> \`${m.toRealmPath}\`${m.chainExpanded ? " _(chain-expanded)_" : ""}`,
            ),
            ...(merged.moved.length > 50
              ? [`... and ${merged.moved.length - 50} more`]
              : []),
          ];
          output(merged, mdLines.join("\n"));
          return;
        } finally {
          await surface.close();
        }
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown entry subcommand "${sub ?? ""}"`,
        { try: "meru-mind entry --help" },
      );
    }

    if (cmd === "object") {
      if (sub === "create") {
        assertAllowedFlags(
          flags,
          ["in", "kind", "name", "parent"],
          "object create",
        );
        const ctx = resolveSessionContext({ engine, flags });
        const parentRaw = flagStr(flags, "parent");
        const parentObjectId = parentRaw
          ? resolveSingleObjectIdForManage({
              engine,
              ctx,
              actor,
              rawRef: parentRaw,
            })
          : undefined;
        const obj = engine.objects.createObject({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmRef: flagStr(flags, "in") ?? third,
          parentObjectId,
          kind: requireFlag(flags, "kind", "object create"),
          name: requireFlag(flags, "name", "object create"),
        });
        output(obj, formatGenericMarkdown("Object Created", obj));
        return;
      }
      if (sub === "move") {
        assertAllowedFlags(flags, ["parent"], "object move");
        const ctx = resolveSessionContext({ engine, flags });
        if (!third?.trim()) {
          throw new MindError(
            "INVALID_REF",
            "object move requires an <objRef> argument",
            { try: "meru-mind object move service:api --parent none" },
          );
        }
        const objectId = resolveSingleObjectIdForManage({
          engine,
          ctx,
          actor,
          rawRef: third,
        });
        const parentRaw = requireFlag(flags, "parent", "object move").trim();
        const nextParentId =
          parentRaw.toLowerCase() === "none" ||
          parentRaw.toLowerCase() === "null"
            ? null
            : resolveSingleObjectIdForManage({
                engine,
                ctx,
                actor,
                rawRef: parentRaw,
              });
        const moved = engine.objects.moveObject({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          objectId,
          parentObjectId: nextParentId,
        });
        output(moved, formatGenericMarkdown("Object Moved", moved));
        return;
      }
      if (sub === "delete") {
        assertAllowedFlags(flags, [], "object delete");
        const ctx = resolveSessionContext({ engine, flags });
        if (!third?.trim()) {
          throw new MindError(
            "INVALID_REF",
            "object delete requires an <objRef> argument",
            { try: "meru-mind object delete service:api" },
          );
        }
        const objectId = resolveSingleObjectIdForManage({
          engine,
          ctx,
          actor,
          rawRef: third,
        });
        const removed = engine.objects.deleteObject({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          objectId,
        });
        output(
          { removed },
          formatGenericMarkdown("Object Deleted", { removed }),
        );
        return;
      }
      if (sub === "link") {
        assertAllowedFlags(flags, [], "object link");
        const ctx = resolveSessionContext({ engine, flags });
        if (!third?.trim() || !fourth?.trim()) {
          throw new MindError(
            "INVALID_INPUT",
            "object link requires <entryId> and <objRef> positional arguments",
            { try: "meru-mind object link rec_... service:api" },
          );
        }
        const objectId = resolveSingleObjectIdForManage({
          engine,
          ctx,
          actor,
          rawRef: fourth,
        });
        const link = engine.objects.linkEntryObject({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          entryId: third.trim(),
          objectId,
        });
        output(link, formatGenericMarkdown("Entry Linked to Object", link));
        return;
      }
      if (sub === "unlink") {
        assertAllowedFlags(flags, [], "object unlink");
        const ctx = resolveSessionContext({ engine, flags });
        if (!third?.trim() || !fourth?.trim()) {
          throw new MindError(
            "INVALID_INPUT",
            "object unlink requires <entryId> and <objRef> positional arguments",
            { try: "meru-mind object unlink rec_... service:api" },
          );
        }
        const objectId = resolveSingleObjectIdForManage({
          engine,
          ctx,
          actor,
          rawRef: fourth,
        });
        const removed = engine.objects.unlinkEntryObject({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          entryId: third.trim(),
          objectId,
        });
        output(
          { removed },
          formatGenericMarkdown("Entry Unlinked from Object", { removed }),
        );
        return;
      }
      if (sub === "set") {
        assertAllowedFlags(
          flags,
          ["state", "label", "since", "because"],
          "object set",
        );
        const ctx = resolveSessionContext({ engine, flags });
        if (!third?.trim()) {
          throw new MindError(
            "INVALID_REF",
            "object set requires an <objRef> argument",
            {
              try: "meru-mind object set service:api --state inactive --label deprecated --because rec_...",
            },
          );
        }
        const objectId = resolveSingleObjectIdForManage({
          engine,
          ctx,
          actor,
          rawRef: third,
        });
        const state = requireFlag(flags, "state", "object set") as ObjectState;
        const res = engine.objects.setObjectState({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          objectId,
          state,
          label: flagStr(flags, "label"),
          since: flagStr(flags, "since"),
          because: flagStr(flags, "because"),
          scopeCeiling: ctx.boundScope,
        });
        output(res, formatGenericMarkdown("Object State Updated", res));
        return;
      }
      if (sub === "alias") {
        assertAllowedFlags(flags, ["add", "remove"], "object alias");
        const ctx = resolveSessionContext({ engine, flags });
        if (!third?.trim()) {
          throw new MindError(
            "INVALID_REF",
            "object alias requires an <objRef> argument",
            { try: 'meru-mind object alias service:api --add "Billing API"' },
          );
        }
        const objectId = resolveSingleObjectIdForManage({
          engine,
          ctx,
          actor,
          rawRef: third,
        });
        const res = engine.objects.updateObjectAliases({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          objectId,
          add: multiFlags["add"] ?? [],
          remove: multiFlags["remove"] ?? [],
          scopeCeiling: ctx.boundScope,
        });
        output(res, formatGenericMarkdown("Object Aliases Updated", res));
        return;
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown object subcommand "${sub ?? ""}"`,
        { try: "meru-mind object --help" },
      );
    }

    if (cmd === "file") {
      if (sub === "write") {
        assertAllowedFlags(
          flags,
          ["content", "file", "expected-version", "message"],
          "file write",
        );
        const ctx = resolveSessionContext({ engine, flags });
        if (!third?.trim()) {
          throw new MindError(
            "INVALID_REF",
            "file write requires a <file:/realm/relPath> argument",
            {
              try: 'meru-mind file write file:/ops/sop.md --content "# SOP"',
            },
          );
        }
        const resolvedFile = resolveFileRef({
          realms: ctx.realms,
          orgId: ctx.org.id,
          ref: third,
          scope: ctx.boundScope,
        });
        const localFile = flagStr(flags, "file");
        const content = localFile
          ? fs.readFileSync(localFile, "utf8")
          : requireFlag(flags, "content", "file write");
        const expectedVersion = parseIntFlag(flags, "expected-version", {
          min: 0,
        });
        const res = await engine.ledger.writeDriveFile({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmId: resolvedFile.realm.id,
          relPath: resolvedFile.relPath,
          content,
          expectedVersion,
          message: flagStr(flags, "message"),
          allowRedactedReingest: flagBool(flags, "as-human"),
        });
        output(
          { ...res, ref: resolvedFile.canonicalRef },
          formatGenericMarkdown(`File Written (${resolvedFile.canonicalRef})`, res),
        );
        return;
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown file subcommand "${sub ?? ""}" (use 'meru-mind show file:...' to read, 'meru-mind ls --only files' to list)`,
        { try: "meru-mind file --help" },
      );
    }

    if (cmd === "rule") {
      if (sub === "add") {
        assertAllowedFlags(
          flags,
          [
            "in",
            "title",
            "body",
            "about",
            "supersedes",
            "because",
            "occurred-at",
            "sensitivity",
            "idempotency-key",
          ],
          "rule add",
        );
        const ctx = resolveSessionContext({ engine, flags });
        const inRef = requireFlag(flags, "in", "rule add");
        const targetRealm = resolveVisibleRealm({
          realms: ctx.realms,
          orgId: ctx.org.id,
          ref: inRef,
          scope: ctx.boundScope,
        });
        const vis = createVisibilityHelpers({
          db: engine.db,
          realms: ctx.realms,
          mounts: engine.db.listMounts(),
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          scope: ctx.boundScope,
        });
        const resolvedAbout = resolveAboutRefsForWrite({
          db: engine.db,
          realms: ctx.realms,
          orgId: ctx.org.id,
          about: flagMulti(multiFlags, "about"),
          scope: ctx.boundScope,
          vis,
        });
        const body = requireFlag(flags, "body", "rule add");
        const supersedesList = flagMulti(multiFlags, "supersedes");
        const rec = await engine.ledger.appendRecord({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmId: targetRealm.id,
          thingId: resolvedAbout.thingId,
          kind: "rule",
          title: requireFlag(flags, "title", "rule add"),
          payload: buildWriteRecordPayload(body),
          refs: flagMulti(multiFlags, "because"),
          objectIds: resolvedAbout.objectIds,
          resourceTags: resolvedAbout.resourceTags,
          supersedesIds: supersedesList.length > 0 ? supersedesList : undefined,
          occurredAt: parseOccurredAtFlag(flags),
          sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
          idempotencyKey: flagStr(flags, "idempotency-key"),
          allowRedactedReingest: flagBool(flags, "as-human"),
        });
        output(rec, formatGenericMarkdown("Rule Added", rec));
        return;
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown rule subcommand "${sub ?? ""}"`,
        { try: "meru-mind rule --help" },
      );
    }

    if (cmd === "raw") {
      if (sub === "add") {
        assertAllowedFlags(
          flags,
          [
            "in",
            "kind",
            "text",
            "topic",
            "file",
            "source-ref",
            "about",
            "occurred-at",
            "sensitivity",
            "idempotency-key",
          ],
          "raw add",
        );
        const ctx = resolveSessionContext({ engine, flags });
        const mounts = engine.db.listMounts();
        const explicitIn = flagStr(flags, "in");
        const isExplicitlyBound = ctx.boundSource === "MERU_MIND_VIEWER_REALM_ID";
        if (
          !explicitIn &&
          !isExplicitlyBound &&
          ctx.org.policy === "open" &&
          workspaceMarkerError
        ) {
          throw workspaceMarkerError;
        }
        const aboutRefs = flagMulti(multiFlags, "about");
        const routed = resolveWriteTargetRealm({
          db: engine.db,
          ledger: engine.ledger,
          realms: ctx.realms,
          mounts,
          scope: ctx.boundScope,
          orgId: ctx.org.id,
          orgPolicy: ctx.org.policy,
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          isExplicitlyBound,
          explicitIn,
          workspaceMarkerRef,
          about: aboutRefs,
        });
        const effectiveScope =
          routed.routedBy === "inbox"
            ? resolveAccessScope({
                realms: routed.realms,
                mounts,
                viewerRealmId: ctx.boundViewerRealmId,
                orgPolicy: ctx.org.policy,
                includeDescendantSeabed: false,
              })
            : ctx.boundScope;
        const vis = createVisibilityHelpers({
          db: engine.db,
          realms: routed.realms,
          mounts,
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          scope: effectiveScope,
        });
        const resolvedAbout = resolveAboutRefsForWrite({
          db: engine.db,
          realms: routed.realms,
          orgId: ctx.org.id,
          about: aboutRefs,
          scope: effectiveScope,
          vis,
        });
        const filePath = flagStr(flags, "file");
        const blobContent = filePath ? fs.readFileSync(filePath) : undefined;
        const entry = await engine.ledger.captureSeabed({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmId: routed.realm.id,
          kind: requireFlag(flags, "kind", "raw add") as SeabedKind,
          text: flagStr(flags, "text") ?? "",
          topicId: flagStr(flags, "topic"),
          blobContent,
          sourceRef: flagStr(flags, "source-ref"),
          objectIds: resolvedAbout.objectIds,
          resourceTags: resolvedAbout.resourceTags,
          occurredAt: parseOccurredAtFlag(flags),
          sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
          idempotencyKey: flagStr(flags, "idempotency-key"),
          allowRedactedReingest: flagBool(flags, "as-human"),
        });
        const payloadOut = {
          ...entry,
          realmPath: routed.realm.path,
          routedBy: routed.routedBy,
        };
        output(
          payloadOut,
          formatGenericMarkdown(
            `Raw Entry Added -> \`${routed.realm.path}\` (routed: ${routed.routedBy})`,
            payloadOut,
          ),
        );
        return;
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown raw subcommand "${sub ?? ""}"`,
        { try: "meru-mind raw --help" },
      );
    }

    if (cmd === "redact") {
      assertAllowedFlags(flags, ["reason"], "redact");
      if (!sub?.trim()) {
        throw new MindError(
          "INVALID_REF",
          "redact requires a positional <entryId> (rec_... or sea_...)",
          { try: "meru-mind redact rec_... --reason \"...\" --as-human" },
        );
      }
      const envViewer = process.env.MERU_MIND_VIEWER_REALM_ID?.trim();
      const res = engine.ledger.redact({
        actor,
        entryId: sub.trim(),
        reason: flagStr(flags, "reason"),
        viewerRealmId: envViewer
          ? resolveAdminRealmId(engine, envViewer, orgFlag)
          : undefined,
      });
      output(res, formatGenericMarkdown("Redacted", res));
      return;
    }

    if (cmd === "settle") {
      assertAllowedFlags(
        flags,
        ["in", "layer", "period", "narrative", "sources"],
        "settle",
      );
      const ctx = resolveSessionContext({ engine, flags });
      const inRef = requireFlag(flags, "in", "settle");
      const targetRealm = resolveVisibleRealm({
        realms: ctx.realms,
        orgId: ctx.org.id,
        ref: inRef,
        scope: ctx.boundScope,
      });
      const sourceIds = parseCsvFlag(flags, "sources");
      const res = await engine.sea.settle({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        targetRealmId: targetRealm.id,
        layer: requireFlag(flags, "layer", "settle") as DistillationLayer,
        periodKey: requireFlag(flags, "period", "settle"),
        narrativeMd: flagStr(flags, "narrative"),
        sourceIds: sourceIds.length > 0 ? sourceIds : undefined,
      });
      output(res, formatGenericMarkdown("Settled Distillation", res));
      return;
    }

    if (cmd === "import") {
      const resolveCliImportTarget = (opts: {
        ctx: ReturnType<typeof resolveSessionContext>;
        explicitIn?: string;
        mapping?: ImportMappingConfig;
        readOnly: boolean;
      }): { targetRealmRef?: string; virtualDefaultRealmPath?: string } => {
        if (opts.explicitIn?.trim()) {
          return { targetRealmRef: opts.explicitIn.trim() };
        }
        if (opts.mapping?.defaultRealm?.trim()) {
          return { targetRealmRef: opts.mapping.defaultRealm.trim() };
        }
        const isExplicitlyBound =
          opts.ctx.boundSource === "MERU_MIND_VIEWER_REALM_ID";
        if (
          !isExplicitlyBound &&
          opts.ctx.org.policy === "open" &&
          workspaceMarkerError
        ) {
          throw workspaceMarkerError;
        }
        if (opts.readOnly) {
          if (isExplicitlyBound) {
            const bound = opts.ctx.realms.find(
              (r) => r.id === opts.ctx.boundViewerRealmId,
            );
            return { targetRealmRef: bound?.path };
          }
          if (opts.ctx.org.policy === "open" && workspaceMarkerRef) {
            return { targetRealmRef: workspaceMarkerRef };
          }
          if (opts.ctx.org.policy === "open") {
            const existingInbox = opts.ctx.realms.find(
              (r) => r.orgId === opts.ctx.org.id && r.path === "/inbox",
            );
            return existingInbox
              ? { targetRealmRef: "/inbox" }
              : { virtualDefaultRealmPath: "/inbox" };
          }
          throw new MindError(
            "NOT_BOUND",
            "Target realm could not be determined; pass --in <realm> or bind MERU_MIND_VIEWER_REALM_ID.",
            { try: "MERU_MIND_VIEWER_REALM_ID=/team/project meru-mind import md ./notes" },
          );
        }
        const routed = resolveWriteTargetRealm({
          db: engine.db,
          ledger: engine.ledger,
          realms: opts.ctx.realms,
          mounts: engine.db.listMounts(),
          scope: opts.ctx.boundScope,
          orgId: opts.ctx.org.id,
          orgPolicy: opts.ctx.org.policy,
          actor,
          viewerRealmId: opts.ctx.boundViewerRealmId,
          isExplicitlyBound,
          workspaceMarkerRef,
        });
        return { targetRealmRef: routed.realm.path };
      };

      if (sub === "md") {
        assertAllowedFlags(
          flags,
          [
            "in",
            "map",
            "base-dir",
            "source-ref",
            "kind",
            "ext-kind",
            "sensitivity",
            "about",
            "include-secret",
            "sync-embeddings",
            "dry-run",
          ],
          "import md",
        );
        const ctx = resolveSessionContext({ engine, flags });
        if (!third?.trim()) {
          throw new MindError(
            "INVALID_INPUT",
            "import md requires a Markdown file or directory path",
            { try: "meru-mind import md ./notes --in /ops" },
          );
        }
        const mapPath = flagStr(flags, "map");
        const mapping = mapPath ? loadMappingFile(mapPath) : undefined;
        const isDryRun = flagBool(flags, "dry-run");
        const importTarget = resolveCliImportTarget({
          ctx,
          explicitIn: flagStr(flags, "in"),
          mapping,
          readOnly: isDryRun,
        });
        if (isDryRun) {
          const preview = engine.importer.previewImport({
            viewerRealmId: ctx.boundViewerRealmId,
            sourcePath: third,
            sourceType: "md",
            mapping,
            baseDir: flagStr(flags, "base-dir"),
            targetRealmRef: importTarget.targetRealmRef,
            virtualDefaultRealmPath: importTarget.virtualDefaultRealmPath,
            skipSecret: !flagBool(flags, "include-secret"),
          });
          output(preview, formatImportDryRunMarkdown(preview));
          if (!preview.valid) {
            process.exitCode = 1;
          }
          return;
        }
        const vis = createVisibilityHelpers({
          db: engine.db,
          realms: ctx.realms,
          mounts: engine.db.listMounts(),
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          scope: ctx.boundScope,
        });
        const resolvedAbout = resolveAboutRefsForWrite({
          db: engine.db,
          realms: ctx.realms,
          orgId: ctx.org.id,
          about: flagMulti(multiFlags, "about"),
          scope: ctx.boundScope,
          vis,
        });
        const res = await engine.importer.importMd({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmRef: importTarget.targetRealmRef,
          inputPath: third,
          baseDir: flagStr(flags, "base-dir"),
          sourceRef: flagStr(flags, "source-ref"),
          kind: flagStr(flags, "kind") as RecordKind | undefined,
          extKind: flagStr(flags, "ext-kind"),
          sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
          skipSecret: !flagBool(flags, "include-secret"),
          objectIds: resolvedAbout.objectIds,
          resourceTags: resolvedAbout.resourceTags,
          mapping,
          syncEmbeddings: flagBool(flags, "sync-embeddings"),
        });
        output(res, formatImportMdMarkdown(res));
        return;
      }
      if (sub === "jsonl") {
        assertAllowedFlags(
          flags,
          ["in", "map", "sync-embeddings", "dry-run"],
          "import jsonl",
        );
        const ctx = resolveSessionContext({ engine, flags });
        if (!third?.trim()) {
          throw new MindError(
            "INVALID_INPUT",
            "import jsonl requires a JSONL file path",
            { try: "meru-mind import jsonl ./events.jsonl --map ./map.json" },
          );
        }
        const mapping = loadMappingFile(
          requireFlag(flags, "map", "import jsonl"),
        );
        const isDryRun = flagBool(flags, "dry-run");
        const importTarget = resolveCliImportTarget({
          ctx,
          explicitIn: flagStr(flags, "in"),
          mapping,
          readOnly: isDryRun,
        });
        if (isDryRun) {
          const preview = engine.importer.previewImport({
            viewerRealmId: ctx.boundViewerRealmId,
            sourcePath: third,
            sourceType: "jsonl",
            mapping,
            targetRealmRef: importTarget.targetRealmRef,
            virtualDefaultRealmPath: importTarget.virtualDefaultRealmPath,
          });
          output(preview, formatImportDryRunMarkdown(preview));
          if (!preview.valid) {
            process.exitCode = 1;
          }
          return;
        }
        const res = await engine.importer.importJsonl({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmRef: importTarget.targetRealmRef,
          jsonlPath: third,
          mapping,
          syncEmbeddings: flagBool(flags, "sync-embeddings"),
        });
        output(res, formatImportJsonlMarkdown(res));
        return;
      }
      if (sub === "verify") {
        assertAllowedFlags(
          flags,
          ["source", "in", "map", "base-dir"],
          "import verify",
        );
        const ctx = resolveSessionContext({ engine, flags });
        const sourcePath = flagStr(flags, "source") ?? third;
        if (!sourcePath) {
          throw new MindError(
            "INVALID_INPUT",
            "import verify requires --source <file|dir>",
            { try: "meru-mind import verify --source ./notes" },
          );
        }
        const mapPath = flagStr(flags, "map");
        const mapping = mapPath ? loadMappingFile(mapPath) : undefined;
        const importTarget = resolveCliImportTarget({
          ctx,
          explicitIn: flagStr(flags, "in"),
          mapping,
          readOnly: true,
        });
        const res = engine.importer.verifyImportConsistency({
          viewerRealmId: ctx.boundViewerRealmId,
          sourcePath,
          mapping,
          baseDir: flagStr(flags, "base-dir"),
          targetRealmRef: importTarget.targetRealmRef,
        });
        output(res, formatImportVerifyMarkdown(res));
        if (!res.passed) {
          process.exitCode = 1;
        }
        return;
      }
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown import subcommand "${sub ?? ""}"`,
        { try: "meru-mind import --help" },
      );
    }
  } finally {
    await engine.close();
  }
}

const wantsJsonErrors = process.argv.includes("--json");

main().catch((err: unknown) => {
  const payload = toSurfaceError(err, { surface: "cli" });
  if (wantsJsonErrors) {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`${formatSurfaceErrorText(payload)}\n`);
  }
  process.exit(1);
});
