import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MindError } from "../types.js";

export const WORKSPACE_REALM_MARKER_FILE = ".meru-mind-realm";
const MAX_MARKER_BYTES = 512;
const MARKER_REF_RE =
  /^(?:realm_[A-Za-z0-9_-]+|\/|\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)$/i;

export interface WorkspaceRealmMarker {
  ref: string;
  filePath: string;
}

function isInsideOrEqual(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function readAndValidateMarker(filePath: string): WorkspaceRealmMarker {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    throw new MindError(
      "INVALID_INPUT",
      `Failed to inspect ${WORKSPACE_REALM_MARKER_FILE} marker file`,
    );
  }
  // Security hardening (P1-15): reject symlinks, directories, FIFOs, and oversized files;
  // NEVER echo file contents in error messages.
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid ${WORKSPACE_REALM_MARKER_FILE} marker: symlinks and non-regular files are forbidden`,
    );
  }
  if (st.size > MAX_MARKER_BYTES) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid ${WORKSPACE_REALM_MARKER_FILE} marker: exceeds maximum size of ${MAX_MARKER_BYTES} bytes`,
    );
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const nonEmptyLines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (nonEmptyLines.length !== 1) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid ${WORKSPACE_REALM_MARKER_FILE} marker: must contain exactly one realm ID or /path`,
    );
  }
  const ref = nonEmptyLines[0]!;
  if (!MARKER_REF_RE.test(ref)) {
    throw new MindError(
      "INVALID_INPUT",
      `Invalid ${WORKSPACE_REALM_MARKER_FILE} marker syntax: expected realm_<id> or /realm/path`,
    );
  }
  return { ref, filePath };
}

/**
 * Discovers and validates a `.meru-mind-realm` workspace marker starting at `cwd`.
 * MUST ONLY be called at process entrypoints (`cli.ts main()` and `mcp.ts runStdio()`),
 * NEVER inside library APIs (`createMindEngine` / `createMindMcpServer`) so host cwd
 * never leaks into unit tests or embedded library callers.
 *
 * Security boundaries:
 * - Only walks upward when `cwd` lies inside `homeDir`, stopping at the nearest `.git` root
 *   or `homeDir` (whichever comes first).
 * - When `cwd` is outside `homeDir` (e.g. `/tmp/...`), inspects ONLY `cwd` itself.
 * - Rejects symlinks, non-regular files, files > 512 bytes, and invalid syntax without echoing content.
 */
export function discoverWorkspaceRealmMarker(
  cwd: string,
  homeDir: string = os.homedir(),
): WorkspaceRealmMarker | null {
  const startDir = path.resolve(cwd);
  const resolvedHome = path.resolve(homeDir);
  const allowWalkUp = isInsideOrEqual(startDir, resolvedHome);

  let current = startDir;
  while (true) {
    const candidate = path.join(current, WORKSPACE_REALM_MARKER_FILE);
    if (fs.existsSync(candidate)) {
      return readAndValidateMarker(candidate);
    }
    if (!allowWalkUp) {
      return null;
    }
    if (current === resolvedHome) {
      return null;
    }
    // Stop walking upward once we reach a git repository root
    if (fs.existsSync(path.join(current, ".git"))) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current || !isInsideOrEqual(parent, resolvedHome)) {
      return null;
    }
    current = parent;
  }
}
