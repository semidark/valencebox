// Headless Electron smoke test for the renderer: loads the real index.html
// with a stub sandbox API (via preload), replays the events the main process
// sends, and reads back the rendered DOM + xterm state.
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
      // serial output → terminal via the real api.onSerial wiring, then
      // flush xterm's async write queue before reading the buffer back
      cbs.serial("sandbox:~# echo hi\\r\\nhi\\r\\n");
      await new Promise(r => window.__term.write("", r));
      cbs.conflict({ path: "src/app.ts", winner: "remote", at: Date.now() });
      // simulate a keystroke: xterm paste() fires onData → api.sendInput
      window.__term.paste("whoami\\n");
      await new Promise(r => setTimeout(r, 50));
      // read the terminal buffer back
      const buf = window.__term.buffer.active;
      let termText = "";
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) termText += line.translateToString(true) + "\\n";
      }
      return {
        phase: document.getElementById("phase").textContent,
        phaseClass: document.getElementById("phase").className,
        boot: document.getElementById("boot").textContent,
        pushed: document.getElementById("pushed").textContent,
        conflictsN: document.getElementById("conflicts-n").textContent,
        net: document.getElementById("net").textContent,
        xtermMounted: !!document.querySelector("#term .xterm"),
        termHasSerial: termText.includes("hi"),
        conflictShown: document.getElementById("conflicts").textContent.includes("src/app.ts"),
        lastInput: globalThis.__lastInput,
        noCmdBox: document.getElementById("cmd") === null && document.getElementById("send") === null,
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
    ["xterm mounted", result.xtermMounted === true],
    ["serial reached terminal", result.termHasSerial === true],
    ["conflict banner", result.conflictShown === true],
    // xterm normalizes the pasted \n to \r (Enter = carriage return)
    ["keystroke → sendInput IPC", result.lastInput === "whoami\r"],
    ["old command box removed", result.noCmdBox === true],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? "UI_SMOKE_PASSED" : "UI_SMOKE_FAILED");
  app.exit(ok ? 0 : 1);
});
