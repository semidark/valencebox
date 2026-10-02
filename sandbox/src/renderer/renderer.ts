// Plain browser script (no imports/exports) so tsc emits no CommonJS wrapper.
// Terminal + FitAddon come from the xterm.js UMD bundles loaded before this
// script (globals: window.Terminal, window.FitAddon.FitAddon).
interface RSyncStats { pushed: number; pulled: number; deleted: number; conflicts: number; bytesOut: number; bytesIn: number; throughput?: { out: number; in: number }; }
interface RStatus {
  phase: string;
  bootMs?: number;
  restored?: boolean;
  sync?: RSyncStats;
  net?: { relayUrl: string; policyHosts: string[]; dataPlane?: boolean };
  ptyConnected?: boolean;
  swapCtrlCmd?: boolean;
  error?: string;
}
interface RConflict { path: string; winner: string; at: number; }
interface SandboxAPI {
  getStatus(): Promise<RStatus>;
  saveSnapshot(): Promise<void>;
  sendInput(data: string): void;
  onStatus(cb: (s: RStatus) => void): void;
  onSerial(cb: (chunk: string) => void): void;
  onConflict(cb: (c: RConflict) => void): void;
  onPtyData(cb: (chunk: Uint8Array) => void): void;
  onPtyClosed(cb: () => void): void;
  sendPtyInput(data: Uint8Array): void;
  sendPtyResize(cols: number, rows: number): void;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): void;
}
declare const Terminal: any;
declare const FitAddon: any;
const api: SandboxAPI = (window as unknown as { sandbox: SandboxAPI }).sandbox;

const $ = (id: string) => document.getElementById(id)!;

// ---- interactive terminal ----
const term = new Terminal({
  fontSize: 13,
  fontFamily: "ui-monospace, Menlo, monospace",
  cursorBlink: true,
  scrollback: 5000,
  theme: {
    background: "#0b0d10",
    foreground: "#cdd3da",
    cursor: "#cdd3da",
    selectionBackground: "#264056",
  },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open($("term"));
fitAddon.fit();
(window as any).__term = term; // debug hook (same convention as the earlier window.vm)

// guest serial output → terminal (boot/fallback); PTY output → terminal (primary)
// PTY input is accepted as soon as usingPty is set, bypassing the isReady gate.
let usingPty = false;
let pendingPtyInput: string[] = [];
// Which modifier represents the physical Ctrl key, from host config.
// false (default, standard macOS): ctrlKey. true (swapped): metaKey.
let swapCtrlCmd = false;
api.onSerial((chunk) => { if (!usingPty) term.write(chunk); });
api.onPtyData((chunk) => {
  if (!usingPty) {
    usingPty = true;
    term.reset();
    api.sendPtyResize(term.cols, term.rows);
    for (const buf of pendingPtyInput) api.sendPtyInput(new TextEncoder().encode(buf));
    pendingPtyInput = [];
  }
  term.write(chunk);
});
api.onPtyClosed(() => {
  usingPty = false;
  term.write("\r\n\x1b[33m[pty session ended — serial fallback]\x1b[0m\r\n");
});
let isReady = false;
term.onData((data: string) => {
  if (usingPty) {
    api.sendPtyInput(new TextEncoder().encode(data));
  } else if (isReady) {
    api.sendInput(data);
  }
});
term.focus();

const refit = () => {
  try {
    fitAddon.fit();
    if (usingPty) api.sendPtyResize(term.cols, term.rows);
  } catch {
    /* container not laid out yet */
  }
};
window.addEventListener("resize", refit);

// ---- status bar ----
let debugMode = false;
const OVERLAY_MSG: Record<string, string> = {
  boot: "Booting…",
  restore: "Restoring snapshot…",
  hydrating: "Syncing files…",
  error: "Error",
  ready: "",
  stopped: "Stopped",
};

function render(s: RStatus) {
  swapCtrlCmd = s.swapCtrlCmd ?? false;
  const phase = $("phase");
  phase.textContent = s.phase + (s.restored ? " (restored)" : "");
  phase.className = "badge" + (s.phase === "ready" ? " ready" : s.phase === "error" ? " error" : "");
  const wasReady = isReady;
  isReady = s.phase === "ready";
  // Re-attach to a live PTY after a renderer reload (e.g. via DevTools):
  // the channel persists in main, but an idle session sends no data, so
  // without this the terminal would stay on the serial fallback.
  if (s.ptyConnected && !usingPty) {
    usingPty = true;
    term.reset();
    api.sendPtyResize(term.cols, term.rows);
  }
  const overlay = $("overlay");
  if (isReady) {
    overlay.classList.add("hidden");
  } else {
    overlay.classList.remove("hidden");
    $("overlay-text").textContent = OVERLAY_MSG[s.phase] || "Waiting…";
  }
  if (wasReady && !isReady) {
    debugMode = false;
    $("debug-btn").textContent = "Debug";
  }
  if (s.bootMs) $("boot").textContent = (s.bootMs / 1000).toFixed(1) + "s";
  if (s.sync) {
    $("pushed").textContent = String(s.sync.pushed);
    $("pulled").textContent = String(s.sync.pulled);
    $("deleted").textContent = String(s.sync.deleted);
    $("conflicts-n").textContent = String(s.sync.conflicts);
    if (s.sync.throughput) {
      const fmt = (v: number) =>
        v >= 1_000_000
          ? (v / 1_000_000).toFixed(1) + " MB/s"
          : v >= 1_000
            ? (v / 1_000).toFixed(1) + " KB/s"
            : v + " B/s";
      $("sync-speed").textContent = `↑${fmt(s.sync.throughput.out)} ↓${fmt(s.sync.throughput.in)}`;
    } else {
      $("sync-speed").textContent = "–";
    }
  }
  $("net").textContent = s.net
    ? `${s.net.policyHosts.length} hosts${s.net.dataPlane ? " +dp" : ""}`
    : "off";
  if (s.error) term.write(`\r\n\x1b[31m[error] ${s.error}\x1b[0m\r\n`);
}

api.onStatus(render);
api.onConflict((c) => {
  const el = $("conflicts");
  el.textContent = `⚠ conflict: ${c.path} — ${c.winner} won @ ${new Date(c.at).toLocaleTimeString()}\n` + el.textContent;
});

$("snap").addEventListener("click", () => {
  if (isReady) api.saveSnapshot();
});

term.focus();

// Custom key routing. `swapCtrlCmd` (from host config) selects which modifier
// represents the physical Ctrl key for terminal control:
//   - false (default, standard macOS): physical Ctrl = ctrlKey.
//   - true (user swapped Ctrl/Cmd in system settings): physical Ctrl = metaKey.
// Terminal control chars and Ctrl+Shift+C/V copy/paste use that modifier; the
// other modifier + letter is suppressed so it doesn't leak control chars.
term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
  if (e.type !== "keydown") return true;

  // Modifier that represents the physical Ctrl key for terminal control.
  const termCtrl = swapCtrlCmd ? e.metaKey : e.ctrlKey;
  // The other modifier (physical Cmd) — suppress its control chars.
  const otherMod = swapCtrlCmd ? e.ctrlKey : e.metaKey;

  // Copy: physical Ctrl + Shift + C.
  if (e.shiftKey && e.code === "KeyC" && termCtrl) {
    const text = term.getSelection();
    if (text) api.clipboardWrite(text);
    return false;
  }
  // Paste: physical Ctrl + Shift + V.
  if (e.shiftKey && e.code === "KeyV" && termCtrl) {
    void api.clipboardRead().then((text) => {
      if (text) term.paste(text);
    });
    return false;
  }
  // Terminal control chars: physical Ctrl + A–Z.
  if (termCtrl && !e.shiftKey && e.keyCode >= 65 && e.keyCode <= 90) {
    const ch = String.fromCharCode(e.keyCode - 64);
    if (usingPty) api.sendPtyInput(new TextEncoder().encode(ch));
    else if (isReady) api.sendInput(ch);
    return false;
  }
  // Suppress physical Cmd + A–Z so xterm doesn't send control chars for it.
  if (otherMod && !termCtrl && !e.shiftKey && e.keyCode >= 65 && e.keyCode <= 90) {
    return false;
  }
  // Everything else (arrows, Enter, Tab, Escape, …) → let xterm handle it.
  return true;
});

$("debug-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  debugMode = !debugMode;
  const overlay = $("overlay");
  if (debugMode) {
    overlay.style.backdropFilter = "none";
    (overlay.style as any).webkitBackdropFilter = "none";
    overlay.style.background = "transparent";
    $("debug-btn").textContent = "Hide";
  } else {
    overlay.style.backdropFilter = "";
    (overlay.style as any).webkitBackdropFilter = "";
    overlay.style.background = "";
    $("debug-btn").textContent = "Debug";
  }
});

api.getStatus().then((s) => s && render(s));
