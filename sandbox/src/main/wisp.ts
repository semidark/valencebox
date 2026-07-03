// WISP egress server — the ONLY network path out of the guest.
// v86's virtio NIC relays ethernet over a WebSocket to this server, which
// terminates TCP/UDP in userspace (no TAP device, no host root). The
// allowlist enforced here is the sandbox's egress policy.
import * as http from "http";
import { AddressInfo } from "net";

export interface EgressPolicy {
  /** hostnames allowed out (exact names or RegExp). Empty array = deny all. */
  allowHosts: (string | RegExp)[];
  /** ports allowed out (defaults: 80, 443) */
  allowPorts?: (number | [number, number])[];
  allowUdp?: boolean;
}

/** Default policy: package registries + apk mirrors only. */
export const DEFAULT_POLICY: EgressPolicy = {
  allowHosts: [
    /(^|\.)dl-cdn\.alpinelinux\.org$/,
    /(^|\.)registry\.npmjs\.org$/,
    /(^|\.)pypi\.org$/,
    /(^|\.)files\.pythonhosted\.org$/,
    /(^|\.)proxy\.golang\.org$/,
    /(^|\.)crates\.io$/,
    /(^|\.)static\.crates\.io$/,
  ],
  allowPorts: [80, 443],
  allowUdp: false,
};

function toRegex(h: string | RegExp): RegExp {
  if (h instanceof RegExp) return h;
  // exact hostname match (and subdomains), escaped
  const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\.)${esc}$`, "i");
}

export class WispServer {
  private server?: http.Server;
  private wisp: any;
  // The v86 wisp adapter opens streams BY RESOLVED IP, never by hostname.
  // Enforcement is therefore IP-pinning: only IPs that the DoH gate answered
  // for allowlisted hostnames are connectable (see doh.ts).
  private pinnedIps = new Set<string>();
  // in-process sync data plane (see data-plane.ts): its VIP/port join the
  // whitelist and its socket class replaces the stock one for all streams
  private vip?: { ip: string; port: number; socketClass: any };
  port = 0;

  constructor(private policy: EgressPolicy = DEFAULT_POLICY) {}

  /** route an internal VIP to an in-process socket class (before start()) */
  attachDataPlane(dp: { advert(): { ip: string; port: number }; socketClass(): any }): void {
    const a = dp.advert();
    this.vip = { ip: a.ip, port: a.port, socketClass: dp.socketClass() };
    if (this.wisp) this.applyPolicy();
  }

  /** wisp:// URL for v86's net_device.relay_url */
  get relayUrl(): string {
    return `wisp://127.0.0.1:${this.port}/`;
  }

  setPolicy(policy: EgressPolicy): void {
    this.policy = policy;
    this.pinnedIps.clear();
    if (this.wisp) this.applyPolicy();
  }

  /** does the egress policy allow this hostname? (used by the DoH gate) */
  hostAllowed(name: string): boolean {
    return this.policy.allowHosts.some((h) => toRegex(h).test(name));
  }

  /** allow connections to an IP the DoH gate resolved for an allowed host */
  pinIp(ip: string): void {
    if (this.pinnedIps.has(ip)) return;
    this.pinnedIps.add(ip);
    if (this.pinnedIps.size > 512) {
      // crude cap: reset and let fresh DNS answers repopulate
      this.pinnedIps.clear();
      this.pinnedIps.add(ip);
    }
    if (this.wisp) this.applyPolicy();
  }

  private applyPolicy(): void {
    const o = this.wisp.options;
    // whitelist matches the CONNECT "hostname" field — which is an IP here
    const ips = [...this.pinnedIps];
    const ports: (number | [number, number])[] = [...(this.policy.allowPorts ?? [80, 443])];
    if (this.vip) {
      ips.push(this.vip.ip);
      ports.push(this.vip.port);
      if (this.pinnedIps.has(this.vip.ip)) {
        // a DoH answer collided with the sync VIP — the VIP shadows it
        console.warn(`wisp: pinned IP collides with sync VIP ${this.vip.ip}`);
      }
    }
    o.hostname_whitelist = ips.map((ip) => new RegExp(`^${ip.replace(/\./g, "\\.")}$`));
    o.port_whitelist = ports;
    o.allow_udp_streams = this.policy.allowUdp ?? false;
    o.allow_direct_ip = true; // IPs are the only currency; whitelist gates them
    o.allow_private_ips = false;
    o.allow_loopback_ips = false;
  }

  async start(port = 0): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod: any = require("@mercuryworkshop/wisp-js/server");
    this.wisp = mod.server;
    mod.logging?.set_level?.(mod.logging.WARN);
    this.applyPolicy();

    this.server = http.createServer((_req, res) => {
      res.writeHead(426, { "Content-Type": "text/plain" });
      res.end("wisp endpoint");
    });
    this.server.on("upgrade", (req, socket, head) => {
      this.wisp.routeRequest(
        req,
        socket,
        head,
        this.vip ? { TCPSocket: this.vip.socketClass } : {}
      );
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        this.port = (this.server!.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
