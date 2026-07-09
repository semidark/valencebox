// Headless v86 VM in the Electron main process (plain Node — no DOM).
import * as fs from "fs";
import * as path from "path";

// libv86 is plain CommonJS with a UMD-ish export
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { V86 } = require(path.join(assetsDir(), "libv86.js"));

export function assetsDir(): string {
  return path.resolve(__dirname, "..", "..", "assets", "v86");
}

export function imagesDir(): string {
  return path.resolve(__dirname, "..", "..", "images");
}

// Caps on v86's async-disk block_cache (see semidark/v86#1). Without a
// bound, every byte ever read or written to hda/hdb accumulates in host
// RAM for the life of the process — most visibly during workspace
// hydration, which can write the guest's entire synced project tree into
// hdb in one pass. hda is boot-time-reads-mostly (root fs effectively
// read-only at runtime — sync-agent writes hdb, not hda) so a small cache
// suffices; hdb absorbs ongoing guest writes so gets more headroom while
// still bounding worst-case growth. The cache self-evicts past this bound,
// so lowering it is a pure host-RAM win, never a correctness issue
// (data is never lost — see flushDisks doc below).
const HDA_MAX_CACHE_BYTES = 16 * 1024 * 1024;
const HDB_MAX_CACHE_BYTES = 32 * 1024 * 1024;

export interface VMOptions {
  memoryMB?: number;
  workspaceImage?: string;
  /** wisp://host:port relay; omit for no network device at all */
  relayUrl?: string;
  /** DoH server name for guest DNS (see doh.ts fetch gate) */
  dohServer?: string;
  /** zstd-decompressed save state to resume from */
  initialState?: ArrayBuffer;
  onSerial?: (text: string) => void;
}

export class SandboxVM {
  emulator: any;
  private serialBuf = "";
  // coalesce serial output for the UI callback: v86 emits one byte per event,
  // so firing onSerial per byte would be one IPC message per character on
  // heavy output. Batch bytes and flush once per event-loop turn. (serialBuf
  // is still updated synchronously below — tests read it immediately.)
  private serialOutPending = "";
  private serialFlushScheduled = false;

  constructor(private opts: VMOptions = {}) {}

  async start(): Promise<void> {
    const assets = assetsDir();
    const images = imagesDir();
    const cfg: any = {
      wasm_path: path.join(assets, "v86.wasm"),
      bios: { url: path.join(assets, "seabios.bin") },
      vga_bios: { url: path.join(assets, "vgabios.bin") },
      memory_size: (this.opts.memoryMB ?? 512) * 1024 * 1024,
      vga_memory_size: 2 * 1024 * 1024,
      bzimage: { url: path.join(images, "vmlinuz.bin") },
      initrd: { url: path.join(images, "initramfs.bin") },
      cmdline:
        // modprobe.blacklist=sr_mod skips the v86 default ATAPI CD-ROM's
        // sr_mod probe, which alone takes ~13 s of emulated CPU on every
        // boot (sr_mod init issues slow SCSI INQUIRY over the IDE bus for
        // an empty CD-ROM). We don't use the CD-ROM. NB: do NOT add
        // `quiet`/`loglevel=3` here — the Electron renderer pipes serial
        // straight into the xterm terminal (main.ts onSerial →
        // IPC.onSerial), and the kernel printk trace is the only visible
        // "boot is happening" feedback during the ~25 s of silent kernel
        // init before OpenRC starts. Silencing it makes the UI look dead.
        "rw root=/dev/sda rootfstype=ext4 console=ttyS0 " +
        "modules=ata_piix,sd-mod,ext4 tsc=reliable mitigations=off " +
        "random.trust_cpu=on modprobe.blacklist=sr_mod",
      // async + fixed_chunk_size → dirty-block tracking keeps save_state small.
      // max_cache_bytes bounds the disk block_cache itself (separate from
      // save_state's dirty-block set) so host RAM doesn't grow unboundedly
      // with cumulative guest disk I/O — see semidark/v86#1.
      hda: {
        url: path.join(images, "alpine-root.img"),
        async: true,
        fixed_chunk_size: 256 * 1024,
        max_cache_bytes: HDA_MAX_CACHE_BYTES,
      },
      hdb: {
        url: this.opts.workspaceImage ?? path.join(images, "workspace.img"),
        async: true,
        fixed_chunk_size: 256 * 1024,
        max_cache_bytes: HDB_MAX_CACHE_BYTES,
      },
      virtio_console: true,
      autostart: true,
      disable_keyboard: true,
      disable_mouse: true,
      disable_speaker: true,
    };
    if (this.opts.relayUrl) {
      cfg.net_device = { type: "virtio", relay_url: this.opts.relayUrl };
      if (this.opts.dohServer) cfg.net_device.doh_server = this.opts.dohServer;
    }
    if (this.opts.initialState) {
      cfg.initial_state = { buffer: this.opts.initialState };
    }

    this.emulator = new V86(cfg);

    this.emulator.add_listener("serial0-output-byte", (byte: number) => {
      const ch = String.fromCharCode(byte);
      this.serialBuf += ch;
      if (this.serialBuf.length > 65536) this.serialBuf = this.serialBuf.slice(-32768);
      if (this.opts.onSerial) {
        this.serialOutPending += ch;
        if (!this.serialFlushScheduled) {
          this.serialFlushScheduled = true;
          setImmediate(() => {
            this.serialFlushScheduled = false;
            const chunk = this.serialOutPending;
            this.serialOutPending = "";
            if (chunk) this.opts.onSerial!(chunk);
          });
        }
      }
    });

    await new Promise<void>((resolve) => {
      this.emulator.add_listener("emulator-loaded", () => resolve());
    });
  }

  /** Everything the guest has printed on ttyS0 (bounded). */
  get serialLog(): string {
    return this.serialBuf;
  }

  serialWrite(text: string): void {
    this.emulator.serial0_send(text);
  }

  /** Wait until the serial log matches re (from `from` offset). */
  async waitSerial(re: RegExp, timeoutMs = 120000, from = 0): Promise<string> {
    const start = Date.now();
    for (;;) {
      const win = this.serialBuf.slice(from);
      const m = win.match(re);
      if (m) return m[0];
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout waiting for ${re}; tail: ${JSON.stringify(win.slice(-400))}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  onVirtioConsole(cb: (data: Uint8Array) => void): void {
    this.emulator.add_listener("virtio-console0-output-bytes", cb);
  }

  // ---- paced host→guest writer ----
  // The v86 virtio-console device consumes exactly one guest RX descriptor
  // (4 KiB for hvc) per bus message and silently DROPS bytes when the queue
  // is empty. So: slice to <4 KiB and only send when a descriptor is free,
  // yielding to the emulator loop between bursts so the guest can refill.
  private static readonly WIRE_SLICE = 3072;
  private txQueue: Buffer[] = [];
  private txHead = 0;
  private pumpScheduled = false;

  private rxQueue0(): any | null {
    try {
      const dev = this.emulator.v86.cpu.devices.virtio_console;
      return dev?.virtio?.queues?.[0] ?? null;
    } catch {
      return null;
    }
  }

  virtioConsoleWrite(data: Uint8Array): void {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    for (let off = 0; off < buf.length; off += SandboxVM.WIRE_SLICE) {
      this.txQueue.push(buf.subarray(off, Math.min(off + SandboxVM.WIRE_SLICE, buf.length)));
    }
    this.schedulePump();
  }

  private stalls = 0;

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    const fire = () => {
      this.pumpScheduled = false;
      this.pump();
    };
    // after repeated stalls back off to timers so we don't spin the loop
    if (this.stalls > 50) setTimeout(fire, 2);
    else setImmediate(fire);
  }

  private pump(): void {
    const q = this.rxQueue0();
    let budget = 16; // max slices per event-loop turn
    const before = this.txHead;
    while (this.txHead < this.txQueue.length && budget > 0) {
      if (q) {
        let free = 0;
        try {
          free = q.count_requests ? q.count_requests() : q.has_request() ? 1 : 0;
        } catch {
          free = 0;
        }
        if (free < 1) break; // guest hasn't refilled RX buffers yet
      }
      this.emulator.bus.send("virtio-console0-input-bytes", this.txQueue[this.txHead++]);
      budget--;
    }
    this.stalls = this.txHead === before ? this.stalls + 1 : 0;
    if (this.txHead >= this.txQueue.length) {
      this.txQueue = [];
      this.txHead = 0;
    } else {
      this.schedulePump();
    }
  }

  async saveState(): Promise<ArrayBuffer> {
    return await this.emulator.save_state();
  }

  /**
   * Proactively write back dirty hda/hdb disk-cache blocks and drop them
   * from host memory (see semidark/v86#1's AsyncXHRBuffer.flush()). The
   * cache also self-evicts once it crosses max_cache_bytes, so this is a
   * best-effort optimization — call it at known-idle points (e.g. right
   * after hydration finishes) to reclaim memory sooner rather than waiting
   * for the next write to trigger eviction. Never throws: disk-cache
   * flushing is a memory optimization, not correctness-critical (data is
   * never lost either way — see AsyncXHRBuffer.flush in the v86 fork).
   */
  async flushDisks(): Promise<void> {
    try {
      await this.emulator?.flush_disks?.();
    } catch {
      /* best-effort */
    }
  }

  stop(): void {
    try {
      this.emulator?.destroy();
    } catch {
      /* v86 destroy is best-effort */
    }
  }
}

export function fileExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
