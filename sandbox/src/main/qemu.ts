import { ChildProcess, spawn, execSync } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import { EventEmitter } from "events";
import { qemuBinaryPath, firmwareDir, allocSerialTransport, allocQmpTransport, VmTransport } from "./asset-paths";
import { QmpClient } from "./qmp";

export interface QemuOptions {
  memoryMB: number;
  smp: number;
  tmpDir: string;
  accel?: "auto" | "kvm" | "hvf" | "whpx" | "tcg";
  freeze?: boolean;
  kernel?: string;
  initrd?: string;
  kernelCmdline?: string;
  rootImage?: string;
  workspaceImage?: string;
  fwCfgConfig?: string;
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
  public serialTransport: VmTransport | null = null;
  public qmpTransport: VmTransport | null = null;
  public machineType: "microvm" | "pc" = "pc";

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
    this.serialTransport = await allocSerialTransport(opts.tmpDir);
    this.qmpTransport = await allocQmpTransport(opts.tmpDir);

    const detected = QemuProcess.checkAccel(process.platform);
    const hw = opts.accel && opts.accel !== "auto" && opts.accel !== "tcg"
      ? { name: opts.accel, available: opts.accel === detected.name && detected.available, hint: detected.hint }
      : detected;
    console.log(`[qemu] accel: ${hw.name}${hw.available ? "" : " (unavailable)"}`);
    if (hw.hint) console.log(`[qemu] ${hw.hint}`);
    this.emit("accel", hw);

    const args = this.buildArgs(opts);
    console.log(`[qemu] machine: ${this.machineType}`);
    const binPath = qemuBinaryPath();

    if (!fs.existsSync(binPath)) {
      throw new Error(`QEMU binary not found at ${binPath}`);
    }

    this.proc = spawn(binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
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

    // chmod Unix sockets after QEMU creates them
    if (this.serialTransport.type === "unix") {
      this.chmodSocket(this.serialTransport.connectPath).catch(() => {});
      this.chmodSocket(this.qmpTransport.connectPath).catch(() => {});
    }

    const qmpLabel = this.qmpTransport.type === "unix"
      ? this.qmpTransport.connectPath
      : `127.0.0.1:${this.qmpTransport.connectPath}`;
    console.log(`[qemu] spawned PID ${proc.pid}, waiting for QMP on ${qmpLabel}`);

    this.qmp = new QmpClient();
    try {
      if (this.qmpTransport.type === "unix") {
        await this.qmp.connectPath(this.qmpTransport.connectPath, 15_000);
      } else {
        await this.qmp.connect(Number(this.qmpTransport.connectPath), "127.0.0.1", 15_000);
      }
    } catch (e) {
      if (this.proc?.exitCode !== null && stderrChunks.length > 0) {
        const msg = Buffer.concat(stderrChunks).toString("utf8").trim();
        throw new Error(`QEMU exited during startup (exit code ${proc.exitCode ?? "?"}): ${msg}`);
      }
      throw e;
    }
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
    // Use microvm when hardware acceleration is available (first accel isn't TCG);
    // fall back to pc (i440fx) under TCG so the guest has HPET for TSC calibration.
    const useMicrovm = accels[0] !== "tcg,thread=multi";
    const machineType = useMicrovm ? "microvm" : "pc";
    this.machineType = machineType;

    const args: string[] = [];

    if (opts.freeze) args.push("-S");
    for (const a of accels) args.push("-accel", a);
    args.push(
      "-machine", machineType,
      "-m", `${opts.memoryMB}`,
      "-smp", `${opts.smp}`,
      "-nodefaults",
      "-no-user-config",
      "-nographic",
      "-no-reboot",
    );

    // QMP transport (put before serial so monitor init happens first on Windows)
    const qmpTr = this.qmpTransport!;
    const qmpArg = qmpTr.type === "unix"
      ? `unix:${qmpTr.local},server,nowait`
      : `tcp:127.0.0.1:${qmpTr.local},server,nowait`;
    args.push("-qmp", qmpArg);

    // Serial transport arg
    const serialTr = this.serialTransport!;
    const serialArg = serialTr.type === "unix"
      ? `unix:${serialTr.local},server,nowait`
      : `tcp:127.0.0.1:${serialTr.local},server,nowait`;
    args.push("-serial", serialArg);

    const fwDir = firmwareDir();
    if (fwDir) args.push("-L", fwDir);

    if (opts.kernel) args.push("-kernel", opts.kernel);
    if (opts.initrd) args.push("-initrd", opts.initrd);
    if (opts.kernelCmdline) {
      // microvm needs reboot=t (triple-fault reboot) for -no-reboot to work
      const cmdline = useMicrovm ? `${opts.kernelCmdline} reboot=t` : opts.kernelCmdline;
      args.push("-append", cmdline);
    }

    const blkDev = useMicrovm ? "virtio-blk-device" : "virtio-blk-pci";
    const netDev = useMicrovm ? "virtio-net-device" : "virtio-net-pci";

    const rootImg = opts.rootImage;
    if (rootImg) {
      args.push(
        "-drive", `id=root,file=${rootImg},format=qcow2,if=none`,
        "-device", `${blkDev},drive=root`,
      );
    }

    if (opts.workspaceImage) {
      args.push(
        "-drive", `id=ws,file=${opts.workspaceImage},format=qcow2,if=none`,
        "-device", `${blkDev},drive=ws`,
      );
    }

    args.push("-netdev", "user,id=net0", "-device", `${netDev},netdev=net0`);

    if (opts.fwCfgConfig) {
      args.push("-fw_cfg", `name=opt/org.valencebox.config,file=${opts.fwCfgConfig}`);
    }

    return args;
  }

  /** Poll for a Unix socket to appear, then chmod 0600 to restrict access. */
  private async chmodSocket(sockPath: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        await fsp.chmod(sockPath, 0o600);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    // Non-fatal — socket works, just less restrictive
  }

  static checkAccel(platform: string): { name: string; available: boolean; hint?: string } {
    if (platform === "linux") {
      try {
        fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
        return { name: "kvm", available: true };
      } catch {
        return {
          name: "kvm", available: false,
          hint: "user not in kvm group? try: sudo usermod -aG kvm $USER && logout/login",
        };
      }
    }
    if (platform === "darwin") {
      // HVF is built into macOS — just check we're on a supported version
      return { name: "hvf", available: true };
    }
    if (platform === "win32") {
      const whpxAvailable = QemuProcess.checkWhpx();
      return whpxAvailable
        ? { name: "whpx", available: true }
        : { name: "whpx", available: false, hint: "WHPX not available — enable Windows Hypervisor Platform (Windows Features) or use -accel tcg" };
    }
    return { name: "tcg", available: true };
  }

  /** Check if WHPX (Windows Hypervisor Platform) is available. */
  private static checkWhpx(): boolean {
    try {
      execSync("sc.exe query whpx", { stdio: "pipe", windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  private resolveAccels(override?: string): string[] {
    if (override && override !== "auto") {
      if (override === "tcg") return ["tcg,thread=multi"];
      const accelInfo = QemuProcess.checkAccel(process.platform);
      if (accelInfo.name === override && accelInfo.available) {
        return [override, "tcg,thread=multi"];
      }
      return ["tcg,thread=multi"];
    }
    const accels: string[] = [];
    {
      const info = QemuProcess.checkAccel(process.platform);
      if (info.available) accels.push(info.name);
    }
    accels.push("tcg,thread=multi");
    return accels;
  }

  private async waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
