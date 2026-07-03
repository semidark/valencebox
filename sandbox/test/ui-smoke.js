// Headless Electron smoke test for the renderer: loads the real index.html
// with a stub sandbox API (via preload), replays the events the main process
// sends, and reads back the rendered DOM.
const { app, BrowserWindow } = require("electron");
const path = require("path");

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: false,
      nodeIntegration: true,
      preload: path.join(__dirname, "fake-preload.js"),
    },
  });
  await win.loadFile(path.join(__dirname, "..", "dist", "renderer", "index.html"));

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const cbs = globalThis.__cbs;
      cbs.status({ phase: "ready", bootMs: 34200, restored: true,
        sync: { pushed: 353, pulled: 2, deleted: 1, conflicts: 1, bytesOut: 13300000, bytesIn: 0 },
        net: { relayUrl: "wisp://127.0.0.1:5000/", policyHosts: ["a","b","c"] } });
      cbs.serial("sandbox:~# echo hi\\r\\nhi\\r\\n");
      cbs.conflict({ path: "src/app.ts", winner: "remote", at: Date.now() });
      document.getElementById("cmd").value = "ls -la";
      document.getElementById("send").click();
      await new Promise(r => setTimeout(r, 50));
      return {
        phase: document.getElementById("phase").textContent,
        phaseClass: document.getElementById("phase").className,
        boot: document.getElementById("boot").textContent,
        pushed: document.getElementById("pushed").textContent,
        conflictsN: document.getElementById("conflicts-n").textContent,
        net: document.getElementById("net").textContent,
        termHasSerial: document.getElementById("term").textContent.includes("hi"),
        conflictShown: document.getElementById("conflicts").textContent.includes("src/app.ts"),
        lastCmd: globalThis.__lastCmd,
      };
    })()
  `);

  const checks = [
    ["phase ready (restored)", result.phase === "ready (restored)"],
    ["phase css .ready", result.phaseClass.includes("ready")],
    ["boot time 34.2s", result.boot === "34.2s"],
    ["pushed 353", result.pushed === "353"],
    ["conflicts 1", result.conflictsN === "1"],
    ["net 3 hosts", result.net === "3 hosts"],
    ["serial rendered", result.termHasSerial === true],
    ["conflict banner", result.conflictShown === true],
    ["runCommand IPC", result.lastCmd === "ls -la"],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "UI_SMOKE_PASSED" : "UI_SMOKE_FAILED");
  app.exit(ok ? 0 : 1);
});
