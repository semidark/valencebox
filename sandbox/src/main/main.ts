// Electron main process: owns the HTTP share + VmManager (QEMU), bridges to renderer.
import { app, BrowserWindow, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";
import { VmManager } from "./vm-manager";
import { HttpShare } from "./http-share";
import * as assetPaths from "./asset-paths";
import { IPC } from "../shared/ipc";
import { SandboxAppConfig } from "../config";

function loadAppConfig(root: string): SandboxAppConfig {
  const p = path.join(root, "sandbox.config.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function resolveWorkspaceDir(cfg: SandboxAppConfig, tmpDir: string): string {
  if (cfg.workspaceDir) return cfg.workspaceDir;
  if (process.env.WORKSPACE_DIR) return process.env.WORKSPACE_DIR;
  const isolated = path.join(tmpDir, "workspace");
  fs.mkdirSync(isolated, { recursive: true });
  return isolated;
}

let win: BrowserWindow | null = null;
let vm: VmManager | null = null;
let share: HttpShare | null = null;
let detectedAccel: { name: string; available: boolean } | undefined;

async function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: "ValenceBox",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require(); renderer stays isolated
    },
  });
  win.on("closed", () => {
    win = null;
  });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

function sendToWindow(channel: string, ...args: any[]) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function registerIpc() {
  ipcMain.handle(IPC.getStatus, () => {
    if (!vm) return { phase: "boot" } as const;
    return {
      phase: vm.running ? "ready" as const : "stopped" as const,
      bootMs: vm.bootMs,
      accel: detectedAccel?.name,
      accelAvailable: detectedAccel?.available,
    };
  });
  ipcMain.on(IPC.serialInput, (_e, data: string) => vm?.sendInput(data));
  // Stub handlers for legacy IPC channels — renderer may still call them
  ipcMain.handle(IPC.saveSnapshot, () => {});
}

async function startVm() {
  const appCfg = loadAppConfig(app.getPath("userData"));
  const tmpDir = fs.mkdtempSync(path.join(app.getPath("userData"), "qemu-"));

  const rootImage = assetPaths.rootQcow2Path();
  if (!fs.existsSync(rootImage)) {
    sendToWindow(IPC.onStatus, { phase: "error", error: "root.qcow2 not found — run `npm run images` first" });
    return;
  }

  // Start HTTP share server (WebDAV) before QEMU so port+token are ready for fw_cfg
  const workspaceDir = resolveWorkspaceDir(appCfg, tmpDir);
  share = new HttpShare();
  const shareCfg = await share.start(workspaceDir);
  console.log(`[share] WebDAV on 127.0.0.1:${shareCfg.port}, fw_cfg at ${shareCfg.fwCfgPath}`);

  const workspaceImage = assetPaths.workspaceQcow2Path();
  if (!fs.existsSync(workspaceImage)) {
    sendToWindow(IPC.onStatus, { phase: "error", error: "workspace.qcow2 not found — run `npm run images` first" });
    return;
  }

  vm = new VmManager({
    memoryMB: appCfg.memMb ?? 512,
    smp: appCfg.smp ?? 2,
    tmpDir,
    accel: appCfg.accel,
    kernel: path.join(assetPaths.imagesDir(), "vmlinuz.bin"),
    initrd: path.join(assetPaths.imagesDir(), "initramfs.bin"),
    kernelCmdline: "console=ttyS0 root=/dev/vda rootfstype=ext4 rootflags=rw modules=virtio_blk,ext4",
    rootImage,
    workspaceImage,
    fwCfgConfig: shareCfg.fwCfgPath,
  });

  vm.on("serial:data", (chunk: string) => sendToWindow(IPC.onSerial, chunk));
  vm.on("serial:connected", () => console.log("[qemu] serial connected"));
  vm.on("serial:error", (err: Error) => {
    console.error("[qemu] serial error:", err);
    sendToWindow(IPC.onStatus, { phase: "error", error: err.message });
  });
  vm.on("serial:closed", () => {
    console.log("[qemu] serial closed");
    sendToWindow(IPC.onStatus, { phase: "stopped" });
  });
  vm.on("qmp:event", (event: string) => {
    console.log("[qemu] QMP event:", event);
  });
  vm.on("accel", (info: { name: string; available: boolean }) => {
    detectedAccel = info;
    console.log(`[qemu] accelerator: ${info.name}${info.available ? "" : " (unavailable — using TCG fallback)"}`);
  });

  try {
    await vm.start();
    sendToWindow(IPC.onStatus, {
      phase: "ready", bootMs: vm.bootMs,
      accel: detectedAccel?.name, accelAvailable: detectedAccel?.available,
    });
  } catch (e: any) {
    sendToWindow(IPC.onStatus, { phase: "error", error: e.message });
    console.error("[qemu] failed to start:", e);
  }
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
  await startVm();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void (async () => {
    try {
      await vm?.stop();
      await share?.stop();
    } catch (err) {
      console.error("[qemu] failed to stop cleanly:", err);
    }
    if (share?.fwCfgPath) {
      fs.rmSync(path.dirname(share.fwCfgPath), { recursive: true, force: true });
    }
  })().finally(() => app.quit());
});
