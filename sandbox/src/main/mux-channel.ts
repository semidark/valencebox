// MuxChannel: framed, multiplexed byte streams over a single virtio-serial
// chardev socket. This is the host↔guest data plane for strict network mode.
//
// Protocol (see docs/mux-protocol.md):
//   frame  = [u32BE payloadLen][u8 type][u32BE streamId][payload]
//   types  = HELLO OPEN OPEN_OK OPEN_FAIL DATA FIN RESET CREDIT PING PONG
//
// Flow control: each stream has a credit window (MUX_WINDOW). A sender may
// only have MUX_WINDOW uncredited bytes in flight; the receiver grants credit
// back in batches as its consumer drains the data. The guest daemon opens the
// virtio-serial port non-blocking and waits with poll() — blocking reads on
// virtio-serial stall for seconds under load (benchmark evidence, see
// docs/NET-CONTAINMENT.md).
//
// Stream ids never collide between directions: the host allocates odd ids,
// the guest allocates even ids. Either side may open streams (host opens
// "fwd:<guestPort>" for port forwards; the guest opens "proxy"/"share").
//
// Liveness: the host role sends PING every 10 s and expects PONG within 30 s.
// The guest daemon sends HELLO on every start; a repeated HELLO means the
// daemon restarted and all previous streams are dead — host state is reset.

import { Duplex } from "stream";
import * as net from "net";
import { EventEmitter } from "events";
import { VmTransport } from "./asset-paths";

// ---- Protocol constants ----

export const FRAME_HEADER_SIZE = 9;
/** Sanity cap for a single frame payload. DATA frames are sent smaller. */
export const MAX_FRAME_PAYLOAD = 256 * 1024;
/** Accumulation cap before declaring the peer protocol-broken. */
const MAX_ACCUM = 4 * 1024 * 1024;

export const MT_HELLO = 1;
export const MT_OPEN = 2;
export const MT_OPEN_OK = 3;
export const MT_OPEN_FAIL = 4;
export const MT_DATA = 5;
export const MT_FIN = 6;
export const MT_RESET = 7;
export const MT_CREDIT = 8;
export const MT_PING = 9;
export const MT_PONG = 10;

/** Per-stream credit window (bytes in flight before the sender must wait). */
export const MUX_WINDOW = 256 * 1024;
/** Receiver grants credit back in batches of at least this size. */
export const MUX_CREDIT_BATCH = 64 * 1024;

/** Default timeout for openStream (guest boot under TCG is slow). */
export const MUX_OPEN_TIMEOUT = 180_000;

const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;

// Dev/test affordances (never set in production).
const MUX_DEBUG = !!process.env.MUX_DEBUG;
const mts = () => new Date().toISOString().slice(11, 23);
const ENV_PING = process.env.MUX_PING_INTERVAL_MS ? Number(process.env.MUX_PING_INTERVAL_MS) : undefined;
const ENV_PONG = process.env.MUX_PONG_TIMEOUT_MS ? Number(process.env.MUX_PONG_TIMEOUT_MS) : undefined;

export type MuxRole = "host" | "guest";
export type MuxStreamHandler = (target: string, stream: MuxStream) => void;

interface WriteEntry {
  buf: Buffer;
  cb: (err?: Error | null) => void;
}

/**
 * One multiplexed byte stream. A Duplex that behaves like a net.Socket for
 * consumers (http.Server injection, tls.TLSSocket wrapping): no-op
 * setTimeout/setKeepAlive/setNoDelay shims and synthetic addresses so code
 * that expects socket metadata does not crash.
 */
export class MuxStream extends Duplex {
  readonly id: number;

  private sendCredit = MUX_WINDOW;
  private writeQueue: WriteEntry[] = [];
  private ended = false;
  private finSent = false;
  private finReceived = false;
  private resetSent = false;
  private resetReceived = false;
  private quietAbort = false;
  private finCb: ((err?: Error | null) => void) | null = null;
  private received = 0;
  private granted = 0;

  constructor(private channel: MuxChannel, id: number) {
    // writableHighWaterMark is advisory only — the credit window is the real
    // bound on in-flight bytes. Keep it well above a typical chunk so write()
    // return values are meaningful.
    super({ readableHighWaterMark: MUX_WINDOW, writableHighWaterMark: MUX_WINDOW, autoDestroy: true });
    this.id = id;
    this.once("close", () => channel.removeStream(id));
  }

  // ---- net.Socket shims (Node http server and TLS call these) ----

  setTimeout(_msecs?: number, _cb?: () => void): this { return this; }
  setKeepAlive(_enable?: boolean, _initialDelay?: number): this { return this; }
  setNoDelay(_enable?: boolean): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
  get remoteAddress(): string { return "mux-guest"; }
  get remoteFamily(): string { return "IPv4"; }
  get remotePort(): number { return 0; }
  get localAddress(): string { return "mux"; }
  get localPort(): number { return 0; }

  // ---- writable side ----

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.writeQueue.push({ buf: Buffer.from(chunk), cb });
    this.pumpWrites();
  }

  _final(cb: (err?: Error | null) => void): void {
    this.ended = true;
    if (this.writeQueue.length === 0) {
      this.sendFin();
      cb(null);
    } else {
      // FIN goes out after queued data (pumpWrites sends it on drain).
      this.finCb = cb;
    }
  }

  _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    const fail = err ?? new Error("mux stream destroyed");
    for (const e of this.writeQueue) e.cb(fail);
    this.writeQueue = [];
    if (this.finCb) { const f = this.finCb; this.finCb = null; f(err); }
    if (!this.resetSent && !this.resetReceived && !this.quietAbort && !(this.finSent && this.finReceived)) {
      this.resetSent = true;
      if (MUX_DEBUG) console.log(`[mux ${mts()}] RESET sent id=${this.id}`);
      this.channel.sendFrame(MT_RESET, this.id);
    }
    cb(err);
  }

  private pumpWrites(): void {
    while (this.writeQueue.length > 0 && this.sendCredit > 0) {
      const entry = this.writeQueue[0];
      const sendable = Math.min(entry.buf.length, this.sendCredit, MAX_FRAME_PAYLOAD);
      this.channel.sendFrame(MT_DATA, this.id, entry.buf.subarray(0, sendable));
      entry.buf = entry.buf.subarray(sendable);
      this.sendCredit -= sendable;
      if (entry.buf.length === 0) {
        this.writeQueue.shift();
        entry.cb(null);
      }
    }
    if (this.writeQueue.length === 0 && this.ended && !this.finSent) {
      this.sendFin();
    }
  }

  private sendFin(): void {
    this.finSent = true;
    if (MUX_DEBUG) console.log(`[mux ${mts()}] FIN sent id=${this.id}`);
    this.channel.sendFrame(MT_FIN, this.id);
    const cb = this.finCb;
    this.finCb = null;
    cb?.(null);
  }

  /** Destroy without sending RESET (used when OPEN_FAIL already answered). */
  abort(): void {
    this.quietAbort = true;
    this.destroy();
  }

  /** Peer sent RESET (or the daemon restarted) — do not answer with frames. */
  markPeerGone(): void {
    this.resetReceived = true;
  }

  // ---- readable side (fed by the channel) ----

  /**
   * Data is pushed as DATA frames arrive; _read is the consumption hook —
   * a good moment to grant credit for bytes the consumer just drained.
   */
  _read(_size: number): void {
    this.maybeGrant();
  }

  /** @internal */
  handleData(chunk: Buffer): void {
    if (this.finReceived || this.resetReceived || this.destroyed) return;
    if (chunk.length === 0) return;
    this.received += chunk.length;
    this.push(chunk);
    this.maybeGrant();
  }

  /** @internal */
  handleFin(): void {
    if (this.finReceived) return;
    this.finReceived = true;
    this.maybeGrant();
    this.push(null);
  }

  /** @internal */
  handleReset(): void {
    this.resetReceived = true;
    this.destroy(new Error("mux stream reset by peer"));
  }

  /** @internal */
  addCredit(n: number): void {
    this.sendCredit += n;
    this.pumpWrites();
  }

  /**
   * Return credit for bytes the consumer has actually drained out of the
   * readable buffer. While the consumer stalls, credit stays outstanding and
   * the peer's sends block — this is the end-to-end backpressure path.
   */
  private maybeGrant(): void {
    const outstanding = this.received - this.granted;
    if (outstanding < MUX_CREDIT_BATCH) return;
    if (this.readableLength > MUX_WINDOW / 2) return; // consumer behind; hold credit
    const grant = outstanding - this.readableLength;
    if (grant > 0) {
      this.granted += grant;
      const payload = Buffer.alloc(4);
      payload.writeUInt32BE(grant, 0);
      this.channel.sendFrame(MT_CREDIT, this.id, payload);
    }
  }
}

interface PendingOpen {
  resolve: (s: MuxStream) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (e: Error) => void;
}

export interface MuxChannelOptions {
  /** Override liveness intervals (tests). */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export class MuxChannel extends EventEmitter {
  private socket: net.Socket | null = null;
  private accum: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private streams = new Map<number, MuxStream>();
  private pendingOpens = new Map<number, PendingOpen>();
  private readyWaiters: ReadyWaiter[] = [];
  private nextId: number;
  private hello = false;
  private handler: MuxStreamHandler | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPong = 0;
  private stopped = false;
  private closedEmitted = false;
  private pingFails = 0;

  constructor(
    private role: MuxRole,
    private transport?: VmTransport,
    private opts: MuxChannelOptions = {},
  ) {
    super();
    this.nextId = role === "host" ? 1 : 2;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** True once the peer's HELLO was received (safe to open streams). */
  get ready(): boolean {
    return this.hello;
  }

  onStream(handler: MuxStreamHandler): void {
    this.handler = handler;
  }

  /**
   * Connect to the chardev socket with the same retry discipline as
   * PtyChannel (EAGAIN from the listen backlog, ENOENT while QEMU creates
   * the socket, ECONNREFUSED before it listens).
   */
  connect(retries = 60, delayMs = 1000): void {
    if (!this.transport) throw new Error("mux channel: no transport configured");
    if (this.socket || this.stopped) return;

    const attempt = () => {
      if (this.stopped || this.socket) return;
      const client = this.transport!.type === "unix"
        ? net.createConnection(this.transport!.connectPath)
        : net.createConnection(Number(this.transport!.connectPath), "127.0.0.1");

      const onError = (err: NodeJS.ErrnoException) => {
        if (retries > 0 && (err.code === "EAGAIN" || err.code === "ENOENT" || err.code === "ECONNREFUSED")) {
          client.destroy();
          retries--;
          setTimeout(attempt, delayMs);
          return;
        }
        this.emit("error", err);
      };

      client.on("connect", () => {
        client.removeListener("error", onError);
        if (this.stopped) { client.destroy(); return; }
        if (this.socket) { client.destroy(); return; } // already attached
        this.attach(client);
      });
      client.on("error", onError);
    };

    attempt();
  }

  /** Attach an existing socket (tests / external transports). */
  attachSocket(client: net.Socket): void {
    if (this.socket) throw new Error("mux channel already attached");
    this.attach(client);
  }

  private attach(client: net.Socket): void {
    this.socket = client;
    this.accum = Buffer.alloc(0);
    this.lastPong = Date.now();
    this.pingFails = 0;
    client.on("data", (chunk: Buffer) => {
      if (this.socket !== client) return;
      if (this.accum.length + chunk.length > MAX_ACCUM) {
        this.fail(new Error("mux accumulator overflow"));
        return;
      }
      this.accum = this.accum.length === 0 ? (chunk as Buffer) : Buffer.concat([this.accum, chunk]);
      this.processBuffer();
    });
    client.on("close", () => {
      if (this.socket !== client) return;
      this.socket = null;
      this.onClosed();
    });
    client.on("error", (err) => this.emit("error", err));
    if (this.role === "host") {
      const interval = this.opts.pingIntervalMs ?? ENV_PING ?? PING_INTERVAL_MS;
      this.pingTimer = setInterval(() => this.checkPing(), interval);
      this.pingTimer.unref?.();
    } else {
      // The guest daemon sends HELLO on every start (see docs/mux-protocol.md);
      // the guest-role channel mirrors that on attach.
      this.sendFrame(MT_HELLO, 0, Buffer.from("1"));
    }
    this.emit("connected");
  }

  disconnect(): void {
    this.stopped = true;
    const s = this.socket;
    this.socket = null;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    s?.destroy();
    this.finishClosed();
  }

  /** Open a stream to a target served by the peer. Resolves on OPEN_OK. */
  openStream(target: string, timeoutMs: number = MUX_OPEN_TIMEOUT): Promise<MuxStream> {
    if (this.stopped) return Promise.reject(new Error("mux channel stopped"));
    return this.waitReady().then(() => new Promise<MuxStream>((resolve, reject) => {
      if (this.stopped || !this.socket) {
        reject(new Error("mux channel closed"));
        return;
      }
      const id = this.nextId;
      this.nextId = (this.nextId + 2) % 0x100000000 || (this.role === "host" ? 1 : 2);
      const st = new MuxStream(this, id);
      this.streams.set(id, st);
      const timer = setTimeout(() => {
        this.pendingOpens.delete(id);
        this.streams.delete(id);
        st.abort();
        this.sendFrame(MT_RESET, id);
        reject(new Error(`mux open timeout (${timeoutMs}ms) for '${target}'`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingOpens.set(id, { resolve, reject, timer });
      if (MUX_DEBUG) console.log(`[mux ${mts()}] OPEN sent id=${id} target='${target}'`);
      this.sendFrame(MT_OPEN, id, Buffer.from(target, "utf8"));
    }));
  }

  waitReady(): Promise<void> {
    if (this.hello) return Promise.resolve();
    if (this.stopped) return Promise.reject(new Error("mux channel stopped"));
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  /** @internal */
  removeStream(id: number): void {
    this.streams.delete(id);
  }

  /** @internal */
  sendFrame(type: number, id: number, payload?: Buffer): void {
    const s = this.socket;
    if (!s || s.destroyed || !s.writable) return;
    const header = Buffer.alloc(FRAME_HEADER_SIZE);
    header.writeUInt32BE(payload?.length ?? 0, 0);
    header.writeUInt8(type, 4);
    header.writeUInt32BE(id, 5);
    s.write(payload && payload.length > 0 ? Buffer.concat([header, payload]) : header);
  }

  private checkPing(): void {
    const timeout = this.opts.pongTimeoutMs ?? ENV_PONG ?? PONG_TIMEOUT_MS;
    if (!this.socket || !this.hello) {
      this.lastPong = Date.now();
      return;
    }
    if (Date.now() - this.lastPong > timeout) {
      this.pingFails++;
      console.error(`[mux] peer unresponsive for ${Date.now() - this.lastPong}ms — dropping channel`);
      const s = this.socket;
      this.socket = null;
      s.destroy();
      this.onClosed();
      return;
    }
    this.sendFrame(MT_PING, 0);
  }

  private processBuffer(): void {
    while (this.accum.length >= FRAME_HEADER_SIZE) {
      const len = this.accum.readUInt32BE(0);
      const type = this.accum.readUInt8(4);
      const id = this.accum.readUInt32BE(5);
      if (len > MAX_FRAME_PAYLOAD) {
        this.fail(new Error(`mux frame too large: ${len}`));
        return;
      }
      const frameLen = FRAME_HEADER_SIZE + len;
      if (this.accum.length < frameLen) break;
      const payload = this.accum.subarray(FRAME_HEADER_SIZE, frameLen);
      this.accum = this.accum.subarray(frameLen);
      try {
        this.dispatch(type, id, payload);
      } catch (err) {
        this.emit("error", err);
      }
    }
  }

  private dispatch(type: number, id: number, payload: Buffer): void {
    switch (type) {
      case MT_HELLO:
        this.handleHello();
        break;
      case MT_OPEN:
        this.handleOpen(id, payload.toString("utf8"));
        break;
      case MT_OPEN_OK: {
        const p = this.pendingOpens.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pendingOpens.delete(id);
          const st = this.streams.get(id);
          if (st) p.resolve(st);
        }
        break;
      }
      case MT_OPEN_FAIL: {
        const p = this.pendingOpens.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pendingOpens.delete(id);
          this.streams.get(id)?.abort();
          this.streams.delete(id);
          p.reject(new Error(`mux open refused for stream ${id}: ${payload.toString("utf8") || "unknown reason"}`));
        }
        break;
      }
      case MT_DATA:
        this.streams.get(id)?.handleData(payload);
        break;
      case MT_FIN:
        this.streams.get(id)?.handleFin();
        break;
      case MT_RESET: {
        const st = this.streams.get(id);
        if (st) {
          this.streams.delete(id);
          st.handleReset();
        }
        const p = this.pendingOpens.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.pendingOpens.delete(id);
          p.reject(new Error(`mux stream ${id} reset by peer`));
        }
        break;
      }
      case MT_CREDIT:
        if (payload.length >= 4) this.streams.get(id)?.addCredit(payload.readUInt32BE(0));
        break;
      case MT_PING:
        if (MUX_DEBUG) console.log(`[mux ${mts()}] PING received`);
        this.sendFrame(MT_PONG, id);
        break;
      case MT_PONG:
        if (MUX_DEBUG) console.log(`[mux ${mts()}] PONG received`);
        this.lastPong = Date.now();
        this.pingFails = 0;
        break;
      default:
        // Unknown frame type: ignore for forward compatibility.
        break;
    }
  }

  private handleHello(): void {
    if (this.hello) {
      // Guest daemon restarted: every previous stream is dead on the peer side.
      console.log("[mux] HELLO re-received — peer restarted, resetting all streams");
      this.resetAll("mux peer restarted");
    }
    this.hello = true;
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.resolve();
    this.emit("ready");
  }

  private handleOpen(id: number, target: string): void {
    if (this.streams.has(id)) {
      this.sendFrame(MT_RESET, id);
      return;
    }
    const st = new MuxStream(this, id);
    if (!this.handler) {
      st.abort();
      this.sendFrame(MT_OPEN_FAIL, id, Buffer.from("no handler registered"));
      return;
    }
    try {
      this.handler(target, st);
    } catch (err: any) {
      st.abort();
      this.sendFrame(MT_OPEN_FAIL, id, Buffer.from(String(err?.message ?? "refused").slice(0, 128)));
      return;
    }
    this.streams.set(id, st);
    this.sendFrame(MT_OPEN_OK, id);
  }

  private resetAll(msg: string): void {
    for (const st of this.streams.values()) {
      st.markPeerGone();
      st.destroy(new Error(msg));
    }
    this.streams.clear();
    for (const p of this.pendingOpens.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(msg));
    }
    this.pendingOpens.clear();
  }

  private onClosed(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.hello = false;
    this.resetAll("mux channel closed");
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.reject(new Error("mux channel closed"));
    this.finishClosed();
  }

  private finishClosed(): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.emit("closed");
  }

  private fail(err: Error): void {
    this.emit("error", err);
    const s = this.socket;
    this.socket = null;
    s?.destroy();
    this.onClosed();
  }
}
