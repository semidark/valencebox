# Host↔Guest Sync Protocol v1

Transport: single virtio-console port. Guest: `/dev/hvc0`. Host: v86 bus
`virtio-console0-input-bytes` (host→guest) / `virtio-console0-output-bytes`
(guest→host). Byte stream; framed. Control/RPC and file data are multiplexed
over the one port via the frame type (this v86 build exposes one port).

## Frame

```
[4B magic "V86S"][u8 type][u32le seq][u32le len][payload…][u32le crc32]
```

- `seq`: per-sender monotonic counter starting at 1.
- `len`: payload byte length. Max 262144.
- `crc32`: IEEE CRC-32 over `type|seq|len|payload` bytes (exactly as on wire).
- On magic/crc mismatch: receiver hunts for next magic (resync) and sends
  NAK {ack:0, error:"bad frame"}.

## Types

| # | Type       | Payload | Semantics |
|---|-----------|---------|-----------|
| 1 | HELLO      | JSON `{version, role, root}` | sent on connect by both sides; reply = ACK. Host sends MANIFEST after guest HELLO is ACKed. |
| 2 | MANIFEST   | JSON `{files: {path: {hash,size,mode,mtimeMs}}}` | full tree state of sender. |
| 3 | FILE_PUT   | JSON `{xfer,path,size,mode,mtimeMs,hash}` | announces incoming file. Receiver opens temp file, replies ACK `{ack:seq,xfer}`. |
| 4 | FILE_CHUNK | binary `[u32le xfer][u64le offset][bytes]` | data. Cumulative ACK `{xfer,received}` every 16 chunks. When `offset+n == size`: receiver verifies sha256, atomically renames into place, sets mode+mtime, sends ACK `{ack:seq,xfer,done:true}` or NAK `{xfer,error}`. |
| 5 | FILE_DEL   | JSON `{path}` | delete file (or dir recursively). ACK. |
| 6 | ACK        | JSON `{ack: seq, …extra}` | |
| 7 | NAK        | JSON `{ack: seq, error}` | |
| 8 | EVENT      | JSON `{events:[{op:"mkdir"\|"conflict"\|"log", path, …}]}` | out-of-band notices. |
| 9 | PING       | empty | reply = ACK. |

## Rules

- Chunk size 48 KiB. Sender window: max 32 unACKed FILE_CHUNK frames.
- Paths are relative to the sync root, `/`-separated, no `..`, no leading `/`.
- Hash = sha256 hex of file content.
- Change detection loop-prevention: each side keeps `lastSync[path] = hash`;
  a local FS event whose file hash equals `lastSync[path]` is an echo of an
  applied remote write and is not pushed back.
- Conflict rule (last-writer-wins): if an incoming FILE_PUT targets a path
  whose local content differs from `lastSync[path]` (concurrent local edit),
  compare `mtimeMs`, newer wins; tie → lexicographically greater hash wins
  (deterministic). Loser is logged as EVENT op=conflict and to the host
  conflict log.
- Symlinks/special files: skipped, logged (EVENT op=log).
