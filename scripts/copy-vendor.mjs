import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_MARKED_VERSION = "18.3.0";
const PINNED_MARKED_ESM_SHA256 =
  "4d2d824f3035e79b6887380d88c6c9ca0958215d1f4f6c053c562d60babc7172";

const resolvedMain = fileURLToPath(import.meta.resolve("marked"));
const markedPkgDir = path.resolve(path.dirname(resolvedMain), "..");
const pkgJson = JSON.parse(
  fs.readFileSync(path.join(markedPkgDir, "package.json"), "utf8"),
);

if (pkgJson.version !== PINNED_MARKED_VERSION) {
  throw new Error(
    `Expected pinned marked@${PINNED_MARKED_VERSION}, found ${pkgJson.version ?? "unknown"}. Update PINNED_MARKED_VERSION & SHA-256 deliberately after auditing.`,
  );
}

const srcEsm = path.join(markedPkgDir, "lib", "marked.esm.js");
const buf = fs.readFileSync(srcEsm);
const actualHash = crypto.createHash("sha256").update(buf).digest("hex");
if (actualHash !== PINNED_MARKED_ESM_SHA256) {
  throw new Error(
    `SHA-256 mismatch for marked.esm.js: expected ${PINNED_MARKED_ESM_SHA256}, got ${actualHash}`,
  );
}

const outDir = path.join(ROOT, "dist", "vendor");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "marked.esm.js"), buf);

for (const licenseName of ["LICENSE", "LICENSE.md"]) {
  const licensePath = path.join(markedPkgDir, licenseName);
  if (fs.existsSync(licensePath)) {
    fs.copyFileSync(licensePath, path.join(outDir, "marked.LICENSE"));
    break;
  }
}
console.log(
  `Copied verified marked@${PINNED_MARKED_VERSION} (${buf.length} bytes, sha256=${actualHash.slice(0, 12)}...) -> dist/vendor/marked.esm.js`,
);
