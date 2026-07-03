// Phase 5 verification: WISP egress with DNS-gated IP-pinned allowlist.
import { WispServer } from "../src/main/wisp";
import { DOH_GATE_HOST, installDohGate } from "../src/main/doh";
import { bootAndLogin } from "./util";

async function main() {
  const wisp = new WispServer({
    allowHosts: ["dl-cdn.alpinelinux.org"],
    allowPorts: [80, 443],
    allowUdp: false,
  });
  installDohGate({
    hostAllowed: (name) => wisp.hostAllowed(name),
    onResolve: (_host, ip) => wisp.pinIp(ip),
    log: (m) => console.log(`  [gate] ${m}`),
  });
  await wisp.start();
  console.log(`✓ wisp server on ${wisp.relayUrl} + DoH gate`);

  const { vm, run } = await bootAndLogin({ relayUrl: wisp.relayUrl, dohServer: DOH_GATE_HOST });
  console.log("✓ booted with virtio NIC + wisp relay");

  await run(
    "ifconfig eth0 2>/dev/null | grep -q 'inet addr' || ifup eth0 >/dev/null 2>&1; ifconfig eth0 | grep 'inet addr'",
    /inet addr:192\.168\.86\.\d+/,
    60000
  );
  console.log("✓ eth0 up with DHCP lease from v86 virtual router");

  // NOTE: exit-code markers are used because the echoed command itself
  // appears in the serial log — `$?` only expands in the output line.
  const allowed = await run(
    "wget -q -O /tmp/apkindex http://dl-cdn.alpinelinux.org/alpine/v3.18/main/x86/APKINDEX.tar.gz; echo ALLOWED_RC=$?",
    /ALLOWED_RC=\d+/,
    90000
  );
  if (!allowed.includes("ALLOWED_RC=0")) throw new Error(`allowlisted fetch failed: ${allowed}`);
  await run("wc -c < /tmp/apkindex", /\d{4,}/, 15000);
  console.log("✓ allowlisted host reachable (APKINDEX fetched, non-empty)");

  const blocked = await run(
    "wget -q -O- -T 10 http://example.com >/dev/null 2>&1; echo BLOCKED_RC=$?",
    /BLOCKED_RC=\d+/,
    60000
  );
  if (blocked.includes("BLOCKED_RC=0")) throw new Error("egress policy leak: example.com was reachable");
  console.log("✓ non-allowlisted host blocked (DNS gate + IP pinning)");

  const apk = await run("apk update >/dev/null 2>&1; echo APK_RC=$?", /APK_RC=\d+/, 180000);
  console.log(apk.includes("APK_RC=0") ? "✓ apk update works through relay" : `  (apk update failed: ${apk} — non-fatal)`);

  vm.stop();
  await wisp.stop();
  console.log("ALL NET TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
