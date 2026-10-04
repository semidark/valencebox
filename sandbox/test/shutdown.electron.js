// Real Electron main-process lifecycle, with a populated legacy workspace.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { ShutdownCoordinator } = require("../dist/main/shutdown");
const { cleanupRuntimeDir, resolveWorkspaceDir } = require("../dist/main/workspace");
const { VmManager } = require("../dist/main/vm-manager");
const { x86_64Profile } = require("../dist/main/guest-profile");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-electron-shutdown-"));
const deadline = setTimeout(() => { console.error("FAIL: Electron shutdown deadline"); app.exit(1); }, 5000);

app.whenReady().then(async () => {
  delete process.env.WORKSPACE_DIR;
  const workspace = resolveWorkspaceDir({}, dir);
  const legacy = fs.mkdtempSync(path.join(dir, "qemu-"));
  const project = path.join(legacy, "workspace", "project");
  fs.mkdirSync(project, { recursive: true });
  for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(project, `${i}.txt`), `content ${i}`);
  // ASAR-like paths must be retained without traversing them under Electron.
  fs.mkdirSync(path.join(project, "tool.asar"));
  fs.writeFileSync(path.join(project, "tool.asar", "payload"), "retain");
  fs.writeFileSync(path.join(legacy, "share-config.json"), "runtime");
  fs.writeFileSync(path.join(workspace, "persistent.txt"), "keep");
  const vm = new VmManager({ memoryMB: 128, smp: 1, tmpDir: legacy,
    guestProfile: x86_64Profile("", ""), portForwards: [] });
  const win = new BrowserWindow({ show: false });
  await win.loadURL("data:text/html,<script>window.onbeforeunload=()=>false</script>");
  let quits = 0;
  let stops = 0;
  const shutdown = new ShutdownCoordinator([
    { name: "VM stop", timeoutMs: 1000, stop: async () => { stops++; await vm.stop(); } },
    { name: "runtime cleanup", timeoutMs: 1000, stop: () => cleanupRuntimeDir(legacy) },
  ], (code) => {
    try {
      assert.equal(code, 0);
      assert.equal(quits, 2);
      assert.equal(stops, 1);
      assert.equal(fs.readdirSync(project).length, 501);
      assert.equal(fs.readFileSync(path.join(workspace, "persistent.txt"), "utf8"), "keep");
      assert.equal(fs.existsSync(path.join(legacy, "share-config.json")), false);
      clearTimeout(deadline);
      // Fixture-only cleanup uses original-fs to treat tool.asar as a real dir.
      require("original-fs").rmSync(dir, { recursive: true, force: true });
      console.log("✓ Electron: repeated quit, populated workspace retained, window close veto bypassed");
      app.exit(0);
    } catch (err) { console.error("FAIL:", err); app.exit(1); }
  }, () => vm.forceStop(), 3000);
  app.on("before-quit", (event) => {
    event.preventDefault();
    quits++;
    void shutdown.request();
  });
  app.quit();
  app.quit();
}).catch((err) => { console.error("FAIL:", err); app.exit(1); });
