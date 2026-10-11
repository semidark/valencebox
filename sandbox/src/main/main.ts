// Electron main process: owns the HTTP share + egress proxy + VmManager (QEMU),
// bridges to renderer.
import { app, BrowserWindow, clipboard, ipcMain, Menu } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { VmManager } from "./vm-manager";
import { HttpShare } from "./http-share";
import { EgressProxy, resolveSecrets, generatePlaceholder } from "./egress-proxy";
import * as assetPaths from "./asset-paths";
import { IPC } from "../shared/ipc";
import { SandboxAppConfig, EgressRuntimeConfig, validateNetworkConfig, parseUpstreamProxy } from "../config";
import { GuestArch, selectGuest, x86_64Profile, aarch64Profile } from "./guest-profile";
import { ShutdownCoordinator, withTimeout } from "./shutdown";
import { cleanupRuntimeDir, resolveWorkspaceDir } from "./workspace";
import { startTcpPortForwards, PortForwardHandle } from "./port-forwards";

// Guest-side mux relay ports (strict mode). The mux daemon binds these on the
// guest loopback; the host passes them via kernel cmdline / fw_cfg so the
// guest's proxy env and davfs2 config point at the relays.
const GUEST_PROXY_RELAY_PORT = 3128;
const GUEST_SHARE_RELAY_PORT = 8081;

function loadAppConfig(root: string): SandboxAppConfig {
  const p = path.join(root, "sandbox.config.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Platforms where the virtio-serial mux tunnel has been verified (boot test
 * on KVM and TCG). On unverified platforms a requested strict mode falls back
 * to legacy SLIRP with a warning — never a silent strict boot.
 */
function strictNetSupportedForPlatform(): boolean {
  return process.platform === "linux";
}

function resolveNetworkMode(cfg: SandboxAppConfig): { strict: boolean; requested: boolean } {
  const requested = cfg.egress?.enforce ?? true;
  if (!requested) return { strict: false, requested: false };
  if (!strictNetSupportedForPlatform()) {
    console.warn(
      "[network] strict egress (virtio-serial tunnel) is not verified on this platform yet — " +
      "falling back to legacy SLIRP networking. UDP and ICMP are NOT contained in this mode.",
    );
    return { strict: false, requested: true };
  }
  return { strict: true, requested: true };
}

/**
 * Build the egress proxy runtime config from the app config.
 * Resolves secret values (inline or from host env), picks a random port, and
 * generates an auth token.
 */
function buildProxyConfig(cfg: SandboxAppConfig, strict: boolean): EgressRuntimeConfig {
  const egress = cfg.egress || {};

  const resolvedSecrets = egress.secrets ? resolveSecrets(egress.secrets) : [];

  const authToken = generatePlaceholder(); // random hex token for proxy auth

  // Use port from config if specified, otherwise let the OS assign one.
  const port = egress.listenPort ?? 0;

  // Resolve a custom upstream CA bundle (PEM) if configured.
  let caCert: string | undefined;
  if (egress.caCertFile) {
    const p = egress.caCertFile.startsWith("~")
      ? path.join(os.homedir(), egress.caCertFile.slice(1))
      : egress.caCertFile;
    try {
      caCert = fs.readFileSync(p, "utf-8");
    } catch (err: any) {
      throw new Error(`egress.caCertFile: failed to read '${p}': ${err.message}`);
    }
  }

  return {
    policy: egress.policy ?? "none",
    allowHosts: egress.allowHosts ?? [],
    denyHosts: egress.denyHosts ?? [],
    allowPorts: egress.allowPorts ?? [80, 443],
    allowAll: egress.allowAll ?? false,
    enableMitm: egress.enableMitm ?? false,
    secrets: resolvedSecrets,
    port,
    authToken,
    caCert,
    maxConnections: egress.maxConnections ?? 256,
    rateLimitPerMin: egress.rateLimitPerMin ?? 0,
    // Strict mode: the guest reaches the proxy through the mux tunnel, so the
    // TCP listener is loopback-only (host-side debugging).
    listenHost: egress.listenHost ?? (strict ? "127.0.0.1" : "0.0.0.0"),
    upstreamProxy: egress.upstreamProxy ? parseUpstreamProxy(egress.upstreamProxy) : undefined,
    upstreamNoProxy: egress.upstreamNoProxy,
  };
}

let win: BrowserWindow | null = null;
let vm: VmManager | null = null;
let share: HttpShare | null = null;
let proxy: EgressProxy | null = null;
let forwardHandle: PortForwardHandle | null = null;
let runtimeDir: string | null = null;
let quitting = false;
let detectedAccel: { name: string; available: boolean } | undefined;
// Loaded once at startup so both the IPC handlers and the VM launcher share it.
let appCfg: SandboxAppConfig = {};

// GPU acceleration must be toggled before app "ready". The renderer only uses
// the DOM/canvas path (xterm without the WebGL addon), so disabling it is safe
// and silences GLX errors on displays without XFree86-VidModeExtension (e.g.
// SSH-forwarded X sessions).
try {
  if (loadAppConfig(app.getPath("userData")).gpuEnabled === false) {
    app.disableHardwareAcceleration();
  }
} catch {
  // userData path unavailable this early — leave GPU acceleration at default.
}

// Minimal menu: drops the default reload (Ctrl/Cmd+R) and force-reload
// accelerators (which would reload the renderer and kick the terminal back
// to the serial fallback) and the edit menu (Cmd+C/V would steal terminal
// copy/paste — the terminal now uses Ctrl+Shift+C/V instead).
function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" as const }]
      : []),
    { role: "fileMenu" },
    {
      label: "View",
      submenu: [
        // No accelerator on purpose: reloads the renderer (to test PTY
        // re-attach) without re-introducing the Ctrl/Cmd+R binding.
        { label: "Reload Window", click: () => win?.webContents.reload() },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

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
  Menu.setApplicationMenu(buildMenu());
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
    const swapCtrlCmd = appCfg.swapCtrlCmd ?? false;
    if (!vm) return { phase: "boot", swapCtrlCmd } as const;
    return {
      phase: vm.running ? "ready" as const : "stopped" as const,
      bootMs: vm.bootMs,
      accel: detectedAccel?.name,
      accelAvailable: detectedAccel?.available,
      ptyConnected: vm.ptyConnected,
      swapCtrlCmd,
    };
  });
  ipcMain.on(IPC.serialInput, (_e, data: string) => vm?.sendInput(data));
  ipcMain.on(IPC.ptyInput, (_e, data: Uint8Array) => vm?.sendPtyInput(data));
  ipcMain.on(IPC.ptyResize, (_e, cols: number, rows: number) => vm?.resizePty(cols, rows));
  ipcMain.handle(IPC.setBalloon, (_e, mb: number) => {
    if (typeof mb !== "number" || !Number.isFinite(mb)) return;
    return vm?.setBalloon(mb);
  });
  ipcMain.handle(IPC.getBalloon, () => vm ? vm.getBalloon() : null);
  // Terminal copy/paste (Ctrl+Shift+C/V) — main-process clipboard so it works
  // regardless of renderer secure-context / permission state on file://.
  ipcMain.handle(IPC.clipboardRead, () => clipboard.readText());
  ipcMain.on(IPC.clipboardWrite, (_e, text: string) => {
    if (typeof text === "string") clipboard.writeText(text);
  });
  // Stub handler for legacy IPC channel — renderer may still call it
  ipcMain.handle(IPC.saveSnapshot, () => {});
}

async function startVm() {
  if (quitting) return;
  try {
    validateNetworkConfig(appCfg);
  } catch (err: any) {
    console.error("[network] config validation failed:", err.message);
    sendToWindow(IPC.onStatus, { phase: "error", error: err.message });
    return;
  }
  const networkMode = resolveNetworkMode(appCfg);
  console.log(`[network] mode: ${networkMode.strict ? "strict (virtio-serial mux tunnel, no NIC)" : "legacy SLIRP"}`);
  const tmpDir = fs.mkdtempSync(path.join(app.getPath("userData"), "qemu-"));
  runtimeDir = tmpDir;

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
  const workspaceDir = resolveWorkspaceDir(appCfg, app.getPath("userData"));
  share = new HttpShare();
  const shareCfg = await share.start(workspaceDir);
  if (quitting) return;
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

  // ---- Egress proxy setup ----
  const proxyCfg = buildProxyConfig(appCfg, networkMode.strict);
  // buildProxyConfig already returns port=0 (OS-assign) unless egress.listenPort is set.
  const caDir = path.join(app.getPath("userData"), "mitm-ca");
  const proxyLogFile = path.join(app.getPath("userData"), "proxy.log");
  proxy = new EgressProxy(proxyCfg, caDir, proxyLogFile);
  await proxy.start();
  if (quitting) return;
  const proxyPort = proxy.port;
  console.log(`[egress-proxy] listening on ${proxyCfg.listenHost}:${proxyPort} (policy=${proxyCfg.policy}${proxyCfg.upstreamProxy ? ", upstream chaining" : ""})`);

  // Write WebDAV share config for delivery via QEMU fw_cfg. In strict mode the
  // guest reaches the share through its local mux relay, so the fw_cfg port is
  // the guest relay port, not the host TCP port.
  const shareConfigFile = path.join(tmpDir, "share-config.json");
  fs.writeFileSync(
    shareConfigFile,
    JSON.stringify({ port: networkMode.strict ? GUEST_SHARE_RELAY_PORT : shareCfg.port, token: shareCfg.token }),
    { mode: 0o600 },
  );

  // If MITM is enabled, copy the CA cert for delivery via fw_cfg. A configured
  // egress.guestCaFile takes precedence (corporate inspection CA / internal
  // root provisioned into the guest trust store).
  let mitmCaFile: string | undefined;
  if (appCfg.egress?.guestCaFile) {
    const p = appCfg.egress.guestCaFile.startsWith("~")
      ? path.join(os.homedir(), appCfg.egress.guestCaFile.slice(1))
      : appCfg.egress.guestCaFile;
    try {
      fs.accessSync(p);
    } catch {
      throw new Error(`egress.guestCaFile: file not found: ${p}`);
    }
    mitmCaFile = path.join(tmpDir, "mitm-ca.pem");
    fs.copyFileSync(p, mitmCaFile);
    fs.chmodSync(mitmCaFile, 0o600);
    console.log(`[egress-proxy] guest CA cert copied for fw_cfg: ${mitmCaFile} (from ${p})`);
  } else if (proxy.runtimeConfig.enableMitm && proxy.ca) {
    mitmCaFile = path.join(tmpDir, "mitm-ca.pem");
    fs.copyFileSync(proxy.ca.cert, mitmCaFile);
    fs.chmodSync(mitmCaFile, 0o600);
    console.log(`[egress-proxy] CA cert copied for fw_cfg: ${mitmCaFile}`);
  }

  // Build secret placeholders string for the guest kernel cmdline.
  // Format: env=placeholder,env2=placeholder2 (URL-safe, no spaces)
  const secretPlaceholders = proxyCfg.secrets.map((s) => `${s.env}=${s.placeholder}`).join(",");

  const portForwards = appCfg.portForwards ?? [
    { hostPort: 2222, guestPort: 22, label: "SSH debug access" },
  ];

  vm = new VmManager({
    memoryMB: appCfg.memMb ?? 4096,
    smp: appCfg.smp ?? 2,
    tmpDir,
    accel: appCfg.accel,
    guestProfile: profile,
    kernelCmdline: profile.kernelCmdline,
    rootImage,
    workspaceImage,
    shareConfigFile,
    mitmCaFile,
    balloonMinMb: appCfg.balloonMinMb,
    // Strict mode: the guest relays through local mux ports; the cmdline
    // carries the guest relay ports (the daemon reads them, with fallbacks).
    proxyPort: networkMode.strict ? GUEST_PROXY_RELAY_PORT : proxyPort,
    sharePort: networkMode.strict ? GUEST_SHARE_RELAY_PORT : undefined,
    proxyToken: proxyCfg.authToken,
    proxySecrets: secretPlaceholders,
    portForwards,
    strictNet: networkMode.strict,
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
  vm.on("pty:data", (chunk: Uint8Array) => sendToWindow(IPC.onPtyData, chunk));
  vm.on("pty:closed", () => sendToWindow(IPC.onPtyClosed));
  vm.on("qmp:event", (event: string) => {
    console.log("[qemu] QMP event:", event);
  });
  vm.on("accel", (info: { name: string; available: boolean }) => {
    detectedAccel = info;
    console.log(`[qemu] accelerator: ${info.name}${info.available ? "" : " (unavailable — using TCG fallback)"}`);
  });

  try {
    await vm.start();
    if (quitting) return;

    // Strict mode: route mux streams into the in-process proxy/share servers
    // and expose host→guest TCP port forwards over the tunnel.
    if (networkMode.strict && vm.mux) {
      const mux = vm.mux;
      mux.onStream((target, stream) => {
        if (target === "proxy" && proxy) {
          proxy.injectConnection(stream);
        } else if (target === "share" && share) {
          share.injectConnection(stream);
        } else {
          throw new Error(`unknown mux target '${target}'`);
        }
      });
      forwardHandle = startTcpPortForwards(mux, portForwards);
      mux.on("closed", () => {
        console.log("[mux] channel closed");
        forwardHandle?.close();
      });
    }

    sendToWindow(IPC.onStatus, {
      phase: "ready", bootMs: vm.bootMs,
      accel: detectedAccel?.name, accelAvailable: detectedAccel?.available,
      swapCtrlCmd: appCfg.swapCtrlCmd ?? false,
    });
  } catch (e: any) {
    sendToWindow(IPC.onStatus, { phase: "error", error: e.message });
    console.error("[qemu] failed to start:", e);
  }
}

app.whenReady().then(async () => {
  appCfg = loadAppConfig(app.getPath("userData"));
  registerIpc();
  await createWindow();
  if (!quitting) await startVm();
}).catch((err) => {
  if (!quitting) console.error("[startup] failed:", err);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

const shutdown = new ShutdownCoordinator([
  {
    name: "VM stop", timeoutMs: 31_000,
    stop: async () => {
      try { await withTimeout(vm?.stop() ?? Promise.resolve(), 30_000, "QEMU stop"); }
      catch (err) { vm?.forceStop(); throw err; }
    },
  },
  { name: "port forwards", timeoutMs: 2_000, stop: async () => { forwardHandle?.close(); } },
  { name: "proxy stop", timeoutMs: 2_000, stop: async () => { await proxy?.stop(); } },
  { name: "share stop", timeoutMs: 2_000, stop: async () => { await share?.stop(); } },
  {
    name: "runtime cleanup", timeoutMs: 2_000,
    stop: async () => {
      if (vm?.running) throw new Error("Runtime files retained because QEMU is still running");
      if (runtimeDir) await cleanupRuntimeDir(runtimeDir);
    },
  },
], (code) => app.exit(code), () => {
  vm?.forceStop();
  forwardHandle?.close();
  proxy?.forceStop();
  share?.forceStop();
});

app.on("before-quit", (e) => {
  e.preventDefault();
  quitting = true;
  void shutdown.request();
});
