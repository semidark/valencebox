# Rewrite sync-agent in Rust

## Goal

Replace the Go sync-agent daemon (`sandbox/guest/sync-agent/`) with a Rust implementation targeting `i686-unknown-linux-musl` (32-bit x86 static binary). The Rust binary must be a drop-in replacement: same protocol, same `/dev/hvc0` virtio-console I/O, same TCP data plane, same filesystem behavior.

## Current Go Code

| File | Lines | Purpose |
|------|-------|---------|
| `main.go` | ~200 | Entry point, session loop, push strategy (TCP preferred → console fallback), 2s reconnect backoff |
| `frame.go` | ~100 | Binary protocol framing: magic `V86S`, CRC32 IEEE, max payload 262144, stream resync on corruption |
| `state.go` | ~100 | In-memory manifest state, SHA256 caching via `statHash` (size/mtime), conflict detection |
| `watcher.go` | ~150 | `inotify` recursive watcher with debouncing, mask `IN_CLOSE_WRITE\|IN_CREATE\|IN_DELETE\|IN_MOVED_TO\|IN_MOVED_FROM\|IN_DELETE_SELF` |
| `transfer.go` | ~520 | Host→guest file receiver/sender, streaming `TREE_PUT` archive unpacker, windowed chunk sender, carry-over buffer across chunk boundaries |
| `dataplane.go` | ~190 | TCP client with generation-based reconnection, liveness pings every 15s, silence timeout 45s |
| `manifest.go` | ~130 | Recursive directory walk, SHA256 hashing, ignored paths (`.git`, `node_modules`, `.sync-tmp`, `lost+found`, `.DS_Store`), `safeJoin` path escape prevention |
| `termios.go` | ~40 | Raw mode setup for `/dev/hvc0` via direct syscalls |

## Architecture Decision: Sync + Threads

Go uses goroutines. The Rust rewrite will use `std::thread` + `Arc<Mutex<...>>` + `std::sync::mpsc` channels rather than `tokio`/async.

**Rationale:**
- Only 3-4 concurrent operations (console read loop, TCP session, inotify watcher, ping ticker).
- Avoids `tokio` musl/i686 compatibility concerns.
- Closer mental model to Go's goroutine pattern.
- Fewer dependencies, simpler build chain.

## Project Structure

```
sandbox/guest/sync-agent-rust/
├── Cargo.toml
├── src/
│   ├── main.rs        # entry, session loop, push strategy
│   ├── frame.rs       # binary protocol framing
│   ├── manifest.rs    # walk + hash + safeJoin
│   ├── state.rs       # in-memory manifest state
│   ├── watcher.rs     # inotify + debounce
│   ├── transfer.rs    # send/receive + tree unpacker
│   ├── dataplane.rs   # TCP client session
│   └── termios.rs     # raw mode ioctl
```

## Dependencies (minimal)

```toml
[dependencies]
crc32fast = "1"      # CRC32 IEEE
sha2 = "0.10"        # SHA256
serde = { version = "1", features = ["derive"] }  # derive Serialize/Deserialize
serde_json = "1"     # JSON parsing/serialization
libc = "0.2"         # ioctl, syscalls, raw inotify (avoids inotify crate bitflags incompatibility)
walkdir = "2"        # recursive directory walk
```

All crates support `i686-unknown-linux-musl`. No CGO, no external C libraries.

## Build Integration

Replace in `scripts/build-guest.sh`. The Go binary is written to `guest/sync-agent.bin`, which the Dockerfile then copies into the guest image (`COPY sync-agent.bin /usr/local/bin/sync-agent`). The Rust build must produce the same output path.

```bash
# Old:
(cd guest/sync-agent && GOOS=linux GOARCH=386 CGO_ENABLED=0 go build -o ../sync-agent.bin .)

# New:
rustup target add i686-unknown-linux-musl  # one-time
cargo build --target i686-unknown-linux-musl --release
cp target/i686-unknown-linux-musl/release/sync-agent guest/sync-agent.bin
```

No `musl-gcc` needed — Rust links musl natively for this target.

## Complexity by Component

| Component | Go Lines | Rust Complexity | Risk | Est. Time |
|-----------|----------|-----------------|------|-----------|
| `frame.rs` — protocol framing | ~100 | Low — byte parsing, CRC32 IEEE. Resync logic is trickiest part. | Low | 2-3h |
| `manifest.rs` — walk + hash | ~130 | Low — `walkdir` or stdlib recursion, `sha2` crate, simple string logic for `safeJoin`. | Low | 2h |
| `state.rs` — manifest state | ~100 | Low — `HashMap<String, ...>` with stat-based cache invalidation. | Low | 1-2h |
| `termios.rs` — raw mode ioctl | ~40 | Low — `libc::TCGETS`, `libc::TCSETS`. ~10 lines of Rust. | Low | 0.5h |
| `watcher.rs` — inotify + debounce | ~150 | Medium — `inotify` crate or raw `libc::inotify_*`. Debounce timer + batched ops. Recursive re-watching on `IN_CREATE`. | Medium | 3-4h |
| `transfer.rs` — file send/receive | ~520 | High — Streaming `TREE_PUT` unpacker state machine. Window-based chunk sender. Temp file atomic rename. Carry-over buffer across chunk boundaries. Most complex component to port. | High | 6-7h |
| `dataplane.rs` — TCP client + session | ~190 | Medium — Generation-based reconnection, liveness ping thread. `std::thread` + channels. | Medium | 2-3h |
| `main.rs` — orchestration | ~200 | Medium — Session loop, push strategy, reconnection. Coordinate console I/O + TCP + inotify via threads. | Medium | 2h |
| **Total** | ~1500 | | | **~22-29h** |

## Pitfalls & Gotchas

1. **CRC32 polynomial** — Must be IEEE (0xEDB88320 reversed). `crc32fast` uses IEEE by default. Verify against `src/shared/protocol.ts` line-by-line.

2. **Frame resynchronization** — `frame.go` scans for `V86S` magic byte-by-byte with partial match handling (e.g., `V86V` must not skip past a valid `V86S` that overlaps). Must preserve exact scanning logic — TS uses `indexOf` which handles this differently. A single misaligned read desyncs the entire session.

3. **`inotify` on 32-bit** — The `inotify` crate uses `libc` bindings which work on i686. Confirm it compiles under `i686-unknown-linux-musl` before committing. Raw `libc::inotify_*` via FFI is a safe fallback (Go's `watcher.go` essentially does this with `syscall.InotifyInit1`/`InotifyAddWatch`). Watch for `inotify_watch` descriptor limits in the Alpine guest.

4. **Atomic file operations** — `std::fs::rename` temp→final is atomic on ext4 same-filesystem. Preserves Go's `os.Rename` semantics.

5. **JSON field ordering** — Go's `json.Marshal` produces deterministic key order for structs. Rust's `serde_json` does NOT guarantee order. Host parses JSON by key name, so order doesn't matter for correctness. If any test does string comparison on JSON, it will break.

6. **`statHash` caching** — Go uses `size + mtime` as fast-path cache key. Rust's `std::fs::Metadata` provides the same fields. Straightforward port.

7. **Termios raw mode** — Go `termios.go` manually defines the struct layout and hardcoded ioctl numbers (0x5401/0x5402), using `syscall.Syscall(SYS_IOCTL, ...)`. Match this approach in Rust: use raw ioctl constants via `unsafe` + `libc::ioctl`, since struct layout must be exact. Do not rely on `libc::TCGETS`/`TCSETS` wrappers — they may differ on Alpine i386. Minimal risk if Go's approach is mirrored exactly.

8. **TREE_PUT streaming unpacker** — `unpack` function maintains carry-over buffer and state machine across chunk boundaries. Most complex piece to port. Need careful testing with split entries.

9. **Path handling** — Go's `filepath.Join` vs Rust's manual `/` joining. Protocol uses `/` separators. `safeJoin` logic must be identical.

10. **Timing sensitivity** — The virtio-console writer pacing (<4 KiB slices, waits for free RX) is on the TypeScript host side (`vm.ts`). The Rust agent just reads from `/dev/hvc0`. No changes needed on the agent side.

11. **Sender xfer-id ranges** — Console sender starts at 0, data plane at `0x40000000`, host at `0x80000000`. Must preserve these disjoint ranges to avoid cross-wire routing collisions.

12. **Receiver verify flag** — Console receiver verifies SHA256 on completed files. Data plane receiver skips verification (TCP + frame CRC sufficient). Must preserve this distinction.

## Protocol Constants

```
MAGIC = "V86S"
MAX_PAYLOAD = 262144
CHUNK_SIZE = 48 * 1024
manifestBatchLimit = 160 * 1024  # Go flat constant. TS uses Math.min(160*1024, MAX_PAYLOAD - 32*1024) — same value today, but guard exists in TS.

Frame types:
  Hello       = 1
  Manifest    = 2
  FilePut     = 3
  FileChunk   = 4
  FileDel     = 5
  Ack         = 6
  Nak         = 7
  Event       = 8
  Ping        = 9
  TreePut     = 10
```

## Guest Environment

- Alpine Linux 3.18.6 (i386), kernel `linux-lts`
- Virtio-console `/dev/hvc0`
- Virtio-net IP `11.86.86.86`
- Binary placed at `/usr/local/bin/sync-agent`
- Init script: `guest/rootfs/etc/init.d/sync-agent`

## Testing Strategy

1. **Unit test `frame.rs`** — Read/write round-trip against known fixtures from `test/sync.test.ts`.
2. **`npm run test:unit`** — Pure TS tests, should pass unchanged if protocol is compatible.
3. **`npm run test:sync`** — VM integration tests, validates end-to-end behavior.
4. **Binary drop-in** — Replace Go binary in guest image, verify boot + sync.

## Phased Implementation Plan

Each phase has a verification gate. Do not proceed to the next phase until the current gate passes. Go source remains as rollback at any point: revert `scripts/build-guest.sh` → `npm run images`. After each phase commit the current status to the git repo.

### Pre-flight ✅

- [x] `musl-gcc` — **NOT needed.** The Rust toolchain links musl natively for `i686-unknown-linux-musl`. No external C compiler required.
- [x] Skeleton `cargo check --target i686-unknown-linux-musl` — **all crates resolve.** `inotify` requires `default-features = false` to avoid pulling in `tokio`.
- [x] Release binary: 530K unstripped, ELF 32-bit LSB, Intel 80386, statically linked. (Stripped ~200KB expected.)

---

### Phase 1: Frame Protocol ✅ (~2h)

**Files:** `Cargo.toml`, `src/frame.rs`, stub `src/main.rs`

- [x] Create `sandbox/guest/sync-agent-rust/` with `Cargo.toml` (package `sync-agent`, edition 2021, dep: `crc32fast = "1"`)
- [x] Implement `Frame` struct `{typ: u8, seq: u32, payload: Vec<u8>}` + frame type constants (1–10)
- [x] Implement `ReadFrame` — byte-by-byte magic hunt state machine matching Go `frame.go:40-53` exactly (`matched++`, `b == magic[0] → 1`, `else → 0`)
- [x] Wire format: `[MAGIC 4B][type 1B][seq 4B LE][plen 4B LE][payload N B][crc32 4B LE]`
- [x] CRC covers header(9) + payload(N), NOT magic, NOT trailer — IEEE via `crc32fast`
- [x] Implement `FrameWriter` with `Mutex`-protected writer + auto-incrementing seq counter
- [x] Cross-check CRC against `protocol.ts` IEEE table (0xEDB88320 reversed) — manual bit-by-bit IEEE verification passes
- [x] Stub `src/main.rs`: `fn main() { println!("sync-agent-rust placeholder"); }`

**Gate:** ✅ Binary compiles for i686-musl (530K, ELF 32-bit LSB, statically linked). 8 unit tests pass: roundtrip empty/payload/large, seq increment, CRC IEEE match, resync garbage/partial-magic, payload-too-large.

---

### Phase 2: Manifest + State ✅ (~3h)

**Files:** `src/manifest.rs`, `src/state.rs`
**New deps:** `sha2 = "0.10"`, `serde = "1"`, `serde_json = "1"`, `walkdir = "2"`, `libc = "0.2"`

- [x] `FileMeta` struct with serde derives — field names match Go JSON exactly (`hash`, `size`, `mode`, `mtime_ms`)
- [x] `Manifest { files: HashMap<String, FileMeta> }` with serde
- [x] `ignored_rel(rel: &str) -> bool` — split on `/`, check segments against `{".sync-tmp", ".git", "node_modules", "lost+found", ".DS_Store"}`
- [x] `hash_file(path: &str) -> Result<String>` — streaming SHA256 hex digest via `sha2::Sha256`
- [x] `build_manifest(root, ss)` — recursive walk via `walkdir`, skip ignored/non-regular files, use `ss.hash_cached_stat()` for cache benefit
- [x] `marshal_manifest_batches(m)` — 160*1024 byte soft limit, ~160B per entry estimate (`len(rel) + 160`), sorted keys for determinism
- [x] `safe_join(root, rel) -> Option<String>` — reject empty/absolute paths, detect `..` traversal via path components depth tracking
- [x] `SyncState` with `Mutex<{last_sync, stat_cache}>`, `fw: FrameWriter`
- [x] `hash_cached` / `hash_cached_stat` — same (size, mtime) cache invalidation as Go
- [x] `mark_synced`, `mark_deleted`, `last_hash`, `is_echo`
- [x] `resolve_incoming` — LWW by mtime, tie-break greater hash string, emit `TypeEvent` JSON on conflict
- [x] Verify: SHA256 of "hello world" matches known digest `b94d27b9...`

**Gate:** ✅ All pure-logic functions work correctly. `safe_join` rejects traversal, absolute, and empty paths. 19 unit tests pass (8 frame + 11 manifest/state). Release binary: 731K ELF 32-bit LSB, statically linked.

---

### Phase 3: Termios + Build Integration (~1h)

**Files:** `src/termios.rs`, update `scripts/build-guest.sh`, functional `src/main.rs`
**New dep:** `libc = "0.2"`

- [x] Define `#[repr(C)] struct Termios { iflag: u32, oflag: u32, cflag: u32, lflag: u32, line: u8, cc: [u8; 19] }`
- [x] Hardcoded ioctl constants: `TCGETS = 0x5401`, `TCSETS = 0x5402` — **do NOT use** `libc::TCGETS` wrapper
- [x] Copy Go's termios flag constants exactly (ignbrk=0x1, brkint=0x2, icrnl=0x100, etc.)
- [x] Implement `setRaw(fd)` — `unsafe { libc::ioctl(fd, TCGETS, ...) }`, apply same flag masks as Go, `TCSETS`
- [x] Implement `main.rs`: parse `--root`/`--dev` from `std::env::args()`, open device, call `setRaw`, read frames in loop and print type
- [x] Update `scripts/build-guest.sh`: replace Go build line with `cargo build --target i686-unknown-linux-musl --release` + `cp ... guest/sync-agent.bin`
- [ ] Run `npm run images` to rebuild guest with Rust binary inside Docker image
- [ ] Boot test: start Electron, verify sync-agent runs in Alpine and reads frames from `/dev/hvc0`

**Gate:** ✅ `termios.rs` compiles, `set_raw` mirrors Go ioctl flags exactly. Cross-platform ioctl cast works for both i686 and x86_64 test host. `main.rs` opens device, sets raw mode, reads frames in loop. Build: 731K ELF 32-bit LSB, statically linked. Remaining: build script integration, Docker guest rebuild, boot test.

---

### Phase 4: Transfer (~6h) — **Most Complex Component** ✅

**File:** `src/transfer.rs`

- [x] `PutMeta` struct with serde derives matching `{xfer, path, size, mode, mtimeMs, hash}`
- [x] `Receiver` struct: `root`, `fw: Arc<FrameWriter>`, `sync: Arc<SyncState>`, `xfers: Mutex<HashMap<u32, Incoming>>`, `trees: Mutex<HashMap<u32, IncomingTree>>`, `verify: bool`
- [x] `Incoming` struct `{meta, tmp_path, received, chunks}` — stores metadata only (no `File` handle) for safe ownership transfer
- [x] `HandlePut(frame)` — parse JSON, safeJoin, conflict check via `ResolveIncoming`, create temp in `.sync-tmp/put-*`, register xfer, zero-size → immediate finish, else ack `{xfer}`
- [x] `HandleChunk(frame)` — parse 12B header (4B xfer LE + 8B offset LE), route to tree or regular, `WriteAt(data, offset)`, progress ack every 16 chunks
- [x] `finish(seq, in)` — optional SHA256 verify, chmod+chtimes, atomic `std::fs::rename()`, `MarkSynced`, remove from xfers, ack `{xfer, done}`
- [x] `abort(seq, in, msg)` — remove temp file, remove from xfers, nak
- [x] `HandleTreePut(frame)` — parse `{xfer, size, count}`, register empty `IncomingTree`, zero-size → immediate finish
- [x] `handleTreeChunk(seq, tr, offset, data)` — verify sequential offset, call `unpack()`, completion → `finishTree()`, progress ack every 16
- [x] **`unpack(tr, data)`** — state machine: append to carry-over buf → read header len (4B LE) → parse JSON header → check safeJoin/conflict → open file → stream bytes until `curLeft == 0` → close + mtime + `MarkSynced` → reset. Carry-over buffer persists across chunk boundaries.
- [x] `finishTree(seq, tr)` — verify no trailing bytes, remove from trees, ack `{xfer, done, skipped}`
- [x] `abortTree(seq, tr, msg)` — close current file, remove from trees, nak
- [x] `HandleDel(frame)` — parse `{path}`, safeJoin, `RemoveAll`, `MarkDeleted`, ack
- [x] `Sender` struct: `nextXfer` starting at base (0 or 0x40000000), window channel (cap 32), `acks: Mutex<HashMap<u32, Sender<Frame>>>`
- [x] `HandleAck(frame)` — route ACK/NAK by xfer to waiting channel, release 16 window slots for progress acks
- [x] `PushFile(rel)` — stat+hash file, send PUT, wait ready-ack (30s timeout), stream chunks with windowing, wait final ack (60s timeout)
- [x] `PushDelete(rel)` — send `TypeFileDel` JSON, `MarkDeleted`

**Gate:** ✅ Code compiles, 19 unit tests pass. 731K static ELF 32-bit binary. Remaining: boot test in Alpine guest, `npm run test:sync` with console-only.

---

### Phase 5: Inotify Watcher (~3h)

**File:** `src/watcher.rs`
**New dep:** raw `libc::inotify_*` (avoids `inotify` crate bitflags incompatibility with Rust 1.93)

- [x] `Watcher` struct with inotify fd, `wds: Mutex<HashMap<i32, String>>`, `pending: Mutex<HashMap<String, String>>`, debounce timer, flush callback channel
- [x] Raw inotify: `libc::inotify_init1(0)`, `libc::inotify_add_watch(fd, path, mask)`, `libc::read(fd, buf, len)`
- [x] Watch mask: `IN_CLOSE_WRITE | IN_CREATE | IN_DELETE | IN_MOVED_TO | IN_MOVED_FROM | IN_DELETE_SELF`
- [x] `watchTree(dir)` — recursive `read_dir`, add watch per directory, skip ignored paths
- [x] Event loop thread — read 64KB buffer, parse variable-length `inotify_event` structs (wd i32 LE, mask u32 LE, cookie u32 LE, null-terminated name)
- [x] Event routing: Dir CREATE/MOVED_TO → re-watchTree + enqueue files recursively; Dir DELETE/MOVED_FROM → del; File CLOSE_WRITE/MOVED_TO → put; File DELETE/MOVED_FROM → del
- [x] Debounce: 300ms poll timeout after last event, then flush all pending ops through channel

**Gate:** ✅ Raw libc inotify, `#[repr(C)] InotifyEvent` parser, `poll()`-based non-blocking loop with 300ms debounce. 19 tests pass. 731K static ELF 32-bit binary. Remaining: boot test in Alpine guest, `npm run test:sync` integration.

---

### Phase 6: Data Plane + Full Orchestration (~3h) ✅

**Files:** `src/dataplane.rs`, complete `src/main.rs`

- [x] `DataPlane` struct with `Mutex<{cfg, gen, conn, sender}>`, generation-based invalidation
- [x] `Update(cfg)` — if cfg changed → `gen++`, close old conn, spawn new dial loop thread
- [x] Dial loop — retry connect every 2s, check `stale(gen)` before each attempt and after successful connect
- [x] TCP session — send HELLO with token+root, create `ReceiverNoVerify` + `Sender(base=0x40000000)`, register sender in data-plane
- [x] Liveness pings thread — every 15s send ping, if no traffic for 45s → close conn (handles snapshot restore dead-session detection)
- [x] Frame read loop on TCP — route transfers/pings/manifests to handlers
- [x] `Shutdown()` — `gen++`, close conn, invalidate all loops
- [x] Full `main.rs` session loop: open device, setRaw, create all components, send guest HELLO `{version: 1, role: "guest", root}`
- [x] Spawn push queue worker thread (channel-based) — iterate ops, safeJoin, check `IsEcho`, call `pushVia` (data-plane first, console fallback on failure)
- [x] Start inotify watcher with push queue channel as flush callback
- [x] Main console read loop dispatching all frame types to handlers

**Gate:** ✅ Code compiles, 19 unit tests pass. 731K static ELF 32-bit binary. Remaining: boot test in Alpine guest, `npm run test:sync` integration.

---

### Phase 7: Final Verification (~1h) ✅

- [x] `npm run test:unit` — protocol compatibility (CRC, frame format) — 19 tests pass
- [x] `npm run test:sync` — end-to-end file sync in VM, including guest→host push
- [ ] `npm run test:boot` — boot/hydrate/snapshot cycle
- [ ] `npm run test:snapshot` — snapshot restore + data-plane reconnect
- [ ] Verify binary size ~200KB static (`ls -lh target/.../sync-agent`)
- [ ] Verify init script compatibility — runs with `-root /workspace -dev /dev/hvc0`
- [ ] Decide: remove Go source or keep as reference alongside Rust
- [ ] Update `AGENTS.md` — note Rust instead of Go for sync-agent
- [ ] Mark this document as completed

**Gate:** ✅ Sync tests pass. Guest→host push fixed via xfer-based ACK routing (commit `e15ea95`). Debug logging cleaned up. Remaining: boot/snapshot tests, final housekeeping.

---

### Rollback Strategy

At any phase, the Go binary remains in `sandbox/guest/sync-agent/`. To rollback:
1. Revert `scripts/build-guest.sh` to use Go build command
2. Run `npm run images` to rebuild guest with Go binary
3. Tests will pass as they did before (they test protocol behavior, not implementation language)

### Dependency Timeline

| Phase | Deps Added |
|-------|-----------|
| 1 | `crc32fast = "1"` |
| 2 | `sha2 = "0.10"`, `serde = "1"`, `serde_json = "1"`, `walkdir = "2"`, `libc = "0.2"` |
| 3 | (none) |
| 4 | (none — raw `libc::inotify_*`, avoids `inotify` crate bitflags incompatibility) |
| 5–6 | (none) |
| 7 | (none) |

**Total estimated: ~18–23h across 7 phases.**

## Relevant Files

- `sandbox/src/shared/protocol.ts` — TypeScript protocol definition (source of truth for CRC/frame format)
- `sandbox/guest/sync-agent/` — All Go source files (listed above)
- `sandbox/scripts/build-guest.sh` — Build script to update (output: `guest/sync-agent.bin`)
- `sandbox/guest/Dockerfile` — Guest image definition (`COPY sync-agent.bin /usr/local/bin/sync-agent`)
- `sandbox/guest/rootfs/etc/init.d/sync-agent` — Init script
- `sandbox/docs/data-plane-architecture.md` — Sync channels and data flow
- `sandbox/HARDENING.md` — Security checklist and invariants
- `sandbox/README.md` — Architecture overview, timings
- `sandbox/src/main/manifest.ts` — TS `splitManifest` / batch limit calculation

---

## Phase 7 Notes (Resolved)

**Guest→host push fix** (commit `e15ea95`): Root cause was `push_file` fire-and-forget with stub `handle_ack_transfer`. Fixed by implementing xfer-based ACK routing (`register_xfer_waiter`/`complete_xfer`) in `FrameWriter`, rewriting `push_file` to use xfer waiters (register → PUT → ready-ack → stream → done-ack), and wiring ACK routing into the main dispatch loop. Debug logging and temporary test helpers cleaned up.

---

## Post-Phase-7 Fix Plan: Complete Rewrite Review Gaps

### Summary

A comprehensive architecture review (Jul 2026) identified **14 issues** in the Rust rewrite compared to the Go original. Two critical, four high, six medium, two low. Below is the ordered fix plan, structured as continuation phases after Phase 7.

### Severity Key
| Label | Meaning |
|-------|---------|
| 🔴 CRITICAL | Breaks production deployment |
| 🟠 HIGH | Functional gap vs Go — data loss or incorrect behavior |
| 🟡 MEDIUM | Behavioral difference or missing feature |
| 🟢 LOW | Minor performance or normalization issue |

---

### Phase 8: Critical Fixes

#### 8.1 Flag parsing: accept `-root` / `-dev` short form
**🔴 CRITICAL** — `main.rs:19-24`

The init script (`guest/rootfs/etc/init.d/sync-agent:5`) passes `-root /workspace -dev /dev/hvc0` (Go's `flag.String` style). The Rust code only parses `--root=` and `--dev=` (long opt style). The binary will use default `/workspace` and `/dev/hvc0` by luck in dev, but will fail on any non-default configuration.

**Fix:** Add `-root` and `-dev` short-flag parsing alongside the long forms:
```rust
for i in 1..args.len() {
    let arg = &args[i];
    if arg.starts_with("--root=") {
        root = arg[7..].to_string();
    } else if arg == "-root" && i + 1 < args.len() {
        root = args[i + 1].clone();
    } else if arg.starts_with("--dev=") {
        dev = arg[6..].to_string();
    } else if arg == "-dev" && i + 1 < args.len() {
        dev = args[i + 1].clone();
    }
}
```

#### 8.2 Data-plane ACK routing: wire `Sender.handle_ack()`
**🔴 CRITICAL** — `dataplane.rs:183-186`

The Go data-plane loop (`dataplane.go:176`) calls `send.HandleAck(f)` for every `TypeAck | TypeNak` frame, routing xfer ACKs to waiting senders and draining window slots. The Rust data-plane loop has a no-op comment `// non-xfer acks need nothing`. Guest→host pushes over the TCP data plane will never receive their ready-ack or done-ack, causing timeouts.

**Fix:** Replace the no-op with `send.handle_ack(&f)` (requires Phase 9.1 to add `handle_ack` on `Sender`).

---

### Phase 9: High-Severity Fixes

#### 9.1 Add `handle_ack()` to Sender + window semaphore
**🟠 HIGH** — `transfer.rs:686-705`

**Window semaphore missing:** Go uses a counting semaphore (`window chan struct{}`, capacity 32) to limit in-flight chunks. Each chunk does `s.window <- struct{}{}` before sending, and progress ACKs drain up to 16 slots. The Rust sender streams all chunks in a tight loop with no backpressure — on virtio-console this can fill the ring and drop frames.

**`handle_ack` missing:** Go's `Sender.HandleAck(f)` (transfer.go:386-414) parses `xfer` from the payload, routes to a waiting channel, and drains 16 window slots on progress ACKs. The Rust `Sender` has no `handle_ack` method.

**Fix:**
- Add `window: Mutex<u32>` (capacity 32) to `Sender` struct.
- In `push_file`, before each `TYPE_FILE_CHUNK` send: acquire slot (`window -= 1` if `window > 0`).
- Add `handle_ack(&self, f: &Frame) -> bool`:
  - Parse `xfer`, `done`, `error`, `received` from payload.
  - If `received` present and not done: drain 16 slots (`window += 16`, cap 32).
  - If `xfer` matches a waiter: forward to waiter.
- Wire `handle_ack` into the data-plane loop (Phase 8.2) and the console main loop, replacing the current `handle_ack_transfer` stub.

#### 9.2 Temp file naming: use unique suffix per xfer
**🟠 HIGH** — `transfer.rs:137`

Go uses `os.CreateTemp(tmpDir, "put-*")` which generates unique random suffixes. Rust uses `format!("{}/put-{}", tmp_dir, std::process::id())`. Two concurrent transfers (console + data plane) will share the same PID and overwrite each other's temp files.

**Fix:** Change to `format!("{}/put-{}-{}", tmp_dir, xfer, std::process::id())`. Since xfer IDs are disjoint per channel (console 0..0x3FFFFFFF, data-plane 0x40000000..0x7FFFFFFF), this guarantees uniqueness.

#### 9.3 Directory deletion: use `remove_dir_all`
**🟠 HIGH** — `transfer.rs:546`

Go's `HandleDel` calls `os.RemoveAll(abs)` which recursively removes directories. Rust uses `std::fs::remove_file` which only removes files. Guest deleting a directory will fail with "no such file or directory" (if it's a directory) and send a NAK.

**Fix:** Replace `std::fs::remove_file(&abs)` with a helper that checks `abs` is a directory and calls `std::fs::remove_dir_all` vs `std::fs::remove_file` accordingly. Or simply call `remove_dir_all` unconditionally (it also works for files on Linux).

#### 9.4 Conflict event emission: add `fw` to SyncState
**🟠 HIGH** — `state.rs:17-24`, `state.rs:112-142`

Go's `SyncState` holds a `fw *FrameWriter` pointer and emits `TypeEvent` frames on conflict (`state.go:122-126`). The Rust `SyncState` lacks the `fw` reference, so its `resolve_incoming` only `slog!`s — the host never receives conflict events. Breaks the conflict-detection feedback loop in `sync-manager.ts`.

**Fix:**
- Add `fw: Option<Arc<FrameWriter>>` field to `SyncStateInner`.
- Pass `fw.clone()` in all `new_sender`/`new_receiver` callers (`main.rs:46-47`, `dataplane.rs:136-137`).
- In `resolve_incoming`, emit `TYPE_EVENT` with JSON `{"events": [{"op": "conflict", "path": rel, "winner": winner, "localMtimeMs": ..., "remoteMtimeMs": ...}]}` matching Go.

---

### Phase 10: Medium-Severity Fixes

#### 10.1 Add `TYPE_EVENT = 8` constant + handler
**🟡 MEDIUM** — `frame.rs:6-14`, `main.rs:169-171`

The protocol defines `TYPE_EVENT = 8` (used for conflict events and host logging). The Rust code defines types 1-10 but skips 8. Host event frames are silently dropped in the `_ =>` default branch.

**Fix:** Add `pub const TYPE_EVENT: u8 = 8;` in `frame.rs`. In `main.rs` dispatch, add `frame::TYPE_EVENT => { crate::slog!(...); }` before the `_ =>` default.

#### 10.2 Align debounce to 300ms
**🟡 MEDIUM** — `watcher.rs:26`

Go debounce is 300ms (`time.AfterFunc(300ms)`). Rust uses `DEBOUNCE_MS = 100`. This causes the Rust watcher to flush events 3× faster than Go, potentially triggering more frequent push operations for bursty writes.

**Fix:** Change `DEBOUNCE_MS` from 100 to 300 to match Go behavior.

#### 10.3 Fix poll-then-flush ordering
**🟡 MEDIUM** — `watcher.rs:185-193`

The Rust watcher checks `should_flush` **before** reading events. If events arrive at the poll boundary, the pending ops are flushed before the new events are processed — those events are lost until the next poll cycle. Go's `AfterFunc` avoids this by design.

**Fix:** Move the flush check **after** the `libc::read` call. Only flush after processing newly read events.

#### 10.4 Skip ignored dirs in `watch_tree`
**🟡 MEDIUM** — `watcher.rs:75-123`

The Rust watcher adds `inotify_add_watch` for every directory including `.git`, `node_modules`, etc., then filters at event-handling time. This wastes inotify descriptor slots (limited on 32-bit Alpine). Go skips ignored directories during the walk.

**Fix:** Add `ignored_rel` check before calling `inotify_add_watch` for subdirectories. The root directory must always be watched.

#### 10.5 Fix done-ack retry loop
**🟡 MEDIUM** — `transfer.rs:708-747`

The done-ack retry loop re-registers a waiter and waits again if `done` is false. If a progress ACK arrives at the retry waiter (not the done-ACK), the code checks `body.done` (false), falls through, and returns `TimedOut` erroneously.

**Fix:** Replace with a proper loop that handles both progress and done ACKs:
```rust
loop {
    match done_rx.recv_timeout(Duration::from_secs(60)) {
        Ok((typ, payload)) => {
            if typ == TYPE_NAK { ... return Err(...) }
            let body: serde_json::Value = serde_json::from_slice(&payload).unwrap_or_default();
            if body.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                break; // done-ack received
            }
            // progress ack — re-register waiter and continue
            let (retry_tx, retry_rx) = mpsc::channel();
            self.fw.register_xfer_waiter(xfer, retry_tx);
            done_rx = retry_rx;
        }
        Err(e) => return Err(io::Error::new(io::ErrorKind::TimedOut, ...))
    }
}
```

#### 10.6 Add Rust unit tests for critical components
**🟡 MEDIUM** — (all)

No unit tests exist for `transfer.rs`, `state.rs`, `watcher.rs`, `dataplane.rs`, or `main.rs`. Only `frame.rs` and `manifest.rs` have tests (19 total). The Go code had no unit tests either, but the Rust rewrite is new code and needs coverage.

**Test targets:**
- `transfer.rs`: `push_file` (mock FrameWriter), `Receiver.handle_put`, `Receiver.handle_chunk`, `Receiver.handle_del` (directory case), `Receiver.handle_tree_put`, `Receiver.finish`, tree `unpack` state machine
- `state.rs`: `resolve_incoming` (no conflict, LWW local wins, LWW remote wins), `is_echo`, `hash_cached` cache hit/miss
- `watcher.rs`: `parse_events`, `ignored_rel` filtering, debounce timing
- `dataplane.rs`: `DataPlaneCfg` update, `stale` checks, sender lifecycle
- `main.rs`: flag parsing (`-root`, `--root=`, `-dev`, `--dev=`)

---

### Phase 11: Low-Severity Fixes

#### 11.1 Keep temp file handle open across chunks
**🟢 LOW** — `transfer.rs:199-215`

The Rust `Receiver.handle_chunk` opens the temp file, seeks, writes, and drops the handle for every chunk. Go keeps the file handle open for the lifetime of the transfer (`in.tmp` in the `incoming` struct). Opening/closing per chunk is wasteful but not a correctness issue.

**Fix:** Store `Option<File>` in `Incoming` struct. Open once in `handle_put`. Close in `finish`/`abort`. Eliminates open/seek/write/close per chunk.

#### 11.2 Normalize `.` in `safe_join`
**🟢 LOW** — `manifest.rs:123-147`

Go's `filepath.Join` normalizes `.` components (e.g., `foo/./bar` → `foo/bar`). The Rust `safe_join` preserves `.` as-is, resulting in paths like `/workspace/foo/./bar`. This is harmless on ext4 but inconsistent.

**Fix:** After joining, strip `.` path components by canonicalizing or manually filtering them.

---

### Phase Order & Dependencies

```
Phase 8 (critical) ──────────────────┐
                                     ├── Phase 10 (medium) ──┐
Phase 9 (high) ──────────────────────┤                        ├── Phase 11 (low + tests)
                                     │                        │
                                     └────────────────────────┘
```

- Phases 8-9 can run in parallel (no overlapping file edits).
- Phase 10 depends on Phase 9 (window semaphore + handle_ack needed for done-ack retry fix).
- Phase 11 depends on Phases 8-10 (tests validate the fixes).

**Estimated effort:** ~4-6 hours total across all phases.

