// EgressProxy injection + upstream chaining tests:
// - injectConnection: CONNECT + auth over an injected socket
// - policy still enforced on injected streams
// - upstream chaining: CONNECT tunneled through a mock upstream proxy (with auth)
// - plain-HTTP forward through the upstream (absolute-form)
// - policy checked BEFORE chaining (disallowed host never reaches upstream)
import * as net from "net";
import * as http from "http";
import { AddressInfo } from "net";
import { EgressProxy } from "../src/main/egress-proxy";
import { EgressRuntimeConfig } from "../src/config";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cfg(overrides: Partial<EgressRuntimeConfig> = {}): EgressRuntimeConfig {
  return {
    policy: "none",
    allowHosts: [],
    denyHosts: [],
    allowPorts: [],
    allowAll: false,
    enableMitm: false,
    secrets: [],
    port: 0,
    authToken: "tok123",
    maxConnections: 64,
    rateLimitPerMin: 0,
    listenHost: "127.0.0.1",
    ...overrides,
  };
}

/** Echo server on a random loopback port. */
async function echoServer(): Promise<number> {
  const srv = net.createServer((s) => s.pipe(s));
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  const port = (srv.address() as AddressInfo).port;
  (srv as any)._port = port;
  (srv as any).closeLater = () => srv.close();
  return port;
}

/** Minimal upstream CONNECT proxy: relays to the requested target, counts CONNECTs. */
async function mockUpstreamProxy(opts: { requireAuth?: string } = {}): Promise<{ port: number; connectCount: () => number; close: () => void }> {
  let connects = 0;
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", function onData(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      sock.removeListener("data", onData);
      const reqLine = buf.subarray(0, buf.indexOf("\r\n")).toString();
      const m = reqLine.match(/^CONNECT ([^\s]+) HTTP/);
      if (!m) {
        sock.write("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        sock.destroy();
        return;
      }
      const auth = /proxy-authorization:\s*(.+)/i.exec(buf.subarray(0, idx).toString())?.[1]?.trim();
      if (opts.requireAuth && auth !== opts.requireAuth) {
        sock.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        sock.destroy();
        return;
      }
      connects++;
      const [host, portStr] = m[1].split(":");
      const upstreamSock = net.createConnection(Number(portStr), host, () => {
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = buf.subarray(idx + 4);
        if (rest.length > 0) upstreamSock.write(rest);
        sock.pipe(upstreamSock);
        upstreamSock.pipe(sock);
      });
      upstreamSock.on("error", () => sock.destroy());
      sock.on("error", () => upstreamSock.destroy());
    });
  });
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
  const port = (srv.address() as AddressInfo).port;
  return { port, connectCount: () => connects, close: () => srv.close() };
}

async function main() {
  // ---- 1. injectConnection: CONNECT with token auth over an injected socket ----
  {
    const proxy = new EgressProxy(cfg());
    await proxy.start();
    const target = await echoServer();

    // A socket pair: one end is fed to the proxy as an injected connection.
    const sockSrv = net.createServer((s) => proxy.injectConnection(s));
    await new Promise<void>((res) => sockSrv.listen(0, "127.0.0.1", res));
    const sp = (sockSrv.address() as AddressInfo).port;
    const s = net.createConnection(sp, "127.0.0.1");
    const auth = "Basic " + Buffer.from(`valencebox:tok123`).toString("base64");
    s.write(`CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    const resp = await new Promise<string>((res) => {
      let buf = "";
      s.on("data", (c: Buffer) => {
        buf += c.toString();
        if (buf.includes("200 Connection Established")) res(buf);
      });
    });
    assert(resp.includes("200 Connection Established"), `CONNECT over injected socket (got '${resp.slice(0, 60)}')`);
    s.write("ping-inject");
    const echoed = await new Promise<string>((res) => {
      let buf = "";
      s.on("data", (c: Buffer) => { buf += c.toString(); if (buf.includes("ping-inject")) res(buf); });
    });
    assert(echoed.includes("ping-inject"), "tunnel relays over injected socket");
    s.destroy();
    await proxy.stop();
    sockSrv.close();
    console.log("✓ injectConnection: CONNECT + auth over injected stream");
  }

  // ---- 2. Policy enforced on injected streams (denylist) ----
  {
    const proxy = new EgressProxy(cfg({ policy: "denylist", denyHosts: ["evil.example"] }));
    await proxy.start();
    const sockSrv = net.createServer((s) => proxy.injectConnection(s));
    await new Promise<void>((res) => sockSrv.listen(0, "127.0.0.1", res));
    const sp = (sockSrv.address() as AddressInfo).port;
    const s = net.createConnection(sp, "127.0.0.1");
    const auth = "Basic " + Buffer.from("valencebox:tok123").toString("base64");
    s.write(`CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    const resp = await new Promise<string>((res) => {
      let buf = "";
      s.on("data", (c: Buffer) => { buf += c.toString(); if (buf.includes("\r\n\r\n") || buf.length > 200) res(buf); });
    });
    assert(resp.includes("403 Forbidden"), `denied host blocked over injected stream (got '${resp.slice(0, 60)}')`);
    s.destroy();
    sockSrv.close();
    await proxy.stop();
    console.log("✓ policy enforced on injected streams");
  }

  // ---- 3. Upstream chaining: CONNECT tunneled through upstream with auth ----
  {
    const upstream = await mockUpstreamProxy({ requireAuth: "Basic " + Buffer.from("corp:p@ss").toString("base64") });
    const proxy = new EgressProxy(cfg({
      upstreamProxy: `http://corp:p%40ss@127.0.0.1:${upstream.port}`,
    }));
    await proxy.start();
    const target = await echoServer();

    const auth = "Basic " + Buffer.from("valencebox:tok123").toString("base64");
    const s = net.createConnection(proxy.port, "127.0.0.1");
    s.write(`CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    await new Promise<string>((res) => {
      let buf = "";
      s.on("data", (c: Buffer) => { buf += c.toString(); if (buf.includes("200 Connection Established")) res(buf); });
    });
    s.write("chained-hello");
    const echoed = await new Promise<string>((res) => {
      let buf = "";
      s.on("data", (c: Buffer) => { buf += c.toString(); if (buf.includes("chained-hello")) res(buf); });
    });
    assert(echoed.includes("chained-hello"), "CONNECT tunnel through upstream relays");
    assert(upstream.connectCount() === 1, `upstream saw exactly one CONNECT (got ${upstream.connectCount()})`);
    s.destroy();
    await proxy.stop();
    upstream.close();
    console.log("✓ upstream chaining: CONNECT through upstream proxy with auth");
  }

  // ---- 4. Policy checked BEFORE chaining ----
  {
    const upstream = await mockUpstreamProxy({});
    const proxy = new EgressProxy(cfg({
      policy: "allowlist",
      allowHosts: ["good.example"],
      upstreamProxy: `http://127.0.0.1:${upstream.port}`,
    }));
    await proxy.start();
    const auth = "Basic " + Buffer.from("valencebox:tok123").toString("base64");
    const s = net.createConnection(proxy.port, "127.0.0.1");
    s.write(`CONNECT bad.example:443 HTTP/1.1\r\nHost: bad.example:443\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    const resp = await new Promise<string>((res) => {
      let buf = "";
      s.on("data", (c: Buffer) => { buf += c.toString(); if (buf.includes("\r\n\r\n")) res(buf); });
    });
    assert(resp.includes("403"), `disallowed host refused before chaining (got '${resp.slice(0, 40)}')`);
    await sleep(100);
    assert(upstream.connectCount() === 0, "upstream never contacted for denied host");
    s.destroy();
    await proxy.stop();
    upstream.close();
    console.log("✓ policy-before-chain: denied host never reaches upstream");
  }

  // ---- 5. Plain-HTTP forward through upstream (absolute-form) ----
  {
    let sawAbsolute = false;
    const upstreamSrv = http.createServer((req, res) => {
      // As an HTTP proxy, the upstream receives absolute-form URLs.
      sawAbsolute = req.url!.startsWith("http://");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("upstream-body");
    });
    await new Promise<void>((res) => upstreamSrv.listen(0, "127.0.0.1", res));
    const upstreamPort = (upstreamSrv.address() as AddressInfo).port;

    const proxy = new EgressProxy(cfg({ upstreamProxy: `http://127.0.0.1:${upstreamPort}` }));
    await proxy.start();

    const auth = "Basic " + Buffer.from("valencebox:tok123").toString("base64");
    const s = net.createConnection(proxy.port, "127.0.0.1");
    s.write(`GET http://example.com/test HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: ${auth}\r\n\r\n`);
    const resp = await new Promise<string>((res) => {
      let buf = "";
      s.on("data", (c: Buffer) => { buf += c.toString(); if (buf.includes("upstream-body")) res(buf); });
      setTimeout(() => res(buf), 3000);
    });
    assert(resp.includes("upstream-body"), `plain HTTP forwarded through upstream (got '${resp.slice(0, 60)}')`);
    assert(sawAbsolute, "upstream received absolute-form URL");
    s.destroy();
    await proxy.stop();
    upstreamSrv.close();
    console.log("✓ plain-HTTP forward through upstream (absolute-form)");
  }

  console.log("ALL EGRESS INJECTION/CHAINING TESTS PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
