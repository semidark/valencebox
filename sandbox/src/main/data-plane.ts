// Data plane: a host↔guest TCP stream carried over the existing virtio-net +
// WISP path, used for bulk file sync (~9x the virtio-console throughput —
// the console stays as control channel and fallback).
//
// Mechanics: the guest dials SYNC_VIP:SYNC_PORT. v86's wisp adapter turns
// that into a wisp CONNECT which wisp-js hands to our injected socket class
// (conn_options.TCPSocket). For the VIP the "socket" never touches the
// network — bytes bridge directly into a FrameChannel in this process. All
// other destinations get a passthrough to a real TCP socket (stock behavior,
// still subject to the wisp allowlist which runs before any socket I/O).
//
// The VIP is public-unicast space squatted for in-process interception (it
// must pass wisp-js's private/loopback IP filter); packets to it never leave
// the process. A per-boot token gates the channel: the first frame over TCP
// must be HELLO {token} matching what the host advertised over the console.
import * as crypto from "crypto";
import * as net from "net";
import { EventEmitter } from "events";
import { FrameChannel } from "./bridge";
import { Frame, FrameType } from "../shared/protocol";

export const SYNC_VIP = "11.86.86.86";
export const SYNC_PORT = 7575;

export interface DataPlaneAdvert {
  ip: string;
  port: number;
  token: string;
}

/** async byte queue bridging wisp-js's pull-based socket interface */
class ByteQueue {
  private items: (Uint8Array | null)[] = [];
  private waiters: ((v: Uint8Array | null) => void)[] = [];
  private closed = false;
  bytes = 0;
  /** fired when buffered bytes drop below the low-water mark */
  onLow?: () => void;
  lowWater = 0;
  put(x: Uint8Array | null): void {
    if (this.closed) return;
    if (x === null) this.closed = true;
    else this.bytes += x.length;
    const w = this.waiters.shift();
    if (w) {
      if (x !== null) this.bytes -= x.length;
      w(x);
    } else this.items.push(x);
  }
  get(): Promise<Uint8Array | null> {
    if (this.items.length) {
      const x = this.items.shift()!;
      if (x !== null) {
        this.bytes -= x.length;
        if (this.onLow && this.bytes < this.lowWater) this.onLow();
      }
      return Promise.resolve(x);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((r) => this.waiters.push(r));
  }
  get size(): number {
    return this.items.length;
  }
}

export class DataPlane extends EventEmitter {
  readonly token = crypto.randomBytes(16).toString("hex");
  channel: FrameChannel | null = null;

  advert(): DataPlaneAdvert {
    return { ip: SYNC_VIP, port: SYNC_PORT, token: this.token };
  }

  /** resolves with the channel; waits up to timeoutMs for the guest to dial */
  waitChannel(timeoutMs: number): Promise<FrameChannel> {
    if (this.channel) return Promise.resolve(this.channel);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("channel", onCh);
        reject(new Error("data plane: guest did not connect"));
      }, timeoutMs);
      const onCh = (ch: FrameChannel) => {
        clearTimeout(timer);
        resolve(ch);
      };
      this.once("channel", onCh);
    });
  }

  private adopt(toGuest: ByteQueue, fromGuestFeed: (cb: (d: Uint8Array) => void) => void, onDead: (cb: () => void) => void): void {
    const ch = new FrameChannel((buf) => toGuest.put(buf));
    // expose queue depth as backpressure: senders throttle on bufferedBytes
    // and resume on "drain" (see SyncManager.pushFile)
    ch.bufferedBytes = () => toGuest.bytes;
    toGuest.lowWater = 1024 * 1024;
    toGuest.onLow = () => ch.emit("drain");
    ch.on(`frame:${FrameType.HELLO}`, (f: Frame) => {
      let body: any = {};
      try {
        body = JSON.parse(f.payload.toString("utf8"));
      } catch {
        /* fallthrough to reject */
      }
      if (body.token === this.token) {
        ch.send(FrameType.ACK, Buffer.from(JSON.stringify({ ack: f.seq, role: "host", channel: "data" })));
        if (this.channel) this.emit("log", "data plane: replacing previous channel");
        this.channel = ch;
        this.emit("channel", ch);
      } else {
        this.emit("log", "data plane: rejecting connection with bad token");
        toGuest.put(null); // close the stream
      }
    });
    fromGuestFeed((data) => ch.feed(data));
    onDead(() => {
      if (this.channel === ch) {
        this.channel = null;
        this.emit("close");
      }
    });
  }

  /**
   * Class for wisp-js conn_options.TCPSocket: VIP streams bridge in-process
   * to a FrameChannel; everything else is a real-TCP passthrough (the wisp
   * allowlist filter has already run by the time connect() is called).
   */
  socketClass(): any {
    const dp = this;
    return class VipOrTcpSocket {
      hostname: string;
      port: number;
      // vip mode
      private vip = false;
      private toGuest = new ByteQueue();
      private feedCb: ((d: Uint8Array) => void) | null = null;
      private deadCb: (() => void) | null = null;
      // passthrough mode
      private sock: net.Socket | null = null;
      private rq = new ByteQueue();
      private paused = false;

      constructor(hostname: string, port: number) {
        this.hostname = hostname;
        this.port = port;
      }

      async connect(): Promise<void> {
        if (this.hostname === SYNC_VIP) {
          if (this.port !== SYNC_PORT) throw new Error(`vip: bad port ${this.port}`);
          this.vip = true;
          dp.adopt(
            this.toGuest,
            (cb) => (this.feedCb = cb),
            (cb) => (this.deadCb = cb)
          );
          return;
        }
        // stock passthrough (hostname is an allowlist-pinned IP)
        await new Promise<void>((resolve, reject) => {
          const s = new net.Socket();
          this.sock = s;
          s.setNoDelay(true);
          s.once("connect", resolve);
          s.on("data", (d) => {
            this.rq.put(d);
            if (this.rq.size > 64 && !this.paused) {
              s.pause();
              this.paused = true;
            }
          });
          s.on("error", (e) => {
            if (!s.connecting) return;
            reject(e);
          });
          s.on("close", () => this.rq.put(null));
          s.connect({ host: this.hostname, port: this.port });
        });
      }

      async recv(): Promise<Uint8Array | null> {
        if (this.vip) return await this.toGuest.get();
        const d = await this.rq.get();
        if (this.paused && this.sock) {
          this.sock.resume();
          this.paused = false;
        }
        return d;
      }

      async send(data: Uint8Array): Promise<void> {
        if (this.vip) {
          this.feedCb?.(data);
          return;
        }
        await new Promise<void>((r) => {
          if (!this.sock || this.sock.destroyed) return r();
          this.sock.write(data, () => r());
        });
      }

      async close(): Promise<void> {
        if (this.vip) {
          this.toGuest.put(null);
          this.deadCb?.();
          return;
        }
        this.sock?.end();
        this.sock = null;
      }

      pause(): void {}
      resume(): void {}
    };
  }
}
