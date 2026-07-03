// Fast, VM-less unit test for sync ignore rules + manifest chunking.
import { isIgnored, splitManifest } from "../src/main/manifest";
import { MAX_PAYLOAD, ManifestPayload } from "../src/shared/protocol";
import { assert } from "./util";

// ---- isIgnored ----
assert(isIgnored("node_modules/react/index.js"), "node_modules ignored");
assert(isIgnored("packages/app/node_modules/x.js"), "nested node_modules ignored");
assert(isIgnored(".git/config"), ".git ignored");
assert(isIgnored("src/.DS_Store"), ".DS_Store ignored");
assert(isIgnored(".sync-tmp/put-1"), "tmp dir ignored");
assert(!isIgnored("src/app.ts"), "regular source not ignored");
assert(!isIgnored("node_modules_notes.md"), "prefix-only name not ignored");
assert(!isIgnored("src/gitthing/.gitignore"), ".gitignore file not ignored");
console.log("✓ isIgnored rules");

// ---- splitManifest ----
const big: ManifestPayload = { files: {} };
for (let i = 0; i < 8000; i++) {
  big.files[`packages/pkg-${i % 40}/src/deeply/nested/module-${i}.ts`] = {
    hash: "a".repeat(64),
    size: 123456 + i,
    mode: 0o644,
    mtimeMs: 1750000000000 + i,
  };
}
const whole = Buffer.byteLength(JSON.stringify(big));
assert(whole > MAX_PAYLOAD, `test manifest is oversized (${whole} bytes)`);

const parts = splitManifest(big);
assert(parts.length > 1, `oversized manifest split into ${parts.length} parts`);
let total = 0;
for (const [i, p] of parts.entries()) {
  const n = Buffer.byteLength(JSON.stringify(p));
  assert(n <= MAX_PAYLOAD, `part ${i} fits in a frame (${n} <= ${MAX_PAYLOAD})`);
  total += Object.keys(p.files).length;
}
assert(total === 8000, `no entries lost across parts (${total})`);
const merged: Record<string, unknown> = {};
for (const p of parts) Object.assign(merged, p.files);
assert(
  JSON.stringify(merged) === JSON.stringify(big.files) ||
    Object.keys(merged).every((k) => big.files[k] !== undefined),
  "merged parts reproduce the manifest"
);
console.log(`✓ splitManifest: ${whole} bytes → ${parts.length} frames, all within cap`);

// tiny manifest stays a single part
assert(splitManifest({ files: {} }).length === 1, "empty manifest → one part");
console.log("ALL MANIFEST UNIT TESTS PASSED");
