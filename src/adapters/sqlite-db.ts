import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import {
  isValidCalendarDate,
  normalizeAlias,
} from "../format/inactive-badges.js";
import { buildRecordFtsBody } from "../format/snippet.js";
import type {
  DateWindowMatch,
  DateWindowQueryParams,
  DateWindowQueryResult,
  DateWindowSpec,
  DbPort,
  FtsMatch,
  PendingVectorItem,
  RealmRecordCountRow,
  UnifiedEntryRef,
  UnifiedFtsSearchParams,
  UnifiedFtsSearchResult,
  VectorMatch,
} from "../ports.js";
import {
  MindError,
  type ChangeLogEntry,
  type Distillation,
  type DistillationLayer,
  type DriveFileMeta,
  type EntryObjectLink,
  type IdempotencyRecord,
  type LedgerRecord,
  type MindObject,
  type ObjectAlias,
  type ObjectState,
  type Organization,
  type OrgPolicy,
  type Realm,
  type RealmMount,
  type RecordKind,
  type RedactedBlocklistEntry,
  type ResourceTag,
  type ResourceTagSummary,
  type SchemaMigrationRecord,
  type SeabedEntry,
  type SeabedKind,
  type Sensitivity,
  type WalCheckpointResult,
} from "../types.js";

export interface SqliteDbOptions {
  dbPath: string;
  vectorDimensions?: number;
  enableVector?: boolean;
}

const DEFAULT_VECTOR_DIM = 1536;
const DEFAULT_BUSY_TIMEOUT_MS = 30000;

const CJK_CHAR_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

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
    // Compute ±1 day across BOTH leap year (2024) and non-leap year (2025)
    // so e.g. year-less 3月1日 includes BOTH 02-28 and 02-29, and Dec 31 <-> Jan 1 rolls over cleanly.
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

  // Body-side JS matcher: digit-only boundaries matching everything ftsLiteralExpr accepts,
  // while rejecting mismatched YYYY年 on year-qualified queries and rejecting 2010-10-05 for 10-10.
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
        const before = text.slice(0, m.index);
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

// Strict extraction order:
// 1. ISO full date (relaxes sentence-end `2026-10-10.` / `2026-10-10:` while NOT slicing `backup_2026-10-10`, `2026-10-10T08:00`, `file:/ops/2026-10-10.md`)
const QUERY_ISO_DATE_RE =
  /(?<![A-Za-z0-9_./:-])(\d{4})-(\d{1,2})-(\d{1,2})(?![A-Za-z0-9_/-]|[.:][A-Za-z0-9_/-])/g;
// 2. Chinese full date (MUST run before Chinese month-day)
const QUERY_CN_FULL_DATE_RE =
  /(?<![0-9])(\d{4})年(\d{1,2})月(\d{1,2})[日号]/g;
// 3. Chinese month-day
const QUERY_CN_MD_DATE_RE = /(?<![0-9])(\d{1,2})月(\d{1,2})[日号]/g;

function extractDateConceptsFromQuery(rawQuery: string): {
  strippedQuery: string;
  dateConcepts: DateConcept[];
} {
  const found: Array<{ index: number; concept: DateConcept }> = [];
  const seenLabels = new Set<string>();
  let working = rawQuery;

  // Replace each valid date match with a SINGLE SPACE (" ") so adjacent CJK chars never fuse.
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
      // Use leap year 2024 so year-less 2月29日 is accepted while 2月30日 / 4月31日 are rejected
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
    // Prefix match catches every bigram starting with this character PLUS the trailing single character
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

  const isIdentifier = /[-/:]/.test(trimmed);
  const ftsTokens = trimmed
    .split(/[^A-Za-z0-9_]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (ftsTokens.length === 0) return null;
  const ftsPhrase = ftsTokens.join(" ");
  const boundaryRe = isIdentifier
    ? new RegExp(
        `(?<![A-Za-z0-9_:/-])${escapeRegExp(trimmed)}(?![A-Za-z0-9_:/-])`,
        "i",
      )
    : new RegExp(
        `(?<![A-Za-z0-9_])${escapeRegExp(trimmed)}(?![A-Za-z0-9_])`,
        "i",
      );

  const scoreText = (text: string): number => (boundaryRe.test(text) ? 1.0 : 0.0);

  return {
    raw: trimmed,
    ftsPhrase,
    terms: [trimmed],
    ftsGroupExpr: quoteFtsPhrase(ftsPhrase),
    isCjk: false,
    isIdentifier,
    scoreText,
    matchText: (text: string) => boundaryRe.test(text),
  };
}

/**
 * Parses a mixed CJK + English + identifier query into concrete search concepts and staged FTS5 expressions:
 * - NEVER deletes characters from inside a contiguous Han/CJK segment (preserving compounds like "上线"/"下线"/"在线").
 * - Length-1 standalone CJK particles are dropped ONLY when separated and >=1 concrete concept remains (so "锁" works).
 * - Length-2 CJK segments stay atomic (dropping standalone 2-char filler segments only when >=1 concrete concept remains).
 * - Length >= 3 CJK segments emit all overlapping 2-char bigrams from the intact segment, filtering ONLY complete
 *   2-char filler bigrams when >=1 non-stopword bigram remains.
 * - Hyphen/slash/colon identifiers (e.g. agent-worker, api/v2, redis:6379) keep exact JS boundary matchers.
 * - Produces both Pass-1 AND expression (`ftsAndExpression`) and Pass-2 OR expression (`ftsOrExpression`).
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
        // Length >= 3: NEVER delete characters from inside the segment;
        // drop the whole segment ONLY if EVERY overlapping bigram is a filler bigram.
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

  // Only strip stopwords/particles when at least one concrete concept remains;
  // when dateConcepts were extracted and only stopwords remain (e.g. "查一下10月10日"),
  // skip raw-segment fallback so the query routes cleanly to pure-date mode.
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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function appendSensitivityExclusion(
  where: string[],
  params: SQLInputValue[],
  column: string,
  excludeSensitivities: Sensitivity[],
): void {
  const unique = Array.from(new Set(excludeSensitivities));
  for (const s of unique) {
    if (s === "secret") {
      where.push(`${column} != 'secret'`);
    } else if (s === "confidential") {
      where.push(`${column} != 'confidential'`);
    } else if (s === "internal") {
      where.push(`${column} != 'internal'`);
    } else if (s === "public") {
      where.push(`${column} != 'public'`);
    } else {
      where.push(`${column} != ?`);
      params.push(s);
    }
  }
}

function normalizeL2(embedding: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < embedding.length; i += 1) {
    const v = embedding[i]!;
    sumSq += v * v;
  }
  if (sumSq === 0) return embedding;
  const invNorm = 1 / Math.sqrt(sumSq);
  const out = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i += 1) {
    out[i] = embedding[i]! * invNorm;
  }
  return out;
}

function toVecBlob(embedding: Float32Array): Uint8Array {
  const unit = normalizeL2(embedding);
  return new Uint8Array(unit.buffer, unit.byteOffset, unit.byteLength);
}

function sleepSyncMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

function isSqliteBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY/i.test(msg);
}

export class SqliteDb implements DbPort {
  private readonly rawDb: DatabaseSync;
  private readonly db: {
    prepare: DatabaseSync["prepare"];
    exec: DatabaseSync["exec"];
    close: DatabaseSync["close"];
  };
  readonly vecEnabled: boolean;
  readonly vectorDimensions: number;
  private inTransaction = false;
  private queryCount = 0;

  constructor(options: SqliteDbOptions) {
    this.vectorDimensions = options.vectorDimensions ?? DEFAULT_VECTOR_DIM;
    if (
      !Number.isInteger(this.vectorDimensions) ||
      this.vectorDimensions <= 0
    ) {
      throw new MindError(
        "INVALID_INPUT",
        `vectorDimensions must be a positive integer, got ${this.vectorDimensions}`,
      );
    }

    if (options.dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    }

    const wantVec = options.enableVector ?? true;
    const rawDb = new DatabaseSync(options.dbPath, {
      allowExtension: wantVec,
    });
    this.rawDb = rawDb;
    const self = this;
    this.db = {
      prepare(sql: string) {
        const stmt = rawDb.prepare(sql);
        const origGet = stmt.get.bind(stmt);
        const origAll = stmt.all.bind(stmt);
        const origRun = stmt.run.bind(stmt);
        stmt.get = ((...args: SQLInputValue[]) => {
          self.queryCount += 1;
          return origGet(...args);
        }) as typeof stmt.get;
        stmt.all = ((...args: SQLInputValue[]) => {
          self.queryCount += 1;
          return origAll(...args);
        }) as typeof stmt.all;
        stmt.run = ((...args: SQLInputValue[]) => {
          self.queryCount += 1;
          return origRun(...args);
        }) as typeof stmt.run;
        return stmt;
      },
      exec(sql: string) {
        return rawDb.exec(sql);
      },
      close() {
        return rawDb.close();
      },
    };

    this.db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
    this.execPragmaWithBusyRetry("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA secure_delete = ON;");

    let loadedVec = false;
    if (wantVec) {
      try {
        sqliteVec.load(this.rawDb);
        loadedVec = true;
      } catch {
        loadedVec = false;
      }
    }
    this.vecEnabled = loadedVec;
    this.initSchema();
  }

  getQueryCount(): number {
    return this.queryCount;
  }

  resetQueryCount(): void {
    this.queryCount = 0;
  }

  private execPragmaWithBusyRetry(sql: string, maxAttempts = 25): void {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        this.db.exec(sql);
        return;
      } catch (err) {
        if (!isSqliteBusyError(err) || attempt === maxAttempts) {
          throw err;
        }
        sleepSyncMs(5 + Math.floor(Math.random() * 20));
      }
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    return rows.some((r) => String(r.name) === column);
  }

  private ensureColumn(
    table: string,
    column: string,
    definition: string,
  ): void {
    if (!this.hasColumn(table, column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE name = ? LIMIT 1`)
      .get(name) as { ok: number } | undefined;
    return Boolean(row);
  }

  private createVecItemsTable(): void {
    if (!this.vecEnabled) return;
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
        item_id TEXT PRIMARY KEY,
        realm_id TEXT PARTITION KEY,
        status TEXT,
        source_type TEXT,
        embedding FLOAT[${this.vectorDimensions}]
      );
    `);
  }

  private assertMinSqliteVersion(minMajor: number, minMinor: number): void {
    const row = this.db
      .prepare(`SELECT sqlite_version() AS v`)
      .get() as { v: string } | undefined;
    const raw = String(row?.v ?? "0.0.0");
    const parts = raw.split(".").map((p) => Number.parseInt(p, 10) || 0);
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    if (major < minMajor || (major === minMajor && minor < minMinor)) {
      throw new MindError(
        "INVALID_INPUT",
        `SQLite >= ${minMajor}.${minMinor}.0 is required for contentless_delete FTS5; got ${raw}`,
      );
    }
  }

  private initSchema(): void {
    this.assertMinSqliteVersion(3, 43);
    this.transaction(() => {
      const now = new Date().toISOString();

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO meta (key, value) VALUES ('change_log_generation', '1')`,
        )
        .run();

      const applied = new Set<number>(
        (
          this.db
            .prepare(`SELECT version FROM schema_migrations`)
            .all() as Array<{ version: number }>
        ).map((r) => Number(r.version)),
      );

      // Migration v1: V0.1 baseline schema
      if (!applied.has(1)) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS orgs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_personal_root INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS realms (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL REFERENCES orgs(id),
            parent_id TEXT REFERENCES realms(id),
            slug TEXT NOT NULL,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            archived_at TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(org_id, path)
          );
          CREATE INDEX IF NOT EXISTS idx_realms_org_parent ON realms(org_id, parent_id);

          CREATE TABLE IF NOT EXISTS realm_mounts (
            id TEXT PRIMARY KEY,
            viewer_realm_id TEXT NOT NULL REFERENCES realms(id),
            target_realm_id TEXT NOT NULL REFERENCES realms(id),
            scope TEXT NOT NULL,
            mounted_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(viewer_realm_id, target_realm_id)
          );
          CREATE INDEX IF NOT EXISTS idx_mounts_viewer ON realm_mounts(viewer_realm_id);

          CREATE TABLE IF NOT EXISTS seabed_entries (
            id TEXT PRIMARY KEY,
            realm_id TEXT NOT NULL REFERENCES realms(id),
            topic_id TEXT,
            kind TEXT NOT NULL,
            author_id TEXT NOT NULL,
            author_kind TEXT NOT NULL,
            author_family TEXT,
            text TEXT NOT NULL,
            blob_sha256 TEXT,
            source_ref TEXT,
            metadata_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_seabed_realm_time ON seabed_entries(realm_id, created_at DESC);

          CREATE TABLE IF NOT EXISTS records (
            id TEXT PRIMARY KEY,
            realm_id TEXT NOT NULL REFERENCES realms(id),
            thing_id TEXT,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            supersedes_id TEXT REFERENCES records(id),
            superseded_by_id TEXT REFERENCES records(id),
            author_id TEXT NOT NULL,
            author_kind TEXT NOT NULL,
            author_family TEXT,
            title TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            refs_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_records_realm_kind_status ON records(realm_id, kind, status, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_records_thing ON records(thing_id, created_at ASC);

          CREATE TABLE IF NOT EXISTS distillations (
            id TEXT PRIMARY KEY,
            realm_id TEXT NOT NULL REFERENCES realms(id),
            layer TEXT NOT NULL,
            period_key TEXT NOT NULL,
            status TEXT NOT NULL,
            hard_facts_json TEXT NOT NULL,
            narrative_md TEXT NOT NULL,
            source_ids_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_distill_realm_layer ON distillations(realm_id, layer, status, created_at DESC);

          CREATE TABLE IF NOT EXISTS drive_files (
            realm_id TEXT NOT NULL REFERENCES realms(id),
            rel_path TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            version INTEGER NOT NULL,
            updated_by TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (realm_id, rel_path)
          );

          CREATE VIRTUAL TABLE IF NOT EXISTS fts_index USING fts5(
            item_id UNINDEXED,
            source_type UNINDEXED,
            realm_id UNINDEXED,
            status UNINDEXED,
            title,
            body,
            tokenize = 'unicode61'
          );

          CREATE TABLE IF NOT EXISTS vec_pending (
            item_id TEXT PRIMARY KEY,
            source_type TEXT NOT NULL,
            realm_id TEXT NOT NULL,
            status TEXT NOT NULL,
            text TEXT NOT NULL
          );
        `);

        this.createVecItemsTable();

        this.db
          .prepare(
            `INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'v0.1_baseline', ?)`,
          )
          .run(now);
      }

      // Migration v2: V0.2a Slice 1a (org policy, provenance/sensitivity/redaction columns,
      // idempotency_keys, change_log, redacted_blocklist, vec_pending rebuild + re-enqueue)
      if (!applied.has(2)) {
        // 1. orgs.policy: nullable column, existing V0.1 orgs backfilled to 'tree'
        this.ensureColumn("orgs", "policy", "TEXT");
        this.db.exec(`UPDATE orgs SET policy = 'tree' WHERE policy IS NULL;`);

        // 2. seabed_entries incremental columns + backfills + indexes
        this.ensureColumn("seabed_entries", "org_id", "TEXT");
        this.ensureColumn("seabed_entries", "occurred_at", "TEXT");
        this.ensureColumn("seabed_entries", "origin_session_id", "TEXT");
        this.ensureColumn(
          "seabed_entries",
          "sensitivity",
          "TEXT NOT NULL DEFAULT 'internal'",
        );
        this.ensureColumn("seabed_entries", "redacted_at", "TEXT");
        this.ensureColumn("seabed_entries", "redacted_by", "TEXT");
        this.ensureColumn("seabed_entries", "redacted_reason", "TEXT");

        this.db.exec(`
          UPDATE seabed_entries
          SET org_id = (SELECT realms.org_id FROM realms WHERE realms.id = seabed_entries.realm_id)
          WHERE org_id IS NULL;
          UPDATE seabed_entries
          SET occurred_at = created_at
          WHERE occurred_at IS NULL;
          CREATE INDEX IF NOT EXISTS idx_seabed_org ON seabed_entries(org_id, occurred_at DESC);
          CREATE INDEX IF NOT EXISTS idx_seabed_realm_occurred ON seabed_entries(realm_id, occurred_at DESC);
        `);

        // 3. records incremental columns + backfills + indexes
        this.ensureColumn("records", "org_id", "TEXT");
        this.ensureColumn("records", "occurred_at", "TEXT");
        this.ensureColumn("records", "origin_session_id", "TEXT");
        this.ensureColumn(
          "records",
          "sensitivity",
          "TEXT NOT NULL DEFAULT 'internal'",
        );
        this.ensureColumn("records", "redacted_at", "TEXT");
        this.ensureColumn("records", "redacted_by", "TEXT");
        this.ensureColumn("records", "redacted_reason", "TEXT");
        this.ensureColumn(
          "records",
          "confirmed_by_human",
          "INTEGER NOT NULL DEFAULT 0",
        );
        this.ensureColumn("records", "ext_kind", "TEXT");

        this.db.exec(`
          UPDATE records
          SET org_id = (SELECT realms.org_id FROM realms WHERE realms.id = records.realm_id)
          WHERE org_id IS NULL;
          UPDATE records
          SET occurred_at = created_at
          WHERE occurred_at IS NULL;
          UPDATE records
          SET confirmed_by_human = 1
          WHERE author_kind = 'human' AND confirmed_by_human = 0;
          CREATE INDEX IF NOT EXISTS idx_records_org ON records(org_id, occurred_at DESC);
          CREATE INDEX IF NOT EXISTS idx_records_realm_occurred ON records(realm_id, occurred_at DESC);
        `);

        // 4. idempotency_keys, change_log, redacted_blocklist
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS idempotency_keys (
            org_id TEXT NOT NULL,
            key TEXT NOT NULL,
            target_table TEXT NOT NULL,
            target_id TEXT NOT NULL,
            realm_id TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (org_id, key)
          );

          CREATE TABLE IF NOT EXISTS change_log (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            generation INTEGER NOT NULL,
            org_id TEXT NOT NULL,
            realm_id TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            op TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_change_log_org_seq ON change_log(org_id, seq ASC);

          CREATE TABLE IF NOT EXISTS redacted_blocklist (
            org_id TEXT NOT NULL,
            source_ref TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            reason TEXT,
            redacted_at TEXT NOT NULL,
            PRIMARY KEY (org_id, source_ref, content_sha256)
          );
        `);

        // 5. Explicit vec_pending rebuild + C2 re-enqueue all non-secret, non-redacted entries missing from vec_items
        this.db.exec(`
          DROP TABLE IF EXISTS vec_pending;
          CREATE TABLE vec_pending (
            item_id TEXT PRIMARY KEY,
            source_type TEXT NOT NULL,
            org_id TEXT NOT NULL,
            realm_id TEXT NOT NULL,
            status TEXT NOT NULL,
            text TEXT NOT NULL,
            queued_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_vec_pending_queued ON vec_pending(queued_at ASC, item_id ASC);
        `);

        const existingVecIds = new Set<string>();
        if (this.vecEnabled && this.tableExists("vec_items")) {
          const vecRows = this.db
            .prepare(`SELECT item_id FROM vec_items`)
            .all() as Array<{ item_id: string }>;
          for (const vr of vecRows) {
            existingVecIds.add(String(vr.item_id));
          }
        }

        const insertPendingStmt = this.db.prepare(
          `INSERT OR REPLACE INTO vec_pending
           (item_id, source_type, org_id, realm_id, status, text, queued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );

        const recRows = this.db
          .prepare(
            `SELECT id, org_id, realm_id, status, title, payload_json
             FROM records
             WHERE redacted_at IS NULL AND sensitivity != 'secret' AND status != 'retracted'`,
          )
          .all() as Array<{
          id: string;
          org_id: string;
          realm_id: string;
          status: string;
          title: string;
          payload_json: string;
        }>;
        for (const r of recRows) {
          if (existingVecIds.has(r.id)) continue;
          let payloadText = "";
          try {
            const parsed = JSON.parse(String(r.payload_json)) as Record<
              string,
              unknown
            >;
            payloadText = Object.entries(parsed)
              .map(
                ([k, v]) =>
                  `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
              )
              .join("\n");
          } catch {
            payloadText = "";
          }
          const embedText = `${r.title}\n${payloadText}`.trim();
          if (!embedText) continue;
          insertPendingStmt.run(
            r.id,
            "record",
            r.org_id,
            r.realm_id,
            r.status,
            embedText,
            now,
          );
        }

        const seaRows = this.db
          .prepare(
            `SELECT id, org_id, realm_id, topic_id, kind, text
             FROM seabed_entries
             WHERE redacted_at IS NULL AND sensitivity != 'secret'`,
          )
          .all() as Array<{
          id: string;
          org_id: string;
          realm_id: string;
          topic_id: string | null;
          kind: string;
          text: string;
        }>;
        for (const s of seaRows) {
          if (existingVecIds.has(s.id)) continue;
          const title = `${s.kind}:${s.topic_id ?? s.realm_id}`;
          const embedText = `${title}\n${s.text}`.trim();
          if (!embedText) continue;
          insertPendingStmt.run(
            s.id,
            "seabed",
            s.org_id,
            s.realm_id,
            "evidence",
            embedText,
            now,
          );
        }

        const distRows = this.db
          .prepare(
            `SELECT d.id, r.org_id, d.realm_id, d.layer, d.period_key, d.status, d.narrative_md
             FROM distillations d
             JOIN realms r ON r.id = d.realm_id
             WHERE d.status != 'retracted'`,
          )
          .all() as Array<{
          id: string;
          org_id: string;
          realm_id: string;
          layer: string;
          period_key: string;
          status: string;
          narrative_md: string;
        }>;
        for (const d of distRows) {
          if (existingVecIds.has(d.id)) continue;
          const embedText =
            `${d.layer}:${d.period_key}\n${d.narrative_md}`.trim();
          if (!embedText) continue;
          insertPendingStmt.run(
            d.id,
            "distillation",
            d.org_id,
            d.realm_id,
            d.status,
            embedText,
            now,
          );
        }

        this.db
          .prepare(
            `INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'v0.2a_slice1a', ?)`,
          )
          .run(now);
      }

      // Migration v3: V0.2a Slice 2a (objects single-parent tree, entry_objects, resource_tags,
      // records.external_ref for reusing kind='thing', records.source_ref for fast chain-head lookup)
      if (!applied.has(3)) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS objects (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL REFERENCES orgs(id),
            parent_object_id TEXT REFERENCES objects(id),
            realm_id TEXT NOT NULL REFERENCES realms(id),
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_objects_org_realm ON objects(org_id, realm_id);
          CREATE INDEX IF NOT EXISTS idx_objects_org_parent ON objects(org_id, parent_object_id);

          CREATE TABLE IF NOT EXISTS entry_objects (
            entry_id TEXT NOT NULL,
            org_id TEXT NOT NULL REFERENCES orgs(id),
            object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
            PRIMARY KEY (entry_id, object_id)
          );
          CREATE INDEX IF NOT EXISTS idx_entry_objects_org_object ON entry_objects(org_id, object_id);

          CREATE TABLE IF NOT EXISTS resource_tags (
            entry_id TEXT NOT NULL,
            org_id TEXT NOT NULL REFERENCES orgs(id),
            tag TEXT NOT NULL,
            PRIMARY KEY (entry_id, tag)
          );
          CREATE INDEX IF NOT EXISTS idx_resource_tags_org_tag ON resource_tags(org_id, tag);
        `);

        this.ensureColumn("records", "external_ref", "TEXT");
        this.ensureColumn("records", "source_ref", "TEXT");

        const hasSourceRefsJson = this.hasColumn("records", "source_refs_json");
        const backfillRows = this.db
          .prepare(
            hasSourceRefsJson
              ? `SELECT id, payload_json, source_refs_json FROM records WHERE source_ref IS NULL OR external_ref IS NULL`
              : `SELECT id, payload_json FROM records WHERE source_ref IS NULL OR external_ref IS NULL`,
          )
          .all() as Array<{
          id: string;
          payload_json: string;
          source_refs_json?: string | null;
        }>;

        const updateBackfill = this.db.prepare(
          `UPDATE records
           SET source_ref = COALESCE(source_ref, ?),
               external_ref = COALESCE(external_ref, ?)
           WHERE id = ?`,
        );

        for (const row of backfillRows) {
          let sourceRef: string | null = null;
          let externalRef: string | null = null;

          if (hasSourceRefsJson && row.source_refs_json) {
            try {
              const arr = JSON.parse(String(row.source_refs_json)) as unknown;
              if (
                Array.isArray(arr) &&
                typeof arr[0] === "string" &&
                arr[0].trim()
              ) {
                sourceRef = arr[0].trim();
              }
            } catch {
              // ignore malformed json
            }
          }

          try {
            const payload = JSON.parse(String(row.payload_json)) as Record<
              string,
              unknown
            >;
            if (!sourceRef) {
              if (
                typeof payload.sourceRef === "string" &&
                payload.sourceRef.trim()
              ) {
                sourceRef = payload.sourceRef.trim();
              } else if (
                typeof payload.source_ref === "string" &&
                payload.source_ref.trim()
              ) {
                sourceRef = payload.source_ref.trim();
              } else if (
                Array.isArray(payload.sourceRefs) &&
                typeof payload.sourceRefs[0] === "string" &&
                payload.sourceRefs[0].trim()
              ) {
                sourceRef = payload.sourceRefs[0].trim();
              }
            }
            if (
              typeof payload.externalRef === "string" &&
              payload.externalRef.trim()
            ) {
              externalRef = payload.externalRef.trim();
            } else if (
              typeof payload.external_ref === "string" &&
              payload.external_ref.trim()
            ) {
              externalRef = payload.external_ref.trim();
            }
          } catch {
            // ignore malformed payload_json
          }

          if (sourceRef !== null || externalRef !== null) {
            updateBackfill.run(sourceRef, externalRef, row.id);
          }
        }

        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_records_org_external_ref ON records(org_id, external_ref);
          CREATE INDEX IF NOT EXISTS idx_records_org_source_ref_status ON records(org_id, source_ref, status);
        `);

        this.db
          .prepare(
            `INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, 'v0.2a_slice2a', ?)`,
          )
          .run(now);
      }

      // Migration v4: V0.2a-Polish (multi-predecessor supersedes_ids_json + nullable occurred_at expression indexes)
      // Explicit legacy note: migration v2's one-time backfill (`SET occurred_at = created_at WHERE occurred_at IS NULL`)
      // on pre-v2 databases is NOT rolled back because historical timestamps cannot be distinguished from backfilled ones;
      // benchmark databases must be freshly re-imported from source.
      if (!applied.has(4)) {
        this.ensureColumn("records", "supersedes_ids_json", "TEXT");
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_records_realm_occ_nulls
            ON records(realm_id, (occurred_at IS NULL), occurred_at DESC, created_at DESC, id DESC);
          CREATE INDEX IF NOT EXISTS idx_seabed_realm_occ_nulls
            ON seabed_entries(realm_id, (occurred_at IS NULL), occurred_at DESC, created_at DESC, id DESC);
        `);
        this.db
          .prepare(
            `INSERT INTO schema_migrations (version, name, applied_at) VALUES (4, 'v0.2a_polish', ?)`,
          )
          .run(now);
      }

      // Migration v5: V0.2a-Surface (global content-hash blocklist index for O(1) write-path enforcement)
      if (!applied.has(5)) {
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_redacted_blocklist_org_sha
            ON redacted_blocklist(org_id, content_sha256);
        `);
        this.db
          .prepare(
            `INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, 'v0.2a_surface', ?)`,
          )
          .run(now);
      }

      // Migration v6: V0.2a-Perf (fts_docs metadata side-table + contentless_delete CJK-bigram FTS5
      // + partial covering indexes + streaming keyset-batched backfill)
      if (!applied.has(6)) {
        this.assertMinSqliteVersion(3, 43);

        this.db.exec(`
          CREATE TABLE IF NOT EXISTS fts_docs (
            docid INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id TEXT NOT NULL UNIQUE,
            org_id TEXT NOT NULL,
            source_type TEXT NOT NULL,
            realm_id TEXT NOT NULL,
            status TEXT NOT NULL,
            kind TEXT NOT NULL,
            occurred_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_fts_docs_realm_type_status
            ON fts_docs(realm_id, source_type, status);
          CREATE INDEX IF NOT EXISTS idx_fts_docs_org
            ON fts_docs(org_id);
          DELETE FROM fts_docs;

          DROP TABLE IF EXISTS fts_index;
          CREATE VIRTUAL TABLE fts_index USING fts5(
            title,
            body,
            content='',
            contentless_delete=1,
            tokenize='unicode61'
          );
          INSERT INTO fts_index(fts_index, rank) VALUES('secure-delete', 1);

          CREATE INDEX IF NOT EXISTS idx_records_live_ls ON records(
            realm_id, (occurred_at IS NULL), occurred_at DESC, created_at DESC, id DESC, kind, org_id, sensitivity, status, redacted_at
          ) WHERE status = 'active' AND redacted_at IS NULL AND sensitivity != 'secret';

          CREATE INDEX IF NOT EXISTS idx_records_live_counts ON records(
            realm_id, kind, sensitivity, status, redacted_at
          ) WHERE status = 'active' AND redacted_at IS NULL AND sensitivity != 'secret';

          CREATE INDEX IF NOT EXISTS idx_seabed_live_ls ON seabed_entries(
            realm_id, (occurred_at IS NULL), occurred_at DESC, created_at DESC, id DESC, kind, org_id, sensitivity, redacted_at
          ) WHERE redacted_at IS NULL AND sensitivity != 'secret';
        `);

        const BATCH = 500;
        const insertDocStmt = this.db.prepare(
          `INSERT INTO fts_docs (item_id, org_id, source_type, realm_id, status, kind, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const insertFtsStmt = this.db.prepare(
          `INSERT INTO fts_index (rowid, title, body) VALUES (?, ?, ?)`,
        );

        // 1) Stream records via keyset pagination (WHERE id > ? ORDER BY id ASC LIMIT 500)
        const selectRecBatch = this.db.prepare(
          `SELECT r.id, COALESCE(r.org_id, rl.org_id, '') AS org_id, r.realm_id, r.status, r.kind, r.occurred_at, r.title, r.payload_json
           FROM records r
           LEFT JOIN realms rl ON rl.id = r.realm_id
           WHERE r.id > ? AND r.sensitivity != 'secret' AND r.status != 'retracted' AND r.redacted_at IS NULL
           ORDER BY r.id ASC
           LIMIT ?`,
        );
        let lastRecId = "";
        while (true) {
          const rows = selectRecBatch.all(lastRecId, BATCH) as Array<{
            id: string;
            org_id: string;
            realm_id: string;
            status: string;
            kind: string;
            occurred_at: string | null;
            title: string;
            payload_json: string;
          }>;
          if (rows.length === 0) break;
          for (const r of rows) {
            let payload: Record<string, unknown> = {};
            try {
              payload = JSON.parse(String(r.payload_json)) as Record<
                string,
                unknown
              >;
            } catch {
              payload = {};
            }
            const body = buildRecordFtsBody(payload);
            const info = insertDocStmt.run(
              r.id,
              String(r.org_id ?? ""),
              "record",
              r.realm_id,
              r.status,
              r.kind,
              r.occurred_at == null ? null : String(r.occurred_at),
            );
            insertFtsStmt.run(
              Number(info.lastInsertRowid),
              normalizeForFts(String(r.title)),
              normalizeForFts(body),
            );
          }
          lastRecId = String(rows[rows.length - 1]!.id);
          if (rows.length < BATCH) break;
        }

        // 2) Stream seabed_entries via keyset pagination
        const selectSeaBatch = this.db.prepare(
          `SELECT s.id, COALESCE(s.org_id, rl.org_id, '') AS org_id, s.realm_id, s.kind, s.topic_id, s.occurred_at, s.text
           FROM seabed_entries s
           LEFT JOIN realms rl ON rl.id = s.realm_id
           WHERE s.id > ? AND s.sensitivity != 'secret' AND s.redacted_at IS NULL
           ORDER BY s.id ASC
           LIMIT ?`,
        );
        let lastSeaId = "";
        while (true) {
          const rows = selectSeaBatch.all(lastSeaId, BATCH) as Array<{
            id: string;
            org_id: string;
            realm_id: string;
            kind: string;
            topic_id: string | null;
            occurred_at: string | null;
            text: string;
          }>;
          if (rows.length === 0) break;
          for (const s of rows) {
            const title = `${s.kind}:${s.topic_id ?? s.realm_id}`;
            const info = insertDocStmt.run(
              s.id,
              String(s.org_id ?? ""),
              "seabed",
              s.realm_id,
              "evidence",
              s.kind,
              s.occurred_at == null ? null : String(s.occurred_at),
            );
            insertFtsStmt.run(
              Number(info.lastInsertRowid),
              normalizeForFts(title),
              normalizeForFts(String(s.text)),
            );
          }
          lastSeaId = String(rows[rows.length - 1]!.id);
          if (rows.length < BATCH) break;
        }

        // 3) Stream distillations via keyset pagination (org_id from realm, kind = layer, occurred_at = created_at)
        const selectDistBatch = this.db.prepare(
          `SELECT d.id, r.org_id, d.realm_id, d.layer, d.period_key, d.status, d.narrative_md, d.created_at
           FROM distillations d
           JOIN realms r ON r.id = d.realm_id
           WHERE d.id > ? AND d.status != 'retracted'
           ORDER BY d.id ASC
           LIMIT ?`,
        );
        let lastDistId = "";
        while (true) {
          const rows = selectDistBatch.all(lastDistId, BATCH) as Array<{
            id: string;
            org_id: string;
            realm_id: string;
            layer: string;
            period_key: string;
            status: string;
            narrative_md: string;
            created_at: string;
          }>;
          if (rows.length === 0) break;
          for (const d of rows) {
            const title = `${d.layer}:${d.period_key}`;
            const info = insertDocStmt.run(
              d.id,
              String(d.org_id ?? ""),
              "distillation",
              d.realm_id,
              d.status,
              d.layer,
              String(d.created_at),
            );
            insertFtsStmt.run(
              Number(info.lastInsertRowid),
              normalizeForFts(title),
              normalizeForFts(String(d.narrative_md)),
            );
          }
          lastDistId = String(rows[rows.length - 1]!.id);
          if (rows.length < BATCH) break;
        }

        this.db
          .prepare(
            `INSERT INTO schema_migrations (version, name, applied_at) VALUES (6, 'v0.2a_perf_fts_docs', ?)`,
          )
          .run(now);
      }

      // Migration v7: V0.2a-Causal-Lifecycle (objects state columns + partial inactive index + object_aliases + keyset backfill)
      if (!applied.has(7)) {
        this.ensureColumn(
          "objects",
          "state",
          "TEXT NOT NULL DEFAULT 'active'",
        );
        this.ensureColumn("objects", "state_label", "TEXT");
        this.ensureColumn("objects", "state_since", "TEXT");
        this.ensureColumn("objects", "state_evidence_id", "TEXT");

        this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_objects_inactive
            ON objects(org_id, realm_id) WHERE state != 'active';

          CREATE TABLE IF NOT EXISTS object_aliases (
            org_id TEXT NOT NULL,
            object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
            alias TEXT NOT NULL,
            alias_norm TEXT NOT NULL,
            is_name INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (object_id, alias_norm)
          );
          CREATE INDEX IF NOT EXISTS idx_object_aliases_norm
            ON object_aliases(org_id, alias_norm);
        `);

        const BATCH = 500;
        const selectObjBatch = this.db.prepare(
          `SELECT id, org_id, name
           FROM objects
           WHERE id > ?
           ORDER BY id ASC
           LIMIT ?`,
        );
        const insertNameAliasStmt = this.db.prepare(
          `INSERT OR IGNORE INTO object_aliases (org_id, object_id, alias, alias_norm, is_name)
           VALUES (?, ?, ?, ?, 1)`,
        );
        let lastObjId = "";
        while (true) {
          const rows = selectObjBatch.all(lastObjId, BATCH) as Array<{
            id: string;
            org_id: string;
            name: string;
          }>;
          if (rows.length === 0) break;
          for (const row of rows) {
            const norm = normalizeAlias(String(row.name));
            if (norm.length > 0) {
              insertNameAliasStmt.run(
                String(row.org_id),
                String(row.id),
                String(row.name),
                norm,
              );
            }
          }
          lastObjId = String(rows[rows.length - 1]!.id);
          if (rows.length < BATCH) break;
        }

        this.db
          .prepare(
            `INSERT INTO schema_migrations (version, name, applied_at) VALUES (7, 'v0.2a_causal_object_lifecycle', ?)`,
          )
          .run(now);
      }

      if (this.vecEnabled && !this.tableExists("vec_items")) {
        this.createVecItemsTable();
      }
    });
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.inTransaction = true;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // ignore rollback error
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  // ---- Schema & Meta ----

  listSchemaMigrations(): SchemaMigrationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      version: Number(r.version),
      name: String(r.name),
      appliedAt: String(r.applied_at),
    }));
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // ---- Organizations ----

  insertOrg(org: Organization): void {
    this.db
      .prepare(
        `INSERT INTO orgs (id, name, is_personal_root, policy, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        org.id,
        org.name,
        org.isPersonalRoot ? 1 : 0,
        org.policy,
        org.createdAt,
      );
  }

  getOrg(id: string): Organization | null {
    const row = this.db
      .prepare(`SELECT * FROM orgs WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapOrg(row) : null;
  }

  listOrgs(): Organization[] {
    const rows = this.db
      .prepare(`SELECT * FROM orgs ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapOrg(r));
  }

  updateOrgPolicy(orgId: string, policy: OrgPolicy): boolean {
    const res = this.db
      .prepare(`UPDATE orgs SET policy = ? WHERE id = ?`)
      .run(policy, orgId);
    return Number(res.changes) > 0;
  }

  private mapOrg(row: Record<string, unknown>): Organization {
    return {
      id: String(row.id),
      name: String(row.name),
      isPersonalRoot: Number(row.is_personal_root) === 1,
      policy: (row.policy === "open" || row.policy === "tree"
        ? row.policy
        : "tree") as OrgPolicy,
      createdAt: String(row.created_at),
    };
  }

  // ---- Realms ----

  insertRealm(realm: Realm): void {
    this.db
      .prepare(
        `INSERT INTO realms (id, org_id, parent_id, slug, path, name, archived_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        realm.id,
        realm.orgId,
        realm.parentId,
        realm.slug,
        realm.path,
        realm.name,
        realm.archivedAt,
        realm.createdAt,
      );
  }

  getRealm(id: string): Realm | null {
    const row = this.db
      .prepare(`SELECT * FROM realms WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRealm(row) : null;
  }

  getRealmByPath(orgId: string, realmPath: string): Realm | null {
    const row = this.db
      .prepare(`SELECT * FROM realms WHERE org_id = ? AND path = ?`)
      .get(orgId, realmPath) as Record<string, unknown> | undefined;
    return row ? this.mapRealm(row) : null;
  }

  listRealms(orgId?: string): Realm[] {
    const rows = orgId
      ? (this.db
          .prepare(
            `SELECT * FROM realms WHERE org_id = ? ORDER BY path ASC, created_at ASC`,
          )
          .all(orgId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM realms ORDER BY org_id ASC, path ASC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapRealm(r));
  }

  private mapRealm(row: Record<string, unknown>): Realm {
    return {
      id: String(row.id),
      orgId: String(row.org_id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      slug: String(row.slug),
      path: String(row.path),
      name: String(row.name),
      archivedAt: row.archived_at ? String(row.archived_at) : null,
      createdAt: String(row.created_at),
    };
  }

  // ---- Mounts ----

  insertMount(mount: RealmMount): void {
    this.db
      .prepare(
        `INSERT INTO realm_mounts (id, viewer_realm_id, target_realm_id, scope, mounted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(viewer_realm_id, target_realm_id) DO UPDATE SET
           scope = excluded.scope,
           mounted_by = excluded.mounted_by,
           created_at = excluded.created_at`,
      )
      .run(
        mount.id,
        mount.viewerRealmId,
        mount.targetRealmId,
        mount.scope,
        mount.mountedBy,
        mount.createdAt,
      );
  }

  deleteMount(viewerRealmId: string, targetRealmId: string): boolean {
    const res = this.db
      .prepare(
        `DELETE FROM realm_mounts WHERE viewer_realm_id = ? AND target_realm_id = ?`,
      )
      .run(viewerRealmId, targetRealmId);
    return Number(res.changes) > 0;
  }

  listMounts(viewerRealmId?: string): RealmMount[] {
    const rows = viewerRealmId
      ? (this.db
          .prepare(
            `SELECT * FROM realm_mounts WHERE viewer_realm_id = ? ORDER BY created_at ASC`,
          )
          .all(viewerRealmId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM realm_mounts ORDER BY created_at ASC`)
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => ({
      id: String(r.id),
      viewerRealmId: String(r.viewer_realm_id),
      targetRealmId: String(r.target_realm_id),
      scope: String(r.scope) as RealmMount["scope"],
      mountedBy: String(r.mounted_by),
      createdAt: String(r.created_at),
    }));
  }

  // ---- Seabed ----

  insertSeabedEntry(entry: SeabedEntry): void {
    this.db
      .prepare(
        `INSERT INTO seabed_entries
         (id, org_id, realm_id, topic_id, kind, author_id, author_kind, author_family, text, blob_sha256, source_ref, metadata_json, occurred_at, origin_session_id, sensitivity, redacted_at, redacted_by, redacted_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.orgId,
        entry.realmId,
        entry.topicId,
        entry.kind,
        entry.authorId,
        entry.authorKind,
        entry.authorFamily,
        entry.text,
        entry.blobSha256,
        entry.sourceRef,
        JSON.stringify(entry.metadata),
        entry.occurredAt,
        entry.originSessionId,
        entry.sensitivity,
        entry.redactedAt,
        entry.redactedBy,
        entry.redactedReason,
        entry.createdAt,
      );
  }

  getSeabedEntry(id: string): SeabedEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM seabed_entries WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapSeabed(row) : null;
  }

  getSeabedEntriesByIds(ids: string[]): SeabedEntry[] {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) return [];
    const results: SeabedEntry[] = [];
    const CHUNK = 500;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      const rows = this.db
        .prepare(
          `SELECT * FROM seabed_entries WHERE id IN (${placeholders(slice.length)})`,
        )
        .all(...slice) as Array<Record<string, unknown>>;
      for (const r of rows) {
        results.push(this.mapSeabed(r));
      }
    }
    return results;
  }

  listSeabedEntries(filter: {
    realmIds: string[];
    kinds?: SeabedKind[];
    authorId?: string;
    topicId?: string;
    since?: string;
    until?: string;
    excludeSensitivities?: Sensitivity[];
    limit?: number;
    offset?: number;
  }): { items: SeabedEntry[]; total: number } {
    if (filter.realmIds.length === 0) {
      return { items: [], total: 0 };
    }
    const where: string[] = [
      `realm_id IN (${placeholders(filter.realmIds.length)})`,
      `redacted_at IS NULL`,
    ];
    const params: SQLInputValue[] = [...filter.realmIds];

    const excludeSens = filter.excludeSensitivities ?? ["secret"];
    appendSensitivityExclusion(where, params, "sensitivity", excludeSens);

    if (filter.kinds && filter.kinds.length > 0) {
      where.push(`kind IN (${placeholders(filter.kinds.length)})`);
      params.push(...filter.kinds);
    }
    if (filter.authorId) {
      where.push(`author_id = ?`);
      params.push(filter.authorId);
    }
    if (filter.topicId) {
      where.push(`topic_id = ?`);
      params.push(filter.topicId);
    }
    if (filter.since) {
      where.push(`occurred_at IS NOT NULL AND occurred_at >= ?`);
      params.push(filter.since);
    }
    if (filter.until) {
      where.push(`occurred_at IS NOT NULL AND occurred_at <= ?`);
      params.push(filter.until);
    }

    const whereSql = where.join(" AND ");
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as c FROM seabed_entries WHERE ${whereSql}`)
      .get(...params) as { c: number };

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM seabed_entries WHERE ${whereSql} ORDER BY (occurred_at IS NULL) ASC, occurred_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      items: rows.map((r) => this.mapSeabed(r)),
      total: Number(totalRow.c),
    };
  }

  listAllSeabedEntries(): SeabedEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM seabed_entries ORDER BY created_at ASC, rowid ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSeabed(r));
  }

  listSeabedEntriesBatch(afterId: string, limit: number): SeabedEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM seabed_entries WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapSeabed(r));
  }

  private mapSeabed(row: Record<string, unknown>): SeabedEntry {
    return {
      id: String(row.id),
      orgId: String(row.org_id ?? ""),
      realmId: String(row.realm_id),
      topicId: row.topic_id ? String(row.topic_id) : null,
      kind: String(row.kind) as SeabedKind,
      authorId: String(row.author_id),
      authorKind: String(row.author_kind) as SeabedEntry["authorKind"],
      authorFamily: row.author_family ? String(row.author_family) : null,
      text: String(row.text),
      blobSha256: row.blob_sha256 ? String(row.blob_sha256) : null,
      sourceRef: row.source_ref ? String(row.source_ref) : null,
      metadata: JSON.parse(String(row.metadata_json)) as Record<string, unknown>,
      occurredAt: row.occurred_at == null ? null : String(row.occurred_at),
      originSessionId: row.origin_session_id
        ? String(row.origin_session_id)
        : null,
      sensitivity: (row.sensitivity
        ? String(row.sensitivity)
        : "internal") as Sensitivity,
      redactedAt: row.redacted_at ? String(row.redacted_at) : null,
      redactedBy: row.redacted_by ? String(row.redacted_by) : null,
      redactedReason: row.redacted_reason ? String(row.redacted_reason) : null,
      createdAt: String(row.created_at),
    };
  }

  // ---- Ledger Records ----

  insertRecord(record: LedgerRecord): void {
    const supersedesList =
      record.supersedesIds && record.supersedesIds.length > 0
        ? Array.from(new Set(record.supersedesIds))
        : record.supersedesId
          ? [record.supersedesId]
          : [];
    const supersedesId = supersedesList[0] ?? null;
    const supersedesIdsJson =
      supersedesList.length > 0 ? JSON.stringify(supersedesList) : null;
    this.db
      .prepare(
        `INSERT INTO records
         (id, org_id, realm_id, thing_id, kind, ext_kind, status, supersedes_id, supersedes_ids_json, superseded_by_id, author_id, author_kind, author_family, confirmed_by_human, title, payload_json, refs_json, external_ref, source_ref, occurred_at, origin_session_id, sensitivity, redacted_at, redacted_by, redacted_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.orgId,
        record.realmId,
        record.thingId,
        record.kind,
        record.extKind,
        record.status,
        supersedesId,
        supersedesIdsJson,
        record.supersededById,
        record.authorId,
        record.authorKind,
        record.authorFamily,
        record.confirmedByHuman ? 1 : 0,
        record.title,
        JSON.stringify(record.payload),
        JSON.stringify(record.refs),
        record.externalRef,
        record.sourceRef,
        record.occurredAt,
        record.originSessionId,
        record.sensitivity,
        record.redactedAt,
        record.redactedBy,
        record.redactedReason,
        record.createdAt,
      );
  }

  markRecordSuperseded(oldId: string, newId: string, orgId?: string): boolean {
    const res = orgId
      ? this.db
          .prepare(
            `UPDATE records
             SET superseded_by_id = ?, status = 'superseded'
             WHERE id = ? AND org_id = ? AND status = 'active' AND superseded_by_id IS NULL`,
          )
          .run(newId, oldId, orgId)
      : this.db
          .prepare(
            `UPDATE records
             SET superseded_by_id = ?, status = 'superseded'
             WHERE id = ? AND status = 'active' AND superseded_by_id IS NULL`,
          )
          .run(newId, oldId);
    return Number(res.changes) === 1;
  }

  getRecord(id: string): LedgerRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM records WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRecord(row) : null;
  }

  getRecordsByIds(ids: string[]): LedgerRecord[] {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) return [];
    const results: LedgerRecord[] = [];
    const CHUNK = 500;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      const rows = this.db
        .prepare(
          `SELECT * FROM records WHERE id IN (${placeholders(slice.length)})`,
        )
        .all(...slice) as Array<Record<string, unknown>>;
      for (const r of rows) {
        results.push(this.mapRecord(r));
      }
    }
    return results;
  }

  findActiveRecordBySourceRef(
    orgId: string,
    sourceRef: string,
    realmId?: string,
  ): LedgerRecord | null {
    const row = realmId
      ? (this.db
          .prepare(
            `SELECT * FROM records
             WHERE org_id = ? AND source_ref = ? AND status = 'active' AND realm_id = ? AND redacted_at IS NULL
             ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(orgId, sourceRef, realmId) as Record<string, unknown> | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM records
             WHERE org_id = ? AND source_ref = ? AND status = 'active' AND redacted_at IS NULL
             ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(orgId, sourceRef) as Record<string, unknown> | undefined);
    return row ? this.mapRecord(row) : null;
  }

  findLatestRecordBySourceRef(
    orgId: string,
    sourceRef: string,
    realmId?: string,
  ): LedgerRecord | null {
    const row = realmId
      ? (this.db
          .prepare(
            `SELECT * FROM records
             WHERE org_id = ? AND source_ref = ? AND realm_id = ? AND redacted_at IS NULL AND status != 'retracted'
             ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(orgId, sourceRef, realmId) as Record<string, unknown> | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM records
             WHERE org_id = ? AND source_ref = ? AND redacted_at IS NULL AND status != 'retracted'
             ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(orgId, sourceRef) as Record<string, unknown> | undefined);
    return row ? this.mapRecord(row) : null;
  }

  findRecordsByExternalRef(
    orgId: string,
    externalRef: string,
    realmIds?: string[],
    excludeSensitivities: Sensitivity[] = ["secret"],
  ): LedgerRecord[] {
    if (realmIds && realmIds.length === 0) return [];
    const where: string[] = [
      `org_id = ?`,
      `external_ref = ?`,
      `status = 'active'`,
      `redacted_at IS NULL`,
    ];
    const params: SQLInputValue[] = [orgId, externalRef];
    if (realmIds && realmIds.length > 0) {
      where.push(`realm_id IN (${placeholders(realmIds.length)})`);
      params.push(...realmIds);
    }
    appendSensitivityExclusion(where, params, "sensitivity", excludeSensitivities);
    const rows = this.db
      .prepare(
        `SELECT * FROM records WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRecord(r));
  }

  listRecords(filter: {
    realmIds: string[];
    thingId?: string;
    kinds?: RecordKind[];
    authorId?: string;
    externalRef?: string;
    includeSuperseded?: boolean;
    since?: string;
    until?: string;
    excludeSensitivities?: Sensitivity[];
    limit?: number;
    offset?: number;
  }): { items: LedgerRecord[]; total: number } {
    if (filter.realmIds.length === 0) {
      return { items: [], total: 0 };
    }
    const where: string[] = [
      `realm_id IN (${placeholders(filter.realmIds.length)})`,
    ];
    const params: SQLInputValue[] = [...filter.realmIds];

    const excludeSens = filter.excludeSensitivities ?? ["secret"];
    appendSensitivityExclusion(where, params, "sensitivity", excludeSens);

    if (!filter.includeSuperseded) {
      where.push(`status = 'active'`);
      where.push(`redacted_at IS NULL`);
    }
    if (filter.thingId) {
      where.push(`thing_id = ?`);
      params.push(filter.thingId);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      where.push(`kind IN (${placeholders(filter.kinds.length)})`);
      params.push(...filter.kinds);
    }
    if (filter.authorId) {
      where.push(`author_id = ?`);
      params.push(filter.authorId);
    }
    if (filter.externalRef) {
      where.push(`external_ref = ?`);
      params.push(filter.externalRef);
    }
    if (filter.since) {
      where.push(`occurred_at IS NOT NULL AND occurred_at >= ?`);
      params.push(filter.since);
    }
    if (filter.until) {
      where.push(`occurred_at IS NOT NULL AND occurred_at <= ?`);
      params.push(filter.until);
    }

    const whereSql = where.join(" AND ");
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as c FROM records WHERE ${whereSql}`)
      .get(...params) as { c: number };

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM records WHERE ${whereSql} ORDER BY (occurred_at IS NULL) ASC, occurred_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      items: rows.map((r) => this.mapRecord(r)),
      total: Number(totalRow.c),
    };
  }

  listRecordsWindow(params: {
    realmIds: string[];
    anchorTime: string;
    anchorId: string;
    direction: "before" | "after";
    timeBasis?: "occurred_at" | "created_at";
    limit: number;
    excludeSensitivities?: Sensitivity[];
  }): LedgerRecord[] {
    if (params.realmIds.length === 0 || params.limit <= 0) return [];
    const excludeSens = params.excludeSensitivities ?? ["secret"];
    const timeCol =
      params.timeBasis === "created_at" ? "created_at" : "occurred_at";
    const where: string[] = [
      `realm_id IN (${placeholders(params.realmIds.length)})`,
      `redacted_at IS NULL`,
      `status != 'retracted'`,
      `id != ?`,
    ];
    if (timeCol === "occurred_at") {
      where.push(`occurred_at IS NOT NULL`);
    }
    const sqlParams: SQLInputValue[] = [...params.realmIds, params.anchorId];
    appendSensitivityExclusion(where, sqlParams, "sensitivity", excludeSens);
    if (params.direction === "before") {
      where.push(`(${timeCol} < ? OR (${timeCol} = ? AND id < ?))`);
      sqlParams.push(params.anchorTime, params.anchorTime, params.anchorId);
    } else {
      where.push(`(${timeCol} > ? OR (${timeCol} = ? AND id > ?))`);
      sqlParams.push(params.anchorTime, params.anchorTime, params.anchorId);
    }
    const order =
      params.direction === "before"
        ? `ORDER BY ${timeCol} DESC, id DESC`
        : `ORDER BY ${timeCol} ASC, id ASC`;
    const rows = this.db
      .prepare(
        `SELECT * FROM records WHERE ${where.join(" AND ")} ${order} LIMIT ?`,
      )
      .all(...sqlParams, params.limit) as Array<Record<string, unknown>>;
    const mapped = rows.map((r) => this.mapRecord(r));
    return params.direction === "before" ? mapped.reverse() : mapped;
  }

  listSeabedWindow(params: {
    realmIds: string[];
    anchorTime: string;
    anchorId: string;
    direction: "before" | "after";
    timeBasis?: "occurred_at" | "created_at";
    limit: number;
    excludeSensitivities?: Sensitivity[];
  }): SeabedEntry[] {
    if (params.realmIds.length === 0 || params.limit <= 0) return [];
    const excludeSens = params.excludeSensitivities ?? ["secret"];
    const timeCol =
      params.timeBasis === "created_at" ? "created_at" : "occurred_at";
    const where: string[] = [
      `realm_id IN (${placeholders(params.realmIds.length)})`,
      `redacted_at IS NULL`,
      `id != ?`,
    ];
    if (timeCol === "occurred_at") {
      where.push(`occurred_at IS NOT NULL`);
    }
    const sqlParams: SQLInputValue[] = [...params.realmIds, params.anchorId];
    appendSensitivityExclusion(where, sqlParams, "sensitivity", excludeSens);
    if (params.direction === "before") {
      where.push(`(${timeCol} < ? OR (${timeCol} = ? AND id < ?))`);
      sqlParams.push(params.anchorTime, params.anchorTime, params.anchorId);
    } else {
      where.push(`(${timeCol} > ? OR (${timeCol} = ? AND id > ?))`);
      sqlParams.push(params.anchorTime, params.anchorTime, params.anchorId);
    }
    const order =
      params.direction === "before"
        ? `ORDER BY ${timeCol} DESC, id DESC`
        : `ORDER BY ${timeCol} ASC, id ASC`;
    const rows = this.db
      .prepare(
        `SELECT * FROM seabed_entries WHERE ${where.join(" AND ")} ${order} LIMIT ?`,
      )
      .all(...sqlParams, params.limit) as Array<Record<string, unknown>>;
    const mapped = rows.map((r) => this.mapSeabed(r));
    return params.direction === "before" ? mapped.reverse() : mapped;
  }

  listAllRecords(): LedgerRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM records ORDER BY created_at ASC, rowid ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRecord(r));
  }

  listRecordsBatch(afterId: string, limit: number): LedgerRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM records WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(afterId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRecord(r));
  }

  listPendingHumanQuestions(filter: {
    realmIds: string[];
    excludeSensitivities?: Sensitivity[];
    limit?: number;
  }): { items: LedgerRecord[]; total: number } {
    if (filter.realmIds.length === 0) {
      return { items: [], total: 0 };
    }
    const excludeSens = filter.excludeSensitivities ?? ["secret"];
    const where: string[] = [
      `p.realm_id IN (${placeholders(filter.realmIds.length)})`,
      `p.kind = 'proposal'`,
      `p.status = 'active'`,
      `p.redacted_at IS NULL`,
      `json_extract(p.payload_json, '$.requiresHuman') = 1`,
    ];
    const params: SQLInputValue[] = [...filter.realmIds];
    appendSensitivityExclusion(where, params, "p.sensitivity", excludeSens);
    where.push(`NOT EXISTS (
      SELECT 1 FROM records v
      WHERE v.realm_id = p.realm_id
        AND v.kind = 'verdict'
        AND v.status = 'active'
        AND v.sensitivity != 'secret'
        AND (
          json_extract(v.payload_json, '$.proposalId') = p.id
          OR EXISTS (SELECT 1 FROM json_each(v.refs_json) WHERE json_each.value = p.id)
        )
    )`);

    const whereSql = where.join(" AND ");
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM records p WHERE ${whereSql}`)
      .get(...params) as { c: number };
    const limit = filter.limit ?? 50;
    const rows = this.db
      .prepare(
        `SELECT p.* FROM records p WHERE ${whereSql} ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;
    return {
      items: rows.map((r) => this.mapRecord(r)),
      total: Number(totalRow.c),
    };
  }

  countRecordsByKind(filter: {
    realmIds: string[];
    includeSuperseded?: boolean;
    excludeSensitivities?: Sensitivity[];
  }): Record<string, number> {
    if (filter.realmIds.length === 0) return {};
    const excludeSens = filter.excludeSensitivities ?? ["secret"];
    const where: string[] = [
      `realm_id IN (${placeholders(filter.realmIds.length)})`,
    ];
    const params: SQLInputValue[] = [...filter.realmIds];
    if (!filter.includeSuperseded) {
      where.push(`status = 'active'`);
      where.push(`redacted_at IS NULL`);
    }
    appendSensitivityExclusion(where, params, "sensitivity", excludeSens);
    const rows = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS c FROM records WHERE ${where.join(" AND ")} GROUP BY kind`,
      )
      .all(...params) as Array<{ kind: string; c: number }>;
    const counts: Record<string, number> = {};
    for (const r of rows) {
      counts[String(r.kind)] = Number(r.c);
    }
    return counts;
  }

  countActiveRecordsByRealm(filter: {
    realmIds: string[];
    excludeSensitivities?: Sensitivity[];
  }): Map<string, RealmRecordCountRow> {
    const out = new Map<string, RealmRecordCountRow>();
    if (filter.realmIds.length === 0) return out;
    const excludeSens = filter.excludeSensitivities ?? ["secret"];
    const where: string[] = [
      `realm_id IN (${placeholders(filter.realmIds.length)})`,
      `status = 'active'`,
      `redacted_at IS NULL`,
    ];
    const params: SQLInputValue[] = [...filter.realmIds];
    appendSensitivityExclusion(where, params, "sensitivity", excludeSens);
    const rows = this.db
      .prepare(
        `SELECT realm_id, kind, COUNT(*) AS c FROM records WHERE ${where.join(" AND ")} GROUP BY realm_id, kind`,
      )
      .all(...params) as Array<{ realm_id: string; kind: string; c: number }>;
    for (const r of rows) {
      const rid = String(r.realm_id);
      const bucket = out.get(rid) ?? {
        rules: 0,
        conclusions: 0,
        things: 0,
        decisions: 0,
      };
      const count = Number(r.c);
      if (r.kind === "rule") {
        bucket.rules += count;
      } else {
        bucket.conclusions += count;
        if (r.kind === "thing") bucket.things += count;
        if (r.kind === "decision") bucket.decisions += count;
      }
      out.set(rid, bucket);
    }
    return out;
  }

  countSeabedByRealm(filter: {
    realmIds: string[];
    excludeSensitivities?: Sensitivity[];
  }): Map<string, number> {
    const out = new Map<string, number>();
    if (filter.realmIds.length === 0) return out;
    const excludeSens = filter.excludeSensitivities ?? ["secret"];
    const where: string[] = [
      `realm_id IN (${placeholders(filter.realmIds.length)})`,
      `redacted_at IS NULL`,
    ];
    const params: SQLInputValue[] = [...filter.realmIds];
    appendSensitivityExclusion(where, params, "sensitivity", excludeSens);
    const rows = this.db
      .prepare(
        `SELECT realm_id, COUNT(*) AS c FROM seabed_entries WHERE ${where.join(" AND ")} GROUP BY realm_id`,
      )
      .all(...params) as Array<{ realm_id: string; c: number }>;
    for (const r of rows) {
      out.set(String(r.realm_id), Number(r.c));
    }
    return out;
  }

  countPendingQuestionsByRealm(filter: {
    realmIds: string[];
    excludeSensitivities?: Sensitivity[];
  }): Map<string, number> {
    const out = new Map<string, number>();
    if (filter.realmIds.length === 0) return out;
    const excludeSens = filter.excludeSensitivities ?? ["secret"];
    const where: string[] = [
      `p.realm_id IN (${placeholders(filter.realmIds.length)})`,
      `p.kind = 'proposal'`,
      `p.status = 'active'`,
      `p.redacted_at IS NULL`,
      `json_extract(p.payload_json, '$.requiresHuman') = 1`,
    ];
    const params: SQLInputValue[] = [...filter.realmIds];
    appendSensitivityExclusion(where, params, "p.sensitivity", excludeSens);
    where.push(`NOT EXISTS (
      SELECT 1 FROM records v
      WHERE v.realm_id = p.realm_id
        AND v.kind = 'verdict'
        AND v.status = 'active'
        AND v.sensitivity != 'secret'
        AND (
          json_extract(v.payload_json, '$.proposalId') = p.id
          OR EXISTS (SELECT 1 FROM json_each(v.refs_json) WHERE json_each.value = p.id)
        )
    )`);
    const rows = this.db
      .prepare(
        `SELECT p.realm_id, COUNT(*) AS c FROM records p WHERE ${where.join(" AND ")} GROUP BY p.realm_id`,
      )
      .all(...params) as Array<{ realm_id: string; c: number }>;
    for (const r of rows) {
      out.set(String(r.realm_id), Number(r.c));
    }
    return out;
  }

  countObjectsByRealm(filter: {
    orgId: string;
    realmIds: string[];
  }): Map<string, number> {
    const out = new Map<string, number>();
    if (filter.realmIds.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT realm_id, COUNT(*) AS c FROM objects
         WHERE org_id = ? AND realm_id IN (${placeholders(filter.realmIds.length)})
         GROUP BY realm_id`,
      )
      .all(filter.orgId, ...filter.realmIds) as Array<{
      realm_id: string;
      c: number;
    }>;
    for (const r of rows) {
      out.set(String(r.realm_id), Number(r.c));
    }
    return out;
  }

  countLinkedEntriesByObjectRealm(filter: {
    orgId: string;
    realmIds: string[];
    excludeSensitivities?: Sensitivity[];
  }): Map<string, number> {
    const out = new Map<string, number>();
    if (filter.realmIds.length === 0) return out;
    const excludeSens = filter.excludeSensitivities ?? ["secret"];
    const recSensWhere: string[] = [];
    const recSensParams: SQLInputValue[] = [];
    appendSensitivityExclusion(
      recSensWhere,
      recSensParams,
      "r.sensitivity",
      excludeSens,
    );
    const seaSensWhere: string[] = [];
    const seaSensParams: SQLInputValue[] = [];
    appendSensitivityExclusion(
      seaSensWhere,
      seaSensParams,
      "s.sensitivity",
      excludeSens,
    );
    const sensClauseRec =
      recSensWhere.length > 0 ? `AND ${recSensWhere.join(" AND ")}` : "";
    const sensClauseSea =
      seaSensWhere.length > 0 ? `AND ${seaSensWhere.join(" AND ")}` : "";
    const sql = `
      SELECT realm_id, COUNT(DISTINCT entry_id) AS c FROM (
        SELECT o.realm_id AS realm_id, eo.entry_id AS entry_id
        FROM entry_objects eo
        JOIN objects o ON o.id = eo.object_id AND o.org_id = eo.org_id
        JOIN records r ON r.id = eo.entry_id AND r.org_id = eo.org_id
        WHERE eo.org_id = ?
          AND o.realm_id IN (${placeholders(filter.realmIds.length)})
          AND r.realm_id != o.realm_id
          AND r.status = 'active'
          AND r.redacted_at IS NULL
          ${sensClauseRec}
        UNION
        SELECT o.realm_id AS realm_id, eo.entry_id AS entry_id
        FROM entry_objects eo
        JOIN objects o ON o.id = eo.object_id AND o.org_id = eo.org_id
        JOIN seabed_entries s ON s.id = eo.entry_id AND s.org_id = eo.org_id
        WHERE eo.org_id = ?
          AND o.realm_id IN (${placeholders(filter.realmIds.length)})
          AND s.realm_id != o.realm_id
          AND s.redacted_at IS NULL
          ${sensClauseSea}
      ) linked
      GROUP BY realm_id
    `;
    const params: SQLInputValue[] = [
      filter.orgId,
      ...filter.realmIds,
      ...recSensParams,
      filter.orgId,
      ...filter.realmIds,
      ...seaSensParams,
    ];
    const rows = this.db.prepare(sql).all(...params) as Array<{
      realm_id: string;
      c: number;
    }>;
    for (const r of rows) {
      out.set(String(r.realm_id), Number(r.c));
    }
    return out;
  }

  lsRealmEntriesUnified(params: {
    orgId: string;
    targetRealmId: string;
    includePhysicalLedger: boolean;
    includePhysicalSeabed: boolean;
    includeObjectLinkedOpenMode: boolean;
    includeSuperseded: boolean;
    kind?: string;
    kinds?: string[];
    tag?: string;
    since?: string;
    until?: string;
    entryIdsFilter?: string[];
    excludeSensitivities?: Sensitivity[];
    limit: number;
    offset: number;
  }): { rows: UnifiedEntryRef[]; total: number } {
    if (params.entryIdsFilter && params.entryIdsFilter.length === 0) {
      return { rows: [], total: 0 };
    }
    const kindList =
      params.kinds && params.kinds.length > 0
        ? params.kinds
        : params.kind
          ? [params.kind]
          : [];
    const excludeSens = params.excludeSensitivities ?? ["secret"];
    const branchLimit = Math.max(0, params.offset + params.limit);
    const pageBranches: string[] = [];
    const pageParams: SQLInputValue[] = [];
    const countSubqueries: string[] = [];
    const countParams: SQLInputValue[] = [];

    const addRecordBranch = (
      realmConditions: string[],
      condParams: SQLInputValue[],
      fromClause = `records r`,
      fromParams: SQLInputValue[] = [],
    ) => {
      const where: string[] = [
        `r.org_id = ?`,
        ...realmConditions,
        `r.redacted_at IS NULL`,
        params.includeSuperseded ? `r.status != 'retracted'` : `r.status = 'active'`,
      ];
      const bParams: SQLInputValue[] = [...fromParams, params.orgId, ...condParams];
      appendSensitivityExclusion(where, bParams, "r.sensitivity", excludeSens);
      if (kindList.length === 1) {
        where.push(`r.kind = ?`);
        bParams.push(kindList[0]!);
      } else if (kindList.length > 1) {
        where.push(`r.kind IN (${placeholders(kindList.length)})`);
        bParams.push(...kindList);
      }
      if (params.tag) {
        where.push(
          `EXISTS (SELECT 1 FROM resource_tags rt WHERE rt.org_id = r.org_id AND rt.entry_id = r.id AND rt.tag = ?)`,
        );
        bParams.push(params.tag);
      }
      if (params.since) {
        where.push(`r.occurred_at IS NOT NULL AND r.occurred_at >= ?`);
        bParams.push(params.since);
      }
      if (params.until) {
        where.push(`r.occurred_at IS NOT NULL AND r.occurred_at <= ?`);
        bParams.push(params.until);
      }
      if (params.entryIdsFilter && params.entryIdsFilter.length > 0) {
        where.push(`r.id IN (${placeholders(params.entryIdsFilter.length)})`);
        bParams.push(...params.entryIdsFilter);
      }
      const whereSql = where.join(" AND ");
      countSubqueries.push(
        `(SELECT COUNT(*) FROM ${fromClause} WHERE ${whereSql})`,
      );
      countParams.push(...bParams);
      pageBranches.push(
        `SELECT id, source_type, occurred_at, created_at FROM (SELECT r.id AS id, 'record' AS source_type, r.occurred_at AS occurred_at, r.created_at AS created_at FROM ${fromClause} WHERE ${whereSql} ORDER BY (r.occurred_at IS NULL) ASC, r.occurred_at DESC, r.created_at DESC, r.id DESC LIMIT ?)`,
      );
      pageParams.push(...bParams, branchLimit);
    };

    const addSeabedBranch = (
      realmConditions: string[],
      condParams: SQLInputValue[],
      fromClause = `seabed_entries s`,
      fromParams: SQLInputValue[] = [],
    ) => {
      const where: string[] = [
        `s.org_id = ?`,
        ...realmConditions,
        `s.redacted_at IS NULL`,
      ];
      const bParams: SQLInputValue[] = [...fromParams, params.orgId, ...condParams];
      appendSensitivityExclusion(where, bParams, "s.sensitivity", excludeSens);
      if (kindList.length === 1) {
        where.push(`s.kind = ?`);
        bParams.push(kindList[0]!);
      } else if (kindList.length > 1) {
        where.push(`s.kind IN (${placeholders(kindList.length)})`);
        bParams.push(...kindList);
      }
      if (params.tag) {
        where.push(
          `EXISTS (SELECT 1 FROM resource_tags rt WHERE rt.org_id = s.org_id AND rt.entry_id = s.id AND rt.tag = ?)`,
        );
        bParams.push(params.tag);
      }
      if (params.since) {
        where.push(`s.occurred_at IS NOT NULL AND s.occurred_at >= ?`);
        bParams.push(params.since);
      }
      if (params.until) {
        where.push(`s.occurred_at IS NOT NULL AND s.occurred_at <= ?`);
        bParams.push(params.until);
      }
      if (params.entryIdsFilter && params.entryIdsFilter.length > 0) {
        where.push(`s.id IN (${placeholders(params.entryIdsFilter.length)})`);
        bParams.push(...params.entryIdsFilter);
      }
      const whereSql = where.join(" AND ");
      countSubqueries.push(
        `(SELECT COUNT(*) FROM ${fromClause} WHERE ${whereSql})`,
      );
      countParams.push(...bParams);
      pageBranches.push(
        `SELECT id, source_type, occurred_at, created_at FROM (SELECT s.id AS id, 'seabed' AS source_type, s.occurred_at AS occurred_at, s.created_at AS created_at FROM ${fromClause} WHERE ${whereSql} ORDER BY (s.occurred_at IS NULL) ASC, s.occurred_at DESC, s.created_at DESC, s.id DESC LIMIT ?)`,
      );
      pageParams.push(...bParams, branchLimit);
    };

    // 4 strictly disjoint branches (UNION ALL, zero cross-branch duplicates)
    if (params.includePhysicalLedger) {
      addRecordBranch([`r.realm_id = ?`], [params.targetRealmId]);
    }
    if (params.includePhysicalSeabed) {
      addSeabedBranch([`s.realm_id = ?`], [params.targetRealmId]);
    }
    if (params.includeObjectLinkedOpenMode) {
      // Drive strictly from small objects -> entry_objects -> records/seabed PK
      // via CROSS JOIN so SQLite never scans org-wide records on open-mode ls!
      const linkedFromRec = `(SELECT DISTINCT eo.entry_id FROM objects o CROSS JOIN entry_objects eo ON eo.org_id = o.org_id AND eo.object_id = o.id WHERE o.org_id = ? AND o.realm_id = ?) linked CROSS JOIN records r ON r.id = linked.entry_id`;
      const linkedFromSea = `(SELECT DISTINCT eo.entry_id FROM objects o CROSS JOIN entry_objects eo ON eo.org_id = o.org_id AND eo.object_id = o.id WHERE o.org_id = ? AND o.realm_id = ?) linked CROSS JOIN seabed_entries s ON s.id = linked.entry_id`;
      if (params.includePhysicalLedger) {
        addRecordBranch(
          [`r.realm_id != ?`],
          [params.targetRealmId],
          linkedFromRec,
          [params.orgId, params.targetRealmId],
        );
      } else {
        addRecordBranch([], [], linkedFromRec, [
          params.orgId,
          params.targetRealmId,
        ]);
      }
      if (params.includePhysicalSeabed) {
        addSeabedBranch(
          [`s.realm_id != ?`],
          [params.targetRealmId],
          linkedFromSea,
          [params.orgId, params.targetRealmId],
        );
      } else {
        addSeabedBranch([], [], linkedFromSea, [
          params.orgId,
          params.targetRealmId,
        ]);
      }
    }

    if (pageBranches.length === 0) {
      return { rows: [], total: 0 };
    }

    const totalRow = this.db
      .prepare(`SELECT ${countSubqueries.join(" + ")} AS c`)
      .get(...countParams) as { c: number };

    const unionSql = pageBranches.join(" UNION ALL ");
    const rows = this.db
      .prepare(
        `SELECT id, source_type, occurred_at, created_at
         FROM (${unionSql}) u
         ORDER BY (occurred_at IS NULL) ASC, occurred_at DESC, created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...pageParams, params.limit, params.offset) as Array<
      Record<string, unknown>
    >;

    return {
      total: Number(totalRow.c),
      rows: rows.map((r) => ({
        id: String(r.id),
        sourceType: String(r.source_type) as "record" | "seabed",
        occurredAt: r.occurred_at == null ? null : String(r.occurred_at),
        createdAt: String(r.created_at),
      })),
    };
  }

  lsEntriesByIdsUnified(params: {
    orgId: string;
    entryIds: string[];
    ledgerRealmIds: string[];
    seabedRealmIds: string[];
    includeSuperseded: boolean;
    kind?: string;
    kinds?: string[];
    tag?: string;
    since?: string;
    until?: string;
    excludeSensitivities?: Sensitivity[];
    limit: number;
    offset: number;
  }): { rows: UnifiedEntryRef[]; total: number } {
    const uniqueIds = Array.from(new Set(params.entryIds.filter(Boolean)));
    if (uniqueIds.length === 0) {
      return { rows: [], total: 0 };
    }
    const kindList =
      params.kinds && params.kinds.length > 0
        ? params.kinds
        : params.kind
          ? [params.kind]
          : [];
    const excludeSens = params.excludeSensitivities ?? ["secret"];
    const branches: string[] = [];
    const sqlParams: SQLInputValue[] = [];

    if (params.ledgerRealmIds.length > 0) {
      const where: string[] = [
        `r.org_id = ?`,
        `r.id IN (${placeholders(uniqueIds.length)})`,
        `r.realm_id IN (${placeholders(params.ledgerRealmIds.length)})`,
        `r.redacted_at IS NULL`,
        params.includeSuperseded ? `r.status != 'retracted'` : `r.status = 'active'`,
      ];
      const bParams: SQLInputValue[] = [
        params.orgId,
        ...uniqueIds,
        ...params.ledgerRealmIds,
      ];
      appendSensitivityExclusion(where, bParams, "r.sensitivity", excludeSens);
      if (kindList.length === 1) {
        where.push(`r.kind = ?`);
        bParams.push(kindList[0]!);
      } else if (kindList.length > 1) {
        where.push(`r.kind IN (${placeholders(kindList.length)})`);
        bParams.push(...kindList);
      }
      if (params.tag) {
        where.push(
          `EXISTS (SELECT 1 FROM resource_tags rt WHERE rt.org_id = r.org_id AND rt.entry_id = r.id AND rt.tag = ?)`,
        );
        bParams.push(params.tag);
      }
      if (params.since) {
        where.push(`r.occurred_at IS NOT NULL AND r.occurred_at >= ?`);
        bParams.push(params.since);
      }
      if (params.until) {
        where.push(`r.occurred_at IS NOT NULL AND r.occurred_at <= ?`);
        bParams.push(params.until);
      }
      branches.push(
        `SELECT r.id AS id, 'record' AS source_type, r.occurred_at AS occurred_at, r.created_at AS created_at FROM records r WHERE ${where.join(" AND ")}`,
      );
      sqlParams.push(...bParams);
    }

    if (params.seabedRealmIds.length > 0) {
      const where: string[] = [
        `s.org_id = ?`,
        `s.id IN (${placeholders(uniqueIds.length)})`,
        `s.realm_id IN (${placeholders(params.seabedRealmIds.length)})`,
        `s.redacted_at IS NULL`,
      ];
      const bParams: SQLInputValue[] = [
        params.orgId,
        ...uniqueIds,
        ...params.seabedRealmIds,
      ];
      appendSensitivityExclusion(where, bParams, "s.sensitivity", excludeSens);
      if (kindList.length === 1) {
        where.push(`s.kind = ?`);
        bParams.push(kindList[0]!);
      } else if (kindList.length > 1) {
        where.push(`s.kind IN (${placeholders(kindList.length)})`);
        bParams.push(...kindList);
      }
      if (params.tag) {
        where.push(
          `EXISTS (SELECT 1 FROM resource_tags rt WHERE rt.org_id = s.org_id AND rt.entry_id = s.id AND rt.tag = ?)`,
        );
        bParams.push(params.tag);
      }
      if (params.since) {
        where.push(`s.occurred_at IS NOT NULL AND s.occurred_at >= ?`);
        bParams.push(params.since);
      }
      if (params.until) {
        where.push(`s.occurred_at IS NOT NULL AND s.occurred_at <= ?`);
        bParams.push(params.until);
      }
      branches.push(
        `SELECT s.id AS id, 'seabed' AS source_type, s.occurred_at AS occurred_at, s.created_at AS created_at FROM seabed_entries s WHERE ${where.join(" AND ")}`,
      );
      sqlParams.push(...bParams);
    }

    if (branches.length === 0) {
      return { rows: [], total: 0 };
    }

    const unionSql = branches.join(" UNION ");
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM (${unionSql}) u`)
      .get(...sqlParams) as { c: number };
    const rows = this.db
      .prepare(
        `SELECT id, source_type, occurred_at, created_at
         FROM (${unionSql}) u
         ORDER BY (occurred_at IS NULL) ASC, occurred_at DESC, created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...sqlParams, params.limit, params.offset) as Array<
      Record<string, unknown>
    >;

    return {
      total: Number(totalRow.c),
      rows: rows.map((r) => ({
        id: String(r.id),
        sourceType: String(r.source_type) as "record" | "seabed",
        occurredAt: r.occurred_at == null ? null : String(r.occurred_at),
        createdAt: String(r.created_at),
      })),
    };
  }

  // ---- Redaction & Blocklist ----

  redactRecordRow(params: {
    id: string;
    redactedAt: string;
    redactedBy: string;
    redactedReason: string | null;
  }): boolean {
    const res = this.db
      .prepare(
        `UPDATE records
         SET status = 'retracted',
             title = '[REDACTED]',
             payload_json = '{}',
             external_ref = NULL,
             source_ref = NULL,
             redacted_at = ?,
             redacted_by = ?,
             redacted_reason = ?
         WHERE id = ?`,
      )
      .run(
        params.redactedAt,
        params.redactedBy,
        params.redactedReason,
        params.id,
      );
    return Number(res.changes) > 0;
  }

  redactSeabedRow(params: {
    id: string;
    redactedAt: string;
    redactedBy: string;
    redactedReason: string | null;
  }): boolean {
    const res = this.db
      .prepare(
        `UPDATE seabed_entries
         SET text = '[REDACTED]',
             metadata_json = '{}',
             blob_sha256 = NULL,
             redacted_at = ?,
             redacted_by = ?,
             redacted_reason = ?
         WHERE id = ?`,
      )
      .run(
        params.redactedAt,
        params.redactedBy,
        params.redactedReason,
        params.id,
      );
    return Number(res.changes) > 0;
  }

  redactChangeLogForEntry(entryId: string): number {
    const res = this.db
      .prepare(
        `UPDATE change_log
         SET entity_id = ?
         WHERE entity_id LIKE ? AND op != 'redact'`,
      )
      .run(entryId, `${entryId}:%`);
    return Number(res.changes);
  }

  findDistillationsBySourceId(sourceId: string): Distillation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM distillations
         WHERE EXISTS (
           SELECT 1 FROM json_each(distillations.source_ids_json)
           WHERE json_each.value = ?
         )
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sourceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapDistillation(r));
  }

  redactDistillationRow(params: {
    id: string;
    hardFacts: Record<string, unknown>;
  }): boolean {
    const res = this.db
      .prepare(
        `UPDATE distillations
         SET status = 'retracted',
             narrative_md = '[REDACTED]',
             hard_facts_json = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(params.hardFacts), params.id);
    return Number(res.changes) > 0;
  }

  countBlobReferences(sha256: string): {
    seabedCount: number;
    driveFiles: DriveFileMeta[];
  } {
    const seaRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM seabed_entries WHERE blob_sha256 = ?`)
      .get(sha256) as { c: number };
    const driveRows = this.db
      .prepare(`SELECT * FROM drive_files WHERE sha256 = ? ORDER BY realm_id ASC, rel_path ASC`)
      .all(sha256) as Array<Record<string, unknown>>;
    return {
      seabedCount: Number(seaRow.c),
      driveFiles: driveRows.map((r) => this.mapDriveMeta(r)),
    };
  }

  insertRedactedBlocklist(entry: RedactedBlocklistEntry): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO redacted_blocklist
         (org_id, source_ref, content_sha256, reason, redacted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.orgId,
        entry.sourceRef,
        entry.contentSha256,
        entry.reason,
        entry.redactedAt,
      );
  }

  isRedactedBlocked(
    orgId: string,
    sourceRef: string,
    contentSha256: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM redacted_blocklist
         WHERE org_id = ? AND source_ref = ? AND content_sha256 = ?
         LIMIT 1`,
      )
      .get(orgId, sourceRef, contentSha256) as { ok: number } | undefined;
    return Boolean(row);
  }

  isContentShaBlocked(orgId: string, contentSha256: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM redacted_blocklist
         WHERE org_id = ? AND content_sha256 = ?
         LIMIT 1`,
      )
      .get(orgId, contentSha256) as { ok: number } | undefined;
    return Boolean(row);
  }

  listRedactedBlocklist(orgId: string): RedactedBlocklistEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM redacted_blocklist WHERE org_id = ? ORDER BY redacted_at ASC`,
      )
      .all(orgId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      orgId: String(r.org_id),
      sourceRef: String(r.source_ref),
      contentSha256: String(r.content_sha256),
      reason: r.reason ? String(r.reason) : null,
      redactedAt: String(r.redacted_at),
    }));
  }

  optimizeFtsAndCheckpoint(): WalCheckpointResult {
    // Optimize FTS5 b-trees to purge tombstone segments (secure_delete zeroes freed pages)
    this.db.exec(`INSERT INTO fts_index(fts_index) VALUES('optimize');`);
    // Use a short busy_timeout for TRUNCATE checkpoint so an active concurrent reader
    // surfaces busy=1 promptly instead of stalling for 10 seconds.
    this.db.exec(`PRAGMA busy_timeout = 100;`);
    try {
      const row = this.db
        .prepare(`PRAGMA wal_checkpoint(TRUNCATE)`)
        .get() as
        | { busy?: number; log?: number; checkpointed?: number }
        | undefined;
      return {
        busy: Number(row?.busy ?? 0),
        log: Number(row?.log ?? 0),
        checkpointed: Number(row?.checkpointed ?? 0),
      };
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
    }
  }

  private mapRecord(row: Record<string, unknown>): LedgerRecord {
    const supersedesId = row.supersedes_id ? String(row.supersedes_id) : null;
    let supersedesIds: string[] = [];
    if (row.supersedes_ids_json) {
      try {
        const parsed = JSON.parse(String(row.supersedes_ids_json)) as unknown;
        if (Array.isArray(parsed)) {
          supersedesIds = parsed
            .filter((x): x is string => typeof x === "string" && x.length > 0);
        }
      } catch {
        supersedesIds = supersedesId ? [supersedesId] : [];
      }
    } else if (supersedesId) {
      supersedesIds = [supersedesId];
    }

    return {
      id: String(row.id),
      orgId: String(row.org_id ?? ""),
      realmId: String(row.realm_id),
      thingId: row.thing_id ? String(row.thing_id) : null,
      kind: String(row.kind) as RecordKind,
      extKind: row.ext_kind ? String(row.ext_kind) : null,
      status: String(row.status) as LedgerRecord["status"],
      supersedesId,
      supersedesIds,
      supersededById: row.superseded_by_id
        ? String(row.superseded_by_id)
        : null,
      authorId: String(row.author_id),
      authorKind: String(row.author_kind) as LedgerRecord["authorKind"],
      authorFamily: row.author_family ? String(row.author_family) : null,
      confirmedByHuman: Number(row.confirmed_by_human ?? 0) === 1,
      title: String(row.title),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      refs: JSON.parse(String(row.refs_json)) as string[],
      externalRef: row.external_ref ? String(row.external_ref) : null,
      sourceRef: row.source_ref ? String(row.source_ref) : null,
      occurredAt: row.occurred_at == null ? null : String(row.occurred_at),
      originSessionId: row.origin_session_id
        ? String(row.origin_session_id)
        : null,
      sensitivity: (row.sensitivity
        ? String(row.sensitivity)
        : "internal") as Sensitivity,
      redactedAt: row.redacted_at ? String(row.redacted_at) : null,
      redactedBy: row.redacted_by ? String(row.redacted_by) : null,
      redactedReason: row.redacted_reason ? String(row.redacted_reason) : null,
      createdAt: String(row.created_at),
    };
  }

  // ---- Objects, Entry-Object Links & Resource Tags (Migration v3) ----

  insertObject(obj: MindObject): void {
    this.transaction(() => {
      const state = obj.state ?? "active";
      this.db
        .prepare(
          `INSERT INTO objects (id, org_id, parent_object_id, realm_id, kind, name, created_at, state, state_label, state_since, state_evidence_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          obj.id,
          obj.orgId,
          obj.parentObjectId,
          obj.realmId,
          obj.kind,
          obj.name,
          obj.createdAt,
          state,
          state !== "active" ? (obj.stateLabel ?? null) : null,
          state !== "active" ? (obj.stateSince ?? null) : null,
          state !== "active" ? (obj.stateEvidenceId ?? null) : null,
        );
      const norm = normalizeAlias(obj.name);
      if (norm.length > 0) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO object_aliases (org_id, object_id, alias, alias_norm, is_name)
             VALUES (?, ?, ?, ?, 1)`,
          )
          .run(obj.orgId, obj.id, obj.name, norm);
      }
    });
  }

  getObject(id: string): MindObject | null {
    const row = this.db
      .prepare(`SELECT * FROM objects WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapObject(row) : null;
  }

  getObjectsByIds(ids: string[]): MindObject[] {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) return [];
    const results: MindObject[] = [];
    const CHUNK = 500;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      const rows = this.db
        .prepare(
          `SELECT * FROM objects WHERE id IN (${placeholders(slice.length)})`,
        )
        .all(...slice) as Array<Record<string, unknown>>;
      for (const r of rows) {
        results.push(this.mapObject(r));
      }
    }
    return results;
  }

  listObjects(filter: {
    orgId: string;
    realmIds?: string[];
    parentObjectId?: string | null;
    kind?: string;
  }): MindObject[] {
    if (filter.realmIds && filter.realmIds.length === 0) return [];
    const where: string[] = [`org_id = ?`];
    const params: SQLInputValue[] = [filter.orgId];

    if (filter.realmIds && filter.realmIds.length > 0) {
      where.push(`realm_id IN (${placeholders(filter.realmIds.length)})`);
      params.push(...filter.realmIds);
    }
    if (filter.parentObjectId !== undefined) {
      if (filter.parentObjectId === null) {
        where.push(`parent_object_id IS NULL`);
      } else {
        where.push(`parent_object_id = ?`);
        params.push(filter.parentObjectId);
      }
    }
    if (filter.kind) {
      where.push(`kind = ?`);
      params.push(filter.kind);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM objects WHERE ${where.join(" AND ")} ORDER BY created_at ASC, id ASC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapObject(r));
  }

  updateObjectParent(id: string, parentObjectId: string | null): boolean {
    const res = this.db
      .prepare(`UPDATE objects SET parent_object_id = ? WHERE id = ?`)
      .run(parentObjectId, id);
    return Number(res.changes) > 0;
  }

  updateObjectState(params: {
    id: string;
    state: ObjectState;
    stateLabel: string | null;
    stateSince: string | null;
    stateEvidenceId: string | null;
  }): boolean {
    const res = this.db
      .prepare(
        `UPDATE objects
         SET state = ?,
             state_label = ?,
             state_since = ?,
             state_evidence_id = ?
         WHERE id = ?`,
      )
      .run(
        params.state,
        params.stateLabel,
        params.stateSince,
        params.stateEvidenceId,
        params.id,
      );
    return Number(res.changes) > 0;
  }

  listInactiveObjects(orgId: string, realmIds: string[]): MindObject[] {
    if (realmIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM objects
         WHERE org_id = ? AND realm_id IN (${placeholders(realmIds.length)}) AND state != 'active'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(orgId, ...realmIds) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapObject(r));
  }

  listObjectAliases(objectIds: string[]): ObjectAlias[] {
    const unique = Array.from(new Set(objectIds.filter(Boolean)));
    if (unique.length === 0) return [];
    const results: ObjectAlias[] = [];
    const CHUNK = 500;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      const rows = this.db
        .prepare(
          `SELECT org_id, object_id, alias, alias_norm, is_name
           FROM object_aliases
           WHERE object_id IN (${placeholders(slice.length)})
           ORDER BY is_name ASC, alias_norm ASC`,
        )
        .all(...slice) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const flag = Number(r.is_name ?? 0);
        results.push({
          orgId: String(r.org_id),
          objectId: String(r.object_id),
          alias: String(r.alias),
          aliasNorm: String(r.alias_norm),
          isName: flag === 1 || flag === 2,
          isExplicit: flag === 0 || flag === 2,
        });
      }
    }
    return results;
  }

  upsertObjectAlias(alias: ObjectAlias): void {
    const flag = alias.isName ? (alias.isExplicit ? 2 : 1) : 0;
    this.db
      .prepare(
        `INSERT INTO object_aliases (org_id, object_id, alias, alias_norm, is_name)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(object_id, alias_norm) DO UPDATE SET
           alias = excluded.alias,
           is_name = excluded.is_name`,
      )
      .run(alias.orgId, alias.objectId, alias.alias, alias.aliasNorm, flag);
  }

  deleteObjectAlias(objectId: string, aliasNorm: string): boolean {
    const res = this.db
      .prepare(
        `DELETE FROM object_aliases WHERE object_id = ? AND alias_norm = ?`,
      )
      .run(objectId, aliasNorm);
    return Number(res.changes) > 0;
  }

  countVisibleAliasOwners(params: {
    orgId: string;
    realmIds: string[];
    aliasNorms: string[];
  }): Map<string, number> {
    const out = new Map<string, number>();
    if (params.realmIds.length === 0 || params.aliasNorms.length === 0) {
      return out;
    }
    const uniqueNorms = Array.from(new Set(params.aliasNorms.filter(Boolean)));
    if (uniqueNorms.length === 0) return out;
    const CHUNK = 300;
    for (let i = 0; i < uniqueNorms.length; i += CHUNK) {
      const slice = uniqueNorms.slice(i, i + CHUNK);
      const rows = this.db
        .prepare(
          `SELECT oa.alias_norm AS alias_norm, COUNT(DISTINCT oa.object_id) AS c
           FROM object_aliases oa
           JOIN objects o ON o.id = oa.object_id
           WHERE oa.org_id = ?
             AND o.org_id = ?
             AND o.realm_id IN (${placeholders(params.realmIds.length)})
             AND oa.alias_norm IN (${placeholders(slice.length)})
           GROUP BY oa.alias_norm`,
        )
        .all(params.orgId, params.orgId, ...params.realmIds, ...slice) as Array<{
        alias_norm: string;
        c: number;
      }>;
      for (const r of rows) {
        out.set(String(r.alias_norm), Number(r.c));
      }
    }
    return out;
  }

  clearObjectStateEvidenceByEntry(
    entryId: string,
  ): Array<{ id: string; orgId: string; realmId: string }> {
    // Keyed strictly on state_evidence_id + state != 'active' (NO org_id filter:
    // redact() fallback orgId can be "" on edge cases). Preserves state and state_since.
    const rows = this.db
      .prepare(
        `SELECT id, org_id, realm_id
         FROM objects
         WHERE state != 'active' AND state_evidence_id = ?
         ORDER BY id ASC`,
      )
      .all(entryId) as Array<{
      id: string;
      org_id: string;
      realm_id: string;
    }>;
    if (rows.length === 0) return [];
    this.db
      .prepare(
        `UPDATE objects
         SET state_label = NULL,
             state_evidence_id = NULL
         WHERE state != 'active' AND state_evidence_id = ?`,
      )
      .run(entryId);
    return rows.map((r) => ({
      id: String(r.id),
      orgId: String(r.org_id),
      realmId: String(r.realm_id),
    }));
  }

  countVisibleLinkedEntriesForObject(params: {
    orgId: string;
    objectId: string;
    ledgerRealmIds: string[];
    seabedRealmIds: string[];
    excludeEntryId?: string | null;
  }): number {
    let total = 0;
    const excludeId = params.excludeEntryId?.trim() || null;

    if (params.ledgerRealmIds.length > 0) {
      const sqlParams: SQLInputValue[] = [
        params.orgId,
        params.objectId,
        params.orgId,
        ...params.ledgerRealmIds,
      ];
      let excludeClause = "";
      if (excludeId) {
        excludeClause = " AND r.id != ?";
        sqlParams.push(excludeId);
      }
      const row = this.db
        .prepare(
          `SELECT COUNT(DISTINCT eo.entry_id) AS c
           FROM entry_objects eo
           JOIN records r ON r.id = eo.entry_id
           WHERE eo.org_id = ?
             AND eo.object_id = ?
             AND r.org_id = ?
             AND r.realm_id IN (${placeholders(params.ledgerRealmIds.length)})
             AND r.status = 'active'
             AND r.redacted_at IS NULL
             AND r.sensitivity != 'secret'${excludeClause}`,
        )
        .get(...sqlParams) as { c: number };
      total += Number(row.c);
    }

    if (params.seabedRealmIds.length > 0) {
      const sqlParams: SQLInputValue[] = [
        params.orgId,
        params.objectId,
        params.orgId,
        ...params.seabedRealmIds,
      ];
      let excludeClause = "";
      if (excludeId) {
        excludeClause = " AND s.id != ?";
        sqlParams.push(excludeId);
      }
      const row = this.db
        .prepare(
          `SELECT COUNT(DISTINCT eo.entry_id) AS c
           FROM entry_objects eo
           JOIN seabed_entries s ON s.id = eo.entry_id
           WHERE eo.org_id = ?
             AND eo.object_id = ?
             AND s.org_id = ?
             AND s.realm_id IN (${placeholders(params.seabedRealmIds.length)})
             AND s.redacted_at IS NULL
             AND s.sensitivity != 'secret'${excludeClause}`,
        )
        .get(...sqlParams) as { c: number };
      total += Number(row.c);
    }

    return total;
  }

  countChildObjects(parentObjectId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM objects WHERE parent_object_id = ?`)
      .get(parentObjectId) as { c: number };
    return Number(row.c);
  }

  deleteObject(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM objects WHERE id = ?`).run(id);
    return Number(res.changes) > 0;
  }

  private mapObject(row: Record<string, unknown>): MindObject {
    const state = row.state ? String(row.state) : "active";
    const obj: MindObject = {
      id: String(row.id),
      orgId: String(row.org_id),
      parentObjectId: row.parent_object_id
        ? String(row.parent_object_id)
        : null,
      realmId: String(row.realm_id),
      kind: String(row.kind),
      name: String(row.name),
      createdAt: String(row.created_at),
    };
    if (state !== "active") {
      obj.state = state as ObjectState;
      obj.stateLabel = row.state_label == null ? null : String(row.state_label);
      obj.stateSince = row.state_since == null ? null : String(row.state_since);
      obj.stateEvidenceId =
        row.state_evidence_id == null ? null : String(row.state_evidence_id);
    }
    return obj;
  }

  insertEntryObject(link: EntryObjectLink): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entry_objects (entry_id, org_id, object_id)
         VALUES (?, ?, ?)`,
      )
      .run(link.entryId, link.orgId, link.objectId);
  }

  deleteEntryObject(entryId: string, objectId: string): boolean {
    const res = this.db
      .prepare(
        `DELETE FROM entry_objects WHERE entry_id = ? AND object_id = ?`,
      )
      .run(entryId, objectId);
    return Number(res.changes) > 0;
  }

  deleteEntryObjectsByEntry(entryId: string): number {
    const res = this.db
      .prepare(`DELETE FROM entry_objects WHERE entry_id = ?`)
      .run(entryId);
    return Number(res.changes);
  }

  listObjectIdsForEntry(entryId: string, orgId?: string): string[] {
    const rows = orgId
      ? (this.db
          .prepare(
            `SELECT object_id FROM entry_objects WHERE entry_id = ? AND org_id = ? ORDER BY object_id ASC`,
          )
          .all(entryId, orgId) as Array<{ object_id: string }>)
      : (this.db
          .prepare(
            `SELECT object_id FROM entry_objects WHERE entry_id = ? ORDER BY object_id ASC`,
          )
          .all(entryId) as Array<{ object_id: string }>);
    return rows.map((r) => String(r.object_id));
  }

  listObjectIdsByEntryIds(
    orgId: string,
    entryIds: string[],
  ): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const unique = Array.from(new Set(entryIds.filter(Boolean)));
    if (unique.length === 0) return out;
    const CHUNK = 500;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      const rows = this.db
        .prepare(
          `SELECT entry_id, object_id FROM entry_objects
           WHERE org_id = ? AND entry_id IN (${placeholders(slice.length)})
           ORDER BY object_id ASC`,
        )
        .all(orgId, ...slice) as Array<{ entry_id: string; object_id: string }>;
      for (const r of rows) {
        const eid = String(r.entry_id);
        const list = out.get(eid) ?? [];
        list.push(String(r.object_id));
        out.set(eid, list);
      }
    }
    return out;
  }

  listObjectRealmIdsForEntry(entryId: string, orgId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT o.realm_id
         FROM entry_objects eo
         JOIN objects o ON o.id = eo.object_id
         WHERE eo.entry_id = ? AND eo.org_id = ? AND o.org_id = ?`,
      )
      .all(entryId, orgId, orgId) as Array<{ realm_id: string }>;
    return rows.map((r) => String(r.realm_id));
  }

  listObjectRealmIdsByEntryIds(
    orgId: string,
    entryIds: string[],
  ): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const unique = Array.from(new Set(entryIds.filter(Boolean)));
    if (unique.length === 0) return out;
    const CHUNK = 500;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      const rows = this.db
        .prepare(
          `SELECT DISTINCT eo.entry_id, o.realm_id
           FROM entry_objects eo
           JOIN objects o ON o.id = eo.object_id
           WHERE eo.org_id = ? AND o.org_id = ? AND eo.entry_id IN (${placeholders(slice.length)})`,
        )
        .all(orgId, orgId, ...slice) as Array<{
        entry_id: string;
        realm_id: string;
      }>;
      for (const r of rows) {
        const eid = String(r.entry_id);
        const list = out.get(eid) ?? [];
        list.push(String(r.realm_id));
        out.set(eid, list);
      }
    }
    return out;
  }

  listEntryIdsForObjects(orgId: string, objectIds: string[]): string[] {
    if (objectIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT entry_id
         FROM entry_objects
         WHERE org_id = ? AND object_id IN (${placeholders(objectIds.length)})`,
      )
      .all(orgId, ...objectIds) as Array<{ entry_id: string }>;
    return rows.map((r) => String(r.entry_id));
  }

  listEntryIdsByObjectRealm(orgId: string, realmId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT eo.entry_id
         FROM entry_objects eo
         JOIN objects o ON o.id = eo.object_id
         WHERE eo.org_id = ? AND o.org_id = ? AND o.realm_id = ?`,
      )
      .all(orgId, orgId, realmId) as Array<{ entry_id: string }>;
    return rows.map((r) => String(r.entry_id));
  }

  insertResourceTag(tag: ResourceTag): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO resource_tags (entry_id, org_id, tag)
         VALUES (?, ?, ?)`,
      )
      .run(tag.entryId, tag.orgId, tag.tag);
  }

  deleteResourceTag(entryId: string, tag: string): boolean {
    const res = this.db
      .prepare(`DELETE FROM resource_tags WHERE entry_id = ? AND tag = ?`)
      .run(entryId, tag);
    return Number(res.changes) > 0;
  }

  deleteResourceTagsByEntry(entryId: string): number {
    const res = this.db
      .prepare(`DELETE FROM resource_tags WHERE entry_id = ?`)
      .run(entryId);
    return Number(res.changes);
  }

  listResourceTagsForEntry(entryId: string, orgId?: string): string[] {
    const rows = orgId
      ? (this.db
          .prepare(
            `SELECT tag FROM resource_tags WHERE entry_id = ? AND org_id = ? ORDER BY tag ASC`,
          )
          .all(entryId, orgId) as Array<{ tag: string }>)
      : (this.db
          .prepare(
            `SELECT tag FROM resource_tags WHERE entry_id = ? ORDER BY tag ASC`,
          )
          .all(entryId) as Array<{ tag: string }>);
    return rows.map((r) => String(r.tag));
  }

  listResourceTagsByEntryIds(
    orgId: string,
    entryIds: string[],
  ): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const unique = Array.from(new Set(entryIds.filter(Boolean)));
    if (unique.length === 0) return out;
    const CHUNK = 500;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      const rows = this.db
        .prepare(
          `SELECT entry_id, tag FROM resource_tags
           WHERE org_id = ? AND entry_id IN (${placeholders(slice.length)})
           ORDER BY tag ASC`,
        )
        .all(orgId, ...slice) as Array<{ entry_id: string; tag: string }>;
      for (const r of rows) {
        const eid = String(r.entry_id);
        const list = out.get(eid) ?? [];
        list.push(String(r.tag));
        out.set(eid, list);
      }
    }
    return out;
  }

  listEntryIdsByResourceTag(orgId: string, tag: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT entry_id FROM resource_tags WHERE org_id = ? AND tag = ?`,
      )
      .all(orgId, tag) as Array<{ entry_id: string }>;
    return rows.map((r) => String(r.entry_id));
  }

  listVisibleResourceTags(params: {
    orgId: string;
    ledgerRealmIds: string[];
    seabedRealmIds: string[];
    prefix?: string;
  }): ResourceTagSummary[] {
    if (
      params.ledgerRealmIds.length === 0 &&
      params.seabedRealmIds.length === 0
    ) {
      return [];
    }

    const visibilityClauses: string[] = [];
    const sqlParams: SQLInputValue[] = [params.orgId];

    if (params.ledgerRealmIds.length > 0) {
      visibilityClauses.push(
        `EXISTS (
          SELECT 1 FROM records r
          WHERE r.id = rt.entry_id
            AND r.org_id = rt.org_id
            AND r.realm_id IN (${placeholders(params.ledgerRealmIds.length)})
            AND r.sensitivity != 'secret'
            AND r.redacted_at IS NULL
            AND r.status != 'retracted'
        )`,
      );
      sqlParams.push(...params.ledgerRealmIds);
    }

    if (params.seabedRealmIds.length > 0) {
      visibilityClauses.push(
        `EXISTS (
          SELECT 1 FROM seabed_entries s
          WHERE s.id = rt.entry_id
            AND s.org_id = rt.org_id
            AND s.realm_id IN (${placeholders(params.seabedRealmIds.length)})
            AND s.sensitivity != 'secret'
            AND s.redacted_at IS NULL
        )`,
      );
      sqlParams.push(...params.seabedRealmIds);
    }

    const where: string[] = [
      `rt.org_id = ?`,
      `(${visibilityClauses.join(" OR ")})`,
    ];
    if (params.prefix && params.prefix.trim()) {
      where.push(`rt.tag LIKE ?`);
      sqlParams.push(`${params.prefix.trim()}%`);
    }

    const rows = this.db
      .prepare(
        `SELECT rt.tag AS tag, COUNT(DISTINCT rt.entry_id) AS c
         FROM resource_tags rt
         WHERE ${where.join(" AND ")}
         GROUP BY rt.tag
         ORDER BY c DESC, rt.tag ASC`,
      )
      .all(...sqlParams) as Array<{ tag: string; c: number }>;

    return rows.map((r) => ({
      tag: String(r.tag),
      count: Number(r.c),
    }));
  }

  // ---- Distillations ----

  insertDistillation(distillation: Distillation): void {
    this.db
      .prepare(
        `INSERT INTO distillations
         (id, realm_id, layer, period_key, status, hard_facts_json, narrative_md, source_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        distillation.id,
        distillation.realmId,
        distillation.layer,
        distillation.periodKey,
        distillation.status,
        JSON.stringify(distillation.hardFacts),
        distillation.narrativeMd,
        JSON.stringify(distillation.sourceIds),
        distillation.createdAt,
      );
  }

  supersedeActiveDistillations(
    realmId: string,
    layer: DistillationLayer,
    periodKey: string,
    exceptId: string,
  ): void {
    const rows = this.db
      .prepare(
        `SELECT id FROM distillations
         WHERE realm_id = ? AND layer = ? AND period_key = ? AND status = 'active' AND id != ?`,
      )
      .all(realmId, layer, periodKey, exceptId) as Array<{ id: string }>;

    this.db
      .prepare(
        `UPDATE distillations SET status = 'superseded'
         WHERE realm_id = ? AND layer = ? AND period_key = ? AND status = 'active' AND id != ?`,
      )
      .run(realmId, layer, periodKey, exceptId);

    for (const row of rows) {
      this.updateFtsStatus(row.id, "superseded");
      this.updateVectorStatus(row.id, "superseded");
    }
  }

  getDistillation(id: string): Distillation | null {
    const row = this.db
      .prepare(`SELECT * FROM distillations WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapDistillation(row) : null;
  }

  getDistillationsByIds(ids: string[]): Distillation[] {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) return [];
    const results: Distillation[] = [];
    const CHUNK = 500;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      const rows = this.db
        .prepare(
          `SELECT * FROM distillations WHERE id IN (${placeholders(slice.length)})`,
        )
        .all(...slice) as Array<Record<string, unknown>>;
      for (const r of rows) {
        results.push(this.mapDistillation(r));
      }
    }
    return results;
  }

  getLatestDistillation(
    realmId: string,
    layer: DistillationLayer,
  ): Distillation | null {
    const row = this.db
      .prepare(
        `SELECT * FROM distillations
         WHERE realm_id = ? AND layer = ? AND status = 'active'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(realmId, layer) as Record<string, unknown> | undefined;
    return row ? this.mapDistillation(row) : null;
  }

  getLatestDistillationsByRealms(
    realmIds: string[],
    layer: DistillationLayer,
  ): Map<string, Distillation> {
    const out = new Map<string, Distillation>();
    const unique = Array.from(new Set(realmIds.filter(Boolean)));
    if (unique.length === 0) return out;
    const rows = this.db
      .prepare(
        `SELECT * FROM distillations
         WHERE realm_id IN (${placeholders(unique.length)}) AND layer = ? AND status = 'active'
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...unique, layer) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const rid = String(r.realm_id);
      if (!out.has(rid)) {
        out.set(rid, this.mapDistillation(r));
      }
    }
    return out;
  }

  listDistillations(filter: {
    realmIds: string[];
    layers?: DistillationLayer[];
    includeSuperseded?: boolean;
    limit?: number;
    offset?: number;
  }): { items: Distillation[]; total: number } {
    if (filter.realmIds.length === 0) {
      return { items: [], total: 0 };
    }
    const where: string[] = [
      `realm_id IN (${placeholders(filter.realmIds.length)})`,
    ];
    const params: SQLInputValue[] = [...filter.realmIds];

    if (!filter.includeSuperseded) {
      where.push(`status = 'active'`);
    }
    if (filter.layers && filter.layers.length > 0) {
      where.push(`layer IN (${placeholders(filter.layers.length)})`);
      params.push(...filter.layers);
    }

    const whereSql = where.join(" AND ");
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as c FROM distillations WHERE ${whereSql}`)
      .get(...params) as { c: number };

    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM distillations WHERE ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      items: rows.map((r) => this.mapDistillation(r)),
      total: Number(totalRow.c),
    };
  }

  listAllDistillations(): Distillation[] {
    const rows = this.db
      .prepare(`SELECT * FROM distillations ORDER BY created_at ASC, rowid ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapDistillation(r));
  }

  listDistillationsBatch(afterId: string, limit: number): Distillation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM distillations WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapDistillation(r));
  }

  listAllCanonicalIds(): Set<string> {
    const out = new Set<string>();
    const BATCH = 500;
    const collectTable = (table: "records" | "seabed_entries" | "distillations") => {
      const stmt = this.db.prepare(
        `SELECT id FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?`,
      );
      let lastId = "";
      while (true) {
        const rows = stmt.all(lastId, BATCH) as Array<{ id: string }>;
        if (rows.length === 0) break;
        for (const r of rows) {
          out.add(String(r.id));
        }
        lastId = String(rows[rows.length - 1]!.id);
        if (rows.length < BATCH) break;
      }
    };
    collectTable("records");
    collectTable("seabed_entries");
    collectTable("distillations");
    return out;
  }

  private mapDistillation(row: Record<string, unknown>): Distillation {
    return {
      id: String(row.id),
      realmId: String(row.realm_id),
      layer: String(row.layer) as DistillationLayer,
      periodKey: String(row.period_key),
      status: String(row.status) as Distillation["status"],
      hardFacts: JSON.parse(String(row.hard_facts_json)) as Record<
        string,
        unknown
      >,
      narrativeMd: String(row.narrative_md),
      sourceIds: JSON.parse(String(row.source_ids_json)) as string[],
      createdAt: String(row.created_at),
    };
  }

  // ---- Drive File Meta ----

  upsertDriveFileMeta(meta: DriveFileMeta): void {
    this.db
      .prepare(
        `INSERT INTO drive_files (realm_id, rel_path, sha256, version, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(realm_id, rel_path) DO UPDATE SET
           sha256 = excluded.sha256,
           version = excluded.version,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(
        meta.realmId,
        meta.relPath,
        meta.sha256,
        meta.version,
        meta.updatedBy,
        meta.updatedAt,
      );
  }

  getDriveFileMeta(realmId: string, relPath: string): DriveFileMeta | null {
    const row = this.db
      .prepare(
        `SELECT * FROM drive_files WHERE realm_id = ? AND rel_path = ?`,
      )
      .get(realmId, relPath) as Record<string, unknown> | undefined;
    return row ? this.mapDriveMeta(row) : null;
  }

  listDriveFilesMeta(realmIds: string[]): DriveFileMeta[] {
    if (realmIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM drive_files WHERE realm_id IN (${placeholders(realmIds.length)}) ORDER BY realm_id ASC, rel_path ASC`,
      )
      .all(...realmIds) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapDriveMeta(r));
  }

  private mapDriveMeta(row: Record<string, unknown>): DriveFileMeta {
    return {
      realmId: String(row.realm_id),
      relPath: String(row.rel_path),
      sha256: String(row.sha256),
      version: Number(row.version),
      updatedBy: String(row.updated_by),
      updatedAt: String(row.updated_at),
    };
  }

  // ---- Idempotency Keys ----

  getIdempotencyKey(orgId: string, key: string): IdempotencyRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM idempotency_keys WHERE org_id = ? AND key = ?`,
      )
      .get(orgId, key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      orgId: String(row.org_id),
      key: String(row.key),
      targetTable: String(row.target_table) as IdempotencyRecord["targetTable"],
      targetId: String(row.target_id),
      realmId: String(row.realm_id),
      payloadHash: String(row.payload_hash),
      createdAt: String(row.created_at),
    };
  }

  insertIdempotencyKey(record: IdempotencyRecord): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_keys
         (org_id, key, target_table, target_id, realm_id, payload_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.orgId,
        record.key,
        record.targetTable,
        record.targetId,
        record.realmId,
        record.payloadHash,
        record.createdAt,
      );
  }

  // ---- Change Log ----

  getChangeLogGeneration(): number {
    const raw = this.getMeta("change_log_generation");
    const parsed = raw ? Number.parseInt(raw, 10) : 1;
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  }

  getLatestChangeLogSeq(orgId?: string): number {
    const row = orgId
      ? (this.db
          .prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM change_log WHERE org_id = ?`)
          .get(orgId) as { s: number })
      : (this.db
          .prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM change_log`)
          .get() as { s: number });
    return Number(row.s ?? 0);
  }

  getLatestVisibleChangeLogSeq(params: {
    orgId: string;
    ledgerRealmIds: string[];
    seabedRealmIds: string[];
    includeSecret?: boolean;
  }): number {
    const visClauses: string[] = [`cl.realm_id = '__org__'`];
    const sqlParams: SQLInputValue[] = [params.orgId];

    if (params.ledgerRealmIds.length > 0) {
      visClauses.push(
        `(cl.entity_type != 'seabed' AND cl.realm_id IN (${placeholders(params.ledgerRealmIds.length)}))`,
      );
      sqlParams.push(...params.ledgerRealmIds);
    }
    if (params.seabedRealmIds.length > 0) {
      visClauses.push(
        `(cl.entity_type = 'seabed' AND cl.realm_id IN (${placeholders(params.seabedRealmIds.length)}))`,
      );
      sqlParams.push(...params.seabedRealmIds);
    }

    const where: string[] = [
      `cl.org_id = ?`,
      `(${visClauses.join(" OR ")})`,
    ];
    if (!params.includeSecret) {
      where.push(`NOT (
        cl.entity_type = 'record'
        AND EXISTS (
          SELECT 1 FROM records r
          WHERE r.id = cl.entity_id AND r.sensitivity = 'secret'
        )
      )`);
      where.push(`NOT (
        cl.entity_type = 'seabed'
        AND EXISTS (
          SELECT 1 FROM seabed_entries s
          WHERE s.id = cl.entity_id AND s.sensitivity = 'secret'
        )
      )`);
    }

    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(cl.seq), 0) AS s FROM change_log cl WHERE ${where.join(" AND ")}`,
      )
      .get(...sqlParams) as { s: number };
    return Number(row.s ?? 0);
  }

  getChangeLogSeqForEntity(entityType: string, entityId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT seq FROM change_log
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(entityType, entityId) as { seq: number } | undefined;
    return row ? Number(row.seq) : null;
  }

  countChangeLogSince(params: {
    orgId: string;
    realmIds: string[];
    sinceSeq: number;
    generation: number;
    includeSecret?: boolean;
  }): number {
    if (params.realmIds.length === 0) return 0;
    const where: string[] = [
      `cl.org_id = ?`,
      `cl.generation = ?`,
      `cl.seq > ?`,
      `cl.realm_id IN (${placeholders(params.realmIds.length)})`,
    ];
    const sqlParams: SQLInputValue[] = [
      params.orgId,
      params.generation,
      params.sinceSeq,
      ...params.realmIds,
    ];
    if (!params.includeSecret) {
      where.push(`NOT (
        cl.entity_type = 'record'
        AND EXISTS (
          SELECT 1 FROM records r
          WHERE r.id = cl.entity_id AND r.sensitivity = 'secret'
        )
      )`);
      where.push(`NOT (
        cl.entity_type = 'seabed'
        AND EXISTS (
          SELECT 1 FROM seabed_entries s
          WHERE s.id = cl.entity_id AND s.sensitivity = 'secret'
        )
      )`);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM change_log cl WHERE ${where.join(" AND ")}`)
      .get(...sqlParams) as { c: number };
    return Number(row.c ?? 0);
  }

  appendChangeLog(
    entry: Omit<ChangeLogEntry, "seq" | "generation">,
  ): ChangeLogEntry {
    const generation = this.getChangeLogGeneration();
    const res = this.db
      .prepare(
        `INSERT INTO change_log
         (generation, org_id, realm_id, entity_type, entity_id, op, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        generation,
        entry.orgId,
        entry.realmId,
        entry.entityType,
        entry.entityId,
        entry.op,
        entry.actorId,
        entry.createdAt,
      );
    return {
      seq: Number(res.lastInsertRowid),
      generation,
      ...entry,
    };
  }

  listChangeLog(params?: {
    orgId?: string;
    realmIds?: string[];
    sinceSeq?: number;
    limit?: number;
    includeSecret?: boolean;
  }): { generation: number; entries: ChangeLogEntry[] } {
    const generation = this.getChangeLogGeneration();
    const where: string[] = [];
    const sqlParams: SQLInputValue[] = [];
    if (params?.orgId) {
      where.push(`cl.org_id = ?`);
      sqlParams.push(params.orgId);
    }
    if (params?.realmIds) {
      if (params.realmIds.length === 0) {
        return { generation, entries: [] };
      }
      where.push(`cl.realm_id IN (${placeholders(params.realmIds.length)})`);
      sqlParams.push(...params.realmIds);
    }
    if (params?.sinceSeq !== undefined) {
      where.push(`cl.seq > ?`);
      sqlParams.push(params.sinceSeq);
    }
    if (!params?.includeSecret) {
      where.push(`NOT (
        cl.entity_type = 'record'
        AND EXISTS (
          SELECT 1 FROM records r
          WHERE r.id = cl.entity_id AND r.sensitivity = 'secret'
        )
      )`);
      where.push(`NOT (
        cl.entity_type = 'seabed'
        AND EXISTS (
          SELECT 1 FROM seabed_entries s
          WHERE s.id = cl.entity_id AND s.sensitivity = 'secret'
        )
      )`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = params?.limit ?? 200;
    const rows = this.db
      .prepare(
        `SELECT cl.* FROM change_log cl ${whereSql} ORDER BY cl.seq ASC LIMIT ?`,
      )
      .all(...sqlParams, limit) as Array<Record<string, unknown>>;

    return {
      generation,
      entries: rows.map((r) => ({
        seq: Number(r.seq),
        generation: Number(r.generation),
        orgId: String(r.org_id),
        realmId: String(r.realm_id),
        entityType: String(r.entity_type),
        entityId: String(r.entity_id),
        op: String(r.op),
        actorId: String(r.actor_id),
        createdAt: String(r.created_at),
      })),
    };
  }

  resetChangeLog(): { generation: number; clearedCount: number } {
    return this.transaction(() => {
      const countRow = this.db
        .prepare(`SELECT COUNT(*) AS c FROM change_log`)
        .get() as { c: number };
      this.db.exec(`DELETE FROM change_log;`);
      const nextGen = this.getChangeLogGeneration() + 1;
      this.setMeta("change_log_generation", String(nextGen));
      return {
        generation: nextGen,
        clearedCount: Number(countRow.c),
      };
    });
  }

  // ---- Rebuildable FTS5 Index (fts_docs side-table + contentless_delete FTS5) ----

  upsertFtsItem(item: {
    itemId: string;
    orgId: string;
    sourceType: "record" | "seabed" | "distillation";
    realmId: string;
    status: string;
    kind: string;
    occurredAt: string | null;
    title: string;
    body: string;
  }): void {
    this.transaction(() => {
      const existing = this.db
        .prepare(`SELECT docid FROM fts_docs WHERE item_id = ?`)
        .get(item.itemId) as { docid: number } | undefined;
      if (existing) {
        this.db
          .prepare(`DELETE FROM fts_index WHERE rowid = ?`)
          .run(existing.docid);
        this.db
          .prepare(`DELETE FROM fts_docs WHERE docid = ?`)
          .run(existing.docid);
      }
      const info = this.db
        .prepare(
          `INSERT INTO fts_docs (item_id, org_id, source_type, realm_id, status, kind, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.itemId,
          item.orgId,
          item.sourceType,
          item.realmId,
          item.status,
          item.kind,
          item.occurredAt,
        );
      const newDocid = Number(info.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO fts_index (rowid, title, body) VALUES (?, ?, ?)`,
        )
        .run(
          newDocid,
          normalizeForFts(item.title),
          normalizeForFts(item.body),
        );
    });
  }

  updateFtsStatus(itemId: string, status: string): void {
    this.db
      .prepare(`UPDATE fts_docs SET status = ? WHERE item_id = ?`)
      .run(status, itemId);
  }

  deleteFtsItem(itemId: string): void {
    this.transaction(() => {
      const existing = this.db
        .prepare(`SELECT docid FROM fts_docs WHERE item_id = ?`)
        .get(itemId) as { docid: number } | undefined;
      if (!existing) return;
      this.db
        .prepare(`DELETE FROM fts_index WHERE rowid = ?`)
        .run(existing.docid);
      this.db
        .prepare(`DELETE FROM fts_docs WHERE docid = ?`)
        .run(existing.docid);
    });
  }

  searchFts(params: {
    query?: string;
    ftsExpression?: string;
    realmIds: string[];
    sourceTypes?: Array<"record" | "seabed" | "distillation">;
    includeSuperseded: boolean;
    limit: number;
  }): FtsMatch[] {
    if (params.realmIds.length === 0) return [];
    const expr =
      params.ftsExpression ??
      (params.query ? buildFtsMatchExpression(params.query) : null);
    if (!expr) return [];

    const where: string[] = [
      `fts_index MATCH ?`,
      `d.realm_id IN (${placeholders(params.realmIds.length)})`,
    ];
    const sqlParams: SQLInputValue[] = [expr, ...params.realmIds];
    if (params.sourceTypes && params.sourceTypes.length > 0) {
      where.push(`d.source_type IN (${placeholders(params.sourceTypes.length)})`);
      sqlParams.push(...params.sourceTypes);
    }
    if (!params.includeSuperseded) {
      where.push(`d.status IN ('active', 'evidence')`);
    }

    const rows = this.db
      .prepare(
        `SELECT d.item_id, d.source_type, d.realm_id, d.status, bm25(fts_index) AS rank
         FROM fts_index
         CROSS JOIN fts_docs d ON d.docid = fts_index.rowid
         WHERE ${where.join(" AND ")}
         ORDER BY rank ASC, d.item_id ASC
         LIMIT ?`,
      )
      .all(...sqlParams, params.limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      itemId: String(r.item_id),
      sourceType: String(r.source_type) as FtsMatch["sourceType"],
      realmId: String(r.realm_id),
      status: String(r.status),
      rank: Number(r.rank),
    }));
  }

  countFts(params: {
    query?: string;
    ftsExpression?: string;
    realmIds: string[];
    sourceTypes?: Array<"record" | "seabed" | "distillation">;
    includeSuperseded: boolean;
  }): number {
    if (params.realmIds.length === 0) return 0;
    const expr =
      params.ftsExpression ??
      (params.query ? buildFtsMatchExpression(params.query) : null);
    if (!expr) return 0;

    const where: string[] = [
      `fts_index MATCH ?`,
      `d.realm_id IN (${placeholders(params.realmIds.length)})`,
    ];
    const sqlParams: SQLInputValue[] = [expr, ...params.realmIds];
    if (params.sourceTypes && params.sourceTypes.length > 0) {
      where.push(`d.source_type IN (${placeholders(params.sourceTypes.length)})`);
      sqlParams.push(...params.sourceTypes);
    }
    if (!params.includeSuperseded) {
      where.push(`d.status IN ('active', 'evidence')`);
    }

    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM fts_index
         CROSS JOIN fts_docs d ON d.docid = fts_index.rowid
         WHERE ${where.join(" AND ")}`,
      )
      .get(...sqlParams) as { c: number };
    return Number(row.c);
  }

  searchFtsUnified(params: UnifiedFtsSearchParams): UnifiedFtsSearchResult {
    const empty: UnifiedFtsSearchResult = {
      rows: [],
      total: 0,
      ledgerCount: 0,
      seabedCount: 0,
    };
    if (!params.ftsExpression || params.perBucketLimit <= 0) {
      return empty;
    }
    if (
      params.ledgerRealmIds.length === 0 &&
      params.seabedRealmIds.length === 0
    ) {
      return empty;
    }
    if (
      params.allowedEntryIds !== undefined &&
      params.allowedEntryIds.length === 0
    ) {
      return empty;
    }

    const hasRecKinds = Boolean(
      params.recordKinds && params.recordKinds.length > 0,
    );
    const hasSeaKinds = Boolean(
      params.seabedKinds && params.seabedKinds.length > 0,
    );
    if (hasRecKinds && !hasSeaKinds && params.ledgerRealmIds.length === 0) {
      return empty;
    }
    if (hasSeaKinds && !hasRecKinds && params.seabedRealmIds.length === 0) {
      return empty;
    }

    const where: string[] = [`fts_index MATCH ?`];
    const sqlParams: SQLInputValue[] = [params.ftsExpression];

    // Strict ledger vs seabed realm scope isolation (never union realm arrays)
    if (
      params.ledgerRealmIds.length > 0 &&
      params.seabedRealmIds.length > 0
    ) {
      where.push(
        `((d.source_type IN ('record', 'distillation') AND d.realm_id IN (${placeholders(params.ledgerRealmIds.length)})) OR (d.source_type = 'seabed' AND d.realm_id IN (${placeholders(params.seabedRealmIds.length)})))`,
      );
      sqlParams.push(...params.ledgerRealmIds, ...params.seabedRealmIds);
    } else if (params.ledgerRealmIds.length > 0) {
      where.push(
        `d.source_type IN ('record', 'distillation') AND d.realm_id IN (${placeholders(params.ledgerRealmIds.length)})`,
      );
      sqlParams.push(...params.ledgerRealmIds);
    } else {
      where.push(
        `d.source_type = 'seabed' AND d.realm_id IN (${placeholders(params.seabedRealmIds.length)})`,
      );
      sqlParams.push(...params.seabedRealmIds);
    }

    if (!params.includeSuperseded) {
      where.push(`d.status IN ('active', 'evidence')`);
    }

    // Explicit --kind SQL pushdown matching Stage 2 & JS semantics
    if (hasRecKinds && hasSeaKinds) {
      where.push(
        `((d.source_type = 'record' AND d.kind IN (${placeholders(params.recordKinds!.length)})) OR (d.source_type = 'seabed' AND d.kind IN (${placeholders(params.seabedKinds!.length)})))`,
      );
      sqlParams.push(...params.recordKinds!, ...params.seabedKinds!);
    } else if (hasRecKinds) {
      where.push(
        `d.source_type = 'record' AND d.kind IN (${placeholders(params.recordKinds!.length)})`,
      );
      sqlParams.push(...params.recordKinds!);
    } else if (hasSeaKinds) {
      where.push(
        `d.source_type = 'seabed' AND d.kind IN (${placeholders(params.seabedKinds!.length)})`,
      );
      sqlParams.push(...params.seabedKinds!);
    }

    if (params.since) {
      where.push(`d.occurred_at IS NOT NULL AND d.occurred_at >= ?`);
      sqlParams.push(params.since);
    }
    if (params.until) {
      where.push(`d.occurred_at IS NOT NULL AND d.occurred_at <= ?`);
      sqlParams.push(params.until);
    }
    if (params.dateWindows && params.dateWindows.length > 0) {
      const dateOrClauses: string[] = [];
      for (const w of params.dateWindows) {
        if (w.startDate && w.endDate) {
          dateOrClauses.push(
            `(substr(d.occurred_at, 1, 10) >= ? AND substr(d.occurred_at, 1, 10) <= ?)`,
          );
          sqlParams.push(w.startDate, w.endDate);
        } else if (w.monthDays && w.monthDays.length > 0) {
          dateOrClauses.push(
            `(substr(d.occurred_at, 6, 5) IN (${placeholders(w.monthDays.length)}))`,
          );
          sqlParams.push(...w.monthDays);
        }
      }
      if (dateOrClauses.length > 0) {
        where.push(
          `d.occurred_at IS NOT NULL AND (${dateOrClauses.join(" OR ")})`,
        );
      }
    }
    if (params.allowedEntryIds && params.allowedEntryIds.length > 0) {
      where.push(`d.item_id IN (SELECT value FROM json_each(?))`);
      sqlParams.push(JSON.stringify(params.allowedEntryIds));
    }

    const sql = `
      WITH m AS MATERIALIZED (
        SELECT d.item_id, d.source_type, d.realm_id, d.status, bm25(fts_index) AS rank
        FROM fts_index
        CROSS JOIN fts_docs d ON d.docid = fts_index.rowid
        WHERE ${where.join(" AND ")}
      )
      SELECT item_id, source_type, realm_id, status, rank,
             (SELECT COUNT(*) FROM m) AS total
      FROM (
        SELECT m.*,
               ROW_NUMBER() OVER (
                 PARTITION BY CASE WHEN source_type = 'seabed' THEN 1 ELSE 0 END
                 ORDER BY rank ASC, item_id ASC
               ) AS rn
        FROM m
      )
      WHERE rn <= ?
      ORDER BY rank ASC, item_id ASC
    `;

    const rawRows = this.db
      .prepare(sql)
      .all(...sqlParams, params.perBucketLimit) as Array<
      Record<string, unknown>
    >;

    if (rawRows.length === 0) {
      return empty;
    }

    const total = Number(rawRows[0]!.total ?? 0);
    let ledgerCount = 0;
    let seabedCount = 0;
    const rows: FtsMatch[] = rawRows.map((r) => {
      const sourceType = String(r.source_type) as FtsMatch["sourceType"];
      if (sourceType === "seabed") seabedCount += 1;
      else ledgerCount += 1;
      return {
        itemId: String(r.item_id),
        sourceType,
        realmId: String(r.realm_id),
        status: String(r.status),
        rank: Number(r.rank),
      };
    });

    return { rows, total, ledgerCount, seabedCount };
  }

  listEntriesByDateWindow(
    params: DateWindowQueryParams,
  ): DateWindowQueryResult {
    const empty: DateWindowQueryResult = {
      rows: [],
      total: 0,
      ledgerCount: 0,
      seabedCount: 0,
    };
    if (
      !params.dateWindows ||
      params.dateWindows.length === 0 ||
      params.perBucketLimit <= 0
    ) {
      return empty;
    }
    if (
      params.ledgerRealmIds.length === 0 &&
      params.seabedRealmIds.length === 0
    ) {
      return empty;
    }
    if (
      params.allowedEntryIds !== undefined &&
      params.allowedEntryIds.length === 0
    ) {
      return empty;
    }

    const hasRecKinds = Boolean(
      params.recordKinds && params.recordKinds.length > 0,
    );
    const hasSeaKinds = Boolean(
      params.seabedKinds && params.seabedKinds.length > 0,
    );
    if (hasRecKinds && !hasSeaKinds && params.ledgerRealmIds.length === 0) {
      return empty;
    }
    if (hasSeaKinds && !hasRecKinds && params.seabedRealmIds.length === 0) {
      return empty;
    }

    const where: string[] = [];
    const sqlParams: SQLInputValue[] = [];

    // Strict ledger vs seabed realm scope isolation (matching searchFtsUnified)
    if (
      params.ledgerRealmIds.length > 0 &&
      params.seabedRealmIds.length > 0
    ) {
      where.push(
        `((d.source_type IN ('record', 'distillation') AND d.realm_id IN (${placeholders(params.ledgerRealmIds.length)})) OR (d.source_type = 'seabed' AND d.realm_id IN (${placeholders(params.seabedRealmIds.length)})))`,
      );
      sqlParams.push(...params.ledgerRealmIds, ...params.seabedRealmIds);
    } else if (params.ledgerRealmIds.length > 0) {
      where.push(
        `d.source_type IN ('record', 'distillation') AND d.realm_id IN (${placeholders(params.ledgerRealmIds.length)})`,
      );
      sqlParams.push(...params.ledgerRealmIds);
    } else {
      where.push(
        `d.source_type = 'seabed' AND d.realm_id IN (${placeholders(params.seabedRealmIds.length)})`,
      );
      sqlParams.push(...params.seabedRealmIds);
    }

    if (!params.includeSuperseded) {
      where.push(`d.status IN ('active', 'evidence')`);
    }

    if (hasRecKinds && hasSeaKinds) {
      where.push(
        `((d.source_type = 'record' AND d.kind IN (${placeholders(params.recordKinds!.length)})) OR (d.source_type = 'seabed' AND d.kind IN (${placeholders(params.seabedKinds!.length)})))`,
      );
      sqlParams.push(...params.recordKinds!, ...params.seabedKinds!);
    } else if (hasRecKinds) {
      where.push(
        `d.source_type = 'record' AND d.kind IN (${placeholders(params.recordKinds!.length)})`,
      );
      sqlParams.push(...params.recordKinds!);
    } else if (hasSeaKinds) {
      where.push(
        `d.source_type = 'seabed' AND d.kind IN (${placeholders(params.seabedKinds!.length)})`,
      );
      sqlParams.push(...params.seabedKinds!);
    }

    if (params.since) {
      where.push(`d.occurred_at IS NOT NULL AND d.occurred_at >= ?`);
      sqlParams.push(params.since);
    }
    if (params.until) {
      where.push(`d.occurred_at IS NOT NULL AND d.occurred_at <= ?`);
      sqlParams.push(params.until);
    }

    const dateOrClauses: string[] = [];
    for (const w of params.dateWindows) {
      if (w.startDate && w.endDate) {
        dateOrClauses.push(
          `(substr(d.occurred_at, 1, 10) >= ? AND substr(d.occurred_at, 1, 10) <= ?)`,
        );
        sqlParams.push(w.startDate, w.endDate);
      } else if (w.monthDays && w.monthDays.length > 0) {
        dateOrClauses.push(
          `(substr(d.occurred_at, 6, 5) IN (${placeholders(w.monthDays.length)}))`,
        );
        sqlParams.push(...w.monthDays);
      }
    }
    if (dateOrClauses.length === 0) {
      return empty;
    }
    where.push(`d.occurred_at IS NOT NULL AND (${dateOrClauses.join(" OR ")})`);

    if (params.allowedEntryIds && params.allowedEntryIds.length > 0) {
      where.push(`d.item_id IN (SELECT value FROM json_each(?))`);
      sqlParams.push(JSON.stringify(params.allowedEntryIds));
    }

    const sql = `
      WITH m AS MATERIALIZED (
        SELECT d.item_id, d.source_type, d.realm_id, d.status, d.occurred_at
        FROM fts_docs d
        WHERE ${where.join(" AND ")}
      )
      SELECT item_id, source_type, realm_id, status, occurred_at,
             (SELECT COUNT(*) FROM m) AS total
      FROM (
        SELECT m.*,
               ROW_NUMBER() OVER (
                 PARTITION BY CASE WHEN source_type = 'seabed' THEN 1 ELSE 0 END
                 ORDER BY occurred_at DESC, item_id ASC
               ) AS rn
        FROM m
      )
      WHERE rn <= ?
      ORDER BY occurred_at DESC, item_id ASC
    `;

    const rawRows = this.db
      .prepare(sql)
      .all(...sqlParams, params.perBucketLimit) as Array<
      Record<string, unknown>
    >;

    if (rawRows.length === 0) {
      return empty;
    }

    const total = Number(rawRows[0]!.total ?? 0);
    let ledgerCount = 0;
    let seabedCount = 0;
    const rows: DateWindowMatch[] = rawRows.map((r) => {
      const sourceType = String(r.source_type) as DateWindowMatch["sourceType"];
      if (sourceType === "seabed") seabedCount += 1;
      else ledgerCount += 1;
      return {
        itemId: String(r.item_id),
        sourceType,
        realmId: String(r.realm_id),
        status: String(r.status),
        occurredAt: r.occurred_at == null ? null : String(r.occurred_at),
      };
    });

    return { rows, total, ledgerCount, seabedCount };
  }

  clearFtsIndex(): void {
    this.transaction(() => {
      this.db.exec(`INSERT INTO fts_index(fts_index) VALUES('delete-all');`);
      this.db.exec(`DELETE FROM fts_docs;`);
    });
  }

  // ---- Rebuildable sqlite-vec Index ----

  upsertVectorItem(item: {
    itemId: string;
    sourceType: "record" | "seabed" | "distillation";
    realmId: string;
    status: string;
    embedding: Float32Array;
  }): void {
    if (!this.vecEnabled) return;
    if (item.embedding.length !== this.vectorDimensions) {
      throw new MindError(
        "INVALID_INPUT",
        `Embedding dimension mismatch: expected ${this.vectorDimensions}, got ${item.embedding.length}`,
      );
    }
    this.db.prepare(`DELETE FROM vec_items WHERE item_id = ?`).run(item.itemId);
    this.db
      .prepare(
        `INSERT INTO vec_items (item_id, realm_id, status, source_type, embedding)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        item.itemId,
        item.realmId,
        item.status,
        item.sourceType,
        toVecBlob(item.embedding),
      );
    this.db
      .prepare(`DELETE FROM vec_pending WHERE item_id = ?`)
      .run(item.itemId);
  }

  markVectorPending(item: PendingVectorItem): void {
    const queuedAt = item.queuedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO vec_pending (item_id, source_type, org_id, realm_id, status, text, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           source_type = excluded.source_type,
           org_id = excluded.org_id,
           realm_id = excluded.realm_id,
           status = excluded.status,
           text = excluded.text,
           queued_at = excluded.queued_at`,
      )
      .run(
        item.itemId,
        item.sourceType,
        item.orgId,
        item.realmId,
        item.status,
        item.text,
        queuedAt,
      );
  }

  getPendingVector(itemId: string): PendingVectorItem | null {
    const row = this.db
      .prepare(`SELECT * FROM vec_pending WHERE item_id = ?`)
      .get(itemId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      itemId: String(row.item_id),
      sourceType: String(row.source_type) as PendingVectorItem["sourceType"],
      orgId: String(row.org_id),
      realmId: String(row.realm_id),
      status: String(row.status),
      text: String(row.text),
      queuedAt: String(row.queued_at),
    };
  }

  deletePendingVector(itemId: string): void {
    this.db.prepare(`DELETE FROM vec_pending WHERE item_id = ?`).run(itemId);
  }

  countPendingVectors(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM vec_pending`)
      .get() as { c: number };
    return Number(row.c);
  }

  updateVectorStatus(itemId: string, status: string): void {
    this.db
      .prepare(`UPDATE vec_pending SET status = ? WHERE item_id = ?`)
      .run(status, itemId);

    if (!this.vecEnabled) return;
    const row = this.db
      .prepare(
        `SELECT realm_id, source_type, embedding FROM vec_items WHERE item_id = ?`,
      )
      .get(itemId) as
      | { realm_id: string; source_type: string; embedding: Uint8Array }
      | undefined;
    if (!row) return;

    this.db.prepare(`DELETE FROM vec_items WHERE item_id = ?`).run(itemId);
    this.db
      .prepare(
        `INSERT INTO vec_items (item_id, realm_id, status, source_type, embedding)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(itemId, row.realm_id, status, row.source_type, row.embedding);
  }

  deleteVectorItem(itemId: string): void {
    this.db.prepare(`DELETE FROM vec_pending WHERE item_id = ?`).run(itemId);
    if (this.vecEnabled) {
      this.db.prepare(`DELETE FROM vec_items WHERE item_id = ?`).run(itemId);
    }
  }

  listPendingVectors(limit = 200, offset = 0): PendingVectorItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM vec_pending ORDER BY queued_at ASC, item_id ASC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      itemId: String(r.item_id),
      sourceType: String(r.source_type) as PendingVectorItem["sourceType"],
      orgId: String(r.org_id),
      realmId: String(r.realm_id),
      status: String(r.status),
      text: String(r.text),
      queuedAt: String(r.queued_at),
    }));
  }

  searchVectors(params: {
    embedding: Float32Array;
    realmIds: string[];
    sourceTypes?: Array<"record" | "seabed" | "distillation">;
    includeSuperseded: boolean;
    limit: number;
  }): VectorMatch[] {
    if (!this.vecEnabled || params.realmIds.length === 0) return [];
    if (params.embedding.length !== this.vectorDimensions) {
      throw new MindError(
        "INVALID_INPUT",
        `Query embedding dimension mismatch: expected ${this.vectorDimensions}, got ${params.embedding.length}`,
      );
    }

    // Partition-key + status + source_type pre-filter ensures hidden siblings,
    // hidden descendant seabed, and superseded records are excluded at the vec0
    // index scan level before Top-K selection.
    const where: string[] = [
      `embedding MATCH ?`,
      `k = ?`,
      `realm_id IN (${placeholders(params.realmIds.length)})`,
    ];
    const sqlParams: SQLInputValue[] = [
      toVecBlob(params.embedding),
      params.limit,
      ...params.realmIds,
    ];
    if (params.sourceTypes && params.sourceTypes.length > 0) {
      where.push(`source_type IN (${placeholders(params.sourceTypes.length)})`);
      sqlParams.push(...params.sourceTypes);
    }
    if (!params.includeSuperseded) {
      where.push(`status IN ('active', 'evidence')`);
    }

    const rows = this.db
      .prepare(
        `SELECT item_id, source_type, realm_id, status, distance
         FROM vec_items
         WHERE ${where.join(" AND ")}`,
      )
      .all(...sqlParams) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      itemId: String(r.item_id),
      sourceType: String(r.source_type) as VectorMatch["sourceType"],
      realmId: String(r.realm_id),
      status: String(r.status),
      distance: Number(r.distance),
    }));
  }

  clearVectorIndex(): void {
    this.db.exec(`DELETE FROM vec_pending;`);
    if (this.vecEnabled) {
      this.db.exec(`DELETE FROM vec_items;`);
    }
  }
}
