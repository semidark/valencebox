import { EventEmitter } from "events";
import * as fsp from "fs/promises";
import * as net from "net";
import { QemuProcess, QemuOptions } from "./qemu";
import { GuestProfile } from "./guest-profile";
import { PtyChannel } from "./pty-channel";


export interface VmManagerOptions {
  memoryMB: number;
  smp: number;
  tmpDir: string;
  accel?: "auto" | "kvm" | "hvf" | "whpx" | "tcg";
  guestProfile: GuestProfile;
  kernel?: string;
  initrd?: string;
  kernelCmdline?: string;
  rootImage?: string;
  workspaceImage?: string;
  sharePort?: number;
  shareToken?: string;
  balloonMinMb?: number;
}

export class VmManager extends EventEmitter {
  private qemu: QemuProcess;
  private serialClient: net.Socket | null = null;
  private _serialLog = "";
  private ptyChannel: PtyChannel | null = null;

  constructor(private opts: VmManagerOptions) {
    super();
    this.qemu = new QemuProcess();
  }

  async start(): Promise<void> {
    this.qemu.on("qmp:event", (event: string) => this.emit("qmp:event", event));
    this.qemu.on("accel", (info: { name: string; available: boolean }) => this.emit("accel", info));
    await this.qemu.start(this.opts as QemuOptions);
    this.connectSerial();
    this.connectPty();
  }

  get qemuProcess(): QemuProcess {
    return this.qemu;
  }

  async stop(): Promise<void> {
    this.ptyChannel?.disconnect();
    this.ptyChannel = null;
    this.serialClient?.destroy();
    this.serialClient = null;
    await this.qemu.stop();
    await fsp.rm(this.opts.tmpDir, { recursive: true, force: true });
  }

  sendInput(data: string): void {
    if (this.serialClient && this.serialClient.writable) {
      this.serialClient.write(data);
    }
  }

  get running(): boolean {
    return this.qemu.running;
  }

  get pid(): number | undefined {
    return this.qemu.pid;
  }

  get bootMs(): number | undefined {
    return this.qemu.bootMs;
  }

  get serialLog(): string {
    return this._serialLog;
  }

  private get balloonMinMb(): number {
    return this.opts.balloonMinMb ?? 2048;
  }

  /** Set balloon target in MB. Clamped to [balloonMinMb, memoryMB]. */
  async setBalloon(mb: number): Promise<void> {
    const clamped = Math.max(this.balloonMinMb, Math.min(this.opts.memoryMB, mb));
    await this.qemu.qmp?.setBalloon(clamped);
  }

  sendPtyInput(data: Uint8Array): void {
    this.ptyChannel?.sendInput(data);
  }

  resizePty(cols: number, rows: number): void {
    this.ptyChannel?.resize(cols, rows);
  }

  /** Query current balloon state. Returns { currentMB, ceilingMB, minMB } or null. */
  async getBalloon(): Promise<{ currentMB: number; ceilingMB: number; minMB: number } | null> {
    if (!this.qemu.qmp?.connected) return null;
    const result = await this.qemu.qmp.queryBalloon();
    return { currentMB: Math.round(result.actual / (1024 * 1024)), ceilingMB: this.opts.memoryMB, minMB: this.balloonMinMb };
  }

  /** Wait for a regex match in the serial log. Returns the full matched text. */
  waitSerial(re: RegExp, timeoutMs: number, from?: number): Promise<string> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const poll = () => {
        const haystack = from !== undefined ? this._serialLog.slice(from) : this._serialLog;
        const m = haystack.match(re);
        if (m) return resolve(m[0]);
        if (Date.now() - start >= timeoutMs) {
          return reject(new Error(`waitSerial timeout ${timeoutMs}ms for ${re}`));
        }
        setTimeout(poll, 200);
      };
      poll();
    });
  }

  private connectPty(): void {
    const transport = this.qemu.ptyTransport;
    if (!transport) return;
    this.ptyChannel = new PtyChannel(transport);
    this.ptyChannel.on("data", (chunk: Uint8Array) => this.emit("pty:data", chunk));
    this.ptyChannel.on("closed", () => this.emit("pty:closed"));
    this.ptyChannel.on("error", (err) => console.error("[pty] channel error:", err));
    this.ptyChannel.connect();
  }

  private connectSerial(): void {
    const transport = this.qemu.serialTransport;
    if (!transport) return;

    if (transport.type === "unix") {
      this.serialClient = net.createConnection(transport.connectPath);
    } else {
      this.serialClient = net.createConnection(Number(transport.connectPath), "127.0.0.1");
    }

    this.serialClient.on("connect", () => {
      this.emit("serial:connected");
    });

    this.serialClient.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      this._serialLog += text;
      if (this._serialLog.length > 65536) {
        this._serialLog = this._serialLog.slice(-65536);
      }
      this.emit("serial:data", text);
    });

    this.serialClient.on("close", () => {
      this.emit("serial:closed");
      this.serialClient = null;
    });

    this.serialClient.on("error", (err) => {
      this.emit("serial:error", err);
    });
  }
}
