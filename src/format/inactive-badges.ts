import type { DbPort } from "../ports.js";
import { MindError, type MindObject, type ObjectAlias } from "../types.js";

const CJK_CHAR_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_GLOBAL_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const ASCII_ALNUM_RE = /[A-Za-z0-9]/;
const LATIN_CONNECTOR_RE = /[._:/-]/;
export const OBJECT_STATE_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const ISO_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MAX_EXPLICIT_ALIASES_PER_OBJECT = 32;
export const MAX_ALIAS_LENGTH = 80;

/**
 * Normalizes an object name or alias for case-insensitive matching and ambiguity checks.
 */
export function normalizeAlias(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_/-]+/g, " ")
    .trim();
}

/**
 * Validates whether (year, month, day) is a real calendar date (handles leap years accurately).
 */
export function isValidCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

export function validateStrictIsoDate(raw: string, flagName = "--since"): string {
  const trimmed = raw.trim();
  const m = ISO_DATE_ONLY_RE.exec(trimmed);
  if (!m) {
    throw new MindError(
      "INVALID_INPUT",
      `${flagName} must be a valid YYYY-MM-DD calendar date, got "${raw}"`,
    );
  }
  const year = Number.parseInt(m[1]!, 10);
  const month = Number.parseInt(m[2]!, 10);
  const day = Number.parseInt(m[3]!, 10);
  if (!isValidCalendarDate(year, month, day)) {
    throw new MindError(
      "INVALID_INPUT",
      `${flagName} is not a real calendar date: "${raw}"`,
    );
  }
  return trimmed;
}

/**
 * Minimum length gate for mention-eligible aliases:
 * - Contains CJK: requires >= 2 CJK characters
 * - Pure Latin/alnum: requires >= 3 non-space characters
 */
export function isEligibleAliasForm(aliasNorm: string): boolean {
  if (!aliasNorm) return false;
  if (CJK_CHAR_RE.test(aliasNorm)) {
    const cjkMatches = aliasNorm.match(CJK_GLOBAL_RE);
    return (cjkMatches?.length ?? 0) >= 2;
  }
  const compact = aliasNorm.replace(/\s+/g, "");
  return compact.length >= 3;
}

export function validateExplicitAliasInput(raw: string): {
  alias: string;
  aliasNorm: string;
} {
  if (/[\r\n]/.test(raw)) {
    throw new MindError(
      "INVALID_INPUT",
      "Alias must be a single line with no newline characters",
    );
  }
  const alias = raw.trim();
  if (!alias) {
    throw new MindError("INVALID_INPUT", "Alias cannot be empty");
  }
  if (alias.length > MAX_ALIAS_LENGTH) {
    throw new MindError(
      "INVALID_INPUT",
      `Alias exceeds maximum length of ${MAX_ALIAS_LENGTH} characters`,
    );
  }
  const aliasNorm = normalizeAlias(alias);
  if (!isEligibleAliasForm(aliasNorm)) {
    throw new MindError(
      "INVALID_INPUT",
      `Alias "${alias}" is too short (Latin aliases require >= 3 chars; CJK aliases require >= 2 CJK chars)`,
    );
  }
  return { alias, aliasNorm };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAsciiAlnum(ch: string): boolean {
  return ch.length === 1 && ASCII_ALNUM_RE.test(ch);
}

function isLatinConnector(ch: string): boolean {
  return ch.length === 1 && LATIN_CONNECTOR_RE.test(ch);
}

export interface CompiledAliasMatcher {
  aliasNorm: string;
  pureCjkSingleToken: boolean;
  regex: RegExp | null;
  startsAsciiAlnum: boolean;
  endsAsciiAlnum: boolean;
}

export function compileAliasMatcher(aliasNorm: string): CompiledAliasMatcher {
  const tokens = aliasNorm.split(" ").filter(Boolean);
  const firstChar = aliasNorm[0] ?? "";
  const lastChar = aliasNorm[aliasNorm.length - 1] ?? "";
  const startsAsciiAlnum = isAsciiAlnum(firstChar);
  const endsAsciiAlnum = isAsciiAlnum(lastChar);

  if (tokens.length === 1 && !startsAsciiAlnum && !endsAsciiAlnum) {
    return {
      aliasNorm,
      pureCjkSingleToken: true,
      regex: null,
      startsAsciiAlnum: false,
      endsAsciiAlnum: false,
    };
  }

  const pattern = tokens.map(escapeRegex).join("[\\s_/-]+");
  return {
    aliasNorm,
    pureCjkSingleToken: false,
    regex: new RegExp(pattern, "gi"),
    startsAsciiAlnum,
    endsAsciiAlnum,
  };
}

/**
 * Matches a compiled alias form against NFKC-normalized text using:
 * - Exact substring matching for CJK
 * - Connector-aware boundary rejection (`[._:/-]`) for Latin/alnum edges so
 *   `api` rejects `payment-api`, `api/v2`, `api_key`, `api.example.com`,
 *   while `alex` still matches `交接给 alex.`, `alex: ok`, and `给alex吧`.
 */
export function matchesCompiledAlias(
  nfkcText: string,
  nfkcLowerText: string,
  matcher: CompiledAliasMatcher,
): boolean {
  if (matcher.pureCjkSingleToken) {
    return nfkcLowerText.includes(matcher.aliasNorm);
  }
  const re = matcher.regex!;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(nfkcText)) !== null) {
    const start = m.index;
    const end = start + m[0]!.length;

    let badLeft = false;
    if (matcher.startsAsciiAlnum && start > 0) {
      const prev1 = nfkcText[start - 1]!;
      const prev2 = start > 1 ? nfkcText[start - 2]! : "";
      badLeft =
        isAsciiAlnum(prev1) ||
        (isLatinConnector(prev1) && isAsciiAlnum(prev2));
    }

    let badRight = false;
    if (matcher.endsAsciiAlnum && end < nfkcText.length) {
      const next1 = nfkcText[end]!;
      const next2 = end + 1 < nfkcText.length ? nfkcText[end + 1]! : "";
      badRight =
        isAsciiAlnum(next1) ||
        (isLatinConnector(next1) && isAsciiAlnum(next2));
    }

    if (!badLeft && !badRight) {
      return true;
    }
    if (m[0]!.length === 0) {
      re.lastIndex += 1;
    }
  }
  return false;
}

export function matchesAliasForm(text: string, aliasNorm: string): boolean {
  if (!text || !aliasNorm) return false;
  const nfkc = text.normalize("NFKC");
  const matcher = compileAliasMatcher(aliasNorm);
  return matchesCompiledAlias(nfkc, nfkc.toLowerCase(), matcher);
}

/**
 * Determines whether an alias row on an inactive object participates in read-time mention matching:
 * - Explicit aliases (`isName === false` or `isExplicit === true`)
 * - Multi-token object names (`isName === true` with space in `aliasNorm`)
 * Single-token object names do NOT participate unless explicitly added as an alias.
 */
export function isAliasRowMentionEligible(row: ObjectAlias): boolean {
  if (!isEligibleAliasForm(row.aliasNorm)) return false;
  if (!row.isName || row.isExplicit) return true;
  return row.aliasNorm.includes(" ");
}

export function formatInactiveBadge(obj: MindObject): string {
  const label = obj.stateLabel?.trim() || "inactive";
  const sincePart = obj.stateSince ? ` ${obj.stateSince}` : "";
  return `${obj.kind}:${obj.name} ${label}${sincePart}`;
}

/**
 * Renders read-time exception-only badges for Markdown lines.
 * Returns empty string (0 chars) when no badges apply.
 * Caps visible badges at 2 plus `(+N)` when more than 2 apply.
 */
export function formatInactiveBadgesMarkdown(badges?: string[]): string {
  if (!badges || badges.length === 0) return "";
  const shown = badges.slice(0, 2);
  const extra = badges.length - shown.length;
  return ` ⚠ ${shown.join("; ")}${extra > 0 ? ` (+${extra})` : ""}`;
}

export interface InactiveBadgeResolver {
  resolveForItem(params: {
    itemId: string;
    linkedObjectIds: string[];
    text: string;
  }): string[];
}

/**
 * Builds a scoped read-time inactive-object badge resolver.
 * Zero-overhead fast path: returns `null` immediately when 0 visible inactive objects exist
 * (0 alias queries, 0 text scanning).
 * Ambiguity checks are strictly restricted to `readableLedgerIds` (P0-1 zero-leak).
 */
export function createInactiveBadgeResolver(
  db: DbPort,
  orgId: string,
  readableLedgerIds: string[],
): InactiveBadgeResolver | null {
  if (readableLedgerIds.length === 0) return null;

  const inactiveObjects = db.listInactiveObjects(orgId, readableLedgerIds);
  if (inactiveObjects.length === 0) {
    return null;
  }

  // Deterministic ordering for stable badge output
  inactiveObjects.sort((a, b) => {
    const keyA = `${a.kind}:${a.name}`.toLowerCase();
    const keyB = `${b.kind}:${b.name}`.toLowerCase();
    if (keyA !== keyB) return keyA.localeCompare(keyB);
    return a.id.localeCompare(b.id);
  });

  const inactiveById = new Map<string, MindObject>();
  const badgeById = new Map<string, string>();
  for (const obj of inactiveObjects) {
    inactiveById.set(obj.id, obj);
    badgeById.set(obj.id, formatInactiveBadge(obj));
  }

  const rawAliases = db.listObjectAliases(inactiveObjects.map((o) => o.id));
  const candidateAliases = rawAliases.filter(isAliasRowMentionEligible);

  const uniqueNorms = Array.from(
    new Set(candidateAliases.map((a) => a.aliasNorm)),
  );
  const visibleOwnerCounts =
    uniqueNorms.length > 0
      ? db.countVisibleAliasOwners({
          orgId,
          realmIds: readableLedgerIds,
          aliasNorms: uniqueNorms,
        })
      : new Map<string, number>();

  // Compile unambiguous matchers per inactive object
  const matchersByObject: Array<{
    obj: MindObject;
    matchers: CompiledAliasMatcher[];
  }> = [];
  const aliasesByObjectId = new Map<string, CompiledAliasMatcher[]>();
  for (const alias of candidateAliases) {
    if ((visibleOwnerCounts.get(alias.aliasNorm) ?? 0) >= 2) {
      continue;
    }
    const list = aliasesByObjectId.get(alias.objectId) ?? [];
    list.push(compileAliasMatcher(alias.aliasNorm));
    aliasesByObjectId.set(alias.objectId, list);
  }
  for (const obj of inactiveObjects) {
    const matchers = aliasesByObjectId.get(obj.id);
    if (matchers && matchers.length > 0) {
      matchersByObject.push({ obj, matchers });
    }
  }

  return {
    resolveForItem(params: {
      itemId: string;
      linkedObjectIds: string[];
      text: string;
    }): string[] {
      const matchedIds = new Set<string>();

      // (a) Explicitly linked visible inactive objects
      for (const oid of params.linkedObjectIds) {
        const obj = inactiveById.get(oid);
        if (!obj) continue;
        if (obj.stateEvidenceId && obj.stateEvidenceId === params.itemId) {
          continue;
        }
        matchedIds.add(obj.id);
      }

      // (b) Conservative mention matching in displayed text
      if (matchersByObject.length > 0 && params.text) {
        const nfkc = params.text.normalize("NFKC");
        const nfkcLower = nfkc.toLowerCase();
        for (const entry of matchersByObject) {
          if (matchedIds.has(entry.obj.id)) continue;
          if (
            entry.obj.stateEvidenceId &&
            entry.obj.stateEvidenceId === params.itemId
          ) {
            continue;
          }
          for (const m of entry.matchers) {
            if (matchesCompiledAlias(nfkc, nfkcLower, m)) {
              matchedIds.add(entry.obj.id);
              break;
            }
          }
        }
      }

      if (matchedIds.size === 0) return [];
      const out: string[] = [];
      for (const obj of inactiveObjects) {
        if (matchedIds.has(obj.id)) {
          out.push(badgeById.get(obj.id)!);
        }
      }
      return out;
    },
  };
}
