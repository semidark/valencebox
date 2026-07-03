// HostBridge: framed request/response + event routing over virtio-console.
import { EventEmitter } from "events";
import {
  Frame,
  FrameParser,
  FrameType,
  encodeFrame,
} from "../shared/protocol";
import { SandboxVM } from "./vm";

interface Pending {
  resolve: (f: Frame) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class HostBridge extends EventEmitter {
  private parser = new FrameParser();
  private seq = 0;
  private pending = new Map<number, Pending>(); // our seq → awaiting ACK/NAK
  private xferWaiters = new Map<number, (f: Frame) => void>(); // xfer id → cb

  constructor(private vm: SandboxVM) {
    super();
    vm.onVirtioConsole((data) => {
      for (const frame of this.parser.push(data)) this.dispatch(frame);
    });
  }

  private dispatch(frame: Frame): void {
    if (frame.type === FrameType.ACK || frame.type === FrameType.NAK) {
      let body: any = {};
      try {
        body = JSON.parse(frame.payload.toString("utf8") || "{}");
      } catch {
        /* non-JSON ack */
      }
      // xfer-routed (transfer progress/completion)
      if (body.xfer !== undefined) {
        const w = this.xferWaiters.get(body.xfer);
        if (w) {
          w(frame);
          return;
        }
      }
      // seq-routed (request/response)
      if (body.ack !== undefined && this.pending.has(body.ack)) {
        const p = this.pending.get(body.ack)!;
        this.pending.delete(body.ack);
        clearTimeout(p.timer);
        if (frame.type === FrameType.NAK) {
          p.reject(new Error(`NAK: ${body.error ?? "unknown"}`));
        } else {
          p.resolve(frame);
        }
        return;
      }
    }
    this.emit("frame", frame);
    this.emit(`frame:${frame.type}`, frame);
  }

  /** Fire-and-forget frame. Returns the sequence number used. */
  send(type: FrameType, payload: Buffer): number {
    const seq = ++this.seq;
    this.vm.virtioConsoleWrite(encodeFrame(type, seq, payload));
    return seq;
  }

  /** Send a frame and wait for its seq-matched ACK. */
  request(type: FrameType, payload: Buffer, timeoutMs = 30000): Promise<Frame> {
    const seq = ++this.seq;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`timeout waiting for ack of ${FrameType[type]} seq ${seq}`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      this.vm.virtioConsoleWrite(encodeFrame(type, seq, payload));
    });
  }

  onXfer(xfer: number, cb: (f: Frame) => void): void {
    this.xferWaiters.set(xfer, cb);
  }

  offXfer(xfer: number): void {
    this.xferWaiters.delete(xfer);
  }

  async ping(timeoutMs = 10000): Promise<number> {
    const t0 = Date.now();
    await this.request(FrameType.PING, Buffer.alloc(0), timeoutMs);
    return Date.now() - t0;
  }

  hello(): Promise<Frame> {
    const body = Buffer.from(JSON.stringify({ version: 1, role: "host", root: "/workspace" }));
    return this.request(FrameType.HELLO, body);
  }

  /** Resolves when the guest agent announces itself. */
  waitGuestHello(timeoutMs = 120000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timeout waiting for guest HELLO")),
        timeoutMs
      );
      this.once(`frame:${FrameType.HELLO}`, (f: Frame) => {
        clearTimeout(timer);
        // acknowledge the guest's hello
        this.send(FrameType.ACK, Buffer.from(JSON.stringify({ ack: f.seq, role: "host" })));
        resolve(f);
      });
    });
  }
}
