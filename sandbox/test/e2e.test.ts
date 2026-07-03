// End-to-end: the Sandbox orchestrator cold-boots, hydrates a host dir,
// snapshots, and a second Sandbox restores from it and reconciles host drift.
import * as fs from "fs";
import * as path from "path";
import { Sandbox } from "../src/main/sandbox";

const SCRATCH = process.env.SCRATCH ?? "/tmp";
const ROOT = path.join(SCRATCH, `e2e-${process.pid}`);
const HOST = path.join(ROOT, "workspace");
const SNAP = path.join(ROOT, "snapshots", "vm.zst");

function reset() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOST, { recursive: true });
  fs.writeFileSync(path.join(HOST, "hello.txt"), "hello from host\n");
  fs.mkdirSync(path.join(HOST, "src"));
  fs.writeFileSync(path.join(HOST, "src", "app.ts"), "export const x = 42;\n");
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  reset();

  // ---- cold boot ----
  const sb = new Sandbox({
    hostDir: HOST,
    snapshotFile: SNAP,
    conflictLog: path.join(ROOT, "snapshots", "conflicts.log"),
    enableNetwork: false, // isolate this test from the network path
    onSerial: process.env.VERBOSE ? (c) => process.stdout.write(c) : undefined,
  });
  const readyP = new Promise<void>((res) =>
    sb.on("status", (s) => s.phase === "ready" && res())
  );
  await sb.start();
  await readyP;
  console.log(`✓ cold boot ready in ${(sb.status.bootMs! / 1000).toFixed(1)}s (pushed ${sb.status.sync?.pushed})`);

  await sb.runInGuest("cat /workspace/src/app.ts", /export const x = 42;/);
  console.log("✓ hydrated files present in guest");

  // guest creates a build artifact
  await sb.runInGuest("mkdir -p /workspace/dist && echo built > /workspace/dist/out.txt && echo OK", /OK/);
  await wait(1500);
  if (!fs.existsSync(path.join(HOST, "dist", "out.txt"))) throw new Error("guest artifact not synced to host");
  console.log("✓ guest artifact synced back to host");

  await sb.saveSnapshot();
  console.log(`✓ snapshot saved (${(sb.status.snapshot!.compressedBytes / 1e6).toFixed(1)} MB)`);
  await sb.stop();

  // ---- host drift while VM is down ----
  fs.writeFileSync(path.join(HOST, "src", "app.ts"), "export const x = 99;\n");
  fs.writeFileSync(path.join(HOST, "added-offline.txt"), "added while off\n");
  console.log("• mutated host dir while sandbox was stopped");

  // ---- restore ----
  const sb2 = new Sandbox({
    hostDir: HOST,
    snapshotFile: SNAP,
    enableNetwork: false,
    onSerial: process.env.VERBOSE ? (c) => process.stdout.write(c) : undefined,
  });
  const ready2 = new Promise<void>((res) =>
    sb2.on("status", (s) => s.phase === "ready" && res())
  );
  const t0 = Date.now();
  await sb2.start();
  await ready2;
  const dt = Date.now() - t0;
  if (!sb2.status.restored) throw new Error("second start did not restore from snapshot");
  console.log(`✓ restored in ${(dt / 1000).toFixed(1)}s (warm boot)`);

  // reconcile must have pushed the offline host edits into the guest
  await sb2.runInGuest("cat /workspace/src/app.ts", /export const x = 99;/, 30000);
  await sb2.runInGuest("cat /workspace/added-offline.txt", /added while off/, 30000);
  console.log("✓ offline host drift reconciled into restored guest");

  await sb2.stop();
  console.log("ALL E2E TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
