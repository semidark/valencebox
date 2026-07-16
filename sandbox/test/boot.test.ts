// QEMU rewrite boot test: boot to Alpine serial login, verify disk layout,
// and confirm key guest services are running.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { VmManager } from "../src/main/vm-manager";
import { imagesDir, rootQcow2Path, workspaceQcow2Path } from "../src/main/asset-paths";

const VERBOSE = !!process.env.VERBOSE;
const SCRATCH = process.env.SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "boot-"));
const ACCEL = process.env.ACCEL;

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(SCRATCH, "boot-test-"));

  const kernel = path.join(imagesDir(), "vmlinuz.bin");
  const initrd = path.join(imagesDir(), "initramfs.bin");
  const rootImage = rootQcow2Path();
  const workspaceImage = workspaceQcow2Path();

  if (!fs.existsSync(kernel)) throw new Error(`Kernel not found: ${kernel}`);
  if (!fs.existsSync(initrd)) throw new Error(`Initrd not found: ${initrd}`);
  if (!fs.existsSync(rootImage)) throw new Error(`Root image not found: ${rootImage}`);
  if (!fs.existsSync(workspaceImage)) throw new Error(`Workspace image not found: ${workspaceImage}`);

  const vm = new VmManager({
    memoryMB: 512,
    smp: 1,
    tmpDir,
    accel: (ACCEL as any) ?? "tcg",
    kernel,
    initrd,
    rootImage,
    workspaceImage,
    kernelCmdline: "console=ttyS0 root=/dev/vda rootfstype=ext4 rootflags=rw modules=virtio_blk,ext4",
  });

  if (VERBOSE) {
    vm.on("serial:data", (data: string) => process.stdout.write(data));
  }

  console.log("booting...");
  const t0 = Date.now();
  await vm.start();

  await vm.waitSerial(/login:/, 120000);
  console.log(`✓ boot to login prompt in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // root auto-login (agetty -a root), no password prompt
  await vm.waitSerial(/:~#/, 10000);
  console.log("✓ root login (bash)");

  const run = async (cmd: string, expect: RegExp, timeout = 15000) => {
    vm.sendInput(cmd + "\n");
    return vm.waitSerial(expect, timeout);
  };

  await run("hostname", /sandbox/);
  console.log("✓ hostname set");

  await run("mount | grep ' /workspace '", /\/dev\/vdb on \/workspace type ext4/);
  console.log("✓ /workspace mounted from second disk (ext4)");

  await run("rc-service mount-share status; echo DONE", /started[\s\S]*DONE/);
  console.log("✓ mount-share service started");

  await run("rc-service workspace-sync status; echo SYNC_DONE", /started[\s\S]*SYNC_DONE/);
  console.log("✓ workspace-sync service started");

  await vm.stop();
  console.log("ALL BOOT TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
