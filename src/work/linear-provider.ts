import { MindError } from "../types.js";
import {
  formatDefaultAnnotateComment,
  resolveEnvSecretRef,
  type AnnotateNote,
  type ProviderCtx,
  type StatusType,
  type WorkItemSnapshot,
  type WorkLocator,
  type WorkProvider,
  type WorkRef,
  type WorkResolveOutcome,
} from "./provider.js";

export interface LinearProviderOptions {
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const LINEAR_WORK_REF_RE = /^work:linear:([A-Za-z0-9_-]+)$/i;
const LINEAR_KEY_RE = /^([A-Z][A-Z0-9]{1,9}-\d+)$/;
const LINEAR_URL_RE = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]{1,9}-\d+)(?:\/.*)?$/i;

function mapLinearStateType(raw: string | undefined): StatusType {
  switch ((raw ?? "").toLowerCase()) {
    case "triage":
      return "triage";
    case "backlog":
      return "backlog";
    case "unstarted":
      return "unstarted";
    case "started":
      return "started";
    case "completed":
      return "completed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "unstarted";
  }
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  trashed?: boolean;
  team?: { id: string; key: string };
  state?: { name: string; type: string };
  assignee?: { id: string; name: string } | null;
  relations?: { nodes?: Array<{ type: string; relatedIssue?: { state?: { type: string } } }> };
}

function isIssueInBindingScope(
  issue: LinearIssueNode,
  binding: Readonly<Record<string, unknown>>,
): boolean {
  const boundTeamId = typeof binding.teamId === "string" ? binding.teamId.trim() : "";
  const boundTeamKey = typeof binding.teamKey === "string" ? binding.teamKey.trim().toUpperCase() : "";
  if (boundTeamId && issue.team?.id !== boundTeamId) return false;
  if (boundTeamKey && (issue.team?.key ?? "").toUpperCase() !== boundTeamKey) return false;
  return true;
}

function toSnapshot(issue: LinearIssueNode, fetchedAt: string): WorkItemSnapshot {
  return {
    ref: `work:linear:${issue.id}`,
    displayId: issue.identifier,
    title: issue.title,
    statusType: mapLinearStateType(issue.state?.type),
    statusName: issue.state?.name ?? "Unknown",
    ...(issue.assignee
      ? {
          assignee: {
            externalId: issue.assignee.id,
            displayName: issue.assignee.name,
          },
        }
      : {}),
    url: issue.url,
    fetchedAt,
    native: {
      teamId: issue.team?.id,
      teamKey: issue.team?.key,
    },
  };
}

/**
 * Official in-process Linear WorkProvider (v0.5).
 * Reads live state via Linear GraphQL API using `binding.apiKeyRef` (`env:LINEAR_API_KEY`).
 * Enforces strict team binding scope (`outOfScope: true`) so an org-wide API key cannot read unbound private teams.
 */
export class LinearWorkProvider implements WorkProvider {
  readonly id = "linear" as const;
  readonly capabilities = { ready: true, annotate: true } as const;

  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: LinearProviderOptions = {}) {
    this.apiUrl = options.apiUrl ?? "https://api.linear.app/graphql";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.env = options.env ?? process.env;
  }

  parseLocator(input: string): WorkLocator | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const refMatch = LINEAR_WORK_REF_RE.exec(trimmed);
    if (refMatch) {
      return { provider: "linear", kind: "id", value: refMatch[1]! };
    }
    const urlMatch = LINEAR_URL_RE.exec(trimmed);
    if (urlMatch) {
      return {
        provider: "linear",
        kind: "url",
        value: urlMatch[1]!.toUpperCase(),
      };
    }
    const keyMatch = LINEAR_KEY_RE.exec(trimmed);
    if (keyMatch) {
      return { provider: "linear", kind: "key", value: keyMatch[1]! };
    }
    return null;
  }

  private async gql<T>(
    apiKey: string,
    query: string,
    variables: Record<string, unknown>,
    deadlineMs: number,
  ): Promise<T> {
    const remaining = Math.max(100, deadlineMs - Date.now());
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    try {
      const res = await this.fetchImpl(this.apiUrl, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new MindError("INVALID_INPUT", `Linear API HTTP ${res.status}`);
      }
      const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (json.errors?.length) {
        throw new MindError("INVALID_INPUT", `Linear API error: ${json.errors[0]!.message}`);
      }
      return json.data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async resolve(
    items: Array<WorkRef | WorkLocator>,
    binding: Readonly<Record<string, unknown>>,
    ctx: ProviderCtx,
  ): Promise<WorkResolveOutcome[]> {
    const apiKey = resolveEnvSecretRef(
      binding.apiKeyRef ?? "env:LINEAR_API_KEY",
      this.env,
    );
    const fetchedAt = new Date().toISOString();
    const results: WorkResolveOutcome[] = [];

    for (const item of items) {
      const loc: WorkLocator | null =
        typeof item === "string" ? this.parseLocator(item) : item;
      const rawInput = typeof item === "string" ? item : item.value;
      if (!loc || loc.provider !== "linear") {
        results.push({ input: rawInput, gone: true });
        continue;
      }

      const data = await this.gql<{ issue?: LinearIssueNode | null }>(
        apiKey,
        `query ResolveIssue($id: String!) {
          issue(id: $id) {
            id identifier title url trashed
            team { id key }
            state { name type }
            assignee { id name }
          }
        }`,
        { id: loc.value },
        ctx.deadlineMs,
      );

      const issue = data?.issue;
      if (!issue || issue.trashed) {
        results.push({ input: rawInput, gone: true });
        continue;
      }
      if (!isIssueInBindingScope(issue, binding)) {
        results.push({ input: rawInput, outOfScope: true });
        continue;
      }
      results.push(toSnapshot(issue, fetchedAt));
    }

    return results;
  }

  async listReady(
    binding: Readonly<Record<string, unknown>>,
    page: { limit: number; cursor?: string },
    ctx: ProviderCtx,
  ): Promise<{ items: WorkItemSnapshot[]; nextCursor?: string }> {
    const apiKey = resolveEnvSecretRef(
      binding.apiKeyRef ?? "env:LINEAR_API_KEY",
      this.env,
    );
    const teamKey = typeof binding.teamKey === "string" ? binding.teamKey.trim() : undefined;
    const teamId = typeof binding.teamId === "string" ? binding.teamId.trim() : undefined;
    const limit = Math.max(1, Math.min(page.limit, 100));
    const fetchedAt = new Date().toISOString();

    const data = await this.gql<{
      issues?: {
        nodes?: LinearIssueNode[];
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    }>(
      apiKey,
      `query ListReadyIssues($first: Int!, $after: String, $teamKey: String, $teamId: ID) {
        issues(
          first: $first
          after: $after
          filter: {
            team: { key: { eq: $teamKey }, id: { eq: $teamId } }
            state: { type: { in: ["unstarted", "backlog"] } }
          }
        ) {
          nodes {
            id identifier title url trashed
            team { id key }
            state { name type }
            assignee { id name }
            relations { nodes { type relatedIssue { state { type } } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      {
        first: limit,
        after: page.cursor ?? null,
        teamKey: teamKey ?? null,
        teamId: teamId ?? null,
      },
      ctx.deadlineMs,
    );

    const nodes = data?.issues?.nodes ?? [];
    const readyItems: WorkItemSnapshot[] = [];
    for (const issue of nodes) {
      if (issue.trashed) continue;
      if (!isIssueInBindingScope(issue, binding)) continue;
      const blocked = (issue.relations?.nodes ?? []).some(
        (rel) =>
          rel.type === "blocked_by" &&
          rel.relatedIssue?.state?.type !== "completed" &&
          rel.relatedIssue?.state?.type !== "canceled",
      );
      if (!blocked) {
        readyItems.push(toSnapshot(issue, fetchedAt));
      }
    }

    const pageInfo = data?.issues?.pageInfo;
    return {
      items: readyItems,
      ...(pageInfo?.hasNextPage && pageInfo.endCursor
        ? { nextCursor: pageInfo.endCursor }
        : {}),
    };
  }

  async annotate(
    ref: WorkRef,
    note: AnnotateNote,
    binding: Readonly<Record<string, unknown>>,
    ctx: ProviderCtx,
  ): Promise<{ externalId: string }> {
    const loc = this.parseLocator(ref);
    if (!loc || loc.provider !== "linear") {
      throw new MindError("INVALID_REF", `Invalid Linear WorkRef: "${ref}"`);
    }
    const apiKey = resolveEnvSecretRef(
      binding.apiKeyRef ?? "env:LINEAR_API_KEY",
      this.env,
    );

    // Check scope + idempotency marker before creating a comment
    const existing = await this.gql<{
      issue?: (LinearIssueNode & {
        comments?: { nodes?: Array<{ id: string; body: string }> };
      }) | null;
    }>(
      apiKey,
      `query CheckAnnotate($id: String!) {
        issue(id: $id) {
          id identifier title url trashed
          team { id key }
          comments(first: 50) { nodes { id body } }
        }
      }`,
      { id: loc.value },
      ctx.deadlineMs,
    );
    const issue = existing?.issue;
    if (!issue || issue.trashed) {
      throw new MindError("NOT_FOUND", `Linear issue not found: ${ref}`);
    }
    if (!isIssueInBindingScope(issue, binding)) {
      throw new MindError(
        "ACCESS_DENIED",
        `Linear issue "${ref}" is outside the bound team scope`,
      );
    }

    const marker = `<!-- meru-idempotency:${note.idempotencyKey} -->`;
    const dup = (issue.comments?.nodes ?? []).find((c) =>
      c.body.includes(marker),
    );
    if (dup) {
      return { externalId: dup.id };
    }

    const body = formatDefaultAnnotateComment(note);
    const created = await this.gql<{
      commentCreate?: { success: boolean; comment?: { id: string } };
    }>(
      apiKey,
      `mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id }
        }
      }`,
      { issueId: issue.id, body },
      ctx.deadlineMs,
    );
    const commentId = created?.commentCreate?.comment?.id;
    if (!commentId) {
      throw new MindError("INVALID_INPUT", "Linear commentCreate did not return an ID");
    }
    return { externalId: commentId };
  }
}
