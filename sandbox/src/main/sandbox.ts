// Sandbox: orchestrates VM + bridge + sync + snapshot + wisp into one
// lifecycle. Usable headless (tests/CI) or from the Electron main process.
import { EventEmitter } from "events";
import * as path from "path";
import { SandboxVM } from "./vm";
import { HostBridge } from "./bridge";
import { SyncManager } from "./sync-manager";
import { SnapshotManager } from "./snapshot";
import { WispServer, EgressPolicy, DEFAULT_POLICY } from "./wisp";
import { DOH_GATE_HOST, installDohGate } from "./doh";
import { SandboxStatus } from "../shared/ipc";

export interface SandboxConfig {
  hostDir: string; // canonical project directory on the host
  snapshotFile: string; // zstd VM snapshot path
  conflictLog?: string;
  memoryMB?: number;
  egress?: EgressPolicy;
  enableNetwork?: boolean;
  onSerial?: (chunk: string) => void;
}

export class Sandbox extends EventEmitter {
  vm!: SandboxVM;
  bridge!: HostBridge;
  sync!: SyncManager;
  snapshots!: SnapshotManager;
  wisp?: WispServer;
  status: SandboxStatus = { phase: "boot" };

  constructor(private cfg: SandboxConfig) {
    super();
  }

  private setStatus(patch: Partial<SandboxStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  async start(): Promise<void> {
    const t0 = Date.now();

    if (this.cfg.enableNetwork ?? true) {
      this.wisp = new WispServer(this.cfg.egress ?? DEFAULT_POLICY);
      installDohGate({
        hostAllowed: (n) => this.wisp!.hostAllowed(n),
        onResolve: (_h, ip) => this.wisp!.pinIp(ip),
        log: (m) => this.emit("log", m),
      });
      await this.wisp.start();
    }

    const restoring = SnapshotManager.exists(this.cfg.snapshotFile);
    let initialState: ArrayBuffer | undefined;
    if (restoring) {
      this.setStatus({ phase: "restore" });
      try {
        initialState = await SnapshotManager.load(this.cfg.snapshotFile);
      } catch (e: any) {
        this.emit("log", `snapshot load failed, cold booting: ${e.message}`);
      }
    }

    this.vm = new SandboxVM({
      memoryMB: this.cfg.memoryMB ?? 512,
      relayUrl: this.wisp?.relayUrl,
      dohServer: this.wisp ? DOH_GATE_HOST : undefined,
      initialState,
      onSerial: this.cfg.onSerial,
    });
    await this.vm.start();

    this.bridge = new HostBridge(this.vm);
    this.snapshots = new SnapshotManager(this.vm, this.cfg.snapshotFile);
    this.sync = new SyncManager(this.bridge, this.cfg.hostDir, {
      conflictLog: this.cfg.conflictLog,
    });
    this.sync.on("conflict", (rec) => this.emit("conflict", rec));
    this.sync.on("pushed", () => this.snapshots.markActivity());
    this.sync.on("pulled", () => this.snapshots.markActivity());
    this.sync.on("hydrated", () => this.pushStatus());

    if (initialState) {
      // Restored: guest agent + serial session are already live. Re-handshake
      // the bridge so pending maps are clean, then reconcile any drift that
      // happened on the host while we were shut down.
      this.setStatus({ phase: "hydrating", restored: true });
      await this.bridge.hello().catch(() => {});
      await this.reconcileAfterRestore();
    } else {
      // Cold boot: wait for login + guest HELLO, then hydrate.
      const helloP = this.bridge.waitGuestHello(120000);
      await this.vm.waitSerial(/login:/, 120000);
      await this.loginRoot();
      const hello = await helloP;
      let guest = { root: "/workspace", version: 1 };
      try {
        guest = JSON.parse(hello.payload.toString("utf8"));
      } catch {
        /* ignore */
      }
      this.setStatus({ phase: "hydrating", guest });
      await this.waitAgentReady();
      await this.sync.hydrate();
    }

    this.snapshots.start();
    this.setStatus({ phase: "ready", bootMs: Date.now() - t0 });
    this.pushStatus();
  }

  private async loginRoot(): Promise<void> {
    const mark = this.vm.serialLog.length;
    this.vm.serialWrite("root\n");
    await this.vm.waitSerial(/Password:/, 15000, mark);
    this.vm.serialWrite("root\n");
    await this.vm.waitSerial(/:~#/, 15000, mark);
  }

  private async waitAgentReady(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      try {
        await this.bridge.ping(3000);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error("guest sync-agent never became responsive");
  }

  private async reconcileAfterRestore(): Promise<void> {
    // Ask the guest for its manifest, then hydrate() diffs host→guest.
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      this.sync.once("guest-manifest", done);
      setTimeout(done, 5000); // proceed even if guest is quiet
    });
    await this.sync.hydrate();
  }

  /** run a shell line in the guest via the serial root session */
  async runInGuest(cmd: string, expect: RegExp, timeoutMs = 30000): Promise<string> {
    const mark = this.vm.serialLog.length;
    this.vm.serialWrite(cmd + "\n");
    return this.vm.waitSerial(expect, timeoutMs, mark);
  }

  async saveSnapshot(): Promise<void> {
    const res = await this.snapshots.save();
    this.setStatus({ snapshot: { at: Date.now(), compressedBytes: res.compressedBytes } });
  }

  private pushStatus(): void {
    this.setStatus({
      sync: { ...this.sync.stats },
      net: this.wisp
        ? {
            relayUrl: this.wisp.relayUrl,
            policyHosts: (this.cfg.egress ?? DEFAULT_POLICY).allowHosts.map(String),
          }
        : undefined,
    });
  }

  async stop(): Promise<void> {
    this.snapshots?.stop();
    await this.sync?.stop();
    this.vm?.stop();
    await this.wisp?.stop();
    this.setStatus({ phase: "stopped" });
  }
}

export function defaultPaths(root = process.cwd()) {
  return {
    hostDir: path.join(root, "workspace"),
    snapshotFile: path.join(root, "snapshots", "vm.zst"),
    conflictLog: path.join(root, "snapshots", "conflicts.log"),
  };
}
