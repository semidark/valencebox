// SnapshotManager: periodic zstd-compressed save_state() for warm boots.
// Full-VM snapshots (RAM + device state + async-disk dirty blocks); saved on
// idle/interval, never per-edit. Durability of files does NOT depend on
// this — the host directory is canonical via SyncManager.
import { EventEmitter } from "events";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { compress, decompress } from "@mongodb-js/zstd";
import { SandboxVM } from "./vm";

export interface SnapshotOptions {
  /** check cadence; a save happens at most this often (default 5 min) */
  intervalMs?: number;
  /** only save if no sync activity for this long (default 10s) */
  idleMs?: number;
  /** zstd level (default 3: fast, ~2-3x) */
  level?: number;
}

export class SnapshotManager extends EventEmitter {
  private lastActivity = Date.now();
  private timer?: NodeJS.Timeout;
  private saving = false;

  constructor(
    private vm: SandboxVM,
    public readonly file: string,
    private opts: SnapshotOptions = {}
  ) {
    super();
  }

  /** call from sync events so we don't snapshot mid-burst */
  markActivity(): void {
    this.lastActivity = Date.now();
  }

  start(): void {
    const interval = this.opts.intervalMs ?? 5 * 60 * 1000;
    const idle = this.opts.idleMs ?? 10 * 1000;
    let lastSave = 0;
    this.timer = setInterval(async () => {
      const now = Date.now();
      if (now - lastSave < interval) return;
      if (now - this.lastActivity < idle) return;
      try {
        await this.save();
        lastSave = Date.now();
      } catch (e: any) {
        this.emit("error", new Error(`snapshot failed: ${e.message}`));
      }
    }, Math.min(interval, 30_000));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async save(): Promise<{ rawBytes: number; compressedBytes: number; ms: number }> {
    if (this.saving) throw new Error("snapshot already in progress");
    this.saving = true;
    const t0 = Date.now();
    try {
      const state: ArrayBuffer = await this.vm.saveState();
      const z = await compress(Buffer.from(state), this.opts.level ?? 3);
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      await fsp.writeFile(tmp, z);
      await fsp.rename(tmp, this.file);
      const res = { rawBytes: state.byteLength, compressedBytes: z.length, ms: Date.now() - t0 };
      this.emit("saved", res);
      return res;
    } finally {
      this.saving = false;
    }
  }

  static exists(file: string): boolean {
    try {
      fs.accessSync(file);
      return true;
    } catch {
      return false;
    }
  }

  /** decompress a snapshot for VMOptions.initialState */
  static async load(file: string): Promise<ArrayBuffer> {
    const z = await fsp.readFile(file);
    const raw = await decompress(z);
    const out = new ArrayBuffer(raw.byteLength);
    new Uint8Array(out).set(raw);
    return out;
  }
}
