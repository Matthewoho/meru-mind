import { detectPlaintextSecret } from "../engine/secret-guard.js";
import { MindError } from "../types.js";

/** Stable external work reference: `work:<provider>:<stableNativeId>` */
export type WorkRef = `work:${string}:${string}`;

export interface WorkLocator {
  provider: string;
  kind: "id" | "key" | "url";
  value: string;
}

export type StatusType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export interface ProviderCtx {
  principalId: string;
  realmId: string;
  deadlineMs: number;
}

export interface WorkItemSnapshot {
  ref: WorkRef;
  /** Human display key (e.g. ENG-123 or owner/repo#42); display only, allowed to change */
  displayId: string;
  title: string;
  statusType: StatusType;
  statusName: string;
  assignee?: { externalId: string; displayName: string };
  url: string;
  /** Required: proves this is a live remote snapshot, NEVER cached local state */
  fetchedAt: string;
  /** Opaque provider bag; core kernel never inspects this */
  native?: Readonly<Record<string, unknown>>;
}

export type WorkResolveOutcome =
  | WorkItemSnapshot
  | { input: string; gone: true }
  | { input: string; outOfScope: true };

export interface AnnotateNote {
  idempotencyKey: string;
  /** Default backlink payload: title + backlink ONLY (never leaks record body unless opted in) */
  title: string;
  backlink: string;
  /** Optional explicit opt-in body; callers opting in must track external residual for redact */
  bodyMarkdown?: string;
}

/**
 * Narrow Single-Source-of-Truth (SSOT) WorkProvider contract (v0.5):
 * - Zero task tables in mind-core
 * - MCP stays strictly at 7 tools
 * - All live status fetched on demand; degraded cleanly to "status unavailable" on outage
 */
export interface WorkProvider {
  readonly id: string;
  readonly capabilities: { ready: boolean; annotate: boolean };

  /** Pure, synchronous, zero-network locator parser */
  parseLocator(input: string): WorkLocator | null;

  /** Live resolve scoped strictly to `binding` (prevents org-wide keys reading unbound private teams/repos) */
  resolve(
    items: Array<WorkRef | WorkLocator>,
    binding: Readonly<Record<string, unknown>>,
    ctx: ProviderCtx,
  ): Promise<WorkResolveOutcome[]>;

  /** Lists live ready work items within `binding` */
  listReady(
    binding: Readonly<Record<string, unknown>>,
    page: { limit: number; cursor?: string },
    ctx: ProviderCtx,
  ): Promise<{ items: WorkItemSnapshot[]; nextCursor?: string }>;

  /** Optional idempotent backlink annotation */
  annotate?(
    ref: WorkRef,
    note: AnnotateNote,
    binding: Readonly<Record<string, unknown>>,
    ctx: ProviderCtx,
  ): Promise<{ externalId: string }>;
}

export interface WorkBindingRecord {
  orgId: string;
  realmId: string;
  provider: string;
  config: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const SECRET_KEY_NAME_RE = /(?:api[_-]?key|token|secret|password|auth)/i;
const ENV_REF_RE = /^env:[A-Z_][A-Z0-9_]*$/;

/**
 * Enforces the hard security invariant on `work_bindings.config_json`:
 * NEVER store plaintext credentials in SQLite — only `env:VAR_NAME` references are allowed.
 */
export function validateWorkBindingConfig(
  config: Record<string, unknown>,
): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new MindError("INVALID_INPUT", "Work binding config must be a JSON object");
  }
  const visit = (obj: Record<string, unknown>, prefix = "") => {
    for (const [k, v] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") {
        const trimmed = v.trim();
        const detected = detectPlaintextSecret(trimmed);
        if (detected) {
          throw new MindError(
            "INVALID_INPUT",
            `work_bindings.config_json field "${fullKey}" contains a plaintext credential (${detected.patternName}). Store an env reference instead (e.g. "env:LINEAR_API_KEY").`,
            {
              reason: "plaintext_secret_in_work_binding",
              try: 'Use "env:LINEAR_API_KEY" or "env:GITHUB_TOKEN" in binding config',
            },
          );
        }
        if (SECRET_KEY_NAME_RE.test(k) && trimmed.length > 0 && !ENV_REF_RE.test(trimmed)) {
          throw new MindError(
            "INVALID_INPUT",
            `work_bindings.config_json field "${fullKey}" must be an env reference matching "env:VAR_NAME" (plaintext secrets are forbidden).`,
            {
              reason: "non_env_credential_ref",
              try: `Set "${k}": "env:YOUR_ENV_VAR_NAME"`,
            },
          );
        }
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        visit(v as Record<string, unknown>, fullKey);
      }
    }
  };
  visit(config);
}

/**
 * Resolves an `"env:VAR_NAME"` credential reference from `env` at runtime.
 */
export function resolveEnvSecretRef(
  refValue: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof refValue !== "string" || !ENV_REF_RE.test(refValue.trim())) {
    throw new MindError(
      "INVALID_INPUT",
      `Expected credential env reference "env:VAR_NAME", got "${String(refValue ?? "")}"`,
    );
  }
  const varName = refValue.trim().slice(4);
  const resolved = env[varName]?.trim();
  if (!resolved) {
    throw new MindError(
      "ACCESS_DENIED",
      `Environment variable "${varName}" referenced by work binding is not set`,
    );
  }
  return resolved;
}

export function formatDefaultAnnotateComment(note: AnnotateNote): string {
  const lines = [
    `<!-- meru-idempotency:${note.idempotencyKey} -->`,
    `**${note.title}**`,
    `Context: ${note.backlink}`,
  ];
  if (note.bodyMarkdown?.trim()) {
    lines.push("", note.bodyMarkdown.trim());
  }
  return lines.join("\n");
}
