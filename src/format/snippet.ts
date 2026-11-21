export interface SnippetConceptLike {
  raw: string;
  terms?: string[];
  isCjk?: boolean;
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
  const maxLen = Math.max(40, params.maxLen ?? 240);

  let source = "";
  if (typeof params.text === "string" && params.text.trim()) {
    source = collapseWhitespace(params.text);
  } else if (params.payload) {
    source = extractReadableText(params.payload, params.title);
  } else if (params.title) {
    source = collapseWhitespace(params.title);
  }

  if (!source) return "";
  if (source.length <= maxLen) return source;

  const concepts = params.concepts ?? [];
  if (concepts.length === 0) {
    const end = snapWindowEnd(source, maxLen - 3);
    return `${source.slice(0, Math.max(1, end)).trimEnd()}...`;
  }

  const lower = source.toLowerCase();
  const spans = collectMatchSpans(lower, concepts);
  if (spans.length === 0) {
    const end = snapWindowEnd(source, maxLen - 3);
    return `${source.slice(0, Math.max(1, end)).trimEnd()}...`;
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
  return `${prefix}${body}${suffix}`;
}
