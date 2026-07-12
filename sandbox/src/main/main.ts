// Electron main process: owns the VmManager (QEMU), bridges it to the renderer.
import { app, BrowserWindow, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";
import { VmManager } from "./vm-manager";
import * as assetPaths from "./asset-paths";
import { IPC } from "../shared/ipc";

export interface SandboxAppConfig {
  accel?: "auto" | "kvm" | "hvf" | "whpx" | "tcg";
  memMb?: number;
  smp?: number;
}

function loadAppConfig(root: string): SandboxAppConfig {
  const p = path.join(root, "sandbox.config.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

let win: BrowserWindow | null = null;
let vm: VmManager | null = null;

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

  vm = new VmManager({
    memoryMB: appCfg.memMb ?? 512,
    smp: appCfg.smp ?? 2,
    tmpDir,
    accel: appCfg.accel,
    kernel: path.join(assetPaths.imagesDir(), "vmlinuz.bin"),
    initrd: path.join(assetPaths.imagesDir(), "initramfs.bin"),
    rootImage,
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

  try {
    await vm.start();
    sendToWindow(IPC.onStatus, { phase: "ready", bootMs: vm.bootMs });
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

app.on("window-all-closed", async () => {
  await vm?.stop();
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void (vm?.stop() ?? Promise.resolve())
    .catch((err) => console.error("[qemu] failed to stop cleanly:", err))
    .finally(() => app.quit());
});
