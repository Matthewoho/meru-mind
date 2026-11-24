#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  assertAccess,
  createMindEngine,
  discoverWorkspaceRealmMarker,
  findRelatedActiveForEcho,
  MindError,
  resolveAccessScope,
  resolveRealmByPath,
  resolveVisibleRealm,
  resolveWriteTargetRealm,
  sanitizeRealmsForScope,
  toSurfaceError,
  writeEverydayConclusion,
  type AccessScope,
  type Actor,
  type AssetKind,
  type Organization,
  type Realm,
  type RealmMount,
} from "./index.js";
import { MERU_MIND_VERSION } from "./version.js";

function okResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errResult(
  err: unknown,
  ctx?: { boundRealmPath?: string; orgPolicy?: "open" | "tree" },
) {
  const payload = toSurfaceError(err, {
    surface: "mcp",
    boundRealmPath: ctx?.boundRealmPath,
    orgPolicy: ctx?.orgPolicy,
  });
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export interface MindMcpServerOptions {
  homeDir?: string;
  orgId?: string;
  viewerRealmId?: string;
  actorId?: string;
  actorFamily?: string;
  /** Optional validated workspace marker ref discovered strictly at stdio process entry */
  workspaceMarkerRef?: string | null;
  /** Optional marker discovery error deferred to routed writes (reads unaffected) */
  workspaceMarkerError?: unknown;
}

export async function createMindMcpServer(options?: MindMcpServerOptions) {
  const engine = await createMindEngine({
    homeDir: options?.homeDir,
  });

  const envOrgId = options?.orgId ?? process.env.MERU_MIND_ORG_ID?.trim();
  const envViewerRaw =
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
  let boundSource: string;

  try {
    // Auto-bootstrap default personal org on empty home when no explicit org/viewer was pinned
    if (engine.ledger.listOrgs().length === 0 && !envOrgId && !envViewerRaw) {
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
    } else if (envViewerRaw && !envViewerRaw.startsWith("/")) {
      const vr = engine.db.getRealm(envViewerRaw);
      if (!vr) {
        throw new MindError(
          "NOT_FOUND",
          `Bound MERU_MIND_VIEWER_REALM_ID not found: ${envViewerRaw}`,
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
          "NOT_BOUND",
          "MERU_MIND_ORG_ID (or MERU_MIND_VIEWER_REALM_ID) is required when multiple organizations exist",
          {
            try: "MERU_MIND_ORG_ID=<orgId> MERU_MIND_VIEWER_REALM_ID=/team/project meru-mind whoami",
          },
        );
      }
    }

    boundOrgId = boundOrg.id;

    if (envViewerRaw) {
      const orgRealms = engine.db.listRealms(boundOrgId);
      const vr = envViewerRaw.startsWith("/")
        ? resolveRealmByPath(orgRealms, envViewerRaw)
        : engine.db.getRealm(envViewerRaw);
      if (!vr) {
        throw new MindError(
          "NOT_FOUND",
          `Bound MERU_MIND_VIEWER_REALM_ID not found: ${envViewerRaw}`,
        );
      }
      if (vr.orgId !== boundOrgId) {
        throw new MindError(
          "ACCESS_DENIED",
          `Bound MERU_MIND_VIEWER_REALM_ID "${envViewerRaw}" does not belong to bound org "${boundOrgId}"`,
        );
      }
      boundViewerRealmId = vr.id;
      boundSource = options?.viewerRealmId
        ? "options.viewerRealmId"
        : "MERU_MIND_VIEWER_REALM_ID";
    } else if (boundOrg.policy === "tree") {
      throw new MindError(
        "NOT_BOUND",
        `MERU_MIND_VIEWER_REALM_ID is required for 'tree' policy organization "${boundOrgId}"`,
        {
          try: "MERU_MIND_VIEWER_REALM_ID=/team/project meru-mind whoami",
        },
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
      boundSource = "open-default:/";
    }
  } catch (err) {
    await engine.close();
    throw err;
  }

  interface CallContext {
    org: Organization;
    realms: Realm[];
    mounts: RealmMount[];
    boundScope: AccessScope;
    boundRealmPath: string;
  }

  let cachedErrorCtx: { boundRealmPath?: string; orgPolicy?: "open" | "tree" } =
    {};

  const resolveCallContext = (includeDescendantSeabed = false): CallContext => {
    const org = engine.db.getOrg(boundOrgId);
    if (!org) {
      throw new MindError(
        "NOT_FOUND",
        `Bound organization missing: ${boundOrgId}`,
      );
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
    const sanitizedRealms = sanitizeRealmsForScope(realms, boundScope);
    const boundRealmPath =
      sanitizedRealms.get(boundViewerRealmId)?.path ?? "/";
    cachedErrorCtx = { boundRealmPath, orgPolicy: org.policy };
    return { org, realms, mounts, boundScope, boundRealmPath };
  };

  const resolveWriteTargetRealmId = (
    ctx: CallContext,
    inRef: string,
  ): string => {
    const trimmed = inRef.trim();
    if (!trimmed) {
      throw new MindError(
        "INVALID_REF",
        'Parameter "in" cannot be blank when provided (omit "in" to auto-route, or pass "/ops" / realm ID)',
      );
    }
    if (
      trimmed.startsWith("/") ||
      trimmed.toLowerCase().startsWith("@mounted/")
    ) {
      try {
        return resolveVisibleRealm({
          realms: ctx.realms,
          orgId: boundOrgId,
          ref: trimmed,
          scope: ctx.boundScope,
        }).id;
      } catch {
        throw new MindError(
          "ACCESS_DENIED",
          `Target realm "${trimmed}" is outside bound scope`,
        );
      }
    }
    return trimmed;
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
    version: MERU_MIND_VERSION,
  });

  // ---- Strictly 7 Everyday Tools (1:1 Mirror of Everyday CLI Verbs) ----

  server.tool(
    "mind_whoami",
    "[read] Show bound org, actor, realm scope, visible corpus counts, latestSeq, and next step.",
    {},
    async () => {
      try {
        const ctx = resolveCallContext(false);
        return okResult(
          engine.sea.whoami({
            actor: boundActor,
            viewerRealmId: boundViewerRealmId,
            boundSource,
            storePath: engine.homeDir,
            scopeCeiling: ctx.boundScope,
          }),
        );
      } catch (err) {
        return errResult(err, cachedErrorCtx);
      }
    },
  );

  server.tool(
    "mind_tree",
    "[read] Browse visible realm & object tree with counts. Printed refs work verbatim in mind_ls and mind_show.",
    {
      ref: z.string().optional(),
      depth: z
        .union([z.number().int().nonnegative(), z.literal("all")])
        .optional(),
      objects: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(false);
        return okResult(
          engine.sea.tree({
            actor: boundActor,
            viewerRealmId: boundViewerRealmId,
            target: args.ref,
            depth: args.depth,
            includeObjects: args.objects,
            limit: args.limit,
            scopeCeiling: ctx.boundScope,
          }),
        );
      } catch (err) {
        return errResult(err, cachedErrorCtx);
      }
    },
  );

  server.tool(
    "mind_ls",
    "[read] List visible contents of a realm (/path, @mounted/<alias>) or entries about an object (kind:name, /realm/kind:name).",
    {
      ref: z.string().optional(),
      only: z.enum(["realms", "objects", "entries", "files"]).optional(),
      kind: z.string().optional(),
      about: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      history: z.boolean().optional(),
      include_descendant_seabed: z.boolean().optional(),
      limit: z.number().int().positive().max(200).optional(),
      cursor: z.string().optional(),
    },
    async (args) => {
      try {
        const includeDescendantSeabed = Boolean(args.include_descendant_seabed);
        const ctx = resolveCallContext(includeDescendantSeabed);
        return okResult(
          await engine.sea.ls({
            actor: boundActor,
            viewerRealmId: boundViewerRealmId,
            ref: args.ref,
            only: args.only,
            kind: args.kind,
            about: args.about,
            since: args.since,
            until: args.until,
            history: args.history,
            includeDescendantSeabed,
            limit: args.limit,
            cursor: args.cursor,
            scopeCeiling: ctx.boundScope,
          }),
        );
      } catch (err) {
        return errResult(err, cachedErrorCtx);
      }
    },
  );

  server.tool(
    "mind_show",
    "[read] Inspect any ref: /realm (brief), kind:name (object card), rec_/sea_ (bounded window + optional history/context), or file:/realm/path.",
    {
      ref: z.string(),
      around: z.string().optional(),
      cursor: z.string().optional(),
      chars: z.number().int().positive().max(200000).optional(),
      full: z.boolean().optional(),
      history: z.boolean().optional(),
      context: z.number().int().nonnegative().max(100).optional(),
      include_descendant_seabed: z.boolean().optional(),
    },
    async (args) => {
      try {
        const includeDescendantSeabed = Boolean(args.include_descendant_seabed);
        const ctx = resolveCallContext(includeDescendantSeabed);
        return okResult(
          await engine.sea.show({
            actor: boundActor,
            viewerRealmId: boundViewerRealmId,
            ref: args.ref,
            around: args.around,
            cursor: args.cursor,
            chars: args.chars,
            full: args.full,
            history: args.history,
            context: args.context,
            includeDescendantSeabed,
            scopeCeiling: ctx.boundScope,
          }),
        );
      } catch (err) {
        return errResult(err, cachedErrorCtx);
      }
    },
  );

  server.tool(
    "mind_search",
    "[read] Search visible memory (FTS5 + vector). Optional in (/realm) narrows scope; about (kind:name) filters by object.",
    {
      query: z.string(),
      in: z.string().optional(),
      about: z.string().optional(),
      kind: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      history: z.boolean().optional(),
      include_descendant_seabed: z.boolean().optional(),
      limit: z.number().int().positive().max(200).optional(),
      cursor: z.string().optional(),
    },
    async (args) => {
      try {
        const includeDescendantSeabed = Boolean(args.include_descendant_seabed);
        const ctx = resolveCallContext(includeDescendantSeabed);
        return okResult(
          await engine.sea.search({
            actor: boundActor,
            viewerRealmId: boundViewerRealmId,
            query: args.query,
            in: args.in,
            about: args.about,
            kind: args.kind,
            since: args.since,
            until: args.until,
            history: args.history,
            includeDescendantSeabed,
            limit: args.limit,
            cursor: args.cursor,
            scopeCeiling: ctx.boundScope,
          }),
        );
      } catch (err) {
        return errResult(err, cachedErrorCtx);
      }
    },
  );

  server.tool(
    "mind_changes",
    "[read] Read incremental visible change log after since seq. Optional in (/realm) filters changes in SQL.",
    {
      since: z.number().int().nonnegative().optional(),
      in: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
      include_descendant_seabed: z.boolean().optional(),
    },
    async (args) => {
      try {
        const includeDescendantSeabed = Boolean(args.include_descendant_seabed);
        const ctx = resolveCallContext(includeDescendantSeabed);
        return okResult(
          engine.sea.changes({
            actor: boundActor,
            viewerRealmId: boundViewerRealmId,
            in: args.in,
            sinceSeq: args.since ?? 0,
            limit: args.limit ?? 50,
            includeDescendantSeabed,
            scopeCeiling: ctx.boundScope,
          }),
        );
      } catch (err) {
        return errResult(err, cachedErrorCtx);
      }
    },
  );

  server.tool(
    "mind_write",
    "[write] Record a conclusion (decision|finding|claim|proposal|verdict; rule forbidden). Optional in auto-routes via bound/marker/about->/inbox.",
    {
      in: z.string().optional(),
      title: z.string(),
      body: z.string(),
      kind: z.string().optional(),
      about: z.array(z.string()).optional(),
      supersedes: z.array(z.string()).optional(),
      because: z.array(z.string()).optional(),
      occurred_at: z.string().nullable().optional(),
      sensitivity: z
        .enum(["public", "internal", "confidential", "secret"])
        .optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(false);
        const isExplicitlyBound =
          boundSource === "MERU_MIND_VIEWER_REALM_ID" ||
          boundSource === "options.viewerRealmId";
        let targetRealmId: string;
        let targetRealmPath: string;
        let routedBy: "explicit" | "bound" | "workspace_marker" | "about" | "inbox";
        let writeRealms = ctx.realms;
        let writeScope = ctx.boundScope;

        if (args.in !== undefined && args.in.trim() !== "") {
          targetRealmId = resolveWriteTargetRealmId(ctx, args.in);
          assertMcpWrite(ctx, targetRealmId, "ledger");
          const targetRealm = ctx.realms.find((r) => r.id === targetRealmId);
          targetRealmPath = targetRealm?.path ?? args.in.trim();
          routedBy = "explicit";
        } else {
          if (
            !isExplicitlyBound &&
            ctx.org.policy === "open" &&
            options?.workspaceMarkerError
          ) {
            throw options.workspaceMarkerError;
          }
          const routed = resolveWriteTargetRealm({
            db: engine.db,
            ledger: engine.ledger,
            realms: ctx.realms,
            mounts: ctx.mounts,
            scope: ctx.boundScope,
            orgId: boundOrgId,
            orgPolicy: ctx.org.policy,
            actor: boundActor,
            viewerRealmId: boundViewerRealmId,
            isExplicitlyBound,
            explicitIn: undefined,
            workspaceMarkerRef: options?.workspaceMarkerRef ?? null,
            about: args.about,
          });
          targetRealmId = routed.realm.id;
          targetRealmPath = routed.realm.path;
          routedBy = routed.routedBy;
          writeRealms = routed.realms;
          if (routedBy === "inbox") {
            writeScope = resolveAccessScope({
              realms: writeRealms,
              mounts: ctx.mounts,
              viewerRealmId: boundViewerRealmId,
              orgPolicy: ctx.org.policy,
              includeDescendantSeabed: false,
            });
          }
          assertMcpWrite(
            { ...ctx, realms: writeRealms, boundScope: writeScope },
            targetRealmId,
            "ledger",
          );
        }

        const rec = await writeEverydayConclusion({
          db: engine.db,
          ledger: engine.ledger,
          realms: writeRealms,
          mounts: ctx.mounts,
          scope: writeScope,
          actor: boundActor,
          viewerRealmId: boundViewerRealmId,
          targetRealmId,
          title: args.title,
          body: args.body,
          kind: args.kind,
          about: args.about,
          supersedes: args.supersedes,
          because: args.because,
          occurredAt: args.occurred_at,
          sensitivity: args.sensitivity,
          allowRedactedReingest: false,
        });
        const relatedActive = await findRelatedActiveForEcho({
          sea: engine.sea,
          actor: boundActor,
          viewerRealmId: boundViewerRealmId,
          newRecord: rec,
          scopeCeiling: writeScope,
        });
        return okResult({
          ...rec,
          realmPath: targetRealmPath,
          routedBy,
          ...(relatedActive.length > 0 ? { relatedActive } : {}),
        });
      } catch (err) {
        return errResult(err, cachedErrorCtx);
      }
    },
  );

  return { server, engine, boundOrgId, boundViewerRealmId, boundActor };
}

async function runStdio(): Promise<void> {
  let workspaceMarkerRef: string | null = null;
  let workspaceMarkerError: unknown = null;
  try {
    workspaceMarkerRef =
      discoverWorkspaceRealmMarker(process.cwd())?.ref ?? null;
  } catch (err) {
    workspaceMarkerError = err;
  }
  const { server, engine } = await createMindMcpServer({
    workspaceMarkerRef,
    workspaceMarkerError,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isDirectEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(fileURLToPath(import.meta.url)) ===
      fs.realpathSync(process.argv[1])
    );
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
})();

if (isDirectEntry) {
  runStdio().catch((err: unknown) => {
    process.stderr.write(
      `meru-mind-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
