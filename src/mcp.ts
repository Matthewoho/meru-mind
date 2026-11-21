#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  assertAccess,
  createMindEngine,
  intersectAccessScopes,
  MindError,
  resolveAccessScope,
  type AccessScope,
  type Actor,
  type AssetKind,
  type Organization,
  type Realm,
  type RealmMount,
} from "./index.js";

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

export interface MindMcpServerOptions {
  homeDir?: string;
  driveMode?: "local" | "layerfs";
  orgId?: string;
  viewerRealmId?: string;
  actorId?: string;
  actorFamily?: string;
}

export async function createMindMcpServer(options?: MindMcpServerOptions) {
  const engine = await createMindEngine({
    homeDir: options?.homeDir,
    driveMode:
      options?.driveMode ??
      ((process.env.MERU_MIND_DRIVE as "local" | "layerfs" | undefined) ??
        "local"),
  });

  const envOrgId = options?.orgId ?? process.env.MERU_MIND_ORG_ID?.trim();
  const envViewerRealmId =
    options?.viewerRealmId ?? process.env.MERU_MIND_VIEWER_REALM_ID?.trim();
  const boundActorId =
    options?.actorId ?? process.env.MERU_MIND_ACTOR_ID?.trim() ?? "mcp-agent";
  const boundActorFamily =
    options?.actorFamily ?? process.env.MERU_MIND_ACTOR_FAMILY?.trim();

  // MCP processes are ALWAYS bound to actor.kind = "agent" (never human)
  const boundActor: Actor = {
    id: boundActorId,
    kind: "agent",
    ...(boundActorFamily ? { family: boundActorFamily } : {}),
  };

  let boundOrgId: string;
  let boundViewerRealmId: string;

  try {
    // Auto-bootstrap default personal org on empty home when no explicit org/viewer was pinned
    if (engine.ledger.listOrgs().length === 0 && !envOrgId && !envViewerRealmId) {
      engine.ledger.createOrg({ name: "Personal", isPersonalRoot: true });
    }

    let boundOrg: Organization | null = null;
    if (envOrgId) {
      boundOrg = engine.db.getOrg(envOrgId);
      if (!boundOrg) {
        throw new MindError(
          "NOT_FOUND",
          `Bound MERU_MIND_ORG_ID not found: ${envOrgId}`,
        );
      }
    } else if (envViewerRealmId) {
      const vr = engine.db.getRealm(envViewerRealmId);
      if (!vr) {
        throw new MindError(
          "NOT_FOUND",
          `Bound MERU_MIND_VIEWER_REALM_ID not found: ${envViewerRealmId}`,
        );
      }
      boundOrg = engine.db.getOrg(vr.orgId);
      if (!boundOrg) {
        throw new MindError(
          "NOT_FOUND",
          `Organization not found for bound viewer realm: ${vr.orgId}`,
        );
      }
    } else {
      const orgs = engine.ledger.listOrgs();
      if (orgs.length === 1) {
        boundOrg = orgs[0]!;
      } else {
        throw new MindError(
          "INVALID_INPUT",
          "MERU_MIND_ORG_ID (or MERU_MIND_VIEWER_REALM_ID) is required when multiple organizations exist",
        );
      }
    }

    boundOrgId = boundOrg.id;

    if (envViewerRealmId) {
      const vr = engine.db.getRealm(envViewerRealmId);
      if (!vr) {
        throw new MindError(
          "NOT_FOUND",
          `Bound MERU_MIND_VIEWER_REALM_ID not found: ${envViewerRealmId}`,
        );
      }
      if (vr.orgId !== boundOrgId) {
        throw new MindError(
          "ACCESS_DENIED",
          `Bound MERU_MIND_VIEWER_REALM_ID "${envViewerRealmId}" does not belong to bound org "${boundOrgId}"`,
        );
      }
      boundViewerRealmId = vr.id;
    } else if (boundOrg.policy === "tree") {
      throw new MindError(
        "INVALID_INPUT",
        `MERU_MIND_VIEWER_REALM_ID is required for 'tree' policy organization "${boundOrgId}"`,
      );
    } else {
      const rootRealm =
        engine.db.getRealmByPath(boundOrgId, "/") ??
        engine.db.listRealms(boundOrgId)[0];
      if (!rootRealm) {
        throw new MindError(
          "NOT_FOUND",
          `No realm found in bound organization "${boundOrgId}"`,
        );
      }
      boundViewerRealmId = rootRealm.id;
    }
  } catch (err) {
    await engine.close();
    throw err;
  }

  interface CallContext {
    org: Organization;
    realms: Realm[];
    mounts: RealmMount[];
    effectiveViewerId: string;
    boundScope: AccessScope;
    effectiveScope: AccessScope;
  }

  /**
   * Computes effective visibility as `scope(requestedViewer) ∩ scope(boundViewer)`:
   * - Never crosses boundOrgId (in either open or tree mode)
   * - Never widens past boundViewerRealmId (blocks child @mounts and child seabed bypasses)
   */
  const resolveCallContext = (
    requestedViewerRealmId?: string,
    includeDescendantSeabed = false,
  ): CallContext => {
    const org = engine.db.getOrg(boundOrgId);
    if (!org) {
      throw new MindError("NOT_FOUND", `Bound organization missing: ${boundOrgId}`);
    }
    const realms = engine.db.listRealms();
    const mounts = engine.db.listMounts();

    const boundScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: boundViewerRealmId,
      orgPolicy: org.policy,
      includeDescendantSeabed,
    });

    const effectiveViewerId = requestedViewerRealmId?.trim() || boundViewerRealmId;
    const reqRealm = realms.find((r) => r.id === effectiveViewerId);
    if (!reqRealm || reqRealm.orgId !== boundOrgId) {
      throw new MindError(
        "ACCESS_DENIED",
        `Viewer realm "${effectiveViewerId}" is outside bound organization "${boundOrgId}"`,
      );
    }

    if (
      org.policy === "tree" &&
      !boundScope.readableLedgerIds.includes(effectiveViewerId)
    ) {
      throw new MindError(
        "ACCESS_DENIED",
        `Viewer realm "${effectiveViewerId}" is outside bound viewer scope "${boundViewerRealmId}"`,
      );
    }

    const reqScope = resolveAccessScope({
      realms,
      mounts,
      viewerRealmId: effectiveViewerId,
      orgPolicy: org.policy,
      includeDescendantSeabed,
    });
    const effectiveScope = intersectAccessScopes(reqScope, boundScope);

    return {
      org,
      realms,
      mounts,
      effectiveViewerId,
      boundScope,
      effectiveScope,
    };
  };

  const assertMcpWrite = (
    ctx: CallContext,
    targetRealmId: string,
    assetKind: AssetKind,
  ): void => {
    const targetRealm = ctx.realms.find((r) => r.id === targetRealmId);
    if (!targetRealm || targetRealm.orgId !== boundOrgId) {
      throw new MindError(
        "ACCESS_DENIED",
        `Target realm "${targetRealmId}" is outside bound organization "${boundOrgId}"`,
      );
    }
    assertAccess({
      realms: ctx.realms,
      mounts: ctx.mounts,
      actor: boundActor,
      viewerRealmId: boundViewerRealmId,
      targetRealmId,
      assetKind,
      required: "write",
      orgPolicy: ctx.org.policy,
    });
  };

  const server = new McpServer({
    name: "meru-mind",
    version: "0.2.0",
  });

  server.tool(
    "mind_list_realms",
    "List visible MindRealms and mounts within the process-bound organization and viewer scope.",
    {
      viewerRealmId: z.string().optional(),
    },
    async ({ viewerRealmId }) => {
      try {
        const ctx = resolveCallContext(viewerRealmId, false);
        const realms = engine.ledger.listRealms({
          orgId: boundOrgId,
          viewerRealmId: ctx.effectiveViewerId,
          scopeCeiling: ctx.effectiveScope,
        });
        const mounts = engine.ledger.listMounts({
          orgId: boundOrgId,
          viewerRealmId: ctx.effectiveViewerId,
          scopeCeiling: ctx.effectiveScope,
        });
        return okResult({
          org: ctx.org,
          boundViewerRealmId,
          realms,
          mounts,
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_brief",
    "Get a budgeted MindSea boot brief for a MindRealm, bounded by process-level scope intersection.",
    {
      viewerRealmId: z.string().optional(),
      recentMessages: z.number().int().positive().optional(),
      maxDecisions: z.number().int().positive().optional(),
      maxActiveThings: z.number().int().positive().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.viewerRealmId, false);
        return okResult(
          engine.sea.brief({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            scopeCeiling: ctx.effectiveScope,
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
    "4-stage scoped recall (ID -> structured filters -> FTS5 -> sqlite-vec RRF). Enforces process-bound scope intersection.",
    {
      viewerRealmId: z.string().optional(),
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
      includeHistory: z.boolean().optional(),
      includeDescendantSeabed: z.boolean().optional(),
      limit: z.number().int().positive().max(200).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(
          args.viewerRealmId,
          Boolean(args.includeDescendantSeabed),
        );
        return okResult(
          await engine.sea.recall({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            scopeCeiling: ctx.effectiveScope,
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
            includeHistory: args.includeHistory,
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
    "Append an immutable seabed entry (message, artifact, evidence, or signal) within bound write scope.",
    {
      viewerRealmId: z.string().optional(),
      targetRealmId: z.string().optional(),
      kind: z.enum(["message", "artifact", "evidence", "signal"]),
      text: z.string(),
      topicId: z.string().optional(),
      sourceRef: z.string().optional(),
      occurredAt: z.string().optional(),
      sensitivity: z
        .enum(["public", "internal", "confidential", "secret"])
        .optional(),
      idempotencyKey: z.string().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.viewerRealmId, false);
        const targetRealmId = args.targetRealmId?.trim() || ctx.effectiveViewerId;
        assertMcpWrite(ctx, targetRealmId, "seabed");
        return okResult(
          await engine.ledger.captureSeabed({
            actor: boundActor,
            viewerRealmId: boundViewerRealmId,
            targetRealmId,
            kind: args.kind,
            text: args.text,
            topicId: args.topicId,
            sourceRef: args.sourceRef,
            occurredAt: args.occurredAt,
            sensitivity: args.sensitivity,
            idempotencyKey: args.idempotencyKey,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_append_record",
    "Append a non-rule ledger record (thing, claim, proposal, verdict, finding, decision) within bound write scope.",
    {
      viewerRealmId: z.string().optional(),
      targetRealmId: z.string().optional(),
      kind: z.enum([
        "thing",
        "claim",
        "proposal",
        "verdict",
        "finding",
        "decision",
      ]),
      extKind: z.string().optional(),
      title: z.string(),
      payload: z.record(z.unknown()).optional(),
      refs: z.array(z.string()).optional(),
      supersedesId: z.string().optional(),
      thingId: z.string().optional(),
      occurredAt: z.string().optional(),
      sensitivity: z
        .enum(["public", "internal", "confidential", "secret"])
        .optional(),
      idempotencyKey: z.string().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.viewerRealmId, false);
        const targetRealmId = args.targetRealmId?.trim() || ctx.effectiveViewerId;
        assertMcpWrite(ctx, targetRealmId, "ledger");
        return okResult(
          await engine.ledger.appendRecord({
            actor: boundActor,
            viewerRealmId: boundViewerRealmId,
            targetRealmId,
            kind: args.kind,
            extKind: args.extKind,
            title: args.title,
            payload: args.payload,
            refs: args.refs,
            supersedesId: args.supersedesId,
            thingId: args.thingId,
            occurredAt: args.occurredAt,
            sensitivity: args.sensitivity,
            idempotencyKey: args.idempotencyKey,
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
      viewerRealmId: z.string().optional(),
      targetRealmId: z.string().optional(),
      relPath: z.string(),
      content: z.string(),
      expectedVersion: z.number().int().nonnegative().optional(),
      message: z.string().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.viewerRealmId, false);
        const targetRealmId = args.targetRealmId?.trim() || ctx.effectiveViewerId;
        assertMcpWrite(ctx, targetRealmId, "drive");
        return okResult(
          await engine.ledger.writeDriveFile({
            actor: boundActor,
            viewerRealmId: boundViewerRealmId,
            targetRealmId,
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
    "Read a file from a MindRealm drive within process-bound scope intersection.",
    {
      viewerRealmId: z.string().optional(),
      targetRealmId: z.string().optional(),
      relPath: z.string(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.viewerRealmId, false);
        return okResult(
          await engine.ledger.readDriveFile({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            targetRealmId: args.targetRealmId,
            relPath: args.relPath,
            scopeCeiling: ctx.effectiveScope,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_drive_list",
    "List files in a MindRealm shared drive within process-bound scope intersection.",
    {
      viewerRealmId: z.string().optional(),
      targetRealmId: z.string().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.viewerRealmId, false);
        return okResult(
          await engine.ledger.listDriveFiles({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            targetRealmId: args.targetRealmId,
            scopeCeiling: ctx.effectiveScope,
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
      viewerRealmId: z.string().optional(),
      targetRealmId: z.string().optional(),
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
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.viewerRealmId, false);
        const targetRealmId = args.targetRealmId?.trim() || ctx.effectiveViewerId;
        assertMcpWrite(ctx, targetRealmId, "ledger");
        return okResult(
          await engine.sea.settle({
            actor: boundActor,
            viewerRealmId: boundViewerRealmId,
            targetRealmId,
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
    "mind_get_supersede_chain",
    "Traverse the chronological supersede chain for a visible ledger record within bound scope.",
    {
      viewerRealmId: z.string().optional(),
      recordId: z.string(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.viewerRealmId, false);
        return okResult(
          engine.ledger.getSupersedeChain({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            recordId: args.recordId,
            scopeCeiling: ctx.effectiveScope,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  return { server, engine, boundOrgId, boundViewerRealmId, boundActor };
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
