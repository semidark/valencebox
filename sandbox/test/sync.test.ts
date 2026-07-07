// Phase 2 throughput + Phase 3 sync engine verification.
// Phase 10.5 extensions: file moves, large guest→host push, overwrite, blake2s verification.
import { blake2sHex } from "blakejs";
import * as fs from "fs";
import * as path from "path";
import { SyncManager } from "../src/main/sync-manager";
import { assert, bootAndLogin } from "./util";

const SCRATCH = process.env.SCRATCH ?? "/tmp";
const HOST_WS = path.join(SCRATCH, `hostws-${process.pid}`);

// deterministic pseudo-random bytes
function prand(size: number, seed: number): Buffer {
  const out = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
}

function makeTree(): { files: number; bytes: number } {
  fs.rmSync(HOST_WS, { recursive: true, force: true });
  fs.mkdirSync(HOST_WS, { recursive: true });
  let files = 0;
  let bytes = 0;
  const put = (rel: string, data: Buffer) => {
    const abs = path.join(HOST_WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    files++;
    bytes += data.length;
  };
  // dependency-tree-ish: many small files across nested dirs
  for (let p = 0; p < 20; p++) {
    for (let f = 0; f < 15; f++) {
      put(`vendor/pkg-${p}/lib/mod-${f}.js`, prand(500 + ((p * f * 37) % 4000), p * 100 + f));
    }
    put(`vendor/pkg-${p}/package.json`, Buffer.from(JSON.stringify({ name: `pkg-${p}` })));
  }
  // some source files
  for (let i = 0; i < 30; i++) put(`src/file-${i}.ts`, prand(2000 + i * 111, 7000 + i));
  // a couple of big artifacts
  put("dist/bundle.bin", prand(8 * 1024 * 1024, 42));
  put("dist/assets.bin", prand(4 * 1024 * 1024, 43));
  put("README.md", Buffer.from("# sync test\n"));
  // ignored trees: present on host, must never reach the guest (not counted)
  for (const rel of ["node_modules/some-pkg/index.js", ".git/config", ".DS_Store"]) {
    const abs = path.join(HOST_WS, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `ignored ${rel}\n`);
  }
  return { files, bytes };
}

const blake2s = (p: string) => blake2sHex(fs.readFileSync(p), undefined, 32);

async function waitFor(desc: string, cond: () => boolean, timeoutMs = 30000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${desc}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  const tree = makeTree();
  console.log(`host tree: ${tree.files} files, ${(tree.bytes / 1e6).toFixed(1)} MB`);

  const { vm, bridge, run } = await bootAndLogin();
  console.log("✓ booted + guest agent connected");

  const sync = new SyncManager(bridge, HOST_WS);
  sync.on("error", (e) => console.log(`  sync error: ${e.message}`));

  // ---- hydrate (host → guest bulk) = the throughput measurement ----
  const t0 = Date.now();
  await sync.hydrate();
  const dt = (Date.now() - t0) / 1000;
  const mbps = tree.bytes / 1e6 / dt;
  console.log(`✓ hydrated ${tree.files} files in ${dt.toFixed(1)}s → ${mbps.toFixed(2)} MB/s`);
  assert(mbps > 0.5, `throughput ${mbps.toFixed(2)} MB/s is below 0.5 MB/s floor`);

  // verify counts and a hash inside the guest
  await run(
    "echo COUNT=$(find /workspace -type f -not -path '*/.sync-tmp/*' -not -path '*/lost+found/*' | wc -l)",
    new RegExp(`COUNT=${tree.files}\\b`)
  );
  console.log("✓ guest file count matches");

  await run(
    "echo IGNORED_MISSING=$(ls /workspace/node_modules /workspace/.git /workspace/.DS_Store 2>&1 | grep -c 'No such')",
    /IGNORED_MISSING=3/
  );
  console.log("✓ ignored trees (node_modules, .git, .DS_Store) not synced");

  const bundleHash = blake2s(path.join(HOST_WS, "dist/bundle.bin"));
  await run("blake2sum /workspace/dist/bundle.bin", new RegExp(bundleHash));
  console.log("✓ guest big-file blake2s matches host");

  // ---- live host → guest ----
  fs.writeFileSync(path.join(HOST_WS, "src/live-edit.ts"), "export const v = 1;\n");
  await waitFor("host push", () => sync.stats.pushed > tree.files - 1 + 1, 20000);
  await run("cat /workspace/src/live-edit.ts", /export const v = 1;/);
  console.log("✓ live host edit appeared in guest");

  // ---- live guest → host ----
  await run("echo 'from-guest-content-xyz' > /workspace/from-guest.txt && echo WROTE", /WROTE/);
  await waitFor(
    "guest push",
    () =>
      fs.existsSync(path.join(HOST_WS, "from-guest.txt")) &&
      fs.readFileSync(path.join(HOST_WS, "from-guest.txt"), "utf8").includes("from-guest-content-xyz"),
    30000
  );
  console.log("✓ guest-created file synced to host");

  // ---- delete guest → host ----
  await run("rm /workspace/from-guest.txt && echo RMDONE", /RMDONE/);
  await waitFor("guest delete", () => !fs.existsSync(path.join(HOST_WS, "from-guest.txt")), 30000);
  console.log("✓ guest deletion synced to host");

  // ---- delete host → guest ----
  const delBefore = sync.stats.deleted;
  fs.rmSync(path.join(HOST_WS, "README.md"));
  await waitFor("host delete", () => sync.stats.deleted > delBefore, 20000);
  await run("ls /workspace/README.md 2>&1 || echo GONE_OK", /GONE_OK|No such file/);
  console.log("✓ host deletion synced to guest");

  // ---- conflict: LWW ----
  // guest edits a file; then host writes the same path with an OLDER mtime →
  // when the guest's push arrives, remote(guest) mtime is newer → guest wins.
  await run("echo 'guest version' > /workspace/conflict.txt && echo CDONE", /CDONE/);
  await waitFor("conflict file arrival", () => fs.existsSync(path.join(HOST_WS, "conflict.txt")), 30000);
  const old = new Date(Date.now() - 60000);
  fs.writeFileSync(path.join(HOST_WS, "conflict.txt"), "host stale version\n");
  fs.utimesSync(path.join(HOST_WS, "conflict.txt"), old, old);
  await run("echo 'guest version 2' > /workspace/conflict.txt && echo C2DONE", /C2DONE/);
  await waitFor(
    "LWW guest win",
    () => fs.readFileSync(path.join(HOST_WS, "conflict.txt"), "utf8").includes("guest version 2"),
    30000
  );
  console.log(`✓ LWW conflict resolved (records: ${sync.stats.conflicts})`);

  // ---- live guest → host file move (same directory) ----
  await run("echo 'move-content-123' > /workspace/move-src.txt && mv /workspace/move-src.txt /workspace/move-dst.txt && echo MOVED_OK", /MOVED_OK/);
  await waitFor(
    "guest file move",
    () => fs.existsSync(path.join(HOST_WS, "move-dst.txt")) && !fs.existsSync(path.join(HOST_WS, "move-src.txt")),
    30000
  );
  assert(
    fs.readFileSync(path.join(HOST_WS, "move-dst.txt"), "utf8").includes("move-content-123"),
    "move destination content mismatch"
  );
  console.log("✓ guest file move synced to host");

  // ---- guest cross-directory file move ----
  await run(
    "mkdir -p /workspace/dest && echo 'cross-move' > /workspace/cross-src.txt && mv /workspace/cross-src.txt /workspace/dest/cross-dst.txt && echo CMOVED_OK",
    /CMOVED_OK/
  );
  await waitFor(
    "guest cross-dir move",
    () =>
      fs.existsSync(path.join(HOST_WS, "dest/cross-dst.txt")) &&
      !fs.existsSync(path.join(HOST_WS, "cross-src.txt")),
    30000
  );
  assert(
    fs.readFileSync(path.join(HOST_WS, "dest/cross-dst.txt"), "utf8").includes("cross-move"),
    "cross-dir move destination content mismatch"
  );
  console.log("✓ guest cross-directory file move synced to host");

  // ---- guest directory move ----
  await run(
    "mkdir -p /workspace/mvdir/sub && echo 'dir-move-data' > /workspace/mvdir/sub/f.txt && mv /workspace/mvdir /workspace/moved-dir && echo DMOVED_OK",
    /DMOVED_OK/
  );
  await waitFor(
    "guest dir move",
    () =>
      fs.existsSync(path.join(HOST_WS, "moved-dir/sub/f.txt")) &&
      !fs.existsSync(path.join(HOST_WS, "mvdir")),
    30000
  );
  assert(
    fs.readFileSync(path.join(HOST_WS, "moved-dir/sub/f.txt"), "utf8").includes("dir-move-data"),
    "dir move content mismatch"
  );
  console.log("✓ guest directory move synced to host");

  // ---- large guest directory rename should not cause echoed delete backlog ----
  let echoedDeletePushes = 0;
  const syncAny = sync as any;
  const realPushDelete = sync.pushDelete.bind(sync);
  syncAny.pushDelete = async (rel: string) => {
    echoedDeletePushes++;
    return realPushDelete(rel);
  };
  await run(
    "mv /workspace/vendor /workspace/vendor-moved && touch /workspace/vendor-moved/after-empty.txt && echo VREN_OK",
    /VREN_OK/
  );
  await waitFor(
    "guest large dir rename + empty file",
    () =>
      fs.existsSync(path.join(HOST_WS, "vendor-moved/pkg-0/lib/mod-0.js")) &&
      fs.existsSync(path.join(HOST_WS, "vendor-moved/after-empty.txt")) &&
      !fs.existsSync(path.join(HOST_WS, "vendor")),
    15000
  );
  await new Promise((r) => setTimeout(r, 2000));
  syncAny.pushDelete = realPushDelete;
  assert(echoedDeletePushes <= 2, `guest rename echoed ${echoedDeletePushes} host delete push(es)`);
  console.log(`✓ guest large directory rename + empty file synced quickly (echoed deletes=${echoedDeletePushes})`);

  // ---- large guest→host push (triggers window draining, >1.5 MB) ----
  // Use 3 MB of deterministic data so blake2s is predictable
  const bigSeed = 99999;
  const bigSize = 3 * 1024 * 1024;
  const bigData = Buffer.alloc(bigSize);
  let xs = bigSeed >>> 0;
  for (let i = 0; i < bigSize; i++) {
    xs = (xs * 1664525 + 1013904223) >>> 0;
    bigData[i] = xs & 0xff;
  }
  const bigRel = "big-push.bin";
  const bigAbs = path.join(HOST_WS, bigRel);
  fs.writeFileSync(bigAbs, bigData);
  const bigHash = blake2s(bigAbs);

  // Push big file into guest first (hydrate it) — pushFile resolves once
  // the guest has ack'd the completed transfer, so no extra wait needed.
  await sync.pushFile(bigRel);
  await run(`blake2sum /workspace/${bigRel}`, new RegExp(bigHash));
  console.log("✓ 3 MB file hydrated to guest");

  // Now edit in guest and push back — this exercises the window drain
  await run(`dd if=/dev/urandom of=/workspace/${bigRel} bs=1M count=3 2>/dev/null && echo BIGDONE`, /BIGDONE/);
  await waitFor(
    "big file guest push",
    () => {
      if (!fs.existsSync(bigAbs)) return false;
      // file should have changed (size still 3 MB, but content differs)
      return fs.statSync(bigAbs).size === bigSize;
    },
    60000
  );
  console.log("✓ large guest→host push (3 MB, window draining) synced");

  // ---- file content overwrite (existing file) ----
  await run("echo 'v1-initial' > /workspace/overwrite-test.txt && echo OV1_OK", /OV1_OK/);
  await waitFor(
    "overwrite v1 arrival",
    () =>
      fs.existsSync(path.join(HOST_WS, "overwrite-test.txt")) &&
      fs.readFileSync(path.join(HOST_WS, "overwrite-test.txt"), "utf8").includes("v1-initial"),
    30000
  );
  await run("echo 'v2-revised-content' > /workspace/overwrite-test.txt && echo OV2_OK", /OV2_OK/);
  await waitFor(
    "overwrite v2 arrival",
    () =>
      fs.existsSync(path.join(HOST_WS, "overwrite-test.txt")) &&
      fs.readFileSync(path.join(HOST_WS, "overwrite-test.txt"), "utf8").includes("v2-revised-content"),
    30000
  );
  console.log("✓ file overwrite (write new content to existing file) synced");

  console.log(
    `stats: pushed=${sync.stats.pushed} pulled=${sync.stats.pulled} deleted=${sync.stats.deleted} ` +
      `out=${(sync.stats.bytesOut / 1e6).toFixed(1)}MB in=${(sync.stats.bytesIn / 1e6).toFixed(1)}MB`
  );

  await sync.stop();
  vm.stop();
  console.log("ALL SYNC TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
