export type GuestArch = "x86_64" | "aarch64";

export interface GuestProfile {
  arch: GuestArch;
  qemuBinary: string;

  /**
   * CPU model for the guest. Called with the resolved accel so aarch64 can
   * return "host" under HVF pass-through and "max" under TCG.
   * x86_64 returns "host" under KVM/HVF (exposes native ISA extensions —
   * SSE4.2/POPCNT/AVX/AVX2, required by X86-64-v2 baseline wheels like
   * numpy >= 2.0), "max" under TCG, and the QEMU default under WHPX:
   * QEMU 9.2.4's accel_uses_host_cpuid() only accepts -cpu host with
   * KVM or HVF, so WHPX + host fails at startup.
   * Returns undefined when no explicit -cpu is needed.
   */
  cpuFor(accel: string): string | undefined;

  machineFor(accel: string): "microvm" | "pc" | "virt";
  virtioSuffix(machine: string): "-device" | "-pci";
  extraCmdline(machine: string): string;

  /** Kernel cmdline parameters specific to this guest arch/distro. */
  kernelCmdline: string;

  rootImage: string;
  workspaceImage: string;
  kernel?: string;
  initrd?: string;
}

export function x86_64Profile(
  rootImage: string,
  workspaceImage: string,
  kernel?: string,
  initrd?: string,
): GuestProfile {
  return {
    arch: "x86_64",
    qemuBinary: "qemu-system-x86_64",

    cpuFor(accel: string): string | undefined {
      if (accel === "kvm" || accel === "hvf") return "host";
      // QEMU 9.2.4: -cpu host requires KVM or HVF (accel_uses_host_cpuid()).
      // WHPX keeps the default model rather than failing at startup.
      if (accel === "whpx") return undefined;
      return "max";
    },

    machineFor(accel: string): "microvm" | "pc" {
      if (accel !== "tcg,thread=multi") return "microvm";
      return "pc";
    },

    virtioSuffix(machine: string): "-device" | "-pci" {
      return machine === "microvm" ? "-device" : "-pci";
    },

    extraCmdline(machine: string): string {
      return machine === "microvm" ? "reboot=t" : "";
    },

    // Ubuntu 24.04 + systemd: bare `rw` is required — the kernel defaults to `ro`
    // when no read-write flag is on the cmdline. `rootflags=rw` only appends mount
    // options and is ineffective by itself. No `modules=` parameter needed
    // (an Alpine mkinitfs feature — unused in Ubuntu); initramfs has modules
    // baked in via /etc/initramfs-tools/modules.
    kernelCmdline:
      "console=ttyS0 root=/dev/vda rootfstype=ext4 rw quiet systemd.show_status=0 systemd.log_level=err systemd.journald.forward_to_console=0",

    rootImage,
    workspaceImage,
    kernel,
    initrd,
  };
}

export function aarch64Profile(
  rootImage: string,
  workspaceImage: string,
  kernel?: string,
  initrd?: string,
): GuestProfile {
  return {
    arch: "aarch64",
    qemuBinary: "qemu-system-aarch64",

    cpuFor(accel: string): string | undefined {
      if (accel === "hvf") return "host";
      if (accel === "tcg,thread=multi") return "max";
      return "max";
    },

    machineFor(): "virt" {
      return "virt";
    },

    virtioSuffix(): "-pci" {
      return "-pci";
    },

    extraCmdline(): "" {
      return "";
    },

    kernelCmdline:
      "console=ttyAMA0 root=/dev/vda rootfstype=ext4 rw quiet systemd.show_status=0 systemd.log_level=err systemd.journald.forward_to_console=0",

    rootImage,
    workspaceImage,
    kernel,
    initrd,
  };
}

export function isX86_64(arch: GuestArch): boolean {
  return arch === "x86_64";
}

/**
 * Resolve the guest arch from config + environment.
 *
 * Phase 9: on Apple Silicon (darwin + arm64), auto-select aarch64 when
 * both the qemu-system-aarch64 binary and arm64 guest images are staged.
 * Falls back to x86_64 when arch is explicitly set or assets are missing.
 * On all other hosts, always returns x86_64.
 */
export function selectGuest(
  configGuest?: GuestArch,
  binaryExists?: (arch: GuestArch) => boolean,
  imagesExist?: (arch: GuestArch) => boolean,
): GuestArch {
  if (configGuest) return configGuest;

  // On Apple Silicon, auto-select aarch64 when assets are present
  if (process.platform === "darwin" && process.arch === "arm64") {
    const hasBinary = binaryExists ? binaryExists("aarch64") : true;
    const hasImages = imagesExist ? imagesExist("aarch64") : true;
    if (hasBinary && hasImages) return "aarch64";
  }

  return "x86_64";
}
