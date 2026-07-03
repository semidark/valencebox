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
    onSerial: (chunk) => sendToWindow(IPC.onSerial, chunk),
  });
  sandbox.on("status", (s) => sendToWindow(IPC.onStatus, s));
  sandbox.on("conflict", (c) => sendToWindow(IPC.onConflict, c));
  sandbox.on("log", (m) => console.log("[sandbox]", m));

  try {
    await sandbox.start();
  } catch (e: any) {
    sendToWindow(IPC.onStatus, { phase: "error", error: e.message });
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

// Electron doesn't wait for an async "before-quit" listener — without
// preventDefault() the process can exit mid-snapshot (e.g. Cmd+Q). Defer the
// actual quit until sandbox.stop() (final snapshot included) has finished,
// then let it through on the second pass.
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void (sandbox?.stop() ?? Promise.resolve())
    .catch((err) => console.error("sandbox failed to stop cleanly:", err))
    .finally(() => app.quit());
});
