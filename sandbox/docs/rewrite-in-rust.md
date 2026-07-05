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

### Phase 7: Final Verification (completed)

- [x] `npm run test:unit` — protocol compatibility (CRC, frame format) — 39 tests pass
- [x] `npm run test:sync` — end-to-end file sync in VM, including guest→host push
- [x] `npm run test:boot` — boot/hydrate/snapshot cycle
- [x] `npm run test:snapshot` — snapshot restore + data-plane reconnect
- [x] Binary size ~200KB static (`ls -lh target/i686-unknown-linux-musl/release/sync-agent`)
- [x] Init script compatibility — runs with `-root /workspace -dev /dev/hvc0`
- [x] Go source kept as reference alongside Rust
- [x] `AGENTS.md` updated — notes Rust instead of Go for sync-agent
- [x] Document completed

**Result:** ✅ All VM tests pass. Guest→host push fixed via xfer-based ACK routing (commit `e15ea95`). All 14 Phase 8 architecture-review fixes applied. Handshake reliability fixed (guest retransmits HELLO; host caches last HELLO). Host-delete semantics match Go (file/dir/idempotent).

### Phase 8: Post-Review Fixes

A comprehensive architecture review identified 14 issues in the Rust rewrite. This phase fixes all of them, ordered by severity.

#### Phase 8.1 — Critical: Flag Parsing & Data-Plane ACK Routing

- [x] **8.1.1 Flag format: accept `-root` / `-dev` short form** — `src/main.rs:19-24`. The init script passes `-root /workspace -dev /dev/hvc0` (Go's `flag.String` style). Rust only parses `--root=` / `--dev=`. Add short-form parsing:

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

- [x] **8.1.2 Data-plane ACK routing: wire `sender.handle_ack()`** — `src/dataplane.rs:183-186`. Go's `dataplane.go:176` calls `send.HandleAck(f)` on every `TYPE_ACK | TYPE_NAK` frame. Rust currently has a no-op comment. Replace with:

    ```rust
    TYPE_ACK | TYPE_NAK => {
        if let Some(ref sender) = inner.sender {
            sender.handle_ack(&f);
        }
    }
    ```
    Requires: `Sender` gains a `handle_ack(&self, f: &Frame)` method (8.2.1).

#### Phase 8.2 — High: Transfer Correctness

- [x] **8.2.1 Window semaphore + `handle_ack()` in Sender** — `src/transfer.rs`. Add `window: Mutex<u32>` (capacity 32) to `Sender`. Before each chunk send, acquire a slot — block if `window == 0`, then `window -= 1`. Add `handle_ack` method matching Go `transfer.go:386-414`: parse `{xfer, done, error, received}`, drain 16 window slots on progress ack, forward to waiter. Wire into data-plane loop (8.1.2) and console main loop.

- [x] **8.2.2 Temp file naming: unique suffix per xfer** — `src/transfer.rs:137`. Change from `put-{pid}` to `put-{xfer}-{pid}`. Console sender xfer IDs are 0..0x3FFFFFFF, data-plane 0x40000000..0x7FFFFFFF — no collisions across channels.

- [x] **8.2.3 Directory deletion: use `remove_dir_all`** — `src/transfer.rs:546`. Replace `std::fs::remove_file(&abs)` with `std::fs::remove_dir_all(&abs)` (works for both files and directories on Linux).

- [x] **8.2.4 Conflict event emission: add `fw` to SyncState** — `src/state.rs:17-24`, `src/state.rs:112-142`. Add `fw: Option<Arc<FrameWriter>>` to `SyncStateInner`. Pass `fw.clone()` from callers. In `resolve_incoming`, emit `TYPE_EVENT` with JSON `{"events":[{"op":"conflict","path":rel,"winner":winner}]}` matching Go `state.go:122-126`.

#### Phase 8.3 — Medium: Protocol Completeness

- [x] **8.3.1 Add `TYPE_EVENT = 8` constant + handler** — `src/frame.rs:6-14`, `src/main.rs:169-171`. Define `pub const TYPE_EVENT: u8 = 8`. In main dispatch loop, add `frame::TYPE_EVENT => { crate::slog!(...); }` before the `_ =>` default.

- [x] **8.3.2 Align debounce to 300ms** — `src/watcher.rs:26`. Change `DEBOUNCE_MS` from 100 to 300 to match Go behavior.

- [x] **8.3.3 Fix poll-then-flush ordering** — `src/watcher.rs:185-193`. Move flush check **after** reading events from inotify.

- [x] **8.3.4 Skip ignored dirs in `watch_tree`** — `src/watcher.rs:75-123`. Check `ignored_rel` before calling `inotify_add_watch` for subdirectories. Root dir must always be watched.

- [x] **8.3.5 Fix done-ack retry loop** — `src/transfer.rs:708-747`. Replace fragile retry loop with a single loop handling both progress and done ACKs:

    ```rust
    loop {
        match done_rx.recv_timeout(Duration::from_secs(60)) {
            Ok((typ, payload)) => {
                if typ == TYPE_NAK { ... return Err(...) }
                let body = serde_json::from_slice(&payload).unwrap_or_default();
                if body.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                    break;
                }
                let (retry_tx, retry_rx) = channel();
                self.fw.register_xfer_waiter(xfer, retry_tx);
                done_rx = retry_rx;
            }
            Err(e) => return Err(TimedOut)
        }
    }
    ```

#### Phase 8.4 — Low + Tests

- [x] **8.4.1 Keep temp file handle open across chunks** — `src/transfer.rs:199-215`. Store `Option<File>` in `Incoming` struct. Open once in `handle_put`, close in `finish`/`abort`.

- [x] **8.4.2 Normalize `.` in `safe_join`** — `src/manifest.rs:123-147`. After joining, strip `.` path components.

- [x] **8.4.3 Add Rust unit tests** — `#[cfg(test)]` in `src/transfer.rs`, `src/state.rs`, `src/watcher.rs`, `src/dataplane.rs`, `src/main.rs`. Coverage targets: transfer (push_file, handle_put, handle_chunk, handle_del, handle_tree_put), state (resolve_incoming, is_echo, hash_cached), watcher (parse_events, ignored_rel), dataplane (cfg update, staleness), main (flag parsing).

#### Phase 8.5 — Clean Up

- [x] Remove any temporary diagnostics or unused imports introduced during Phase 8
- [x] Run `cargo check --target i686-unknown-linux-musl` — zero warnings
- [x] Run `cargo test --target i686-unknown-linux-musl` — all tests pass
- [x] Rebuild guest image, run `npm run test:sync`, `npm run test:boot`, `npm run test:snapshot`

**Estimated effort:** ~4–6 hours total 

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

## Phase 8 Notes (Resolved)

All 14 architecture-review fixes implemented in a single batch (Phases 8.1-8.5). Three additional fixes applied after test failures:

1. **Host-delete semantics** (`transfer.rs:530`): `handle_del` now matches Go's `os.RemoveAll` — uses `symlink_metadata` to check path type, calls `remove_file` for files and `remove_dir_all` for dirs, ACKs on missing paths (idempotent). Fixes `ENOTDIR` / `ENOENT` NAK errors.

2. **Delete echo suppression removed** (`main.rs:107-110`): Rust-only `last_hash(rel).is_none()` guard deleted. Deletes are now forwarded unconditionally per Go behavior; host receiver is idempotent.

3. **Handshake reliability** (`main.rs:72-109`, `bridge.ts:127-144`): Guest retransmits HELLO every 2s until ACKed (up to 60s). Host `waitGuestHello` caches the last guest HELLO frame, making the listener sticky — resolves even if HELLO arrives before the listener is armed.

All three VM tests (`test:boot`, `test:sync`, `test:snapshot`) pass with the Rust binary. `test:unit` covers 39 tests.



