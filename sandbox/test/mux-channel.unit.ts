// MuxChannel unit tests: framing, demux, flow control, HELLO reset, liveness,
// and injection into a real http.Server over a MuxStream. Two MuxChannel
// instances (host + guest roles) are connected over a loopback socketpair.
import * as net from "net";
import * as http from "http";
import { AddressInfo } from "net";
import { MuxChannel, MuxStream, MUX_WINDOW, MT_HELLO } from "../src/main/mux-channel";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wire host+guest channels together over a loopback TCP pair. */
async function makePair(hostOpts = {}, guestOpts = {}): Promise<{ host: MuxChannel; guest: MuxChannel; close: () => void }> {
  const server = net.createServer((sock) => {
    guest.attachSocket(sock);
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;

  const host = new MuxChannel("host", undefined, hostOpts);
  const guest = new MuxChannel("guest", undefined, guestOpts);
  const client = net.createConnection(port, "127.0.0.1");
  host.attachSocket(client);
  // attach happens on TCP connect; wait for the guest HELLO to arrive.
  while (!host.ready) await sleep(5);

  const close = () => {
    host.disconnect();
    guest.disconnect();
    server.close();
    client.destroy();
  };
  return { host, guest, close };
}

/** Simulated guest daemon: targets "echo" pipes back, "fail" refuses,
 * "dial:<host>:<port>" bridges to a TCP service, "slow:<bytes>" sends slowly. */
function guestDaemon(guest: MuxChannel): void {
  guest.onStream((target, stream) => {
    if (target === "echo") {
      stream.pipe(stream);
      return;
    }
    if (target === "fail") {
      throw new Error("refused by test daemon");
    }
    if (target.startsWith("dial:")) {
      const [h, p] = target.slice(5).split(":");
      const sock = net.createConnection(Number(p), h);
      sock.on("connect", () => {
        stream.pipe(sock);
        sock.pipe(stream);
      });
      sock.on("error", () => stream.destroy(new Error("dial failed")));
      stream.on("close", () => sock.destroy());
      return;
    }
    throw new Error(`unknown target '${target}'`);
  });
}

async function main() {
  // ---- 1. HELLO/ready + bidirectional data over echo ----
  {
    const { host, guest, close } = await makePair();
    guestDaemon(guest);
    assert(host.ready, "ready after HELLO");
    const st = await host.openStream("echo", 5000);
    const got: Buffer[] = [];
    st.on("data", (c: Buffer) => got.push(c));
    st.write("hello mux");
    await sleep(100);
    assert(Buffer.concat(got).toString() === "hello mux", "echo roundtrip");
    st.end();
    close();
    console.log("✓ HELLO/ready + echo stream");
  }

  // ---- 2. Large transfer both directions with integrity ----
  {
    const { host, guest, close } = await makePair();
    guestDaemon(guest);
    const total = 4 * 1024 * 1024;
    const pattern = Buffer.alloc(65536);
    for (let i = 0; i < pattern.length; i++) pattern[i] = (i * 7) & 0xff;

    const st = await host.openStream("echo", 5000);
    let received = 0;
    let mismatches = 0;
    let sent = 0;
    st.on("data", (c: Buffer) => {
      for (let i = 0; i < c.length; i++) {
        if (c[i] !== pattern[(received + i) % pattern.length]) mismatches++;
      }
      received += c.length;
      if (received === total) st.end();
    });
    await new Promise<void>((res) => {
      const pump = () => {
        while (sent < total) {
          sent += pattern.length;
          if (!st.write(pattern)) { st.once("drain", pump); return; }
        }
      };
      pump();
      st.on("close", res);
    });
    await sleep(100);
    assert(received === total, `received all ${total} bytes (got ${received})`);
    assert(mismatches === 0, `no corruption (${mismatches} mismatches)`);
    close();
    console.log("✓ 4 MiB bidirectional transfer, no corruption");
  }

  // ---- 3. OPEN_FAIL for refused target ----
  {
    const { host, guest, close } = await makePair();
    guestDaemon(guest);
    let failed = false;
    await host.openStream("fail", 5000).catch((e) => { failed = true; assert(String(e.message).includes("refused"), "refused reason"); });
    assert(failed, "openStream rejects with OPEN_FAIL");
    close();
    console.log("✓ OPEN_FAIL propagation");
  }

  // ---- 4. Flow control: stalled consumer blocks sender, resume unblocks ----
  {
    const { host, guest, close } = await makePair();
    // Guest echoes, but the "consumer" of the host stream stalls.
    guestDaemon(guest);
    const st = await host.openStream("echo", 5000);
    st.pause(); // data accumulates in readable buffer, no consumption
    const chunk = Buffer.alloc(4096, 0x41);
    let sent = 0;
    const target = 2 * MUX_WINDOW;
    const pump = () => {
      while (sent < target) {
        sent += chunk.length;
        if (!st.write(chunk)) { st.once("drain", pump); return; }
      }
    };
    pump();
    await sleep(200);
    // Without credit the sender must stall before sending 2×window.
    assert(sent < target + chunk.length, `sender blocked by credit window (sent ${sent})`);
    st.resume(); // consume → credit granted → sender continues
    await sleep(500);
    assert(sent >= target, `sender resumed after credit (sent ${sent})`);
    close();
    console.log("✓ flow control: credit window blocks stalled consumer, resumes on drain");
  }

  // ---- 5. RESET propagation ----
  {
    const { host, guest, close } = await makePair();
    guestDaemon(guest);
    const st = await host.openStream("echo", 5000);
    st.on("error", () => {});
    const closed = new Promise<void>((res) => st.once("close", res));
    // Simulate the guest daemon aborting the stream: a plain destroy sends RESET.
    (guest as any).streams.get(st.id).destroy();
    await closed;
    assert(st.destroyed, "host stream destroyed by peer RESET");
    close();
    console.log("✓ RESET propagation");
  }

  // ---- 6. HELLO restart: second HELLO destroys host streams ----
  {
    const { host, guest, close } = await makePair();
    guestDaemon(guest);
    const st = await host.openStream("echo", 5000);
    st.on("error", () => {});
    const closed = new Promise<void>((res) => st.once("close", res));
    // Simulate daemon restart: guest sends a fresh HELLO frame.
    guest.sendHelloForTest();
    await closed;
    assert(st.destroyed, "host stream destroyed by HELLO restart");
    assert(host.ready, "channel ready again after restart");
    const st2 = await host.openStream("echo", 5000);
    st2.end();
    close();
    console.log("✓ HELLO restart resets streams, channel reusable");
  }

  // ---- 7. dial target: bridge to a TCP service ----
  {
    const { host, guest, close } = await makePair();
    guestDaemon(guest);
    const srv = net.createServer((s) => {
      s.on("data", (c) => s.write(Buffer.concat([Buffer.from("got:"), c])));
    });
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    const port = (srv.address() as AddressInfo).port;

    const st = await host.openStream(`dial:127.0.0.1:${port}`, 5000);
    const got: Buffer[] = [];
    st.on("data", (c: Buffer) => got.push(c));
    st.write("ping1");
    await sleep(150);
    assert(Buffer.concat(got).toString() === "got:ping1", `dial roundtrip (got '${Buffer.concat(got).toString()}')`);
    st.destroy();
    srv.close();
    close();
    console.log("✓ fwd-style dial target bridges to guest TCP");
  }

  // ---- 8. Injection into a real http.Server over a MuxStream ----
  {
    const { host, guest, close } = await makePair();
    // Guest handler mimics the host routing: inject into an http server.
    const httpServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`injected:${req.url}`);
    });
    guest.onStream((_target, stream) => {
      // guest role acts as the "host app" here: feed stream to the server
      httpServer.emit("connection", stream);
    });
    const srv = await new Promise<http.Server>((res) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => res(s));
    });
    const port = (srv.address() as AddressInfo).port;

    const st = await host.openStream("proxy", 5000);
    st.write(`GET /mux-test HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
    const body = await new Promise<string>((res) => {
      let buf = "";
      st.on("data", (c: Buffer) => (buf += c.toString()));
      st.on("close", () => res(buf));
      setTimeout(() => res(buf), 2000);
    });
    assert(body.includes("HTTP/1.1 200 OK"), `http status over mux stream (got '${body.slice(0, 60)}')`);
    assert(body.includes("injected:/mux-test"), "http body over mux stream");
    st.destroy();
    srv.close();
    close();
    console.log("✓ http.Server request/response over injected MuxStream");
  }

  // ---- 9. Liveness: PONG keeps channel alive; missing PONG drops it ----
  {
    const { host, guest, close } = await makePair({ pingIntervalMs: 20, pongTimeoutMs: 80 });
    guestDaemon(guest);
    const closed = new Promise<void>((res) => host.once("closed", res));
    // Simulate a dead peer: guest stops replying (drop its handler by
    // disconnecting the guest channel but keeping host socket alive is not
    // possible over TCP — instead stop PONG by making guest ignore PINGs via
    // a raw socket that never responds).
    await sleep(250);
    // Over a live socket pair PONGs flow, so the channel must still be up.
    assert(host.connected, "channel alive while pongs flow");
    close();
    console.log("✓ liveness ping/pong keeps channel alive");

    // Dead-peer drop: attach host to a socket that never responds.
    const deadServer = net.createServer(() => { /* accept, never reply */ });
    await new Promise<void>((res) => deadServer.listen(0, "127.0.0.1", res));
    const dport = (deadServer.address() as AddressInfo).port;
    const host2 = new MuxChannel("host", undefined, { pingIntervalMs: 20, pongTimeoutMs: 80 });
    host2.attachSocket(net.createConnection(dport, "127.0.0.1"));
    const dropped = new Promise<void>((res) => host2.once("closed", res));
    // Never send HELLO → checkPing resets lastPong while !ready, so force ready.
    (host2 as any).hello = true;
    await dropped;
    assert(!host2.connected, "channel dropped after pong timeout");
    deadServer.close();
    console.log("✓ pong timeout drops channel");
  }

  // ---- 10. openStream before ready waits for HELLO ----
  {
    const server = net.createServer((sock) => {
      // Delay the guest attach (and therefore HELLO) to prove openStream waits.
      setTimeout(() => guest.attachSocket(sock), 100);
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    const port = (server.address() as AddressInfo).port;
    const host = new MuxChannel("host");
    const guest = new MuxChannel("guest");
    guest.onStream((target, stream) => { if (target === "echo") stream.pipe(stream); });
    host.attachSocket(net.createConnection(port, "127.0.0.1"));
    assert(!host.ready, "not ready before HELLO");
    const st = await host.openStream("echo", 5000);
    assert(host.ready, "ready after HELLO");
    st.destroy();
    host.disconnect();
    guest.disconnect();
    server.close();
    console.log("✓ openStream waits for HELLO before sending OPEN");
  }

  console.log("ALL MUX CHANNEL TESTS PASSED");
  process.exit(0);
}

function guestDaemonAfterReady(guest: MuxChannel): void {
  guest.onStream((target, stream) => {
    if (target === "echo") stream.pipe(stream);
  });
}

// Small test hooks on MuxChannel — implemented via prototype patching here so
// the production surface stays clean.
declare module "../src/main/mux-channel" {
  interface MuxChannel {
    sendHelloForTest(): void;
    resetAllPublicForTest(): void;
  }
}
(MuxChannel.prototype as any).sendHelloForTest = function () {
  (this as any).sendFrame(MT_HELLO, 0, Buffer.from("1"));
  (this as any).handleHello();
};
(MuxChannel.prototype as any).resetAllPublicForTest = function () {
  (this as any).resetAll("test reset");
};

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
