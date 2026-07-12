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

  async connect(sockPath: string, timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      this.greetingResolve = resolve;
      this.greetingReject = reject;
      this.greetingTimer = setTimeout(() => {
        if (this.greetingReject) {
          this.greetingReject(new Error("QMP greeting timeout"));
        }
      }, timeoutMs);

      this.sock = net.createConnection(sockPath, () => {
        // TCP connected — wait for QMP greeting JSON in onData
      });
      this.sock.setEncoding("utf8");

      this.sock.on("data", (data: string) => this.onData(data));
      this.sock.on("close", () => {
        this.sock = null;
        this.emit("close");
      });
      this.sock.on("error", (err) => {
        if (this.greetingReject) {
          this.greetingReject(err);
        }
        this.emit("error", err);
      });
    });
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
