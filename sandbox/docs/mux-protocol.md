# Mux Protocol (virtio-serial tunnel framing)

Status: implemented. This is the wire protocol spoken between the guest
`valencebox-mux` daemon (`guest/guest-mux/`) and the host `MuxChannel`
(`src/main/mux-channel.ts`) over the single virtio-serial port named `mux`
(`-device virtserialport,chardev=mux,name=mux` in strict network mode).

## Transport

One byte stream: the virtio-serial port, exposed to the host as a chardev
socket (Unix socket on Linux/macOS, loopback TCP on Windows — named pipes
have a chardev read bug in the bundled QEMU build). Single connection; the
host side is the client (`server=on,wait=off`), the socket is chmod 0600.

**The guest MUST open the port non-blocking and wait with `poll()`.**
Blocking reads on virtio-serial stall for 1–2 s under load and can desync the
frame stream (see the benchmark section of docs/NET-CONTAINMENT.md).

## Frames

```
+--------------+--------+--------------+---------+
| u32BE length | u8 type| u32BE stream | payload |
+--------------+--------+--------------+---------+
```

`length` is the payload length in bytes (0 for control frames). Frames are
packed back-to-back with no padding. A receiver that sees `length` above
`MAX_FRAME_PAYLOAD` (256 KiB) or garbage framing MUST drop the connection —
the stream is unrecoverable.

| Type | Value | Payload | Direction |
|---|---|---|---|
| HELLO | 1 | version string (currently `1`) | guest → host, on every daemon start |
| OPEN | 2 | target string (UTF-8) | either |
| OPEN_OK | 3 | empty | receiver → opener |
| OPEN_FAIL | 4 | reason (UTF-8) | receiver → opener |
| DATA | 5 | raw bytes | either |
| FIN | 6 | empty | either (half-close of sender's write side) |
| RESET | 7 | empty | either (abort the stream) |
| CREDIT | 8 | u32BE grant | either |
| PING | 9 | empty | host → guest |
| PONG | 10 | empty | guest → host |

## Stream lifecycle

- Either side opens: `OPEN` with a target string. The receiver replies
  `OPEN_OK` once it accepted the stream (handler registered), or
  `OPEN_FAIL` (reason) if it refuses — e.g. unknown target, dial failure.
- Data flows as `DATA` frames (≤ 64 KiB payload per frame in practice).
- `FIN` half-closes the sender's write side; the peer's write side stays
  usable. A peer that received FIN and finishes sending closes its side
  with FIN too; the stream is then complete and both sides release it
  without RESET.
- `RESET` aborts the stream immediately (dial failure, application error,
  consumer abort). A side that received RESET must not echo RESET.
- Frame order on the wire is the delivery order for all streams (single
  FIFO byte stream); interleaving across streams is arbitrary.

### Targets

| Target | Meaning | Opener |
|---|---|---|
| `proxy` | Host `EgressProxy` (HTTP CONNECT / forward proxy) | guest |
| `share` | Host WebDAV share (workspace sync) | guest |
| `fwd:<guestPort>` | Guest loopback service (e.g. `fwd:22` → sshd) | host |

Host-side injection: an accepted `proxy` stream is handed to
`EgressProxy.injectConnection()`, a `share` stream to
`HttpShare.injectConnection()` — both feed the stream to their in-process
HTTP server via `server.emit("connection", stream)`. Guest-side: the daemon
dials `127.0.0.1:<port>` for `fwd:` targets.

## Flow control

Per-stream credit window of `MUX_WINDOW = 256 KiB`. A sender may have at
most `MUX_WINDOW` uncredited bytes in flight per stream. The receiver grants
credit back (`CREDIT u32BE`) in batches of at least `MUX_CREDIT_BATCH =
64 KiB`, and only for bytes its **consumer** has actually drained — a stalled
consumer (e.g. a slow HTTP body) holds credit, which blocks the peer, which
exerts backpressure on the original TCP client. Batching keeps the per-frame
credit round-trip cost negligible (benchmarks: ~0.1 ms per 64 KiB round trip).

Initial credit is implicit: both sides start every stream with a full
`MUX_WINDOW` of send credit (no handshake frame needed).

## Stream ids

Ids are unique per direction and never collide: the host allocates odd ids
(1, 3, 5 …), the guest allocates even ids (2, 4, 6 …), each incrementing by
2. Id 0 is used for PING/PONG.

## Liveness and restart

- The guest daemon sends `HELLO` immediately after opening the port, and
  again on every restart. A host that sees a **second** HELLO destroys all
  its streams for that port (the peer lost their state) and considers the
  channel fresh.
- The host role pings every 10 s (`PING`) and requires a `PONG` within 30 s.
  On timeout it drops the chardev connection and all streams. The guest
  replies to PING with PONG; the guest itself detects host death via write
  failures on the port (exit → systemd restarts it).
- Before the first HELLO the host must not send OPEN frames (they would be
  silently dropped by QEMU while the guest port is closed). Host `openStream`
  callers block until the channel is ready (up to a generous timeout — guest
  boot under TCG is slow).

## Authentication

The tunnel is private to the QEMU host process ↔ guest, so there is no
transport-level authentication. Application-level auth is unchanged: the
guest keeps speaking the proxy dialect (CONNECT + `Proxy-Authorization`
with the per-session token) to `EgressProxy`, and HTTP Basic (valence +
token) to the WebDAV share. The tokens are not a guest-compartment boundary
(a root guest can open arbitrary streams either way) — host policy
(allowlist/denylist/ports) at EgressProxy is the actual boundary.
