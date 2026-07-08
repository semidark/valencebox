// PTY terminal: opens a real PTY in the guest over the framed virtio-console
// channel. Gives xterm.js a proper terminal (TIOCSWINSZ resize, job control,
// unbuffered stdout) — something the raw serial console (ttyS0) can't do.
//
// Data flow:
//   xterm.js → IPC ptyInput → bridge PTY_DATA frame → hvc0 → sync-agent → PTY master
//   PTY slave (bash) → PTY master → sync-agent → PTY_DATA frame → hvc0 → IPC onPtyData → xterm.js
//   xterm.js resize → IPC ptyResize → bridge PTY_RESIZE frame → hvc0 → TIOCSWINSZ
import { EventEmitter } from "events";
import { FrameType } from "../shared/protocol";
import { HostBridge } from "./bridge";

export class PtyTerminal extends EventEmitter {
  private bridge: HostBridge;
  private open = false;

  constructor(bridge: HostBridge) {
    super();
    this.bridge = bridge;

    this.bridge.on(`frame:${FrameType.PTY_DATA}`, (f: any) => {
      this.emit("data", f.payload);
    });
    this.bridge.on(`frame:${FrameType.PTY_CLOSE}`, () => {
      this.open = false;
      this.emit("closed");
    });
  }

  /** Request a PTY session from the guest. Resolves on ACK. */
  async start(rows = 24, cols = 80): Promise<void> {
    const body = Buffer.from(JSON.stringify({ rows, cols }));
    await this.bridge.request(FrameType.PTY_OPEN, body, 10000);
    this.open = true;
  }

  /** Send keystrokes to the guest PTY (fire-and-forget). */
  sendInput(data: Uint8Array): void {
    if (!this.open) return;
    this.bridge.send(FrameType.PTY_DATA, Buffer.from(data));
  }

  /** Resize the guest PTY via TIOCSWINSZ (fire-and-forget). */
  resize(cols: number, rows: number): void {
    if (!this.open) return;
    const body = Buffer.from(JSON.stringify({ rows, cols }));
    this.bridge.send(FrameType.PTY_RESIZE, body);
  }

  /** Close the PTY session in the guest. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.bridge.send(FrameType.PTY_CLOSE, Buffer.alloc(0));
  }

  get isOpen(): boolean {
    return this.open;
  }
}
