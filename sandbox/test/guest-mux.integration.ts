// Integration test: the real Rust guest daemon (valencebox-mux) talking the
// mux protocol to the host MuxChannel over TCP (VALENCEBOX_MUX_TCP dev mode).
// Verifies relay opens, bidirectional data, fwd dials, and flow control
// against the production guest binary before any VM boot.
//
// Skipped when the daemon binary has not been built (cargo build --release in
// guest/guest-mux).
import { spawn } from "child_process";
import * as dgram from "dgram";
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
    await new Promise<void>((res) => srv.close(() => res()));
    return p;
  };
  const proxyRelayPort = await reservePort();
  const shareRelayPort = await reservePort();
  const tproxyRelayPort = await reservePort();
  const dnsPort = await (async () => {
    const u = dgram.createSocket("udp4");
    await new Promise<void>((res) => u.bind(0, "127.0.0.1", res));
    const p = (u.address() as AddressInfo).port;
    await new Promise<void>((res) => u.close(() => res()));
    return p;
  })();

  // The mux transport carrier (daemon connects here).
  const muxSrv = await listen();
  const muxPort = portOf(muxSrv);

  const openedTargets: string[] = [];
  const host = new MuxChannel("host");
  muxSrv.on("connection", (sock) => {
    host.attachSocket(sock);
    // Host routing, as in main.ts strict mode.
    host.onStream((target, stream) => {
      openedTargets.push(target);
      if (target === "proxy" || target === "share" || target.startsWith("tproxy:")) {
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
      VALENCEBOX_TPROXY_PORT: String(tproxyRelayPort),
      VALENCEBOX_DNS_PORT: String(dnsPort),
      VALENCEBOX_TPROXY_DEFAULT_DST: "198.18.0.2:443",
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

  // ---- 5. Fake-DNS (UDP) + transparent proxy listener (`tproxy:<host>:<port>`) ----
  {
    const buildDnsQuery = (id: number, name: string, qtype: number): Buffer => {
      const labels = name.split(".").map((l) => {
        const b = Buffer.from(l, "ascii");
        return Buffer.concat([Buffer.from([b.length]), b]);
      });
      const header = Buffer.alloc(12);
      header.writeUInt16BE(id, 0);
      header.writeUInt16BE(0x0100, 2); // RD=1
      header.writeUInt16BE(1, 4); // QDCOUNT=1
      const tail = Buffer.alloc(5);
      tail.writeUInt8(0, 0);
      tail.writeUInt16BE(qtype, 1);
      tail.writeUInt16BE(1, 3); // QCLASS=IN
      return Buffer.concat([header, ...labels, tail]);
    };

    const udpQuery = (pkt: Buffer): Promise<Buffer> =>
      new Promise((res, rej) => {
        const u = dgram.createSocket("udp4");
        const t = setTimeout(() => { u.close(); rej(new Error("dns timeout")); }, 3000);
        u.once("message", (msg) => { clearTimeout(t); u.close(); res(msg); });
        u.send(pkt, dnsPort, "127.0.0.1");
      });

    // Query A record for transparent.example → expects 198.18.0.2
    const respA = await udpQuery(buildDnsQuery(0xbeef, "Transparent.Example", 1));
    assert(respA.readUInt16BE(0) === 0xbeef, "DNS transaction ID matches");
    assert(respA.readUInt16BE(6) === 1, "DNS A response has 1 answer");
    const ipBytes = Array.from(respA.subarray(respA.length - 4));
    assert(
      JSON.stringify(ipBytes) === JSON.stringify([198, 18, 0, 2]),
      `Fake-DNS returned 198.18.0.2 (got ${ipBytes.join(".")})`,
    );

    // Query AAAA record → expects NOERROR with 0 answers (NODATA)
    const respAAAA = await udpQuery(buildDnsQuery(0xcafe, "transparent.example", 28));
    assert((respAAAA[3] & 0x0f) === 0, "DNS AAAA RCODE is NOERROR");
    assert(respAAAA.readUInt16BE(6) === 0, "DNS AAAA ANCOUNT is 0 (NODATA)");

    // Connect to tproxy listener (VALENCEBOX_TPROXY_DEFAULT_DST=198.18.0.2:443)
    // Daemon maps 198.18.0.2 → transparent.example and opens "tproxy:transparent.example:443"
    const s = net.createConnection(tproxyRelayPort, "127.0.0.1");
    await new Promise<void>((res) => s.once("connect", res));
    s.write("ping-tproxy");
    const got = await new Promise<string>((res) => {
      let buf = "";
      s.on("data", (c: Buffer) => { buf += c.toString(); if (buf.includes("ping-tproxy")) res(buf); });
    });
    assert(got.includes("ping-tproxy"), "tproxy relay roundtrip");
    assert(
      openedTargets.includes("tproxy:transparent.example:443"),
      `daemon translated Fake-DNS IP to tproxy:transparent.example:443 (got ${JSON.stringify(openedTargets)})`,
    );
    s.destroy();
    console.log("✓ Fake-DNS (A/AAAA) + tproxy listener maps 198.18.0.2 → tproxy:transparent.example:443");
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
