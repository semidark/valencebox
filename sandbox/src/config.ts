import * as net from "net";
import { GuestArch } from "./main/guest-profile";

// ---- Egress proxy types ----

export type EgressPolicy = "allowlist" | "denylist" | "none";

export interface SecretSpec {
  /** Environment variable name exposed to the guest (with placeholder value). */
  env: string;

  /**
   * Inline secret value (stored in config file — use with caution).
   * If set, this takes priority over `fromEnv`.
   */
  value?: string;

  /**
   * Read the secret value from this host environment variable at app startup.
   * Preferred over inline `value` for security (secret never written to disk).
   */
  fromEnv?: string;

  /**
   * Read the secret value from a file on disk. The path supports `~` for the
   * user's home directory. The file is read at app startup and trailing
   * newlines are stripped. Preferred over inline `value` and `fromEnv` for
   * secrets managed by external tools (e.g. 1password CLI, gpg).
   */
  fromFile?: string;

  /**
   * Host patterns where this secret may be injected.
   * Supports wildcard: `*.openai.com`, `api.github.com`.
   */
  hosts: string[];
}

export interface EgressConfig {
  /** Egress filtering policy. "none" = allow all (but proxy still starts). */
  policy?: EgressPolicy;

  /** Host patterns always allowed (in allowlist mode) or never allowed (in denylist mode). */
  allowHosts?: string[];

  /** Host patterns always denied. Takes priority over allowlist. */
  denyHosts?: string[];

  /** Ports allowed through the proxy. Default [80, 443]. */
  allowPorts?: number[];

  /** If true, bypass all filtering (open egress). Default false. */
  allowAll?: boolean;

  /** Explicit proxy listen port. Default 0 (OS assigns a random available port). */
  listenPort?: number;

  /** Enable MITM TLS interception for secret injection. Default false. */
  enableMitm?: boolean;

  /** Secrets to inject: placeholders in the guest, real values replaced by the proxy. */
  secrets?: SecretSpec[];

  /**
   * Path to a custom CA bundle (PEM) used to verify upstream TLS servers.
   * Supports `~` for the user's home directory. Use this when upstreams present
   * internal/self-signed certificates that should verify without disabling
   * `rejectUnauthorized`. When set, MITM upstream connections verify against
   * this bundle in addition to the system trust store.
   */
  caCertFile?: string;

  /**
   * Maximum number of concurrent connections the proxy will accept.
   * Connections beyond this limit are rejected with 503. Default 256.
   */
  maxConnections?: number;

  /**
   * Maximum requests (or CONNECTs) per client IP per minute. 0 disables rate
   * limiting. Requests beyond the limit are rejected with 429. Default 0.
   */
  rateLimitPerMin?: number;

  /**
   * Host interface the proxy binds to. Default "0.0.0.0" so the guest can reach
   * it via the SLIRP gateway (10.0.2.2). Set to "127.0.0.1" to restrict to
   * loopback only if your SLIRP setup delivers guest connections via loopback.
   * In strict network mode (egress.enforce, default true on verified platforms)
   * the default becomes "127.0.0.1": the guest reaches the proxy through the
   * virtio-serial mux tunnel, not through SLIRP.
   */
  listenHost?: string;

  /**
   * Strict network containment. When true (the default on verified platforms),
   * the VM boots with `-nic none`: no SLIRP, no guest NIC, no UDP, no ICMP.
   * The only guest↔host data path is a multiplexed virtio-serial tunnel, and
   * all guest egress is forced through EgressProxy where host policy applies.
   * TCP port forwards are implemented as host-initiated mux streams.
   *
   * Set false to opt in to the legacy SLIRP path (unrestricted guest network
   * with proxy environment variables steering cooperating clients).
   *
   * On platforms where the tunnel is not yet verified (macOS, Windows) a
   * requested strict mode falls back to legacy SLIRP with a warning — never a
   * silent strict boot.
   */
  enforce?: boolean;

  /**
   * Optional corporate/parent HTTP proxy (e.g. `http://proxy.corp.example:8080`,
   * credentials allowed as `http://user:pass@host:port`). When set, EgressProxy
   * dials all upstream connections (CONNECT tunnels, plain-HTTP forwarding,
   * MITM re-encryption) through this proxy via HTTP CONNECT. Host policy and
   * port policy are still enforced before chaining. Only `http://` upstreams
   * are supported. Default: unset (direct upstream connections).
   */
  upstreamProxy?: string;

  /**
   * Hosts that must be dialed DIRECTLY even when `upstreamProxy` is set —
   * the equivalent of the standard `no_proxy` environment variable. Entries
   * are comma/space separated (or a string array) and may be:
   *   - plain hostnames:           `localhost`
   *   - domain suffixes:           `.corp.example` (matches `*.corp.example` and `corp.example`)
   *   - IP literals:               `10.1.2.3`, `::1`
   *   - CIDR ranges (v4 and v6):   `127.0.0.0/8`, `fe80::/10`
   *   - `*` (everything bypasses the upstream proxy)
   *
   * Loopback (`localhost`, `127.0.0.0/8`, `::1`) is always direct — host-local
   * services must never be routed through an external proxy — and cannot be
   * removed. Everything else defaults to chained through the upstream proxy.
   */
  upstreamNoProxy?: string | string[];

  /**
   * PEM certificate (or bundle) installed into the GUEST trust store at boot
   * via fw_cfg. Use this when corporate TLS inspection (e.g. an intercepting
   * proxy) presents certificates the guest must trust, or to provision an
   * internal root CA. Independent of `enableMitm`: when both apply, this file
   * takes precedence for guest delivery. Supports `~` for the home directory.
   */
  guestCaFile?: string;
}

/** Parsed upstream proxy for host-side chaining. */
export interface UpstreamProxy {
  /** Upstream proxy hostname. */
  host: string;
  /** Upstream proxy port. */
  port: number;
  /** Pre-rendered "Basic ..." Proxy-Authorization header value, or undefined. */
  authHeader?: string;
}

/** Parsed no_proxy exception set for upstream proxy chaining. */
export interface UpstreamNoProxySet {
  /** Lowercase domains (leading dot stripped); match host and *.host. "*" = all. */
  domains: string[];
  /** Normalized IP literals (v4/v6, no brackets). */
  ips: string[];
  /** CIDR ranges. */
  cidrs: { family: 4 | 6; prefix: string; bits: number }[];
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function ipv6ToBigInt(ip: string): bigint | null {
  // Strip a zone suffix (fe80::1%eth0) and expand "::".
  const bare = ip.split("%")[0];
  if (!bare.includes(":")) return null;
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const parseGroup = (g: string): number | null =>
    /^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : null;
  if (halves.length === 2) {
    const head = halves[0] === "" ? [] : halves[0].split(":");
    const tail = halves[1] === "" ? [] : halves[1].split(":");
    if (head.some((g) => parseGroup(g) === null) || tail.some((g) => parseGroup(g) === null)) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
    let v = 0n;
    for (const g of groups) v = (v << 16n) | BigInt(parseInt(g, 16));
    return v;
  }
  const groups = bare.split(":");
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    const n = parseGroup(g);
    if (n === null) return null;
    v = (v << 16n) | BigInt(n);
  }
  return v;
}

function ipToBigInt(ip: string): { family: 4 | 6; value: bigint } | null {
  if (net.isIPv4(ip)) {
    const v = ipv4ToBigInt(ip);
    return v === null ? null : { family: 4, value: v };
  }
  if (net.isIPv6(ip)) {
    const v = ipv6ToBigInt(ip);
    return v === null ? null : { family: 6, value: v };
  }
  return null;
}

/**
 * Parse a no_proxy-style exception list for upstream chaining.
 * Throws with a clear message on malformed entries (fail-closed config load).
 */
export function parseUpstreamNoProxy(spec: string | string[]): UpstreamNoProxySet {
  const raw = Array.isArray(spec) ? spec : spec.split(/[,\s]+/);
  const out: UpstreamNoProxySet = { domains: [], ips: [], cidrs: [] };
  for (const entryRaw of raw) {
    const entry = entryRaw.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
    if (!entry) continue;
    if (entry === "*") {
      out.domains.push("*");
      continue;
    }
    if (entry.includes("/")) {
      const [prefixRaw, bitsRaw] = entry.split("/");
      const bits = Number(bitsRaw);
      const ip = ipToBigInt(prefixRaw);
      if (ip === null || !Number.isInteger(bits) || bits < 0) {
        throw new Error(`egress.upstreamNoProxy: invalid CIDR '${entryRaw.trim()}'`);
      }
      const maxBits = ip.family === 4 ? 32 : 128;
      if (bits > maxBits) {
        throw new Error(`egress.upstreamNoProxy: CIDR '${entryRaw.trim()}' exceeds /${maxBits} for IPv${ip.family}`);
      }
      out.cidrs.push({ family: ip.family, prefix: prefixRaw, bits });
      continue;
    }
    if (ipToBigInt(entry) !== null) {
      out.ips.push(entry);
      continue;
    }
    const domain = entry.replace(/^\./, "");
    if (!HOSTNAME_RE.test(domain)) {
      throw new Error(`egress.upstreamNoProxy: invalid host entry '${entryRaw.trim()}'`);
    }
    out.domains.push(domain);
  }
  return out;
}

/** Loopback entries that are always direct (cannot be overridden). */
export const UPSTREAM_NO_PROXY_LOOPBACK = "localhost,127.0.0.0/8,::1";

/** Strip brackets/port and lowercase a host for no_proxy matching. */
function noProxyHost(host: string): string {
  const h = host.toLowerCase();
  // Bracketed IPv6 ([::1]:8080) — everything inside the brackets is the host.
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h.slice(1) : h.slice(1, end);
  }
  // Strip a trailing :port when present (bare IPv6 without port has multiple colons).
  if ((h.match(/:/g) ?? []).length === 1) {
    return h.slice(0, h.indexOf(":"));
  }
  return h;
}

/** True when `host` (host[:port], brackets allowed) must bypass the upstream proxy. */
export function matchesUpstreamNoProxy(host: string, set: UpstreamNoProxySet): boolean {
  if (set.domains.includes("*")) return true;
  const h = noProxyHost(host);
  if (set.ips.includes(h)) return true;
  for (const d of set.domains) {
    if (h === d || h.endsWith("." + d)) return true;
  }
  const ip = ipToBigInt(h);
  if (ip !== null) {
    for (const c of set.cidrs) {
      const base = ipToBigInt(c.prefix);
      if (base === null || base.family !== ip.family) continue;
      const bits = BigInt(ip.family === 4 ? 32 : 128);
      const shift = bits - BigInt(c.bits);
      if (ip.value >> shift === base.value >> shift) return true;
    }
  }
  return false;
}

/**
 * Parse an `http://[user:pass@]host:port` upstream proxy URL.
 * Only http CONNECT proxies are supported; anything else throws.
 */
export function parseUpstreamProxy(url: string): UpstreamProxy {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`egress.upstreamProxy: invalid URL '${url}'`);
  }
  if (parsed.protocol !== "http:") {
    throw new Error(`egress.upstreamProxy: only http:// upstream proxies are supported (got '${parsed.protocol}')`);
  }
  if (!parsed.hostname) {
    throw new Error(`egress.upstreamProxy: missing host in '${url}'`);
  }
  const port = parseInt(parsed.port, 10) || 80;
  let authHeader: string | undefined;
  if (parsed.username || parsed.password) {
    const creds = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
    authHeader = "Basic " + Buffer.from(creds, "utf-8").toString("base64");
  }
  return { host: parsed.hostname, port, authHeader };
}

/**
 * Describes a resolved secret ready for the proxy at runtime.
 * The `value` is the real credential; `placeholder` is what the guest sees.
 */
export interface ResolvedSecret {
  env: string;
  value: string;
  placeholder: string;
  hosts: string[];
}

/**
 * Runtime configuration for the egress proxy, after resolving inline values,
 * reading host environment variables, and generating placeholders.
 */
export interface EgressRuntimeConfig {
  policy: EgressPolicy;
  allowHosts: string[];
  denyHosts: string[];
  allowPorts: number[];
  allowAll: boolean;
  enableMitm: boolean;
  secrets: ResolvedSecret[];
  port: number;
  authToken: string;
  /** Resolved PEM content of the custom upstream CA bundle, or undefined. */
  caCert?: string;
  /** Max concurrent connections accepted by the proxy. */
  maxConnections: number;
  /** Max requests per client IP per minute; 0 = unlimited. */
  rateLimitPerMin: number;
  /** Interface the proxy binds to. */
  listenHost: string;
  /** Parsed upstream proxy for host-side chaining, or undefined. */
  upstreamProxy?: UpstreamProxy;
  /** Parsed no_proxy exception set (or raw spec); loopback always appended. */
  upstreamNoProxy?: UpstreamNoProxySet | string | string[];
}

// ---- Port forwarding ----

export interface PortForward {
  /** Host port to listen on (1–65535). */
  hostPort: number;
  /** Guest port to forward to (1–65535). */
  guestPort: number;
  /** Host bind address. Default "127.0.0.1" for security. */
  hostIp?: string;
  /** Protocol: "tcp" (default) or "udp". */
  protocol?: "tcp" | "udp";
  /** Optional description. */
  label?: string;
}

// ---- Main app config ----

export interface SandboxAppConfig {
  guest?: GuestArch;
  accel?: "auto" | "kvm" | "hvf" | "whpx" | "tcg";
  workspaceDir?: string;
  memMb?: number;
  smp?: number;
  balloonMinMb?: number;

  /**
   * Set false to disable Chromium GPU acceleration (app.disableHardwareAcceleration()).
   * The renderer only needs the DOM/canvas path (xterm without the WebGL addon),
   * so this is safe on displays where GLX is broken — e.g. SSH-forwarded X
   * sessions missing XFree86-VidModeExtension, where the GPU process otherwise
   * spams "eglGetMscRateANGLE: glXGetMscRateOML failed".
   * Default: true (GPU acceleration enabled).
   */
  gpuEnabled?: boolean;

  /** Egress proxy configuration. Undefined = proxy started with policy=none (all traffic allowed). */
  egress?: EgressConfig;

  /**
   * Port forwarding rules from host to guest (QEMU hostfwd).
   * Each rule creates a listener on the host that forwards connections to the
   * specified guest port.
   *
   * Default when undefined: `[{ hostPort: 2222, guestPort: 22, label: "SSH debug access" }]`.
   * Set to an empty array `[]` to disable all port forwarding (including SSH).
   */
  portForwards?: PortForward[];

  /**
   * Swap the physical Ctrl and Cmd keys for terminal control (macOS).
   *
   * Some macOS users configure their system to swap the physical Ctrl and Cmd
   * keys. When `true`, the terminal treats the physical Ctrl key — which then
   * arrives as `metaKey` — as the terminal-control modifier (Ctrl+A, Ctrl+C,
   * …) and suppresses the physical Cmd key (arriving as `ctrlKey`) so it does
   * not leak control characters. Copy/paste follow the same modifier
   * (physical Ctrl + Shift + C/V).
   *
   * Default `false` (standard macOS layout): physical Ctrl = `ctrlKey` drives
   * terminal control, physical Cmd = `metaKey` is suppressed.
   */
  swapCtrlCmd?: boolean;
}

/**
 * Fail-closed network config validation. Runs on the loaded config (not the
 * silent JSON fallback) before the VM is started. Throws with a clear message
 * when the configuration cannot be honored — the VM refuses to start.
 */
export function validateNetworkConfig(cfg: SandboxAppConfig): void {
  const egress = cfg.egress ?? {};
  const enforce = egress.enforce ?? true;

  if (enforce) {
    for (const fwd of cfg.portForwards ?? []) {
      if ((fwd.protocol ?? "tcp") !== "tcp") {
        throw new Error(
          `strict network mode (egress.enforce) does not support protocol: "udp" ` +
          `port forwards (hostPort ${fwd.hostPort} → guestPort ${fwd.guestPort}). ` +
          `Remove the rule or set egress.enforce: false for legacy SLIRP networking.`
        );
      }
    }
  }

  if (egress.upstreamProxy !== undefined) {
    // Parse eagerly so a bad URL fails at config load, not on first request.
    parseUpstreamProxy(egress.upstreamProxy);
  }

  if (egress.upstreamNoProxy !== undefined) {
    // Parse eagerly so malformed entries fail at config load.
    parseUpstreamNoProxy(egress.upstreamNoProxy);
  }
}
