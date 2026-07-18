// Electron main process: owns the HTTP share + VmManager (QEMU), bridges to renderer.
import { app, BrowserWindow, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";
import { VmManager } from "./vm-manager";
import { HttpShare } from "./http-share";
import * as assetPaths from "./asset-paths";
import { IPC } from "../shared/ipc";
import { SandboxAppConfig } from "../config";
import { GuestArch, selectGuest, x86_64Profile, aarch64Profile } from "./guest-profile";

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
  ipcMain.handle(IPC.setBalloon, (_e, mb: number) => {
    if (typeof mb !== "number" || !Number.isFinite(mb)) return;
    return vm?.setBalloon(mb);
  });
  ipcMain.handle(IPC.getBalloon, () => vm ? vm.getBalloon() : null);
  // Stub handlers for legacy IPC channels — renderer may still call them
  ipcMain.handle(IPC.saveSnapshot, () => {});
}

async function startVm() {
  const appCfg = loadAppConfig(app.getPath("userData"));
  const tmpDir = fs.mkdtempSync(path.join(app.getPath("userData"), "qemu-"));

  // Resolve guest architecture before checking images (paths differ by arch)
  const guestArch = selectGuest(
    appCfg.guest,
    (arch) => fs.existsSync(assetPaths.qemuBinaryPath(arch)),
    (arch) => fs.existsSync(assetPaths.rootQcow2Path(arch)),
  );

  const rootImage = assetPaths.rootQcow2Path(guestArch);
  if (!fs.existsSync(rootImage)) {
    sendToWindow(IPC.onStatus, { phase: "error", error: `${path.basename(rootImage)} not found — run \`npm run images\` first` });
    return;
  }

  // Start HTTP share server (WebDAV) before QEMU so port+token are ready for fw_cfg
  const workspaceDir = resolveWorkspaceDir(appCfg, tmpDir);
  share = new HttpShare();
  const shareCfg = await share.start(workspaceDir);
  console.log(`[share] WebDAV on 127.0.0.1:${shareCfg.port}, token=${shareCfg.token.slice(0, 8)}...`);
  console.log(`[share] workspace: ${workspaceDir}`);

  // Write a marker file that unison on the guest checks before syncing.
  // If the davfs2 mount drops, the marker becomes inaccessible and unison
  // refuses to start — preventing the guest from deleting everything under
  // the false assumption that the host workspace is empty.
  const markerPath = path.join(workspaceDir, ".valence-sync-marker");
  fs.writeFileSync(markerPath, "");
  console.log(`[share] sync marker at ${markerPath}`);

  const workspaceImage = assetPaths.workspaceQcow2Path(guestArch);
  if (!fs.existsSync(workspaceImage)) {
    sendToWindow(IPC.onStatus, { phase: "error", error: `${path.basename(workspaceImage)} not found — run \`npm run images\` first` });
    return;
  }

  const profile = guestArch === "aarch64"
    ? aarch64Profile(
        rootImage,
        workspaceImage,
        assetPaths.kernelPath(guestArch),
        assetPaths.initrdPath(guestArch),
      )
    : x86_64Profile(
        rootImage,
        workspaceImage,
        path.join(assetPaths.imagesDir(), "vmlinuz.bin"),
        path.join(assetPaths.imagesDir(), "initramfs.bin"),
      );

  vm = new VmManager({
    memoryMB: appCfg.memMb ?? 4096,
    smp: appCfg.smp ?? 2,
    tmpDir,
    accel: appCfg.accel,
    guestProfile: profile,
    kernelCmdline: profile.kernelCmdline,
    rootImage,
    workspaceImage,
    sharePort: shareCfg.port,
    shareToken: shareCfg.token,
    balloonMinMb: appCfg.balloonMinMb,
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
    })().finally(() => app.quit());
});
