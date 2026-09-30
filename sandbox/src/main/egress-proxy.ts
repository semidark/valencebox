import * as http from "http";
import * as https from "https";
import * as net from "net";
import { Duplex } from "stream";
import * as tls from "tls";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { generate as selfsignedGenerate } from "selfsigned";
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

function resolvePath(p: string): string {
  // Expand ~ to the user's home directory.
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Resolve secrets from a config: read inline `value`, `fromFile`, or `fromEnv`, generate placeholders.
 */
export function resolveSecrets(secrets: { env: string; value?: string; fromFile?: string; fromEnv?: string; hosts: string[] }[]): ResolvedSecret[] {
  return secrets.map((spec) => {
    // Validate env_name: must be a valid POSIX environment variable name.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(spec.env)) {
      throw new Error(`egress secret: invalid environment variable name '${spec.env}'`);
    }

    let value: string | undefined;

    if (spec.value !== undefined) {
      value = spec.value;
    } else if (spec.fromFile !== undefined) {
      const filePath = resolvePath(spec.fromFile);
      try {
        value = fs.readFileSync(filePath, "utf-8").trimEnd();
      } catch (err: any) {
        const msg = `egress secret '${spec.env}': failed to read file '${filePath}': ${err.message}`;
        console.error("[egress-proxy]", msg);
        throw new Error(msg);
      }
      if (value === "") {
        const msg = `egress secret '${spec.env}': file '${filePath}' is empty`;
        console.error("[egress-proxy]", msg);
        throw new Error(msg);
      }
    } else if (spec.fromEnv !== undefined) {
      value = process.env[spec.fromEnv];
      if (value === undefined || value === "") {
        const msg = `egress secret '${spec.env}': host environment variable '${spec.fromEnv}' is not set or empty`;
        console.error("[egress-proxy]", msg);
        throw new Error(msg);
      }
    } else {
      throw new Error(`egress secret '${spec.env}': must specify 'value', 'fromFile', or 'fromEnv'`);
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

/**
 * Response headers that must never reach the guest through the proxy: they can
 * pin the client against the MITM leaf or otherwise interfere with the proxy's
 * TLS termination.
 */
const STRIPPED_RESPONSE_HEADERS = [
  "strict-transport-security",
  "public-key-pins",
  "public-key-pins-report-only",
  "expect-ct",
];

/**
 * Strip HSTS / HPKP / Expect-CT from upstream response headers so they cannot
 * pin the guest against the proxy's MITM leaf or force policy the proxy cannot
 * honor. Returns a new header object; the input is not mutated.
 */
export function sanitizeResponseHeaders(
  headers: http.IncomingHttpHeaders,
): http.IncomingHttpHeaders {
  const out: http.IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (STRIPPED_RESPONSE_HEADERS.includes(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
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

/** True if the (bracket-stripped) host is an IPv4/IPv6 literal. */
function isIpAddress(host: string): boolean {
  const bare = host.replace(/^\[/, "").replace(/\]$/, "");
  return net.isIP(bare) !== 0;
}

/**
 * Generate or load a MITM CA keypair for the proxy.
 *
 * Pure-Node cert generation via `selfsigned` (→ @peculiar/x509); no `openssl`
 * subprocess is required. Stored under the userData directory for persistence
 * across restarts (a stable CA keeps the leaf-cert cache valid).
 */
export async function ensureMitmCa(caDir: string): Promise<MitmCa> {
  const certPath = path.join(caDir, "mitm-ca-cert.pem");
  const keyPath = path.join(caDir, "mitm-ca-key.pem");

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: certPath, key: keyPath };
  }

  fs.mkdirSync(caDir, { recursive: true, mode: 0o755 });

  const ca = await selfsignedGenerate(
    [
      { name: "commonName", value: "ValenceBox MITM CA" },
      { name: "organizationName", value: "ValenceBox" },
    ],
    {
      algorithm: "sha256",
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    },
  );

  fs.writeFileSync(certPath, ca.cert, { mode: 0o644 });
  fs.writeFileSync(keyPath, ca.private, { mode: 0o600 });

  console.log(`[egress-proxy] Generated MITM CA: ${certPath}`);
  return { cert: certPath, key: keyPath };
}

/**
 * Generate or load a leaf certificate for a specific hostname, signed by the
 * MITM CA. Pure-Node (selfsigned); cached to disk keyed by SHA256 of the
 * normalized host. Issues an IP SAN for IP literals, DNS SAN otherwise.
 */
export async function ensureLeafCertificate(
  host: string,
  mitmCa: MitmCa,
  certCacheDir: string,
): Promise<{ cert: string; key: string }> {
  fs.mkdirSync(certCacheDir, { recursive: true, mode: 0o755 });

  const normalized = normalizeHost(host);
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");
  const certPath = path.join(certCacheDir, `${hash}.pem`);
  const keyPath = path.join(certCacheDir, `${hash}.key`);

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: certPath, key: keyPath };
  }

  const altNames = isIpAddress(normalized)
    ? [{ type: 7 as const, ip: normalized.replace(/^\[/, "").replace(/\]$/, "") }]
    : [{ type: 2 as const, value: normalized }];

  const leaf = await selfsignedGenerate(
    [{ name: "commonName", value: normalized }],
    {
      algorithm: "sha256",
      keySize: 2048,
      ca: {
        key: fs.readFileSync(mitmCa.key, "utf-8"),
        cert: fs.readFileSync(mitmCa.cert, "utf-8"),
      },
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames },
      ],
    },
  );

  fs.writeFileSync(certPath, leaf.cert, { mode: 0o644 });
  fs.writeFileSync(keyPath, leaf.private, { mode: 0o600 });

  console.log(`[egress-proxy] Generated leaf cert for ${normalized}`);
  return { cert: certPath, key: keyPath };
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
  private logFile: string | undefined;
  private activeConnections = 0;
  private rateBuckets = new Map<string, { count: number; windowStart: number }>();
  private byteCounters = new Map<string, { in: number; out: number }>();

  constructor(
    config: EgressRuntimeConfig,
    caDir?: string,
    logFile?: string,
  ) {
    this.config = config;
    this.caDir = caDir || path.join(process.cwd(), ".mitm-ca");
    this.logFile = logFile;
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

  /** Snapshot of live connection count and per-host byte counters. */
  getStats(): { activeConnections: number; hosts: Record<string, { in: number; out: number }> } {
    const hosts: Record<string, { in: number; out: number }> = {};
    for (const [h, v] of this.byteCounters) hosts[h] = { ...v };
    return { activeConnections: this.activeConnections, hosts };
  }

  async start(): Promise<void> {
    // If MITM is enabled, ensure the CA exists (pure-Node, async).
    if (this.config.enableMitm) {
      this.mitmCa = await ensureMitmCa(this.caDir);
    }

    this.initLogFile();

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

      // Idle keep-alive protection. requestTimeout is disabled (0) so long-lived
      // downloads / SSE streams are not killed mid-transfer.
      this.server.keepAliveTimeout = 65000;
      this.server.headersTimeout = 66000;
      this.server.requestTimeout = 0;
      this.server.on("connection", (socket) => this.trackConnection(socket));

      this.mitmServer.keepAliveTimeout = 65000;
      this.mitmServer.headersTimeout = 66000;
      this.mitmServer.requestTimeout = 0;

      const port = this.config.port;
      const host = this.config.listenHost || "0.0.0.0";
      this.server.listen(port, host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.config.port = addr.port;
        }
        console.log(`[egress-proxy] listening on ${host}:${this.config.port} (policy=${this.config.policy}, mitm=${this.config.enableMitm})`);
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

  /**
   * Count a live TCP connection and enforce the max-connections limit.
   * Over-limit connections are rejected with 503 and destroyed.
   */
  private trackConnection(socket: net.Socket): void {
    this.activeConnections++;
    if (this.activeConnections > this.config.maxConnections) {
      this.log("DENY", "", socket.remoteAddress || "?", `connection limit reached (${this.config.maxConnections})`);
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.once("close", () => { this.activeConnections--; });
  }

  /**
   * Sliding-minute rate limit per client IP. Returns false when the limit is
   * exceeded. A limit of 0 disables rate limiting entirely.
   */
  private checkRateLimit(ip: string): boolean {
    const limit = this.config.rateLimitPerMin;
    if (!limit || limit <= 0) return true;
    const now = Date.now();
    const minute = 60000;
    const bucket = this.rateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart >= minute) {
      this.rateBuckets.set(ip, { count: 1, windowStart: now });
      return true;
    }
    bucket.count++;
    return bucket.count <= limit;
  }

  /** Accumulate byte counts (up = client→upstream, down = upstream→client). */
  private addBytes(host: string, up: number, down: number): void {
    let c = this.byteCounters.get(host);
    if (!c) { c = { in: 0, out: 0 }; this.byteCounters.set(host, c); }
    c.in += up;
    c.out += down;
  }

  /**
   * Open the rotating log file. Truncates to empty if the existing file exceeds
   * 10 MB (rotation on startup).
   */
  private initLogFile(): void {
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      if (fs.existsSync(this.logFile)) {
        const st = fs.statSync(this.logFile);
        if (st.size > 10 * 1024 * 1024) {
          fs.writeFileSync(this.logFile, "");
        }
      }
    } catch (err: any) {
      console.error("[egress-proxy] failed to init log file:", err.message);
    }
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

    // Per-client rate limit.
    const clientIp = req.socket.remoteAddress || "?";
    if (!this.checkRateLimit(clientIp)) {
      this.log("DENY", req.method || "GET", clientIp, "rate limit exceeded");
      res.writeHead(429, { "Content-Type": "text/plain", "Proxy-Connection": "close" });
      res.end("Too Many Requests\n");
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

    // Secret hosts over plain HTTP: buffer and rewrite headers/body so
    // placeholders are swapped for real secrets without TLS interception.
    if (!useTls && this.isSecretHost(targetHost)) {
      await this.forwardRequestWithSecrets(req, res, targetHost, port, path);
      return;
    }

    const options: https.RequestOptions = {
      hostname: targetHost,
      port,
      path,
      method: req.method,
      headers: { ...req.headers },
    };

    // Custom upstream CA bundle (D9): verify internal/self-signed upstreams
    // against the configured CA in addition to the system trust store.
    if (useTls && this.config.caCert) {
      options.ca = [...tls.rootCertificates, this.config.caCert];
    }

    // Strip proxy-specific headers before forwarding.
    delete (options.headers as any)["proxy-authorization"];
    delete (options.headers as any)["proxy-connection"];

    return new Promise((resolve, reject) => {
      const mod = useTls ? https : http;
      const forwardReq = mod.request(options, (forwardRes) => {
        res.writeHead(forwardRes.statusCode || 200, sanitizeResponseHeaders(forwardRes.headers));
        forwardRes.on("data", (c: Buffer) => this.addBytes(targetHost, 0, c.length));
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

  private async forwardRequestWithSecrets(req: http.IncomingMessage, res: http.ServerResponse, targetHost: string, port: number, path: string): Promise<void> {
    const method = req.method || "GET";
    try {
      const transferEncoding = req.headers["transfer-encoding"];
      if (transferEncoding && transferEncoding.toLowerCase().includes("chunked")) {
        this.log("BLOCK", method, targetHost, "chunked encoding not supported for secret hosts");
        this.send403(res, "chunked encoding is not supported for secret hosts");
        return;
      }

      const chunks: Buffer[] = [];
      let totalLen = 0;
      for await (const chunk of req) {
        totalLen += chunk.length;
        if (totalLen > MITM_MAX_BODY_SIZE) {
          this.send403(res, "payload too large");
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);

      const rawHeaders: [string, string][] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        rawHeaders.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
      }

      const rewrittenHeaders = rewriteHeaders(rawHeaders, this.config.secrets, targetHost);
      const rewrittenBody = rewriteBody(body, this.config.secrets);

      const origContentLength = req.headers["content-length"];
      if (rewrittenBody !== body && origContentLength) {
        const origLen = parseInt(origContentLength, 10);
        let clFixed = false;
        for (let i = 0; i < rewrittenHeaders.length; i++) {
          if (rewrittenHeaders[i][0].toLowerCase() === "content-length") {
            rewrittenHeaders[i][1] = rewrittenBody.length.toString();
            clFixed = true;
            break;
          }
        }
        if (!clFixed) {
          rewrittenHeaders.push(["content-length", rewrittenBody.length.toString()]);
        }
        this.log("DEBUG", method, `${targetHost}:${port}`,
          `Content-Length adjusted: ${origLen} → ${rewrittenBody.length}`);
      }

      const headers: Record<string, string> = Object.fromEntries(rewrittenHeaders);
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];

      const options: https.RequestOptions = {
        hostname: targetHost,
        port,
        path,
        method,
        headers,
      };

      const forwardReq = http.request(options, (forwardRes) => {
        this.log("HTTP-SECRET", method, `${targetHost}:${port}`, `upstream responded ${forwardRes.statusCode}`);
        res.writeHead(forwardRes.statusCode || 200, sanitizeResponseHeaders(forwardRes.headers));
        forwardRes.on("data", (c: Buffer) => this.addBytes(targetHost, 0, c.length));
        forwardRes.pipe(res);
      });

      forwardReq.on("error", (err) => {
        this.log("ERROR", method, `${targetHost}:${port}`, `upstream error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain", "Proxy-Connection": "close" });
          res.end(`Bad Gateway: ${err.message}\n`);
        }
      });

      forwardReq.write(rewrittenBody);
      forwardReq.end();

      this.log("HTTP-SECRET", method, `${targetHost}:${port}`, "secret injection active");
    } catch (err: any) {
      if (err instanceof PlaceholderViolation) {
        this.log("BLOCK", method, targetHost, `placeholder(s) not authorized: ${err.envNames.join(", ")}`);
        this.send403(res, `Egress denied: ${err.message}`);
      } else {
        this.log("ERROR", method, `${targetHost}:${port}`, err.message);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain", "Proxy-Connection": "close" });
          res.end(`Bad Gateway: ${err.message}\n`);
        }
      }
    }
  }

  private async handleConnect(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
    // Authentication check.
    if (!this.authenticate(req)) {
      clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nProxy-Authenticate: Basic realm=\"valencebox\"\r\n\r\n");
      clientSocket.end();
      return;
    }

    // Per-client rate limit.
    const clientIp = (clientSocket as net.Socket).remoteAddress || "?";
    if (!this.checkRateLimit(clientIp)) {
      this.log("DENY", "CONNECT", clientIp, "rate limit exceeded");
      clientSocket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
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

      // Byte counters for the tunnel (observe chunks; pipe still owns flow).
      clientSocket.on("data", (c: Buffer) => this.addBytes(targetHost, c.length, 0));
      upstream.on("data", (c: Buffer) => this.addBytes(targetHost, 0, c.length));

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

    // Get or generate a leaf certificate for this host (pure-Node, async).
    const certCacheDir = path.join(this.caDir, "certs");
    let leaf: { cert: string; key: string };
    try {
      leaf = await ensureLeafCertificate(targetHost, this.mitmCa, certCacheDir);
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
      const upstreamOpts: https.RequestOptions = {
        hostname: targetHost,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: Object.fromEntries(rewrittenHeaders),
        rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
      };
      // Custom upstream CA bundle (D9): verify against the configured CA in
      // addition to the system trust store.
      if (this.config.caCert) {
        upstreamOpts.ca = [...tls.rootCertificates, this.config.caCert];
      }
      const upstreamReq = https.request(upstreamOpts, (upstreamRes) => {
        const statusCode = upstreamRes.statusCode || 200;
        this.log("MITM", method, `${targetHost}:${targetPort}`, `upstream responded ${statusCode}`);
        res.writeHead(statusCode, sanitizeResponseHeaders(upstreamRes.headers));

        let clientDisconnected = false;
        upstreamRes.on("data", (c: Buffer) => this.addBytes(targetHost, 0, c.length));
        upstreamRes.on("error", (err) => {
          this.log("ERROR", method, `${targetHost}:${targetPort}`, `upstream response error: ${err.message}`);
          res.destroy();
          upstreamReq.destroy();
        });
        upstreamRes.on("close", () => {
          if (!upstreamRes.complete && !clientDisconnected) {
            this.log("ERROR", method, `${targetHost}:${targetPort}`, "upstream connection dropped mid-stream");
            res.destroy();
            upstreamReq.destroy();
          }
        });
        res.on("close", () => {
          if (!res.writableEnded) {
            clientDisconnected = true;
            this.log("ERROR", method, `${targetHost}:${targetPort}`, `client disconnected before response completed (status ${statusCode})`);
          }
          upstreamRes.destroy();
          upstreamReq.destroy();
        });

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
    const line = `[egress-proxy] ${timestamp} ${type} ${method} ${target} ${detail}`;
    console.log(line);
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, line + "\n");
      } catch {
        // Never let a log-write failure disrupt proxying.
      }
    }
  }
}
