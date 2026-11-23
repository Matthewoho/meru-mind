import { isValidCalendarDate } from "../format/inactive-badges.js";
import type { DateWindowSpec } from "../ports.js";

const CJK_CHAR_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/** Single source of truth for ASCII alphanumeric word characters (aligned with SQLite FTS5 unicode61, where `_` is a separator). */
export const ASCII_WORD_CLASS = "A-Za-z0-9";
/** Strict delimiter boundary class preserved for hyphen/slash/colon identifiers (e.g., `agent-worker` != `agent-worker-bridge`). */
export const IDENTIFIER_STRICT_BOUNDARY_CLASS = "A-Za-z0-9:/-";
/** Superset character class for 1-char passage seam padding in SeaEngine (never creates a false boundary). */
export const PASSAGE_SEAM_WORD_RE = /[A-Za-z0-9_:/-]/;

/**
 * Normalizes mixed CJK + Latin text for SQLite FTS5 unicode61:
 * - Preserves Latin/numeric words and exact word boundaries.
 * - Inserts spaces at CJK <-> Latin/digit boundaries so tokens never fuse.
 * - For contiguous CJK runs (Han/Hiragana/Katakana/Hangul):
 *   - L === 1: emits the single character (e.g. "锁").
 *   - L >= 2: emits overlapping 2-char bigram tokens plus the trailing character
 *     (e.g. "发布平台" -> "发布 布平 平台 台") for single-token posting lookups
 *     with zero cross-punctuation false positives.
 */
export function normalizeForFts(text: string): string {
  return text
    .replace(CJK_RUN_RE, (run) => {
      const chars = Array.from(run);
      if (chars.length === 1) {
        return ` ${chars[0]!} `;
      }
      const tokens: string[] = [];
      for (let i = 0; i < chars.length - 1; i += 1) {
        tokens.push(`${chars[i]!}${chars[i + 1]!}`);
      }
      tokens.push(chars[chars.length - 1]!);
      return ` ${tokens.join(" ")} `;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const EN_STOPWORDS = new Set([
  "find",
  "search",
  "about",
  "related",
  "show",
  "list",
  "get",
  "what",
  "is",
  "are",
  "the",
  "for",
  "of",
  "in",
  "on",
  "to",
  "with",
  "check",
  "look",
  "lookup",
  "query",
  "please",
  "tell",
  "me",
  "a",
  "an",
]);

/** Standalone length-1 CJK particles dropped ONLY when separated and >=1 concrete concept remains */
const CJK_STANDALONE_PARTICLES = new Set([
  "把",
  "从",
  "的",
  "了",
  "吗",
  "呢",
  "啊",
  "在",
  "里",
  "给",
  "被",
  "将",
]);

/** Complete 2-char CJK filler bigrams filtered ONLY after generating overlapping bigrams from intact segments */
const CJK_BIGRAM_STOPWORDS = new Set([
  "什么",
  "为什",
  "上次",
  "现在",
  "已经",
  "关于",
  "相关",
  "一下",
  "查一",
  "查找",
  "搜索",
  "查询",
  "帮我",
  "请问",
  "看看",
  "有没",
  "没有",
  "怎么",
  "如何",
  "哪些",
  "可以",
  "应该",
  "需要",
  "还是",
  "或者",
  "以及",
  "的是",
  "了吗",
  "了没",
]);

const SEGMENT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[A-Za-z0-9_]+(?:[-/:.][A-Za-z0-9_]+)*/gu;

export const CJK_COVERAGE_THRESHOLD = 0.75;

export interface SearchConcept {
  raw: string;
  ftsPhrase: string;
  /** Retained terms for matching (2-char bigrams for CJK len>=3, [raw] for len 1-2 or non-CJK) */
  terms: string[];
  /** Optional branch-and-bound pre-filter needles (e.g. longest subtoken for multi-word snake_case concepts) */
  prefilterTerms?: string[];
  /** Boundary-aware regex for non-CJK concepts (reused by snippet span matcher so display matches scoring) */
  matchRegex?: RegExp;
  /** FTS5 expression for this concept: `"t"`, `"c"*`, or `("b1" OR "b2" ...)` */
  ftsGroupExpr: string;
  isCjk: boolean;
  isIdentifier: boolean;
  /** Continuous coverage score in [0, 1]; optional pre-lowercased text avoids repeated .toLowerCase() */
  scoreText(text: string, lowerText?: string): number;
  /** Covered per pre-registered threshold (>= 0.75 for CJK, 1.0 for non-CJK) */
  matchText(text: string, lowerText?: string): boolean;
}

export interface DateConcept {
  raw: string;
  year: number | null;
  month: number;
  day: number;
  /** Canonical display label, e.g. "2026-10-10" or "10-10" */
  label: string;
  /** ±1 calendar day UTC window spec */
  window: DateWindowSpec;
  /** Canonical FTS5 OR expression covering padded/unpadded ISO, ISO-T prefix, and Chinese 日/号 prefix phrases */
  ftsLiteralExpr: string;
  /** True iff occurredAt UTC date prefix falls within ±1 calendar day */
  matchOccurredAt(occurredAt: string | null): boolean;
  /** True iff body/title text matches any literal variant accepted by ftsLiteralExpr */
  matchLiteralText(text: string): boolean;
}

export interface ParsedSearchQuery {
  concepts: SearchConcept[];
  /** Pass 1 (AND across all concepts; multi-bigram CJK uses OR inside parenthesized group) */
  ftsAndExpression: string | null;
  /** Pass 2 (OR across all concepts/bigrams) */
  ftsOrExpression: string | null;
  /** Backward-compatible alias for ftsOrExpression */
  ftsExpression: string | null;
  hasIdentifiers: boolean;
  /** Present ONLY when parseSearchQuery is called with { extractDates: true } */
  dateConcepts?: DateConcept[];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatUtcYmd(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function formatUtcMd(ms: number): string {
  const dt = new Date(ms);
  return `${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * Canonical FTS5 literal expression for a parsed date concept:
 * - Full Cartesian product of padded/unpadded month & day
 * - ISO numeric + ISO timestamp T-prefix (`"2026 10 10t"*`) when year is specified
 * - Chinese `YYYY 年 M 月 D 日/号*` (when year specified) + `M 月 D 日/号*` (always),
 *   using FTS5 prefix-phrase idiom to match contiguous `"10月10日上线"` and `日`↔`号`.
 */
export function buildDateLiteralFtsExpr(dc: {
  year: number | null;
  month: number;
  day: number;
}): string {
  const mVariants = Array.from(new Set([String(dc.month), pad2(dc.month)]));
  const dVariants = Array.from(new Set([String(dc.day), pad2(dc.day)]));
  const clauses: string[] = [];
  const seen = new Set<string>();
  const add = (expr: string) => {
    if (!seen.has(expr)) {
      seen.add(expr);
      clauses.push(expr);
    }
  };

  if (dc.year !== null) {
    const y = String(dc.year);
    for (const m of mVariants) {
      for (const d of dVariants) {
        add(`"${y} ${m} ${d}"`);
        add(`"${y} ${m} ${d}t"*`);
        add(`"${y} 年 ${m} 月 ${d} 日"*`);
        add(`"${y} 年 ${m} 月 ${d} 号"*`);
      }
    }
  }
  for (const m of mVariants) {
    for (const d of dVariants) {
      add(`"${m} 月 ${d} 日"*`);
      add(`"${m} 月 ${d} 号"*`);
    }
  }

  return clauses.join(" OR ");
}

function makeDateConcept(
  raw: string,
  year: number | null,
  month: number,
  day: number,
): DateConcept {
  const DAY_MS = 86_400_000;
  let window: DateWindowSpec;
  let matchOccurredAt: (occurredAt: string | null) => boolean;

  if (year !== null) {
    const centerMs = Date.UTC(year, month - 1, day);
    const startDate = formatUtcYmd(centerMs - DAY_MS);
    const endDate = formatUtcYmd(centerMs + DAY_MS);
    window = { startDate, endDate };
    matchOccurredAt = (occurredAt: string | null): boolean => {
      if (!occurredAt || occurredAt.length < 10) return false;
      const prefix = occurredAt.slice(0, 10);
      return prefix >= startDate && prefix <= endDate;
    };
  } else {
    const mdSet = new Set<string>();
    for (const refYear of [2024, 2025]) {
      if (!isValidCalendarDate(refYear, month, day)) continue;
      const centerMs = Date.UTC(refYear, month - 1, day);
      mdSet.add(formatUtcMd(centerMs - DAY_MS));
      mdSet.add(formatUtcMd(centerMs));
      mdSet.add(formatUtcMd(centerMs + DAY_MS));
    }
    const monthDays = Array.from(mdSet).sort();
    window = { monthDays };
    matchOccurredAt = (occurredAt: string | null): boolean => {
      if (!occurredAt || occurredAt.length < 10) return false;
      return mdSet.has(occurredAt.slice(5, 10));
    };
  }

  const label =
    year !== null
      ? `${year}-${pad2(month)}-${pad2(day)}`
      : `${pad2(month)}-${pad2(day)}`;
  const ftsLiteralExpr = buildDateLiteralFtsExpr({ year, month, day });

  const mPat = month < 10 ? `0?${month}` : String(month);
  const dPat = day < 10 ? `0?${day}` : String(day);

  const isoBodyRe =
    year !== null
      ? new RegExp(
          `(?<!\\d)${year}[-/.\\s]${mPat}[-/.\\s]${dPat}(?!\\d)`,
          "i",
        )
      : null;
  const cnFullBodyRe =
    year !== null
      ? new RegExp(`(?<!\\d)${year}\\s*年\\s*${mPat}\\s*月\\s*${dPat}\\s*[日号]`)
      : null;
  const cnMdBodyRe = new RegExp(
    `(?<!\\d)${mPat}\\s*月\\s*${dPat}\\s*[日号]`,
    "g",
  );
  const numericMdBodyRe =
    year === null
      ? new RegExp(`(?<!\\d)${mPat}[-/]${dPat}(?!\\d|[-/]\\d)`)
      : null;

  const matchLiteralText = (text: string): boolean => {
    if (!text) return false;
    if (year !== null) {
      if (isoBodyRe!.test(text)) return true;
      if (cnFullBodyRe!.test(text)) return true;
      cnMdBodyRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = cnMdBodyRe.exec(text)) !== null) {
        const before = text.slice(Math.max(0, m.index - 12), m.index);
        const yearPrefix = /(\d{4})\s*年\s*$/.exec(before);
        if (yearPrefix && Number.parseInt(yearPrefix[1]!, 10) !== year) {
          continue;
        }
        return true;
      }
      return false;
    }
    cnMdBodyRe.lastIndex = 0;
    if (cnMdBodyRe.test(text)) return true;
    if (numericMdBodyRe!.test(text)) return true;
    return false;
  };

  return {
    raw,
    year,
    month,
    day,
    label,
    window,
    ftsLiteralExpr,
    matchOccurredAt,
    matchLiteralText,
  };
}

const QUERY_ISO_DATE_RE =
  /(?<![A-Za-z0-9_./:-])(\d{4})-(\d{1,2})-(\d{1,2})(?![A-Za-z0-9_/-]|[.:][A-Za-z0-9_/-])/g;
const QUERY_CN_FULL_DATE_RE =
  /(?<![0-9])(\d{4})年(\d{1,2})月(\d{1,2})[日号]/g;
const QUERY_CN_MD_DATE_RE = /(?<![0-9])(\d{1,2})月(\d{1,2})[日号]/g;

function extractDateConceptsFromQuery(rawQuery: string): {
  strippedQuery: string;
  dateConcepts: DateConcept[];
} {
  const found: Array<{ index: number; concept: DateConcept }> = [];
  const seenLabels = new Set<string>();
  let working = rawQuery;

  working = working.replace(
    QUERY_ISO_DATE_RE,
    (match, yStr: string, mStr: string, dStr: string, offset: number) => {
      const year = Number.parseInt(yStr, 10);
      const month = Number.parseInt(mStr, 10);
      const day = Number.parseInt(dStr, 10);
      if (!isValidCalendarDate(year, month, day)) return match;
      const dc = makeDateConcept(match, year, month, day);
      if (!seenLabels.has(dc.label)) {
        seenLabels.add(dc.label);
        found.push({ index: offset, concept: dc });
      }
      return " ";
    },
  );

  working = working.replace(
    QUERY_CN_FULL_DATE_RE,
    (match, yStr: string, mStr: string, dStr: string, offset: number) => {
      const year = Number.parseInt(yStr, 10);
      const month = Number.parseInt(mStr, 10);
      const day = Number.parseInt(dStr, 10);
      if (!isValidCalendarDate(year, month, day)) return match;
      const dc = makeDateConcept(match, year, month, day);
      if (!seenLabels.has(dc.label)) {
        seenLabels.add(dc.label);
        found.push({ index: offset, concept: dc });
      }
      return " ";
    },
  );

  working = working.replace(
    QUERY_CN_MD_DATE_RE,
    (match, mStr: string, dStr: string, offset: number) => {
      const month = Number.parseInt(mStr, 10);
      const day = Number.parseInt(dStr, 10);
      if (!isValidCalendarDate(2024, month, day)) return match;
      const dc = makeDateConcept(match, null, month, day);
      if (!seenLabels.has(dc.label)) {
        seenLabels.add(dc.label);
        found.push({ index: offset, concept: dc });
      }
      return " ";
    },
  );

  found.sort((a, b) => a.index - b.index);
  return {
    strippedQuery: working,
    dateConcepts: found.map((f) => f.concept),
  };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteFtsPhrase(phrase: string): string {
  return `"${phrase.replace(/"/g, '""')}"`;
}

function formatCjkFtsTerm(term: string): string {
  const chars = Array.from(term);
  if (chars.length === 1) {
    return `${quoteFtsPhrase(term)}*`;
  }
  return quoteFtsPhrase(term);
}

function generateOverlappingBigrams(segment: string): string[] {
  const chars = Array.from(segment);
  if (chars.length <= 2) return [segment];
  const bigrams: string[] = [];
  for (let i = 0; i <= chars.length - 2; i += 1) {
    bigrams.push(`${chars[i]!}${chars[i + 1]!}`);
  }
  return bigrams;
}

function makeCjkConcept(raw: string): SearchConcept | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const chars = Array.from(trimmed);

  let terms: string[];
  if (chars.length <= 2) {
    terms = [trimmed];
  } else {
    const allBigrams = Array.from(new Set(generateOverlappingBigrams(trimmed)));
    const filtered = allBigrams.filter((bg) => !CJK_BIGRAM_STOPWORDS.has(bg));
    terms = filtered.length > 0 ? filtered : allBigrams;
  }

  const ftsPhrase = terms.join(" ");
  const lowerRaw = trimmed.toLowerCase();
  const lowerTerms = terms.map((t) => t.toLowerCase());
  const ftsTokens = terms.map((t) => formatCjkFtsTerm(t));
  const ftsGroupExpr =
    ftsTokens.length === 1 ? ftsTokens[0]! : `(${ftsTokens.join(" OR ")})`;

  const scoreText = (text: string, preLower?: string): number => {
    const lowerText = preLower ?? text.toLowerCase();
    if (lowerText.includes(lowerRaw)) {
      return 1.0;
    }
    if (lowerTerms.length === 1) {
      return lowerText.includes(lowerTerms[0]!) ? 1.0 : 0.0;
    }
    let matched = 0;
    for (const bg of lowerTerms) {
      if (lowerText.includes(bg)) {
        matched += 1;
      }
    }
    return matched / lowerTerms.length;
  };

  return {
    raw: trimmed,
    ftsPhrase,
    terms,
    ftsGroupExpr,
    isCjk: true,
    isIdentifier: false,
    scoreText,
    matchText: (text: string, preLower?: string) =>
      scoreText(text, preLower) >= CJK_COVERAGE_THRESHOLD,
  };
}

function makeNonCjkConcept(raw: string): SearchConcept | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Per-concept classification (v0.5.1 Option X):
  // - Hyphen/slash/colon identifiers keep strict delimiter isolation (`agent-worker` != `agent-worker-bridge`),
  //   with `_` removed from the lookaround since FTS5 unicode61 splits on `_`.
  // - Plain words and pure snake_case / dotted compounds split on `[^A-Za-z0-9]+`, matching FTS5 unicode61 100%.
  const isIdentifier = /[-/:]/.test(trimmed);
  const ftsTokens = trimmed
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (ftsTokens.length === 0) return null;
  const ftsPhrase = ftsTokens.join(" ");

  let boundaryRe: RegExp;
  let prefilterTerms: string[] | undefined;
  if (isIdentifier) {
    boundaryRe = new RegExp(
      `(?<![${IDENTIFIER_STRICT_BOUNDARY_CLASS}])${escapeRegExp(trimmed)}(?![${IDENTIFIER_STRICT_BOUNDARY_CLASS}])`,
      "i",
    );
  } else if (ftsTokens.length === 1) {
    boundaryRe = new RegExp(
      `(?<![${ASCII_WORD_CLASS}])${escapeRegExp(ftsTokens[0]!)}(?![${ASCII_WORD_CLASS}])`,
      "i",
    );
  } else {
    const phrasePattern = ftsTokens
      .map(escapeRegExp)
      .join(`[^${ASCII_WORD_CLASS}]+`);
    boundaryRe = new RegExp(
      `(?<![${ASCII_WORD_CLASS}])${phrasePattern}(?![${ASCII_WORD_CLASS}])`,
      "i",
    );
    // Longest subtoken is guaranteed present in any window matching the full multi-token phrase
    // (even when separators differ, e.g. MODEL_MANAGER_SERVER_ADDRESS vs model-manager-server-address).
    let longest = ftsTokens[0]!;
    for (let i = 1; i < ftsTokens.length; i += 1) {
      if (ftsTokens[i]!.length > longest.length) {
        longest = ftsTokens[i]!;
      }
    }
    prefilterTerms = [longest];
  }

  const scoreText = (text: string): number => (boundaryRe.test(text) ? 1.0 : 0.0);

  return {
    raw: trimmed,
    ftsPhrase,
    terms: [trimmed],
    ...(prefilterTerms ? { prefilterTerms } : {}),
    matchRegex: boundaryRe,
    ftsGroupExpr: quoteFtsPhrase(ftsPhrase),
    isCjk: false,
    isIdentifier,
    scoreText,
    matchText: (text: string) => boundaryRe.test(text),
  };
}

/**
 * Parses a mixed CJK + English + identifier query into concrete search concepts and staged FTS5 expressions.
 * Kept pure (zero Node/SQLite imports) so it works identically in Node 22 and future Cloudflare Workers / DO runtimes.
 */
export function parseSearchQuery(
  rawQuery: string,
  options?: { extractDates?: boolean },
): ParsedSearchQuery {
  const wantDates = options?.extractDates === true;
  let queryForSegments = rawQuery;
  let dateConcepts: DateConcept[] = [];
  if (wantDates) {
    const extracted = extractDateConceptsFromQuery(rawQuery);
    queryForSegments = extracted.strippedQuery;
    dateConcepts = extracted.dateConcepts;
  }

  const rawSegments = queryForSegments.match(SEGMENT_RE) ?? [];
  if (rawSegments.length === 0) {
    return {
      concepts: [],
      ftsAndExpression: null,
      ftsOrExpression: null,
      ftsExpression: null,
      hasIdentifiers: false,
      ...(wantDates ? { dateConcepts } : {}),
    };
  }

  const concreteRaw: string[] = [];
  const fallbackRaw: string[] = [];

  for (const seg of rawSegments) {
    fallbackRaw.push(seg);
    if (CJK_CHAR_RE.test(seg)) {
      const chars = Array.from(seg);
      if (chars.length === 1) {
        if (CJK_STANDALONE_PARTICLES.has(seg)) {
          continue;
        }
        concreteRaw.push(seg);
      } else if (chars.length === 2) {
        if (CJK_BIGRAM_STOPWORDS.has(seg)) {
          continue;
        }
        concreteRaw.push(seg);
      } else {
        const allBigrams = generateOverlappingBigrams(seg);
        const nonFiller = allBigrams.filter(
          (bg) => !CJK_BIGRAM_STOPWORDS.has(bg),
        );
        if (nonFiller.length > 0) {
          concreteRaw.push(seg);
        }
      }
    } else {
      if (!EN_STOPWORDS.has(seg.toLowerCase())) {
        concreteRaw.push(seg);
      }
    }
  }

  const chosen =
    concreteRaw.length > 0
      ? concreteRaw
      : dateConcepts.length > 0
        ? []
        : fallbackRaw;
  const seen = new Set<string>();
  const concepts: SearchConcept[] = [];
  for (const raw of chosen) {
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const concept = CJK_CHAR_RE.test(raw)
      ? makeCjkConcept(raw)
      : makeNonCjkConcept(raw);
    if (concept) {
      concepts.push(concept);
    }
  }

  if (concepts.length === 0) {
    return {
      concepts: [],
      ftsAndExpression: null,
      ftsOrExpression: null,
      ftsExpression: null,
      hasIdentifiers: false,
      ...(wantDates ? { dateConcepts } : {}),
    };
  }

  const ftsAndExpression =
    concepts.length === 1
      ? concepts[0]!.ftsGroupExpr
      : concepts.map((c) => c.ftsGroupExpr).join(" AND ");

  const orClauses: string[] = [];
  const seenOr = new Set<string>();
  for (const c of concepts) {
    if (c.isCjk) {
      for (const t of c.terms) {
        const tokenExpr = formatCjkFtsTerm(t);
        if (!seenOr.has(tokenExpr)) {
          seenOr.add(tokenExpr);
          orClauses.push(tokenExpr);
        }
      }
    } else {
      const phrase = quoteFtsPhrase(c.ftsPhrase);
      if (!seenOr.has(phrase)) {
        seenOr.add(phrase);
        orClauses.push(phrase);
      }
    }
  }
  const ftsOrExpression = orClauses.join(" OR ");

  return {
    concepts,
    ftsAndExpression,
    ftsOrExpression,
    ftsExpression: ftsOrExpression,
    hasIdentifiers: concepts.some((c) => c.isIdentifier),
    ...(wantDates ? { dateConcepts } : {}),
  };
}

export function buildFtsMatchExpression(rawQuery: string): string | null {
  return parseSearchQuery(rawQuery).ftsOrExpression;
}

/**
 * Generates SQL `?` placeholders. Centralized here so future Cloudflare DO adapters
 * (100-bound-parameter limit) can replace IN (...) cleanly from one helper.
 */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Computes exact highlight character ranges [start, end) in `text` for a search query.
 * Used by v0.4 composable frontend clients so highlight rendering never requires raw HTML from the server.
 */
export function computeHighlightRanges(
  text: string,
  query: string,
): Array<[number, number]> {
  if (!text || !query.trim()) return [];
  const parsed = parseSearchQuery(query);
  const terms: string[] = [];
  for (const c of parsed.concepts) {
    if (c.isCjk) {
      terms.push(c.raw, ...c.terms);
    } else {
      terms.push(c.raw);
    }
  }
  const uniqueTerms = Array.from(new Set(terms.filter((t) => t.length > 0))).sort(
    (a, b) => b.length - a.length,
  );
  if (uniqueTerms.length === 0) return [];

  const lower = text.toLowerCase();
  const rawRanges: Array<[number, number]> = [];
  for (const term of uniqueTerms) {
    const needle = term.toLowerCase();
    let idx = lower.indexOf(needle);
    while (idx !== -1 && rawRanges.length < 64) {
      rawRanges.push([idx, idx + needle.length]);
      idx = lower.indexOf(needle, idx + needle.length);
    }
  }
  if (rawRanges.length === 0) return [];
  rawRanges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  const merged: Array<[number, number]> = [];
  for (const [s, e] of rawRanges) {
    const prev = merged[merged.length - 1];
    if (prev && s <= prev[1]) {
      prev[1] = Math.max(prev[1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}
