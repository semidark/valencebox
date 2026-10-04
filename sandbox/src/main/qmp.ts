import * as net from "net";
import { EventEmitter } from "events";

interface PendingCmd {
  id: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  request: string;
  timer: ReturnType<typeof setTimeout>;
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
  private generation = 0;

  get connected(): boolean {
    return this.sock !== null && !this.sock.destroyed;
  }

  async connect(port: number, host = "127.0.0.1", timeoutMs = 15_000): Promise<void> {
    return this.connectRetry(timeoutMs, (remaining) => this.tryConnect(() => net.createConnection(port, host), remaining));
  }

  async connectPath(path: string, timeoutMs = 15_000): Promise<void> {
    return this.connectRetry(timeoutMs, (remaining) => this.tryConnect(() => net.createConnection(path), remaining));
  }

  private async connectRetry(timeoutMs: number, tryConnect: (remaining: number) => Promise<void>): Promise<void> {
    const generation = ++this.generation;
    const deadline = Date.now() + timeoutMs;
    let lastErr: Error | undefined;

    while (Date.now() < deadline) {
      if (generation !== this.generation) throw new Error("QMP disconnected");
      try {
        await tryConnect(Math.max(1, deadline - Date.now()));
        return;
      } catch (e: any) {
        if (generation !== this.generation) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, Math.min(200, Math.max(0, deadline - Date.now()))));
      }
    }

    throw lastErr ?? new Error(`QMP connect timeout after ${timeoutMs}ms`);
  }

  private async tryConnect(createSocket: () => net.Socket, timeoutMs: number): Promise<void> {
    this.cleanup(new Error("QMP connection replaced"));
    return new Promise((resolve, reject) => {
      this.greetingResolve = resolve;
      this.greetingReject = reject;
      const sock = createSocket();
      this.sock = sock;
      this.greetingTimer = setTimeout(() => {
        if (this.sock === sock) this.cleanup(new Error("QMP greeting timeout"));
      }, timeoutMs);
      sock.setEncoding("utf8");
      // Events from a replaced socket must not clear a new connection.
      sock.on("data", (data: string) => { if (this.sock === sock) this.onData(data); });
      sock.on("close", () => { if (this.sock === sock) this.cleanup(new Error("QMP connection closed")); });
      sock.on("error", (err) => { if (this.sock === sock) this.cleanup(err); });
    });
  }

  private cleanup(err: Error): void {
    const sock = this.sock;
    this.sock = null;
    sock?.destroy();
    this.buf = "";
    this.greetingReject?.(err);
    this.greetingResolve = null;
    this.greetingReject = null;
    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    this.greetingTimer = null;
    const commands = this.pending ? [this.pending, ...this.queue] : this.queue;
    this.pending = null;
    this.queue = [];
    for (const cmd of commands) {
      clearTimeout(cmd.timer);
      cmd.reject(err);
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
    this.generation++;
    this.cleanup(new Error("QMP disconnected"));
  }

  async execute<T = unknown>(cmd: string, args?: Record<string, unknown>, timeoutMs = 5_000): Promise<T> {
    if (!this.connected) throw new Error("QMP not connected");

    const id = String(++this.cmdSeq);
    const request = args
      ? JSON.stringify({ execute: cmd, arguments: args, id }) + "\n"
      : JSON.stringify({ execute: cmd, id }) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Invalidate the connection: a late reply cannot satisfy another command.
        this.cleanup(new Error(`QMP ${cmd} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const entry: PendingCmd = { id, resolve: resolve as (v: unknown) => void, reject, request, timer };
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
          id?: string;
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
    id?: string;
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

    if (!this.pending || msg.id !== this.pending.id) return;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(new Error(`QMP error: ${msg.error.class} — ${msg.error.desc}`));
    } else {
      p.resolve(msg["return"]);
    }

    const next = this.queue.shift();
    if (next && this.sock) {
      this.pending = next;
      this.sock!.write(next.request);
    }
  }
}
