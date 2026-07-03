import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { FileMeta, ManifestPayload } from "../shared/protocol";

export const TMP_DIR_NAME = ".sync-tmp";

export function hashFileSync(p: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

const SKIP_DIRS = new Set([TMP_DIR_NAME, "lost+found", ".git", "node_modules/.cache"]);

export function buildManifest(root: string): ManifestPayload {
  const files: Record<string, FileMeta> = {};
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(rel)) continue;
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(abs);
          files[rel] = {
            hash: hashFileSync(abs),
            size: st.size,
            mode: st.mode & 0o777,
            mtimeMs: Math.floor(st.mtimeMs),
          };
        } catch {
          /* raced deletion */
        }
      }
      // symlinks/others skipped per protocol
    }
  };
  walk(root);
  return { files };
}

/** Resolve a protocol-relative path under root, rejecting escapes. */
export function safeJoin(root: string, rel: string): string | null {
  if (!rel || rel.startsWith("/") || rel.includes("\0")) return null;
  const norm = path.normalize(rel.split("/").join(path.sep));
  if (norm === ".." || norm.startsWith(".." + path.sep) || path.isAbsolute(norm)) return null;
  return path.join(root, norm);
}
