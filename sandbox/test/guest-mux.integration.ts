// Integration test: the real Rust guest daemon (valencebox-mux) talking the
// mux protocol to the host MuxChannel over TCP (VALENCEBOX_MUX_TCP dev mode).
// Verifies relay opens, bidirectional data, fwd dials, and flow control
// against the production guest binary before any VM boot.
//
// Skipped when the daemon binary has not been built (cargo build --release in
// guest/guest-mux).
import { spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { MuxChannel } from "../src/main/mux-channel";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DAEMON = path.join(__dirname, "..", "guest", "guest-mux", "target", "release", "valencebox-mux");

async function listen(): Promise<net.Server> {
  const srv = net.createServer();
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  return srv;
}
const portOf = (srv: net.Server) => (srv.address() as AddressInfo).port;

async function main() {
  if (!fs.existsSync(DAEMON)) {
    console.log("SKIP: valencebox-mux not built (cargo build --release in guest/guest-mux)");
    return;
  }

  // Backing services the daemon will relay to (host side of the mux).
  const proxyEcho = await listen();
  proxyEcho.on("connection", (s) => s.pipe(s));

  const shareEcho = await listen();
  shareEcho.on("connection", (s) => s.pipe(s));

  // Reserve two free ports for the daemon's guest-side relay listeners.
  const reservePort = async (): Promise<number> => {
    const srv = await listen();
    const p = portOf(srv);
    await new Promise<void>((res) => srv.close(res));
    return p;
  };
  const proxyRelayPort = await reservePort();
  const shareRelayPort = await reservePort();

  // The mux transport carrier (daemon connects here).
  const muxSrv = await listen();
  const muxPort = portOf(muxSrv);

  const host = new MuxChannel("host");
  muxSrv.on("connection", (sock) => {
    host.attachSocket(sock);
    // Host routing, as in main.ts strict mode.
    host.onStream((target, stream) => {
      if (target === "proxy" || target === "share") {
        // Pretend to be the proxy/share: echo.
        stream.pipe(stream);
      } else {
        throw new Error(`unknown target '${target}'`);
      }
    });
  });

  const daemon = spawn(DAEMON, [], {
    env: {
      ...process.env,
      VALENCEBOX_MUX_TCP: `127.0.0.1:${muxPort}`,
      VALENCEBOX_PROXY_PORT: String(proxyRelayPort),
      VALENCEBOX_SHARE_PORT: String(shareRelayPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stderr.on("data", (d: Buffer) => console.log(`[daemon] ${d.toString().trim()}`));
  daemon.on("exit", (code) => { if (code !== null && code !== 0) throw new Error(`daemon exited ${code}`); });

  while (!host.ready) await sleep(10);
  console.log("✓ daemon HELLO received");

  // ---- 1. proxy relay: host connects to the guest relay port ----
  {
    const s = net.createConnection(proxyRelayPort, "127.0.0.1");
    await new Promise<void>((res) => s.once("connect", res));
    s.write("ping-proxy");
    const got = await new Promise<string>((res) => {
      let buf = "";
      s.on("data", (c: Buffer) => { buf += c.toString(); if (buf.includes("ping-proxy")) res(buf); });
    });
    assert(got.includes("ping-proxy"), "proxy relay roundtrip");
    s.destroy();
    console.log("✓ proxy relay (guest→host OPEN 'proxy')");
  }

  // ---- 2. share relay ----
  {
    const s = net.createConnection(shareRelayPort, "127.0.0.1");
    await new Promise<void>((res) => s.once("connect", res));
    s.write("ping-share");
    const got = await new Promise<string>((res) => {
      let buf = "";
      s.on("data", (c: Buffer) => { buf += c.toString(); if (buf.includes("ping-share")) res(buf); });
    });
    assert(got.includes("ping-share"), "share relay roundtrip");
    s.destroy();
    console.log("✓ share relay (guest→host OPEN 'share')");
  }

  // ---- 3. fwd dial: host-initiated stream, daemon dials a local service ----
  {
    const target = await listen();
    target.on("connection", (s) => s.on("data", (c: Buffer) => s.write(Buffer.concat([Buffer.from("got:"), c]))));
    const targetPort = portOf(target);
    const st = await host.openStream(`fwd:${targetPort}`, 5000);
    st.write("fwd-payload");
    const got = await new Promise<string>((res) => {
      let buf = "";
      st.on("data", (c: Buffer) => { buf += c.toString(); if (buf.includes("got:fwd-payload")) res(buf); });
    });
    assert(got.includes("got:fwd-payload"), "fwd dial roundtrip");
    st.destroy();
    target.close();
    console.log("✓ fwd dial (host→guest OPEN, daemon dials 127.0.0.1)");
  }

  // ---- 4. 4 MiB through the proxy relay, no corruption ----
  {
    const pattern = Buffer.alloc(65536);
    for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 7) & 0xff;
    const total = 4 * 1024 * 1024;
    const s = net.createConnection(proxyRelayPort, "127.0.0.1");
    await new Promise<void>((res) => s.once("connect", res));
    let received = 0, mismatches = 0, sent = 0;
    s.on("data", (c: Buffer) => {
      for (let i = 0; i < c.length; i++) {
        if (c[i] !== pattern[(received + i) % pattern.length]) mismatches++;
      }
      received += c.length;
      if (received === total) s.end();
    });
    await new Promise<void>((res) => {
      const pump = () => {
        while (sent < total) {
          sent += pattern.length;
          if (!s.write(pattern)) { s.once("drain", pump); return; }
        }
      };
      pump();
      s.on("close", res);
    });
    await sleep(100);
    assert(received === total, `received ${received}/${total}`);
    assert(mismatches === 0, `${mismatches} corrupted bytes`);
    console.log("✓ 4 MiB roundtrip through daemon relays, no corruption");
  }

  daemon.kill("SIGTERM");
  muxSrv.close();
  proxyEcho.close();
  shareEcho.close();
  console.log("ALL GUEST MUX DAEMON INTEGRATION TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
