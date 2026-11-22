export const DEFAULT_SHOW_LIMIT = 3500;
export const MAX_SHOW_LIMIT = 200000;

export interface SnippetConceptLike {
  raw: string;
  terms?: string[];
  isCjk?: boolean;
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
  conceptIdx: number;
}

function collectMatchSpans(
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
        spans.push({ pos: found, conceptIdx: idx });
        from = found + Math.max(1, needle.length);
        count += 1;
      }
    }
  }
  spans.sort((a, b) => a.pos - b.pos);
  return spans;
}

function snapWindowStart(text: string, rawStart: number): number {
  if (rawStart <= 0) return 0;
  // Move forward slightly to a clean whitespace boundary if nearby (ASCII words)
  const lookAhead = Math.min(text.length, rawStart + 18);
  const spaceIdx = text.indexOf(" ", rawStart);
  if (spaceIdx !== -1 && spaceIdx <= lookAhead) {
    return spaceIdx + 1;
  }
  return rawStart;
}

function snapWindowEnd(text: string, rawEnd: number): number {
  if (rawEnd >= text.length) return text.length;
  const lookBack = Math.max(0, rawEnd - 18);
  const spaceIdx = text.lastIndexOf(" ", rawEnd);
  if (spaceIdx !== -1 && spaceIdx >= lookBack) {
    return spaceIdx;
  }
  return rawEnd;
}

/**
 * Single shared match-centered snippet builder with exact truncation metadata.
 * `truncated === true` iff characters were actually elided/sliced from the readable text.
 */
export function buildSnippetWithMeta(params: {
  title?: string;
  text?: string;
  payload?: Record<string, unknown> | null;
  concepts?: SnippetConceptLike[];
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
  const spans = collectMatchSpans(lower, concepts);
  if (spans.length === 0) {
    const end = snapWindowEnd(source, maxLen - 3);
    return {
      snippet: `${source.slice(0, Math.max(1, end)).trimEnd()}...`,
      truncated: true,
    };
  }

  // Evaluate candidate windows centered around each match cluster; maximize distinct concepts then total hits
  let bestStart = 0;
  let bestDistinct = -1;
  let bestTotal = -1;

  const half = Math.floor(maxLen / 2);
  for (let i = 0; i < spans.length; i += 1) {
    const anchor = spans[i]!.pos;
    const winStart = Math.max(0, Math.min(source.length - maxLen, anchor - half));
    const winEnd = Math.min(source.length, winStart + maxLen);

    const distinct = new Set<number>();
    let total = 0;
    for (let j = 0; j < spans.length; j += 1) {
      const s = spans[j]!;
      if (s.pos >= winStart && s.pos < winEnd) {
        distinct.add(s.conceptIdx);
        total += 1;
      }
    }

    if (
      distinct.size > bestDistinct ||
      (distinct.size === bestDistinct && total > bestTotal)
    ) {
      bestDistinct = distinct.size;
      bestTotal = total;
      bestStart = winStart;
    }
  }

  const snappedStart = snapWindowStart(source, bestStart);
  const rawEnd = Math.min(source.length, snappedStart + maxLen);
  const snappedEnd = snapWindowEnd(source, rawEnd);

  const prefix = snappedStart > 0 ? "..." : "";
  const suffix = snappedEnd < source.length ? "..." : "";
  const body = source.slice(snappedStart, snappedEnd).trim();
  return {
    snippet: `${prefix}${body}${suffix}`,
    truncated: true,
  };
}

/**
 * Single shared match-centered snippet builder across recall, ls, brief, and Markdown views.
 * - Extracts readable text from structured payloads (never dumping raw JSON metadata blobs).
 * - When query concepts are provided, centers the ~maxLen window around the highest concept-hit
 *   density region with `...` ellipsis.
 */
export function buildSnippet(params: {
  title?: string;
  text?: string;
  payload?: Record<string, unknown> | null;
  concepts?: SnippetConceptLike[];
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
    const spans = collectMatchSpans(lower, concepts);
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
