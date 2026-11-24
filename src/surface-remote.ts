import type { WorkBindingRecord } from "./work/provider.js";
import type { SafeListReadyResult, SafeResolveResult } from "./work/registry.js";
import type {
  MindSurface,
  SurfaceAddRuleInput,
  SurfaceChangesParams,
  SurfaceCreateRealmInput,
  SurfaceUpdateRealmInput,
  SurfaceCreateTokenInput,
  SurfaceCreateTokenResult,
  SurfaceLsParams,
  SurfaceMountRealmInput,
  SurfaceMoveInput,
  SurfaceRawAddInput,
  SurfaceRedactInput,
  SurfaceSearchParams,
  SurfaceShowParams,
  SurfaceTreeParams,
  SurfaceWriteInput,
  SurfaceWriteResult,
} from "./surface.js";
import {
  MindError,
  type AuthTokenPublic,
  type ChangesResult,
  type LedgerRecord,
  type LsResult,
  type MindErrorCode,
  type MoveEntriesResult,
  type Organization,
  type Principal,
  type Realm,
  type RealmArchiveResult,
  type RealmMount,
  type RealmUnarchiveResult,
  type RedactResult,
  type SeabedEntry,
  type SearchResult,
  type ShowResult,
  type ShowSupersedeChainResult,
  type SurfaceErrorPayload,
  type TreeResult,
  type WhoamiResult,
} from "./types.js";

const WIRE_TO_ENGINE_CODE: Record<string, MindErrorCode> = {
  not_found: "NOT_FOUND",
  forbidden: "ACCESS_DENIED",
  conflict: "CONFLICT",
  idempotency_mismatch: "IDEMPOTENCY_MISMATCH",
  invalid_input: "INVALID_INPUT",
  unknown_command: "UNKNOWN_COMMAND",
  unknown_flag: "UNKNOWN_FLAG",
  invalid_ref: "INVALID_REF",
  ambiguous_ref: "AMBIGUOUS_REF",
  not_listable: "NOT_LISTABLE",
  not_bound: "NOT_BOUND",
};

export interface RemoteMindSurfaceOptions {
  baseUrl: string;
  token: string;
  /** Optional untrusted workspace hint (.meru-mind-realm) sent via header and intersected with token scope */
  workspaceHint?: string | null;
  /** Optional client session tag for MindPulse (`X-Meru-Session-Id`); defaults to `MERU_MIND_SESSION_ID` env */
  sessionId?: string | null;
  /** Optional self-reported client hint for MindPulse (`X-Meru-Client`); defaults to `MERU_MIND_CLIENT` env */
  clientHint?: string | null;
  fetchImpl?: typeof fetch;
}

/**
 * Remote HTTP implementation of `MindSurface` talking to `meru-mind serve` (`/v1/*`).
 * Passes the exact same contract test suite as `LocalMindSurface`.
 */
export class RemoteMindSurface implements MindSurface {
  readonly mode = "remote" as const;
  private _principal: Principal;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly workspaceHint: string | null;
  private readonly sessionId: string | null;
  private readonly clientHint: string | null;
  private readonly fetchImpl: typeof fetch;
  private lastReadSeq = 0;

  private constructor(
    options: RemoteMindSurfaceOptions,
    initialPrincipal: Principal,
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.workspaceHint = options.workspaceHint ?? null;
    this.sessionId =
      options.sessionId !== undefined
        ? options.sessionId
        : (process.env.MERU_MIND_SESSION_ID?.trim() || null);
    this.clientHint =
      options.clientHint !== undefined
        ? options.clientHint
        : (process.env.MERU_MIND_CLIENT?.trim() || null);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this._principal = initialPrincipal;
  }

  get principal(): Principal {
    return this._principal;
  }

  /**
   * Connects to a running `meru-mind serve` instance, verifies the Bearer token via `/v1/whoami`,
   * and returns an authenticated `RemoteMindSurface`.
   */
  static async connect(
    options: RemoteMindSurfaceOptions,
  ): Promise<RemoteMindSurface> {
    const placeholder: Principal = {
      tokenId: null,
      orgId: "",
      actor: { id: "unknown", kind: "agent" },
      boundRealmId: "",
      boundSource: "remote",
      authKind: "bearer",
    };
    const surface = new RemoteMindSurface(options, placeholder);
    const info = await surface.whoami();
    surface._principal = {
      tokenId: null,
      orgId: info.org.id,
      actor: info.actor,
      boundRealmId: info.bound.realmId,
      boundSource: info.bound.source,
      authKind: "bearer",
    };
    return surface;
  }

  private async request<T>(
    method: "GET" | "POST",
    endpoint: string,
    options?: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      signal?: AbortSignal;
      extraHeaders?: Record<string, string>;
    },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (options?.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...(options?.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(this.workspaceHint
        ? { "X-Meru-Workspace-Hint": this.workspaceHint }
        : {}),
      ...(this.sessionId
        ? { "X-Meru-Session-Id": this.sessionId }
        : {}),
      ...(this.clientHint
        ? { "X-Meru-Client": this.clientHint }
        : {}),
      ...(this.lastReadSeq > 0
        ? { "X-Meru-Last-Read-Seq": String(this.lastReadSeq) }
        : {}),
      ...(options?.extraHeaders ?? {}),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options?.signal,
      });
    } catch (err) {
      throw new MindError(
        "INVALID_INPUT",
        `Failed to connect to Meru Mind server at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text };
      }
    }

    const latestHeader = res.headers.get("x-meru-latest-seq");
    if (latestHeader) {
      const seqNum = Number.parseInt(latestHeader, 10);
      if (Number.isFinite(seqNum) && seqNum > this.lastReadSeq) {
        this.lastReadSeq = seqNum;
      }
    }

    if (!res.ok) {
      const errObj = (parsed ?? {}) as Partial<SurfaceErrorPayload>;
      const engineCode =
        (errObj.error ? WIRE_TO_ENGINE_CODE[errObj.error] : undefined) ??
        (res.status === 401 || res.status === 403
          ? "ACCESS_DENIED"
          : res.status === 404
            ? "NOT_FOUND"
            : res.status === 409
              ? "CONFLICT"
              : "INVALID_INPUT");
      throw new MindError(
        engineCode,
        errObj.message ?? `HTTP ${res.status} from ${endpoint}`,
        {
          ...(errObj.candidates ? { candidates: errObj.candidates } : {}),
          ...(errObj.try ? { try: errObj.try } : {}),
        },
      );
    }

    return parsed as T;
  }

  async whoami(): Promise<WhoamiResult> {
    const res = await this.request<WhoamiResult>("GET", "/v1/whoami");
    if (res.latestSeq > this.lastReadSeq) {
      this.lastReadSeq = res.latestSeq;
    }
    return res;
  }

  async tree(params?: SurfaceTreeParams): Promise<TreeResult> {
    return this.request<TreeResult>("GET", "/v1/tree", {
      query: {
        ref: params?.ref,
        depth: params?.depth,
        objects: params?.includeObjects,
        limit: params?.limit,
      },
    });
  }

  async ls(params?: SurfaceLsParams): Promise<LsResult> {
    return this.request<LsResult>("GET", "/v1/ls", {
      query: {
        ref: params?.ref,
        only: params?.only,
        kind: params?.kind,
        about: params?.about,
        since: params?.since,
        until: params?.until,
        history: params?.history,
        include_descendant_seabed: params?.includeDescendantSeabed,
        limit: params?.limit,
        cursor: params?.cursor,
      },
    });
  }

  async show(params: SurfaceShowParams): Promise<ShowResult> {
    return this.request<ShowResult>("GET", "/v1/show", {
      query: {
        ref: params.ref,
        around: params.around,
        cursor: params.cursor,
        chars: params.chars,
        full: params.full,
        history: params.history,
        context: params.context,
        include_descendant_seabed: params.includeDescendantSeabed,
      },
    });
  }

  async search(params: SurfaceSearchParams): Promise<SearchResult> {
    return this.request<SearchResult>("GET", "/v1/search", {
      query: {
        query: params.query,
        in: params.in,
        about: params.about,
        kind: params.kind,
        since: params.since,
        until: params.until,
        history: params.history,
        include_descendant_seabed: params.includeDescendantSeabed,
        limit: params.limit,
        cursor: params.cursor,
      },
    });
  }

  async changes(params?: SurfaceChangesParams): Promise<ChangesResult> {
    const res = await this.request<ChangesResult>("GET", "/v1/changes", {
      query: {
        since: params?.sinceSeq,
        generation: params?.generation,
        in: params?.in,
        limit: params?.limit,
        include_descendant_seabed: params?.includeDescendantSeabed,
        wait: params?.waitSeconds,
      },
      signal: params?.signal,
    });
    if (res.latestSeq > this.lastReadSeq) {
      this.lastReadSeq = res.latestSeq;
    }
    return res;
  }

  async write(params: SurfaceWriteInput): Promise<SurfaceWriteResult> {
    const lastReadSeq =
      params.lastReadSeq !== undefined ? params.lastReadSeq : this.lastReadSeq;
    return this.request<SurfaceWriteResult>("POST", "/v1/write", {
      body: {
        ...params,
        ...(lastReadSeq > 0 ? { lastReadSeq } : {}),
      },
    });
  }

  async rawAdd(params: SurfaceRawAddInput): Promise<SeabedEntry> {
    return this.request<SeabedEntry>("POST", "/v1/raw", {
      body: params,
    });
  }

  async move(params: SurfaceMoveInput): Promise<MoveEntriesResult> {
    return this.request<MoveEntriesResult>("POST", "/v1/move", {
      body: params,
    });
  }

  async getEntryChain(entryId: string): Promise<ShowSupersedeChainResult> {
    return this.request<ShowSupersedeChainResult>(
      "GET",
      `/v1/entry/${encodeURIComponent(entryId)}/chain`,
    );
  }

  async addRule(params: SurfaceAddRuleInput): Promise<LedgerRecord> {
    return this.request<LedgerRecord>("POST", "/v1/rules", { body: params });
  }

  async redact(params: SurfaceRedactInput): Promise<RedactResult> {
    return this.request<RedactResult>("POST", "/v1/redact", { body: params });
  }

  async createRealm(params: SurfaceCreateRealmInput): Promise<Realm> {
    return this.request<Realm>("POST", "/v1/realms", { body: params });
  }

  async updateRealm(params: SurfaceUpdateRealmInput): Promise<Realm> {
    return this.request<Realm>("POST", "/v1/realms/set", { body: params });
  }

  async mountRealm(params: SurfaceMountRealmInput): Promise<RealmMount> {
    return this.request<RealmMount>("POST", "/v1/realms/mount", {
      body: params,
    });
  }

  async unmountRealm(params: {
    viewerRef: string;
    targetRef: string;
  }): Promise<boolean> {
    const res = await this.request<{ unmounted: boolean }>(
      "POST",
      "/v1/realms/unmount",
      { body: params },
    );
    return res.unmounted;
  }

  async archiveRealm(params: { ref: string }): Promise<RealmArchiveResult> {
    return this.request<RealmArchiveResult>("POST", "/v1/realms/archive", {
      body: params,
    });
  }

  async unarchiveRealm(params: { ref: string }): Promise<RealmUnarchiveResult> {
    return this.request<RealmUnarchiveResult>("POST", "/v1/realms/unarchive", {
      body: params,
    });
  }

  async setOrgPolicy(params: { policy: "open" | "tree" }): Promise<Organization> {
    return this.request<Organization>("POST", "/v1/org/policy", {
      body: params,
    });
  }

  async createToken(
    params: SurfaceCreateTokenInput,
  ): Promise<SurfaceCreateTokenResult> {
    return this.request<SurfaceCreateTokenResult>("POST", "/v1/tokens", {
      body: params,
    });
  }

  async listTokens(params?: {
    includeRevoked?: boolean;
  }): Promise<AuthTokenPublic[]> {
    return this.request<AuthTokenPublic[]>("GET", "/v1/tokens", {
      query: { include_revoked: params?.includeRevoked },
    });
  }

  async revokeToken(params: { tokenId: string }): Promise<boolean> {
    const res = await this.request<{ revoked: boolean }>(
      "POST",
      "/v1/tokens/revoke",
      { body: params },
    );
    return res.revoked;
  }

  async bindWork(params: {
    realmRef: string;
    provider: string;
    config: Record<string, unknown>;
  }): Promise<WorkBindingRecord> {
    return this.request<WorkBindingRecord>("POST", "/v1/work/bindings", {
      body: params,
    });
  }

  async unbindWork(params: { realmRef: string }): Promise<boolean> {
    const res = await this.request<{ unbound: boolean }>(
      "POST",
      "/v1/work/unbind",
      { body: params },
    );
    return res.unbound;
  }

  async listWorkBindings(): Promise<WorkBindingRecord[]> {
    return this.request<WorkBindingRecord[]>("GET", "/v1/work/bindings");
  }

  async resolveWork(params: {
    realmRef?: string;
    items: string[];
  }): Promise<SafeResolveResult> {
    return this.request<SafeResolveResult>("POST", "/v1/work/resolve", {
      body: params,
    });
  }

  async listReadyWork(params?: {
    realmRef?: string;
    limit?: number;
    cursor?: string;
  }): Promise<SafeListReadyResult> {
    return this.request<SafeListReadyResult>("GET", "/v1/work/ready", {
      query: {
        ref: params?.realmRef,
        limit: params?.limit,
        cursor: params?.cursor,
      },
    });
  }

  async close(): Promise<void> {
    // Stateless HTTP client; no persistent socket to close
  }
}
