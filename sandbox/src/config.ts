import { GuestArch } from "./main/guest-profile";

export interface SandboxAppConfig {
  guest?: GuestArch;
  accel?: "auto" | "kvm" | "hvf" | "whpx" | "tcg";
  workspaceDir?: string;
  memMb?: number;
  smp?: number;
  balloonMinMb?: number;
}
