import { EventEmitter } from "events";
import * as fsp from "fs/promises";
import * as net from "net";
import { QemuProcess, QemuOptions } from "./qemu";


export interface VmManagerOptions {
  memoryMB: number;
  smp: number;
  tmpDir: string;
  accel?: "auto" | "kvm" | "hvf" | "whpx" | "tcg";
  kernel?: string;
  initrd?: string;
  kernelCmdline?: string;
  rootImage?: string;
  workspaceImage?: string;
  fwCfgConfig?: string;
}

export class VmManager extends EventEmitter {
  private qemu: QemuProcess;
  private serialClient: net.Socket | null = null;
  private _serialLog = "";

  constructor(private opts: VmManagerOptions) {
    super();
    this.qemu = new QemuProcess();
  }

  async start(): Promise<void> {
    this.qemu.on("qmp:event", (event: string) => this.emit("qmp:event", event));
    this.qemu.on("accel", (info: { name: string; available: boolean }) => this.emit("accel", info));
    await this.qemu.start(this.opts);
    this.connectSerial();
  }

  get qemuProcess(): QemuProcess {
    return this.qemu;
  }

  async stop(): Promise<void> {
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
