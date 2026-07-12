import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { qemuBinaryPath, firmwareDir, serialSockPath, qmpSockPath } from "./asset-paths";
import { QmpClient } from "./qmp";

export interface QemuOptions {
  memoryMB: number;
  smp: number;
  tmpDir: string;
  accel?: "auto" | "kvm" | "hvf" | "whpx" | "tcg";
  kernel?: string;
  initrd?: string;
  rootImage?: string;
  workspaceImage?: string;
}

export interface QemuStats {
  running: boolean;
  pid: number | undefined;
  bootMs: number | undefined;
}

export class QemuProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private startedAt = 0;
  private qmp: QmpClient | null = null;
  public serialPath = "";
  public qmpPath = "";

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get bootMs(): number | undefined {
    return this.startedAt ? Date.now() - this.startedAt : undefined;
  }

  stats(): QemuStats {
    return { running: this.running, pid: this.pid, bootMs: this.bootMs };
  }

  async start(opts: QemuOptions): Promise<void> {
    this.startedAt = Date.now();
    this.serialPath = serialSockPath(opts.tmpDir);
    this.qmpPath = qmpSockPath(opts.tmpDir);

    const args = this.buildArgs(opts);
    const binPath = qemuBinaryPath();

    if (!fs.existsSync(binPath)) {
      throw new Error(`QEMU binary not found at ${binPath}`);
    }

    this.proc = spawn(binPath, args, {
      stdio: ["ignore", "pipe", "inherit"],
    });

    const stderrChunks: Buffer[] = [];
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      process.stderr.write(chunk);
    });
    this.proc.on("exit", () => {
      if (stderrChunks.length > 0) {
        const msg = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (msg) this.emit("stderr", msg);
      }
    });

    const proc = this.proc;

    proc.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      console.log(`[qemu] process exited: ${reason}`);
      this.emit("exit", { code, signal, reason });
      if (this.proc === proc) this.proc = null;
    });

    proc.on("error", (err) => {
      console.error(`[qemu] process error:`, err);
      this.emit("error", err);
    });

    console.log(`[qemu] spawned PID ${proc.pid}, waiting for serial socket at ${this.serialPath}`);
    await this.waitForSocket(this.serialPath, 15_000);
    console.log(`[qemu] serial socket ready`);
    await this.waitForSocket(this.qmpPath, 15_000);
    console.log(`[qemu] QMP socket ready`);

    this.qmp = new QmpClient();
    await this.qmp.connect(this.qmpPath);
    await this.qmp.execute("qmp_capabilities");
    console.log(`[qemu] QMP handshake complete`);

    this.qmp.on("event", (event: string) => {
      this.emit("qmp:event", event);
    });
  }

  async queryStatus(): Promise<{ status: string; running: boolean }> {
    if (!this.qmp?.connected) throw new Error("QMP not connected");
    return this.qmp.execute("query-status") as Promise<{ status: string; running: boolean }>;
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;

    try {
      if (this.qmp?.connected) {
        const status = await this.queryStatus();
        if (status.running) {
          await this.qmp.execute("system_powerdown");
          await this.waitForExit(proc, timeoutMs);
        }
      }
    } catch {
      // QMP failed — fall through to kill
    }
    this.qmp?.disconnect();
    this.qmp = null;

    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await this.waitForExit(proc, timeoutMs);
    }
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
      await this.waitForExit(proc, 5_000);
    }
  }

  private buildArgs(opts: QemuOptions): string[] {
    const accels = this.resolveAccels(opts.accel);
    const args: string[] = [];

    for (const a of accels) args.push("-accel", a);
    args.push(
      "-machine", "microvm",
      "-m", `${opts.memoryMB}`,
      "-smp", `${opts.smp}`,
      "-nodefaults",
      "-no-user-config",
      "-nographic",
      "-no-reboot",
      "-serial", `unix:${this.serialPath},server,nowait`,
      "-qmp", `unix:${this.qmpPath},server,nowait`,
    );

    const fwDir = firmwareDir();
    if (fwDir) args.push("-L", fwDir);

    if (opts.kernel) args.push("-kernel", opts.kernel);
    if (opts.initrd) args.push("-initrd", opts.initrd);

    const rootImg = opts.rootImage;
    if (rootImg) {
      args.push(
        "-drive", `id=root,file=${rootImg},format=qcow2,if=none`,
        "-device", "virtio-blk-device,drive=root",
      );
    }

    if (opts.workspaceImage) {
      args.push(
        "-drive", `id=ws,file=${opts.workspaceImage},format=qcow2,if=none`,
        "-device", "virtio-blk-device,drive=ws",
      );
    }

    args.push("-netdev", "user,id=net0", "-device", "virtio-net-device,netdev=net0");

    return args;
  }

  private resolveAccels(override?: string): string[] {
    if (override && override !== "auto") {
      if (override === "tcg") return ["tcg,thread=multi"];
      return [override, "tcg,thread=multi"];
    }
    const accels: string[] = [];
    if (process.platform === "linux") accels.push("kvm");
    if (process.platform === "darwin") accels.push("hvf");
    if (process.platform === "win32") accels.push("whpx");
    accels.push("tcg,thread=multi");
    return accels;
  }

  private async waitForSocket(sockPath: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(sockPath)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`QEMU socket ${sockPath} not ready within ${timeoutMs}ms`);
  }

  private async waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
