// Stub window.sandbox before the renderer script runs, and capture the
// callbacks it registers so the smoke test can replay main-process events.
const { contextBridge } = require("electron");
const cbs = {};
globalThis.__cbs = cbs;
const api = {
  getStatus: async () => ({ phase: "boot" }),
  saveSnapshot: async () => {},
  runCommand: async (c) => { globalThis.__lastCmd = c; },
  onStatus: (cb) => { cbs.status = cb; },
  onSerial: (cb) => { cbs.serial = cb; },
  onConflict: (cb) => { cbs.conflict = cb; },
};
// contextIsolation is off in the smoke harness, so a plain assignment works
window.sandbox = api;
try { contextBridge.exposeInMainWorld("sandbox", api); } catch { /* isolation off */ }
