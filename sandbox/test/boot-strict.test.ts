// Strict network mode boot test: boots the VM with -nic none and the
// virtio-serial mux tunnel, asserting the full Phase 1 gate:
//   - serial login, hostname, /workspace disk layout
//   - no network interfaces except lo (no NIC/SLIRP)
//   - valencebox-mux daemon active; HELLO seen; share+proxy injected streams work
//   - WebDAV sync reaches active state over the tunnel (mount-share + unison)
//   - HTTP through the guest proxy relay reaches a host-side service
//   - SSH debug access over a host-initiated mux forward
//
// Requires images/root.qcow2 with valencebox-mux (npm run images) and cargo
// artifacts are not needed here. ACCEL defaults to tcg.
import { execFile } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { VmManager } from "../src/main/vm-manager";
import { HttpShare } from "../src/main/http-share";
import { EgressProxy, parseTransparentTarget } from "../src/main/egress-proxy";
import { startTcpPortForwards } from "../src/main/port-forwards";
import { imagesDir, rootQcow2Path, workspaceQcow2Path, getRandomFreePort } from "../src/main/asset-paths";
import { x86_64Profile } from "../src/main/guest-profile";
import { EgressRuntimeConfig } from "../src/config";

const VERBOSE = !!process.env.VERBOSE;
const SCRATCH = process.env.SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "boot-strict-"));
const ACCEL = process.env.ACCEL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(SCRATCH, "boot-strict-"));
  const workspaceDir = fs.mkdtempSync(path.join(SCRATCH, "ws-"));
  let vm: VmManager | undefined;
  let share: HttpShare | undefined;
  let proxy: EgressProxy | undefined;
  let forwards: { close(): void } | undefined;

  try {
    const kernel = path.join(imagesDir(), "vmlinuz.bin");
    const initrd = path.join(imagesDir(), "initramfs.bin");
    const rootImage = rootQcow2Path();
    const workspaceImage = workspaceQcow2Path();
    for (const f of [kernel, initrd, rootImage, workspaceImage]) {
      if (!fs.existsSync(f)) throw new Error(`missing image: ${f}`);
    }
    const profile = x86_64Profile(rootImage, workspaceImage, kernel, initrd);

    // Host-side share + proxy (policy none; loopback listeners).
    share = new HttpShare();
    const shareCfg = await share.start(workspaceDir);
    fs.writeFileSync(path.join(workspaceDir, ".valence-sync-marker"), "");
    console.log(`[share] WebDAV on 127.0.0.1:${shareCfg.port}`);

    const proxyCfg: EgressRuntimeConfig = {
      policy: "denylist", allowHosts: [], denyHosts: ["blocked.valencebox.test"], allowPorts: [],
      allowAll: false, enableMitm: false, secrets: [], port: 0,
      authToken: "testtoken123", maxConnections: 64, rateLimitPerMin: 0,
      listenHost: "127.0.0.1",
    };
    proxy = new EgressProxy(proxyCfg, path.join(tmpDir, "ca"), path.join(tmpDir, "proxy.log"));
    await proxy.start();
    console.log(`[proxy] on 127.0.0.1:${proxy.port}`);

    // fw_cfg share config: in strict mode the port is the guest relay port.
    const GUEST_SHARE_RELAY_PORT = 8081;
    const GUEST_PROXY_RELAY_PORT = 3128;
    const shareConfigFile = path.join(tmpDir, "share-config.json");
    fs.writeFileSync(shareConfigFile, JSON.stringify({ port: GUEST_SHARE_RELAY_PORT, token: shareCfg.token }), { mode: 0o600 });

    const sshHostPort = await getRandomFreePort();

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
      proxyPort: GUEST_PROXY_RELAY_PORT,
      sharePort: GUEST_SHARE_RELAY_PORT,
      proxyToken: proxyCfg.authToken,
      portForwards: [{ hostPort: sshHostPort, guestPort: 22, label: "SSH debug (mux)" }],
      strictNet: true,
    });

    if (VERBOSE) {
      vm.on("serial:data", (data: string) => process.stdout.write(data));
    }

    console.log("booting (strict: -nic none)...");
    const t0 = Date.now();
    await vm.start();

    const mux = vm.mux;
    if (!mux) throw new Error("mux channel missing (strictNet had no transport?)");
    let helloSeen = false;
    mux.on("ready", () => { helloSeen = true; console.log("[mux] ready"); });
    mux.on("closed", () => { console.log("[mux] CHANNEL CLOSED"); });
    mux.on("error", (e) => { console.log("[mux] channel error:", e.message); });
    const seenTproxyTargets: string[] = [];
    // Route mux streams into the in-process servers, as main.ts does.
    mux.onStream((target, stream) => {
      if (target === "proxy" && proxy) proxy.injectConnection(stream);
      else if (target === "share" && share) share.injectConnection(stream);
      else if (target.startsWith("tproxy:") && proxy) {
        seenTproxyTargets.push(target);
        const parsed = parseTransparentTarget(target);
        if (!parsed) throw new Error(`malformed tproxy target '${target}'`);
        // Map the synthetic test hostname to 127.0.0.1 on the host so the test
        // requires no external DNS while still exercising the full guest
        // Fake-DNS + iptables OUTPUT REDIRECT + SO_ORIGINAL_DST path.
        const dialHost = parsed.host === "tproxy.valencebox.test" ? "127.0.0.1" : parsed.host;
        proxy.injectTransparentConnection(stream, dialHost, parsed.port);
      } else throw new Error(`unknown mux target '${target}'`);
    });
    forwards = startTcpPortForwards(mux, [{ hostPort: sshHostPort, guestPort: 22, label: "SSH debug (mux)" }]);

    await vm.waitSerial(/login:/, 180000);
    console.log(`✓ boot to login prompt in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await vm.waitSerial(/:~#/, 10000);
    console.log("✓ root login (bash)");

    const run = async (cmd: string, expect: RegExp, timeout = 20000) => {
      const from = vm!.serialLog.length;
      vm!.sendInput(cmd + "\n");
      return vm!.waitSerial(expect, timeout, from);
    };

    await run("hostname", /sandbox/);
    console.log("✓ hostname set");

    // No NIC: only lo may exist. Sentinels are split (LINKS_"DONE") so the
    // echoed command cannot satisfy the match before real output arrives.
    const links = await run(
      `echo "LINKS_"'DONE'"'"; ip -o link show | awk -F': ' '{print $2}'`,
      /LINKS_DONE[\s\S]*?[\r\n](lo[\s\S]*?)[\r\n]/,
      15000,
    );
    const ifaces = links.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z0-9@]+$/.test(l));
    if (!ifaces.includes("lo")) throw new Error(`lo missing: ${ifaces.join(",")}`);
    if (ifaces.some((i) => i !== "lo")) throw new Error(`unexpected interfaces in strict mode: ${ifaces.join(",")}`);
    console.log("✓ no network interfaces except lo (strict containment)");

    await run("systemctl is-active valencebox-mux; echo MUX_DONE", /[\r\n]active[\r\n][\s\S]*MUX_DONE/, 30000);
    console.log("✓ valencebox-mux service active");

    // Wait for the daemon to come up and greet the host.
    const helloDeadline = Date.now() + 60000;
    while (!helloSeen && Date.now() < helloDeadline) await new Promise((r) => setTimeout(r, 200));
    if (!helloSeen) throw new Error("mux HELLO not received");
    console.log("✓ mux HELLO received (tunnel up)");

    await run("findmnt -no SOURCE,FSTYPE /workspace; echo MNT_DONE", /\/dev\/vdb\s+ext4[\s\S]*MNT_DONE/);
    console.log("✓ /workspace mounted from second disk (ext4)");

    await run("systemctl is-active mount-share; echo STATUS_DONE", /[\r\n]active[\r\n][\s\S]*STATUS_DONE/);
    console.log("✓ mount-share service started");

    // workspace-sync over the tunnel: davfs2 → 127.0.0.1 relay → mux → host share.
    let syncActive = false;
    for (let i = 0; i < 30 && !syncActive; i++) {
      try {
        await run("systemctl is-active workspace-sync; echo SYNC_DONE", /[\r\n]active[\r\n][\s\S]*SYNC_DONE/, 3000);
        syncActive = true;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!syncActive) throw new Error("workspace-sync did not reach active state");
    console.log("✓ workspace-sync active (WebDAV over the mux tunnel)");

    // Egress round trip: guest curl → proxy relay → mux → host proxy → share.
    // (no_proxy is cleared inline because the relay and target are loopback.)
    const curlCmd =
      `no_proxy=' ' NO_PROXY=' ' code=$(curl -s -o /dev/null -w '%{http_code}' ` +
      `-u valence:${shareCfg.token} -X PROPFIND -H 'Depth: 0' ` +
      `-x http://valencebox:testtoken123@127.0.0.1:${GUEST_PROXY_RELAY_PORT} ` +
      `http://127.0.0.1:${shareCfg.port}/); echo "HTTPCODE_$code"`;
    const curlOut = await run(curlCmd, /HTTPCODE_\d{3}/, 30000);
    const code = curlOut.match(/HTTPCODE_(\d{3})/)?.[1];
    if (code !== "207") throw new Error(`PROPFIND via proxy relay returned ${code ?? "?"} (expected 207)`);
    console.log("✓ egress round trip: curl → proxy relay → mux → EgressProxy → WebDAV (207)");

    // Phase 2 transparent proxy gate:
    // 1. Fake-DNS on 127.0.0.1:53 resolves synthetic hostnames into 198.18.0.0/15.
    const dnsOut = await run(
      `getent ahostsv4 tproxy.valencebox.test | head -1 | awk '{print $1}'; echo "DNS_"'DONE'`,
      /198\.18\.\d+\.\d+[\s\S]*DNS_DONE/,
      15000,
    );
    const fakeIp = dnsOut.match(/(198\.18\.\d+\.\d+)/)?.[1];
    if (!fakeIp) throw new Error(`Fake-DNS did not return 198.18.x.y: ${dnsOut}`);
    console.log(`✓ Fake-DNS resolved tproxy.valencebox.test → ${fakeIp}`);

    // 2. Non-proxy-aware client (env -i strips HTTP_PROXY/http_proxy, no -x flag)
    //    connects to hostname → Fake-DNS → lo OUTPUT REDIRECT → valencebox-mux:3129
    //    (SO_ORIGINAL_DST) → mux "tproxy:<host>:<port>" → EgressProxy → WebDAV (207).
    const tproxyAllowCmd =
      `tcode=$(env -i PATH=/usr/bin:/bin curl -s -o /dev/null -w '%{http_code}' ` +
      `-u valence:${shareCfg.token} -X PROPFIND -H 'Depth: 0' ` +
      `-H 'Host: 127.0.0.1:${shareCfg.port}' ` +
      `http://tproxy.valencebox.test:${shareCfg.port}/); echo "TPROXY_ALLOW_$tcode"`;
    const tproxyAllowOut = await run(tproxyAllowCmd, /TPROXY_ALLOW_\d{3}/, 30000);
    const tAllowCode = tproxyAllowOut.match(/TPROXY_ALLOW_(\d{3})/)?.[1];
    if (tAllowCode !== "207") {
      throw new Error(`transparent PROPFIND (no HTTP_PROXY) returned ${tAllowCode ?? "?"} (expected 207)`);
    }
    if (!seenTproxyTargets.includes(`tproxy:tproxy.valencebox.test:${shareCfg.port}`)) {
      throw new Error(`expected tproxy:tproxy.valencebox.test:${shareCfg.port} in ${JSON.stringify(seenTproxyTargets)}`);
    }
    console.log("✓ transparent proxy: env-stripped curl → Fake-DNS → iptables REDIRECT → tproxy → WebDAV (207)");

    // 3. Disallowed host fails closed over the transparent path.
    const tproxyDenyCmd =
      `dcode=$(env -i PATH=/usr/bin:/bin curl -s -o /dev/null -w '%{http_code}' --max-time 5 ` +
      `http://blocked.valencebox.test:${shareCfg.port}/ || true); echo "TPROXY_DENY_$dcode"`;
    const tproxyDenyOut = await run(tproxyDenyCmd, /TPROXY_DENY_\d{3}/, 20000);
    const tDenyCode = tproxyDenyOut.match(/TPROXY_DENY_(\d{3})/)?.[1];
    if (tDenyCode !== "000" && tDenyCode !== "403") {
      throw new Error(`transparent denied host returned ${tDenyCode ?? "?"} (expected 000 or 403)`);
    }
    if (!seenTproxyTargets.includes(`tproxy:blocked.valencebox.test:${shareCfg.port}`)) {
      throw new Error(`expected tproxy:blocked.valencebox.test:${shareCfg.port} in ${JSON.stringify(seenTproxyTargets)}`);
    }
    console.log(`✓ transparent proxy policy: denied host blocked (${tDenyCode})`);

    // Raw TCP probe of the SSH forward (captures the mux failure reason).
    console.log("[probe] starting; state:", mux.connected, (mux as any).stopped);
    const probe = await new Promise<string>((res) => {
      const s = net.createConnection(sshHostPort, "127.0.0.1");
      let buf = "";
      s.on("connect", () => { buf += "connected;"; });
      s.on("data", (c: Buffer) => { buf += c.toString(); if (buf.includes("SSH-")) { s.destroy(); res(buf); } });
      s.on("error", (e) => { buf += `err:${e.message}`; res(buf); });
      s.on("close", () => { if (!buf.includes("SSH-") && !buf.startsWith("err:")) res(buf + "closed-no-banner"); });
      setTimeout(() => { s.destroy(); res(buf + "timeout"); }, 20000);
    });
    console.log("[probe]", probe, "mux.connected =", mux.connected, "stopped =", (mux as any).stopped);
    if (!probe.includes("SSH-")) throw new Error(`ssh forward probe failed: ${probe}`);
    console.log("✓ SSH banner received over host-initiated mux forward");

    // Full ssh login over the forward. execFile (async) — the mux channel and
    // forward listeners must keep serving while ssh runs; execFileSync would
    // freeze the event loop and starve the tunnel.
    const keyPath = path.join(imagesDir(), "vm-debug");
    const sshOut = await new Promise<string>((res, rej) => {
      execFile(
        "ssh",
        [
          "-q", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
          "-o", "ProxyCommand=none", "-o", "ConnectTimeout=10",
          "-i", keyPath, "-p", String(sshHostPort), "root@127.0.0.1", "echo SSH_OVER_MUX",
        ],
        { encoding: "utf8", timeout: 45000 },
        (err, stdout, stderr) => {
          if (err) rej(new Error(`ssh failed: ${String(stderr || err.message).slice(0, 200)}`));
          else res(String(stdout));
        },
      );
    });
    if (!sshOut.includes("SSH_OVER_MUX")) throw new Error(`ssh over mux forward failed: ${sshOut}`);
    console.log("✓ SSH debug access over host-initiated mux forward");

    console.log("ALL STRICT BOOT TESTS PASSED");
  } finally {
    if (vm) await vm.stop();
    forwards?.close();
    await proxy?.stop();
    await share?.stop();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("FAIL:", e.message ?? e);
  process.exit(1);
});
