#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createMindEngine, MindError, type Actor } from "./index.js";

function toActor(input: {
  actorId?: string;
  actorKind?: "human" | "agent" | "system";
  actorFamily?: string;
}): Actor {
  return {
    id: input.actorId ?? process.env.MERU_MIND_ACTOR_ID ?? "mcp-agent",
    kind: input.actorKind ?? "agent",
    ...(input.actorFamily ? { family: input.actorFamily } : {}),
  };
}

function okResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errResult(err: unknown) {
  const payload =
    err instanceof MindError
      ? { error: err.code, message: err.message, details: err.details }
      : {
          error: "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : String(err),
        };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export async function createMindMcpServer(options?: {
  homeDir?: string;
  driveMode?: "local" | "layerfs";
}) {
  const engine = await createMindEngine({
    homeDir: options?.homeDir,
    driveMode:
      options?.driveMode ??
      ((process.env.MERU_MIND_DRIVE as "local" | "layerfs" | undefined) ??
        "local"),
  });

  // Auto-bootstrap default personal org on empty home so fresh MCP clients can start immediately
  if (engine.ledger.listOrgs().length === 0) {
    engine.ledger.createOrg({ name: "Personal", isPersonalRoot: true });
  }

  const server = new McpServer({
    name: "meru-mind",
    version: "0.1.0",
  });

  server.tool(
    "mind_list_realms",
    "List organizations and MindRealm hierarchy.",
    {
      orgId: z.string().optional(),
    },
    async ({ orgId }) => {
      try {
        return okResult({
          orgs: engine.ledger.listOrgs(),
          realms: engine.ledger.listRealms(orgId),
          mounts: engine.ledger.listMounts(),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_create_realm",
    "Create a child MindRealm under an existing parent realm.",
    {
      orgId: z.string(),
      parentId: z.string(),
      slug: z.string(),
      name: z.string(),
    },
    async (args) => {
      try {
        return okResult(engine.ledger.createRealm(args));
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_mount_realm",
    "Explicitly mount a target realm as read-only into a viewer realm.",
    {
      viewerRealmId: z.string(),
      targetRealmId: z.string(),
      scope: z.enum(["all", "ledger", "drive"]).optional(),
      actorId: z.string().optional(),
      actorKind: z.enum(["human", "agent", "system"]).optional(),
    },
    async (args) => {
      try {
        return okResult(
          engine.ledger.mountRealm({
            actor: toActor(args),
            viewerRealmId: args.viewerRealmId,
            targetRealmId: args.targetRealmId,
            scope: args.scope,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_brief",
    "Get a budgeted MindSea boot brief for a MindRealm, including mandatory omitted counts.",
    {
      viewerRealmId: z.string(),
      actorId: z.string().optional(),
      actorKind: z.enum(["human", "agent", "system"]).optional(),
      recentMessages: z.number().int().positive().optional(),
      maxDecisions: z.number().int().positive().optional(),
      maxActiveThings: z.number().int().positive().optional(),
    },
    async (args) => {
      try {
        return okResult(
          engine.sea.brief({
            actor: toActor(args),
            viewerRealmId: args.viewerRealmId,
            budget: {
              recentMessages: args.recentMessages,
              maxDecisions: args.maxDecisions,
              maxActiveThings: args.maxActiveThings,
            },
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_recall",
    "4-stage scoped recall (ID -> structured filters -> FTS5 -> sqlite-vec RRF). Enforces MindRealm visibility.",
    {
      viewerRealmId: z.string(),
      query: z.string().optional(),
      id: z.string().optional(),
      thingId: z.string().optional(),
      targetRealmId: z.string().optional(),
      recordKinds: z
        .array(
          z.enum([
            "thing",
            "claim",
            "proposal",
            "verdict",
            "finding",
            "decision",
            "rule",
          ]),
        )
        .optional(),
      seabedKinds: z
        .array(z.enum(["message", "artifact", "evidence", "signal"]))
        .optional(),
      authorId: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      includeSuperseded: z.boolean().optional(),
      includeDescendantSeabed: z.boolean().optional(),
      limit: z.number().int().positive().max(200).optional(),
      offset: z.number().int().nonnegative().optional(),
      actorId: z.string().optional(),
      actorKind: z.enum(["human", "agent", "system"]).optional(),
    },
    async (args) => {
      try {
        return okResult(
          await engine.sea.recall({
            actor: toActor(args),
            viewerRealmId: args.viewerRealmId,
            query: args.query,
            id: args.id,
            thingId: args.thingId,
            targetRealmId: args.targetRealmId,
            recordKinds: args.recordKinds,
            seabedKinds: args.seabedKinds,
            authorId: args.authorId,
            since: args.since,
            until: args.until,
            includeSuperseded: args.includeSuperseded,
            includeDescendantSeabed: args.includeDescendantSeabed,
            limit: args.limit,
            offset: args.offset,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_capture_seabed",
    "Append an immutable seabed entry (message, artifact, evidence, or signal) to the viewer realm.",
    {
      viewerRealmId: z.string(),
      kind: z.enum(["message", "artifact", "evidence", "signal"]),
      text: z.string(),
      topicId: z.string().optional(),
      sourceRef: z.string().optional(),
      actorId: z.string().optional(),
      actorKind: z.enum(["human", "agent", "system"]).optional(),
      actorFamily: z.string().optional(),
    },
    async (args) => {
      try {
        return okResult(
          await engine.ledger.captureSeabed({
            actor: toActor(args),
            viewerRealmId: args.viewerRealmId,
            kind: args.kind,
            text: args.text,
            topicId: args.topicId,
            sourceRef: args.sourceRef,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_append_record",
    "Append a ledger record (thing, claim, proposal, verdict, finding, decision, rule) with invariant checks.",
    {
      viewerRealmId: z.string(),
      kind: z.enum([
        "thing",
        "claim",
        "proposal",
        "verdict",
        "finding",
        "decision",
        "rule",
      ]),
      title: z.string(),
      payload: z.record(z.unknown()).optional(),
      refs: z.array(z.string()).optional(),
      supersedesId: z.string().optional(),
      thingId: z.string().optional(),
      actorId: z.string().optional(),
      actorKind: z.enum(["human", "agent", "system"]).optional(),
      actorFamily: z.string().optional(),
    },
    async (args) => {
      try {
        return okResult(
          await engine.ledger.appendRecord({
            actor: toActor(args),
            viewerRealmId: args.viewerRealmId,
            kind: args.kind,
            title: args.title,
            payload: args.payload,
            refs: args.refs,
            supersedesId: args.supersedesId,
            thingId: args.thingId,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_drive_write",
    "Write a file to the MindRealm shared drive with optimistic concurrency conflict detection.",
    {
      viewerRealmId: z.string(),
      relPath: z.string(),
      content: z.string(),
      expectedVersion: z.number().int().nonnegative().optional(),
      message: z.string().optional(),
      actorId: z.string().optional(),
      actorKind: z.enum(["human", "agent", "system"]).optional(),
    },
    async (args) => {
      try {
        return okResult(
          await engine.ledger.writeDriveFile({
            actor: toActor(args),
            viewerRealmId: args.viewerRealmId,
            relPath: args.relPath,
            content: args.content,
            expectedVersion: args.expectedVersion,
            message: args.message,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_drive_read",
    "Read a file from a visible MindRealm drive.",
    {
      viewerRealmId: z.string(),
      targetRealmId: z.string().optional(),
      relPath: z.string(),
      actorId: z.string().optional(),
      actorKind: z.enum(["human", "agent", "system"]).optional(),
    },
    async (args) => {
      try {
        return okResult(
          await engine.ledger.readDriveFile({
            actor: toActor(args),
            viewerRealmId: args.viewerRealmId,
            targetRealmId: args.targetRealmId,
            relPath: args.relPath,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_settle",
    "Settle current realm state into a MindSea distillation (event slice or cognitive card) with deterministic hard facts.",
    {
      viewerRealmId: z.string(),
      layer: z.enum([
        "slice_shift",
        "slice_day",
        "slice_week",
        "slice_month",
        "card_realm",
        "card_person",
        "card_progress",
      ]),
      periodKey: z.string(),
      narrativeMd: z.string().optional(),
      sourceIds: z.array(z.string()).optional(),
      actorId: z.string().optional(),
      actorKind: z.enum(["human", "agent", "system"]).optional(),
    },
    async (args) => {
      try {
        return okResult(
          await engine.sea.settle({
            actor: toActor(args),
            viewerRealmId: args.viewerRealmId,
            layer: args.layer,
            periodKey: args.periodKey,
            narrativeMd: args.narrativeMd,
            sourceIds: args.sourceIds,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_export_slice",
    "Export a strictly scoped read-only MindRealm slice directory for shallow-integrated agents.",
    {
      viewerRealmId: z.string(),
      outDir: z.string(),
      actorId: z.string().optional(),
      actorKind: z.enum(["human", "agent", "system"]).optional(),
    },
    async (args) => {
      try {
        return okResult(
          await engine.slice.exportSlice({
            actor: toActor(args),
            viewerRealmId: args.viewerRealmId,
            outDir: args.outDir,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_drive_list",
    "List files in a visible MindRealm shared drive.",
    {
      viewerRealmId: z.string(),
      targetRealmId: z.string().optional(),
      actorId: z.string().optional(),
      actorKind: z.enum(["human", "agent", "system"]).optional(),
    },
    async (args) => {
      try {
        return okResult(
          await engine.ledger.listDriveFiles({
            actor: toActor(args),
            viewerRealmId: args.viewerRealmId,
            targetRealmId: args.targetRealmId,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_unmount_realm",
    "Remove a read-only mount between viewer and target realm.",
    {
      viewerRealmId: z.string(),
      targetRealmId: z.string(),
    },
    async (args) => {
      try {
        return okResult({
          removed: engine.ledger.unmountRealm(
            args.viewerRealmId,
            args.targetRealmId,
          ),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_get_supersede_chain",
    "Traverse the chronological supersede chain for a visible ledger record.",
    {
      viewerRealmId: z.string(),
      recordId: z.string(),
      actorId: z.string().optional(),
      actorKind: z.enum(["human", "agent", "system"]).optional(),
    },
    async (args) => {
      try {
        return okResult(
          engine.ledger.getSupersedeChain({
            actor: toActor(args),
            viewerRealmId: args.viewerRealmId,
            recordId: args.recordId,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_rebuild",
    "Rebuild derived FTS5, sqlite-vec, and Drive snapshots from canonical SQLite + Blob truth.",
    {
      restoreDrive: z.boolean().optional(),
    },
    async ({ restoreDrive }) => {
      try {
        return okResult(await engine.sea.rebuild({ restoreDrive }));
      } catch (err) {
        return errResult(err);
      }
    },
  );

  return { server, engine };
}

function isExecutedDirectly(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return (
      fs.realpathSync(argv1) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

// Start stdio transport when executed directly (including via bin symlinks like meru-mind-mcp)
if (isExecutedDirectly()) {
  createMindMcpServer()
    .then(async ({ server, engine }) => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      const shutdown = async () => {
        await engine.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      process.stderr.write(
        `meru-mind-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
