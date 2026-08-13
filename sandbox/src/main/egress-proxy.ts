import * as http from "http";
import * as https from "https";
import * as net from "net";
import { Duplex } from "stream";
import * as tls from "tls";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { EgressPolicy, EgressRuntimeConfig, ResolvedSecret } from "../config";

// ---- Helpers ----

const COPY_CHUNK_SIZE = 65536;

/**
 * Maximum body size we are willing to buffer for MITM placeholder rewriting.
 */
const MITM_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Constant-time comparison to prevent timing attacks on the proxy auth token.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare against a fixed-length dummy to avoid leaking timing on length mismatch.
    const dummy = crypto.randomBytes(b.length).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(dummy), Buffer.from(b));
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Normalize a host string: lowercase, strip trailing dot, strip port.
 */
export function normalizeHost(host: string): string {
  let h = host.toLowerCase().replace(/\.$/, "");
  const colonIdx = h.lastIndexOf(":");
  if (colonIdx > 0) {
    if (h[colonIdx - 1] === "]" && colonIdx < h.length - 1) {
      // Bracketed IPv6 with port: [::1]:443 → strip port.
      h = h.substring(0, colonIdx);
    } else if (h[colonIdx - 1] !== "]" && h.indexOf(":") === colonIdx) {
      // Single colon → host:port format; strip the port.
      h = h.substring(0, colonIdx);
    }
    // Otherwise it's bare IPv6 (e.g. ::1) — leave untouched.
  }
  return h;
}

/**
 * Check whether a host matches a pattern. Pattern may be:
 * - `*.example.com` — matches any subdomain of example.com
 * - `example.com` — exact match
 * - `*` — wildcard (matches everything)
 */
function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return host.endsWith(suffix) || host === suffix.slice(1);
  }
  return host === pattern;
}

/**
 * Check whether a host is allowed under the given policy.
 */
export function hostAllowed(
  host: string,
  policy: EgressPolicy,
  allowHosts: string[],
  denyHosts: string[],
): boolean {
  if (policy === "none") return true;

  const normalized = normalizeHost(host);

  // Deny list takes priority.
  for (const pattern of denyHosts) {
    if (hostMatchesPattern(normalized, pattern)) return false;
  }

  if (policy === "denylist") return true;

  // Allowlist mode: must match at least one allow pattern.
  for (const pattern of allowHosts) {
    if (hostMatchesPattern(normalized, pattern)) return true;
  }

  return false;
}

/**
 * Generate a cryptographically random placeholder string.
 * Format: `psbx-sec-<24 hex chars>` (96-bit strength)
 */
export function generatePlaceholder(): string {
  return "psbx-sec-" + crypto.randomBytes(12).toString("hex");
}

/**
 * Resolve secrets from a config: read inline `value` or `fromEnv`, generate placeholders.
 */
export function resolveSecrets(secrets: { env: string; value?: string; fromEnv?: string; hosts: string[] }[]): ResolvedSecret[] {
  return secrets.map((spec) => {
    // Validate env_name: must be a valid POSIX environment variable name.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(spec.env)) {
      throw new Error(`egress secret: invalid environment variable name '${spec.env}'`);
    }

    let value: string | undefined;

    if (spec.value !== undefined) {
      value = spec.value;
    } else if (spec.fromEnv !== undefined) {
      value = process.env[spec.fromEnv];
      if (value === undefined || value === "") {
        const msg = `egress secret '${spec.env}': host environment variable '${spec.fromEnv}' is not set or empty`;
        console.error("[egress-proxy]", msg);
        throw new Error(msg);
      }
    } else {
      throw new Error(`egress secret '${spec.env}': must specify either 'value' or 'fromEnv'`);
    }

    return {
      env: spec.env,
      value,
      placeholder: generatePlaceholder(),
      hosts: spec.hosts,
    };
  });
}

/**
 * Rewrite headers, replacing any placeholder with the real secret value.
 * Returns the rewritten headers, or throws if a placeholder is used on an unauthorized host.
 */
export function rewriteHeaders(
  headers: [string, string][],
  secrets: ResolvedSecret[],
  host: string,
): [string, string][] {
  const rewritten: [string, string][] = [];
  const unauthorized = new Set<string>();

  for (const [name, value] of headers) {
    // Strip the Proxy-* headers that the client may have sent. They are consumed
    // here and must not reach the upstream.
    if (name.toLowerCase() === "proxy-authorization" || name.toLowerCase() === "proxy-connection") {
      continue;
    }

    let newValue = value;
    for (const secret of secrets) {
      if (secret.placeholder && newValue.includes(secret.placeholder)) {
        if (hostAllowed(host, "allowlist", secret.hosts, [])) {
          newValue = newValue.replaceAll(secret.placeholder, secret.value);
        } else {
          unauthorized.add(secret.env);
        }
      }
    }
    rewritten.push([name, newValue]);
  }

  if (unauthorized.size > 0) {
    const msg = `secret placeholder(s) not authorized for host '${host}': ${[...unauthorized].sort().join(", ")}`;
    throw new PlaceholderViolation([...unauthorized].sort());
  }

  return rewritten;
}

/**
 * Rewrite body bytes, replacing any placeholder with the real secret value.
 */
export function rewriteBody(body: Buffer, secrets: ResolvedSecret[]): Buffer {
  let data = body.toString("utf-8");
  let modified = false;
  for (const secret of secrets) {
    if (secret.placeholder && data.includes(secret.placeholder)) {
      data = data.replaceAll(secret.placeholder, secret.value);
      modified = true;
    }
  }
  return modified ? Buffer.from(data, "utf-8") : body;
}

// ---- Exceptions ----

export class PlaceholderViolation extends Error {
  constructor(public readonly envNames: string[]) {
    super(`secret placeholder(s) not authorized: ${envNames.join(", ")}`);
    this.name = "PlaceholderViolation";
  }
}

// ---- MITM CA ----

export interface MitmCa {
  cert: string;    // PEM certificate path
  key: string;     // PEM private key path
}

/**
 * Generate or load a MITM CA keypair for the proxy.
 * Stored under the userData directory for persistence across restarts.
 */
export function ensureMitmCa(caDir: string): MitmCa {
  const certPath = path.join(caDir, "mitm-ca-cert.pem");
  const keyPath = path.join(caDir, "mitm-ca-key.pem");

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: certPath, key: keyPath };
  }

  // Generate a new CA keypair.
  fs.mkdirSync(caDir, { recursive: true, mode: 0o755 });

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Create a self-signed CA cert.
  // Node's X509Certificate API is read-only. We use crypto.createSign to build
  // a self-signed x509 v3 certificate.
  const serial = BigInt("0x" + crypto.randomBytes(8).toString("hex"));
  const now = new Date();
  const expires = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  // Build the cert using a simple DER approach with createSign.
  // This replicates what `openssl req -x509 -new` does.
  const subject = "/CN=ValenceBox MITM CA/O=ValenceBox";
  const issuer = subject;

  const certPem = generateSelfSignedCert(publicKey, privateKey, serial, subject, now, expires);

  fs.writeFileSync(certPath, certPem, { mode: 0o644 });
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });

  console.log(`[egress-proxy] Generated MITM CA: ${certPath}`);
  return { cert: certPath, key: keyPath };
}

/**
 * Generate a self-signed X.509v3 certificate.
 * Uses Node crypto to build the DER and sign it.
 */
function generateSelfSignedCert(
  publicKeyPem: string,
  privateKeyPem: string,
  serial: bigint,
  subject: string,
  notBefore: Date,
  notAfter: Date,
): string {
  // We use openssl via spawnSync for the actual cert generation because Node's
  // built-in X509Certificate API is read-only. However, the proxy may need to
  // run without openssl. As a fallback we do the DER construction manually.
  //
  // For production, we prefer the openssl subprocess since it produces
  // widely-compatible certs. Fall back to a JS approximation.

  try {
    return generateSelfSignedCertViaOpenssl(privateKeyPem, serial, subject, notBefore, notAfter);
  } catch {
    return generateSelfSignedCertJs(publicKeyPem, privateKeyPem, serial, subject, notBefore, notAfter);
  }
}

function generateSelfSignedCertViaOpenssl(
  privateKeyPem: string,
  serial: bigint,
  subject: string,
  notBefore: Date,
  notAfter: Date,
): string {
  const { spawnSync } = require("child_process") as typeof import("child_process");

  const tmpDir = fs.mkdtempSync("mitm-ca-");
  const tmpKey = path.join(tmpDir, "key.pem");
  fs.writeFileSync(tmpKey, privateKeyPem);

  const result = spawnSync("openssl", [
    "req", "-x509", "-new", "-nodes",
    "-key", tmpKey,
    "-sha256",
    "-days", "365",
    "-subj", subject,
    "-set_serial", serial.toString(),
    "-extensions", "v3_ca",
  ], {
    encoding: "utf-8",
    timeout: 10000,
  });

  cleanupTempDir(tmpDir);

  if (result.status !== 0) {
    throw new Error(`openssl failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
}

function generateSelfSignedCertJs(
  _publicKeyPem: string,
  privateKeyPem: string,
  _serial: bigint,
  _subject: string,
  _notBefore: Date,
  _notAfter: Date,
): string {
  // Minimal self-signed cert using Node crypto.
  // For a real implementation, we'd construct the TBSCertificate DER manually.
  // For Phase A (no MITM) this path isn't needed; we use openssl.
  // For Phase B, we'll implement full DER encoding.
  //
  // For now, fall back to openssl requirement with a clear error.
  throw new Error("openssl is required for MITM CA generation (JS fallback not yet implemented)");
}

/**
 * Generate or load a leaf certificate for a specific hostname.
 */
export function ensureLeafCertificate(
  host: string,
  mitmCa: MitmCa,
  certCacheDir: string,
): { cert: string; key: string } {
  fs.mkdirSync(certCacheDir, { recursive: true, mode: 0o755 });

  const normalized = normalizeHost(host);
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");
  const certPath = path.join(certCacheDir, `${hash}.pem`);
  const keyPath = path.join(certCacheDir, `${hash}.key`);

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: certPath, key: keyPath };
  }

  // Generate a leaf keypair.
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  } as any);

  // Generate leaf cert signed by the MITM CA using openssl.
  const { spawnSync } = require("child_process") as typeof import("child_process");
  const tmpDir = fs.mkdtempSync("mitm-leaf-");
  const keyFile = path.join(tmpDir, "leaf.key");
  const csrFile = path.join(tmpDir, "leaf.csr");
  const extFile = path.join(tmpDir, "leaf.ext");

  fs.writeFileSync(keyFile, privateKey);

  // CSR config
  const csrSubject = `/CN=${normalized}/O=ValenceBox`;

  const opensslPath = "openssl";

  // Generate CSR
  const csrResult = spawnSync(opensslPath, [
    "req", "-new",
    "-key", keyFile,
    "-subj", csrSubject,
    "-sha256",
  ], {
    encoding: "utf-8",
    timeout: 10000,
  });

  if (csrResult.status !== 0) {
    cleanupTempDir(tmpDir);
    throw new Error(`openssl CSR failed for ${host}: ${csrResult.stderr}`);
  }

  fs.writeFileSync(csrFile, csrResult.stdout);

  // X509 v3 extensions
  fs.writeFileSync(extFile, [
    "subjectKeyIdentifier = hash",
    "authorityKeyIdentifier = keyid:always,issuer",
    "basicConstraints = CA:FALSE",
    `subjectAltName = DNS:${normalized}`,
  ].join("\n"));

  // Sign with CA
  const signResult = spawnSync(opensslPath, [
    "x509", "-req",
    "-in", csrFile,
    "-CA", mitmCa.cert,
    "-CAkey", mitmCa.key,
    "-CAcreateserial",
    "-out", certPath,
    "-days", "365",
    "-sha256",
    "-extfile", extFile,
  ], {
    encoding: "utf-8",
    timeout: 10000,
  });

  if (signResult.status !== 0) {
    cleanupTempDir(tmpDir);
    throw new Error(`openssl sign failed for ${host}: ${signResult.stderr}`);
  }

  // Copy the private key to the cache
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });

  cleanupTempDir(tmpDir);
  console.log(`[egress-proxy] Generated leaf cert for ${normalized}`);
  return { cert: certPath, key: keyPath };
}

function cleanupTempDir(dir: string): void {
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
  } catch {}
}

// ---- EgressProxy class ----

// Map TLS sockets to the upstream host they were CONNECTed to, so the MITM
// http.Server request handler knows where to proxy.
const mitmTargetMap = new WeakMap<tls.TLSSocket, { host: string; port: number }>();

export class EgressProxy {
  private server: http.Server | null = null;
  private readonly config: EgressRuntimeConfig;
  private mitmCa: MitmCa | null = null;
  private caDir: string;
  private mitmServer: http.Server;

  constructor(
    config: EgressRuntimeConfig,
    caDir?: string,
  ) {
    this.config = config;
    this.caDir = caDir || path.join(process.cwd(), ".mitm-ca");
    this.mitmServer = http.createServer((req, res) => {
      this.handleMitmRequest(req, res);
    });
  }

  get port(): number {
    return this.config.port;
  }

  get runtimeConfig(): EgressRuntimeConfig {
    return this.config;
  }

  get ca(): MitmCa | null {
    return this.mitmCa;
  }

  async start(): Promise<void> {
    // If MITM is enabled, ensure the CA exists.
    if (this.config.enableMitm) {
      this.mitmCa = ensureMitmCa(this.caDir);
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("connect", (req, clientSocket, head) => {
        this.handleConnect(req, clientSocket, head);
      });

      this.server.on("error", (err) => {
        console.error("[egress-proxy] server error:", err);
      });

      const port = this.config.port;
      this.server.listen(port, "0.0.0.0", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.config.port = addr.port;
        }
        console.log(`[egress-proxy] listening on 0.0.0.0:${this.config.port} (policy=${this.config.policy}, mitm=${this.config.enableMitm})`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        console.log("[egress-proxy] stopped");
        this.server = null;
        resolve();
      });
    });
  }

  private authenticate(req: http.IncomingMessage): boolean {
    if (!this.config.authToken) return true; // no auth configured

    const authHeader = req.headers["proxy-authorization"];
    if (!authHeader) return false;

    // Expect: "Basic <base64("valencebox:<token>")>"
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0].toLowerCase() !== "basic") return false;

    try {
      const decoded = Buffer.from(parts[1], "base64").toString("utf-8");
      const colonIdx = decoded.indexOf(":");
      if (colonIdx === -1) return false;
      const token = decoded.slice(colonIdx + 1);
      return constantTimeEqual(token, this.config.authToken);
    } catch {
      return false;
    }
  }

  private send403(res: http.ServerResponse, reason: string): void {
    res.writeHead(403, { "Content-Type": "text/plain", "Proxy-Connection": "close" });
    res.end(`Egress denied: ${reason}\n`);
  }

  private sendMitmError(res: http.ServerResponse, statusCode: number, message: string): void {
    if (res.headersSent) return;
    res.writeHead(statusCode, { "Content-Type": "text/plain" });
    res.end(message);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Authentication check.
    if (!this.authenticate(req)) {
      res.writeHead(407, {
        "Proxy-Authenticate": "Basic realm=\"valencebox\"",
        "Content-Type": "text/plain",
        "Proxy-Connection": "close",
      });
      res.end("Proxy authentication required\n");
      return;
    }

    const host = req.headers["host"] || "";
    if (!host) {
      this.send403(res, "no host header");
      return;
    }

    const targetHost = normalizeHost(host);

    // Policy check.
    if (!this.config.allowAll && !hostAllowed(targetHost, this.config.policy, this.config.allowHosts, this.config.denyHosts)) {
      this.log("DENY", req.method || "GET", targetHost, "host blocked by policy");
      this.send403(res, `host '${targetHost}' is not allowed`);
      return;
    }

    // For non-CONNECT requests, we forward as an HTTP proxy.
    try {
      await this.forwardRequest(req, res, targetHost);
    } catch (err: any) {
      this.log("ERROR", req.method || "GET", targetHost, err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain", "Proxy-Connection": "close" });
        res.end(`Bad Gateway: ${err.message}\n`);
      }
    }
  }

  private async forwardRequest(req: http.IncomingMessage, res: http.ServerResponse, targetHost: string): Promise<void> {
    const rawUrl = req.url || "/";

    // In forward proxy mode, req.url is an absolute URL (e.g. http://host:port/path).
    // Parse it to extract the correct hostname, port, and path.
    let port = 80;
    let path = rawUrl;
    let useTls = false;
    try {
      const parsed = new URL(rawUrl);
      port = parseInt(parsed.port, 10) || (parsed.protocol === "https:" ? 443 : 80);
      path = parsed.pathname + parsed.search;
      useTls = parsed.protocol === "https:";
    } catch {
      // Origin-form request; keep defaults.
    }

    // Enforce allowPorts if configured.
    if (this.config.allowPorts.length > 0 && !this.config.allowPorts.includes(port)) {
      this.send403(res, `port ${port} is not allowed`);
      return;
    }

    const options: http.RequestOptions = {
      hostname: targetHost,
      port,
      path,
      method: req.method,
      headers: { ...req.headers },
    };

    // Strip proxy-specific headers before forwarding.
    delete (options.headers as any)["proxy-authorization"];
    delete (options.headers as any)["proxy-connection"];

    return new Promise((resolve, reject) => {
      const mod = useTls ? https : http;
      const forwardReq = mod.request(options, (forwardRes) => {
        res.writeHead(forwardRes.statusCode || 200, forwardRes.headers);
        forwardRes.pipe(res);
        resolve();
      });

      forwardReq.on("error", (err) => {
        reject(err);
      });

      // If there's a request body, pipe it.
      if (req) {
        req.pipe(forwardReq);
      } else {
        forwardReq.end();
      }
    });
  }

  private async handleConnect(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    // Authentication check.
    if (!this.authenticate(req)) {
      clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nProxy-Authenticate: Basic realm=\"valencebox\"\r\n\r\n");
      clientSocket.end();
      return;
    }

    const [hostPart, portStr] = (req.url || "").split(":");
    const targetHost = normalizeHost(hostPart);
    const targetPort = parseInt(portStr, 10) || 443;

    // Policy check.
    if (!this.config.allowAll && !hostAllowed(targetHost, this.config.policy, this.config.allowHosts, this.config.denyHosts)) {
      this.log("DENY", "CONNECT", `${targetHost}:${targetPort}`, "host blocked by policy");
      clientSocket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nEgress denied: host '${targetHost}' is not allowed\n`);
      clientSocket.end();
      return;
    }

    // Port check.
    if (this.config.allowPorts.length > 0 && !this.config.allowPorts.includes(targetPort)) {
      this.log("DENY", "CONNECT", `${targetHost}:${targetPort}`, "port blocked by policy");
      clientSocket.write(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nEgress denied: port ${targetPort} is not allowed\n`);
      clientSocket.end();
      return;
    }

    // Check if this is a secret host (requires MITM).
    if (this.config.enableMitm && this.isSecretHost(targetHost)) {
      await this.handleMitmConnect(targetHost, targetPort, clientSocket, head);
      return;
    }

    // Plain CONNECT tunnel: open a TCP connection to the upstream and relay bytes.
    try {
      const upstream = await this.connectUpstream(targetHost, targetPort);

      // Forward any initial data the client already sent (race between headers
      // and CONNECT response).
      if (head.length > 0) {
        upstream.write(head);
      }

      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      // Start the tunnel: relay between client and upstream.
      // Simple two-way relay using pipe
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);

      clientSocket.on("error", () => {
        clientSocket.destroy();
        upstream.destroy();
      });
      upstream.on("error", () => {
        clientSocket.destroy();
        upstream.destroy();
      });
      clientSocket.on("close", () => upstream.destroy());
      upstream.on("close", () => clientSocket.destroy());

      this.log("CONNECT", "", `${targetHost}:${targetPort}`, "tunnel established");
    } catch (err: any) {
      this.log("ERROR", "CONNECT", `${targetHost}:${targetPort}`, err.message);
      clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nBad Gateway: ${err.message}\n`);
      clientSocket.end();
    }
  }

  private isSecretHost(host: string): boolean {
    const normalized = normalizeHost(host);
    for (const secret of this.config.secrets) {
      for (const pattern of secret.hosts) {
        if (hostMatchesPattern(normalized, pattern)) return true;
      }
    }
    return false;
  }

  private async handleMitmConnect(
    targetHost: string,
    targetPort: number,
    clientSocket: Duplex,
    _head: Buffer,
  ): Promise<void> {
    if (!this.mitmCa) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nMITM CA not initialized\n");
      clientSocket.end();
      return;
    }

    // Get or generate a leaf certificate for this host.
    const certCacheDir = path.join(this.caDir, "certs");
    let leaf: { cert: string; key: string };
    try {
      leaf = ensureLeafCertificate(targetHost, this.mitmCa, certCacheDir);
    } catch (err: any) {
      this.log("ERROR", "MITM", `${targetHost}:${targetPort}`, `cert generation failed: ${err.message}`);
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nFailed to generate TLS certificate for interception\n");
      clientSocket.end();
      return;
    }

    // Send 200 to the client to confirm CONNECT.
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // The HTTP CONNECT handler may have paused the socket; resume it so the
    // TLSSocket can read incoming TLS ClientHello data.
    clientSocket.resume();

    // Wrap the client socket with TLS (server-side).
    const clientTls = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: fs.readFileSync(leaf.key),
      cert: fs.readFileSync(leaf.cert),
    });

    // Enable TCP keepalive on the client TLS socket so intermediate NAT /
    // firewalls don't tear down long-lived SSE streams.
    clientTls.setKeepAlive(true, 15000);

    // Track errors and handshake outcome.
    let handshakeComplete = false;
    clientTls.on("error", (err) => {
      const phase = handshakeComplete ? "client TLS error" : "TLS handshake failed";
      this.log("ERROR", "MITM", `${targetHost}:${targetPort}`, `${phase}: ${err.message}`);
      clientTls.destroy();
    });

    // A server-side TLSSocket emits "secure", not the client-side
    // "secureConnect" event. Register before handing the socket to the HTTP
    // server so a fast handshake cannot race past the listener.
    const handshake = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.log("ERROR", "MITM", `${targetHost}:${targetPort}`, "TLS handshake timed out");
        clientTls.destroy();
        resolve();
      }, 5000);

      clientTls.once("secure", () => {
        handshakeComplete = true;
        clearTimeout(timer);
        resolve();
      });
      clientTls.once("error", () => {
        clearTimeout(timer);
        resolve();
      });
      clientTls.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // Hand the TLS socket to the mitmServer immediately so its connection handler
    // starts reading from the socket (which triggers the underlying TCP read and
    // completes the TLS handshake).
    mitmTargetMap.set(clientTls, { host: targetHost, port: targetPort });
    this.mitmServer.emit("connection", clientTls);
    await handshake;

    if (!handshakeComplete) {
      return;
    }

    this.log("MITM", "CONNECT", `${targetHost}:${targetPort}`, "TLS interception active");
  }

  private async handleMitmRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const target = mitmTargetMap.get(req.socket as tls.TLSSocket);
    if (!target) {
      // Should never happen; the socket was not created by our MITM CONNECT path.
      this.sendMitmError(res, 502, "Bad Gateway: MITM target unknown");
      req.socket.destroy();
      return;
    }

    const { host: targetHost, port: targetPort } = target;
    const method = req.method || "GET";

    try {
      // Reject chunked bodies: we must buffer and rewrite the whole body.
      const transferEncoding = req.headers["transfer-encoding"];
      if (transferEncoding && transferEncoding.toLowerCase().includes("chunked")) {
        this.log("BLOCK", method, targetHost, "chunked encoding not supported for secret hosts");
        this.sendMitmError(res, 411, "Length Required: chunked encoding is not supported for secret hosts");
        return;
      }

      // Read the whole body so we can scan it for placeholders.
      const chunks: Buffer[] = [];
      let totalLen = 0;
      for await (const chunk of req) {
        totalLen += chunk.length;
        if (totalLen > MITM_MAX_BODY_SIZE) {
          this.sendMitmError(res, 413, "Payload Too Large");
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);

      // Convert rawHeaders to [name, value] pairs for rewriting.
      const rawHeaders: [string, string][] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        rawHeaders.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
      }

      // Rewrite headers and body, swapping placeholders for real secrets.
      const rewrittenHeaders = rewriteHeaders(rawHeaders, this.config.secrets, targetHost);
      const rewrittenBody = rewriteBody(body, this.config.secrets);

      // Fix Content-Length if body size changed after placeholder replacement.
      const origContentLength = req.headers["content-length"];
      if (rewrittenBody !== body && origContentLength) {
        const origLen = parseInt(origContentLength, 10);
        // Remove the stale Content-Length; Node.js will recalculate (or we set the correct value).
        let clRemoved = false;
        for (let i = 0; i < rewrittenHeaders.length; i++) {
          if (rewrittenHeaders[i][0].toLowerCase() === "content-length") {
            rewrittenHeaders[i][1] = rewrittenBody.length.toString();
            clRemoved = true;
            break;
          }
        }
        if (!clRemoved) {
          rewrittenHeaders.push(["content-length", rewrittenBody.length.toString()]);
        }
        this.log("DEBUG", method, `${targetHost}:${targetPort}`,
          `Content-Length adjusted: ${origLen} → ${rewrittenBody.length}`);
      }

      // Forward to the upstream server over TLS.
      const upstreamReq = https.request({
        hostname: targetHost,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: Object.fromEntries(rewrittenHeaders),
        rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
      }, (upstreamRes) => {
        const statusCode = upstreamRes.statusCode || 200;
        this.log("MITM", method, `${targetHost}:${targetPort}`, `upstream responded ${statusCode}`);
        res.writeHead(statusCode, upstreamRes.headers);

        // Log all upstream response events for debugging SSE terminations.
        const upTag = `upstream:${method}:${targetHost}:${targetPort}`;
        let clientDisconnected = false;
        upstreamRes.on("end", () => this.log("DEBUG", upTag, "", "upstreamRes 'end'"));
        upstreamRes.on("error", (err) => {
          this.log("ERROR", upTag, "", `upstreamRes 'error': ${err.message}`);
          res.destroy();
          upstreamReq.destroy();
        });
        upstreamRes.on("pause", () => this.log("DEBUG", upTag, "", "upstreamRes 'pause' (backpressure)"));
        upstreamRes.on("resume", () => this.log("DEBUG", upTag, "", "upstreamRes 'resume'"));
        upstreamRes.on("close", () => {
          this.log("DEBUG", upTag, "", `upstreamRes 'close' (complete=${upstreamRes.complete}, errored=${!!upstreamRes.errored})`);
          if (!upstreamRes.complete && !clientDisconnected) {
            this.log("ERROR", upTag, "", `upstream connection dropped mid-stream`);
            res.destroy();
            upstreamReq.destroy();
          }
        });

        // Log client response events.
        const cliTag = `client:${method}:${targetHost}:${targetPort}`;
        res.on("close", () => {
          const ended = res.writableEnded;
          if (!ended) clientDisconnected = true;
          this.log("DEBUG", cliTag, "", `res 'close' (writableEnded=${ended})`);
          if (!ended) {
            this.log("ERROR", cliTag, "", `client disconnected before response completed (upstream status ${statusCode})`);
          }
          upstreamRes.destroy();
          upstreamReq.destroy();
        });
        res.on("finish", () => this.log("DEBUG", cliTag, "", "res 'finish'"));
        res.on("drain", () => this.log("DEBUG", cliTag, "", "res 'drain'"));

        upstreamRes.pipe(res);
      });

      upstreamReq.on("error", (err) => {
        this.log("ERROR", method, `${targetHost}:${targetPort}`, `upstream error: ${err.message}`);
        this.sendMitmError(res, 502, `Bad Gateway: ${err.message}`);
      });

      // Enable TCP keepalive on the upstream socket.
      // Must handle both sync (pool reuse) and async (new conn) socket assignment.
      if (upstreamReq.socket) {
        upstreamReq.socket.setKeepAlive(true, 15000);
        this.log("DEBUG", method, `${targetHost}:${targetPort}`, "keepalive set on pre-existing socket");
      }
      upstreamReq.on("socket", (socket) => {
        socket.setKeepAlive(true, 15000);
        this.log("DEBUG", method, `${targetHost}:${targetPort}`, "keepalive set on socket (async)");
      });

      upstreamReq.write(rewrittenBody);
      upstreamReq.end();

      this.log("MITM", method, `${targetHost}:${targetPort}`, "secret injection active");
    } catch (err: any) {
      if (err instanceof PlaceholderViolation) {
        this.log("BLOCK", method, targetHost, `placeholder(s) not authorized: ${err.envNames.join(", ")}`);
        this.sendMitmError(res, 403, `Egress denied: ${err.message}`);
      } else {
        this.log("ERROR", method, `${targetHost}:${targetPort}`, err.message);
        this.sendMitmError(res, 502, `Bad Gateway: ${err.message}`);
      }
    }
  }

  private connectUpstream(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(10000);
      socket.connect(port, host, () => {
        socket.setTimeout(0);
        resolve(socket);
      });
      socket.on("error", reject);
      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error(`upstream connection timeout: ${host}:${port}`));
      });
    });
  }

  private log(type: string, method: string, target: string, detail: string): void {
    if (type === "DEBUG" && process.env.VERBOSE !== "1") return;
    const timestamp = new Date().toISOString();
    console.log(`[egress-proxy] ${timestamp} ${type} ${method} ${target} ${detail}`);
  }
}
