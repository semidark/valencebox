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
}
