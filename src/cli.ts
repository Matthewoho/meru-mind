#!/usr/bin/env node
import fs from "node:fs";
import {
  createMindEngine,
  MindError,
  type Actor,
  type ActorKind,
  type DistillationLayer,
  type MountScope,
  type RecordKind,
  type SeabedKind,
} from "./index.js";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "personal",
  "include-superseded",
  "include-descendant-seabed",
  "no-restore-drive",
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
    throw new MindError("INVALID_INPUT", `Flag --${key} must be an integer, got "${raw}"`);
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

function buildActor(flags: Record<string, string | boolean>): Actor {
  const id = flagStr(flags, "actor") ?? "user";
  const kind = (flagStr(flags, "actor-kind") ?? "human") as ActorKind;
  if (kind !== "human" && kind !== "agent" && kind !== "system") {
    throw new MindError("INVALID_INPUT", `Invalid --actor-kind: ${kind}`);
  }
  const family = flagStr(flags, "family");
  return { id, kind, ...(family ? { family } : {}) };
}

function printUsage(): void {
  const help = `meru-mind — Scoped visibility (MindRealm) & layered memory/ledger engine (MindSea)

Global flags:
  --home <dir>              Data directory (default: MERU_MIND_HOME or ~/.meru-mind)
  --drive <local|layerfs>   Drive adapter (default: local)
  --actor <id>              Actor ID (default: user)
  --actor-kind <kind>       human | agent | system (default: human)
  --family <name>           Model family for agent actors (e.g. claude, gemini, deepseek)
  --json                    Print JSON output

Commands:
  init [--org <name>] [--personal]
  org create --name <name> [--personal]
  org list
  realm create --org <orgId> --parent <realmId> --slug <slug> --name <name>
  realm list [--org <orgId>]
  mount --viewer <realmId> --target <realmId> [--scope all|ledger|drive]
  unmount --viewer <realmId> --target <realmId>
  capture --realm <realmId> --kind message|artifact|evidence|signal --text <text> [--topic <id>] [--file <path>]
  record --realm <realmId> --kind thing|claim|proposal|verdict|finding|decision|rule --title <title> [--payload <json>] [--refs <a,b>] [--supersedes <id>] [--thing <id>]
  drive write --realm <realmId> --path <relPath> (--content <text> | --file <path>) [--expected-version <n>] [--message <msg>]
  drive read --viewer <realmId> [--target <realmId>] --path <relPath>
  drive list --viewer <realmId> [--target <realmId>]
  brief --realm <realmId> [--limit <n>]
  recall --realm <realmId> [--query <text>] [--id <id>] [--thing <id>] [--target <realmId>] [--include-superseded] [--include-descendant-seabed] [--limit <n>]
  settle --realm <realmId> --layer <layer> --period <key> [--narrative <text>] [--sources <a,b>]
  export-slice --realm <realmId> --out <dir>
  rebuild [--no-restore-drive]
`;
  process.stdout.write(help);
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub] = positionals;

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

  const output = (data: unknown) => {
    process.stdout.write(`${JSON.stringify(data, null, asJson ? 0 : 2)}\n`);
  };

  try {
    if (cmd === "init") {
      const existing = engine.ledger.listOrgs();
      if (existing.length > 0) {
        const realms = engine.ledger.listRealms(existing[0]!.id);
        output({
          initialized: false,
          homeDir: engine.homeDir,
          org: existing[0],
          rootRealm: realms[0] ?? null,
        });
        return;
      }
      const created = engine.ledger.createOrg({
        name: flagStr(flags, "org") ?? "Personal",
        isPersonalRoot: !flags["personal"] ? true : flagBool(flags, "personal"),
      });
      output({ initialized: true, homeDir: engine.homeDir, ...created });
      return;
    }

    if (cmd === "org") {
      if (sub === "create") {
        output(
          engine.ledger.createOrg({
            name: requireFlag(flags, "name"),
            isPersonalRoot: flagBool(flags, "personal"),
          }),
        );
        return;
      }
      if (sub === "list") {
        output(engine.ledger.listOrgs());
        return;
      }
      throw new MindError("INVALID_INPUT", `Unknown org subcommand: ${sub ?? ""}`);
    }

    if (cmd === "realm") {
      if (sub === "create") {
        output(
          engine.ledger.createRealm({
            orgId: requireFlag(flags, "org"),
            parentId: requireFlag(flags, "parent"),
            slug: requireFlag(flags, "slug"),
            name: requireFlag(flags, "name"),
          }),
        );
        return;
      }
      if (sub === "list") {
        output(engine.ledger.listRealms(flagStr(flags, "org")));
        return;
      }
      throw new MindError("INVALID_INPUT", `Unknown realm subcommand: ${sub ?? ""}`);
    }

    if (cmd === "mount") {
      output(
        engine.ledger.mountRealm({
          actor,
          viewerRealmId: requireFlag(flags, "viewer"),
          targetRealmId: requireFlag(flags, "target"),
          scope: (flagStr(flags, "scope") as MountScope | undefined) ?? "all",
        }),
      );
      return;
    }

    if (cmd === "unmount") {
      output({
        removed: engine.ledger.unmountRealm(
          requireFlag(flags, "viewer"),
          requireFlag(flags, "target"),
        ),
      });
      return;
    }

    if (cmd === "capture") {
      const filePath = flagStr(flags, "file");
      const blobContent = filePath ? fs.readFileSync(filePath) : undefined;
      output(
        await engine.ledger.captureSeabed({
          actor,
          viewerRealmId: requireFlag(flags, "realm"),
          kind: requireFlag(flags, "kind") as SeabedKind,
          text: flagStr(flags, "text") ?? "",
          topicId: flagStr(flags, "topic"),
          blobContent,
          sourceRef: flagStr(flags, "source-ref"),
        }),
      );
      return;
    }

    if (cmd === "record") {
      const payloadRaw = flagStr(flags, "payload");
      let payload: Record<string, unknown> = {};
      if (payloadRaw !== undefined) {
        try {
          const parsed = JSON.parse(payloadRaw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("payload must be a JSON object");
          }
          payload = parsed as Record<string, unknown>;
        } catch (err) {
          throw new MindError(
            "INVALID_INPUT",
            `Invalid --payload JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const refsRaw = flagStr(flags, "refs");
      const refs = refsRaw
        ? refsRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      output(
        await engine.ledger.appendRecord({
          actor,
          viewerRealmId: requireFlag(flags, "realm"),
          kind: requireFlag(flags, "kind") as RecordKind,
          title: requireFlag(flags, "title"),
          payload,
          refs,
          supersedesId: flagStr(flags, "supersedes"),
          thingId: flagStr(flags, "thing"),
        }),
      );
      return;
    }

    if (cmd === "drive") {
      if (sub === "write") {
        const filePath = flagStr(flags, "file");
        const content = filePath
          ? fs.readFileSync(filePath, "utf8")
          : requireFlag(flags, "content");
        const expectedVersion = parseIntFlag(flags, "expected-version", { min: 0 });
        output(
          await engine.ledger.writeDriveFile({
            actor,
            viewerRealmId: requireFlag(flags, "realm"),
            relPath: requireFlag(flags, "path"),
            content,
            expectedVersion,
            message: flagStr(flags, "message"),
          }),
        );
        return;
      }
      if (sub === "read") {
        const viewer = requireFlag(flags, "viewer");
        output(
          await engine.ledger.readDriveFile({
            actor,
            viewerRealmId: viewer,
            targetRealmId: flagStr(flags, "target") ?? viewer,
            relPath: requireFlag(flags, "path"),
          }),
        );
        return;
      }
      if (sub === "list") {
        const viewer = requireFlag(flags, "viewer");
        output(
          await engine.ledger.listDriveFiles({
            actor,
            viewerRealmId: viewer,
            targetRealmId: flagStr(flags, "target") ?? viewer,
          }),
        );
        return;
      }
      throw new MindError("INVALID_INPUT", `Unknown drive subcommand: ${sub ?? ""}`);
    }

    if (cmd === "brief") {
      const n = parseIntFlag(flags, "limit", { min: 1 });
      output(
        engine.sea.brief({
          actor,
          viewerRealmId: requireFlag(flags, "realm"),
          budget: n
            ? {
                recentMessages: n,
                maxQuestions: n,
                maxActiveThings: n,
                maxDecisions: n,
              }
            : undefined,
        }),
      );
      return;
    }

    if (cmd === "recall") {
      const limit = parseIntFlag(flags, "limit", { min: 1 });
      output(
        await engine.sea.recall({
          actor,
          viewerRealmId: requireFlag(flags, "realm"),
          query: flagStr(flags, "query"),
          id: flagStr(flags, "id"),
          thingId: flagStr(flags, "thing"),
          targetRealmId: flagStr(flags, "target"),
          includeSuperseded: flagBool(flags, "include-superseded"),
          includeDescendantSeabed: flagBool(flags, "include-descendant-seabed"),
          limit,
        }),
      );
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
      output(
        await engine.sea.settle({
          actor,
          viewerRealmId: requireFlag(flags, "realm"),
          layer: requireFlag(flags, "layer") as DistillationLayer,
          periodKey: requireFlag(flags, "period"),
          narrativeMd: flagStr(flags, "narrative"),
          sourceIds,
        }),
      );
      return;
    }

    if (cmd === "export-slice") {
      output(
        await engine.slice.exportSlice({
          actor,
          viewerRealmId: requireFlag(flags, "realm"),
          outDir: requireFlag(flags, "out"),
        }),
      );
      return;
    }

    if (cmd === "rebuild") {
      output(
        await engine.sea.rebuild({
          restoreDrive: !flagBool(flags, "no-restore-drive"),
        }),
      );
      return;
    }

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
