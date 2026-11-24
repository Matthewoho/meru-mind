import { GitHubWorkProvider } from "../work/github-provider.js";
import { LinearWorkProvider } from "../work/linear-provider.js";

export type PulseTargetKind =
  | "linear"
  | "github"
  | "object"
  | "alert"
  | "approval"
  | "branch"
  | "file";

export const MAX_TARGET_KEYS = 8;
export const MAX_TARGET_KEY_CHARS = 120;

const linearParser = new LinearWorkProvider();
const githubParser = new GitHubWorkProvider();

const KNOWN_OBJECT_KINDS = new Set([
  "service",
  "project",
  "person",
  "decision",
  "resource",
  "repo",
  "incident",
  "env",
  "system",
  "component",
]);

const DEFAULT_BRANCHES = new Set(["main", "master", "head", "develop", "dev"]);

/** Common technical standards/prefixes that look like `ABC-123` but are NOT issue trackers */
const NON_ISSUE_PREFIXES = new Set([
  "UTF",
  "HTTP",
  "HTTPS",
  "SHA",
  "MD",
  "TLS",
  "SSL",
  "AES",
  "RSA",
  "ECDSA",
  "RFC",
  "ISO",
  "ANSI",
  "IEEE",
  "POSIX",
  "ECMA",
  "NODE",
  "ES",
  "TS",
  "JS",
  "CSS",
  "HTML",
  "SQL",
  "BASE",
  "ARM",
  "AMD",
  "X86",
  "IPV",
  "TCP",
  "UDP",
  "DNS",
  "GCP",
  "AWS",
  "IAM",
  "VPC",
  "NAT",
  "ECS",
  "GKE",
  "EKS",
  "CDN",
  "SSE",
  "MCP",
  "RPC",
  "API",
  "CLI",
  "SDK",
  "JWT",
  "OAUTH",
  "CORS",
  "CSRF",
  "XSS",
  "SQLI",
  "CVE",
]);

const BARE_ISSUE_RE = /\b([A-Za-z][A-Za-z0-9]{1,9})-([1-9]\d{0,5})\b/g;
const LINEAR_URL_TEXT_RE =
  /https?:\/\/linear\.app\/[A-Za-z0-9_-]+\/issue\/([A-Za-z][A-Za-z0-9]{1,9}-[1-9]\d{0,5})(?:\/[^\s)'"`]*)?/gi;
const GITHUB_URL_TEXT_RE =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9]\d{0,6})\b/gi;
const GITHUB_SHORT_TEXT_RE =
  /\b([A-Za-z0-9_.-]{2,39})\/([A-Za-z0-9_.-]{2,100})#([1-9]\d{0,6})\b/g;
const TYPED_OBJ_TEXT_RE =
  /\b(service|project|person|decision|resource|repo|incident|env|system|component):([A-Za-z0-9._-]{2,64})\b/gi;
const ALERT_TEXT_RE = /\b(alert|approval):([A-Za-z0-9._-]{2,48})\b/gi;
const FILE_KEY_RE = /^file:([^\s/\\]{1,80})$/i;
const BRANCH_KEY_RE =
  /^(?:branch:|repo:)?([A-Za-z0-9._-]{1,48})@([A-Za-z0-9._/-]{1,64})$/;

function cleanControl(raw: string): string {
  return raw.replace(/[\x00-\x1f\x7f]+/g, "").trim();
}

function isLikelyIssueKey(prefix: string): boolean {
  const upper = prefix.toUpperCase();
  if (upper.length < 2 || upper.length > 10) return false;
  if (NON_ISSUE_PREFIXES.has(upper)) return false;
  // Require at least 2 leading letters (rejects V0-1, P1-2, T1-3, M2-1)
  if (!/^[A-Z]{2,}/.test(upper)) return false;
  return true;
}

/**
 * Normalizes a single deterministic target token into a canonical match key,
 * or returns `null` for non-deterministic/freeform strings (which remain display-only).
 * Pure, synchronous, zero network I/O.
 */
export function normalizeDeterministicKey(raw: string): string | null {
  const trimmed = cleanControl(String(raw ?? ""));
  if (!trimmed || trimmed.length > MAX_TARGET_KEY_CHARS) return null;

  // Realm paths (`/projects/meru`) are realm scopes, not target keys
  if (trimmed.startsWith("/") || trimmed.startsWith("@mounted/")) return null;

  // 1. Explicit `issue:ENG-42` or Linear URL / key / work:linear:* via existing LinearWorkProvider.parseLocator
  const withoutIssuePrefix = trimmed.replace(/^issue:/i, "");
  const normalizedLinearCandidate = /^[A-Za-z][A-Za-z0-9]{1,9}-[1-9]\d{0,5}$/.test(
    withoutIssuePrefix,
  )
    ? withoutIssuePrefix.toUpperCase()
    : withoutIssuePrefix;
  const linearLoc = linearParser.parseLocator(normalizedLinearCandidate);
  if (linearLoc && linearLoc.provider === "linear") {
    const val = linearLoc.value.toUpperCase();
    if (linearLoc.kind === "id") {
      return `work:linear:${linearLoc.value}`;
    }
    const prefix = val.split("-")[0] ?? "";
    if (isLikelyIssueKey(prefix)) {
      return `work:linear:${val}`;
    }
    return null;
  }

  // 2. Explicit `pr:owner/repo#42` or GitHub URL / owner/repo#42 / work:github:* via existing GitHubWorkProvider.parseLocator
  const withoutPrPrefix = trimmed.replace(/^pr:/i, "");
  const ghUrlMatch =
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9]\d{0,6})(?:[/?#].*)?$/i.exec(
      withoutPrPrefix,
    );
  if (ghUrlMatch) {
    return `work:github:${ghUrlMatch[1]!.toLowerCase()}/${ghUrlMatch[2]!.toLowerCase()}#${ghUrlMatch[3]!}`;
  }
  const ghLoc = githubParser.parseLocator(withoutPrPrefix);
  if (ghLoc && ghLoc.provider === "github") {
    const v = ghLoc.value.trim();
    const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(v);
    if (m) {
      return `work:github:${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}#${m[3]!}`;
    }
    if (ghLoc.kind === "id") {
      return `work:github:${v.toLowerCase()}`;
    }
    return null;
  }

  // 3. Dispatcher alert / approval IDs (`alert:4044`, `approval:202611180061`)
  const alertMatch = /^(alert|approval):([A-Za-z0-9._-]{2,48})$/i.exec(trimmed);
  if (alertMatch) {
    return `${alertMatch[1]!.toLowerCase()}:${alertMatch[2]!.toLowerCase()}`;
  }

  // 4. Meru Mind typed objects (`service:auth`, `project:meru`, etc.)
  const objMatch = /^([a-z]{2,16}):([A-Za-z0-9._-]{2,64})$/i.exec(trimmed);
  if (objMatch && KNOWN_OBJECT_KINDS.has(objMatch[1]!.toLowerCase())) {
    return `${objMatch[1]!.toLowerCase()}:${objMatch[2]!.toLowerCase()}`;
  }

  // 5. File basename (`file:pulse.ts` — never accepts slashes or traversal)
  const fileMatch = FILE_KEY_RE.exec(trimmed);
  if (fileMatch) {
    const base = fileMatch[1]!;
    if (base === "." || base === ".." || base.includes("..")) return null;
    return `file:${base.toLowerCase()}`;
  }

  // 6. Non-default git repo@branch (`branch:meru-mind@fix/auth` or `meru-mind@fix/auth`)
  const branchMatch = BRANCH_KEY_RE.exec(trimmed);
  if (branchMatch) {
    const repo = branchMatch[1]!.toLowerCase();
    const branch = branchMatch[2]!.toLowerCase();
    if (DEFAULT_BRANCHES.has(branch)) return null;
    return `branch:${repo}@${branch}`;
  }

  return null;
}

/**
 * Extracts deterministic target keys from free text (prompts, branch names, titles, notes).
 * Pure, synchronous, zero network I/O, zero LLM calls.
 */
export function extractDeterministicKeysFromText(text: string): string[] {
  if (!text) return [];
  const sample = String(text).slice(0, 4000);
  const found = new Set<string>();

  const push = (raw: string) => {
    if (found.size >= MAX_TARGET_KEYS) return;
    const norm = normalizeDeterministicKey(raw);
    if (norm) found.add(norm);
  };

  for (const m of sample.matchAll(LINEAR_URL_TEXT_RE)) {
    if (m[1]) push(m[1]);
  }
  for (const m of sample.matchAll(GITHUB_URL_TEXT_RE)) {
    if (m[1] && m[2] && m[3]) push(`${m[1]}/${m[2]}#${m[3]}`);
  }
  for (const m of sample.matchAll(GITHUB_SHORT_TEXT_RE)) {
    if (m[1] && m[2] && m[3]) push(`${m[1]}/${m[2]}#${m[3]}`);
  }
  for (const m of sample.matchAll(ALERT_TEXT_RE)) {
    if (m[1] && m[2]) push(`${m[1]}:${m[2]}`);
  }
  for (const m of sample.matchAll(TYPED_OBJ_TEXT_RE)) {
    if (m[1] && m[2]) push(`${m[1]}:${m[2]}`);
  }
  for (const m of sample.matchAll(BARE_ISSUE_RE)) {
    if (m[1] && m[2] && isLikelyIssueKey(m[1])) {
      push(`${m[1]}-${m[2]}`);
    }
  }

  return Array.from(found);
}

/**
 * Normalizes a list of raw candidate keys/focus items, additionally extracting
 * embedded deterministic issue keys from branch tokens (e.g. `meru-mind@fix/eng-42-auth`
 * yields BOTH `branch:meru-mind@fix/eng-42-auth` AND `work:linear:ENG-42`).
 */
export function normalizeTargetKeys(rawKeys: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const raw of rawKeys) {
    if (out.size >= MAX_TARGET_KEYS) break;
    const trimmed = cleanControl(String(raw ?? ""));
    if (!trimmed) continue;
    const norm = normalizeDeterministicKey(trimmed);
    if (norm) {
      out.add(norm);
      if (norm.startsWith("branch:")) {
        for (const embedded of extractDeterministicKeysFromText(norm.slice(7))) {
          if (out.size >= MAX_TARGET_KEYS) break;
          out.add(embedded);
        }
      }
    }
  }
  return Array.from(out);
}

export function describeTargetKey(key: string): {
  kind: PulseTargetKind;
  label: string;
} {
  if (key.startsWith("work:linear:")) {
    return { kind: "linear", label: key.slice("work:linear:".length) };
  }
  if (key.startsWith("work:github:")) {
    return { kind: "github", label: key.slice("work:github:".length) };
  }
  if (key.startsWith("alert:")) {
    return { kind: "alert", label: key };
  }
  if (key.startsWith("approval:")) {
    return { kind: "approval", label: key };
  }
  if (key.startsWith("branch:")) {
    return { kind: "branch", label: key.slice("branch:".length) };
  }
  if (key.startsWith("file:")) {
    return { kind: "file", label: key.slice("file:".length) };
  }
  return { kind: "object", label: key };
}
