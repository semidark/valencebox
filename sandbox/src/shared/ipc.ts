// Shared IPC contract between main and renderer.
export interface SandboxStatus {
  phase: "boot" | "restore" | "hydrating" | "ready" | "stopped" | "error";
  bootMs?: number;
  accel?: string;
  accelAvailable?: boolean;
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
  ptyConnected?: boolean;
  /** True when the host config swaps physical Ctrl/Cmd for terminal control. */
  swapCtrlCmd?: boolean;
  error?: string;
}

export interface ConflictRecordDTO {
  path: string;
  winner: "local" | "remote";
  at: number;
}

export interface BalloonStatus {
  currentMB: number;
  ceilingMB: number;
  minMB: number;
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
  // Memory balloon control
  setBalloon: "sandbox:setBalloon", // renderer→main: set balloon to N MB
  getBalloon: "sandbox:getBalloon", // renderer→main: get current balloon status → BalloonStatus
  // Clipboard (terminal copy/paste via Ctrl+Shift+C/V; routed through main
  // so it works regardless of renderer secure-context / permission state)
  clipboardRead: "sandbox:clipboard:read", // renderer→main: read clipboard → string
  clipboardWrite: "sandbox:clipboard:write", // renderer→main: write clipboard (fire-and-forget)
} as const;
