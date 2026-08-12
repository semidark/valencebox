import { EventEmitter } from "events";
import * as net from "net";
import { VmTransport } from "./asset-paths";

const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MB sanity cap
const MAX_ACCUM = 65536;

export class PtyChannel extends EventEmitter {
  private client: net.Socket | null = null;
  private accumBuffer = Buffer.alloc(0);

  constructor(private transport: VmTransport) {
    super();
  }

  get connected(): boolean {
    return this.client !== null && !this.client.destroyed;
  }

  connect(retries = 60, delayMs = 1000) {
    if (this.client) return;

    const attempt = () => {
      const client = this.transport.type === "unix"
        ? net.createConnection(this.transport.connectPath)
        : net.createConnection(Number(this.transport.connectPath), "127.0.0.1");

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
        this.client = client;
        this.emit("connected");
      });
      client.on("close", () => {
        if (this.client !== client) return;
        this.emit("closed");
        this.client = null;
      });
      client.on("error", onError);
      client.on("data", (chunk: Buffer) => {
        if (this.accumBuffer.length + chunk.length > MAX_ACCUM) {
          this.emit("error", new Error("pty accumulator overflow"));
          this.disconnect();
          return;
        }
        this.accumBuffer = Buffer.concat([this.accumBuffer, chunk]);
        this.processBuffer();
      });
    };

    attempt();
  }

  disconnect() {
    this.client?.destroy();
    this.client = null;
  }

  sendInput(data: Uint8Array) {
    this.sendFrame(1, Buffer.from(data));
  }

  resize(cols: number, rows: number) {
    const payload = Buffer.alloc(4);
    payload.writeUInt16BE(cols, 0);
    payload.writeUInt16BE(rows, 2);
    this.sendFrame(2, payload);
  }

  private sendFrame(type: number, payload: Buffer) {
    if (!this.client?.writable) return;
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length, 0);
    header.writeUInt8(type, 4);
    this.client.write(Buffer.concat([header, payload]));
  }

  private processBuffer() {
    while (this.accumBuffer.length >= 5) {
      const payloadLen = this.accumBuffer.readUInt32BE(0);
      const type = this.accumBuffer.readUInt8(4);
      if (payloadLen > MAX_FRAME_SIZE) {
        this.emit("error", new Error(`pty frame too large: ${payloadLen}`));
        this.disconnect();
        return;
      }
      const frameLen = 5 + payloadLen;

      if (this.accumBuffer.length < frameLen) {
        break;
      }

      const payload = this.accumBuffer.subarray(5, frameLen);
      this.accumBuffer = this.accumBuffer.subarray(frameLen);

      if (type === 1) {
        this.emit("data", new Uint8Array(payload));
      } else if (type === 4) {
        this.emit("closed");
      }
    }
  }
}
