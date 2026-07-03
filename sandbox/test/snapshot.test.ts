// Phase 4 verification: zstd save_state → restore skips cold boot.
import * as path from "path";
import { SandboxVM } from "../src/main/vm";
import { HostBridge } from "../src/main/bridge";
import { SnapshotManager } from "../src/main/snapshot";
import { assert, bootAndLogin } from "./util";

const SCRATCH = process.env.SCRATCH ?? "/tmp";
const SNAP = path.join(SCRATCH, `snap-${process.pid}.zst`);

async function main() {
  // ---- cold boot, leave a RAM/disk marker, snapshot ----
  const cold = await bootAndLogin();
  console.log("✓ cold boot done");

  // hostname sanity while we're here (earlier runs showed 'localhost')
  const hn = await cold.run("sh /sbin/firstboot.sh; rc-service hostname restart >/dev/null 2>&1; echo H_$(hostname)_H", /H_[a-z]+_H/);
  console.log(`  hostname after firstboot re-run: ${hn}`);

  await cold.run("echo snapshot-marker-123 > /root/marker && sync && echo MARKED", /MARKED/);

  const snap = new SnapshotManager(cold.vm, SNAP);
  const res = await snap.save();
  console.log(
    `✓ snapshot saved: raw ${(res.rawBytes / 1e6).toFixed(1)}MB → zstd ${(res.compressedBytes / 1e6).toFixed(1)}MB in ${res.ms}ms`
  );
  cold.vm.stop();

  // ---- restore ----
  const t0 = Date.now();
  const state = await SnapshotManager.load(SNAP);
  const vm = new SandboxVM({ memoryMB: 512, initialState: state });
  await vm.start();
  const bridge = new HostBridge(vm);
  const dt = Date.now() - t0;

  // the restored VM continues the old shell session — no login needed
  const mark = vm.serialLog.length;
  vm.serialWrite("cat /root/marker\n");
  await vm.waitSerial(/snapshot-marker-123/, 30000, mark);
  console.log(`✓ restored in ${(dt / 1000).toFixed(1)}s — marker present, session continued`);
  assert(dt < 30000, `restore took ${dt}ms`);

  // bridge must survive restore (virtio-console state is serialized)
  const rtt = await bridge.ping(10000);
  console.log(`✓ bridge alive after restore (ping ${rtt}ms)`);

  vm.stop();
  console.log("ALL SNAPSHOT TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
