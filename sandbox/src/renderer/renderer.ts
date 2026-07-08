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
// When the PTY opens, we clear the terminal and switch keystrokes to PTY.
let usingPty = false;
api.onSerial((chunk) => { if (!usingPty) term.write(chunk); });
api.onPtyData((chunk) => {
  if (!usingPty) {
    usingPty = true;
    term.reset();
  }
  term.write(chunk);
});
api.onPtyClosed(() => {
  usingPty = false;
  term.write("\r\n\x1b[33m[pty session ended — falling back to serial]\x1b[0m\r\n");
});
let isReady = false;
term.onData((data: string) => {
  if (!isReady) return;
  if (usingPty) {
    api.sendPtyInput(new TextEncoder().encode(data));
  } else {
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
  const phase = $("phase");
  phase.textContent = s.phase + (s.restored ? " (restored)" : "");
  phase.className = "badge" + (s.phase === "ready" ? " ready" : s.phase === "error" ? " error" : "");
  const wasReady = isReady;
  isReady = s.phase === "ready";
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
  term.focus();
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
