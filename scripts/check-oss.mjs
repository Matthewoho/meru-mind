#!/usr/bin/env node
/**
 * Open-source hygiene check: prevents accidental inclusion of personal paths,
 * private notes, credentials, SQLite binaries, or local agent config files.
 *
 * Generic rules live in this script. Optional local private denylist terms can
 * be supplied outside the repository via:
 *   - MERU_MIND_OSS_DENYLIST_FILE (env var), or
 *   - ~/.config/meru-mind/oss-denylist.txt
 * One case-insensitive literal term per line; blank lines and `#` comments are
 * ignored. If the external file does not exist, private-term scanning is
 * skipped silently (safe for public CI).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

function listCandidateFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function loadExternalDenylist() {
  const denylistPath =
    process.env.MERU_MIND_OSS_DENYLIST_FILE?.trim() ||
    path.join(os.homedir(), ".config", "meru-mind", "oss-denylist.txt");

  if (!fs.existsSync(denylistPath)) {
    return { path: denylistPath, terms: [] };
  }
  const stat = fs.statSync(denylistPath);
  if (!stat.isFile()) {
    return { path: denylistPath, terms: [] };
  }

  const lines = fs
    .readFileSync(denylistPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  return { path: denylistPath, terms: Array.from(new Set(lines)) };
}

const FORBIDDEN_PATH_PATTERNS = [
  /^\.agents\//,
  /(^|\/)AGENTS\.md$/,
  /(^|\/)CLAUDE\.md$/,
  /\.sqlite($|3|-wal|-shm)/i,
  /\.db$/i,
  /^\.env($|\.(?!example$))/,
  /(^|\/)blobs\//,
];

const FORBIDDEN_CONTENT_PATTERNS = [
  { name: "macOS user home path", re: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: "Linux user home path", re: /\/home\/[A-Za-z0-9._-]+\// },
  { name: "Windows user home path", re: /[A-Z]:\\Users\\[A-Za-z0-9._-]+\\/ },
  { name: "OpenAI/Anthropic key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const violations = [];
const files = listCandidateFiles();
const externalDenylist = loadExternalDenylist();

for (const rel of files) {
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;

  const buf = fs.readFileSync(full);
  const isSelf = rel === "scripts/check-oss.mjs";

  if (!isSelf) {
    for (const pat of FORBIDDEN_PATH_PATTERNS) {
      if (pat.test(rel)) {
        violations.push(`${rel}: forbidden path pattern ${pat}`);
      }
    }

    if (buf.subarray(0, 15).toString("utf8") === "SQLite format 3") {
      violations.push(`${rel}: binary SQLite database detected`);
      continue;
    }
  }

  const text = buf.toString("utf8");

  if (!isSelf) {
    for (const check of FORBIDDEN_CONTENT_PATTERNS) {
      if (check.re.test(text)) {
        violations.push(`${rel}: matched forbidden content (${check.name})`);
      }
    }
  }

  if (externalDenylist.terms.length > 0) {
    const lowerText = text.toLowerCase();
    for (const term of externalDenylist.terms) {
      if (lowerText.includes(term.toLowerCase())) {
        violations.push(`${rel}: matched external denylist term`);
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`OSS hygiene check FAILED (${violations.length} issue(s)):\n`);
  for (const v of violations) {
    process.stderr.write(`  - ${v}\n`);
  }
  process.exit(1);
}

const extraInfo =
  externalDenylist.terms.length > 0
    ? `, ${externalDenylist.terms.length} external denylist term(s) checked`
    : "";
process.stdout.write(
  `OSS hygiene check PASSED (${files.length} files scanned${extraInfo}, 0 issues).\n`,
);
