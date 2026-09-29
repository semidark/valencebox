// Golden-argument test: verifies QemuProcess.buildArgs produces the correct
// argument vector for each guest arch + machine type combination.
// Calls the real static method directly — no duplication.
import { QemuProcess, QemuOptions } from "../src/main/qemu";
import { x86_64Profile, aarch64Profile, GuestProfile } from "../src/main/guest-profile";
import { PortForward } from "../src/config";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function buildOpts(p: GuestProfile, overrides: Partial<QemuOptions> = {}): QemuOptions {
  return {
    memoryMB: 512,
    smp: 2,
    guestProfile: p,
    portForwards: [],
    ...overrides,
  };
}

function testCase(name: string, opts: QemuOptions, machine: string, checks: (args: string[]) => void, resolvedAccel?: string) {
  const args = QemuProcess.buildArgs(opts, machine, resolvedAccel);
  checks(args);
  console.log(`✓ ${name}: ${args.length} args`);
}

const p = x86_64Profile("/images/root.qcow2", "/images/ws.qcow2");

// Case 1: minimal invocation (no kernel/cmdline)
testCase("minimal x86_64 TCG", buildOpts(p, {
  memoryMB: 1024,
  rootImage: p.rootImage,
  workspaceImage: p.workspaceImage,
}), "pc", (args) => {
  assert(!args.includes("-cpu"), "x86_64 TCG has no -cpu flag");
  assert(!args.includes("-append"), "no -append without kernelCmdline");
});

// Case 2: full invocation with kernel, initrd, cmdline, share port+token
const pFull = x86_64Profile(
  "/images/root.qcow2",
  "/images/ws.qcow2",
  "/images/vmlinuz-virt",
  "/images/initramfs-virt",
);
testCase("full x86_64 TCG", buildOpts(pFull, {
  memoryMB: 2048,
  smp: 4,
  rootImage: pFull.rootImage,
  workspaceImage: pFull.workspaceImage,
  kernelCmdline: "console=ttyS0 root=/dev/vda quiet",
  proxyPort: 12345,
  proxyToken: "abc123def456",
}), "pc", (args) => {
  assert(!args.includes("-cpu"), "x86_64 TCG has no -cpu flag");
  const appendIdx = args.indexOf("-append");
  assert(appendIdx !== -1, "cmdline present");
  assert(!args[appendIdx + 1].includes("reboot=t"), "no reboot=t under pc");
  assert(args[appendIdx + 1].includes("valencebox.proxy_port=12345"), "proxy_port on cmdline");
  assert(args[appendIdx + 1].includes("valencebox.proxy_token=abc123def456"), "proxy_token on cmdline");
  assert(args.some(a => a === "virtio-balloon-pci"), "virtio-balloon-pci for pc");
});

// Case 3: no kernel, no cmdline (still works)
const pNoKernel = x86_64Profile("/r.qcow2", "/w.qcow2");
testCase("no-kernel x86_64 TCG", buildOpts(pNoKernel, {
  memoryMB: 512,
  smp: 1,
  rootImage: "/r.qcow2",
  workspaceImage: "/w.qcow2",
}), "pc", (args) => {
  assert(!args.includes("-append"), "no -append without kernelCmdline");
});

// Case 4: microvm machine type (appends reboot=t)
testCase("microvm x86_64 TCG", buildOpts(pFull, {
  kernelCmdline: "console=ttyS0 root=/dev/vda quiet",
}), "microvm", (args) => {
  const appendIdx = args.indexOf("-append");
  assert(appendIdx !== -1, "cmdline present");
  assert(args[appendIdx + 1].includes("reboot=t"), "reboot=t under microvm");
  const microSuffix = "-device";
  assert(args.some(a => a.startsWith(`virtio-blk${microSuffix}`)), "virtio-blk-device for microvm");
  assert(args.some(a => a.startsWith(`virtio-net${microSuffix}`)), "virtio-net-device for microvm");
  assert(args.some(a => a.startsWith(`virtio-rng${microSuffix}`)), "virtio-rng-device for microvm");
  assert(args.some(a => a.startsWith(`virtio-balloon${microSuffix}`)), "virtio-balloon-device for microvm");
});

// ---- aarch64 profile tests ----

const pa = aarch64Profile("/images/root-arm64.qcow2", "/images/ws-arm64.qcow2");

// Case 5: aarch64 virt under HVF (resolvedAccel = "hvf")
testCase("aarch64 virt HVF", buildOpts(pa, {
  kernelCmdline: "console=ttyAMA0 root=/dev/vda quiet",
}), "virt", (args) => {
  const machineIdx = args.indexOf("-machine");
  assert(machineIdx !== -1, "-machine present");
  assert(args[machineIdx + 1].includes("virt,gic-version=3"), "virt + gic-version=3");
  const cpuIdx = args.indexOf("-cpu");
  assert(cpuIdx !== -1, "-cpu present for aarch64");
  assert(args[cpuIdx + 1] === "host", "cpu = host under HVF");
  const appendIdx = args.indexOf("-append");
  assert(appendIdx !== -1, "cmdline present");
  assert(args[appendIdx + 1].includes("console=ttyAMA0"), "ARM serial console");
  assert(!args[appendIdx + 1].includes("reboot=t"), "no reboot=t for virt");
  assert(args.some(a => a.startsWith("virtio-blk-pci")), "virtio-blk-pci for virt");
  assert(args.some(a => a.startsWith("virtio-balloon-pci")), "virtio-balloon-pci for virt");
}, "hvf");

// Case 6: aarch64 virt under TCG (resolvedAccel = "tcg,thread=multi")
testCase("aarch64 virt TCG", buildOpts(pa, {
  kernelCmdline: "console=ttyAMA0 root=/dev/vda quiet",
}), "virt", (args) => {
  const cpuIdx = args.indexOf("-cpu");
  assert(cpuIdx !== -1, "-cpu present");
  assert(args[cpuIdx + 1] === "max", "cpu = max under TCG");
}, "tcg,thread=multi");

// ---- Port forwarding tests ----

// Case 7: default SSH forward
testCase("port-forward ssh only", buildOpts(p, {
  portForwards: [{ hostPort: 2222, guestPort: 22 }],
}), "pc", (args) => {
  const idx = args.indexOf("-netdev");
  assert(idx !== -1, "-netdev present");
  assert(args[idx + 1].includes("hostfwd=tcp:127.0.0.1:2222-:22"), "SSH hostfwd present");
  assert(!args[idx + 1].includes("hostfwd=tcp:127.0.0.1:2222-:22,hostfwd="), "no extra hostfwds");
});

// Case 8: no port forwards (empty array — SSH disabled)
testCase("port-forward none", buildOpts(p, {
  portForwards: [],
}), "pc", (args) => {
  const idx = args.indexOf("-netdev");
  assert(idx !== -1, "-netdev present");
  assert(!args[idx + 1].includes("hostfwd"), "no hostfwd when portForwards is empty");
});

// Case 9: single custom TCP forward
testCase("port-forward single tcp", buildOpts(p, {
  portForwards: [{ hostPort: 8080, guestPort: 80, label: "web" }],
}), "pc", (args) => {
  const idx = args.indexOf("-netdev");
  assert(idx !== -1, "-netdev present");
  assert(args[idx + 1].includes("hostfwd=tcp:127.0.0.1:8080-:80"), "custom TCP hostfwd");
});

// Case 10: multiple forwards
testCase("port-forward multiple", buildOpts(p, {
  portForwards: [
    { hostPort: 2222, guestPort: 22, label: "SSH" },
    { hostPort: 8080, guestPort: 80, label: "web" },
    { hostPort: 3443, guestPort: 443, label: "https" },
  ],
}), "pc", (args) => {
  const idx = args.indexOf("-netdev");
  assert(idx !== -1, "-netdev present");
  const val = args[idx + 1];
  assert(val.includes("hostfwd=tcp:127.0.0.1:2222-:22"), "SSH hostfwd");
  assert(val.includes("hostfwd=tcp:127.0.0.1:8080-:80"), "web hostfwd");
  assert(val.includes("hostfwd=tcp:127.0.0.1:3443-:443"), "https hostfwd");
  // All three should be in the same -netdev value, comma-separated
  const matches = val.match(/hostfwd=/g);
  assert(matches !== null && matches!.length === 3, "exactly three hostfwd entries");
});

// Case 11: UDP forward
testCase("port-forward udp", buildOpts(p, {
  portForwards: [{ protocol: "udp", hostPort: 5353, guestPort: 53 }],
}), "pc", (args) => {
  const idx = args.indexOf("-netdev");
  assert(idx !== -1, "-netdev present");
  assert(args[idx + 1].includes("hostfwd=udp:127.0.0.1:5353-:53"), "UDP hostfwd");
});

// Case 12: custom hostIp
testCase("port-forward custom ip", buildOpts(p, {
  portForwards: [{ hostIp: "0.0.0.0", hostPort: 3000, guestPort: 3000 }],
}), "pc", (args) => {
  const idx = args.indexOf("-netdev");
  assert(idx !== -1, "-netdev present");
  assert(args[idx + 1].includes("hostfwd=tcp:0.0.0.0:3000-:3000"), "custom IP hostfwd");
});

// Case 13: port forwards with aarch64 virt
testCase("port-forward aarch64 virt", buildOpts(pa, {
  portForwards: [{ hostPort: 2222, guestPort: 22 }],
}), "virt", (args) => {
  const idx = args.indexOf("-netdev");
  assert(idx !== -1, "-netdev present");
  assert(args[idx + 1].includes("hostfwd=tcp:127.0.0.1:2222-:22"), "aarch64 SSH hostfwd");
});

console.log("ALL GOLDEN ARGS TESTS PASSED");