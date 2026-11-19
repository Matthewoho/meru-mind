import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BlobPort } from "../ports.js";
import { MindError } from "../types.js";

const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * Immutable content-addressed local blob store (blobs/<prefix>/<sha256>, 0o444).
 * Provides durable storage for seabed artifacts/evidence and drive snapshots.
 */
export class LocalBlobStore implements BlobPort {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    fs.mkdirSync(rootDir, { recursive: true });
  }

  private blobPath(sha256: string): string {
    if (!SHA256_RE.test(sha256)) {
      throw new MindError("INVALID_INPUT", `Invalid sha256 digest: ${sha256}`);
    }
    return path.join(this.rootDir, sha256.slice(0, 2), sha256);
  }

  put(content: Buffer | string): { sha256: string; bytes: number } {
    const buf =
      typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const target = this.blobPath(sha256);

    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
      fs.writeFileSync(tmp, buf, { mode: 0o444 });
      try {
        fs.renameSync(tmp, target);
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // ignore cleanup failure
        }
        if (!fs.existsSync(target)) {
          throw err;
        }
      }
      try {
        fs.chmodSync(target, 0o444);
      } catch {
        // ignore chmod failure on platforms that disallow it
      }
    }

    return { sha256, bytes: buf.byteLength };
  }

  get(sha256: string): Buffer | null {
    const target = this.blobPath(sha256);
    if (!fs.existsSync(target)) {
      return null;
    }
    return fs.readFileSync(target);
  }

  getText(sha256: string): string | null {
    const buf = this.get(sha256);
    return buf ? buf.toString("utf8") : null;
  }

  has(sha256: string): boolean {
    const target = this.blobPath(sha256);
    return fs.existsSync(target);
  }
}
