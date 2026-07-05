// SyncManager: host side of the bidirectional /workspace sync.
// Canonical store = host directory. See PROTOCOL.md for wire semantics.
import { EventEmitter } from "events";
import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as chokidar from "chokidar";
import {
  CHUNK_SIZE,
  Frame,
  FrameType,
  ManifestPayload,
  PutMeta,
  decodeChunk,
  encodeChunk,
  encodeTreeEntry,
} from "../shared/protocol";
import { FrameChannel } from "./bridge";
import { TMP_DIR_NAME, buildManifest, hashFileSync, isIgnored, safeJoin, splitManifest } from "./manifest";

// bigger chunks on the TCP data plane: fewer frames, same 256 KiB frame cap
const DATA_CHUNK_SIZE = 192 * 1024;

interface Incoming {
  meta: PutMeta;
  fd: fs.promises.FileHandle;
  tmpPath: string;
  received: number;
  chunks: number;
  ch: FrameChannel; // replies go back on the channel the transfer arrived on
}

export interface ConflictRecord {
  path: string;
  winner: "local" | "remote";
  localMtimeMs: number;
  remoteMtimeMs: number;
  at: number;
}

export interface SyncStats {
  pushed: number;
  pulled: number;
  deleted: number;
  conflicts: number;
  bytesOut: number;
  bytesIn: number;
}

const WINDOW = 32;
const ACK_EVERY = 16;
// data-plane flow control is byte-based (transport queue depth), so its
// chunk window is just a safety cap; throttling happens at HIGH_WATER
const DATA_WINDOW = 256;
const HIGH_WATER = 4 * 1024 * 1024;
// hydrate batches files below this size into TREE_PUT archives of roughly
// this many bytes — per-transfer round trips (~30 ms RTT on the data plane)
// otherwise dominate many-small-file syncs
const SMALL_FILE_LIMIT = 256 * 1024;
const TREE_BATCH_BYTES = 2 * 1024 * 1024;

export class SyncManager extends EventEmitter {
  private lastSync = new Map<string, string>(); // rel → hash at last sync
  private incoming = new Map<number, Incoming>();
  private nextXfer = 0x80000000; // host xfer ids in upper range, guest uses low
  private watcher?: chokidar.FSWatcher;
  private pendingLocal = new Map<string, "put" | "del">();
  private flushTimer?: NodeJS.Timeout;
  private pushChain: Promise<void> = Promise.resolve();
  private guestManifest?: ManifestPayload;
  stats: SyncStats = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, bytesOut: 0, bytesIn: 0 };
  conflicts: ConflictRecord[] = [];

  private dataCh?: FrameChannel;

  constructor(
    private bridge: FrameChannel,
    public readonly hostDir: string,
    private opts: { conflictLog?: string; expectDataChannel?: boolean } = {}
  ) {
    super();
    fs.mkdirSync(hostDir, { recursive: true });
    this.wireChannel(bridge);
  }

  /** route bulk transfers over a faster channel (console stays fallback) */
  attachDataChannel(ch: FrameChannel): void {
    this.dataCh = ch;
    ch.setMaxListeners(64); // concurrent transfers each hold a drain listener
    this.wireChannel(ch);
    this.emit("data-channel", true);
  }

  detachDataChannel(): void {
    this.dataCh = undefined;
    this.emit("data-channel", false);
  }

  get dataChannelActive(): boolean {
    return this.dataCh !== undefined;
  }

  /** the channel new host→guest transfers should use */
  private txChannel(): FrameChannel {
    return this.dataCh ?? this.bridge;
  }

  private wireChannel(ch: FrameChannel): void {
    ch.on(`frame:${FrameType.MANIFEST}`, (f: Frame) => {
      // manifests arrive as one or more parts (see splitManifest) — merge
      try {
        const part: ManifestPayload = JSON.parse(f.payload.toString("utf8"));
        if (!this.guestManifest) this.guestManifest = { files: {} };
        for (const [rel, meta] of Object.entries(part.files ?? {})) {
          if (!isIgnored(rel)) this.guestManifest.files[rel] = meta;
        }
        this.emit("guest-manifest", this.guestManifest);
      } catch {
        /* ignore malformed */
      }
      ch.send(FrameType.ACK, Buffer.from(JSON.stringify({ ack: f.seq })));
    });
    ch.on(`frame:${FrameType.FILE_PUT}`, (f: Frame) => void this.handlePut(ch, f));
    ch.on(`frame:${FrameType.FILE_CHUNK}`, (f: Frame) => void this.handleChunk(ch, f));
    ch.on(`frame:${FrameType.FILE_DEL}`, (f: Frame) => void this.handleDel(ch, f));
    ch.on(`frame:${FrameType.EVENT}`, (f: Frame) => {
      try {
        const body = JSON.parse(f.payload.toString("utf8"));
        for (const ev of body.events ?? []) {
          if (ev.op === "conflict") this.recordConflict(ev.path, ev.winner, ev.localMtimeMs, ev.remoteMtimeMs);
          this.emit("guest-event", ev);
        }
      } catch {
        /* ignore */
      }
    });
  }

  // ---------- lifecycle ----------

  /**
   * Initial hydrate: host is canonical. Pushes files whose content differs,
   * deletes guest-only files, then starts the host watcher.
   */
  async hydrate(): Promise<void> {
    const guest = this.guestManifest ?? { files: {} };
    const host = buildManifest(this.hostDir);
    const toPush: string[] = [];
    for (const [rel, meta] of Object.entries(host.files)) {
      const g = guest.files[rel];
      if (!g || g.hash !== meta.hash) toPush.push(rel);
      else this.lastSync.set(rel, meta.hash);
    }
    const toDelete = Object.keys(guest.files).filter((rel) => !host.files[rel]);

    // announce host manifest so the guest can seed its own lastSync
    // (chunked: a whole-project manifest can exceed the frame payload cap)
    for (const part of splitManifest(host)) {
      this.bridge.send(FrameType.MANIFEST, Buffer.from(JSON.stringify(part)));
    }

    // On the TCP data plane, per-transfer round trips dominate for small
    // files (RTT through the emulated netstack is tens of ms, vs <1 ms on
    // the console) — batch small files into TREE_PUT archives and pipeline
    // the transfers. The protocol multiplexes by xfer id, and the guest
    // keeps per-xfer state, so interleaved transfers are safe. Console
    // stays serial per-file (its paced writer gains nothing from either).
    //
    // The data plane can connect *after* hydrate has already started (its
    // connect races the console login handshake and doesn't always win —
    // see Sandbox.waitDataPlane). So batching/channel choice is decided
    // lazily, per claim, not once up front: a small-file queue is drained
    // into TREE_PUT batches only while dataChannelActive is actually true
    // at claim time, and a late connection is picked up by the next claim.
    const smallQueue: string[] = [];
    const bigQueue: string[] = [];
    for (const rel of toPush) {
      (host.files[rel].size >= SMALL_FILE_LIMIT ? bigQueue : smallQueue).push(rel);
    }
    const claim = (): (() => Promise<void>) | null => {
      if (this.dataChannelActive && smallQueue.length) {
        const batch: string[] = [];
        let bytes = 0;
        while (smallQueue.length && bytes < TREE_BATCH_BYTES) {
          const rel = smallQueue.shift()!;
          batch.push(rel);
          bytes += host.files[rel].size + 256; // entry header overhead
        }
        return () => this.pushTree(batch);
      }
      const rel = smallQueue.shift() ?? bigQueue.shift();
      return rel ? () => this.pushFile(rel) : null;
    };
    // size the worker pool for the fast path whenever a data plane is
    // configured at all, even if not connected yet — otherwise a late
    // connection is stuck behind a pool that was sized for serial console.
    const concurrency = this.dataChannelActive || this.opts.expectDataChannel ? 8 : 1;
    const workers = Math.max(1, Math.min(concurrency, toPush.length));
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (;;) {
          const job = claim();
          if (!job) return;
          await job();
        }
      })
    );
    for (const rel of toDelete) await this.pushDelete(rel);
    this.emit("hydrated", { pushed: toPush.length, deleted: toDelete.length });
    this.startWatcher();
  }

  private startWatcher(): void {
    this.watcher = chokidar.watch(this.hostDir, {
      ignoreInitial: true,
      ignored: (p: string) => {
        const rel = path.relative(this.hostDir, p).split(path.sep).join("/");
        return rel !== "" && isIgnored(rel);
      },
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    });
    this.watcher
      .on("add", (p) => this.enqueueLocal(p, "put"))
      .on("change", (p) => this.enqueueLocal(p, "put"))
      .on("unlink", (p) => this.enqueueLocal(p, "del"))
      .on("unlinkDir", (p) => this.enqueueLocal(p, "del"));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  private enqueueLocal(abs: string, op: "put" | "del"): void {
    const rel = path.relative(this.hostDir, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) return;
    this.pendingLocal.set(rel, op);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flushLocal(), 300);
  }

  private async flushLocal(): Promise<void> {
    const ops = new Map(this.pendingLocal);
    this.pendingLocal.clear();
    for (const [rel, op] of ops) {
      this.pushChain = this.pushChain.then(async () => {
        try {
          if (op === "put") {
            const abs = safeJoin(this.hostDir, rel);
            if (!abs) return;
            // echo suppression: content equals what we last synced
            try {
              if (this.lastSync.get(rel) === hashFileSync(abs)) return;
            } catch {
              return; // vanished
            }
            await this.pushFile(rel);
          } else {
            await this.pushDelete(rel);
          }
        } catch (e: any) {
          this.emit("error", new Error(`push ${op} ${rel}: ${e.message}`));
        }
      });
    }
    await this.pushChain;
  }

  // ---------- host → guest ----------

  async pushFile(rel: string): Promise<void> {
    const abs = safeJoin(this.hostDir, rel);
    if (!abs) throw new Error(`illegal path ${rel}`);
    const st = await fsp.stat(abs);
    if (!st.isFile()) return;
    const hash = hashFileSync(abs);
    const xfer = ++this.nextXfer;
    const ch = this.txChannel(); // transfer stays on one channel end to end
    const chunkSize = ch === this.bridge ? CHUNK_SIZE : DATA_CHUNK_SIZE;
    const meta: PutMeta = {
      xfer,
      path: rel,
      size: st.size,
      mode: st.mode & 0o777,
      mtimeMs: Math.floor(st.mtimeMs),
      hash,
    };

    const done = await new Promise<Frame>((resolve, reject) => {
      let window = 0;
      let sent = 0;
      let readDone = false;
      let fd: number | null = null;
      const timer = setTimeout(() => finish(new Error(`timeout pushing ${rel}`)), 120000);
      const maxWindow = ch.bufferedBytes ? DATA_WINDOW : WINDOW;
      const onDrain = () => pump();
      console.log(`[pushFile] ${rel} (${meta.size}B) xfer=${xfer} ch=${ch === this.bridge ? 'console' : 'dataplane'}`);

      const finish = (err: Error | null, frame?: Frame) => {
        clearTimeout(timer);
        ch.offXfer(xfer);
        ch.off("drain", onDrain);
        if (fd !== null) fs.closeSync(fd);
        err ? reject(err) : resolve(frame!);
      };

      const pump = () => {
        if (fd === null || readDone) return;
        while (window < maxWindow && !readDone) {
          // primary throttle on the data plane: transport queue depth
          if (ch.bufferedBytes && ch.bufferedBytes() > HIGH_WATER) return;
          const buf = Buffer.alloc(chunkSize);
          const n = fs.readSync(fd, buf, 0, chunkSize, sent);
          if (n <= 0) {
            readDone = true;
            break;
          }
          ch.send(FrameType.FILE_CHUNK, encodeChunk(xfer, sent, buf.subarray(0, n)));
          this.stats.bytesOut += n;
          sent += n;
          window++;
          if (sent >= meta.size) {
            readDone = true;
            break;
          }
        }
      };
      ch.on("drain", onDrain);

      ch.onXfer(xfer, (f: Frame) => {
        let body: any = {};
        try {
          body = JSON.parse(f.payload.toString("utf8"));
        } catch {
          /* ignore */
        }
        console.log(`[pushFile] ${rel} xfer=${xfer} cb: type=${FrameType[f.type]} body=${JSON.stringify(body)}`);
        if (f.type === FrameType.NAK) {
          if (body.conflict) {
            // guest's local edit won LWW — it will push its version to us
            finish(null, f);
            return;
          }
          finish(new Error(`guest NAK on ${rel}: ${body.error}`));
          return;
        }
        if (body.done) {
          finish(null, f);
          return;
        }
        if (body.received !== undefined) {
          window = Math.max(0, window - ACK_EVERY);
          pump();
          return;
        }
        // initial ready-ack → start data (console path; the data plane
        // starts optimistically below and ignores this ack)
        if (meta.size > 0 && fd === null) {
          fd = fs.openSync(abs, "r");
          pump();
        }
      });

      ch.send(FrameType.FILE_PUT, Buffer.from(JSON.stringify(meta)));
      console.log(`[pushFile] ${rel} FILE_PUT sent, waiting for ACK`);
      // Data plane: TCP delivery order guarantees the guest sees FILE_PUT
      // before any chunk, so skip the ready-ack round trip (it dominates
      // small-file cost — RTT through the emulated netstack is tens of ms).
      // On a conflict-NAK the first NAK finishes the transfer; stray
      // unknown-xfer NAKs for already-sent chunks are ignored.
      if (ch !== this.bridge && meta.size > 0) {
        fd = fs.openSync(abs, "r");
        pump();
      }
    });

    let doneBody: any = {};
    try {
      doneBody = JSON.parse(done.payload.toString("utf8"));
    } catch {
      /* ignore */
    }
    if (!doneBody.conflict) {
      this.lastSync.set(rel, hash);
      this.stats.pushed++;
      this.emit("pushed", rel);
    }
  }

  /**
   * Push a batch of small files as one TREE_PUT archive (data plane only).
   * Archive entries: [u32le header-len][JSON {path,size,mode,mtimeMs,hash}]
   * [raw bytes]. The body streams as FILE_CHUNK frames under one xfer id;
   * the guest unpacks sequentially and reports LWW-skipped paths in the
   * done-ACK.
   */
  async pushTree(rels: string[]): Promise<void> {
    const ch = this.txChannel();
    const parts: Buffer[] = [];
    const meta: { rel: string; hash: string }[] = [];
    for (const rel of rels) {
      const abs = safeJoin(this.hostDir, rel);
      if (!abs) throw new Error(`illegal path ${rel}`);
      let st: fs.Stats;
      let data: Buffer;
      try {
        st = fs.statSync(abs);
        if (!st.isFile()) continue;
        data = fs.readFileSync(abs);
      } catch {
        continue; // raced deletion
      }
      const hash = crypto.createHash("sha256").update(data).digest("hex");
      parts.push(
        encodeTreeEntry(
          {
            path: rel,
            size: data.length,
            mode: st.mode & 0o777,
            mtimeMs: Math.floor(st.mtimeMs),
            hash,
          },
          data
        )
      );
      meta.push({ rel, hash });
    }
    if (!meta.length) return;
    const archive = Buffer.concat(parts);
    const xfer = ++this.nextXfer;

    await new Promise<void>((resolve, reject) => {
      let sent = 0;
      let window = 0;
      const timer = setTimeout(() => finish(new Error(`timeout pushing tree (${meta.length} files)`)), 120000);
      const onDrain = () => pump();

      const finish = (err: Error | null) => {
        clearTimeout(timer);
        ch.offXfer(xfer);
        ch.off("drain", onDrain);
        err ? reject(err) : resolve();
      };

      const pump = () => {
        while (sent < archive.length && window < DATA_WINDOW) {
          if (ch.bufferedBytes && ch.bufferedBytes() > HIGH_WATER) return;
          const n = Math.min(DATA_CHUNK_SIZE, archive.length - sent);
          ch.send(FrameType.FILE_CHUNK, encodeChunk(xfer, sent, archive.subarray(sent, sent + n)));
          this.stats.bytesOut += n;
          sent += n;
          window++;
        }
      };

      ch.onXfer(xfer, (f: Frame) => {
        let body: any = {};
        try {
          body = JSON.parse(f.payload.toString("utf8"));
        } catch {
          /* ignore */
        }
        if (f.type === FrameType.NAK) {
          return finish(new Error(`guest NAK on tree: ${body.error}`));
        }
        if (body.done) {
          const skipped = new Set<string>(body.skipped ?? []);
          for (const m of meta) {
            if (skipped.has(m.rel)) continue;
            this.lastSync.set(m.rel, m.hash);
            this.stats.pushed++;
            this.emit("pushed", m.rel);
          }
          return finish(null);
        }
        if (body.received !== undefined) {
          window = Math.max(0, window - ACK_EVERY);
          pump();
        }
      });
      ch.on("drain", onDrain);

      ch.send(
        FrameType.TREE_PUT,
        Buffer.from(JSON.stringify({ xfer, size: archive.length, count: meta.length }))
      );
      pump(); // stream immediately — TCP ordering delivers TREE_PUT first
    });
  }

  async pushDelete(rel: string): Promise<void> {
    await this.txChannel().request(FrameType.FILE_DEL, Buffer.from(JSON.stringify({ path: rel })));
    this.lastSync.delete(rel);
    this.stats.deleted++;
    this.emit("deleted", rel);
  }

  // ---------- guest → host ----------

  private ack(ch: FrameChannel, seq: number, extra: Record<string, unknown> = {}): void {
    ch.send(FrameType.ACK, Buffer.from(JSON.stringify({ ack: seq, ...extra })));
  }

  private nak(ch: FrameChannel, seq: number, error: string, extra: Record<string, unknown> = {}): void {
    ch.send(FrameType.NAK, Buffer.from(JSON.stringify({ ack: seq, error, ...extra })));
  }

  private async handlePut(ch: FrameChannel, f: Frame): Promise<void> {
    let meta: PutMeta;
    try {
      meta = JSON.parse(f.payload.toString("utf8"));
    } catch {
      return this.nak(ch, f.seq, "bad FILE_PUT json");
    }
    const abs = safeJoin(this.hostDir, meta.path);
    if (!abs) return this.nak(ch, f.seq, "illegal path", { xfer: meta.xfer });
    if (isIgnored(meta.path)) return this.nak(ch, f.seq, "ignored path", { xfer: meta.xfer });

    // LWW conflict: local edited since last sync?
    const verdict = this.resolveIncoming(meta, abs);
    if (verdict === "local") {
      return this.nak(ch, f.seq, "conflict: local wins", { xfer: meta.xfer, conflict: true });
    }

    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmpDir = path.join(this.hostDir, TMP_DIR_NAME);
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `put-${meta.xfer}-${Date.now()}`);
    const fd = await fsp.open(tmpPath, "w");
    const inc: Incoming = { meta, fd, tmpPath, received: 0, chunks: 0, ch };
    this.incoming.set(meta.xfer, inc);
    if (meta.size === 0) return void this.finishIncoming(f.seq, inc);
    this.ack(ch, f.seq, { xfer: meta.xfer });
  }

  private async handleChunk(ch: FrameChannel, f: Frame): Promise<void> {
    const { xfer, offset, data } = decodeChunk(f.payload);
    const inc = this.incoming.get(xfer);
    if (!inc) return this.nak(ch, f.seq, "unknown xfer", { xfer });
    try {
      await inc.fd.write(data, 0, data.length, offset);
    } catch (e: any) {
      return this.abortIncoming(f.seq, inc, e.message);
    }
    inc.received += data.length;
    inc.chunks++;
    this.stats.bytesIn += data.length;
    if (inc.received >= inc.meta.size) {
      await this.finishIncoming(f.seq, inc);
    } else if (inc.chunks % ACK_EVERY === 0) {
      this.ack(inc.ch, f.seq, { xfer, received: inc.received });
    }
  }

  private async finishIncoming(seq: number, inc: Incoming): Promise<void> {
    await inc.fd.close();
    const gotHash = hashFileSync(inc.tmpPath);
    if (gotHash !== inc.meta.hash) {
      return this.abortIncoming(seq, inc, `hash mismatch: got ${gotHash}`);
    }
    const abs = safeJoin(this.hostDir, inc.meta.path)!;
    await fsp.chmod(inc.tmpPath, inc.meta.mode).catch(() => {});
    const mt = new Date(inc.meta.mtimeMs);
    await fsp.utimes(inc.tmpPath, mt, mt).catch(() => {});
    await fsp.rename(inc.tmpPath, abs);
    this.lastSync.set(inc.meta.path, inc.meta.hash);
    this.incoming.delete(inc.meta.xfer);
    this.stats.pulled++;
    this.emit("pulled", inc.meta.path);
    this.ack(inc.ch, seq, { xfer: inc.meta.xfer, done: true });
  }

  private async abortIncoming(seq: number, inc: Incoming, msg: string): Promise<void> {
    await inc.fd.close().catch(() => {});
    await fsp.unlink(inc.tmpPath).catch(() => {});
    this.incoming.delete(inc.meta.xfer);
    this.nak(inc.ch, seq, msg, { xfer: inc.meta.xfer });
  }

  private async handleDel(ch: FrameChannel, f: Frame): Promise<void> {
    let body: { path: string };
    try {
      body = JSON.parse(f.payload.toString("utf8"));
    } catch {
      return this.nak(ch, f.seq, "bad FILE_DEL json");
    }
    const abs = safeJoin(this.hostDir, body.path);
    if (!abs) return this.nak(ch, f.seq, "illegal path");
    if (isIgnored(body.path)) return this.ack(ch, f.seq); // never synced, nothing to do
    await fsp.rm(abs, { recursive: true, force: true });
    this.lastSync.delete(body.path);
    this.stats.deleted++;
    this.emit("deleted", body.path);
    this.ack(ch, f.seq);
  }

  // ---------- conflicts ----------

  private resolveIncoming(meta: PutMeta, abs: string): "local" | "remote" {
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return "remote";
    }
    let localHash: string;
    try {
      localHash = hashFileSync(abs);
    } catch {
      return "remote";
    }
    if (localHash === meta.hash) return "remote";
    if (localHash === this.lastSync.get(meta.path)) return "remote"; // clean update
    const localM = Math.floor(st.mtimeMs);
    const winner =
      localM > meta.mtimeMs || (localM === meta.mtimeMs && localHash > meta.hash)
        ? "local"
        : "remote";
    this.recordConflict(meta.path, winner, localM, meta.mtimeMs);
    return winner;
  }

  private recordConflict(rel: string, winner: "local" | "remote", localM: number, remoteM: number): void {
    const rec: ConflictRecord = {
      path: rel,
      winner,
      localMtimeMs: localM,
      remoteMtimeMs: remoteM,
      at: Date.now(),
    };
    this.conflicts.push(rec);
    this.stats.conflicts++;
    this.emit("conflict", rec);
    if (this.opts.conflictLog) {
      fs.appendFileSync(this.opts.conflictLog, JSON.stringify(rec) + "\n");
    }
  }
}
