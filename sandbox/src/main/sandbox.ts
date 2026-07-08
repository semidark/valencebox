// Sandbox: orchestrates VM + bridge + sync + snapshot + wisp into one
// lifecycle. Usable headless (tests/CI) or from the Electron main process.
import { EventEmitter } from "events";
import * as path from "path";
import { SandboxVM } from "./vm";
import { HostBridge } from "./bridge";
import { SyncManager } from "./sync-manager";
import { SnapshotManager } from "./snapshot";
import { WispServer, EgressPolicy, DEFAULT_POLICY } from "./wisp";
import { DataPlane } from "./data-plane";
import { PtyTerminal } from "./terminal";
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
  dataPlane?: DataPlane;
  ptyTerminal?: PtyTerminal;
  status: SandboxStatus = { phase: "boot" };
  private stopping = false;

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
      this.dataPlane = new DataPlane();
      this.dataPlane.on("log", (m) => this.emit("log", m));
      this.wisp.attachDataPlane(this.dataPlane);
      installDohGate({
        hostAllowed: (n) => this.wisp!.hostAllowed(n),
        onResolve: (_h, ip) => this.wisp!.pinIp(ip),
        log: (m) => this.emit("log", m),
      });
      await this.wisp.start();
    }

    const restoring = SnapshotManager.usable(this.cfg.snapshotFile);
    if (!restoring && SnapshotManager.exists(this.cfg.snapshotFile)) {
      this.emit("log", "snapshot is from different disk images — cold booting");
    }
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
    if (this.dataPlane) {
      this.bridge.helloExtra = { dataPlane: this.dataPlane.advert() };
    }
    this.snapshots = new SnapshotManager(this.vm, this.cfg.snapshotFile);
    this.sync = new SyncManager(this.bridge, this.cfg.hostDir, {
      conflictLog: this.cfg.conflictLog,
      expectDataChannel: !!this.dataPlane,
    });
    this.sync.on("conflict", (rec) => this.emit("conflict", rec));
    this.sync.on("pushed", () => this.snapshots.markActivity());
    this.sync.on("pulled", () => this.snapshots.markActivity());
    this.sync.on("hydrated", () => this.pushStatus());
    this.sync.on("throughput", () => this.pushStatus());
    this.dataPlane?.on("channel", (ch) => {
      this.sync.attachDataChannel(ch);
      this.emit("log", "data plane connected (bulk sync over virtio-net TCP)");
      this.pushStatus();
    });
    this.dataPlane?.on("close", () => {
      this.sync.detachDataChannel();
      this.emit("log", "data plane disconnected — falling back to console");
      this.pushStatus();
    });

    if (initialState) {
      // Restored: guest agent + serial session are already live. Re-handshake
      // the bridge so pending maps are clean, then reconcile any drift that
      // happened on the host while we were shut down.
      this.setStatus({ phase: "hydrating", restored: true });
      await this.bridge.hello().catch(() => {});
      await this.reconcileAfterRestore();
      this.nudgeTerminalAfterRestore();
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
      await this.waitDataPlane();
      await this.sync.hydrate();
      // Hydration can write the guest's entire synced workspace into hdb in
      // one pass; proactively flush its disk-cache now instead of waiting
      // for size-triggered eviction to catch up (see vm.ts flushDisks doc).
      await this.vm.flushDisks();
    }

    this.snapshots.start();
    this.setStatus({ phase: "ready", bootMs: Date.now() - t0 });
    this.pushStatus();

    // Open a PTY terminal for interactive use (replaces serial as the primary
    // terminal). The serial console (ttyS0) stays as a boot/fallback channel.
    try {
      this.ptyTerminal = new PtyTerminal(this.bridge);
      this.ptyTerminal.on("data", (chunk: Uint8Array) => this.emit("pty:data", chunk));
      this.ptyTerminal.on("closed", () => {
        this.emit("pty:closed");
        this.schedulePtyReopen();
      });
      await this.ptyTerminal.start(24, 80);
      this.ptyRetries = 0;
      this.emit("log", "pty: session opened");
    } catch (e: any) {
      this.emit("log", `pty: open failed — falling back to serial: ${e.message}`);
    }
  }

  private ptyRetries = 0;
  private schedulePtyReopen(): void {
    if (this.stopping) return;
    if (this.ptyRetries >= 5) {
      this.emit("log", "pty: max retries reached — staying on serial");
      return;
    }
    this.ptyRetries++;
    const delay = Math.min(500 * this.ptyRetries, 3000);
    this.emit("log", `pty: reopening in ${delay}ms (attempt ${this.ptyRetries})`);
    setTimeout(async () => {
      if (this.stopping || !this.ptyTerminal) return;
      try {
        await this.ptyTerminal.start(24, 80);
        this.ptyRetries = 0;
        this.emit("log", "pty: session reopened");
      } catch (e: any) {
        this.emit("log", `pty: reopen failed: ${e.message}`);
        this.schedulePtyReopen();
      }
    }, delay);
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
    // Wait for the guest manifest, which arrives as multiple frames for big
    // workspaces: settle 1s after the last part (cap 10s; proceed if quiet).
    await new Promise<void>((resolve) => {
      let settle: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(cap);
        if (settle) clearTimeout(settle);
        this.sync.off("guest-manifest", onPart);
        resolve();
      };
      const cap = setTimeout(done, 10000);
      const onPart = () => {
        if (settle) clearTimeout(settle);
        settle = setTimeout(done, 1000);
      };
      this.sync.on("guest-manifest", onPart);
      settle = setTimeout(done, 5000); // guest silent → proceed
    });
    await this.waitDataPlane();
    await this.sync.hydrate();
    await this.vm.flushDisks();
  }

  private nudgeTerminalAfterRestore(): void {
    // Best-effort: force the guest shell to print a fresh prompt so the
    // user sees the terminal is alive after a warm restore.
    try {
      this.vm.serialWrite(" echo '[sandbox] restored' && reset\n");
    } catch {
      // ignore — restore still completed successfully
    }
  }

  /**
   * Give the guest a moment to dial the data plane so hydrate runs fast.
   * The guest starts dialing as soon as it gets the advert (in the ACK to
   * its own early console HELLO) — independent of, and roughly concurrent
   * with, the login handshake this waits on beforehand. So by the time this
   * runs, the two are typically neck-and-neck; on a loaded machine or a
   * slow DHCP/WISP negotiation the data plane can lose that race by more
   * than a few seconds. Falls back to the console if it still isn't there —
   * but hydrate() itself keeps checking for a late connection (see there),
   * so this timeout only controls how long we delay the *start* of hydrate,
   * not whether the fast path gets used at all.
   */
  private async waitDataPlane(timeoutMs = 25000): Promise<void> {
    if (!this.dataPlane || this.dataPlane.channel) return;
    await this.dataPlane.waitChannel(timeoutMs).catch(() => {
      this.emit("log", "data plane not connected yet — hydrating over console (will switch over if it connects mid-hydrate)");
    });
  }

  /** forward raw keystrokes from the UI terminal to the guest serial line */
  sendInput(data: string): void {
    this.vm.serialWrite(data);
  }

  /** send keystrokes to the PTY terminal (if open) */
  sendPtyInput(data: Uint8Array): void {
    this.ptyTerminal?.sendInput(data);
  }

  /** resize the PTY terminal (if open) */
  resizePty(cols: number, rows: number): void {
    this.ptyTerminal?.resize(cols, rows);
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
      sync: { ...this.sync.stats, throughput: { ...this.sync.syncThroughput } },
      net: this.wisp
        ? {
            relayUrl: this.wisp.relayUrl,
            policyHosts: (this.cfg.egress ?? DEFAULT_POLICY).allowHosts.map(String),
            dataPlane: this.sync?.dataChannelActive ?? false,
          }
        : undefined,
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.ptyTerminal?.close();
    this.snapshots?.stop();
    await this.sync?.stop();
    // Best-effort final checkpoint so a graceful quit doesn't lose ground to
    // the periodic idle-gated snapshot (snapshot.ts). Safe once the guest
    // handshake succeeded — "hydrating" and "ready" are both past that point
    // ("boot"/"restore" precede vm.start(), and a restore replays hello()
    // rather than the login flow, so a pre-handshake snapshot from those
    // phases wouldn't restore correctly).
    if (this.snapshots && (this.status.phase === "hydrating" || this.status.phase === "ready")) {
      try {
        await this.saveSnapshot();
      } catch (e: any) {
        this.emit("log", `final snapshot failed: ${e.message}`);
      }
    }
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
