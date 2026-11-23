#!/usr/bin/env node
import fs from "node:fs";
import {
  buildWriteRecordPayload,
  createMindEngine,
  formatChangesMarkdown,
  formatGenericMarkdown,
  formatImportJsonlMarkdown,
  formatImportMdMarkdown,
  formatImportVerifyMarkdown,
  formatLsMarkdown,
  formatSearchMarkdown,
  formatShowMarkdown,
  formatSurfaceErrorText,
  formatTreeMarkdown,
  formatWhoamiMarkdown,
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
  toSurfaceError,
  writeEverydayConclusion,
  type AccessScope,
  type Actor,
  type ActorKind,
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
  "drive",
  "actor",
  "actor-kind",
  "as-human",
  "family",
  "org",
  "json",
  "help",
]);

const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "personal",
  "as-human",
  "history",
  "full",
  "include-descendant-seabed",
  "no-restore-drive",
  "sync-embeddings",
  "include-secret",
  "objects",
  "no-objects",
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
  write --in <realm> --title T --body B [--kind decision|finding|claim|proposal|verdict]
        [--about <obj>]... [--supersedes <entry>]... [--because <ref>]...
        [--occurred-at <iso|none>] [--sensitivity public|internal|confidential|secret]

MANAGE [write / human]:
  realm | object | file | rule | raw | redact | settle | import | org | admin

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
Usage: meru-mind tree [ref] [-L|--depth <n|all>] [--objects|--no-objects] [--limit <n>]
Flags:
  -L, --depth <n|all>    Expansion depth (default: 1; 0 = target only; all = unlimited)
  --objects/--no-objects Include object hierarchy (default: true)
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
Usage: meru-mind write --in <realm> --title <T> --body <B> [--kind <k>] [--about <obj>]... [--supersedes <id>]... [--because <ref>]... [--occurred-at <iso|none>] [--sensitivity <level>] [--idempotency-key <key>]
Flags:
  --in <realm>           Target writable realm (/path or realm_...) [required]
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
  meru-mind write --in /ops --title "API timeout" --body "Raised timeout to 30s" --about service:api
`,
  realm: `Risk: high-risk-write (create/mount/unmount in tree orgs require --as-human)
When to use: Manage realms and cross-branch read-only mounts.
Usage:
  meru-mind realm create [--org <orgId>] --parent <realm> --slug <slug> --name <name> [--as-human]
  meru-mind realm list [--limit <n>]
  meru-mind realm mount --viewer <realm> --target <realm> [--scope all|ledger|drive] [--as-human]
  meru-mind realm unmount --viewer <realm> --target <realm> [--as-human]
Examples:
  meru-mind realm create --parent / --slug ops --name "Operations" --as-human
  meru-mind realm mount --viewer /team-b/c2 --target /team-a/c1 --scope ledger --as-human
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
  file: `Risk: write
When to use: Write a versioned file to a MindRealm shared drive (use 'meru-mind show file:...' to read).
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
  raw: `Risk: write
When to use: Append immutable raw seabed entries (messages, artifacts, evidence, signals) from scripts/collectors.
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
  settle: `Risk: write
When to use: Create a deterministic distillation slice or cognitive card for a realm.
Usage:
  meru-mind settle --in <realm> --layer <layer> --period <key> [--narrative <text>] [--sources <a,b>]
Examples:
  meru-mind settle --in /ops --layer card_realm --period 2026-11-22
`,
  import: `Risk: write
When to use: Import Markdown or JSONL corpora and verify DB consistency against sources.
Usage:
  meru-mind import md <file-or-dir> [--in <realm>] [--map <mapping.json>] [--base-dir <dir>] [--source-ref <ref>] [--kind <kind>] [--sensitivity <level>] [--about <obj>]... [--include-secret] [--sync-embeddings] [--as-human]
  meru-mind import jsonl <file.jsonl> --map <mapping.json> [--in <realm>] [--sync-embeddings] [--as-human]
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
When to use: Initialize a store, sync pending embeddings, rebuild derived indexes/drive, or export a read-only slice.
Usage:
  meru-mind admin init [--org <name>] [--personal] [--policy open|tree]
  meru-mind admin sync-embeddings [--batch-size <n>] [--max-items <n>]
  meru-mind admin rebuild [--no-restore-drive]
  meru-mind admin export-slice [--in <realm>] --out <dir>
Examples:
  meru-mind admin init --org "Acme" --policy open
  meru-mind admin rebuild
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
    "object",
    "file",
    "rule",
    "raw",
    "redact",
    "settle",
    "import",
    "org",
    "admin",
  ]);
  if (!KNOWN_COMMANDS.has(cmd)) {
    throw new MindError("UNKNOWN_COMMAND", `Unknown command "${cmd}"`, {
      try: "meru-mind --help",
    });
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
      assertAllowedFlags(flags, ["depth", "objects", "no-objects", "limit"], "tree");
      const ctx = resolveSessionContext({ engine, flags });
      const includeObjects = flagBool(flags, "no-objects") ? false : true;
      const res = engine.sea.tree({
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        target: sub,
        depth: parseDepthFlag(flags),
        includeObjects,
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
      const inRef = requireFlag(flags, "in", "write");
      const targetRealm = resolveVisibleRealm({
        realms: ctx.realms,
        orgId: ctx.org.id,
        ref: inRef,
        scope: ctx.boundScope,
      });
      const rec = await writeEverydayConclusion({
        db: engine.db,
        ledger: engine.ledger,
        realms: ctx.realms,
        mounts: engine.db.listMounts(),
        scope: ctx.boundScope,
        actor,
        viewerRealmId: ctx.boundViewerRealmId,
        targetRealmId: targetRealm.id,
        title: requireFlag(flags, "title", "write"),
        body: requireFlag(flags, "body", "write"),
        kind: flagStr(flags, "kind"),
        about: flagMulti(multiFlags, "about"),
        supersedes: flagMulti(multiFlags, "supersedes"),
        because: flagMulti(multiFlags, "because"),
        occurredAt: parseOccurredAtFlag(flags),
        sensitivity: flagStr(flags, "sensitivity") as Sensitivity | undefined,
        explicitIdempotencyKey: flagStr(flags, "idempotency-key"),
        allowRedactedReingest: flagBool(flags, "as-human"),
      });
      output(rec, formatGenericMarkdown(`Written [${rec.kind}]`, rec));
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
      throw new MindError(
        "UNKNOWN_COMMAND",
        `Unknown admin subcommand "${sub ?? ""}"`,
        { try: "meru-mind admin --help" },
      );
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
          ["parent", "slug", "name"],
          "realm create",
        );
        const orgId = resolveAdminOrgId(engine, orgFlag);
        const parentRef = requireFlag(flags, "parent", "realm create");
        const parentId = resolveAdminRealmId(engine, parentRef, orgId);
        const res = engine.ledger.createRealm({
          actor,
          orgId,
          parentId,
          slug: requireFlag(flags, "slug", "realm create"),
          name: requireFlag(flags, "name", "realm create"),
        });
        output(res, formatGenericMarkdown("Realm Created", res));
        return;
      }
      if (sub === "list") {
        assertAllowedFlags(flags, ["limit"], "realm list");
        const ctx = resolveSessionContext({ engine, flags });
        const allVisible = engine.ledger.listRealms({
          orgId: ctx.org.id,
          viewerRealmId: ctx.boundViewerRealmId,
          scopeCeiling: ctx.boundScope,
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
        const inRef = requireFlag(flags, "in", "raw add");
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
        const filePath = flagStr(flags, "file");
        const blobContent = filePath ? fs.readFileSync(filePath) : undefined;
        const entry = await engine.ledger.captureSeabed({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmId: targetRealm.id,
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
        output(entry, formatGenericMarkdown("Raw Entry Added", entry));
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
          targetRealmRef: flagStr(flags, "in"),
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
          ["in", "map", "sync-embeddings"],
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
        const res = await engine.importer.importJsonl({
          actor,
          viewerRealmId: ctx.boundViewerRealmId,
          targetRealmRef: flagStr(flags, "in"),
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
        const res = engine.importer.verifyImportConsistency({
          viewerRealmId: ctx.boundViewerRealmId,
          sourcePath,
          mapping,
          baseDir: flagStr(flags, "base-dir"),
          targetRealmRef: flagStr(flags, "in"),
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
