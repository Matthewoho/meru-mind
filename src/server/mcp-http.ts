import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toSurfaceError } from "../format/errors.js";
import type { MindSurface } from "../surface.js";

function okResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errResult(err: unknown) {
  const payload = toSurfaceError(err, { surface: "mcp" });
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

/**
 * Registers strictly the 7 everyday MCP tools against any `MindSurface`.
 * Used by Streamable HTTP MCP (`/mcp` in `meru-mind serve`) so HTTP MCP and CLI/REST
 * share the exact same `MindSurface` + `Principal` choke point with zero behavior drift.
 */
export function createSurfaceMcpServer(surface: MindSurface): McpServer {
  const server = new McpServer({
    name: "meru-mind",
    version: "0.3.0",
  });

  server.tool(
    "mind_whoami",
    "[read] Show bound org, actor, realm scope, visible corpus counts, latestSeq, and next step.",
    {},
    async () => {
      try {
        return okResult(await surface.whoami());
      } catch (err) {
        return errResult(err);
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
        return okResult(
          await surface.tree({
            ref: args.ref,
            depth: args.depth,
            includeObjects: args.objects,
            limit: args.limit,
          }),
        );
      } catch (err) {
        return errResult(err);
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
        return okResult(
          await surface.ls({
            ref: args.ref,
            only: args.only,
            kind: args.kind,
            about: args.about,
            since: args.since,
            until: args.until,
            history: args.history,
            includeDescendantSeabed: args.include_descendant_seabed,
            limit: args.limit,
            cursor: args.cursor,
          }),
        );
      } catch (err) {
        return errResult(err);
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
        return okResult(
          await surface.show({
            ref: args.ref,
            around: args.around,
            cursor: args.cursor,
            chars: args.chars,
            full: args.full,
            history: args.history,
            context: args.context,
            includeDescendantSeabed: args.include_descendant_seabed,
          }),
        );
      } catch (err) {
        return errResult(err);
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
        return okResult(
          await surface.search({
            query: args.query,
            in: args.in,
            about: args.about,
            kind: args.kind,
            since: args.since,
            until: args.until,
            history: args.history,
            includeDescendantSeabed: args.include_descendant_seabed,
            limit: args.limit,
            cursor: args.cursor,
          }),
        );
      } catch (err) {
        return errResult(err);
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
        return okResult(
          await surface.changes({
            sinceSeq: args.since ?? 0,
            in: args.in,
            limit: args.limit ?? 50,
            includeDescendantSeabed: args.include_descendant_seabed,
          }),
        );
      } catch (err) {
        return errResult(err);
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
      idempotency_key: z.string().optional(),
    },
    async (args) => {
      try {
        const res = await surface.write({
          in: args.in,
          title: args.title,
          body: args.body,
          kind: args.kind,
          about: args.about,
          supersedes: args.supersedes,
          because: args.because,
          occurredAt: args.occurred_at,
          sensitivity: args.sensitivity,
          idempotencyKey: args.idempotency_key,
        });
        return okResult({
          ...res.record,
          routedBy: res.routedBy,
          ...(res.relatedActive ? { relatedActive: res.relatedActive } : {}),
          ...(res.collisionHints ? { collisionHints: res.collisionHints } : {}),
        });
      } catch (err) {
        return errResult(err);
      }
    },
  );

  return server;
}
