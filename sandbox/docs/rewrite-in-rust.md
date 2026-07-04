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

## Implementation Order

1. `frame.rs` — Protocol framing (foundation, everything else depends on it)
2. `manifest.rs` + `state.rs` — Walk, hash, state management
3. `termios.rs` — Raw mode setup
4. `transfer.rs` — Send/receive, tree unpacker
5. `watcher.rs` — inotify + debounce
6. `dataplane.rs` — TCP client session
7. `main.rs` — Orchestration, session loop
8. Build integration + testing

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

