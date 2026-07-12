export interface SandboxAppConfig {
  accel?: "auto" | "kvm" | "hvf" | "whpx" | "tcg";
  workspaceDir?: string;
  memMb?: number;
  smp?: number;
  egress?: {
    allowAll?: boolean;
    extraHosts?: string[];
    extraPorts?: (number | [number, number])[];
  };
}
