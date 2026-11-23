import {
  MindError,
  type MindErrorCode,
  type SurfaceErrorPayload,
  type WireErrorCode,
} from "../types.js";

const ENGINE_TO_WIRE_CODE: Record<MindErrorCode, WireErrorCode> = {
  NOT_FOUND: "not_found",
  ACCESS_DENIED: "forbidden",
  RULE_REQUIRES_HUMAN: "forbidden",
  SLICE_VIOLATION: "forbidden",
  FORBIDDEN_HOME_PATH: "forbidden",
  CONFLICT: "conflict",
  VERDICT_INVARIANT: "conflict",
  IDEMPOTENCY_MISMATCH: "idempotency_mismatch",
  INVALID_INPUT: "invalid_input",
  DRIVE_ERROR: "invalid_input",
  UNKNOWN_COMMAND: "unknown_command",
  UNKNOWN_FLAG: "unknown_flag",
  INVALID_REF: "invalid_ref",
  AMBIGUOUS_REF: "ambiguous_ref",
  NOT_LISTABLE: "not_listable",
  NOT_BOUND: "not_bound",
};

export function mapMindErrorCodeToWire(code: MindErrorCode): WireErrorCode {
  return ENGINE_TO_WIRE_CODE[code] ?? "invalid_input";
}

export interface SurfaceErrorOptions {
  surface?: "cli" | "mcp";
  boundRealmPath?: string;
  orgPolicy?: "open" | "tree";
}

function safeMcpRealmRef(options?: SurfaceErrorOptions): string {
  const bound = options?.boundRealmPath?.trim();
  if (bound) return bound;
  return options?.orgPolicy === "tree" ? "<bound-realm>" : "/";
}

function safeMcpWriteRealmRef(options?: SurfaceErrorOptions): string {
  const bound = options?.boundRealmPath?.trim();
  if (bound && bound !== "/") return bound;
  return options?.orgPolicy === "tree" ? "<bound-realm>" : "/ops";
}

function adaptTryHintForMcp(
  code: MindErrorCode,
  explicitTry: string | undefined,
  candidates: string[],
  options?: SurfaceErrorOptions,
): string | undefined {
  const realmRef = safeMcpRealmRef(options);
  const writeRealmRef = safeMcpWriteRealmRef(options);

  if (code === "RULE_REQUIRES_HUMAN") {
    return "Rules are human-only and cannot be written over MCP; ask a human to run 'meru-mind rule add --as-human' on CLI";
  }

  if (code === "AMBIGUOUS_REF" && candidates.length > 0) {
    const first = candidates[0]!;
    if (explicitTry && explicitTry.includes("meru-mind write")) {
      return options?.orgPolicy === "tree"
        ? `mind_write({ in: ${JSON.stringify(writeRealmRef)}, title: "<title>", body: "<body>", about: [${JSON.stringify(first)}] })`
        : `mind_write({ title: "<title>", body: "<body>", about: [${JSON.stringify(first)}] })`;
    }
    return `mind_show({ ref: ${JSON.stringify(first)} })`;
  }

  if (code === "NOT_LISTABLE") {
    const m = explicitTry?.match(/^meru-mind show\s+(.+)$/);
    const target = m?.[1]?.trim();
    return target
      ? `mind_show({ ref: ${JSON.stringify(target)} })`
      : `mind_show({ ref: "<ref>" })`;
  }

  if (code === "INVALID_REF") {
    return `mind_tree({ ref: ${JSON.stringify(realmRef)} })`;
  }

  if (
    code === "ACCESS_DENIED" &&
    explicitTry &&
    explicitTry.includes("Remove the redacted content")
  ) {
    return "Remove the redacted content before retrying mind_write (re-ingesting redacted content is blocked over MCP)";
  }

  if (!explicitTry) {
    return undefined;
  }

  if (explicitTry.startsWith("meru-mind tree")) {
    return `mind_tree({ ref: ${JSON.stringify(realmRef)} })`;
  }
  if (explicitTry.startsWith("meru-mind ls")) {
    if (explicitTry.includes("--only files")) {
      return `mind_ls({ ref: ${JSON.stringify(realmRef)}, only: "files" })`;
    }
    if (explicitTry.includes("--about")) {
      return `mind_ls({ ref: ${JSON.stringify(realmRef)}, about: "service:api" })`;
    }
    return `mind_ls({ ref: ${JSON.stringify(realmRef)} })`;
  }
  if (explicitTry.startsWith("meru-mind show ")) {
    let ref = explicitTry.slice("meru-mind show ".length).trim();
    if (options?.orgPolicy === "tree" && ref === "file:/readme.md" && realmRef !== "/") {
      ref = `file:${realmRef}/readme.md`;
    }
    return `mind_show({ ref: ${JSON.stringify(ref)} })`;
  }
  if (explicitTry.startsWith("meru-mind search")) {
    if (explicitTry.includes("--about")) {
      return `mind_search({ query: "keyword", in: ${JSON.stringify(realmRef)}, about: "service:api" })`;
    }
    return `mind_search({ query: "keyword", in: ${JSON.stringify(realmRef)} })`;
  }
  if (explicitTry.startsWith("meru-mind write")) {
    const inPart =
      options?.orgPolicy === "tree"
        ? `in: ${JSON.stringify(writeRealmRef)}, `
        : "";
    if (explicitTry.includes("--about")) {
      return `mind_write({ ${inPart}title: "<title>", body: "<body>", about: ["service:api"] })`;
    }
    return `mind_write({ ${inPart}kind: "finding", title: "<title>", body: "<body>" })`;
  }

  return explicitTry;
}

function defaultTryHint(
  code: MindErrorCode,
  options?: SurfaceErrorOptions,
): string | undefined {
  const surface = options?.surface ?? "cli";
  const realmRef = safeMcpRealmRef(options);
  switch (code) {
    case "RULE_REQUIRES_HUMAN":
      return surface === "cli"
        ? `meru-mind rule add --in ${realmRef} --title "<title>" --body "<body>" --as-human`
        : "Rules are human-only and cannot be written over MCP; ask a human to run 'meru-mind rule add --as-human' on CLI";
    case "NOT_BOUND":
      return "MERU_MIND_VIEWER_REALM_ID=/team/project meru-mind whoami";
    case "INVALID_REF":
      return surface === "cli"
        ? `meru-mind tree ${realmRef}`
        : `mind_tree({ ref: ${JSON.stringify(realmRef)} })`;
    default:
      return undefined;
  }
}

export function toSurfaceError(
  err: unknown,
  options?: SurfaceErrorOptions,
): SurfaceErrorPayload {
  const surface = options?.surface ?? "cli";
  if (err instanceof MindError) {
    const wireCode = mapMindErrorCodeToWire(err.code);
    const rawCandidates = err.details?.candidates;
    const candidates = Array.isArray(rawCandidates)
      ? rawCandidates
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      : [];
    const explicitTry =
      typeof err.details?.try === "string" && err.details.try.trim().length > 0
        ? err.details.try.trim()
        : undefined;
    let tryCommand: string | undefined;
    if (surface === "mcp") {
      tryCommand =
        adaptTryHintForMcp(err.code, explicitTry, candidates, options) ??
        defaultTryHint(err.code, options);
    } else {
      tryCommand = explicitTry ?? defaultTryHint(err.code, options);
      if (
        tryCommand &&
        options?.orgPolicy === "tree" &&
        options.boundRealmPath &&
        tryCommand === "meru-mind tree /"
      ) {
        tryCommand = `meru-mind tree ${options.boundRealmPath}`;
      }
    }

    return {
      error: wireCode,
      message: err.message,
      ...(candidates.length > 0 ? { candidates } : {}),
      ...(tryCommand ? { try: tryCommand } : {}),
    };
  }

  return {
    error: "invalid_input",
    message: err instanceof Error ? err.message : String(err),
  };
}

export function formatSurfaceErrorText(payload: SurfaceErrorPayload): string {
  const lines: string[] = [
    `error: ${payload.error}`,
    `message: ${payload.message}`,
  ];
  if (payload.candidates && payload.candidates.length > 0) {
    lines.push(`candidates: ${payload.candidates.join(", ")}`);
  }
  if (payload.try) {
    lines.push(`try: ${payload.try}`);
  }
  return lines.join("\n");
}
