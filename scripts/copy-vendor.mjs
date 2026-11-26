import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "dist", "vendor");

const VENDORS = [
  {
    pkgName: "marked",
    pinnedVersion: "18.3.0",
    relSrcPath: path.join("lib", "marked.esm.js"),
    outFileName: "marked.esm.js",
    outLicenseName: "marked.LICENSE",
    expectedSha256:
      "4d2d824f3035e79b6887380d88c6c9ca0958215d1f4f6c053c562d60babc7172",
  },
  {
    pkgName: "mermaid",
    pinnedVersion: "11.17.2",
    relSrcPath: path.join("dist", "mermaid.min.js"),
    outFileName: "mermaid.min.js",
    outLicenseName: "mermaid.LICENSE",
    expectedSha256:
      "581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8",
  },
];

function resolvePackageDir(pkgName) {
  const resolvedEntry = fileURLToPath(import.meta.resolve(pkgName));
  let cur = path.dirname(resolvedEntry);
  while (true) {
    const candidatePkg = path.join(cur, "package.json");
    if (fs.existsSync(candidatePkg)) {
      const parsed = JSON.parse(fs.readFileSync(candidatePkg, "utf8"));
      if (parsed.name === pkgName) {
        return { pkgDir: cur, pkgJson: parsed };
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      throw new Error(`Could not locate package.json for vendored package "${pkgName}"`);
    }
    cur = parent;
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const v of VENDORS) {
  const { pkgDir, pkgJson } = resolvePackageDir(v.pkgName);
  if (pkgJson.version !== v.pinnedVersion) {
    throw new Error(
      `Expected pinned ${v.pkgName}@${v.pinnedVersion}, found ${pkgJson.version ?? "unknown"}. Update pinned version & SHA-256 deliberately after auditing.`,
    );
  }

  const srcPath = path.join(pkgDir, v.relSrcPath);
  const buf = fs.readFileSync(srcPath);
  const actualHash = crypto.createHash("sha256").update(buf).digest("hex");
  if (actualHash !== v.expectedSha256) {
    throw new Error(
      `SHA-256 mismatch for ${v.outFileName}: expected ${v.expectedSha256}, got ${actualHash}`,
    );
  }

  fs.writeFileSync(path.join(OUT_DIR, v.outFileName), buf);

  for (const licenseName of ["LICENSE", "LICENSE.md"]) {
    const licensePath = path.join(pkgDir, licenseName);
    if (fs.existsSync(licensePath)) {
      fs.copyFileSync(licensePath, path.join(OUT_DIR, v.outLicenseName));
      break;
    }
  }

  console.log(
    `Copied verified ${v.pkgName}@${v.pinnedVersion} (${buf.length} bytes, sha256=${actualHash.slice(0, 12)}...) -> dist/vendor/${v.outFileName}`,
  );
}
