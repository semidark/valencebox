import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as tls from "tls";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { EgressProxy, ensureMitmCa, ensureLeafCertificate, MitmCa } from "../src/main/egress-proxy";
import { EgressRuntimeConfig, EgressConfig } from "../src/config";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEq(actual: any, expected: any, msg: string): void {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg} — expected '${expected}', got '${actual}'`);
  }
}

/**
 * Wait until a condition becomes true, polling every 50ms.
 */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!cond()) throw new Error("waitFor timeout");
}

// ---- Helpers ----

function createMitmCa(tempDir: string): MitmCa {
  const caDir = path.join(tempDir, "ca");
  return ensureMitmCa(caDir);
}

/**
 * Generate a self-signed cert for localhost inside a caller-managed tmpDir.
 * The caller is responsible for removing tmpDir when done.
 */
function generateTestKeyPair(tmpDir: string): { key: string; cert: string } {
  const { spawnSync } = require("child_process") as typeof import("child_process");
  const keyFile = path.join(tmpDir, "key.pem");
  const certFile = path.join(tmpDir, "cert.pem");

  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  fs.writeFileSync(keyFile, privateKey);

  const result = spawnSync("openssl", [
    "req", "-x509", "-new", "-nodes",
    "-key", keyFile,
    "-sha256",
    "-days", "1",
    "-subj", "/CN=localhost/O=Test",
  ], { encoding: "utf-8", timeout: 5000 });

  if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr}`);
  fs.writeFileSync(certFile, result.stdout);

  return { key: keyFile, cert: certFile };
}

// ---- MITM CA + leaf cert generation ----

async function testMitmCertGeneration() {
  const tmpDir = fs.mkdtempSync("mitm-test-");
  try {
    const ca = createMitmCa(tmpDir);
    assert(fs.existsSync(ca.cert), "CA cert file exists");
    assert(fs.existsSync(ca.key), "CA key file exists");

    // Generate a leaf cert for a test host.
    const certCacheDir = path.join(tmpDir, "certs");
    const leaf = ensureLeafCertificate("test.example.com", ca, certCacheDir);
    assert(fs.existsSync(leaf.cert), "leaf cert file exists");
    assert(fs.existsSync(leaf.key), "leaf key file exists");

    // Cached reuse: calling again should return the same files.
    const leaf2 = ensureLeafCertificate("test.example.com", ca, certCacheDir);
    assertEq(leaf.cert, leaf2.cert, "leaf cert cache hit");
    assertEq(leaf.key, leaf2.key, "leaf key cache hit");

    console.log("✓ MITM CA and leaf cert generation");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---- Auth token verification ----

/**
 * Send an HTTP request to the proxy (HTTP forward mode) and return the status.
 */
function proxyRequest(port: number, host: string, authHeader?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Host": host, "Connection": "close" };
    if (authHeader) headers["Proxy-Authorization"] = authHeader;
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/",
      method: "GET",
      headers,
    }, (res) => {
      // Drain the response to avoid hanging.
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on("error", reject);
    req.end();
    setTimeout(() => { req.destroy(); reject(new Error("timeout")); }, 3000);
  });
}

async function testAuthTokenValidation() {
  const config: EgressRuntimeConfig = {
    policy: "none", allowHosts: [], denyHosts: [],
    allowPorts: [80, 443], allowAll: true, enableMitm: false,
    secrets: [], port: 0, authToken: "test-token",
  };
  const proxy = new EgressProxy(config);

  try {
    await proxy.start();
    const port = proxy.port;
    const goodAuth = "Basic " + Buffer.from("psbx:test-token").toString("base64");
    const badAuth = "Basic " + Buffer.from("user:wrong-token").toString("base64");

    // Valid auth → the request passes auth and the proxy processes it
    // (either 502 for a failed forward or 200 for a successful one — either
    // means auth didn't block it).
    const authOk = await proxyRequest(port, "example.com", goodAuth);
    assert(authOk !== 407, `authenticated request was not blocked by auth (got ${authOk})`);

    // Missing auth → 407.
    const missing = await proxyRequest(port, "example.com");
    assertEq(missing, 407, "missing auth returns 407");

    // Invalid token → 407.
    const invalid = await proxyRequest(port, "example.com", badAuth);
    assertEq(invalid, 407, "invalid token returns 407");

    console.log("✓ auth token validation");
  } finally {
    await proxy.stop();
  }
}

// ---- Policy enforcement on CONNECT ----

async function testConnectPolicyEnforcement() {
  const config: EgressRuntimeConfig = {
    policy: "allowlist", allowHosts: ["allowed.example.com"], denyHosts: [],
    allowPorts: [80, 443], allowAll: false, enableMitm: false,
    secrets: [], port: 0, authToken: "test",
  };
  const proxy = new EgressProxy(config);

  try {
    await proxy.start();
    const port = proxy.port;

    const auth = "Basic " + Buffer.from("psbx:test").toString("base64");

    // Blocked host → 403.
    {
      const sock = net.connect(port, "127.0.0.1");
      sock.write(`CONNECT blocked.example.com:443 HTTP/1.1\r\nHost: blocked.example.com:443\r\nProxy-Authorization: ${auth}\r\n\r\n`);

      const data = await new Promise<Buffer>((resolve) => {
        sock.once("data", resolve);
        setTimeout(() => sock.destroy(), 2000);
      });

      const response = data.toString("utf-8");
      assert(response.includes("403"), `blocked host returns 403: ${response.slice(0, 50)}`);
      sock.destroy();
    }

    // Allowed host → policy passes (upstream will fail with 502, but not 403).
    {
      const sock = net.connect(port, "127.0.0.1");
      sock.write(`CONNECT allowed.example.com:443 HTTP/1.1\r\nHost: allowed.example.com:443\r\nProxy-Authorization: ${auth}\r\n\r\n`);

      const data = await new Promise<Buffer>((resolve) => {
        sock.once("data", resolve);
        setTimeout(() => sock.destroy(), 2000);
      });

      const response = data.toString("utf-8");
      assert(!response.includes("403"), `allowed host is not blocked by policy: ${response.slice(0, 50)}`);
      sock.destroy();
    }

    console.log("✓ CONNECT policy enforcement");
  } finally {
    await proxy.stop();
  }
}

// ---- MITM secret injection end-to-end ----

async function testMitmSecretInjection() {
  const tmpDir = fs.mkdtempSync("mitm-test-");
  let upstreamServer: https.Server | undefined;
  let proxy: EgressProxy | undefined;

  try {
    // Create a self-signed cert for the upstream server inside tmpDir.
    const upstreamDir = path.join(tmpDir, "upstream");
    fs.mkdirSync(upstreamDir, { recursive: true });
    const upstreamKeyPair = generateTestKeyPair(upstreamDir);

    let capturedHeaders: http.IncomingHttpHeaders | undefined;
    let capturedBody = "";

    // Start a fake upstream HTTPS server that echoes back the Authorization header.
    upstreamServer = https.createServer(
      { key: fs.readFileSync(upstreamKeyPair.key), cert: fs.readFileSync(upstreamKeyPair.cert) },
      (req, res) => {
        capturedHeaders = req.headers;
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          capturedBody = body;
          res.writeHead(200, { "Content-Type": "text/plain" });
          // Keep the response alive beyond the proxy's 5s TLS handshake timeout.
          // A server-side TLSSocket must clear that timer on its "secure" event.
          setTimeout(() => res.end(`ok: ${body}`), 5250);
        });
      },
    );

    await new Promise<void>((resolve) => upstreamServer!.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstreamServer!.address() as any).port;

    const proxyConfig: EgressRuntimeConfig = {
      policy: "allowlist",
      allowHosts: ["127.0.0.1"],
      denyHosts: [],
      allowPorts: [upstreamPort, 443],
      allowAll: false,
      enableMitm: true,
      secrets: [
        { env: "TEST_TOKEN", value: "real-token-value", placeholder: "psbx-sec-test-abc", hosts: ["127.0.0.1"] },
      ],
      port: 0,
      authToken: "test",
    };

    const caDir = path.join(tmpDir, "ca");
    proxy = new EgressProxy(proxyConfig, caDir);
    await proxy.start();
    const proxyPort = proxy.port;

    const auth = "Basic " + Buffer.from("psbx:test").toString("base64");

    // Connect to the proxy and issue a CONNECT for our upstream.
    const sock = net.connect(proxyPort, "127.0.0.1");
    sock.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nProxy-Authorization: ${auth}\r\n\r\n`);

    // Read the CONNECT response.
    const connectResponse = await new Promise<Buffer>((resolve) => {
      const timer = setTimeout(() => sock.destroy(), 3000);
      sock.once("data", (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    assert(connectResponse.toString("utf-8").includes("200"), "CONNECT returns 200");

    // Wrap the socket with TLS (the proxy's MITM side).
    const clientTls = tls.connect({
      socket: sock,
      host: "127.0.0.1",
      rejectUnauthorized: false,
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("TLS timeout")), 3000);
      clientTls.once("secureConnect", () => {
        clearTimeout(timer);
        resolve();
      });
      clientTls.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Send an HTTPS request with placeholders in both a header and the body.
    // The body replacement changes its byte length, exercising Content-Length repair.
    const requestBody = "token=psbx-sec-test-abc";
    const request = [
      "POST /test HTTP/1.1",
      "Host: 127.0.0.1",
      "Authorization: Bearer psbx-sec-test-abc",
      `Content-Length: ${Buffer.byteLength(requestBody)}`,
      "Connection: close",
      "",
      requestBody,
    ].join("\r\n");

    clientTls.write(request);

    // Read the response.
    const response = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      clientTls.on("data", (chunk) => {
        chunks.push(chunk as Buffer);
      });
      clientTls.on("end", () => resolve(Buffer.concat(chunks)));
      clientTls.on("error", () => resolve(Buffer.concat(chunks)));
      setTimeout(() => resolve(Buffer.concat(chunks)), 7000);
    });

    clientTls.destroy();

    const responseStr = response.toString("utf-8");
    assert(responseStr.includes("200"), `MITM response includes 200 (got: ${responseStr.slice(0, 100).replace(/\n/g, "\\n")})`);
    assert(responseStr.includes("ok: "), "MITM response remains connected beyond the handshake timeout");

    // Wait briefly for the upstream to process.
    await new Promise((r) => setTimeout(r, 500));

    // Verify the upstream received the rewritten token (real value, not placeholder).
    assert(capturedHeaders !== undefined, "upstream received headers");
    assertEq(capturedBody, "token=real-token-value", "placeholder replaced in upstream body");
    if (capturedHeaders) {
      const authHeader = capturedHeaders["authorization"] as string | undefined;
      assert(authHeader !== undefined, "authorization header present in upstream");
      if (authHeader) {
        assert(authHeader === "Bearer real-token-value",
          `placeholder replaced in upstream: expected "Bearer real-token-value", got "${authHeader}"`);
      }
    }

    console.log("✓ MITM secret injection");
  } finally {
    await proxy?.stop();
    upstreamServer?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---- Run all ----

async function main() {
  try {
    await testMitmCertGeneration();
    await testAuthTokenValidation();
    await testConnectPolicyEnforcement();
    await testMitmSecretInjection();
    console.log("\nALL EGRESS PROXY INTEGRATION TESTS PASSED");
  } catch (err: any) {
    console.error("\nTEST FAILED:", err.message);
    process.exit(1);
  }
}

main();
