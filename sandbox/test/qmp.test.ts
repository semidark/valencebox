// Phase 2 verification: QMP control plane — connect, negotiate, query, shutdown.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { QemuProcess } from "../src/main/qemu";
import { x86_64Profile } from "../src/main/guest-profile";

const VERBOSE = !!process.env.VERBOSE;
const SCRATCH = process.env.SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "qmp-"));
const ACCEL = process.env.ACCEL;

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(SCRATCH, "qmp-test-"));
  const qemu = new QemuProcess();

  try {
    qemu.on("stderr", (msg: string) => VERBOSE && console.error("[qemu:stderr]", msg));
    qemu.on("qmp:event", (event: string) => VERBOSE && console.log("[qmp:event]", event));

    const profile = x86_64Profile("", "");

    await qemu.start({
      memoryMB: 128,
      smp: 1,
      tmpDir,
      accel: (ACCEL as any) ?? "tcg",
      freeze: true,
      guestProfile: profile,
    });

    // query-status while frozen at prelaunch
    const status1 = await qemu.queryStatus();
    console.log(`✓ query-status: ${JSON.stringify(status1)}`);

    // clean shutdown via QMP system_powerdown
    await qemu.stop(15_000);
    console.log("✓ clean shutdown via QMP");

    if (qemu.running) throw new Error("QEMU still running after stop()");
    console.log("✓ process exited cleanly");

    console.log("ALL QMP TESTS PASSED");
  } finally {
    if (qemu.running) await qemu.stop(5_000);
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
