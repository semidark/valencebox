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
serde_json = "1"     # JSON parsing/serialization
inotify = "0.10"     # Linux inotify wrapper (fallback: raw libc::inotify_*)
libc = "0.2"         # ioctl, syscalls, inotify fallback
walkdir = "2"        # recursive directory walk (alternative: manual std::fs::read_dir recursion)
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

Requires `musl-gcc` for the i686 musl target, or `cargo-zigbuild`/`cross` as alternatives.

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

Each phase has a verification gate. Do not proceed to the next phase until the current gate passes. Go source remains as rollback at any point: revert `scripts/build-guest.sh` → `npm run images`.

### Pre-flight

- [ ] Confirm `musl-gcc` works for i686-musl linker (`rustc --target i686-unknown-linux-musl` already installed)
- [ ] Skeleton `cargo check --target i686-unknown-linux-musl` to verify all crates resolve

---

### Phase 1: Frame Protocol (~2h)

**Files:** `Cargo.toml`, `src/frame.rs`, stub `src/main.rs`

- [ ] Create `sandbox/guest/sync-agent-rust/` with `Cargo.toml` (package `sync-agent`, edition 2021, dep: `crc32fast = "1"`)
- [ ] Implement `Frame` struct `{typ: u8, seq: u32, payload: Vec<u8>}` + frame type constants (1–10)
- [ ] Implement `ReadFrame` — byte-by-byte magic hunt state machine matching Go `frame.go:40-53` exactly (`matched++`, `b == magic[0] → 1`, `else → 0`)
- [ ] Wire format: `[MAGIC 4B][type 1B][seq 4B LE][plen 4B LE][payload N B][crc32 4B LE]`
- [ ] CRC covers header(9) + payload(N), NOT magic, NOT trailer — IEEE via `crc32fast`
- [ ] Implement `FrameWriter` with `Mutex`-protected writer + auto-incrementing seq counter
- [ ] Cross-check CRC against `protocol.ts` IEEE table (0xEDB88320 reversed)
- [ ] Stub `src/main.rs`: `fn main() { println!("sync-agent-rust placeholder"); }`

**Gate:** Binary compiles for i686-musl. Frame read/write round-trip produces identical bytes for a known payload.

---

### Phase 2: Manifest + State (~3h)

**Files:** `src/manifest.rs`, `src/state.rs`
**New deps:** `sha2 = "0.10"`, `serde_json = "1"`, optionally `walkdir = "2"`

- [ ] `FileMeta` struct with serde derives — field names match Go JSON exactly (`hash`, `size`, `mode`, `mtimeMs`)
- [ ] `Manifest { files: HashMap<String, FileMeta> }` with serde
- [ ] `ignoredRel(rel: &str) -> bool` — split on `/`, check segments against `{".sync-tmp", ".git", "node_modules", "lost+found", ".DS_Store"}`
- [ ] `hashFile(path: &str) -> Result<String>` — streaming SHA256 hex digest via `sha2::Sha256`
- [ ] `buildManifest(root, ss)` — recursive walk, skip ignored/non-regular files, use `ss.hash_cached_stat()` for cache benefit
- [ ] `marshalManifestBatches(m)` — 160*1024 byte soft limit, ~160B per entry estimate (`len(rel) + 160`)
- [ ] `safeJoin(root, rel) -> Option<String>` — reject empty/absolute paths, detect `..` via path components
- [ ] `SyncState` with `Mutex<{last_sync, stat_cache}>`, `fw: Arc<FrameWriter>`
- [ ] `HashCached` / `hashCachedStat` — same (size, mtime) cache invalidation as Go
- [ ] `MarkSynced`, `MarkDeleted`, `LastHash`, `IsEcho`
- [ ] `ResolveIncoming` — LWW by mtime, tie-break greater hash string, emit `TypeEvent` JSON on conflict
- [ ] Verify: serialize a `FileMeta` with serde_json and compare key names against Go's `json.Marshal` output

**Gate:** All pure-logic functions work correctly. `safeJoin` rejects the same paths Go rejects.

---

### Phase 3: Termios + Build Integration (~1h)

**Files:** `src/termios.rs`, update `scripts/build-guest.sh`, functional `src/main.rs`
**New dep:** `libc = "0.2"`

- [ ] Define `#[repr(C)] struct Termios { iflag: u32, oflag: u32, cflag: u32, lflag: u32, line: u8, cc: [u8; 19] }`
- [ ] Hardcoded ioctl constants: `TCGETS = 0x5401`, `TCSETS = 0x5402` — **do NOT use** `libc::TCGETS` wrapper
- [ ] Copy Go's termios flag constants exactly (ignbrk=0x1, brkint=0x2, icrnl=0x100, etc.)
- [ ] Implement `setRaw(fd)` — `unsafe { libc::ioctl(fd, TCGETS, ...) }`, apply same flag masks as Go, `TCSETS`
- [ ] Implement `main.rs`: parse `-root`/`-dev` from `std::env::args()`, open device, call `setRaw`, read frames in loop and print type
- [ ] Update `scripts/build-guest.sh`: replace Go build line with `cargo build --target i686-unknown-linux-musl --release` + `cp ... guest/sync-agent.bin`
- [ ] Run `npm run images` to rebuild guest with Rust binary inside Docker image
- [ ] Boot test: start Electron, verify sync-agent runs in Alpine and reads frames from `/dev/hvc0`

**Gate:** Guest boots, sync-agent binary runs in Alpine, opens `/dev/hvc0`, reads frames without crashing. Go binary is NOT yet deleted — parallel run possible.

---

### Phase 4: Transfer (~6h) — **Most Complex Component**

**File:** `src/transfer.rs`

- [ ] `PutMeta` struct with serde derives matching `{xfer, path, size, mode, mtimeMs, hash}`
- [ ] `Receiver` struct: `root`, `fw: Arc<FrameWriter>`, `sync: Arc<SyncState>`, `xfers: Mutex<HashMap<u32, Incoming>>`, `trees: Mutex<HashMap<u32, IncomingTree>>`, `verify: bool`
- [ ] `Incoming` struct `{meta, tmp: File, tmpPath, received, chunks}`
- [ ] `HandlePut(frame)` — parse JSON, safeJoin, conflict check via `ResolveIncoming`, create temp in `.sync-tmp/put-*`, register xfer, zero-size → immediate finish, else ack `{xfer}`
- [ ] `HandleChunk(frame)` — parse 12B header (4B xfer LE + 8B offset LE), route to tree or regular, `WriteAt(data, offset)`, progress ack every 16 chunks
- [ ] `finish(seq, in)` — close temp, optional SHA256 verify, chmod+chtimes, atomic `std::fs::rename()`, `MarkSynced`, remove from xfers, ack `{xfer, done}`
- [ ] `abort(seq, in, msg)` — close temp, remove file, remove from xfers, nak
- [ ] `HandleTreePut(frame)` — parse `{xfer, size, count}`, register empty `IncomingTree`, zero-size → immediate finish
- [ ] `handleTreeChunk(seq, tr, offset, data)` — verify sequential offset, call `unpack()`, completion → `finishTree()`, progress ack every 16
- [ ] **`unpack(tr, data)`** — state machine: append to carry-over buf → read header len (4B LE) → parse JSON header → check safeJoin/conflict → open file → stream bytes until `curLeft == 0` → close + mtime + `MarkSynced` → reset. Carry-over buffer persists across chunk boundaries.
- [ ] `finishTree(seq, tr)` — verify no trailing bytes, remove from trees, ack `{xfer, done, skipped}`
- [ ] `abortTree(seq, tr, msg)` — close current file, remove from trees, nak
- [ ] `HandleDel(frame)` — parse `{path}`, safeJoin, `RemoveAll`, `MarkDeleted`, ack
- [ ] `Sender` struct: `nextXfer` starting at base (0 or 0x40000000), window channel (cap 32), `acks: Mutex<HashMap<u32, Sender<Frame>>>`
- [ ] `HandleAck(frame)` — route ACK/NAK by xfer to waiting channel, release 16 window slots for progress acks
- [ ] `PushFile(rel)` — stat+hash file, send PUT, wait ready-ack (30s timeout), stream chunks with windowing, wait final ack (60s timeout)
- [ ] `PushDelete(rel)` — send `TypeFileDel` JSON, `MarkDeleted`

**Gate:** Console I/O transfers work bidirectionally. TREE_PUT streaming with mid-chunk splits handles correctly. Disable data-plane for this phase. Run `npm run test:sync` with console-only.

---

### Phase 5: Inotify Watcher (~3h)

**File:** `src/watcher.rs`
**New dep:** `inotify = "0.10"` (or fallback to raw `libc::inotify_*`)

- [ ] `Watcher` struct with inotify fd, `wds: Mutex<HashMap<i32, String>>`, `pending: Mutex<HashMap<String, String>>`, debounce timer, flush callback channel
- [ ] Raw inotify: `libc::inotify_init(0)`, `libc::inotify_add_watch(fd, path, mask)`, `libc::read(fd, buf, len)`
- [ ] Watch mask: `IN_CLOSE_WRITE | IN_CREATE | IN_DELETE | IN_MOVED_TO | IN_MOVED_FROM | IN_DELETE_SELF`
- [ ] `watchTree(dir)` — recursive `read_dir`, add watch per directory, skip ignored paths
- [ ] Event loop thread — read 64KB buffer, parse variable-length `inotify_event` structs (wd i32 LE, mask u32 LE, cookie u32 LE, null-terminated name)
- [ ] Event routing: Dir CREATE/MOVED_TO → re-watchTree + enqueue files recursively; Dir DELETE/MOVED_FROM → del; File CLOSE_WRITE/MOVED_TO → put; File DELETE/MOVED_FROM → del
- [ ] Debounce: 300ms `thread::sleep` after last event, then flush all pending ops through channel

**Gate:** Guest-side file changes produce correct events forwarded over console within ~300ms debounce. Compare against Go behavior.

---

### Phase 6: Data Plane + Full Orchestration (~3h)

**Files:** `src/dataplane.rs`, complete `src/main.rs`

- [ ] `DataPlane` struct with `Mutex<{cfg, gen, conn, sender}>`, generation-based invalidation
- [ ] `Update(cfg)` — if cfg changed → `gen++`, close old conn, spawn new dial loop thread
- [ ] Dial loop — retry connect every 2s, check `stale(gen)` before each attempt and after successful connect
- [ ] TCP session — send HELLO with token+root, create `ReceiverNoVerify` + `Sender(base=0x40000000)`, register sender in data-plane
- [ ] Liveness pings thread — every 15s send ping, if no traffic for 45s → close conn (handles snapshot restore dead-session detection)
- [ ] Frame read loop on TCP — route transfers/pings/manifests to handlers
- [ ] `Shutdown()` — `gen++`, close conn, invalidate all loops
- [ ] Full `main.rs` session loop: open device, setRaw, create all components, send guest HELLO `{version: 1, role: "guest", root}`
- [ ] Spawn push queue worker thread (channel-based) — iterate ops, safeJoin, check `IsEcho`, call `pushVia` (data-plane first, console fallback on failure)
- [ ] Start inotify watcher with push queue channel as flush callback
- [ ] Main console read loop dispatching all frame types to handlers

**Gate:** Full VM integration. Run `npm run test:sync` — all tests pass with TCP data plane active. Compare sync throughput qualitatively against Go baseline.

---

### Phase 7: Final Verification (~1h)

- [ ] `npm run test:unit` — protocol compatibility (CRC, frame format)
- [ ] `npm run test:sync` — end-to-end file sync in VM
- [ ] `npm run test:boot` — boot/hydrate/snapshot cycle
- [ ] `npm run test:snapshot` — snapshot restore + data-plane reconnect
- [ ] Verify binary size ~200KB static (`ls -lh target/.../sync-agent`)
- [ ] Verify init script compatibility — runs with `-root /workspace -dev /dev/hvc0`
- [ ] Decide: remove Go source or keep as reference alongside Rust
- [ ] Update `AGENTS.md` — note Rust instead of Go for sync-agent
- [ ] Mark this document as completed

**Gate:** All tests pass, guest boots and syncs correctly.

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
| 2 | `sha2 = "0.10"`, `serde_json = "1"`, optional `walkdir = "2"` |
| 3 | `libc = "0.2"` |
| 4–5 | (none / `inotify = "0.10"` or raw libc) |
| 6–7 | (none) |

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

