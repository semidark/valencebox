import { ChildProcess, spawn, spawnSync, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as fsp from "fs/promises";
import { EventEmitter } from "events";
import { qemuBinaryPath, firmwareDir, qemuPlatformDir, allocSerialTransport, allocQmpTransport, VmTransport } from "./asset-paths";
import { QmpClient } from "./qmp";
import { GuestProfile } from "./guest-profile";

export interface QemuOptions {
  memoryMB: number;
  smp: number;
  tmpDir: string;
  accel?: "auto" | "kvm" | "hvf" | "whpx" | "tcg";
  freeze?: boolean;
  guestProfile: GuestProfile;
  kernel?: string;
  initrd?: string;
  kernelCmdline?: string;
  rootImage?: string;
  workspaceImage?: string;
  sharePort?: number;
  shareToken?: string;
}

export interface QemuStats {
  running: boolean;
  pid: number | undefined;
  bootMs: number | undefined;
}

export class QemuProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private startedAt = 0;
  private _qmp: QmpClient | null = null;

  /** Expose QMP client for balloon control and other direct QMP calls. */
  get qmp(): QmpClient | null { return this._qmp; }
  public serialTransport: VmTransport | null = null;
  public qmpTransport: VmTransport | null = null;
  public machineType: "microvm" | "pc" | "virt" = "pc";

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

    const detected = QemuProcess.checkAccel(process.platform, opts.guestProfile.arch);
    const hw = opts.accel && opts.accel !== "auto" && opts.accel !== "tcg"
      ? { name: opts.accel, available: opts.accel === detected.name && detected.available, hint: detected.hint }
      : detected;
    console.log(`[qemu] accel: ${hw.name}${hw.available ? "" : " (unavailable)"}`);
    if (hw.hint) console.log(`[qemu] ${hw.hint}`);
    this.emit("accel", hw);

    const args = this.buildArgs(opts);
    const binPath = qemuBinaryPath(opts.guestProfile.arch);
    const fwDir = firmwareDir();
    console.log(`[qemu] binary: ${binPath}`);
    console.log(`[qemu] firmware: ${fwDir || "(none, using QEMU built-in search path)"}`);
    console.log(`[qemu] machine: ${this.machineType}`);

    // If binPath contains a path separator, it's a path — verify it exists.
    // If it's just a name (bare executable, no separator), let the OS resolve via $PATH.
    const isPath = binPath.includes("/") || (process.platform === "win32" && binPath.includes("\\"));
    if (isPath && !fs.existsSync(binPath)) {
      throw new Error(`QEMU binary not found at ${binPath}`);
    }

    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    if (process.platform === "darwin") {
      const libDir = path.join(qemuPlatformDir(), "lib");
      if (fs.existsSync(libDir)) {
        spawnEnv.DYLD_LIBRARY_PATH = [libDir, spawnEnv.DYLD_LIBRARY_PATH].filter(Boolean).join(":");
      }
    }

    this.proc = spawn(binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv,
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

    const qmp = new QmpClient();
    this._qmp = qmp;
    try {
      if (this.qmpTransport.type === "unix") {
        await qmp.connectPath(this.qmpTransport.connectPath, 15_000);
      } else {
        await qmp.connect(Number(this.qmpTransport.connectPath), "127.0.0.1", 15_000);
      }
    } catch (e) {
      if (this.proc?.exitCode !== null && stderrChunks.length > 0) {
        const msg = Buffer.concat(stderrChunks).toString("utf8").trim();
        throw new Error(`QEMU exited during startup (exit code ${proc.exitCode ?? "?"}): ${msg}`);
      }
      throw e;
    }
    await qmp.execute("qmp_capabilities");
    console.log(`[qemu] QMP handshake complete (${this.bootMs}ms)`);

    qmp.on("event", (event: string) => {
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
    this._qmp?.disconnect();
    this._qmp = null;

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
    const profile = opts.guestProfile;
    const accels = this.resolveAccels(opts.accel, profile);
    const resolvedAccel = accels[0];
    const machineType = profile.machineFor(resolvedAccel);
    this.machineType = machineType;

    const args: string[] = [];

    if (opts.freeze) args.push("-S");
    for (const a of accels) args.push("-accel", a);

    // QMP transport
    const qmpTr = this.qmpTransport!;
    const qmpArg = qmpTr.type === "unix"
      ? `unix:${qmpTr.local},server,nowait`
      : `tcp:127.0.0.1:${qmpTr.local},server,nowait`;
    args.push("-qmp", qmpArg);

    // Serial transport
    const serialTr = this.serialTransport!;
    const serialArg = serialTr.type === "unix"
      ? `unix:${serialTr.local},server,nowait`
      : `tcp:127.0.0.1:${serialTr.local},server,nowait`;
    args.push("-serial", serialArg);

    const fwDir = firmwareDir();
    if (fwDir) args.push("-L", fwDir);

    // Delegate pure-argument construction to the static method (testable)
    args.push(...QemuProcess.buildArgs(opts, machineType, resolvedAccel));

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

  static buildArgs(opts: QemuOptions, machineType: string, resolvedAccel?: string): string[] {
    const profile = opts.guestProfile;
    const args: string[] = [];

    const accel = resolvedAccel ?? "tcg,thread=multi";
    const machineArg = machineType === "virt" && profile.arch === "aarch64"
      ? `${machineType},gic-version=3`
      : machineType;
    args.push(
      "-machine", machineArg,
      "-m", `${opts.memoryMB}`,
      "-smp", `${opts.smp}`,
      "-no-user-config",
      "-nographic",
      "-no-reboot",
    );
    // -nodefaults is safe for pc and microvm (built-in serial devices survive)
    // but strips the PL011 UART from -machine virt (aarch64). Skip it for virt.
    if (machineType !== "virt") args.push("-nodefaults");
    const cpuModel = profile.cpuFor(accel);
    if (cpuModel) args.push("-cpu", cpuModel);

    const kernel = opts.kernel ?? profile.kernel;
    if (kernel) args.push("-kernel", kernel);
    const initrd = opts.initrd ?? profile.initrd;
    if (initrd) args.push("-initrd", initrd);
    if (opts.kernelCmdline) {
      const extra = profile.extraCmdline(machineType);
      let cmdline = extra ? `${opts.kernelCmdline} ${extra}` : opts.kernelCmdline;
      if (opts.sharePort && opts.shareToken) {
        cmdline += ` valencebox.port=${opts.sharePort} valencebox.token=${opts.shareToken}`;
      }
      args.push("-append", cmdline);
    }

    const suffix = profile.virtioSuffix(machineType);
    const blkDev = `virtio-blk${suffix}`;
    const netDev = `virtio-net${suffix}`;
    const rngDev = `virtio-rng${suffix}`;

    const rootImg = opts.rootImage ?? profile.rootImage;
    if (rootImg) {
      args.push(
        "-drive", `id=root,file=${rootImg},format=qcow2,if=none`,
        "-device", `${blkDev},drive=root`,
      );
    }

    const wsImg = opts.workspaceImage ?? profile.workspaceImage;
    if (wsImg) {
      args.push(
        "-drive", `id=ws,file=${wsImg},format=qcow2,if=none`,
        "-device", `${blkDev},drive=ws`,
      );
    }

    args.push("-netdev", `user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22`, "-device", `${netDev},netdev=net0`);
    args.push("-device", rngDev);
    args.push("-device", `virtio-balloon${suffix}`);

    return args;
  }

  static checkAccel(platform: string, arch?: string): { name: string; available: boolean; hint?: string } {
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
      // HVF can accelerate aarch64 guests only on Apple Silicon hosts.
      // On Intel Macs, HVF is unavailable for any guest (not aarch64-capable).
      if (arch === "aarch64" && process.arch === "arm64") {
        return { name: "hvf", available: true };
      }
      return { name: "tcg", available: true };
    }
    if (platform === "win32") {
      // WHPX is x86_64-only; aarch64 guests always use TCG on Windows.
      if (arch === "aarch64") {
        return { name: "tcg", available: true };
      }
      const whpxAvailable = QemuProcess.checkWhpx();
      return whpxAvailable
        ? { name: "whpx", available: true }
        : { name: "whpx", available: false, hint: "WHPX not available — enable Windows Hypervisor Platform (Windows Features) or use -accel tcg" };
    }
    return { name: "tcg", available: true };
  }

  /** Probe WHPX by briefly starting QEMU with `-accel whpx`. */
  private static checkWhpx(): boolean {
    try {
      const qemu = qemuBinaryPath("x86_64");
      // Spawn QEMU with WHPX + minimal config.
      // If WHPX is available and working, QEMU will start running and time out (ETIMEDOUT).
      // If WHPX is not available, QEMU will exit immediately with an error (status !== 0).
      const res = spawnSync(
        qemu,
        ["-accel", "whpx", "-machine", "none", "-display", "none"],
        { timeout: 300, windowsHide: true }
      );
      return (res.error as any)?.code === "ETIMEDOUT" || res.status === 0;
    } catch {
      return false;
    }
  }

  private resolveAccels(override: string | undefined, profile: GuestProfile): string[] {
    if (override && override !== "auto") {
      if (override === "tcg") return ["tcg,thread=multi"];
      const accelInfo = QemuProcess.checkAccel(process.platform, profile.arch);
      if (accelInfo.name === override && accelInfo.available) {
        return [override, "tcg,thread=multi"];
      }
      return ["tcg,thread=multi"];
    }
    const accels: string[] = [];
    {
      const info = QemuProcess.checkAccel(process.platform, profile.arch);
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
