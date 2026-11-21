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
  resolveRealmByPath,
  resolveVisibleRealm,
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
          "INVALID_INPUT",
          "MERU_MIND_ORG_ID (or MERU_MIND_VIEWER_REALM_ID) is required when multiple organizations exist",
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
   * Resolves a realm reference (path `/ops`, `@mounted/<alias>`, OR realm ID) inside bound scope.
   */
  const resolveFocusRealm = (
    realms: Realm[],
    boundScope: AccessScope,
    orgPolicy: Organization["policy"],
    focusRef?: string,
  ): string => {
    const trimmed = focusRef?.trim();
    if (!trimmed) return boundViewerRealmId;
    try {
      const found = resolveVisibleRealm({
        realms,
        orgId: boundOrgId,
        ref: trimmed,
        scope: boundScope,
      });
      if (
        orgPolicy === "tree" &&
        !boundScope.readableLedgerIds.includes(found.id)
      ) {
        throw new MindError(
          "ACCESS_DENIED",
          `Focus realm "${trimmed}" is outside bound viewer scope "${boundViewerRealmId}"`,
        );
      }
      return found.id;
    } catch (err) {
      if (err instanceof MindError && err.code === "NOT_FOUND") {
        throw new MindError(
          "ACCESS_DENIED",
          `Focus realm "${trimmed}" is outside bound scope "${boundViewerRealmId}"`,
        );
      }
      throw err;
    }
  };

  /**
   * Computes effective visibility as `scope(focus) ∩ scope(boundViewer)`:
   * - Accepts realm path OR ID for `focus`
   * - Never crosses boundOrgId (in either open or tree mode)
   * - Never widens past boundViewerRealmId (blocks child @mounts and child seabed bypasses)
   */
  const resolveCallContext = (
    focusRef?: string,
    includeDescendantSeabed = false,
  ): CallContext => {
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

    const effectiveViewerId = resolveFocusRealm(
      realms,
      boundScope,
      org.policy,
      focusRef,
    );

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

  /**
   * Resolves a realm target (path OR ID) for write tools strictly against boundOrgId/boundScope.
   */
  const resolveWriteTargetRealmId = (
    ctx: CallContext,
    targetRef?: string,
  ): string => {
    const trimmed = targetRef?.trim();
    if (!trimmed) return boundViewerRealmId;
    if (trimmed.startsWith("/") || trimmed.toLowerCase().startsWith("@mounted/")) {
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

  /**
   * Resolves an optional read target realm (path OR ID) within effectiveScope.
   */
  const resolveOptionalReadTargetRealmId = (
    ctx: CallContext,
    targetRef?: string,
  ): string | undefined => {
    const trimmed = targetRef?.trim();
    if (!trimmed) return undefined;
    return resolveVisibleRealm({
      realms: ctx.realms,
      orgId: boundOrgId,
      ref: trimmed,
      scope: ctx.effectiveScope,
    }).id;
  };

  /**
   * Resolves a drive read/list target realm (path OR ID). Paths resolve via
   * visible-only realm lookup (opaque NOT_FOUND on hidden paths); explicit IDs
   * are passed through to ledger access enforcement (ACCESS_DENIED).
   */
  const resolveDriveReadTargetRealmId = (
    ctx: CallContext,
    targetRef?: string,
  ): string => {
    const trimmed = targetRef?.trim();
    if (!trimmed) return ctx.effectiveViewerId;
    const normalized = trimmed.startsWith("realm:")
      ? trimmed.slice("realm:".length)
      : trimmed;
    if (
      normalized.startsWith("/") ||
      normalized.toLowerCase().startsWith("@mounted/")
    ) {
      return resolveVisibleRealm({
        realms: ctx.realms,
        orgId: boundOrgId,
        ref: normalized,
        scope: ctx.effectiveScope,
      }).id;
    }
    return normalized;
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

  // ---- Read Tools (Unified `target` + `focus` accepting path OR ID) ----

  server.tool(
    "mind_list_realms",
    "List visible MindRealms (hidden ancestors rewritten to @mounted/<alias>) and mounts within session-bound scope. Optional focus (path or ID) narrows in tree mode.",
    {
      focus: z.string().optional(),
    },
    async ({ focus }) => {
      try {
        const ctx = resolveCallContext(focus, false);
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
    "Read budgeted realm summary (rules, kindHistogram, recentConclusions, pending questions, active things, recent raw, bounded childSummaries). target/focus accept /path, @mounted/<alias>, or realm ID.",
    {
      target: z.string().optional(),
      focus: z.string().optional(),
      recentMessages: z.number().int().positive().optional(),
      maxDecisions: z.number().int().positive().optional(),
      maxActiveThings: z.number().int().positive().optional(),
      maxRecentConclusions: z.number().int().positive().optional(),
      maxChildSummaries: z.number().int().positive().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.focus, false);
        return okResult(
          engine.sea.brief({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            target: args.target,
            scopeCeiling: ctx.effectiveScope,
            budget: {
              recentMessages: args.recentMessages,
              maxDecisions: args.maxDecisions,
              maxActiveThings: args.maxActiveThings,
              maxRecentConclusions: args.maxRecentConclusions,
              maxChildSummaries: args.maxChildSummaries,
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
    "Ranked search (ID -> filters -> FTS5 + vector -> lexicographic rank) returning copy-pasteable rec_.../sea_... handles. target restricts to one realm (/path or ID); focus narrows in tree mode (opt-in focusBoost tie-breaks in open mode).",
    {
      query: z.string().optional(),
      id: z.string().optional(),
      thingId: z.string().optional(),
      target: z.string().optional(),
      focus: z.string().optional(),
      focusBoost: z.boolean().optional(),
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
          args.focus,
          Boolean(args.includeDescendantSeabed),
        );
        const targetRealmId = resolveOptionalReadTargetRealmId(
          ctx,
          args.target,
        );
        return okResult(
          await engine.sea.recall({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            scopeCeiling: ctx.effectiveScope,
            query: args.query,
            id: args.id,
            thingId: args.thingId,
            targetRealmId,
            focusBoost: args.focusBoost,
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

  // ---- Write Tools (Always bound to boundViewerRealmId; NEVER accept focus/viewer overrides) ----

  server.tool(
    "mind_capture_seabed",
    "[DEPRECATED: alias for mind_write_raw; scheduled for removal in v0.3.0] Append an immutable raw entry within bound write scope.",
    {
      target: z.string().optional(),
      kind: z.enum(["message", "artifact", "evidence", "signal"]),
      text: z.string(),
      topicId: z.string().optional(),
      sourceRef: z.string().optional(),
      objectIds: z.array(z.string()).optional(),
      resourceTags: z.array(z.string()).optional(),
      occurredAt: z.string().nullable().optional(),
      sensitivity: z
        .enum(["public", "internal", "confidential", "secret"])
        .optional(),
      idempotencyKey: z.string().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(undefined, false);
        const targetRealmId = resolveWriteTargetRealmId(ctx, args.target);
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
            objectIds: args.objectIds,
            resourceTags: args.resourceTags,
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
    "mind_write_raw",
    "Append an immutable [raw] entry (message, artifact, evidence, or signal) within bound write scope.",
    {
      target: z.string().optional(),
      kind: z.enum(["message", "artifact", "evidence", "signal"]),
      text: z.string(),
      topicId: z.string().optional(),
      sourceRef: z.string().optional(),
      objectIds: z.array(z.string()).optional(),
      resourceTags: z.array(z.string()).optional(),
      occurredAt: z.string().nullable().optional(),
      sensitivity: z
        .enum(["public", "internal", "confidential", "secret"])
        .optional(),
      idempotencyKey: z.string().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(undefined, false);
        const targetRealmId = resolveWriteTargetRealmId(ctx, args.target);
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
            objectIds: args.objectIds,
            resourceTags: args.resourceTags,
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
    "[DEPRECATED: alias for mind_write_conclusion; scheduled for removal in v0.3.0] Append a non-rule [conclusion] ledger record within bound write scope.",
    {
      target: z.string().optional(),
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
      externalRef: z.string().optional(),
      sourceRef: z.string().optional(),
      objectIds: z.array(z.string()).optional(),
      resourceTags: z.array(z.string()).optional(),
      supersedesId: z.string().optional(),
      supersedesIds: z.array(z.string()).optional(),
      thingId: z.string().optional(),
      occurredAt: z.string().nullable().optional(),
      sensitivity: z
        .enum(["public", "internal", "confidential", "secret"])
        .optional(),
      idempotencyKey: z.string().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(undefined, false);
        const targetRealmId = resolveWriteTargetRealmId(ctx, args.target);
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
            externalRef: args.externalRef,
            sourceRef: args.sourceRef,
            objectIds: args.objectIds,
            resourceTags: args.resourceTags,
            supersedesId: args.supersedesId,
            supersedesIds: args.supersedesIds,
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
    "mind_write_conclusion",
    "Append a non-rule [conclusion] record (thing, claim, proposal, verdict, finding, decision) within bound write scope.",
    {
      target: z.string().optional(),
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
      externalRef: z.string().optional(),
      sourceRef: z.string().optional(),
      objectIds: z.array(z.string()).optional(),
      resourceTags: z.array(z.string()).optional(),
      supersedesId: z.string().optional(),
      supersedesIds: z.array(z.string()).optional(),
      thingId: z.string().optional(),
      occurredAt: z.string().nullable().optional(),
      sensitivity: z
        .enum(["public", "internal", "confidential", "secret"])
        .optional(),
      idempotencyKey: z.string().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(undefined, false);
        const targetRealmId = resolveWriteTargetRealmId(ctx, args.target);
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
            externalRef: args.externalRef,
            sourceRef: args.sourceRef,
            objectIds: args.objectIds,
            resourceTags: args.resourceTags,
            supersedesId: args.supersedesId,
            supersedesIds: args.supersedesIds,
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
      target: z.string().optional(),
      relPath: z.string(),
      content: z.string(),
      expectedVersion: z.number().int().nonnegative().optional(),
      message: z.string().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(undefined, false);
        const targetRealmId = resolveWriteTargetRealmId(ctx, args.target);
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
      target: z.string().optional(),
      focus: z.string().optional(),
      relPath: z.string(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.focus, false);
        const targetRealmId = resolveDriveReadTargetRealmId(ctx, args.target);
        return okResult(
          await engine.ledger.readDriveFile({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            targetRealmId,
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
      target: z.string().optional(),
      focus: z.string().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.focus, false);
        const targetRealmId = resolveDriveReadTargetRealmId(ctx, args.target);
        return okResult(
          await engine.ledger.listDriveFiles({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            targetRealmId,
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
      target: z.string().optional(),
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
        const ctx = resolveCallContext(undefined, false);
        const targetRealmId = resolveWriteTargetRealmId(ctx, args.target);
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
    "Traverse the chronological supersede DAG for a visible ledger record within bound scope.",
    {
      focus: z.string().optional(),
      recordId: z.string(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.focus, false);
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

  server.tool(
    "mind_tree",
    "Explore visible MindRealms and Objects as a tree with direct/subtree counts (default depth=1, unreadable raw=null). target/focus accept /path, @mounted/<alias>, or realm ID.",
    {
      target: z.string().optional(),
      focus: z.string().optional(),
      depth: z.union([z.number().int().nonnegative(), z.literal("all")]).optional(),
      includeObjects: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.focus, false);
        return okResult(
          engine.sea.tree({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            target: args.target,
            depth: args.depth,
            includeObjects: args.includeObjects,
            limit: args.limit,
            scopeCeiling: ctx.effectiveScope,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_ls",
    "List visible non-secret entries with explicit target prefixes (/path, @mounted/<alias>, realm:<id>, obj:<id|name>, thing:<ref>, tag:<type:name>). Optional kind/tag filters, pagination, and focus (/path or ID).",
    {
      target: z.string().optional(),
      targetType: z.enum(["realm", "object", "thing", "resource"]).optional(),
      focus: z.string().optional(),
      kind: z.string().optional(),
      tag: z.string().optional(),
      includeSuperseded: z.boolean().optional(),
      includeDescendantSeabed: z.boolean().optional(),
      limit: z.number().int().positive().max(200).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(
          args.focus,
          Boolean(args.includeDescendantSeabed),
        );
        return okResult(
          await engine.sea.ls({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            target: args.target,
            targetType: args.targetType,
            kind: args.kind,
            tag: args.tag,
            includeSuperseded: args.includeSuperseded,
            includeDescendantSeabed: args.includeDescendantSeabed,
            limit: args.limit,
            offset: args.offset,
            scopeCeiling: ctx.effectiveScope,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_cat",
    "Inspect full content of one visible entry (rec_..., sea_..., dist_...) or drive relPath (pass targetRealm as /path or ID). Optional focus narrows read perspective.",
    {
      target: z.string(),
      targetRealm: z.string().optional(),
      focus: z.string().optional(),
      includeDescendantSeabed: z.boolean().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(
          args.focus,
          Boolean(args.includeDescendantSeabed),
        );
        return okResult(
          await engine.sea.cat({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            target: args.target,
            targetRealmRef: args.targetRealm,
            includeDescendantSeabed: args.includeDescendantSeabed,
            scopeCeiling: ctx.effectiveScope,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_replay",
    "Replay surrounding timeline context entries (occurred_at with created_at fallback for undated anchors) and supersede DAG within bound scope.",
    {
      entryId: z.string(),
      focus: z.string().optional(),
      window: z.number().int().positive().max(100).optional(),
      includeDescendantSeabed: z.boolean().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(
          args.focus,
          Boolean(args.includeDescendantSeabed),
        );
        return okResult(
          engine.sea.replay({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            entryId: args.entryId,
            window: args.window,
            includeDescendantSeabed: args.includeDescendantSeabed,
            scopeCeiling: ctx.effectiveScope,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_changes",
    "Read operational change_log entries since a sequence number, filtered to visible non-secret scope.",
    {
      target: z.string().optional(),
      focus: z.string().optional(),
      sinceSeq: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
      includeDescendantSeabed: z.boolean().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(
          args.focus,
          Boolean(args.includeDescendantSeabed),
        );
        return okResult(
          engine.sea.changes({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            target: args.target,
            sinceSeq: args.sinceSeq,
            limit: args.limit,
            includeDescendantSeabed: args.includeDescendantSeabed,
            scopeCeiling: ctx.effectiveScope,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_list_objects",
    "List visible single-parent object nodes (hidden parents sanitized to null) within bound scope.",
    {
      target: z.string().optional(),
      focus: z.string().optional(),
      parentObjectId: z.string().optional(),
      kind: z.string().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.focus, false);
        return okResult(
          engine.objects.listObjects({
            viewerRealmId: ctx.effectiveViewerId,
            realmRef: args.target,
            parentObjectId: args.parentObjectId,
            kind: args.kind,
            scopeCeiling: ctx.effectiveScope,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_list_tags",
    "List visible <type>:<name> resource tags (excluding secret/redacted entries) within bound scope.",
    {
      target: z.string().optional(),
      focus: z.string().optional(),
      prefix: z.string().optional(),
      includeDescendantSeabed: z.boolean().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(
          args.focus,
          Boolean(args.includeDescendantSeabed),
        );
        return okResult(
          engine.objects.listResourceTags({
            viewerRealmId: ctx.effectiveViewerId,
            realmRef: args.target,
            prefix: args.prefix,
            includeDescendantSeabed: args.includeDescendantSeabed,
            scopeCeiling: ctx.effectiveScope,
          }),
        );
      } catch (err) {
        return errResult(err);
      }
    },
  );

  server.tool(
    "mind_list_things",
    "List visible thing identity anchors (records.kind='thing') optionally filtered by externalRef.",
    {
      target: z.string().optional(),
      focus: z.string().optional(),
      externalRef: z.string().optional(),
      includeSuperseded: z.boolean().optional(),
      limit: z.number().int().positive().max(200).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async (args) => {
      try {
        const ctx = resolveCallContext(args.focus, false);
        return okResult(
          engine.ledger.listThings({
            actor: boundActor,
            viewerRealmId: ctx.effectiveViewerId,
            targetRealmRef: args.target,
            externalRef: args.externalRef,
            includeSuperseded: args.includeSuperseded,
            limit: args.limit,
            offset: args.offset,
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
