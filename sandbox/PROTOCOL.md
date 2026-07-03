# Host↔Guest Sync Protocol v1

Transports (same framing on both):

- **Control channel** — virtio-console port. Guest: `/dev/hvc0`. Host: v86
  bus `virtio-console0-input-bytes` / `virtio-console0-output-bytes`.
  Carries HELLO/PING/MANIFEST/EVENT and serves as the transfer fallback.
- **Data channel** — a guest→host TCP stream over virtio-net, terminated
  in-process by the host's WISP relay (`data-plane.ts`). The host advertises
  `{ip, port, token}` in its HELLO / hello-ACK payload (`dataPlane` field);
  the guest dials it and must open with HELLO `{token}` or the stream is
  closed. Bulk FILE_PUT/FILE_CHUNK/FILE_DEL prefer this channel (~2-5x the
  console's throughput; per-file round trips are pipelined). Each transfer
  runs end-to-end on one channel; xfer-id ranges are disjoint per sender
  (console guest: 0+, data guest: 0x40000000+, host: 0x80000000+). On the
  data channel the host streams chunks immediately after FILE_PUT (TCP
  ordering makes the ready-ACK redundant) and the guest skips the sha256
  read-back verify (frame CRC32 + TCP checksums cover integrity). The guest
  keepalive-pings every 15 s and re-dials on 45 s silence, on drop, or on a
  changed advert (e.g. after snapshot restore).

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
| 2 | MANIFEST   | JSON `{files: {path: {hash,size,mode,mtimeMs}}}` | tree state of sender. Sent as **one or more frames** (a whole-project manifest exceeds the payload cap); receiver merges the parts. |
| 3 | FILE_PUT   | JSON `{xfer,path,size,mode,mtimeMs,hash}` | announces incoming file. Receiver opens temp file, replies ACK `{ack:seq,xfer}`. |
| 4 | FILE_CHUNK | binary `[u32le xfer][u64le offset][bytes]` | data. Cumulative ACK `{xfer,received}` every 16 chunks. When `offset+n == size`: receiver verifies sha256, atomically renames into place, sets mode+mtime, sends ACK `{ack:seq,xfer,done:true}` or NAK `{xfer,error}`. |
| 5 | FILE_DEL   | JSON `{path}` | delete file (or dir recursively). ACK. |
| 6 | ACK        | JSON `{ack: seq, …extra}` | |
| 7 | NAK        | JSON `{ack: seq, error}` | |
| 8 | EVENT      | JSON `{events:[{op:"mkdir"\|"conflict"\|"log", path, …}]}` | out-of-band notices. |
| 9 | PING       | empty | reply = ACK. |
| 10 | TREE_PUT  | JSON `{xfer,size,count}` | announces a batched small-file archive of `size` bytes / `count` entries. The body streams as FILE_CHUNK frames under the same `xfer` (sequential offsets; sender starts immediately — no ready-ACK). Archive entry: `[u32le header-len][JSON {path,size,mode,mtimeMs,hash}][raw bytes]`. Receiver unpacks streamingly, applies LWW per entry (losers are skipped, not NAKed), cumulative ACK every 16 chunks, final ACK `{ack,xfer,done:true,skipped:[paths]}`. Data-plane only; used by hydrate for files < 256 KiB. |

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
- Ignored paths (never synced, any depth): `node_modules`, `.git`,
  `.sync-tmp`, `lost+found`, `.DS_Store`. Both sides exclude them from
  manifests/watchers; the host additionally rejects incoming PUT/DEL on them.
