import { MindError, type Sensitivity } from "../types.js";

export interface SecretPatternMatch {
  patternName: string;
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "OpenAI/Anthropic API key",
    re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: "GitHub personal/app token",
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  },
  {
    name: "Private key block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    name: "Meru Mind server token",
    re: /\bmm_live_[A-Za-z0-9_-]{24,}\b/,
  },
  {
    name: "AWS access key ID",
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: "Slack token",
    re: /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/,
  },
  {
    name: "Linear API key",
    re: /\blin_api_[A-Za-z0-9]{24,}\b/,
  },
];

/**
 * Scans candidate text for high-confidence plaintext credentials/secrets.
 * Reuses the same credential regex rules enforced by `scripts/check-oss.mjs`.
 */
export function detectPlaintextSecret(text: string): SecretPatternMatch | null {
  if (!text) return null;
  for (const pat of SECRET_PATTERNS) {
    if (pat.re.test(text)) {
      return { patternName: pat.name };
    }
  }
  return null;
}

/**
 * Guard invoked at everyday write surfaces: blocks accidental plaintext credential writes
 * unless the caller explicitly classifies the entry as `sensitivity: "secret"`.
 */
export function assertNoAccidentalSecret(params: {
  texts: Array<string | null | undefined>;
  sensitivity?: Sensitivity;
  surfaceHint?: string;
}): void {
  if (params.sensitivity === "secret") return;
  for (const text of params.texts) {
    if (!text) continue;
    const match = detectPlaintextSecret(text);
    if (match) {
      throw new MindError(
        "INVALID_INPUT",
        `Refused to store plaintext credential (${match.patternName}) in non-secret memory. Remove the credential, reference an env var name instead (e.g. env:API_KEY), or pass --sensitivity secret.`,
        {
          reason: "secret_detected",
          pattern: match.patternName,
          try:
            params.surfaceHint ??
            'Remove the secret value or re-run with --sensitivity secret',
        },
      );
    }
  }
}
