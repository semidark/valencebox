import { EventEmitter } from "events";
import * as net from "net";
import { VmTransport } from "./asset-paths";

export class PtyChannel extends EventEmitter {
  private client: net.Socket | null = null;
  private accumBuffer = Buffer.alloc(0);

  constructor(private transport: VmTransport) {
    super();
  }

  get connected(): boolean {
    return this.client !== null && !this.client.destroyed;
  }

  connect() {
    if (this.client) return;

    if (this.transport.type === "unix") {
      this.client = net.createConnection(this.transport.connectPath);
    } else {
      this.client = net.createConnection(Number(this.transport.connectPath), "127.0.0.1");
    }

    this.client.on("connect", () => this.emit("connected"));
    this.client.on("close", () => {
      this.emit("closed");
      this.client = null;
    });
    this.client.on("error", (err) => this.emit("error", err));

    this.client.on("data", (chunk: Buffer) => {
      this.accumBuffer = Buffer.concat([this.accumBuffer, chunk]);
      this.processBuffer();
    });
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
