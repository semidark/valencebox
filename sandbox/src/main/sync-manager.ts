// SyncManager: host side of the bidirectional /workspace sync.
// Canonical store = host directory. See PROTOCOL.md for wire semantics.
import { EventEmitter } from "events";
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
} from "../shared/protocol";
import { HostBridge } from "./bridge";
import { TMP_DIR_NAME, buildManifest, hashFileSync, isIgnored, safeJoin, splitManifest } from "./manifest";

interface Incoming {
  meta: PutMeta;
  fd: fs.promises.FileHandle;
  tmpPath: string;
  received: number;
  chunks: number;
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

  constructor(
    private bridge: HostBridge,
    public readonly hostDir: string,
    private opts: { conflictLog?: string } = {}
  ) {
    super();
    fs.mkdirSync(hostDir, { recursive: true });
    bridge.on(`frame:${FrameType.MANIFEST}`, (f: Frame) => {
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
      this.bridge.send(FrameType.ACK, Buffer.from(JSON.stringify({ ack: f.seq })));
    });
    bridge.on(`frame:${FrameType.FILE_PUT}`, (f: Frame) => void this.handlePut(f));
    bridge.on(`frame:${FrameType.FILE_CHUNK}`, (f: Frame) => void this.handleChunk(f));
    bridge.on(`frame:${FrameType.FILE_DEL}`, (f: Frame) => void this.handleDel(f));
    bridge.on(`frame:${FrameType.EVENT}`, (f: Frame) => {
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

    for (const rel of toPush) await this.pushFile(rel);
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

      const finish = (err: Error | null, frame?: Frame) => {
        clearTimeout(timer);
        this.bridge.offXfer(xfer);
        if (fd !== null) fs.closeSync(fd);
        err ? reject(err) : resolve(frame!);
      };

      const pump = () => {
        if (fd === null || readDone) return;
        while (window < WINDOW && !readDone) {
          const buf = Buffer.alloc(CHUNK_SIZE);
          const n = fs.readSync(fd, buf, 0, CHUNK_SIZE, sent);
          if (n <= 0) {
            readDone = true;
            break;
          }
          this.bridge.send(FrameType.FILE_CHUNK, encodeChunk(xfer, sent, buf.subarray(0, n)));
          this.stats.bytesOut += n;
          sent += n;
          window++;
          if (sent >= meta.size) {
            readDone = true;
            break;
          }
        }
      };

      this.bridge.onXfer(xfer, (f: Frame) => {
        let body: any = {};
        try {
          body = JSON.parse(f.payload.toString("utf8"));
        } catch {
          /* ignore */
        }
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
        // initial ready-ack → start data
        if (meta.size > 0 && fd === null) {
          fd = fs.openSync(abs, "r");
          pump();
        }
      });

      this.bridge.send(FrameType.FILE_PUT, Buffer.from(JSON.stringify(meta)));
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

  async pushDelete(rel: string): Promise<void> {
    await this.bridge.request(FrameType.FILE_DEL, Buffer.from(JSON.stringify({ path: rel })));
    this.lastSync.delete(rel);
    this.stats.deleted++;
    this.emit("deleted", rel);
  }

  // ---------- guest → host ----------

  private ack(seq: number, extra: Record<string, unknown> = {}): void {
    this.bridge.send(FrameType.ACK, Buffer.from(JSON.stringify({ ack: seq, ...extra })));
  }

  private nak(seq: number, error: string, extra: Record<string, unknown> = {}): void {
    this.bridge.send(FrameType.NAK, Buffer.from(JSON.stringify({ ack: seq, error, ...extra })));
  }

  private async handlePut(f: Frame): Promise<void> {
    let meta: PutMeta;
    try {
      meta = JSON.parse(f.payload.toString("utf8"));
    } catch {
      return this.nak(f.seq, "bad FILE_PUT json");
    }
    const abs = safeJoin(this.hostDir, meta.path);
    if (!abs) return this.nak(f.seq, "illegal path", { xfer: meta.xfer });
    if (isIgnored(meta.path)) return this.nak(f.seq, "ignored path", { xfer: meta.xfer });

    // LWW conflict: local edited since last sync?
    const verdict = this.resolveIncoming(meta, abs);
    if (verdict === "local") {
      return this.nak(f.seq, "conflict: local wins", { xfer: meta.xfer, conflict: true });
    }

    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmpDir = path.join(this.hostDir, TMP_DIR_NAME);
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `put-${meta.xfer}-${Date.now()}`);
    const fd = await fsp.open(tmpPath, "w");
    const inc: Incoming = { meta, fd, tmpPath, received: 0, chunks: 0 };
    this.incoming.set(meta.xfer, inc);
    if (meta.size === 0) return void this.finishIncoming(f.seq, inc);
    this.ack(f.seq, { xfer: meta.xfer });
  }

  private async handleChunk(f: Frame): Promise<void> {
    const { xfer, offset, data } = decodeChunk(f.payload);
    const inc = this.incoming.get(xfer);
    if (!inc) return this.nak(f.seq, "unknown xfer", { xfer });
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
      this.ack(f.seq, { xfer, received: inc.received });
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
    this.ack(seq, { xfer: inc.meta.xfer, done: true });
  }

  private async abortIncoming(seq: number, inc: Incoming, msg: string): Promise<void> {
    await inc.fd.close().catch(() => {});
    await fsp.unlink(inc.tmpPath).catch(() => {});
    this.incoming.delete(inc.meta.xfer);
    this.nak(seq, msg, { xfer: inc.meta.xfer });
  }

  private async handleDel(f: Frame): Promise<void> {
    let body: { path: string };
    try {
      body = JSON.parse(f.payload.toString("utf8"));
    } catch {
      return this.nak(f.seq, "bad FILE_DEL json");
    }
    const abs = safeJoin(this.hostDir, body.path);
    if (!abs) return this.nak(f.seq, "illegal path");
    if (isIgnored(body.path)) return this.ack(f.seq); // never synced, nothing to do
    await fsp.rm(abs, { recursive: true, force: true });
    this.lastSync.delete(body.path);
    this.stats.deleted++;
    this.emit("deleted", body.path);
    this.ack(f.seq);
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
