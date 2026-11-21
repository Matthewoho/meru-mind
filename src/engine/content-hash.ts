import crypto from "node:crypto";

export function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) {
      sorted[key] = canonicalizeJson(v);
    }
  }
  return sorted;
}

export function sha256Bytes(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function computePayloadHash(value: unknown): string {
  const canonical = JSON.stringify(canonicalizeJson(value));
  return sha256Bytes(canonical);
}

/**
 * Single canonical record content hash shared across LedgerEngine.redact(),
 * LedgerEngine.appendRecord(), ImporterEngine, and all interactive write paths.
 *
 * Uses the exact pre-v5 formula (`sha256(title + "\n" + canonicalJson(payload))`)
 * so 100% of pre-v5 redacted_blocklist rows match automatically after migration v5.
 */
export function computeRecordContentSha256(
  title: string,
  payload: Record<string, unknown>,
): string {
  return sha256Bytes(
    `${title.trim()}\n${JSON.stringify(canonicalizeJson(payload))}`,
  );
}

/**
 * Single canonical seabed content hash shared across LedgerEngine.redact(),
 * LedgerEngine.captureSeabed(), and importers.
 */
export function computeSeabedContentSha256(text: string): string {
  return sha256Bytes(text.trim());
}

/**
 * Single canonical file content hash shared across LedgerEngine.writeDriveFile()
 * and redacted_blocklist checks.
 */
export function computeFileContentSha256(content: Buffer | string): string {
  return sha256Bytes(content);
}

/**
 * Single canonical payload constructor shared across CLI `write`, MCP `mind_write`,
 * and CLI `rule add` so written payload shape is guaranteed identical to what
 * `appendRecord()` stores and `redact()` hashes.
 */
export function buildWriteRecordPayload(
  body: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = extra ? { ...extra } : {};
  const trimmed = body.trim();
  if (trimmed) {
    payload.body = trimmed;
  }
  return payload;
}

export const REDACTED_CONTENT_BLOCKED_MSG =
  "Content matches a human-redacted entry and cannot be re-written";

export const REDACTED_CONTENT_TRY_HINT =
  "Remove the redacted content before writing again (or pass --as-human on CLI to explicitly override)";
