# Network Containment — Strict Egress via virtio-serial Tunnel

Status: plan, not implemented. This document records the Phase 1 architecture
for mandatory, fail-closed guest egress and the milestones that gate rollout.
Phase 2 (transparent proxying of non-proxy-aware clients) is out of scope here
and sketched at the end. Paths are relative to `sandbox/`.

## Problem

Today the VM runs QEMU with an unrestricted SLIRP user network
(`-netdev user,id=net0` plus a virtio NIC). Proxy environment variables steer
cooperating clients to the host-side `EgressProxy`, but any guest process can
ignore them and egress directly through SLIRP. There is no enforced boundary:
**the current design cannot guarantee that guest traffic passes host policy.**

## Non-negotiable requirements

1. A path around the egress proxy is absolutely unacceptable. Strict mode is
   fail-closed: no NIC, no direct egress, UDP and ICMP unsupported.
2. Only egress that `EgressProxy` can apply policy to exists: HTTP(S) via the
   proxy (CONNECT and plain-HTTP forwarding), with allowlist/denylist host
   policy, port policy, rate limits and MITM secret injection unchanged.
3. UDP port forwards are rejected (fail-closed), not silently dropped.
4. Legacy SLIRP mode remains available as an explicit opt-out while the new
   path is proven; once proven, **strict is the default and SLIRP is opt-in.**

## Architecture (Phase 1)

```
guest                                  host (Electron main)
------                                 --------------------
tools → HTTP(S)_PROXY=127.0.0.1:P ─┐
davfs2 → 127.0.0.1:S ─────────────┤    ┌─ EgressProxy (policy, MITM)
                                   ├─→  mux-channel ─┤
mux daemon bridges guest loopback ─┘    │  injects Duplex streams via
to virtio-serial port "mux"             │  server.emit("connection", shim)
                                         └─ HttpShare (WebDAV)
host → 127.0.0.1:2222 (SSH debug) ─────── OPEN fwd:22 → guest loopback
```

- QEMU launches with `-nic none`. The only guest↔host data path is a
  virtio-serial port (`-chardev socket,id=mux` + `-device virtserialport,
  name=mux`), framed and multiplexed by both sides.
- A guest Rust daemon (`valencebox-mux`) listens on guest loopback ports and
  bridges each accepted TCP connection to one multiplexed stream.
- The host demultiplexer (`src/main/mux-channel.ts`) injects each stream
  directly into the in-process servers — the same pattern the MITM server
  already uses (`egress-proxy.ts` feeds `mitmServer.emit("connection", …)`).
  Proxy and share token authentication are unchanged; the guest keeps
  speaking the proxy dialect (CONNECT + `Proxy-Authorization`).

### What works in strict mode

| Traffic | Support |
|---|---|
| TCP via HTTP proxy (apt, npm, pip, curl, git over HTTPS) | Yes, policy-enforced |
| Other TCP (git over SSH, databases) via HTTP CONNECT | Yes, host:port policy applies |
| DNS | Resolved host-side by the proxy; no in-guest DNS |
| UDP (QUIC/HTTP3, NTP, WireGuard) | **No.** HTTP/3 clients fall back to TCP |
| ICMP (ping, traceroute) | **No.** |
| TCP port forwards (SSH debug) | Yes, host-initiated over the tunnel |
| UDP port forwards | **Rejected at config load (fail-closed)** |
| Non-proxy-aware clients | Fail until Phase 2 transparent proxy |

### Security notes

- The tunnel is private to the QEMU host process ↔ guest, so third parties
  cannot reach it. It is **not** a guest-compartment boundary: a compromised
  root guest can open arbitrary streams into the proxy either way. Hostname
  and port policy at `EgressProxy` is the actual boundary.
- In strict mode the proxy listener binds `127.0.0.1` (legacy mode keeps
  `0.0.0.0` for SLIRP reachability). Removing the TCP path also stops
  leaking the proxy token through guest `/proc/cmdline` in the long run;
  until then, delivery moves from kernel cmdline to the mux handshake.
- Proxy/share tokens remain in place as defense-in-depth; they were never
  secret from the root guest and are not a compartment boundary.

## Protocol (mux framing)

Extends the existing PtyChannel framing style (`[u32BE len][u8 type]` on
`/dev/virtio-ports/pty`) with a stream id:

- Header: `[u32BE len][u8 type][u32BE streamId]`
- Types: `HELLO, OPEN(target), OPEN_OK, OPEN_FAIL, DATA, FIN, RESET,
  CREDIT(u32)`.
- Targets: `proxy`, `share`, `fwd:<guestPort>`.
- Per-stream credit window (~256 KiB) with **batched** CREDIT grants.
- The guest daemon opens the port **non-blocking** and waits with `poll()`.
  Benchmark evidence: blocking reads on virtio-serial stall 1–2 s under load
  and occasionally desync the frame stream; non-blocking + poll eliminates
  both (15/15 clean runs).
- `HELLO` on daemon (re)start resets host stream state; a `PING/PONG`
  liveness pair lets the host detect daemon death.
- The QEMU chardev socket is single-connection with `server=on,wait=off`;
  the host owns it with `0600` and must refuse a second connection.

## Benchmarks (KVM, Linux x86-64, 2 vCPU microvm, load-3 host)

Guest Rust benchmark client vs. today's direct SLIRP TCP to `10.0.2.2`:

| Test | virtio-serial mux | SLIRP TCP |
|---|---|---|
| Stream open p50 / p99 | 0.10–0.16 ms / ~1 ms | 0.51 ms / 2 ms |
| Download 128 MiB | 190–230 MB/s | 185–245 MB/s |
| Upload 128 MiB | 1,700–1,900 MB/s | 85–97 MB/s |
| 50 × 4 MiB concurrent | ~240 MB/s aggregate, even | ~400 MB/s, uneven |
| 2,000 × 64 KiB, conc 16 (npm-like) | ~3,500 req/s, p99 6–21 ms | ~1,650 req/s, p99 16–18 ms |
| 3,000 × 4 KiB, conc 50 (metadata-like) | ~22,000 req/s, p99 3–11 ms | ~3,500 req/s, p99 28 ms |

`npm install` patterns (many small/medium concurrent requests, well under
50 MB/s aggregate) are 2–6× faster over the tunnel than over SLIRP. The only
regression is ~40% lower aggregate throughput at high stream concurrency
(~240 MB/s), far above real-world package-install demand. macOS (HVF),
Windows and TCG are unmeasured; TCG coverage is required by the M3 gate.

## Configuration

```jsonc
{
  "egress": {
    "enforce": true,             // default flips to true at M3; false = legacy SLIRP
    "upstreamProxy": "http://user:pass@proxy.corp.example:8080",  // optional
    // … existing policy knobs unchanged …
  },
  "portForwards": [
    { "hostPort": 2222, "guestPort": 22, "label": "SSH debug access" }
  ]
}
```

- `egress.enforce?: boolean` — strict mode. Default `true` once the M3 gate
  passes; before that the shipped default is `false`. `false` selects the
  legacy SLIRP path unchanged.
- `egress.upstreamProxy?: string` — **host-side** proxy chaining for
  corporate networks. All `EgressProxy` outbound connections (CONNECT
  tunnels, plain-HTTP forwarding, MITM re-encryption) dial through the
  upstream via CONNECT. Host policy and port policy still apply **before**
  chaining; MITM secret injection still works because TLS still terminates
  at `EgressProxy`. This replaces the interim guest-side `upstreamProxy`
  fw_cfg workaround (reverted at M2).
- Validation is fail-closed: `enforce: true` with any `protocol: "udp"`
  port forward is a config-load error and the VM refuses to start with a
  clear message. (Validation runs on the loaded config; it does not rely on
  the silent `JSON.parse` → `{}` fallback for correctness.)
- Platform gating follows the standing decision: strict requested but the
  tunnel path unverified on a platform (macOS HVF, Windows) → warning +
  SLIRP fallback, never a silent strict boot.

## Milestones

| # | Deliverable | Gate |
|---|---|---|
| M1 | Protocol spec (`docs/mux-protocol.md`); config knobs and UDP fail-closed validation; strict QEMU args (`-nic none`, mux chardev + virtserialport; Unix socket on Linux/macOS, loopback TCP on Windows — named pipes have a chardev read bug); golden-args strict cases per machine type, including aarch64 `virt` (which skips `-nodefaults`, making `-nic none` mandatory) | `test:unit` |
| M2 | `src/main/mux-channel.ts` (demux, per-stream Duplex shim with synthetic `remoteAddress = "mux:<id>"` so rate-limit buckets don't collapse to `"?"`, batched CREDIT flow control, HELLO reset, PING/PONG liveness); stream injection into proxy and share servers; `EgressProxy` upstream chaining; revert the interim fw_cfg `upstreamProxy` diff | `test:egress` + new mux/chaining unit tests against a mock upstream proxy |
| M3 | Rust guest daemon (`guest-mux/`, static musl via `rust:alpine` buildx stage, non-blocking + poll); `valencebox-mux.service` (`Restart=always`); `mount-share.sh` re-pointed from `10.0.2.2` to guest loopback; drop `network-online.target` dependency; image mode detection via `/dev/virtio-ports/mux` presence; **default flips to `enforce: true`** | New strict `test:boot` variant: no `eth0`, mux service active, WebDAV-over-tunnel sync active, curl via relay — passing on KVM **and** TCG |
| M4 | TCP portForwards over the mux (host listener → `OPEN fwd:<port>` → guest dials loopback); strict proxy binds `127.0.0.1`; docs (AGENTS.md, qemu.md, HARDENING.md); benchmark rerun for the record | Full suite, both modes |

## Test plan

- **golden-args (M1):** strict cases per machine type — `-nic none`, no
  `-netdev`/`virtio-net`, mux chardev present; legacy cases retained.
- **mux-channel unit (M2):** framing, demux, flow control, HELLO reset,
  PING timeout, abort/reset.
- **Chaining unit (M2):** CONNECT-through-upstream, upstream auth,
  policy-before-chain ordering.
- **Boot strict variant (M3):** asserts no `eth0`, mux service active,
  workspace-sync active over the tunnel, curl through the relay. Keeps the
  non-blocking-read regression check (blocking reads caused 1–2 s stalls
  and frame desyncs in benchmarks).
- **Legacy suites unchanged.** SLIRP mode stays fully tested while it exists.

## Out of scope / follow-ups

- **Phase 2 transparent proxy:** fake-DNS + `iptables REDIRECT` in the guest
  so non-proxy-aware clients work without per-tool setup (Clash/sing-box
  technique). The M3 daemon architecture leaves room for a second listen
  path. Real UDP egress would need a datagram path in `EgressProxy` and is
  explicitly rejected for now.
- macOS HVF, Windows and TCG performance measurement beyond the M3
  functional gate.
- Migrating token delivery off the kernel cmdline (guest `/proc/cmdline` is
  world-readable) — the mux handshake is the natural carrier.
