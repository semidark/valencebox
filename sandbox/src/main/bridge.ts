// FrameChannel: framed request/response + event routing over any byte
// stream. HostBridge binds it to the virtio-console (control channel); the
// data plane (data-plane.ts) binds it to a wisp-routed TCP stream.
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

export class FrameChannel extends EventEmitter {
  private parser = new FrameParser();
  private seq = 0;
  private pending = new Map<number, Pending>(); // our seq → awaiting ACK/NAK
  private xferWaiters = new Map<number, (f: Frame) => void>(); // xfer id → cb

  /** bytes queued but not yet consumed by the transport (backpressure);
   *  set by the transport owner (data-plane), unset ⇒ no signal available */
  bufferedBytes?: () => number;

  constructor(private writeRaw: (buf: Buffer) => void) {
    super();
  }

  /** feed raw bytes received from the peer into the frame parser */
  feed(data: Uint8Array): void {
    for (const frame of this.parser.push(data)) this.dispatch(frame);
  }

  private dispatch(frame: Frame): void {
    if (frame.type === FrameType.PING) {
      // liveness probe from the guest (data-plane keepalive) — always answer
      this.send(FrameType.ACK, Buffer.from(JSON.stringify({ ack: frame.seq })));
      return;
    }
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
    this.writeRaw(encodeFrame(type, seq, payload));
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
      this.writeRaw(encodeFrame(type, seq, payload));
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
}

export class HostBridge extends FrameChannel {
  /** extra fields merged into HELLO / hello-ACK payloads (data-plane advert) */
  helloExtra: Record<string, unknown> = {};

  constructor(vm: SandboxVM) {
    super((buf) => vm.virtioConsoleWrite(buf));
    vm.onVirtioConsole((data) => this.feed(data));
  }

  hello(): Promise<Frame> {
    const body = Buffer.from(
      JSON.stringify({ version: 1, role: "host", root: "/workspace", ...this.helloExtra })
    );
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
        // acknowledge the guest's hello (and advertise the data plane)
        this.send(
          FrameType.ACK,
          Buffer.from(JSON.stringify({ ack: f.seq, role: "host", ...this.helloExtra }))
        );
        resolve(f);
      });
    });
  }
}
