import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { FileMeta, ManifestPayload, MAX_PAYLOAD } from "../shared/protocol";

export const TMP_DIR_NAME = ".sync-tmp";

// Never synced, at any depth. Mirrors guest/sync-agent/manifest.go.
// node_modules: host-native binaries are useless in the i386 Linux guest
// (install inside the guest instead); .git: history isn't workspace content.
export const IGNORE_SEGMENTS = new Set([
  TMP_DIR_NAME,
  ".git",
  "node_modules",
  "lost+found",
  ".DS_Store",
]);

/** true if a protocol-relative path falls under the sync ignore rules */
export function isIgnored(rel: string): boolean {
  return rel.split("/").some((seg) => IGNORE_SEGMENTS.has(seg));
}

export function hashFileSync(p: string): string {
  const h = crypto.createHash("blake2s256");
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
      if (IGNORE_SEGMENTS.has(e.name)) continue;
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

// A whole-project manifest easily exceeds MAX_PAYLOAD (a ~5k-file tree is
// ~1 MB of JSON), so it crosses the wire as multiple MANIFEST frames that the
// receiver merges. Batch limit leaves headroom under the frame cap.
const MANIFEST_BATCH_LIMIT = Math.min(160 * 1024, MAX_PAYLOAD - 32 * 1024);

/** Split a manifest into payload-sized parts (always at least one). */
export function splitManifest(m: ManifestPayload): ManifestPayload[] {
  const parts: ManifestPayload[] = [];
  let cur: Record<string, FileMeta> = {};
  let curLen = 0;
  for (const [rel, meta] of Object.entries(m.files)) {
    // serialized entry size: key + hash(64) + numbers + JSON punctuation
    const entLen = Buffer.byteLength(rel) + 160;
    if (curLen > 0 && curLen + entLen > MANIFEST_BATCH_LIMIT) {
      parts.push({ files: cur });
      cur = {};
      curLen = 0;
    }
    cur[rel] = meta;
    curLen += entLen;
  }
  parts.push({ files: cur });
  return parts;
}

/** Resolve a protocol-relative path under root, rejecting escapes. */
export function safeJoin(root: string, rel: string): string | null {
  if (!rel || rel.startsWith("/") || rel.includes("\0")) return null;
  const norm = path.normalize(rel.split("/").join(path.sep));
  if (norm === ".." || norm.startsWith(".." + path.sep) || path.isAbsolute(norm)) return null;
  return path.join(root, norm);
}
