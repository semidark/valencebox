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

  get connected(): boolean {
    return this.sock !== null && !this.sock.destroyed;
  }

  async connect(sockPath: string, timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`QMP connect timeout`)), timeoutMs);

      this.sock = net.createConnection(sockPath, () => {
        clearTimeout(timer);
      });
      this.sock.setEncoding("utf8");

      this.sock.on("data", (data: string) => this.onData(data));
      this.sock.on("close", () => {
        this.sock = null;
        this.emit("close");
      });
      this.sock.on("error", (err) => this.emit("error", err));

      this.waitForGreeting().then(resolve).catch(reject);
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
        const msg: { event?: string; return?: unknown; error?: { class: string; desc: string } } = JSON.parse(trimmed);
        this.processMessage(msg);
      } catch {
        // skip malformed JSON
      }
    }
  }

  private processMessage(msg: { event?: string; return?: unknown; error?: { class: string; desc: string } }): void {
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

  private waitForGreeting(): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const idx = this.buf.indexOf("\n");
        if (idx === -1) {
          this.sock?.once("data", () => check());
          return;
        }
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.QMP) {
            resolve();
          } else {
            reject(new Error("Unexpected QMP greeting"));
          }
        } catch {
          reject(new Error("QMP greeting parse error"));
        }
      };
      check();
    });
  }
}
