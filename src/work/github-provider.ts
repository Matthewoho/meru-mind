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

export interface GitHubProviderOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

const GH_WORK_REF_RE = /^work:github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/i;
const GH_QUALIFIED_KEY_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const GH_SHORT_KEY_RE = /^#(\d+)$/;
const GH_URL_RE = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)(?:[/?#].*)?$/i;

interface GitHubIssueDto {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason?: string | null;
  html_url: string;
  pull_request?: unknown;
  labels?: Array<{ name?: string } | string>;
  assignee?: { id?: number | string; login?: string } | null;
}

function mapGitHubStatus(issue: GitHubIssueDto): {
  statusType: StatusType;
  statusName: string;
} {
  if (issue.state === "closed") {
    if (issue.state_reason === "not_planned") {
      return { statusType: "canceled", statusName: "closed (not_planned)" };
    }
    return { statusType: "completed", statusName: "closed" };
  }
  const labels = (issue.labels ?? []).map((l) =>
    typeof l === "string" ? l.toLowerCase() : (l.name ?? "").toLowerCase(),
  );
  if (labels.includes("in-progress") || labels.includes("in progress")) {
    return { statusType: "started", statusName: "open (in-progress)" };
  }
  if (labels.includes("triage")) {
    return { statusType: "triage", statusName: "open (triage)" };
  }
  return { statusType: "unstarted", statusName: "open" };
}

function toSnapshot(
  owner: string,
  repo: string,
  issue: GitHubIssueDto,
  fetchedAt: string,
): WorkItemSnapshot {
  const mapped = mapGitHubStatus(issue);
  return {
    ref: `work:github:${owner}/${repo}#${issue.number}`,
    displayId: `${owner}/${repo}#${issue.number}`,
    title: issue.title,
    statusType: mapped.statusType,
    statusName: mapped.statusName,
    ...(issue.assignee?.login
      ? {
          assignee: {
            externalId: String(issue.assignee.id ?? issue.assignee.login),
            displayName: issue.assignee.login,
          },
        }
      : {}),
    url: issue.html_url,
    fetchedAt,
    native: {
      owner,
      repo,
      number: issue.number,
      labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    },
  };
}

/**
 * Official in-process GitHub Issues WorkProvider (v0.5 — second provider stress-testing WorkProvider contract).
 * Reads live issue state via GitHub REST API using `binding.tokenRef` (`env:GITHUB_TOKEN`).
 * Enforces strict `(binding.owner, binding.repo)` scope (`outOfScope: true` for issues from any other repo).
 */
export class GitHubWorkProvider implements WorkProvider {
  readonly id = "github" as const;
  readonly capabilities = { ready: true, annotate: true } as const;

  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: GitHubProviderOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.env = options.env ?? process.env;
  }

  parseLocator(input: string): WorkLocator | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const refM = GH_WORK_REF_RE.exec(trimmed);
    if (refM) {
      return {
        provider: "github",
        kind: "id",
        value: `${refM[1]!}/${refM[2]!}#${refM[3]!}`,
      };
    }
    const urlM = GH_URL_RE.exec(trimmed);
    if (urlM) {
      return {
        provider: "github",
        kind: "url",
        value: `${urlM[1]!}/${urlM[2]!}#${urlM[3]!}`,
      };
    }
    const qualM = GH_QUALIFIED_KEY_RE.exec(trimmed);
    if (qualM) {
      return {
        provider: "github",
        kind: "key",
        value: `${qualM[1]!}/${qualM[2]!}#${qualM[3]!}`,
      };
    }
    const shortM = GH_SHORT_KEY_RE.exec(trimmed);
    if (shortM) {
      return { provider: "github", kind: "key", value: `#${shortM[1]!}` };
    }
    return null;
  }

  private parseTarget(
    loc: WorkLocator,
    binding: Readonly<Record<string, unknown>>,
  ): { owner: string; repo: string; number: number; inScope: boolean } {
    const boundOwner = typeof binding.owner === "string" ? binding.owner.trim() : "";
    const boundRepo = typeof binding.repo === "string" ? binding.repo.trim() : "";

    const shortM = GH_SHORT_KEY_RE.exec(loc.value);
    if (shortM) {
      if (!boundOwner || !boundRepo) {
        return { owner: "", repo: "", number: Number(shortM[1]), inScope: false };
      }
      return {
        owner: boundOwner,
        repo: boundRepo,
        number: Number.parseInt(shortM[1]!, 10),
        inScope: true,
      };
    }

    const fullM = GH_QUALIFIED_KEY_RE.exec(loc.value);
    if (!fullM) {
      return { owner: "", repo: "", number: 0, inScope: false };
    }
    const owner = fullM[1]!;
    const repo = fullM[2]!;
    const number = Number.parseInt(fullM[3]!, 10);
    const inScope =
      (!boundOwner || owner.toLowerCase() === boundOwner.toLowerCase()) &&
      (!boundRepo || repo.toLowerCase() === boundRepo.toLowerCase());
    return { owner, repo, number, inScope };
  }

  private async ghFetch(
    token: string,
    apiPath: string,
    init: { method?: string; body?: unknown },
    deadlineMs: number,
  ): Promise<Response> {
    const remaining = Math.max(100, deadlineMs - Date.now());
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), remaining);
    try {
      return await this.fetchImpl(`${this.apiBaseUrl}${apiPath}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async resolve(
    items: Array<WorkRef | WorkLocator>,
    binding: Readonly<Record<string, unknown>>,
    ctx: ProviderCtx,
  ): Promise<WorkResolveOutcome[]> {
    const token = resolveEnvSecretRef(
      binding.tokenRef ?? "env:GITHUB_TOKEN",
      this.env,
    );
    const fetchedAt = new Date().toISOString();
    const out: WorkResolveOutcome[] = [];

    for (const item of items) {
      const rawInput = typeof item === "string" ? item : item.value;
      const loc = typeof item === "string" ? this.parseLocator(item) : item;
      if (!loc || loc.provider !== "github") {
        out.push({ input: rawInput, gone: true });
        continue;
      }
      const target = this.parseTarget(loc, binding);
      if (!target.number) {
        out.push({ input: rawInput, gone: true });
        continue;
      }
      if (!target.inScope) {
        out.push({ input: rawInput, outOfScope: true });
        continue;
      }

      const res = await this.ghFetch(
        token,
        `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${target.number}`,
        {},
        ctx.deadlineMs,
      );
      if (res.status === 404 || res.status === 410) {
        out.push({ input: rawInput, gone: true });
        continue;
      }
      if (!res.ok) {
        throw new MindError("INVALID_INPUT", `GitHub API HTTP ${res.status}`);
      }
      const dto = (await res.json()) as GitHubIssueDto;
      out.push(toSnapshot(target.owner, target.repo, dto, fetchedAt));
    }

    return out;
  }

  async listReady(
    binding: Readonly<Record<string, unknown>>,
    page: { limit: number; cursor?: string },
    ctx: ProviderCtx,
  ): Promise<{ items: WorkItemSnapshot[]; nextCursor?: string }> {
    const token = resolveEnvSecretRef(
      binding.tokenRef ?? "env:GITHUB_TOKEN",
      this.env,
    );
    const owner = typeof binding.owner === "string" ? binding.owner.trim() : "";
    const repo = typeof binding.repo === "string" ? binding.repo.trim() : "";
    if (!owner || !repo) {
      throw new MindError(
        "INVALID_INPUT",
        'GitHub work binding requires "owner" and "repo"',
      );
    }
    const perPage = Math.max(1, Math.min(page.limit, 100));
    const pageNum = page.cursor ? Number.parseInt(page.cursor, 10) || 1 : 1;
    const fetchedAt = new Date().toISOString();

    const res = await this.ghFetch(
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=${perPage}&page=${pageNum}`,
      {},
      ctx.deadlineMs,
    );
    if (!res.ok) {
      throw new MindError("INVALID_INPUT", `GitHub API HTTP ${res.status}`);
    }
    const rawList = (await res.json()) as GitHubIssueDto[];
    const items: WorkItemSnapshot[] = [];
    for (const dto of rawList) {
      if (dto.pull_request) continue;
      const labels = (dto.labels ?? []).map((l) =>
        typeof l === "string" ? l.toLowerCase() : (l.name ?? "").toLowerCase(),
      );
      if (labels.includes("blocked")) continue;
      items.push(toSnapshot(owner, repo, dto, fetchedAt));
    }
    return {
      items,
      ...(rawList.length >= perPage ? { nextCursor: String(pageNum + 1) } : {}),
    };
  }

  async annotate(
    ref: WorkRef,
    note: AnnotateNote,
    binding: Readonly<Record<string, unknown>>,
    ctx: ProviderCtx,
  ): Promise<{ externalId: string }> {
    const loc = this.parseLocator(ref);
    if (!loc || loc.provider !== "github") {
      throw new MindError("INVALID_REF", `Invalid GitHub WorkRef: "${ref}"`);
    }
    const target = this.parseTarget(loc, binding);
    if (!target.inScope) {
      throw new MindError(
        "ACCESS_DENIED",
        `GitHub issue "${ref}" is outside the bound repository scope`,
      );
    }
    const token = resolveEnvSecretRef(
      binding.tokenRef ?? "env:GITHUB_TOKEN",
      this.env,
    );

    const listRes = await this.ghFetch(
      token,
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${target.number}/comments?per_page=100`,
      {},
      ctx.deadlineMs,
    );
    if (listRes.status === 404 || listRes.status === 410) {
      throw new MindError("NOT_FOUND", `GitHub issue not found: ${ref}`);
    }
    if (!listRes.ok) {
      throw new MindError("INVALID_INPUT", `GitHub API HTTP ${listRes.status}`);
    }
    const existing = (await listRes.json()) as Array<{ id: number; body?: string }>;
    const marker = `<!-- meru-idempotency:${note.idempotencyKey} -->`;
    const dup = existing.find((c) => (c.body ?? "").includes(marker));
    if (dup) {
      return { externalId: String(dup.id) };
    }

    const body = formatDefaultAnnotateComment(note);
    const postRes = await this.ghFetch(
      token,
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${target.number}/comments`,
      { method: "POST", body: { body } },
      ctx.deadlineMs,
    );
    if (!postRes.ok) {
      throw new MindError("INVALID_INPUT", `GitHub comment create HTTP ${postRes.status}`);
    }
    const created = (await postRes.json()) as { id: number };
    return { externalId: String(created.id) };
  }
}
