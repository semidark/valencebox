import * as assert from "node:assert/strict";
import * as net from "net";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { once } from "events";
import { spawn } from "child_process";
import { QmpClient } from "../src/main/qmp";
import { QemuProcess } from "../src/main/qemu";
import { ShutdownCoordinator, withTimeout } from "../src/main/shutdown";
import { cleanupRuntimeDir, resolveWorkspaceDir } from "../src/main/workspace";
import { EgressProxy } from "../src/main/egress-proxy";
import { HttpShare } from "../src/main/http-share";

async function fakeQmp(test: (client: QmpClient, peer: net.Socket) => Promise<void>, greeting = true) {
  const peers = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    if (greeting) socket.write('{"QMP":{"version":{}}}\n');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new QmpClient();
  try {
    const connection = once(server, "connection");
    const connecting = client.connect((server.address() as net.AddressInfo).port, "127.0.0.1", 100);
    // Attach a rejection handler before a deliberately missing greeting times out.
    const connected = connecting.then(() => null, (err: Error) => err);
    const [peer] = await connection;
    if (greeting) assert.equal(await connected, null);
    else {
      const err = await connected;
      assert.match(err!.message, /greeting timeout/);
      assert.equal(client.connected, false);
    }
    await test(client, peer);
  } finally {
    client.disconnect();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testQmpFailures() {
  for (const mode of ["close", "disconnect", "timeout"] as const) {
    await fakeQmp(async (client, peer) => {
      const requests = once(peer, "data");
      const pending = client.execute("query-status", undefined, 100);
      const queued = client.execute("query-balloon", undefined, 500);
      const results = Promise.allSettled([pending, queued]);
      await requests;
      if (mode === "close") peer.destroy();
      if (mode === "disconnect") client.disconnect();
      const settled = await withTimeout(results, 1000, "QMP rejection");
      assert.equal(settled.filter((r) => r.status === "rejected").length, 2);
      assert.equal(client.connected, false);
    });
  }
  await fakeQmp(async (client, peer) => {
    const requests = once(peer, "data");
    let resolved = false;
    const command = client.execute("query-status").then((result) => { resolved = true; return result; });
    const [data] = await requests;
    const request = JSON.parse(data.toString());
    peer.write(JSON.stringify({ return: "wrong", id: "unrelated" }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resolved, false);
    peer.write(JSON.stringify({ return: "correct", id: request.id }) + "\n");
    assert.equal(await command, "correct");
  });
  await fakeQmp(async () => {}, false);
  console.log("✓ QMP: pending/queued rejection, command/greeting deadlines, reply IDs");
}

async function testCoordinator() {
  const order: string[] = [];
  let exits = 0;
  const shutdown = new ShutdownCoordinator([
    { name: "stalled cleanup", timeoutMs: 20, stop: () => new Promise(() => {}) },
    { name: "failed stop", timeoutMs: 100, stop: async () => { throw new Error("fixture failure"); } },
    { name: "remaining resource", timeoutMs: 100, stop: async () => { order.push("stopped"); } },
  ], (code) => { assert.equal(code, 1); exits++; }, () => assert.fail("unexpected watchdog"), 1000);
  const first = shutdown.request();
  assert.equal(shutdown.request(), first);
  await first;
  await shutdown.request();
  assert.deepEqual(order, ["stopped"]);
  assert.equal(exits, 1);

  let forced = false;
  const watchdog = new ShutdownCoordinator([
    { name: "stuck VM", timeoutMs: 500, stop: () => new Promise(() => {}) },
  ], (code) => { assert.equal(code, 1); exits++; }, () => { forced = true; }, 20);
  await watchdog.request();
  assert.equal(forced, true);
  assert.equal(exits, 2);
  console.log("✓ shutdown: repeated requests, failed/stalled stages, overall watchdog");
}

async function testQemuStop() {
  // Real signal-exited child: Node leaves exitCode null and sets signalCode.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await once(child, "spawn");
  child.kill("SIGTERM");
  await once(child, "exit");
  const qemu = new QemuProcess();
  (qemu as any).proc = child;
  assert.equal(qemu.running, false);
  const first = qemu.stop(100);
  assert.equal(qemu.stop(100), first);
  await withTimeout(first, 500, "signal-exited QEMU stop");

  // A real live child plus a QMP endpoint that never replies must reach SIGTERM.
  await fakeQmp(async (client) => {
    const liveChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await once(liveChild, "spawn");
    const liveQemu = new QemuProcess();
    (liveQemu as any).proc = liveChild;
    (liveQemu as any)._qmp = client;
    try {
      await withTimeout(liveQemu.stop(100), 1000, "QEMU with unresponsive QMP");
      assert.equal(liveQemu.running, false);
      assert.equal(client.connected, false);
    } finally {
      if (liveChild.exitCode === null && liveChild.signalCode === null) liveChild.kill("SIGKILL");
    }
  });
  console.log("✓ QEMU: signal exits, idempotent stop, unresponsive QMP fallback");
}

async function testWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-shutdown-workspace-"));
  const previous = process.env.WORKSPACE_DIR;
  delete process.env.WORKSPACE_DIR;
  try {
    const workspace = resolveWorkspaceDir({}, dir);
    fs.writeFileSync(path.join(workspace, "project.txt"), "keep");
    assert.equal(resolveWorkspaceDir({}, dir), workspace);
    const runtime = fs.mkdtempSync(path.join(dir, "qemu-"));
    fs.writeFileSync(path.join(runtime, "share-config.json"), "runtime only");
    await cleanupRuntimeDir(runtime);
    assert.equal(fs.existsSync(runtime), false);
    assert.equal(fs.readFileSync(path.join(workspace, "project.txt"), "utf8"), "keep");
    const legacy = fs.mkdtempSync(path.join(dir, "qemu-"));
    fs.mkdirSync(path.join(legacy, "workspace"));
    fs.writeFileSync(path.join(legacy, "workspace", "project.txt"), "legacy");
    fs.writeFileSync(path.join(legacy, "mitm-ca.pem"), "runtime only");
    await cleanupRuntimeDir(legacy);
    assert.equal(fs.readFileSync(path.join(legacy, "workspace", "project.txt"), "utf8"), "legacy");
    assert.equal(fs.existsSync(path.join(legacy, "mitm-ca.pem")), false);
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("✓ cleanup: persistent and legacy workspaces retained");
}

async function testServerStops() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-shutdown-sockets-"));
  const peers = new Set<net.Socket>();
  const upstream = net.createServer((socket) => {
    peers.add(socket);
    socket.on("error", () => {}); // Forced shutdown may reset the peer.
    socket.on("close", () => peers.delete(socket));
  });
  const proxy = new EgressProxy({
    policy: "none", allowHosts: [], denyHosts: [], allowPorts: [], allowAll: true,
    enableMitm: false, secrets: [], port: 0, authToken: "",
    maxConnections: 256, rateLimitPerMin: 0, listenHost: "127.0.0.1",
  });
  const share = new HttpShare();
  let tunnel: net.Socket | undefined;
  let upload: net.Socket | undefined;
  let forward: http.ClientRequest | undefined;
  try {
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const port = (upstream.address() as net.AddressInfo).port;
    await proxy.start();
    await share.start(dir);
    tunnel = net.connect(proxy.port, "127.0.0.1");
    tunnel.on("error", () => {});
    await once(tunnel, "connect");
    const response = once(tunnel, "data");
    tunnel.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    assert.match((await response)[0].toString(), /200 Connection Established/);
    const tunnelClosed = new Promise<void>((resolve) => tunnel!.once("close", () => resolve()));
    tunnel.resume();

    const acceptedForward = once(upstream, "connection");
    forward = http.request({ host: "127.0.0.1", port: proxy.port,
      path: `http://127.0.0.1:${port}/stream`, headers: { Host: `127.0.0.1:${port}` } });
    forward.on("error", () => {});
    forward.end();
    await acceptedForward;
    // The expected ECONNRESET must not reject the close-event wait.
    const forwardClosed = new Promise<void>((resolve) => forward!.once("close", resolve));

    // Incomplete headers would otherwise keep server.close waiting.
    upload = net.connect(share.port, "127.0.0.1");
    upload.on("error", () => {});
    await once(upload, "connect");
    upload.write("PUT /pending HTTP/1.1\r\nHost: localhost\r\n");
    const uploadClosed = new Promise<void>((resolve) => upload!.once("close", () => resolve()));
    upload.resume();
    const stopping = proxy.stop();
    assert.equal(proxy.stop(), stopping);
    const stoppingShare = share.stop();
    assert.equal(share.stop(), stoppingShare);
    await withTimeout(Promise.all([stopping, stoppingShare, tunnelClosed, forwardClosed, uploadClosed]), 1000, "server stops");
    // Let the remote end observe FIN/close before checking upstream release.
    for (const peer of peers) peer.resume();
    await withTimeout(Promise.all([...peers].map((peer) => new Promise<void>((resolve) => peer.once("close", () => resolve())))), 1000, "upstream release");
    assert.equal(proxy.getStats().activeConnections, 0);
  } finally {
    tunnel?.destroy();
    upload?.destroy();
    forward?.destroy();
    await proxy.stop();
    await share.stop();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("✓ servers: live CONNECT, upstream HTTP, incomplete WebDAV, repeated stop");
}

async function main() {
  await testQmpFailures();
  await testCoordinator();
  await testQemuStop();
  await testWorkspace();
  await testServerStops();
  console.log("ALL SHUTDOWN TESTS PASSED");
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
