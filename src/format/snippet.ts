export const DEFAULT_SHOW_LIMIT = 3500;
export const MAX_SHOW_LIMIT = 200000;

export interface SnippetConceptLike {
  raw: string;
  terms?: string[];
  isCjk?: boolean;
  /** Optional boundary-aware regex for non-CJK concepts */
  matchRegex?: RegExp;
  /** Optional continuous coverage scorer (matches SeaEngine threshold: >= 0.75 CJK, 1.0 non-CJK) */
  scoreText?: (text: string, lowerText?: string) => number;
}

export interface SnippetWithMeta {
  snippet: string;
  truncated: boolean;
}

export interface WindowTextResult {
  slice: string;
  start: number;
  end: number;
  total: number;
  shownChars: number;
  truncated: boolean;
  nextOffset: number | null;
  aroundMatched?: boolean;
}

const PREFERRED_TEXT_KEYS = [
  "summary",
  "statement",
  "body",
  "content",
  "text",
  "rationale",
  "detail",
  "description",
  "decision",
  "note",
  "reason",
  "message",
  "outcome",
] as const;

const METADATA_IGNORE_KEYS = new Set([
  "contentsha256",
  "content_sha256",
  "sha256",
  "sourceref",
  "source_ref",
  "sourcerefs",
  "source_refs",
  "sourceid",
  "source_id",
  "externalref",
  "external_ref",
  "frontmatter",
  "crossrealmsupersedes",
  "cross_realm_supersedes",
  "idempotencykey",
  "idempotency_key",
]);

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Single shared pure record-payload FTS text builder reused across ledger writes,
 * recall JS concept coverage checks, rebuild(), and Migration v6 backfill.
 */
export function buildRecordFtsBody(
  payload: Record<string, unknown> | null | undefined,
): string {
  if (!payload || typeof payload !== "object") return "";
  return Object.entries(payload)
    .map(
      ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
    )
    .join("\n");
}

/**
 * Builds the canonical un-trimmed display content for an entry or file.
 * For ledger records, preserves `payload.body` verbatim plus ALL non-metadata payload
 * keys (including `summary`, `content`, `text`, etc. — NEVER stripping prose keys),
 * excluding only `"body"` and internal technical `METADATA_IGNORE_KEYS`.
 */
export function buildCanonicalEntryContent(
  input:
    | { kind: "record"; payload: Record<string, unknown> | null | undefined }
    | { kind: "seabed"; text: string }
    | { kind: "distillation"; narrativeMd: string }
    | { kind: "file"; content: string },
): string {
  if (input.kind === "seabed") {
    return input.text;
  }
  if (input.kind === "distillation") {
    return input.narrativeMd;
  }
  if (input.kind === "file") {
    return input.content;
  }
  const payload = input.payload;
  if (!payload || typeof payload !== "object") return "";

  const baseText = typeof payload.body === "string" ? payload.body : "";
  const extraPayload: Record<string, unknown> = {};
  let hasExtra = false;
  for (const [k, v] of Object.entries(payload)) {
    if (k === "body") continue;
    if (METADATA_IGNORE_KEYS.has(k.toLowerCase())) continue;
    extraPayload[k] = v;
    hasExtra = true;
  }

  if (!hasExtra) {
    return baseText;
  }
  const payloadBlock = [
    "## Payload",
    "",
    "```json",
    JSON.stringify(extraPayload, null, 2),
    "```",
  ].join("\n");
  return baseText.length > 0 ? `${baseText}\n\n${payloadBlock}` : payloadBlock;
}

/**
 * Extracts clean human-readable prose from a structured record payload without
 * dumping internal JSON metadata fields such as `contentSha256` or `frontmatter`.
 */
export function extractReadableText(
  payload: Record<string, unknown> | null | undefined,
  fallbackTitle?: string,
): string {
  if (!payload || typeof payload !== "object") {
    return collapseWhitespace(fallbackTitle ?? "");
  }

  const chunks: string[] = [];
  const usedKeys = new Set<string>();

  for (const key of PREFERRED_TEXT_KEYS) {
    const val = payload[key];
    if (typeof val === "string" && val.trim()) {
      chunks.push(val.trim());
      usedKeys.add(key);
    }
  }

  if (chunks.length === 0) {
    for (const [k, v] of Object.entries(payload)) {
      if (usedKeys.has(k)) continue;
      if (METADATA_IGNORE_KEYS.has(k.toLowerCase())) continue;
      if (typeof v === "string" && v.trim()) {
        chunks.push(v.trim());
      } else if (typeof v === "number" || typeof v === "boolean") {
        chunks.push(`${k}: ${String(v)}`);
      } else if (Array.isArray(v)) {
        const strs = v
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .slice(0, 8);
        if (strs.length > 0) {
          chunks.push(`${k}: ${strs.join(", ")}`);
        }
      }
    }
  }

  const combined = collapseWhitespace(chunks.join(" "));
  if (combined) return combined;
  return collapseWhitespace(fallbackTitle ?? "");
}

interface MatchSpan {
  pos: number;
  end: number;
  conceptIdx: number;
}

function collectLegacySpans(
  lowerText: string,
  concepts: SnippetConceptLike[],
): MatchSpan[] {
  const spans: MatchSpan[] = [];
  for (let idx = 0; idx < concepts.length; idx += 1) {
    const c = concepts[idx]!;
    const needles = Array.from(
      new Set(
        [c.raw, ...(c.terms ?? [])]
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    for (const needle of needles) {
      let from = 0;
      let count = 0;
      while (from < lowerText.length && count < 12) {
        const found = lowerText.indexOf(needle, from);
        if (found === -1) break;
        spans.push({ pos: found, end: found + needle.length, conceptIdx: idx });
        from = found + Math.max(1, needle.length);
        count += 1;
      }
    }
  }
  spans.sort((a, b) => a.pos - b.pos);
  return spans;
}

function collectExactSpansForConcept(
  sourceText: string,
  lowerText: string,
  concept: SnippetConceptLike,
  conceptIdx: number,
): MatchSpan[] {
  const out: MatchSpan[] = [];
  if (concept.matchRegex) {
    const globalFlags = concept.matchRegex.flags.includes("g")
      ? concept.matchRegex.flags
      : `${concept.matchRegex.flags}g`;
    const re = new RegExp(concept.matchRegex.source, globalFlags);
    let count = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sourceText)) !== null && count < 16) {
      const len = Math.max(1, m[0].length);
      out.push({ pos: m.index, end: m.index + len, conceptIdx });
      count += 1;
      if (m[0].length === 0) re.lastIndex += 1;
    }
    return out;
  }

  // Prefer exact `raw` occurrence first for CJK / plain terms before falling back to bigrams
  const rawLower = concept.raw.trim().toLowerCase();
  if (rawLower) {
    let from = 0;
    let count = 0;
    while (from < lowerText.length && count < 12) {
      const found = lowerText.indexOf(rawLower, from);
      if (found === -1) break;
      out.push({ pos: found, end: found + rawLower.length, conceptIdx });
      from = found + Math.max(1, rawLower.length);
      count += 1;
    }
    if (out.length > 0) return out;
  }

  const needles = Array.from(
    new Set(
      (concept.terms ?? [])
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  for (const needle of needles) {
    let from = 0;
    let count = 0;
    while (from < lowerText.length && count < 8) {
      const found = lowerText.indexOf(needle, from);
      if (found === -1) break;
      out.push({ pos: found, end: found + needle.length, conceptIdx });
      from = found + Math.max(1, needle.length);
      count += 1;
    }
  }
  return out;
}

function conceptMatchesText(
  text: string | undefined,
  lowerText: string,
  concept: SnippetConceptLike,
): boolean {
  if (!text || !lowerText) return false;
  if (concept.scoreText) {
    const threshold = concept.isCjk ? 0.75 : 1.0;
    return concept.scoreText(text, lowerText) >= threshold;
  }
  if (concept.matchRegex) {
    return concept.matchRegex.test(text);
  }
  const rawLower = concept.raw.trim().toLowerCase();
  if (rawLower && lowerText.includes(rawLower)) {
    return true;
  }
  const terms = (concept.terms ?? [])
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (terms.length === 0) return false;
  let hits = 0;
  for (const t of terms) {
    if (lowerText.includes(t)) hits += 1;
  }
  return hits / terms.length >= 0.75;
}

function collectMatchSpans(
  _sourceText: string,
  lowerText: string,
  concepts: SnippetConceptLike[],
): MatchSpan[] {
  return collectLegacySpans(lowerText, concepts);
}

function snapWindowStart(text: string, rawStart: number): number {
  if (rawStart <= 0) return 0;
  // Move forward slightly to a clean whitespace boundary if nearby (ASCII words)
  const lookAhead = Math.min(text.length, rawStart + 18);
  const spaceIdx = text.indexOf(" ", rawStart);
  if (spaceIdx !== -1 && spaceIdx <= lookAhead) {
    return safeStart(text, spaceIdx + 1);
  }
  return safeStart(text, rawStart);
}

function snapWindowEnd(text: string, rawEnd: number, minStart = 0): number {
  if (rawEnd >= text.length) return text.length;
  const lookBack = Math.max(minStart, rawEnd - 18);
  const spaceIdx = text.lastIndexOf(" ", rawEnd);
  if (spaceIdx !== -1 && spaceIdx >= lookBack) {
    return safeEnd(text, spaceIdx, minStart);
  }
  return safeEnd(text, rawEnd, minStart);
}

/**
 * O(spans) two-pointer sliding window maximizing distinct matched concepts, then total hits.
 * Mathematically identical selection to the O(spans^2) anchor scan for monotonically sorted spans.
 */
function pickBestSingleWindow(
  spans: MatchSpan[],
  sourceLen: number,
  windowLen: number,
  conceptCount: number,
  minBound = 0,
  maxBound = sourceLen,
): number {
  const effectiveMaxLen = Math.max(1, Math.min(windowLen, maxBound - minBound));
  const half = Math.floor(effectiveMaxLen / 2);
  const counts = new Int32Array(conceptCount);
  let left = 0;
  let right = 0;
  let distinctCount = 0;

  // Advance `left`/`right` to first span >= minBound
  while (left < spans.length && spans[left]!.pos < minBound) {
    left += 1;
  }
  right = left;

  let bestStart = minBound;
  let bestDistinct = -1;
  let bestTotal = -1;

  for (let i = left; i < spans.length; i += 1) {
    const anchor = spans[i]!.pos;
    if (anchor >= maxBound) break;
    const winStart = Math.max(
      minBound,
      Math.min(maxBound - effectiveMaxLen, anchor - half),
    );
    const winEnd = Math.min(maxBound, winStart + effectiveMaxLen);

    while (right < spans.length && spans[right]!.pos < winEnd) {
      const cIdx = spans[right]!.conceptIdx;
      if (counts[cIdx] === 0) distinctCount += 1;
      counts[cIdx] = counts[cIdx]! + 1;
      right += 1;
    }
    while (left < right && spans[left]!.pos < winStart) {
      const cIdx = spans[left]!.conceptIdx;
      const next = counts[cIdx]! - 1;
      counts[cIdx] = next;
      if (next === 0) distinctCount -= 1;
      left += 1;
    }

    const total = right - left;
    if (
      distinctCount > bestDistinct ||
      (distinctCount === bestDistinct && total > bestTotal)
    ) {
      bestDistinct = distinctCount;
      bestTotal = total;
      bestStart = winStart;
    }
  }
  return bestStart;
}

function conceptsInRange(
  spans: MatchSpan[],
  start: number,
  end: number,
): Set<number> {
  const found = new Set<number>();
  for (let i = 0; i < spans.length; i += 1) {
    const s = spans[i]!;
    if (s.pos >= end) break;
    if (s.pos >= start && s.end <= end) {
      found.add(s.conceptIdx);
    } else if (s.pos >= start && s.pos < end) {
      found.add(s.conceptIdx);
    }
  }
  return found;
}

/**
 * Single shared match-centered snippet builder with exact truncation metadata.
 * - Preserves byte-identical single-window output whenever Window 1 + Title already cover
 *   every body-matched query concept.
 * - When a body-matched query concept is absent from both Title and Window 1, splits the
 *   strict `maxLen` budget into up to 2 chronological non-overlapping windows joined by ` … `,
 *   prioritizing the rarest uncovered concept (pre-limit candidate pool `df`), with an ultra-short
 *   tail tag `[+term]` if >=3 widely scattered concepts still remain uncovered — all strictly
 *   within `maxLen` chars (zero char-budget regression).
 */
export function buildSnippetWithMeta(params: {
  title?: string;
  text?: string;
  payload?: Record<string, unknown> | null;
  concepts?: SnippetConceptLike[];
  /** Pre-limit candidate-pool document frequency per concept index (tie-breaker only when >1 uncovered concept) */
  conceptDf?: ReadonlyArray<number> | Int32Array;
  /** Optional prefix/suffix ellipsis chars reserved by caller (applied ONLY in multi-segment mode) */
  reservedEdgeChars?: number;
  maxLen?: number;
}): SnippetWithMeta {
  const maxLen = Math.max(40, params.maxLen ?? 240);

  let source = "";
  if (typeof params.text === "string" && params.text.trim()) {
    source = collapseWhitespace(params.text);
  } else if (params.payload) {
    source = extractReadableText(params.payload, params.title);
  } else if (params.title) {
    source = collapseWhitespace(params.title);
  }

  if (!source) return { snippet: "", truncated: false };
  if (source.length <= maxLen) return { snippet: source, truncated: false };

  const concepts = params.concepts ?? [];
  if (concepts.length === 0) {
    const end = snapWindowEnd(source, maxLen - 3);
    return {
      snippet: `${source.slice(0, Math.max(1, end)).trimEnd()}...`,
      truncated: true,
    };
  }

  const lower = source.toLowerCase();
  const spans = collectMatchSpans(source, lower, concepts);
  if (spans.length === 0) {
    const end = snapWindowEnd(source, maxLen - 3);
    return {
      snippet: `${source.slice(0, Math.max(1, end)).trimEnd()}...`,
      truncated: true,
    };
  }

  const bestStart = pickBestSingleWindow(spans, source.length, maxLen, concepts.length);
  const snappedStart = snapWindowStart(source, bestStart);
  const rawEnd = Math.min(source.length, snappedStart + maxLen);
  const snappedEnd = snapWindowEnd(source, rawEnd, snappedStart);

  // Check true concept coverage: only genuinely matched concepts (score >= threshold, never stray single CJK bigrams)
  // that are absent from BOTH Title (binary check) and Window 1 trigger the 2-segment split!
  const titleLower = (params.title ?? "").toLowerCase();
  const win1Slice = source.slice(snappedStart, snappedEnd);
  const win1Lower = lower.slice(snappedStart, snappedEnd);

  const uncovered: number[] = [];
  for (let idx = 0; idx < concepts.length; idx += 1) {
    const c = concepts[idx]!;
    if (!conceptMatchesText(source, lower, c)) continue;
    if (conceptMatchesText(params.title, titleLower, c)) continue;
    if (conceptMatchesText(win1Slice, win1Lower, c)) continue;
    uncovered.push(idx);
  }

  // Fast path: 1 window + title already covers every genuinely matched concept -> 100% byte-identical output!
  if (uncovered.length === 0 || maxLen < 80) {
    const prefix = snappedStart > 0 ? "..." : "";
    const suffix = snappedEnd < source.length ? "..." : "";
    const body = win1Slice.trim();
    return {
      snippet: `${prefix}${body}${suffix}`,
      truncated: true,
    };
  }

  // Collect exact spans for uncovered concepts only when 2-segment mode actually triggers
  const exactUncoveredSpans = new Map<number, MatchSpan[]>();
  for (const idx of uncovered) {
    exactUncoveredSpans.set(
      idx,
      collectExactSpansForConcept(source, lower, concepts[idx]!, idx),
    );
  }

  // Multi-segment coverage-first path: strict <= hardCap budget (zero tolerance)
  const hardCap = Math.max(60, maxLen - (params.reservedEdgeChars ?? 0));
  const df = params.conceptDf;
  uncovered.sort((a, b) => {
    const dfA = df && a < df.length ? df[a]! : Number.MAX_SAFE_INTEGER;
    const dfB = df && b < df.length ? df[b]! : Number.MAX_SAFE_INTEGER;
    if (dfA !== dfB) return dfA - dfB;
    const lenDiff = concepts[b]!.raw.length - concepts[a]!.raw.length;
    if (lenDiff !== 0) return lenDiff;
    return a - b;
  });

  const uncoveredSet = new Set<number>(uncovered);
  const targetIdx = uncovered[0]!;
  const SEP = " … "; // 3 chars

  // Build 2 non-overlapping segments within a given per-segment budget
  const buildTwoSegmentSnippet = (
    perSegBudget: number,
    tailTag: string,
  ): { text: string; covered: Set<number> } => {
    const segBudget = Math.max(24, perSegBudget);
    const halfSeg = Math.floor(segBudget / 2);

    // Segment A: densest sub-window inside Window 1
    const rawStartA = pickBestSingleWindow(
      spans,
      source.length,
      segBudget,
      concepts.length,
      snappedStart,
      snappedEnd,
    );

    // Segment B: best span of rarest uncovered concept `targetIdx` maximizing uncovered concepts
    const targetSpans = exactUncoveredSpans.get(targetIdx) ?? [];
    let bestAnchorB = targetSpans[0]?.pos ?? 0;
    let bestUncoveredHits = -1;
    for (let i = 0; i < targetSpans.length; i += 1) {
      const anchor = targetSpans[i]!.pos;
      const wStart = Math.max(0, Math.min(source.length - segBudget, anchor - halfSeg));
      const wEnd = Math.min(source.length, wStart + segBudget);
      let hitCount = 0;
      for (const uIdx of uncovered) {
        const uSpans = exactUncoveredSpans.get(uIdx);
        if (uSpans?.some((sp) => sp.pos >= wStart && sp.pos < wEnd)) {
          hitCount += 1;
        }
      }
      if (hitCount > bestUncoveredHits) {
        bestUncoveredHits = hitCount;
        bestAnchorB = anchor;
      }
    }
    const rawStartB = Math.max(
      0,
      Math.min(source.length - segBudget, bestAnchorB - halfSeg),
    );

    const segs = [
      { start: rawStartA, end: Math.min(source.length, rawStartA + segBudget) },
      { start: rawStartB, end: Math.min(source.length, rawStartB + segBudget) },
    ].sort((a, b) => a.start - b.start);

    const first = segs[0]!;
    const second = segs[1]!;

    // If segments overlap or nearly touch, merge into one clean slice strictly <= hardCap
    if (first.end + 6 >= second.start) {
      const mergedBudget = Math.max(24, hardCap - 6 - tailTag.length);
      const mStart = snapWindowStart(source, first.start);
      const mEnd = snapWindowEnd(
        source,
        Math.min(source.length, mStart + mergedBudget),
        mStart,
      );
      const lead = mStart > 0 ? "..." : "";
      const trail = mEnd < source.length ? "..." : "";
      const body = source.slice(mStart, mEnd).trim();
      const text = `${lead}${body}${trail}${tailTag}`;
      const bodyLower = body.toLowerCase();
      const covered = new Set<number>();
      for (const uIdx of uncovered) {
        if (conceptMatchesText(body, bodyLower, concepts[uIdx]!)) {
          covered.add(uIdx);
        }
      }
      return { text, covered };
    }

    const s1Start = snapWindowStart(source, first.start);
    const s1End = snapWindowEnd(
      source,
      Math.min(second.start - 1, s1Start + segBudget),
      s1Start,
    );
    const s2Start = snapWindowStart(source, Math.max(s1End + 1, second.start));
    const s2End = snapWindowEnd(
      source,
      Math.min(source.length, s2Start + segBudget),
      s2Start,
    );

    const lead = s1Start > 0 ? "..." : "";
    const trail = s2End < source.length ? "..." : "";
    const body1 = source.slice(s1Start, s1End).trim();
    const body2 = source.slice(s2Start, s2End).trim();
    const b1Lower = body1.toLowerCase();
    const b2Lower = body2.toLowerCase();
    const covered = new Set<number>();
    for (const uIdx of uncovered) {
      const c = concepts[uIdx]!;
      if (
        conceptMatchesText(body1, b1Lower, c) ||
        conceptMatchesText(body2, b2Lower, c)
      ) {
        covered.add(uIdx);
      }
    }
    return {
      text: `${lead}${body1}${SEP}${body2}${trail}${tailTag}`,
      covered,
    };
  };

  // Reserve 9 chars worst-case for leading "..." (3) + middle " … " (3) + trailing "..." (3)
  const basePerSeg = Math.floor((hardCap - 9) / 2);
  let built = buildTwoSegmentSnippet(basePerSeg, "");

  // Tail fallback: if >= 3 scattered body concepts remain uncovered outside title + both segments,
  // append an ultra-short `[+term1,+term2]` hint while trimming segment budgets so total <= hardCap.
  const stillMissing = uncovered.filter((idx) => !built.covered.has(idx));
  if (stillMissing.length > 0) {
    const parts: string[] = [];
    let tagLen = 3; // " []"
    for (const idx of stillMissing) {
      const token = `+${concepts[idx]!.raw.slice(0, 14)}`;
      const addLen = (parts.length > 0 ? 1 : 0) + token.length;
      if (tagLen + addLen > 32) break;
      parts.push(token);
      tagLen += addLen;
    }
    if (parts.length > 0) {
      const tailTag = ` [${parts.join(",")}]`;
      const trimmedPerSeg = Math.floor((hardCap - 9 - tailTag.length) / 2);
      built = buildTwoSegmentSnippet(trimmedPerSeg, tailTag);
    }
  }

  // Final hard-cap safety guard (strictly <= hardCap, zero tolerance)
  let finalText = built.text;
  if (finalText.length > hardCap) {
    const cut = safeEnd(finalText, hardCap - 3, 0);
    finalText = `${finalText.slice(0, cut).trimEnd()}...`;
  }
  return {
    snippet: finalText,
    truncated: true,
  };
}

/**
 * Single shared match-centered snippet builder across recall, ls, brief, and Markdown views.
 * - Extracts readable text from structured payloads (never dumping raw JSON metadata blobs).
 * - Preserves byte-identical single-window output when all matched concepts fit in Title ∪ Window 1;
 *   splits into up to 2 chronological windows within strict `maxLen` when a concept would otherwise vanish.
 */
export function buildSnippet(params: {
  title?: string;
  text?: string;
  payload?: Record<string, unknown> | null;
  concepts?: SnippetConceptLike[];
  conceptDf?: ReadonlyArray<number> | Int32Array;
  maxLen?: number;
}): string {
  return buildSnippetWithMeta(params).snippet;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function safeStart(text: string, i: number): number {
  let pos = Math.max(0, Math.min(i, text.length));
  if (
    pos > 0 &&
    pos < text.length &&
    isHighSurrogate(text.charCodeAt(pos - 1)) &&
    isLowSurrogate(text.charCodeAt(pos))
  ) {
    pos -= 1;
  }
  return pos;
}

function safeEnd(text: string, i: number, minStart: number): number {
  let pos = Math.max(minStart, Math.min(i, text.length));
  if (
    pos > 0 &&
    pos < text.length &&
    isHighSurrogate(text.charCodeAt(pos - 1)) &&
    isLowSurrogate(text.charCodeAt(pos))
  ) {
    if (pos - 1 > minStart) {
      pos -= 1;
    } else {
      pos += 1;
    }
  }
  if (pos <= minStart && minStart < text.length) {
    pos = Math.min(text.length, minStart + 1);
    if (
      pos < text.length &&
      isHighSurrogate(text.charCodeAt(pos - 1)) &&
      isLowSurrogate(text.charCodeAt(pos))
    ) {
      pos += 1;
    }
  }
  return pos;
}

/**
 * UTF-16 surrogate-safe, line-aligned, zero-progress-guarded bounded window slicer.
 * Lossless pagination invariant: paginating from cursorOffset=0 via nextOffset until null
 * concatenates to `text` code-unit-for-code-unit (`chunks.join("") === text`).
 */
export function windowText(params: {
  text: string;
  around?: string;
  aroundConcepts?: SnippetConceptLike[];
  cursorOffset?: number;
  limit?: number;
  full?: boolean;
}): WindowTextResult {
  const text = params.text;
  const total = text.length;
  const limit = Math.max(1, Math.min(params.limit ?? DEFAULT_SHOW_LIMIT, MAX_SHOW_LIMIT));

  if (params.full) {
    return {
      slice: text,
      start: 0,
      end: total,
      total,
      shownChars: total,
      truncated: false,
      nextOffset: null,
    };
  }

  if (params.cursorOffset !== undefined) {
    if (params.cursorOffset >= total) {
      return {
        slice: "",
        start: total,
        end: total,
        total,
        shownChars: 0,
        truncated: false,
        nextOffset: null,
      };
    }
  }

  let start = 0;
  let aroundMatched: boolean | undefined;
  const hasAround = typeof params.around === "string" && params.around.trim().length > 0;

  if (hasAround) {
    const trimmedAround = params.around!.trim();
    const concepts: SnippetConceptLike[] =
      params.aroundConcepts && params.aroundConcepts.length > 0
        ? params.aroundConcepts
        : trimmedAround
            .split(/\s+/)
            .filter(Boolean)
            .map((t) => ({ raw: t }));

    const lower = text.toLowerCase();
    const spans = collectMatchSpans(text, lower, concepts);
    if (spans.length === 0) {
      aroundMatched = false;
      start = 0;
    } else {
      aroundMatched = true;
      if (total <= limit) {
        return {
          slice: text,
          start: 0,
          end: total,
          total,
          shownChars: total,
          truncated: false,
          nextOffset: null,
          aroundMatched: true,
        };
      }

      // Find highest-scoring match cluster within window width `limit`
      let bestAnchor = spans[0]!.pos;
      let bestDistinct = -1;
      let bestTotal = -1;
      const leadOffset = Math.floor(limit * 0.35);

      for (let i = 0; i < spans.length; i += 1) {
        const anchor = spans[i]!.pos;
        const winStart = Math.max(0, Math.min(total - limit, anchor - leadOffset));
        const winEnd = Math.min(total, winStart + limit);

        const distinct = new Set<number>();
        let hitCount = 0;
        for (let j = 0; j < spans.length; j += 1) {
          const s = spans[j]!;
          if (s.pos >= winStart && s.pos < winEnd) {
            distinct.add(s.conceptIdx);
            hitCount += 1;
          }
        }
        if (
          distinct.size > bestDistinct ||
          (distinct.size === bestDistinct && hitCount > bestTotal)
        ) {
          bestDistinct = distinct.size;
          bestTotal = hitCount;
          bestAnchor = anchor;
        }
      }

      const rawStart = Math.max(0, Math.min(total - limit, bestAnchor - leadOffset));
      if (rawStart === 0) {
        start = 0;
      } else {
        const snapRange = Math.floor(limit * 0.15);
        const minSnap = Math.max(0, rawStart - snapRange);
        const maxSnap = Math.min(bestAnchor, rawStart + snapRange);

        let chosenStart = rawStart;
        let bestDist = Number.POSITIVE_INFINITY;

        // Backward newline search
        const backNl = text.lastIndexOf("\n", rawStart - 1);
        if (backNl !== -1 && backNl + 1 >= minSnap) {
          const cand = backNl + 1;
          const dist = Math.abs(rawStart - cand);
          if (dist < bestDist) {
            bestDist = dist;
            chosenStart = cand;
          }
        }
        // Forward newline search (never skip past bestAnchor)
        const fwdNl = text.indexOf("\n", rawStart);
        if (fwdNl !== -1 && fwdNl + 1 <= maxSnap) {
          const cand = fwdNl + 1;
          const dist = Math.abs(cand - rawStart);
          if (dist < bestDist) {
            chosenStart = cand;
          }
        }
        start = safeStart(text, chosenStart);
      }
    }
  } else if (params.cursorOffset !== undefined) {
    start = safeStart(text, params.cursorOffset);
  } else if (total <= limit) {
    return {
      slice: text,
      start: 0,
      end: total,
      total,
      shownChars: total,
      truncated: false,
      nextOffset: null,
    };
  }

  const rawEnd = Math.min(total, start + limit);
  let end: number;
  if (rawEnd < total) {
    const minLineBreak = start + Math.floor(limit * 0.5);
    const nlIdx = text.lastIndexOf("\n", rawEnd - 1);
    if (nlIdx >= minLineBreak) {
      end = nlIdx + 1;
    } else {
      end = safeEnd(text, rawEnd, start);
    }
  } else {
    end = total;
  }

  const slice = text.slice(start, end);
  const nextOffset = end < total ? end : null;
  const truncated = start > 0 || end < total;

  return {
    slice,
    start,
    end,
    total,
    shownChars: slice.length,
    truncated,
    nextOffset,
    ...(aroundMatched !== undefined ? { aroundMatched } : {}),
  };
}
