import { x86_64Profile, aarch64Profile, selectGuest, isX86_64 } from "../src/main/guest-profile";

const ROOT = "/images/root.qcow2";
const WS = "/images/ws.qcow2";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ---- x86_64Profile factory ----

{
  const p = x86_64Profile(ROOT, WS);
  assert(p.arch === "x86_64", "arch is x86_64");
  assert(p.qemuBinary === "qemu-system-x86_64", "qemu binary is x86_64");
  assert(p.cpuFor("kvm") === undefined, "no -cpu for x86_64");
  assert(p.cpuFor("tcg,thread=multi") === undefined, "no -cpu for x86_64 TCG");

  assert(p.rootImage === ROOT, "rootImage from factory");
  assert(p.workspaceImage === WS, "workspaceImage from factory");
  assert(p.kernel === undefined, "no kernel");
  assert(p.initrd === undefined, "no initrd");
  assert(typeof p.kernelCmdline === "string", "kernelCmdline is string");
  assert(p.kernelCmdline.includes("console=ttyS0"), "kernelCmdline has console");
  assert(!p.kernelCmdline.includes("modules="), "no modules= param (Alpine-ism removed in Ubuntu migration)");
  console.log("✓ x86_64Profile: basic fields");
}

// ---- machineFor ----

{
  const p = x86_64Profile(ROOT, WS);
  assert(p.machineFor("kvm") === "microvm", "kvm → microvm");
  assert(p.machineFor("hvf") === "microvm", "hvf → microvm");
  assert(p.machineFor("whpx") === "microvm", "whpx → microvm");
  assert(p.machineFor("tcg,thread=multi") === "pc", "tcg → pc");
  console.log("✓ machineFor: hw accel → microvm, TCG → pc");
}

// ---- virtioSuffix ----

{
  const p = x86_64Profile(ROOT, WS);
  assert(p.virtioSuffix("microvm") === "-device", "microvm → -device");
  assert(p.virtioSuffix("pc") === "-pci", "pc → -pci");
  console.log("✓ virtioSuffix: microvm → -device, pc → -pci");
}

// ---- extraCmdline ----

{
  const p = x86_64Profile(ROOT, WS);
  assert(p.extraCmdline("microvm") === "reboot=t", "microvm → reboot=t");
  assert(p.extraCmdline("pc") === "", "pc → empty");
  console.log("✓ extraCmdline: microvm → reboot=t, pc → empty");
}

// ---- selectGuest ----

{
  // No config → x86_64 on non-Apple-Silicon (assets don't matter)
  const arch = selectGuest(undefined, () => true, () => true);
  if (process.platform === "darwin" && process.arch === "arm64") {
    assert(arch === "aarch64", "default selectGuest on Apple Silicon → aarch64");
  } else {
    assert(arch === "x86_64", "default selectGuest on non-Apple-Silicon → x86_64");
  }
  console.log("✓ selectGuest: default → x86_64 or aarch64 by platform");
}

{
  // On Apple Silicon, missing aarch64 binary → fallback to x86_64
  const arch = selectGuest(undefined, () => false, () => true);
  assert(arch === "x86_64", "selectGuest no aarch64 binary → x86_64");
  console.log("✓ selectGuest: no aarch64 binary → x86_64 fallback");
}

{
  // Explicit aarch64 — honor config override regardless of platform
  const arch = selectGuest("aarch64");
  assert(arch === "aarch64", "selectGuest aarch64");
  console.log("✓ selectGuest: explicit aarch64");
}

{
  // Explicit x86_64
  const arch = selectGuest("x86_64");
  assert(arch === "x86_64", "selectGuest x86_64");
  console.log("✓ selectGuest: explicit x86_64");
}

// ---- isX86_64 ----

{
  assert(isX86_64("x86_64") === true, "isX86_64 x86_64");
  assert(isX86_64("aarch64") === false, "isX86_64 aarch64");
  console.log("✓ isX86_64");
}

// ---- x86_64Profile with kernel/initrd ----

{
  const p = x86_64Profile(ROOT, WS, "/boot/vmlinuz", "/boot/initramfs");
  assert(p.kernel === "/boot/vmlinuz", "profile kernel");
  assert(p.initrd === "/boot/initramfs", "profile initrd");
  console.log("✓ x86_64Profile with kernel+initrd");
}

// ---- aarch64Profile factory ----

{
  const p = aarch64Profile("/images/root-arm64.qcow2", "/images/ws-arm64.qcow2");
  assert(p.arch === "aarch64", "arch is aarch64");
  assert(p.qemuBinary === "qemu-system-aarch64", "qemu binary is aarch64");

  assert(p.cpuFor("hvf") === "host", "cpuFor(hvf) → host");
  assert(p.cpuFor("tcg,thread=multi") === "max", "cpuFor(tcg) → max");

  assert(p.machineFor("hvf") === "virt", "hvf → virt");
  assert(p.machineFor("tcg,thread=multi") === "virt", "tcg → virt");
  assert(p.virtioSuffix("virt") === "-pci", "virt → -pci");
  assert(p.extraCmdline("virt") === "", "virt → no extra cmdline");

  assert(p.rootImage === "/images/root-arm64.qcow2", "rootImage from factory");
  assert(p.workspaceImage === "/images/ws-arm64.qcow2", "workspaceImage from factory");
  assert(p.kernel === undefined, "no kernel");
  assert(p.initrd === undefined, "no initrd");
  assert(typeof p.kernelCmdline === "string", "kernelCmdline is string");
  assert(p.kernelCmdline.includes("console=ttyAMA0"), "kernelCmdline has ARM console");
  assert(!p.kernelCmdline.includes("modules="), "no modules= param (Alpine-ism removed in Ubuntu migration)");
  console.log("✓ aarch64Profile: basic fields");
}

{
  const p = aarch64Profile("/r.qcow2", "/w.qcow2", "/boot/vmlinuz-arm64", "/boot/initrd-arm64");
  assert(p.kernel === "/boot/vmlinuz-arm64", "profile kernel");
  assert(p.initrd === "/boot/initrd-arm64", "profile initrd");
  console.log("✓ aarch64Profile with kernel+initrd");
}

console.log("ALL GUEST PROFILE TESTS PASSED");
