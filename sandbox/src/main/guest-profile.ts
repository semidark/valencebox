export type GuestArch = "x86_64" | "aarch64";

export interface GuestProfile {
  arch: GuestArch;
  qemuBinary: string;
  cpu?: string;

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
    // options and is ineffective by itself. No Alpine `modules=` parameter needed;
    // initramfs has modules baked in.
    kernelCmdline:
      "console=ttyS0 root=/dev/vda rootfstype=ext4 rw quiet systemd.show_status=0 systemd.log_level=err systemd.journald.forward_to_console=0",

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
 * Phase 7: always returns "x86_64". The aarch64 auto-select logic
 * (Apple Silicon + HVF + assets present) is added in Phase 9.
 */
export function selectGuest(configGuest?: GuestArch): GuestArch {
  if (configGuest) return configGuest;
  return "x86_64";
}
