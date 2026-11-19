#!/usr/bin/env node
/**
 * Open-source hygiene check: prevents accidental inclusion of personal paths,
 * private notes, credentials, SQLite binaries, or local agent config files.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
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

for (const rel of files) {
  if (rel === "scripts/check-oss.mjs") continue;

  for (const pat of FORBIDDEN_PATH_PATTERNS) {
    if (pat.test(rel)) {
      violations.push(`${rel}: forbidden path pattern ${pat}`);
    }
  }

  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
  const buf = fs.readFileSync(full);
  if (buf.subarray(0, 15).toString("utf8") === "SQLite format 3") {
    violations.push(`${rel}: binary SQLite database detected`);
    continue;
  }
  const text = buf.toString("utf8");
  for (const check of FORBIDDEN_CONTENT_PATTERNS) {
    if (check.re.test(text)) {
      violations.push(`${rel}: matched forbidden content (${check.name})`);
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

process.stdout.write(`OSS hygiene check PASSED (${files.length} files scanned, 0 issues).\n`);
