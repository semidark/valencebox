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
      `manifest.ts`, guest `manifest.rs`) rejects absolute paths and `..`
      escapes on every FILE_PUT/FILE_DEL. Sync is confined to `hostDir`.
- [x] **Renderer is sandboxed from Node.** `contextIsolation: true`,
      `nodeIntegration: false`; the renderer touches the system only through
      the typed `window.sandbox` preload surface (`preload.ts`).

## Egress

- [x] **Single egress path through host-process proxy.** The only network
      device is the SLIRP NIC (`-nic user`). All outbound HTTP(S) traffic
      from the guest must go through the `EgressProxy` running in the Electron
      main process (`egress-proxy.ts`). No TAP, no host routing, no root.
- [x] **Allowlist/denylist enforced.** The proxy checks every CONNECT
      request against a configurable allowlist or denylist of host patterns
      (supports `*.example.com` wildcards). Deny rules take priority over
      allow rules. Verified: `test/egress-proxy.unit.ts` (hostAllowed tests
      for allowlist, denylist, none policy, wildcards, case insensitivity,
      deny priority, trailing dots, port stripping).
- [x] **Proxy authentication required.** The guest must present a bearer
      token in the `Proxy-Authorization` header. The token is a
      cryptographically random hex string generated per-session and passed
      to the guest via kernel cmdline (`valencebox.proxy_token=`). Constant-
      time comparison prevents timing attacks.
- [x] **Open egress when unconfigured.** If the `sandbox.config.json` lacks
      an `egress` section or policy is `"none"`, the proxy still starts but
      allows all traffic (same behaviour as today's unconstrained SLIRP).
- [x] **WebDAV sync traffic bypasses the proxy.** The guest sets
      `no_proxy=127.0.0.1,localhost,10.0.2.2` so the WebDAV share server
      (listening on the SLIRP gateway) is never proxied. Verified: the share
      server and proxy are independent `http.Server` instances; the guest
      sees `10.0.2.2:<share_port>` in `no_proxy`.
- [x] **Port forwards bind to 127.0.0.1 by default.** QEMU hostfwd rules in
      `portForwards` default to `hostIp: "127.0.0.1"` unless the user
      explicitly overrides it. This prevents accidental exposure of guest
      services to the network.
- [x] **Proxy connection + rate limits.** `maxConnections` (default 256) caps
      concurrent TCP connections; over-limit connections are rejected with 503.
      `rateLimitPerMin` (default 0 = off) caps requests/CONNECTs per client IP
      per minute; over-limit returns 429. This contains resource exhaustion from
      a compromised guest. Verified: `test/egress-proxy.integration.ts`
      (max-connection 503, rate-limit 429).
- [x] **Response header sanitization.** `Strict-Transport-Security`,
      `Public-Key-Pins`, `Public-Key-Pins-Report-Only`, and `Expect-CT` are
      stripped from upstream responses (plain-HTTP forward + MITM paths) so they
      cannot pin the guest against the proxy's MITM leaf. Verified:
      `test/egress-proxy.unit.ts` (`sanitizeResponseHeaders`).
- [x] **MITM TLS interception (optional).** When `egress.enableMitm` is
      `true`, the proxy terminates TLS for declared secret hosts, replaces
      placeholder strings with real credentials, and re-encrypts to the
      upstream. The guest must trust the proxy's ephemeral CA (installed via
      `update-ca-certificates` in the guest image). MITM is off by default.
      Verified: `test/egress-proxy.unit.ts` (placeholder replacement in
      headers and body; unauthorized host blocking) and
      `test/egress-proxy.integration.ts` (end-to-end injection).
- [x] **Pure-Node certificate generation (no `openssl`).** The MITM CA and leaf
      certs are generated with `selfsigned` (→ `@peculiar/x509`), removing the
      host `openssl` subprocess dependency (and its env-var injection surface).
      Leaf certs carry a DNS SAN for hostnames and an IP SAN for IP literals.
      Verified: `test/egress-proxy.integration.ts` (CA:TRUE, leaf SAN, chain
      verification).
- [x] **Custom upstream CA (optional).** `egress.caCertFile` supplies a PEM
      bundle used to verify upstream TLS servers in addition to the system
      trust store, so internal/self-signed upstreams verify without disabling
      `rejectUnauthorized`. Verified: `test/egress-proxy.integration.ts`
      (strict verification against a custom CA).
- [ ] **Secret placeholders protect credentials.** Real secrets (API keys,
      tokens) are never exposed to the guest. The host generates
      cryptographically random placeholders (`psbx-sec-<hex>`) that the
      guest sees in its environment variables. The proxy replaces them with
      real values during MITM interception. A placeholder used on a
      non-declared host results in a 403 Forbidden. Verified:
      `test/egress-proxy.unit.ts` (PlaceholderViolation thrown for
      unauthorized host).

## Known gaps / follow-ups

- Guest runs as root; add a non-root build user + drop caps for defence in
  depth (agent builds already confined to `/workspace`).
- No per-file encryption of snapshots at rest.
- HTTP proxy does not filter request content (headers or body), only
  hostname+port. For plain HTTP forward (non-CONNECT), the proxy forwards
  GET/POST/etc. requests; MITM interception applies only to CONNECT on
  declared secret hosts.

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
- Data-plane transfers skip the guest's sha256 read-back verify (frame CRC32
  + TCP checksums still apply); the console path keeps full verification.
