// Electron main process: owns the Sandbox, bridges it to the renderer.
import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import { Sandbox, defaultPaths } from "./sandbox";
import { IPC } from "../shared/ipc";

let win: BrowserWindow | null = null;
let sandbox: Sandbox | null = null;

async function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    title: "v86 Coding Sandbox",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require(); renderer stays isolated
    },
  });
  await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

function registerIpc() {
  // Registered before the window loads so the renderer's initial getStatus()
  // never races the handler. sandbox may still be null at that point.
  ipcMain.handle(IPC.getStatus, () => sandbox?.status ?? { phase: "boot" });
  ipcMain.handle(IPC.saveSnapshot, () => sandbox?.saveSnapshot());
  ipcMain.on(IPC.serialInput, (_e, data: string) => sandbox?.sendInput(data));
}

async function startSandbox() {
  const paths = defaultPaths(app.getPath("userData"));
  // WORKSPACE_DIR points the sync engine at an arbitrary host project dir
  // (default: <userData>/workspace). Not a live mount — see README.
  if (process.env.WORKSPACE_DIR) {
    paths.hostDir = path.resolve(process.env.WORKSPACE_DIR);
  }
  console.log("[sandbox] host workspace:", paths.hostDir);
  sandbox = new Sandbox({
    ...paths,
    memoryMB: 512,
    enableNetwork: true,
    onSerial: (chunk) => win?.webContents.send(IPC.onSerial, chunk),
  });
  sandbox.on("status", (s) => win?.webContents.send(IPC.onStatus, s));
  sandbox.on("conflict", (c) => win?.webContents.send(IPC.onConflict, c));
  sandbox.on("log", (m) => console.log("[sandbox]", m));

  try {
    await sandbox.start();
  } catch (e: any) {
    win?.webContents.send(IPC.onStatus, { phase: "error", error: e.message });
    console.error("sandbox failed to start:", e);
  }
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
  await startSandbox();
});

app.on("window-all-closed", async () => {
  await sandbox?.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await sandbox?.stop();
});
