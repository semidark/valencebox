// Plain browser script (no imports/exports) so tsc emits no CommonJS wrapper.
// Terminal + FitAddon come from the xterm.js UMD bundles loaded before this
// script (globals: window.Terminal, window.FitAddon.FitAddon).
interface RSyncStats { pushed: number; pulled: number; deleted: number; conflicts: number; bytesOut: number; bytesIn: number; }
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

// guest serial output → terminal; keystrokes → guest serial line
api.onSerial((chunk) => term.write(chunk));
term.onData((data: string) => api.sendInput(data));
term.focus();

const refit = () => {
  try {
    fitAddon.fit();
  } catch {
    /* container not laid out yet */
  }
};
window.addEventListener("resize", refit);

// ---- status bar ----
function render(s: RStatus) {
  const phase = $("phase");
  phase.textContent = s.phase + (s.restored ? " (restored)" : "");
  phase.className = "badge" + (s.phase === "ready" ? " ready" : s.phase === "error" ? " error" : "");
  if (s.bootMs) $("boot").textContent = (s.bootMs / 1000).toFixed(1) + "s";
  if (s.sync) {
    $("pushed").textContent = String(s.sync.pushed);
    $("pulled").textContent = String(s.sync.pulled);
    $("deleted").textContent = String(s.sync.deleted);
    $("conflicts-n").textContent = String(s.sync.conflicts);
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
  api.saveSnapshot();
  term.focus();
});

api.getStatus().then((s) => s && render(s));
