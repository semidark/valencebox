// Production-tunnel benchmark (docs/NET-CONTAINMENT.md "final evidence item").
// Measures the REAL stack — valencebox-mux daemon, MuxChannel framing/flow
// control, relay listeners, EgressProxy injection — not the prototype harness.
//
// Scenarios:
//   S1  tunnel ceiling      128 MiB plain HTTP via guest relay → raw host server
//   S2  full strict chain   128 MiB HTTPS via relay → EgressProxy → local TLS server
//   S3  npm-shape           500 × 64 KiB HTTPS, concurrency 16, p50/p99
//   S4  interference        S2 while unison churns the workspace share
//   S5  stability           N rounds of S3 (default 3) — desync/stall guard
//   S6  legacy comparison   S2 over SLIRP (separate boot with strictNet:false)
//
// Usage: npx tsx test/bench-tunnel.ts [--accel kvm|tcg] [--legacy] [--quick] [--rounds N]
//   --quick   S2 + S3 only (skip churn/stability)
//   --legacy  boot SLIRP mode instead (comparison run)
// Images must exist (npm run images). NEVER run with SCRATCH pointing at a
// real directory (cleanup deletes its SCRATCH root, like the boot tests).
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { generate as selfsignedGenerate } from "selfsigned";
import { VmManager } from "../src/main/vm-manager";
import { HttpShare } from "../src/main/http-share";
import { EgressProxy } from "../src/main/egress-proxy";
import { startTcpPortForwards } from "../src/main/port-forwards";
import { imagesDir, rootQcow2Path, workspaceQcow2Path, getRandomFreePort } from "../src/main/asset-paths";
import { x86_64Profile } from "../src/main/guest-profile";
import { EgressRuntimeConfig } from "../src/config";

const args = process.argv.slice(2);
const ACCEL = (args.includes("--accel") ? args[args.indexOf("--accel") + 1] : process.env.ACCEL ?? "kvm");
const LEGACY = args.includes("--legacy");
const QUICK = args.includes("--quick");
const ROUNDS = args.includes("--rounds") ? Number(args[args.indexOf("--rounds") + 1]) : 3;

const SCRATCH = process.env.SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "vbbench-"));
const BIG_BYTES = 128 * 1024 * 1024;
const OBJ_BYTES = 64 * 1024;
const OBJ_COUNT = 500;
const CONC = 16;
const TOKEN = "benchtok123";
const GUEST_PROXY_RELAY = 3128;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes: number, ms: number) => (bytes / (1024 * 1024) / (ms / 1000)).toFixed(0);
const stats = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return xs.length
    ? { n: xs.length, mean: (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1), p50: pct(50).toFixed(1), p99: pct(99).toFixed(1), max: sorted[sorted.length - 1].toFixed(1) }
    : { n: 0 };
};

async function main() {
  const tag = LEGACY ? `legacy/${ACCEL}` : `strict/${ACCEL}`;
  console.log(`\n==== bench run: ${tag} (rounds=${QUICK ? 1 : ROUNDS}, quick=${QUICK}) ====`);
  const tmpDir = fs.mkdtempSync(path.join(SCRATCH, "bench-"));
  const workspaceDir = fs.mkdtempSync(path.join(SCRATCH, "ws-"));
  let vm: VmManager | undefined;
  let share: HttpShare | undefined;
  let proxy: EgressProxy | undefined;
  let forwards: { close(): void } | undefined;
  let rawServer: http.Server | undefined;
  let tlsServer: https.Server | undefined;
  const results: Record<string, any> = {};

  try {
    // ---- host servers ----
    const big = Buffer.alloc(BIG_BYTES, 0x61);
    const obj = Buffer.alloc(OBJ_BYTES, 0x62);
    rawServer = http.createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "Content-Length": big.length });
        res.end(big);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => rawServer.listen(0, "127.0.0.1", r));
    const rawPort = (rawServer.address() as net.AddressInfo).port;

    const kp = await selfsignedGenerate([{ name: "commonName", value: "127.0.0.1" }], {
      keySize: 2048,
      extensions: [{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] }],
    });
    tlsServer = https.createServer({ key: kp.private, cert: kp.cert }, (req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "Content-Length": big.length });
        res.end(big);
      } else {
        const m = req.url?.match(/\/obj\/(\d+)/);
        if (m) { res.writeHead(200, { "Content-Length": obj.length }); res.end(obj); }
        else { res.writeHead(404); res.end(); }
      }
    });
    await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
    const tlsPort = (tlsServer.address() as net.AddressInfo).port;

    share = new HttpShare();
    const shareCfg = await share.start(workspaceDir);
    fs.writeFileSync(path.join(workspaceDir, ".valence-sync-marker"), "");

    const proxyCfg: EgressRuntimeConfig = {
      policy: "none", allowHosts: [], denyHosts: [], allowPorts: [],
      allowAll: false, enableMitm: false, secrets: [], port: 0,
      authToken: TOKEN, maxConnections: 512, rateLimitPerMin: 0,
      listenHost: LEGACY ? "0.0.0.0" : "127.0.0.1",
    };
    proxy = new EgressProxy(proxyCfg, path.join(tmpDir, "ca"), path.join(tmpDir, "proxy.log"));
    await proxy.start();
    const proxyPort = proxy.port;

    // ---- guest VMs serve only loopback and only autossh: brief silence is fine.

    // Host-side switch: during S1 the "proxy" stream goes to the raw server
    // (isolates tunnel+relay), afterwards to EgressProxy (full chain).
    let sink: "raw" | "proxy" = "proxy";
    const sshPort = await getRandomFreePort();

    // ---- boot VM ----
    const kernel = path.join(imagesDir(), "vmlinuz.bin");
    const initrd = path.join(imagesDir(), "initramfs.bin");
    const rootImage = rootQcow2Path();
    const workspaceImage = workspaceQcow2Path();
    const profile = x86_64Profile(rootImage, workspaceImage, kernel, initrd);

    const shareConfigFile = path.join(tmpDir, "share-config.json");
    fs.writeFileSync(shareConfigFile, JSON.stringify({
      port: LEGACY ? shareCfg.port : 8081,
      token: shareCfg.token,
    }), { mode: 0o600 });

    vm = new VmManager({
      memoryMB: 1024,
      smp: 2,
      tmpDir,
      accel: ACCEL as any,
      guestProfile: profile,
      kernel, initrd, rootImage, workspaceImage,
      kernelCmdline: profile.kernelCmdline,
      shareConfigFile,
      proxyPort: LEGACY ? proxyPort : GUEST_PROXY_RELAY,
      sharePort: LEGACY ? undefined : 8081,
      proxyToken: TOKEN,
      portForwards: LEGACY
        ? [{ hostPort: sshPort, guestPort: 22, label: "bench ssh (hostfwd)" }]
        : [{ hostPort: sshPort, guestPort: 22, label: "bench ssh (mux)" }],
      strictNet: !LEGACY,
    });
    console.log(`booting (${LEGACY ? "SLIRP" : "strict, -nic none"})...`);
    const t0 = Date.now();
    await vm.start();

    if (!LEGACY) {
      const mux = vm.mux!;
      mux.onStream((target, stream) => {
        if (target === "proxy") {
          if (sink === "raw") rawServer.emit("connection", stream);
          else proxy!.injectConnection(stream);
        } else if (target === "share" && share) {
          share.injectConnection(stream);
        } else throw new Error(`unknown mux target '${target}'`);
      });
      forwards = startTcpPortForwards(mux, [{ hostPort: sshPort, guestPort: 22, label: "bench ssh (mux)" }]);
    }

    await vm.waitSerial(/login:/, 180000);
    (globalThis as any).__benchVm = vm;
    console.log(`boot: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    await vm.waitSerial(/:~#/, 10000);
    const matter = await new Promise<string>((res, rej) => {
      execFile("ssh", [
        "-q", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
        "-o", "IdentitiesOnly=yes", "-i", path.join(imagesDir(), "vm-debug"),
        "-p", String(sshPort), "root@127.0.0.1", "echo READY",
      ], { timeout: 30000 }, (e, out) => (e ? rej(e) : res(String(out))));
    });
    if (!matter.includes("READY")) throw new Error("ssh into guest failed");
    results.bootSec = Number((((Date.now() - t0) / 1000)).toFixed(0));

    const sshOnce = (cmd: string, timeout: number): Promise<string> =>
      new Promise((res, rej) => {
        execFile("ssh", [
          "-q", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
          "-o", "IdentitiesOnly=yes", "-i", path.join(imagesDir(), "vm-debug"),
          "-p", String(sshPort), "root@127.0.0.1", `bash -lc '${cmd.replace(/'/g, `'\\''`)}'`,
        ], { timeout, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => {
          if (e) rej(new Error(`ssh cmd failed killed=${(e as any).killed} code=${(e as any).code} signal=${(e as any).signal}: ${e.message} | stderr: ${String(err).slice(0, 400)}`));
          else res(String(out));
        });
      });
    const run = async (cmd: string, timeout = 300000): Promise<string> => {
      let lastErr: Error | undefined;
      for (let i = 0; i < 3; i++) {
        try { return await sshOnce(cmd, timeout); }
        catch (err: any) {
          lastErr = err;
          if (!String(err.message).includes("ssh cmd failed")) throw err;
          await sleep(2000);
        }
      }
      throw lastErr;
    };

    const dl = async (url: string, insecure: boolean): Promise<number[]> =>
      (await run(`out=''; for i in 1 2 3; do no_proxy=' ' NO_PROXY=' ' curl ${insecure ? "-k" : ""} -s -S -o /dev/null -w '%{time_total} ' --max-time 90 '${url}' || exit 9; done; echo $out`))
        .trim().split(/\s+/).map(Number).filter((x) => Number.isFinite(x) && x > 0);

    // ---- S1: tunnel ceiling (raw sink) ----
    if (!LEGACY) {
      sink = "raw";
      const t = (await run(`for i in 1 2 3; do curl -s -o /dev/null -w '%{time_total} ' --max-time 90 'http://127.0.0.1:${GUEST_PROXY_RELAY}/big'; done`))
        .trim().split(/\s+/).map(Number).filter((x) => Number.isFinite(x) && x > 0);
      results.S1_tunnelCeiling = { note: "plain HTTP via relay → raw host server (tunnel+relay only)", times_s: t, MBps: t.map((x) => mb(BIG_BYTES, x * 1000)) };
      sink = "proxy";
      console.log("S1 tunnel ceiling MB/s:", results.S1_tunnelCeiling.MBps.join(", "));

      // Probe: is the HOST LISTENER still accepting?
      const tcpProbe = await new Promise<string>((res) => {
        const c = net.createConnection(sshPort, "127.0.0.1");
        c.setTimeout(3000);
        c.on("connect", () => { c.destroy(); res("listener accepts"); });
        c.on("error", (e: any) => res("listener connect error: " + e.code));
        c.on("timeout", () => { c.destroy(); res("listener timeout"); });
      });
      console.log("S1 tcp probe:", tcpProbe);
      console.log("S1 mux state: connected=" + vm!.mux!.connected + " ready=" + vm!.mux!.ready);

      // Probe: is the mux path still usable for new streams after the flood?
      const probe = await new Promise<string>((res, rej) => {
        (async () => {
          try {
            const st = await vm!.mux!.openStream("fwd:22", 8000);
            st.write("\n");
            let buf = "";
            st.on("data", (c: Buffer) => { buf += c.toString().slice(0, 40); if (buf.includes("SSH-") || buf.length > 40) { st.destroy(); res("SSH banner: " + buf.slice(0, 20)); } });
            setTimeout(() => { st.destroy(); res("no banner, bytes=" + buf.length); }, 4000);
          } catch (e: any) { rej(e); }
        })();
      });
      console.log("S1 post-flood probe:", probe);

      // Daemon state after the flood (plain ssh works; curl's exit code was the red herring).
      const st = await run("ss -tlnp | grep -E '3128|8081'; pgrep -a valencebox-mux; systemctl show valencebox-mux -p NRestarts,SubState,ExecMainStatus,MainPID --no-pager; journalctl -b -t valencebox-mux --no-pager | tail -8; echo STATE_DONE", 20000);
      console.log("S1 daemon state:\n" + st.split("STATE_DONE")[0]);
    } else {
      // Legacy comparison point for S1: direct HTTP via proxy (no TLS)
      const t = await dl(`http://127.0.0.1:${tlsPort}/big`, false);
      results.S1_note = "legacy boot does not use the tunnel; S1 skipped (no relay exists)";
    }

    // ---- S2: full chain ----
    {
      const t = await dl(`https://127.0.0.1:${tlsPort}/big`, true);
      results.S2_fullChain = { site: "guest curl → relay → mux → EgressProxy → local TLS", times_s: t, MBps: t.map((x) => mb(BIG_BYTES, x * 1000)) };
      console.log("S2 full chain MB/s:", results.S2_fullChain.MBps.join(", "));
    }

    // ---- S3: npm-shape + S5 stability rounds ----
    {
      const rounds: any[] = [];
      const n = QUICK ? 1 : ROUNDS;
      for (let r = 0; r < n; r++) {
        const out = await run(
          `seq 0 ${OBJ_COUNT - 1} | sed 's|^|https://127.0.0.1:${tlsPort}/obj/|' > /tmp/urls; ` +
          `t0=$(date +%s%N); xargs -P ${CONC} -I{} env no_proxy=' ' NO_PROXY=' ' curl -k -s -o /dev/null -w '%{http_code} %{time_total}\\n' --max-time 60 {} < /tmp/urls > /tmp/times.txt; ` +
          `t1=$(date +%s%N); echo $(( (t1-t0)/1000000 )); grep -c '^200 ' /tmp/times.txt; grep '^200 ' /tmp/times.txt | awk '{print $2}' | sort -n | awk '{x[NR]=$1} END{print x[int(NR*0.5)+1]*1000, x[int(NR*0.99)+1]*1000}'`,
          600000,
        );
        const [wallMs, ok200, p50, p99] = out.trim().split(/\s+/).map(Number);
        const mbps = ((OBJ_COUNT * OBJ_BYTES) / (1024 * 1024) / (wallMs / 1000)).toFixed(1);
        rounds.push({ wallMs, reqPerSec: ((OBJ_COUNT / wallMs) * 1000).toFixed(0), MBps: mbps, p50Ms: p50.toFixed(1), p99Ms: p99.toFixed(1), http200: ok200 });
        console.log(`S3 round ${r}: ${rounds[rounds.length - 1].reqPerSec} req/s, MB/s ${mbps}, p50 ${p50.toFixed(1)}ms p99 ${p99.toFixed(1)}ms, ${ok200}/${OBJ_COUNT}`);
        await sleep(1000);
      }
      results.S3_npmShape = { note: `${OBJ_COUNT} x ${OBJ_BYTES >> 10}KiB HTTPS, conc ${CONC}`, rounds };
    }

    // ---- S4: interference (S2 with unison churn) ----
    if (!QUICK && !LEGACY) {
      let churning = true;
      let churned = 0;
      const churner = (async () => {
        while (churning) {
          const round = Date.now();
          for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(workspaceDir, `churn-${round}-${i}`), Buffer.alloc(256 * 1024, 0x63));
          churned += 20;
          await sleep(2000);
        }
      })();
      try {
        const t = await dl(`https://127.0.0.1:${tlsPort}/big`, true);
        results.S4_interference = { note: `S2 while unison syncs ${churned}+ host-written files`, times_s: t, MBps: t.map((x) => mb(BIG_BYTES, x * 1000)) };
      } finally {
        churning = false;
        await churner.catch(() => {});
        for (const f of fs.readdirSync(workspaceDir)) if (f.startsWith("churn-")) fs.unlinkSync(path.join(workspaceDir, f));
      }
      console.log("S4 churn MB/s:", results.S4_interference?.MBps.join(", "));
    }

    console.log(`\n==== RESULTS (${tag}) ====`);
    console.log(JSON.stringify(results, null, 2));
  } finally {
    if (vm) await vm.stop().catch(() => {});
    forwards?.close();
    await proxy?.stop().catch(() => {});
    await share?.stop().catch(() => {});
    rawServer?.close();
    tlsServer?.close();
    if (!process.env.SCRATCH) fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("BENCH FAIL:", e.message ?? e);
  try {
    const vmAny = (globalThis as any).__benchVm;
    if (vmAny?.serialLog) console.error("--- last serial output ---\n" + vmAny.serialLog.slice(-2500));
  } catch {}
  process.exit(1);
});
