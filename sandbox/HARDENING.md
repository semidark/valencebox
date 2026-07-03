# Sandbox hardening checklist (Phase 6)

Status of the isolation-relevant invariants. "Verified by" points at the
automated check or the code that enforces it.

## Isolation

- [x] **No live host filesystem mount in the guest.** The guest root and
      `/workspace` are ext4 *disk images* (`hda`/`hdb`), not 9p/virtfs host
      mounts. Files cross the boundary only as bytes over the framed
      virtio-console protocol. Verified: `test/boot.test.ts` asserts
      `/workspace` is `/dev/{sd,hd,vd}b … type ext4`; there is no `-fs`/9p
      device in `vm.ts`.
- [x] **Guest cannot read arbitrary host paths.** `safeJoin` (host
      `manifest.ts`, guest `manifest.go`) rejects absolute paths and `..`
      escapes on every FILE_PUT/FILE_DEL. Sync is confined to `hostDir`.
- [x] **Renderer is sandboxed from Node.** `contextIsolation: true`,
      `nodeIntegration: false`; the renderer touches the system only through
      the typed `window.sandbox` preload surface (`preload.ts`).

## Egress

- [x] **Single egress path.** The only network device is the virtio NIC
      wired to the in-process WISP relay (`wisp.ts`). No TAP, no host routing,
      no root. With `enableNetwork:false` there is no NIC at all.
- [x] **Allowlist enforced.** Two coupled layers (`doh.ts` + `wisp.ts`):
      DNS resolves only allowlisted hostnames (else NXDOMAIN); the WISP
      server only opens streams to IPs the gate pinned, on allowlisted ports;
      `allow_private_ips`/`allow_loopback_ips` off, so the guest cannot reach
      the host LAN or localhost. Verified: `test/net.test.ts` (allowed host
      fetches real data; `example.com` blocked; `apk update` works).
- [ ] **Residual: IP-pinning granularity.** A CDN IP pinned for an allowed
      host also permits other hostnames sharing that IP. Acceptable for a
      registry allowlist; document per-deployment. UDP is off by default so
      DNS is the only UDP and it is host-mediated.

## Persistence & durability

- [x] **Canonical store is the host directory**, not VM disk internals. A
      lost/corrupt snapshot only costs warm-boot time. Verified:
      `test/e2e.test.ts` mutates the host dir while the VM is down and the
      restored guest reconciles.
- [x] **Snapshots are crash-safe.** Written to `*.tmp` then atomically
      renamed (`snapshot.ts`); a torn write can't replace a good snapshot.
- [x] **Snapshot cadence is idle/interval-gated**, never per-edit
      (`SnapshotManager.start`: default ≥5 min apart, only after ≥10 s idle).

## Resource sizing

- [x] **RAM chosen deliberately: 512 MB.** Snapshot ≈ 89 MB raw → ~33 MB
      zstd. Larger RAM ⇒ proportionally larger/slower snapshots; async+chunked
      disks keep their delta small so RAM dominates snapshot size.
- [x] **Bounded buffers.** Serial log capped (`vm.ts`); host→guest TX paced to
      the guest's RX ring with a stall backoff; pinned-IP set capped at 512.

## Known gaps / follow-ups

- Guest runs as root; add a non-root build user + drop caps for defence in
  depth (agent builds already confined to `/workspace`).
- WISP allowlist is hostname/port only; no request-content inspection.
- No per-file encryption of snapshots at rest.
- Single virtio-console port multiplexes control + data; spec's 4-port split
  (port 0 data / port 1 RPC) is a latency optimization not yet needed.
