import { x86_64Profile, selectGuest, isX86_64 } from "../src/main/guest-profile";

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
  assert(p.cpu === undefined, "no -cpu for x86_64");

  assert(p.rootImage === ROOT, "rootImage from factory");
  assert(p.workspaceImage === WS, "workspaceImage from factory");
  assert(p.kernel === undefined, "no kernel");
  assert(p.initrd === undefined, "no initrd");
  assert(typeof p.kernelCmdline === "string", "kernelCmdline is string");
  assert(p.kernelCmdline.includes("console=ttyS0"), "kernelCmdline has console");
  assert(!p.kernelCmdline.includes("modules="), "no Alpine modules= param");
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
  // No config → x86_64 in Phase 7
  const arch = selectGuest(undefined);
  assert(arch === "x86_64", "default selectGuest → x86_64");
  console.log("✓ selectGuest: default → x86_64");
}

{
  // Explicit aarch64 — not functional yet but the gate honors it
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

console.log("ALL GUEST PROFILE TESTS PASSED");
