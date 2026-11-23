import type { DbPort } from "../ports.js";
import type { Realm } from "../types.js";
import { GitHubWorkProvider } from "./github-provider.js";
import { LinearWorkProvider } from "./linear-provider.js";
import type {
  AnnotateNote,
  ProviderCtx,
  WorkBindingRecord,
  WorkItemSnapshot,
  WorkLocator,
  WorkProvider,
  WorkRef,
  WorkResolveOutcome,
} from "./provider.js";

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  cooldownMs?: number;
  defaultTimeoutMs?: number;
}

interface BreakerState {
  failures: number;
  openedUntilMs: number;
}

export type SafeResolveResult =
  | { unavailable: false; provider: string; outcomes: WorkResolveOutcome[] }
  | { unavailable: true; provider: string; reason: string };

export type SafeListReadyResult =
  | { unavailable: false; provider: string; items: WorkItemSnapshot[]; nextCursor?: string }
  | { unavailable: true; provider: string; reason: string };

/**
 * Walks realm ancestry (self -> parent -> ... -> root) to resolve the nearest `work_bindings` row.
 */
export function resolveWorkBindingForRealm(params: {
  db: DbPort;
  realms: Realm[];
  orgId: string;
  realmId: string;
}): WorkBindingRecord | null {
  const byId = new Map(params.realms.map((r) => [r.id, r]));
  const visited = new Set<string>();
  let cur = byId.get(params.realmId);
  while (cur && cur.orgId === params.orgId && !visited.has(cur.id)) {
    visited.add(cur.id);
    const binding = params.db.getWorkBinding(params.orgId, cur.id);
    if (binding) return binding;
    if (!cur.parentId) break;
    cur = byId.get(cur.parentId);
  }
  return null;
}

/**
 * Static in-process WorkProvider registry with per-provider circuit breaker and graceful degradation.
 * NEVER dynamically imports arbitrary user-configured code paths (third-party providers run out-of-process over MCP).
 */
export class WorkProviderRegistry {
  private readonly providers = new Map<string, WorkProvider>();
  private readonly breakers = new Map<string, BreakerState>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly defaultTimeoutMs: number;

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 3;
    this.cooldownMs = config.cooldownMs ?? 30_000;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 5_000;
  }

  static createDefault(config?: CircuitBreakerConfig): WorkProviderRegistry {
    const reg = new WorkProviderRegistry(config);
    reg.register(new LinearWorkProvider());
    reg.register(new GitHubWorkProvider());
    return reg;
  }

  register(provider: WorkProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): WorkProvider | null {
    return this.providers.get(id) ?? null;
  }

  listIds(): string[] {
    return Array.from(this.providers.keys()).sort();
  }

  /** Pure offline locator parsing across registered providers */
  parseLocator(input: string, preferredProvider?: string): WorkLocator | null {
    if (preferredProvider) {
      const pref = this.providers.get(preferredProvider);
      if (pref) {
        const hit = pref.parseLocator(input);
        if (hit) return hit;
      }
    }
    for (const provider of this.providers.values()) {
      const hit = provider.parseLocator(input);
      if (hit) return hit;
    }
    return null;
  }

  private isCircuitOpen(providerId: string, nowMs = Date.now()): boolean {
    const b = this.breakers.get(providerId);
    if (!b) return false;
    if (b.openedUntilMs > nowMs) return true;
    // Half-open after cooldown
    if (b.openedUntilMs > 0) {
      b.openedUntilMs = 0;
      b.failures = Math.max(0, this.failureThreshold - 1);
    }
    return false;
  }

  private recordSuccess(providerId: string): void {
    this.breakers.delete(providerId);
  }

  private recordFailure(providerId: string, nowMs = Date.now()): void {
    const cur = this.breakers.get(providerId) ?? { failures: 0, openedUntilMs: 0 };
    cur.failures += 1;
    if (cur.failures >= this.failureThreshold) {
      cur.openedUntilMs = nowMs + this.cooldownMs;
    }
    this.breakers.set(providerId, cur);
  }

  /**
   * Resolves live work items with timeout + circuit breaker; degrades cleanly to "status unavailable"
   * on network/provider failure without ever returning stale cached state or failing core reads.
   */
  async resolveSafe(params: {
    binding: WorkBindingRecord;
    items: Array<WorkRef | WorkLocator>;
    principalId: string;
    realmId: string;
    timeoutMs?: number;
  }): Promise<SafeResolveResult> {
    const providerId = params.binding.provider;
    const provider = this.providers.get(providerId);
    if (!provider) {
      return {
        unavailable: true,
        provider: providerId,
        reason: `status unavailable: provider "${providerId}" is not registered`,
      };
    }
    if (this.isCircuitOpen(providerId)) {
      return {
        unavailable: true,
        provider: providerId,
        reason: `status unavailable: circuit breaker open for "${providerId}"`,
      };
    }

    const ctx: ProviderCtx = {
      principalId: params.principalId,
      realmId: params.realmId,
      deadlineMs: Date.now() + (params.timeoutMs ?? this.defaultTimeoutMs),
    };
    try {
      const outcomes = await provider.resolve(
        params.items,
        params.binding.config,
        ctx,
      );
      this.recordSuccess(providerId);
      return { unavailable: false, provider: providerId, outcomes };
    } catch (err) {
      this.recordFailure(providerId);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        unavailable: true,
        provider: providerId,
        reason: `status unavailable (${providerId}): ${msg}`,
      };
    }
  }

  async listReadySafe(params: {
    binding: WorkBindingRecord;
    limit?: number;
    cursor?: string;
    principalId: string;
    realmId: string;
    timeoutMs?: number;
  }): Promise<SafeListReadyResult> {
    const providerId = params.binding.provider;
    const provider = this.providers.get(providerId);
    if (!provider) {
      return {
        unavailable: true,
        provider: providerId,
        reason: `status unavailable: provider "${providerId}" is not registered`,
      };
    }
    if (!provider.capabilities.ready) {
      return {
        unavailable: true,
        provider: providerId,
        reason: `status unavailable: provider "${providerId}" does not support listReady`,
      };
    }
    if (this.isCircuitOpen(providerId)) {
      return {
        unavailable: true,
        provider: providerId,
        reason: `status unavailable: circuit breaker open for "${providerId}"`,
      };
    }

    const ctx: ProviderCtx = {
      principalId: params.principalId,
      realmId: params.realmId,
      deadlineMs: Date.now() + (params.timeoutMs ?? this.defaultTimeoutMs),
    };
    try {
      const res = await provider.listReady(
        params.binding.config,
        { limit: params.limit ?? 20, cursor: params.cursor },
        ctx,
      );
      this.recordSuccess(providerId);
      return {
        unavailable: false,
        provider: providerId,
        items: res.items,
        ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}),
      };
    } catch (err) {
      this.recordFailure(providerId);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        unavailable: true,
        provider: providerId,
        reason: `status unavailable (${providerId}): ${msg}`,
      };
    }
  }

  async annotate(params: {
    binding: WorkBindingRecord;
    ref: WorkRef;
    note: AnnotateNote;
    principalId: string;
    realmId: string;
    timeoutMs?: number;
  }): Promise<{ externalId: string }> {
    const providerId = params.binding.provider;
    const provider = this.providers.get(providerId);
    if (!provider || !provider.capabilities.annotate || !provider.annotate) {
      throw new Error(`Provider "${providerId}" does not support annotate`);
    }
    if (this.isCircuitOpen(providerId)) {
      throw new Error(`Circuit breaker open for "${providerId}"`);
    }
    const ctx: ProviderCtx = {
      principalId: params.principalId,
      realmId: params.realmId,
      deadlineMs: Date.now() + (params.timeoutMs ?? this.defaultTimeoutMs),
    };
    try {
      const res = await provider.annotate(
        params.ref,
        params.note,
        params.binding.config,
        ctx,
      );
      this.recordSuccess(providerId);
      return res;
    } catch (err) {
      this.recordFailure(providerId);
      throw err;
    }
  }
}
