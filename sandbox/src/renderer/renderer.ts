// Plain browser script (no imports/exports) so tsc emits no CommonJS wrapper.
// The preload-exposed API and status shape are described locally.
interface RSyncStats { pushed: number; pulled: number; deleted: number; conflicts: number; bytesOut: number; bytesIn: number; }
interface RStatus {
  phase: string;
  bootMs?: number;
  restored?: boolean;
  sync?: RSyncStats;
  net?: { relayUrl: string; policyHosts: string[] };
  error?: string;
}
interface RConflict { path: string; winner: string; at: number; }
interface SandboxAPI {
  getStatus(): Promise<RStatus>;
  saveSnapshot(): Promise<void>;
  runCommand(cmd: string): Promise<void>;
  onStatus(cb: (s: RStatus) => void): void;
  onSerial(cb: (chunk: string) => void): void;
  onConflict(cb: (c: RConflict) => void): void;
}
const api: SandboxAPI = (window as unknown as { sandbox: SandboxAPI }).sandbox;

const $ = (id: string) => document.getElementById(id)!;
const term = $("term");
let raw = "";

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
  $("net").textContent = s.net ? `${s.net.policyHosts.length} hosts` : "off";
  if (s.error) appendTerm(`\n[error] ${s.error}\n`);
}

function appendTerm(chunk: string) {
  raw += chunk;
  if (raw.length > 200000) raw = raw.slice(-120000);
  term.textContent = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  term.scrollTop = term.scrollHeight;
}

api.onStatus(render);
api.onSerial(appendTerm);
api.onConflict((c) => {
  const el = $("conflicts");
  el.textContent = `⚠ conflict: ${c.path} — ${c.winner} won @ ${new Date(c.at).toLocaleTimeString()}\n` + el.textContent;
});

const input = $("cmd") as HTMLInputElement;
const run = () => {
  const cmd = input.value.trim();
  if (!cmd) return;
  api.runCommand(cmd);
  input.value = "";
};
$("send").addEventListener("click", run);
input.addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") run();
});
$("snap").addEventListener("click", () => api.saveSnapshot());

api.getStatus().then((s) => s && render(s));
