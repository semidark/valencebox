# Sandbox hardening — current implementation notes

These notes describe isolation-relevant behavior in the current QEMU source and
assertions present in current tests. They are **not a security audit**, a proof of
confinement, or a claim that all hardening work is complete. Source and test files
were inspected for this docs-only update. `test:unit`, `test:share`, and
`test:egress` passed, as did `tsc --noEmit -p .`. No integration tests, builds,
UI tests, or VM boots were run. Passing those suites does not validate the
uncovered guarantees discussed below. Paths are relative to `sandbox/`.

## Filesystem boundary and renderer

- **No QEMU filesystem passthrough, but there is a guest WebDAV mount.**
  `src/main/qemu.ts` attaches root and workspace qcow2 images through virtio-blk;
  it does not configure 9p/virtfs or another host-directory passthrough device.
  `guest/usr/local/libexec/mount-share.sh` formats `/dev/vdb` as ext4 only when
  `blkid` finds no filesystem, then mounts it at `/workspace`.
  `guest/usr/local/libexec/workspace-sync.sh` separately mounts the host HTTP
  WebDAV share with davfs at `/host-workspace`, and unison mirrors it into the
  native `/workspace` working tree. Thus “no filesystem passthrough” does not
  mean “no live network filesystem mount” or “no host-file access.”
- **Host share root and traversal test scope.** `src/main/http-share.ts` passes
  `workspaceDir` as the Nephele `FileSystemAdapter` root, binds the plain-HTTP
  server to `127.0.0.1`, and uses Basic authentication with username `valence`
  and a random per-instance token. The guest reaches it at `10.0.2.2` through
  SLIRP. `test/share.test.ts` contains auth and WebDAV CRUD assertions, raw
  traversal PUT/GET error assertions, and checks that selected encoded PUT
  paths do not create the specified files/directories outside the share root.
  Encoded paths are not all required to return errors. These are selected path
  traversal cases, **not proof of symlink confinement** or arbitrary-host-path
  isolation; the test does not exercise symlinks or filesystem races. The share
  wrapper delegates filesystem handling to the adapter rather than implementing
  a separate realpath/symlink confinement check.
- **Boot assertions are narrower than sync verification.** `test/boot.test.ts`
  asserts `/workspace` is `/dev/vdb` ext4, root login, and service active states.
  It does not start a host share or verify a WebDAV/unison round-trip, disconnect
  recovery, or persistence after a crash. It was not run for this update.
- **Renderer Node isolation is configured; Electron's renderer sandbox is not.**
  `src/main/main.ts` sets `contextIsolation: true` and `nodeIntegration: false`,
  but explicitly sets `sandbox: false` for the preload. `src/main/preload.ts`
  exposes the typed `window.sandbox` IPC surface (terminal, status, clipboard,
  balloon, and snapshot calls). This is not a claim of Chromium OS-level
  renderer sandboxing or a review of the IPC boundary.
- **Guest sessions run as root.** `guest/Dockerfile` configures root serial
  auto-login and root SSH key access; `guest/etc/systemd/system/pty-daemon.service`
  uses `User=root`. A non-root build user and capability reduction remain
  follow-ups, not implemented confinement to `/workspace`.

## Network and proxy policy

- **Proxy use is configured, not mandatory egress enforcement.**
  `src/main/qemu.ts` creates an unrestricted `-netdev user,id=net0` SLIRP
  backend with a virtio NIC; it does not set `restrict=on` or install a firewall
  forcing traffic through the proxy. `mount-share.sh` sets HTTP(S) proxy
  environment variables for cooperating clients. They do not constrain clients
  that ignore them or other protocols. The proxy's policy applies to requests
  that reach it; this is not evidence that all guest egress is mediated.
- **WebDAV is separate from the egress proxy.** `NO_PROXY`/`no_proxy` includes
  `127.0.0.1,localhost,10.0.2.2,::1`. The share and proxy are separate HTTP
  servers. This configures proxy bypass for cooperating clients accessing the
  share, not a network enforcement rule. The application proxy defaults to
  `0.0.0.0` (`egress.listenHost` can override it), unlike the loopback share.
- **Basic proxy authentication, not bearer authentication.** `main.ts` generates
  a per-start token using `generatePlaceholder()` (`psbx-sec-` plus 12 random
  bytes as hex). `qemu.ts` delivers proxy port/token and `ENV=placeholder`
  mappings via kernel cmdline. `EgressProxy.authenticate()` accepts
  `Proxy-Authorization: Basic <base64(username:token)>`, compares the password
  token, and does not validate the username. Missing/bad credentials produce
  407 when a token is configured; an empty runtime token disables auth. The
  helper uses `timingSafeEqual` for equal-length tokens; this is not a verified
  timing-attack-resistance claim. Integration assertions cover valid, missing,
  and wrong tokens, not a timing analysis.
- **Host and port checks are separate.** `hostAllowed()` implements normalized
  target-host matching, exact/wildcard patterns, and deny priority under
  allowlist/denylist policies. Policy `"none"` returns true before consulting
  either host list; `allowAll: true` bypasses host filtering in both outer
  request handlers. **Neither bypasses `allowPorts`**, authentication, or the
  applicable limits. CONNECT and forward handlers reject ports outside a
  nonempty `allowPorts`; an empty array disables port filtering. `main.ts`
  defaults to policy `"none"`, `allowAll: false`, and ports `[80, 443]` even
  when `egress` is absent. That default is open host policy at the proxy, not
  unrestricted proxy ports and not a SLIRP restriction.
  `test/egress-proxy.unit.ts` contains host-policy/normalization assertions;
  integration tests contain CONNECT host allow/deny assertions. Port enforcement
  and bypass semantics above are source observations, not a claim of dedicated
  test coverage for all combinations.
- **Host forwards default to loopback.** `qemu.ts` defaults each `hostIp` to
  `127.0.0.1`; explicit overrides can expose the listener on another interface.
  `main.ts` defaults to SSH host port 2222 → guest port 22; `portForwards: []`
  disables forwards. `test/golden-args.unit.ts` asserts loopback, custom IP,
  TCP/UDP, multiple, and empty forward argument cases without booting a VM.
- **Limits exist, with a connection accounting gap.** `main.ts` defaults
  `maxConnections` to 256 and `rateLimitPerMin` to 0 (off).
  `EgressProxy.trackConnection()` increments the count and rejects over-limit
  sockets with a 503 write/destroy, but returns **before registering the close
  decrement** on those rejected sockets. The counter therefore retains those
  increments; this is a source-level accounting gap, not a tested exhaustion
  exploit. `testMaxConnectionLimit` asserts one over-limit 503, not subsequent
  count recovery. Per-client-IP rate buckets count outer requests/CONNECTs
  and return 429 above the configured limit; the MITM inner request handler
  does not apply that check per inner request. `testRateLimit` asserts a third
  outer HTTP request is limited when the limit is two.

## MITM and credentials

- **Optional CONNECT interception uses a persistent CA.** With
  `enableMitm: true`, CONNECT to a declared secret host is TLS-terminated;
  other CONNECT traffic is an opaque TCP tunnel. MITM defaults off.
  `ensureMitmCa()` generates/reuses cert and key under application
  `userData/mitm-ca/`, not an ephemeral per-session CA. New cert/key files use
  modes 0644/0600; existence of both files selects reuse. Leaf certificates
  are cached under `mitm-ca/certs/` by normalized-host hash. Runtime generation
  uses `selfsigned` / `@peculiar/x509`, not a host `openssl` subprocess.
  Integration assertions cover leaf SANs, signature verification, and leaf
  cache path reuse; the fixture helper still invokes `openssl` for its upstream.
- **Guest CA delivery and trust are setup behavior, not a tested guest guarantee.**
  QEMU entry `opt/org.valencebox.mitm-ca` is read at
  `/sys/firmware/qemu_fw_cfg/by_name/opt/org.valencebox.mitm-ca/raw`.
  `mount-share.sh` installs it as
  `/usr/local/share/ca-certificates/valencebox-mitm.crt`, attempts
  `update-ca-certificates` (failure is tolerated), and configures
  `NODE_EXTRA_CA_CERTS`. Host-side integration tests disable verification on
  their client-to-proxy TLS sockets; they do not verify actual guest CA trust.
- **Placeholder replacement is not uniformly host-scoped.** `resolveSecrets()`
  validates env names and resolves `value` > `fromFile` > `fromEnv`; guest boot
  receives placeholders, not those resolved values. `rewriteHeaders()` checks
  each encountered placeholder against that secret's declared hosts and throws
  `PlaceholderViolation` on mismatch. **`rewriteBody()` takes no host argument**
  and replaces placeholders from the full secret list. Both MITM and plain-HTTP
  secret forwarding call it with all configured secrets once the target matches
  any secret host. Unit assertions cover header mismatch and body replacement,
  not cross-host body authorization. Opaque tunnels and ordinary forwards do
  not provide global placeholder scanning. Do not infer that every unauthorized
  placeholder use returns 403, or that real credentials can never reach a guest.
- **Plain HTTP can inject real secrets, even with MITM disabled.**
  `forwardRequest()` selects `forwardRequestWithSecrets()` for non-TLS requests
  to a declared secret host independently of `enableMitm`; that path forwards
  rewritten credentials via `http.request`, in plaintext to the upstream.
  Both rewriting paths buffer up to 10 MB. MITM rejects chunked bodies with
  411 and oversized bodies with 413; the plain-HTTP secret path uses 403 for
  those cases. These are implementation observations, not exploit tests.
- **Upstream TLS verification depends on the host environment.** MITM sets
  `rejectUnauthorized` to `process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0"`.
  Ordinary HTTPS forwarding uses Node's default behavior. A configured
  `caCertFile` is read by `main.ts` and appended to `tls.rootCertificates`
  for TLS forwarding/MITM, but does not override an environment disabling
  verification. `testCustomUpstreamCa` removes that environment variable for
  its strict-upstream success assertion; `testMitmSecretInjection` uses a
  self-signed upstream without a configured upstream CA. That fixture is not
  evidence of strict TLS verification in the default environment.
- **Response header sanitization has a defined scope.** HSTS, HPKP (including
  report-only), and Expect-CT are removed from forwarded HTTP/MITM responses.
  Unit assertions cover stripping and nonmutation. Opaque CONNECT tunnels
  cannot sanitize encrypted headers. This is not general content filtering.

## Persistence and resource sizing

- **Host-canonical is a sync preference, not a durability guarantee.** `main.ts`
  starts the host share and writes `.valence-sync-marker`. At sync-script
  startup, `workspace-sync.sh` checks mount usability, attempts stale-mount
  recovery, waits for that marker, clears `/root/.unison/*`, then execs unison
  with host preference and polling. The marker check is **startup-only**, not
  an ongoing check on every sync iteration. Archive clearing and
  `-prefer /host-workspace` express reconciliation behavior; they do not prove
  crash safety, prevention of deletion on later disconnects, or preservation
  of unsynced guest edits. The exclusions are `node_modules`, `.git`,
  `.DS_Store`, `lost+found`, and the marker. No current end-to-end durability
  test was found in `test/`.
- **Snapshots are unimplemented.** The renderer button calls preload
  `saveSnapshot`, but `main.ts` registers a no-op IPC handler. Current
  `VmManager` has no snapshot backend manager, save/restore, cadence, or atomic
  snapshot writer. Generic QMP command support is not an implemented snapshot
  lifecycle. Snapshot crash safety, encryption, size, and restore timings are
  not current guarantees.
- **Application RAM defaults to 4096 MB**, with 2 vCPUs (`main.ts`); the boot
  test fixture explicitly uses **512 MB** and 1 vCPU. Fixture sizing is not
  the app default. `VmManager` defaults the balloon floor to 2048 MB and keeps
  the serial log to the last 65536 characters; these are specific source
  bounds, not proof that all process buffers or resource usage are bounded.
