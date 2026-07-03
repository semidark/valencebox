// Phase 2 throughput + Phase 3 sync engine verification.
import * as crypto from "crypto";
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
  // node_modules-ish: many small files across nested dirs
  for (let p = 0; p < 20; p++) {
    for (let f = 0; f < 15; f++) {
      put(`node_modules/pkg-${p}/lib/mod-${f}.js`, prand(500 + ((p * f * 37) % 4000), p * 100 + f));
    }
    put(`node_modules/pkg-${p}/package.json`, Buffer.from(JSON.stringify({ name: `pkg-${p}` })));
  }
  // some source files
  for (let i = 0; i < 30; i++) put(`src/file-${i}.ts`, prand(2000 + i * 111, 7000 + i));
  // a couple of big artifacts
  put("dist/bundle.bin", prand(8 * 1024 * 1024, 42));
  put("dist/assets.bin", prand(4 * 1024 * 1024, 43));
  put("README.md", Buffer.from("# sync test\n"));
  return { files, bytes };
}

const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

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

  const bundleHash = sha(path.join(HOST_WS, "dist/bundle.bin"));
  await run("sha256sum /workspace/dist/bundle.bin", new RegExp(bundleHash));
  console.log("✓ guest big-file sha256 matches host");

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
  fs.rmSync(path.join(HOST_WS, "README.md"));
  await waitFor("host delete", () => sync.stats.deleted >= 2, 20000);
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
