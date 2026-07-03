// Data-plane verification: bulk sync over a host↔guest TCP stream carried by
// virtio-net + WISP (console remains control channel + fallback).
//  1. guest dials the VIP and authenticates with the boot token
//  2. hydrate runs over TCP and clearly beats the console's ~2.9 MB/s
//  3. guest→host pushes travel the TCP path too
//  4. after snapshot restore (new wisp port + new token) the guest re-dials
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { SandboxVM } from "../src/main/vm";
import { HostBridge } from "../src/main/bridge";
import { SyncManager } from "../src/main/sync-manager";
import { SnapshotManager } from "../src/main/snapshot";
import { WispServer } from "../src/main/wisp";
import { DataPlane } from "../src/main/data-plane";
import { assert, bootAndLogin } from "./util";

const SCRATCH = process.env.SCRATCH ?? "/tmp";
const HOST_WS = path.join(SCRATCH, `dpws-${process.pid}`);
const SNAP = path.join(SCRATCH, `dpsnap-${process.pid}.zst`);
const MB = 1024 * 1024;

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
  for (let i = 0; i < 200; i++) put(`src/mod-${i}.ts`, prand(1200 + i * 13, 900 + i));
  // small-file-heavy portion: exercises TREE_PUT batching (per-file round
  // trips would otherwise dominate at ~30 ms RTT)
  for (let i = 0; i < 600; i++) {
    put(`packages/pkg-${i % 30}/lib/module-${i}.js`, prand(4096 + (i % 512), 5000 + i));
  }
  put("dist/big-a.bin", prand(12 * MB, 7));
  put("dist/big-b.bin", prand(8 * MB, 8));
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

function newNet(): { wisp: WispServer; dp: DataPlane } {
  const wisp = new WispServer({ allowHosts: [], allowPorts: [80, 443] });
  const dp = new DataPlane();
  dp.on("log", (m: string) => console.log(`  [dp] ${m}`));
  wisp.attachDataPlane(dp);
  return { wisp, dp };
}

async function main() {
  fs.rmSync(SNAP, { force: true });
  fs.rmSync(SNAP + ".meta.json", { force: true });
  const tree = makeTree();
  console.log(`host tree: ${tree.files} files, ${(tree.bytes / MB).toFixed(1)} MB`);

  const { wisp, dp } = newNet();
  await wisp.start();
  const { vm, bridge, run } = await bootAndLogin(
    { relayUrl: wisp.relayUrl },
    { helloExtra: { dataPlane: dp.advert() } }
  );
  console.log("✓ booted, data plane advertised in hello-ack");

  const ch = await dp.waitChannel(90000);
  console.log("✓ guest dialed the VIP and authenticated");

  const sync = new SyncManager(bridge, HOST_WS);
  sync.on("error", (e) => console.log(`  sync error: ${e.message}`));
  sync.attachDataChannel(ch);

  const t0 = Date.now();
  await sync.hydrate();
  const dt = (Date.now() - t0) / 1000;
  const mbps = tree.bytes / MB / dt;
  // Bar: clearly beat the measured console baseline for the same tree
  // (~2.9 MB/s for bytes + ~5 ms per-file round trip, serial). MB/s alone
  // misleads on small-file-heavy trees where bytes are tiny but per-file
  // guest VFS work dominates.
  const consoleEst = tree.bytes / (2.9 * MB) + tree.files * 0.005;
  console.log(
    `✓ hydrated ${tree.files} files in ${dt.toFixed(1)}s (${mbps.toFixed(1)} MB/s; ` +
      `console baseline ≈ ${consoleEst.toFixed(1)}s)`
  );
  assert(
    dt < consoleEst * 0.8,
    `data-plane hydrate ${dt.toFixed(1)}s should clearly beat console baseline ~${consoleEst.toFixed(1)}s`
  );

  await run(
    "echo COUNT=$(find /workspace -type f -not -path '*/lost+found/*' | wc -l)",
    new RegExp(`COUNT=${tree.files}\\b`),
    60000
  );
  console.log("✓ guest file count matches (incl. TREE_PUT-batched files)");

  const bigHash = sha(path.join(HOST_WS, "dist/big-a.bin"));
  await run("sha256sum /workspace/dist/big-a.bin", new RegExp(bigHash), 120000);
  console.log("✓ guest big-file sha256 matches host");

  const smallHash = sha(path.join(HOST_WS, "packages/pkg-7/lib/module-337.js"));
  await run("sha256sum /workspace/packages/pkg-7/lib/module-337.js", new RegExp(smallHash), 30000);
  console.log("✓ guest batched-small-file sha256 matches host");

  // guest → host over the data plane
  await run(
    "dd if=/dev/zero of=/workspace/from-guest.bin bs=1M count=4 2>/dev/null && echo tail-marker-xyz >> /workspace/from-guest.bin && echo GDONE",
    /GDONE/,
    60000
  );
  await waitFor(
    "guest push",
    () => {
      const p = path.join(HOST_WS, "from-guest.bin");
      try {
        return fs.statSync(p).size > 4 * MB && fs.readFileSync(p).includes("tail-marker-xyz");
      } catch {
        return false;
      }
    },
    60000
  );
  console.log("✓ guest-created 4MB file synced to host (data plane)");

  // ---- snapshot → restore: guest must re-dial the NEW advert ----
  const snaps = new SnapshotManager(vm, SNAP);
  await snaps.save();
  vm.stop();
  await wisp.stop();
  console.log("✓ snapshot saved, vm + wisp stopped");

  const { wisp: wisp2, dp: dp2 } = newNet();
  await wisp2.start();
  const state = await SnapshotManager.load(SNAP);
  const vm2 = new SandboxVM({
    memoryMB: 512,
    relayUrl: wisp2.relayUrl,
    initialState: state,
    onSerial: process.env.VERBOSE ? (t) => process.stdout.write(t) : undefined,
  });
  await vm2.start();
  const bridge2 = new HostBridge(vm2);
  bridge2.helloExtra = { dataPlane: dp2.advert() };
  await bridge2.hello();
  console.log("✓ restored + re-helloed with fresh advert");

  const ch2 = await dp2.waitChannel(90000);
  console.log("✓ guest re-dialed after restore (new port, new token)");

  const sync2 = new SyncManager(bridge2, HOST_WS);
  sync2.attachDataChannel(ch2);
  fs.writeFileSync(path.join(HOST_WS, "post-restore.txt"), "after restore\n");
  await sync2.pushFile("post-restore.txt");
  const mark = vm2.serialLog.length;
  vm2.serialWrite("cat /workspace/post-restore.txt\n");
  await vm2.waitSerial(/after restore/, 30000, mark);
  console.log("✓ post-restore push over new data plane verified in guest");

  await sync.stop();
  await sync2.stop();
  vm2.stop();
  await wisp2.stop();
  fs.rmSync(HOST_WS, { recursive: true, force: true });
  fs.rmSync(SNAP, { force: true });
  fs.rmSync(SNAP + ".meta.json", { force: true });
  console.log("ALL DATA PLANE TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
