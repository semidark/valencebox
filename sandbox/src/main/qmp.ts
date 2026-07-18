import * as net from "net";
import { EventEmitter } from "events";

interface PendingCmd {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  request: string;
}

export class QmpClient extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf = "";
  private cmdSeq = 0;
  private pending: PendingCmd | null = null;
  private queue: PendingCmd[] = [];
  private greetingResolve: (() => void) | null = null;
  private greetingReject: ((e: Error) => void) | null = null;
  private greetingTimer: ReturnType<typeof setTimeout> | null = null;

  get connected(): boolean {
    return this.sock !== null && !this.sock.destroyed;
  }

  async connect(port: number, host = "127.0.0.1", timeoutMs = 15_000): Promise<void> {
    return this.connectRetry(timeoutMs, () => this.tryConnect(port, host));
  }

  async connectPath(path: string, timeoutMs = 15_000): Promise<void> {
    return this.connectRetry(timeoutMs, () => this.tryConnectPath(path));
  }

  private async connectRetry(timeoutMs: number, tryConnect: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: Error | undefined;

    while (Date.now() < deadline) {
      try {
        await tryConnect();
        return;
      } catch (e: any) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    throw lastErr ?? new Error(`QMP connect timeout after ${timeoutMs}ms`);
  }

  private async tryConnect(port: number, host: string): Promise<void> {
    this.cleanup();
    return new Promise((resolve, reject) => {
      this.setupGreetingHandlers(resolve, reject);
      this.sock = net.createConnection(port, host, () => {});
      this.sock.setEncoding("utf8");
      this.sock.on("data", (data: string) => this.onData(data));
      this.sock.on("close", () => this.onClose());
      this.sock.on("error", (err) => this.onError(err));
    });
  }

  private async tryConnectPath(path: string): Promise<void> {
    this.cleanup();
    return new Promise((resolve, reject) => {
      this.setupGreetingHandlers(resolve, reject);
      this.sock = net.createConnection(path, () => {});
      this.sock.setEncoding("utf8");
      this.sock.on("data", (data: string) => this.onData(data));
      this.sock.on("close", () => this.onClose());
      this.sock.on("error", (err) => this.onError(err));
    });
  }

  private setupGreetingHandlers(resolve: () => void, reject: (e: Error) => void): void {
    this.greetingResolve = resolve;
    this.greetingReject = reject;
    this.greetingTimer = setTimeout(() => {
      if (this.greetingReject) {
        this.greetingReject(new Error("QMP greeting timeout"));
      }
    }, 15_000);
  }

  private cleanup(): void {
    this.sock?.destroy();
    this.sock = null;
    this.greetingResolve = null;
    this.greetingReject = null;
    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    this.greetingTimer = null;
  }

  private onClose(): void {
    if (this.greetingReject) {
      this.greetingReject(new Error("QMP connection closed before greeting"));
    }
    this.sock = null;
  }

  private onError(err: Error): void {
    if (this.greetingReject) {
      this.greetingReject(err);
    }
  }

  /** Set balloon target in MB. QEMU expects bytes. */
  async setBalloon(mb: number): Promise<void> {
    await this.execute("balloon", { value: mb * 1024 * 1024 });
  }

  /** Query current balloon size. Returns actual guest RAM in bytes. */
  async queryBalloon(): Promise<{ actual: number }> {
    return this.execute("query-balloon") as Promise<{ actual: number }>;
  }

  disconnect(): void {
    this.sock?.destroy();
    this.sock = null;
    this.pending = null;
    for (const p of this.queue) p.reject(new Error("QMP disconnected"));
    this.queue = [];
  }

  async execute<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.sock) throw new Error("QMP not connected");

    const id = String(++this.cmdSeq);
    const request = args
      ? JSON.stringify({ execute: cmd, arguments: args, id }) + "\n"
      : JSON.stringify({ execute: cmd, id }) + "\n";

    return new Promise((resolve, reject) => {
      const entry: PendingCmd = { resolve: resolve as (v: unknown) => void, reject, request };
      if (this.pending) {
        this.queue.push(entry);
      } else {
        this.pending = entry;
        this.sock!.write(entry.request);
      }
    });
  }

  private onData(data: string): void {
    this.buf += data;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg: {
          event?: string;
          return?: unknown;
          error?: { class: string; desc: string };
          QMP?: { version: unknown };
        } = JSON.parse(trimmed);
        this.processMessage(msg);
      } catch {
        // skip malformed JSON
      }
    }
  }

  private processMessage(msg: {
    event?: string;
    return?: unknown;
    error?: { class: string; desc: string };
    QMP?: { version: unknown };
  }): void {
    // QMP greeting — resolve the connect() promise
    if (msg.QMP) {
      if (this.greetingTimer) clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
      if (this.greetingResolve) {
        this.greetingResolve();
        this.greetingResolve = null;
        this.greetingReject = null;
      }
      return;
    }

    if (msg.event) {
      this.emit("event", msg.event);
      return;
    }

    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    if (msg.error) {
      p.reject(new Error(`QMP error: ${msg.error.class} — ${msg.error.desc}`));
    } else {
      p.resolve(msg["return"]);
    }

    const next = this.queue.shift();
    if (next) {
      this.pending = next;
      this.sock!.write(next.request);
    }
  }
}
