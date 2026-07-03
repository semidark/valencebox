// Phase 1+2 verification: boot, disk layout, virtio-console handshake.
import { SandboxVM } from "../src/main/vm";
import { HostBridge } from "../src/main/bridge";

const VERBOSE = !!process.env.VERBOSE;

async function main() {
  const vm = new SandboxVM({
    memoryMB: 512,
    onSerial: VERBOSE ? (t) => process.stdout.write(t) : undefined,
  });

  console.log("booting…");
  const t0 = Date.now();
  await vm.start();

  const bridge = new HostBridge(vm);
  const helloP = bridge.waitGuestHello(120000);

  await vm.waitSerial(/login:/, 120000);
  console.log(`✓ boot to login prompt in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // login and inspect the system
  let mark = vm.serialLog.length;
  vm.serialWrite("root\n");
  await vm.waitSerial(/Password:/, 15000, mark);
  vm.serialWrite("root\n");
  await vm.waitSerial(/:~#/, 15000, mark);
  console.log("✓ root login (bash)");

  const run = async (cmd: string, expect: RegExp, timeout = 15000) => {
    mark = vm.serialLog.length;
    vm.serialWrite(cmd + "\n");
    const out = await vm.waitSerial(expect, timeout, mark);
    return out;
  };

  const hn = await run("echo HN=$(hostname)=$(cat /etc/hostname)", /HN=\S+/);
  console.log(`  hostname state: ${hn}`);

  await run("mount | grep ' /workspace '", /\/dev\/[a-z]+b on \/workspace type ext4/);
  console.log("✓ /workspace mounted from second disk (ext4)");

  await run("ls -l /dev/hvc0 && echo HVC_OK", /HVC_OK/);
  console.log("✓ /dev/hvc0 present");

  await run("rc-service sync-agent status; echo STATUS_DONE", /started[\s\S]*STATUS_DONE/);
  console.log("✓ sync-agent service started");

  const hello = await helloP;
  console.log(`✓ guest HELLO: ${hello.payload.toString()}`);

  let rtt = -1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      rtt = await bridge.ping(8000);
      break;
    } catch (e: any) {
      console.log(`  ping attempt ${attempt} failed: ${e.message}`);
      await run("tail -3 /var/log/sync-agent.log; echo LOG_DONE", /LOG_DONE/);
      console.log("  agent log tail: " + vm.serialLog.slice(mark).replace(/\r/g, "").slice(0, 600));
    }
  }
  if (rtt < 0) throw new Error("PING never acknowledged");
  console.log(`✓ PING acked in ${rtt}ms`);

  const rtts: number[] = [];
  for (let i = 0; i < 10; i++) rtts.push(await bridge.ping());
  console.log(`✓ 10 pings: min ${Math.min(...rtts)}ms max ${Math.max(...rtts)}ms`);

  vm.stop();
  console.log("ALL BOOT TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
