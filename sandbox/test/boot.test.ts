// QEMU rewrite boot test: boot to Ubuntu serial login, verify disk layout,
// and confirm key guest services are running (systemd).
//
// Runs WITH a real host WebDAV share so the fw_cfg share-config path is
// exercised end-to-end: the guest must load qemu_fw_cfg, read the share
// config from /sys/firmware, mount /host-workspace, and bring workspace-sync
// to a stable `active` state. Without a share the sync script exits on the
// missing davfs secrets and the `active` window is too short to sample.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { VmManager } from "../src/main/vm-manager";
import { HttpShare } from "../src/main/http-share";
import { imagesDir, rootQcow2Path, workspaceQcow2Path } from "../src/main/asset-paths";
import { x86_64Profile } from "../src/main/guest-profile";

const VERBOSE = !!process.env.VERBOSE;
const SCRATCH = process.env.SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "boot-"));
const ACCEL = process.env.ACCEL;

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(SCRATCH, "boot-test-"));
  const hostWorkspace = fs.mkdtempSync(path.join(SCRATCH, "host-ws-"));
  let vm: VmManager | undefined;
  let share: HttpShare | undefined;

  try {
    const kernel = path.join(imagesDir(), "vmlinuz.bin");
    const initrd = path.join(imagesDir(), "initramfs.bin");
    const rootImage = rootQcow2Path();
    const workspaceImage = workspaceQcow2Path();

    if (!fs.existsSync(kernel)) throw new Error(`Kernel not found: ${kernel}`);
    if (!fs.existsSync(initrd)) throw new Error(`Initrd not found: ${initrd}`);
    if (!fs.existsSync(rootImage)) throw new Error(`Root image not found: ${rootImage}`);
    if (!fs.existsSync(workspaceImage)) throw new Error(`Workspace image not found: ${workspaceImage}`);

    // ---- Host share: seed a file + the sync marker the guest waits for ----
    fs.writeFileSync(path.join(hostWorkspace, "host-seed.txt"), "hello-from-host");
    fs.writeFileSync(path.join(hostWorkspace, ".valence-sync-marker"), "");
    share = new HttpShare();
    const shareCfg = await share.start(hostWorkspace);
    const shareConfigFile = path.join(tmpDir, "share-config.json");
    fs.writeFileSync(shareConfigFile, JSON.stringify({ port: shareCfg.port, token: shareCfg.token }), { mode: 0o600 });
    console.log(`[test] host share on 127.0.0.1:${shareCfg.port}`);

    const profile = x86_64Profile(rootImage, workspaceImage, kernel, initrd);

    vm = new VmManager({
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
      shareConfigFile,
      portForwards: [],
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
      const from = vm!.serialLog.length;
      vm!.sendInput(cmd + "\n");
      return vm!.waitSerial(expect, timeout, from);
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

    // ---- Fix #1: fw_cfg delivered the share config to the guest ----
    // qemu_fw_cfg must be loaded (baked into initramfs) so the sysfs tree
    // exists and mount-share.sh could read the port/token from it.
    await run(
      "cat /sys/firmware/qemu_fw_cfg/by_name/opt/org.valencebox.config/raw; echo FWCFG_DONE",
      new RegExp(`"port":${shareCfg.port}[\\s\\S]*"token":"${shareCfg.token}"[\\s\\S]*FWCFG_DONE`),
      15000
    );
    console.log("✓ fw_cfg share config readable in guest (qemu_fw_cfg loaded)");

    // ---- Fix #4: /host-workspace (davfs) mounts and unison syncs ----
    // With the share + marker present, workspace-sync reaches a stable `active`
    // (unison running), not the old no-share exit-and-restart race.
    let syncActive = false;
    for (let i = 0; i < 20 && !syncActive; i++) {
      try {
        await run("systemctl is-active workspace-sync; echo SYNC_DONE", /[\r\n]active[\r\n][\s\S]*SYNC_DONE/, 3000);
        syncActive = true;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!syncActive) throw new Error("workspace-sync did not reach active state");
    console.log("✓ workspace-sync service active");

    // Host seed file must propagate into the guest's native /workspace.
    let synced = false;
    for (let i = 0; i < 15 && !synced; i++) {
      try {
        await run("cat /workspace/host-seed.txt 2>/dev/null; echo SEED_DONE", /hello-from-host[\s\S]*SEED_DONE/, 3000);
        synced = true;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!synced) throw new Error("host seed file did not sync into /workspace");
    console.log("✓ host→guest sync round-trip");

    // Guest edits must propagate back to the host workspace (bidirectional sync).
    // Write via a dedicated file in /tmp then mv to prevent partial writes.
    // Use a unique per-run filename and payload so previous runs on persistent qcow2 cannot false-pass.
    const guestRunId = Date.now().toString(36);
    const guestFileName = `guest-created-${guestRunId}.txt`;
    const guestPayload = `hello-from-guest-${guestRunId}`;
    await run(
      `echo ${guestPayload} > /tmp/guest-tmp && mv /tmp/guest-tmp /workspace/${guestFileName}; echo GUEST_SYNC_READY`,
      /[\r\n]GUEST_SYNC_READY[\r\n]/,
      5000
    );
    const guestFilePath = path.join(hostWorkspace, guestFileName);
    let guestSynced = false;
    for (let i = 0; i < 20 && !guestSynced; i++) {
      if (fs.existsSync(guestFilePath)) {
        try {
          const content = fs.readFileSync(guestFilePath, "utf-8").trim();
          if (content === guestPayload) {
            guestSynced = true;
            break;
          }
        } catch {
          // File may be midway through write
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!guestSynced) throw new Error("guest file did not sync back to host workspace");
    console.log("✓ guest→host sync round-trip");

    // No .nephelemeta sidecars leaked into the guest workspace or host tree (recursive check).
    // find runs without pipe to wc so errors (e.g. unreadable/missing dir) exit non-zero and fail.
    await run(
      "find_out=$(find /workspace -name '*nephelemeta*') && [ -z \"$find_out\" ] && echo META_CHECK_OK || echo META_CHECK_FAIL; echo META_CHECK_DONE",
      /[\r\n]META_CHECK_OK[\r\n][\s\S]*META_CHECK_DONE/,
      10000
    );

    const hasNepheleMeta = (dir: string): boolean => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.includes("nephelemeta")) return true;
        if (entry.isDirectory()) {
          if (hasNepheleMeta(path.join(dir, entry.name))) return true;
        }
      }
      return false;
    };
    if (hasNepheleMeta(hostWorkspace)) {
      throw new Error(".nephelemeta sidecars detected in host workspace tree");
    }
    console.log("✓ no .nephelemeta sidecars in /workspace or host tree");

    console.log("ALL BOOT TESTS PASSED");
  } finally {
    if (vm) await vm.stop();
    if (share) await share.stop();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
