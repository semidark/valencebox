// Framed protocol over virtio-console — see PROTOCOL.md.
// Mirrors guest/sync-agent/frame.go bit-for-bit.

export const MAGIC = Buffer.from("V86S", "latin1");
export const MAX_PAYLOAD = 262144;
export const CHUNK_SIZE = 48 * 1024;

export enum FrameType {
  HELLO = 1,
  MANIFEST = 2,
  FILE_PUT = 3,
  FILE_CHUNK = 4,
  FILE_DEL = 5,
  ACK = 6,
  NAK = 7,
  EVENT = 8,
  PING = 9,
  // announces a batched small-file archive; the archive body streams as
  // FILE_CHUNK frames under the same xfer id (see PROTOCOL.md)
  TREE_PUT = 10,
}

export interface Frame {
  type: FrameType;
  seq: number;
  payload: Buffer;
}

// ---- CRC32 (IEEE, same polynomial as Go hash/crc32.IEEE) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export function encodeFrame(type: FrameType, seq: number, payload: Buffer): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error(`payload too large: ${payload.length}`);
  const hdr = Buffer.alloc(9);
  hdr.writeUInt8(type, 0);
  hdr.writeUInt32LE(seq, 1);
  hdr.writeUInt32LE(payload.length, 5);
  const crcBody = Buffer.concat([hdr, payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(crcBody), 0);
  return Buffer.concat([MAGIC, hdr, payload, crc]);
}

// Streaming parser with magic-hunt resynchronization.
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(data: Uint8Array): Frame[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(data)]);
    const frames: Frame[] = [];
    for (;;) {
      const start = this.buf.indexOf(MAGIC);
      if (start === -1) {
        // keep last 3 bytes in case magic is split across pushes
        if (this.buf.length > 3) this.buf = this.buf.subarray(this.buf.length - 3);
        return frames;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      if (this.buf.length < 13) return frames; // magic + header
      const type = this.buf.readUInt8(4);
      const seq = this.buf.readUInt32LE(5);
      const plen = this.buf.readUInt32LE(9);
      if (plen > MAX_PAYLOAD) {
        this.buf = this.buf.subarray(4); // bad header — resync past this magic
        continue;
      }
      const total = 13 + plen + 4;
      if (this.buf.length < total) return frames;
      const payload = this.buf.subarray(13, 13 + plen);
      const wireCrc = this.buf.readUInt32LE(13 + plen);
      const calc = crc32(this.buf.subarray(4, 13 + plen));
      if (calc !== wireCrc) {
        this.buf = this.buf.subarray(4); // corrupt — resync
        continue;
      }
      frames.push({ type, seq, payload: Buffer.from(payload) });
      this.buf = this.buf.subarray(total);
    }
  }
}

export interface FileMeta {
  hash: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

export interface ManifestPayload {
  files: Record<string, FileMeta>;
}

export interface PutMeta extends FileMeta {
  xfer: number;
  path: string;
}

export interface TreePutMeta {
  xfer: number;
  size: number; // total archive bytes
  count: number; // number of entries
}

/**
 * One archive entry for TREE_PUT: [u32le header-len][JSON header][raw bytes].
 * The header is a PutMeta-like JSON object {path, size, mode, mtimeMs, hash}.
 */
export function encodeTreeEntry(header: object, data: Buffer): Buffer {
  const h = Buffer.from(JSON.stringify(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(h.length, 0);
  return Buffer.concat([len, h, data]);
}

export function encodeChunk(xfer: number, offset: number, data: Buffer): Buffer {
  const p = Buffer.alloc(12 + data.length);
  p.writeUInt32LE(xfer, 0);
  p.writeBigUInt64LE(BigInt(offset), 4);
  data.copy(p, 12);
  return p;
}

export function decodeChunk(payload: Buffer): { xfer: number; offset: number; data: Buffer } {
  return {
    xfer: payload.readUInt32LE(0),
    offset: Number(payload.readBigUInt64LE(4)),
    data: payload.subarray(12),
  };
}
