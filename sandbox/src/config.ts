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
}

// ---- Main app config ----

export interface SandboxAppConfig {
  guest?: GuestArch;
  accel?: "auto" | "kvm" | "hvf" | "whpx" | "tcg";
  workspaceDir?: string;
  memMb?: number;
  smp?: number;
  balloonMinMb?: number;

  /** Egress proxy configuration. Undefined = proxy started with policy=none (all traffic allowed). */
  egress?: EgressConfig;
}
