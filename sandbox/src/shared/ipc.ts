// Shared IPC contract between main and renderer.
export interface SandboxStatus {
  phase: "boot" | "restore" | "hydrating" | "ready" | "stopped" | "error";
  bootMs?: number;
  restored?: boolean;
  guest?: { root: string; version: number };
  net?: { relayUrl: string; policyHosts: string[]; dataPlane?: boolean };
  sync?: {
    pushed: number;
    pulled: number;
    deleted: number;
    conflicts: number;
    bytesOut: number;
    bytesIn: number;
    throughput?: { out: number; in: number };
  };
  snapshot?: { at: number; compressedBytes: number } | null;
  error?: string;
}

export interface ConflictRecordDTO {
  path: string;
  winner: "local" | "remote";
  at: number;
}

export const IPC = {
  getStatus: "sandbox:getStatus",
  onStatus: "sandbox:status",
  onSerial: "sandbox:serial",
  onConflict: "sandbox:conflict",
  saveSnapshot: "sandbox:saveSnapshot",
  serialInput: "sandbox:serialInput", // raw keystrokes renderer→guest serial (fire-and-forget)
  // PTY terminal (opens after sandbox reaches "ready" phase)
  onPtyData: "sandbox:pty:data", // guest→renderer: PTY output bytes
  onPtyClosed: "sandbox:pty:closed", // guest→renderer: PTY session ended
  ptyInput: "sandbox:pty:input", // renderer→guest: keystrokes (fire-and-forget)
  ptyResize: "sandbox:pty:resize", // renderer→guest: {cols, rows}
} as const;
