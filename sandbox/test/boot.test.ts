// QEMU rewrite boot test: boot to Ubuntu serial login, verify disk layout,
// and confirm key guest services are running (systemd).
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { VmManager } from "../src/main/vm-manager";
import { imagesDir, rootQcow2Path, workspaceQcow2Path } from "../src/main/asset-paths";
import { x86_64Profile } from "../src/main/guest-profile";

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

  const profile = x86_64Profile(rootImage, workspaceImage, kernel, initrd);

  const vm = new VmManager({
    memoryMB: 512,
    smp: 1,
    tmpDir,
    accel: (ACCEL as any) ?? "tcg",
    guestProfile: profile,
    kernel,
    initrd,
    rootImage,
    workspaceImage,
    kernelCmdline: profile.kernelCmdline,
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

  // Track the length of the serial log before each command so waitSerial only
  // matches output produced *after* the command is sent (not the echoed cmd or
  // earlier boot noise). Commands append a unique sentinel so we match the
  // command's own output, not the typed command line echoed back.
  const run = async (cmd: string, expect: RegExp, timeout = 15000) => {
    const from = vm.serialLog.length;
    vm.sendInput(cmd + "\n");
    return vm.waitSerial(expect, timeout, from);
  };

  await run("hostname", /sandbox/);
  console.log("✓ hostname set");

  // Ubuntu aliases `grep` to `grep --color=auto` for interactive shells, which
  // injects ANSI escapes into the match. Use findmnt (stable, uncolored output)
  // to assert the /workspace mount source + fstype.
  await run("findmnt -no SOURCE,FSTYPE /workspace; echo MNT_DONE", /\/dev\/vdb\s+ext4[\s\S]*MNT_DONE/);
  console.log("✓ /workspace mounted from second disk (ext4)");

  // `is-active` prints `active\r\n`; match `active` bounded by CR/LF so it does
  // not also match `activating`.
  await run("systemctl is-active mount-share; echo STATUS_DONE", /[\r\n]active[\r\n][\s\S]*STATUS_DONE/);
  console.log("✓ mount-share service started");

  // workspace-sync is Type=simple; without a host WebDAV share the sync script
  // loops (waiting for secrets/marker), so the unit oscillates between active
  // and activating (Restart=on-failure). Poll until we catch it `active`.
  let syncActive = false;
  for (let i = 0; i < 15 && !syncActive; i++) {
    try {
      await run("systemctl is-active workspace-sync; echo SYNC_DONE", /[\r\n]active[\r\n][\s\S]*SYNC_DONE/, 3000);
      syncActive = true;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!syncActive) throw new Error("workspace-sync did not reach active state");
  console.log("✓ workspace-sync service started");

  await vm.stop();
  console.log("ALL BOOT TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
