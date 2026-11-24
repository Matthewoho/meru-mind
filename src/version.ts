import fs from "node:fs";

function loadPackageVersion(): string {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // Fallback if package.json is unavailable in a custom bundle
  }
  return "0.5.2";
}

export const MERU_MIND_VERSION: string = loadPackageVersion();
