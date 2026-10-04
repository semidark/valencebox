# MITM Egress Proxy — Implementation Plan and Current Status

The original plan added a host-process HTTP CONNECT/forward proxy with
allowlist/denylist policy and optional TLS interception for secret injection.
It did **not** replace unrestricted SLIRP with a mandatory egress gate in the
current implementation. Guest proxy environment variables configure cooperating
HTTP(S) clients; they do not force all guest traffic through the proxy.

## Current status — implementation evidence and verification scope

This section describes current code and assertions present in tests, not a
security audit or a declaration that all audit findings are resolved. For this
docs-only update, `test:unit`, `test:share`, `test:egress`, and the no-emit
TypeScript check passed. **No integration tests, builds, UI tests or QEMU boots
were run.** Paths below are relative to `sandbox/`. The historical task record
is separate from current verification.

### Wiring and policy

- `src/main/main.ts` starts `EgressProxy` in Electron's main process, resolves
  secrets, generates a per-start auth token, and passes proxy config to
  `VmManager`/`QemuProcess`. `src/main/qemu.ts` emits unrestricted
  `-netdev user,id=net0` SLIRP plus a virtio NIC: no `restrict=on` or firewall
  enforcing proxy-only egress is configured.
- `guest/usr/local/libexec/mount-share.sh` writes HTTP(S) proxy environment
  variables with URL credentials `valencebox:<token>` and a `no_proxy` list
  including `127.0.0.1,localhost,10.0.2.2,::1`. The share server is separate from
  the egress proxy. `src/main/http-share.ts` serves the host directory as
  plain-HTTP WebDAV on loopback; `workspace-sync.sh` mounts it with davfs at
  `/host-workspace` and mirrors it with unison to native `/workspace`.
  This is a network mount, not QEMU filesystem passthrough.
- Proxy authentication is **Basic**, not bearer or HMAC authentication:
  `Proxy-Authorization: Basic <base64(username:token)>`. `authenticate()`
  compares the password token but does not check the username; an empty runtime
  token disables auth. The app generates a token with `generatePlaceholder()`
  (`psbx-sec-` plus 12 random bytes in hex). Proxy port/token and comma-separated
  `ENV=placeholder` mappings are on the kernel cmdline, not JSON or `fw_cfg`.
  Equal-length comparison uses `timingSafeEqual`; no timing analysis was run.
- CONNECT and outer HTTP handlers check host policy. Deny rules take priority
  in allowlist/denylist modes. Policy `"none"` ignores both host lists;
  `allowAll: true` bypasses host checks. **Neither disables `allowPorts`**,
  authentication, or applicable limits. A nonempty port list is enforced in
  CONNECT and forwarding; `[]` disables the port check. App defaults are
  policy `"none"`, ports `[80, 443]`, `allowAll: false`, and MITM off. Absent
  `egress` therefore means no host filtering, not all proxy ports allowed.
- The proxy defaults to listening on `0.0.0.0` (configurable `listenHost`), while
  WebDAV binds to `127.0.0.1`. QEMU host forwards default to `127.0.0.1` unless
  explicitly overridden; the app defaults to SSH 2222 → 22, with `[]` disabling
  forwards. These listener choices are distinct from guest egress enforcement.

### MITM, secrets, and remaining implementation limitations

- MITM CONNECT interception occurs only with `enableMitm` and a target matching
  a declared secret host. Other CONNECT requests are opaque TCP tunnels.
  Runtime CA/leaf generation uses pure Node `selfsigned` / `@peculiar/x509`.
  The CA is **persistent**, stored under application `userData/mitm-ca/` and
  reused when both files exist. New key/cert files use modes 0600/0644. Leaf
  certs are cached under `mitm-ca/certs/` by normalized-host SHA256; runtime
  generation does not call `openssl`.
- QEMU names the CA `fw_cfg` entry **`opt/org.valencebox.mitm-ca`**. The guest
  reads **`/sys/firmware/qemu_fw_cfg/by_name/opt/org.valencebox.mitm-ca/raw`**,
  installs `/usr/local/share/ca-certificates/valencebox-mitm.crt`, attempts
  `update-ca-certificates` with tolerated failure, and configures
  `NODE_EXTRA_CA_CERTS`. The share config entry is `opt/org.valencebox.config`,
  read at `/sys/firmware/qemu_fw_cfg/by_name/opt/org.valencebox.config/raw`.
  Host-side integration tests do not verify actual guest CA installation/trust.
- `resolveSecrets()` validates env names and resolves sources in order
  `value` > `fromFile` > `fromEnv`. Guest setup receives placeholders rather
  than resolved values. **Header and body authorization differ:**
  `rewriteHeaders()` checks each encountered placeholder's declared hosts;
  `rewriteBody()` has no host argument and replaces from the entire secret
  list. MITM and plain-HTTP secret paths pass all secrets after matching any
  secret host. Header mismatch assertions do not prove host-scoped body
  authorization. Ordinary forwards/opaque tunnels do not scan all placeholder
  uses; there is no blanket “unauthorized placeholder always returns 403” or
  “real secrets can never reach the guest” guarantee.
- **Plaintext secret injection exists independently of MITM enablement.**
  Non-TLS forwards to secret hosts use `forwardRequestWithSecrets()` and send
  rewritten credentials upstream via `http.request`. Both secret paths buffer
  up to 10 MB. MITM returns 411 for chunked bodies and 413 for oversized bodies;
  plain-HTTP secret forwarding returns 403 for those cases.
- **TLS verification is environment-dependent.** MITM upstream requests set
  `rejectUnauthorized` from `NODE_TLS_REJECT_UNAUTHORIZED !== "0"`; ordinary
  HTTPS forwards use Node's defaults. `caCertFile` adds a PEM bundle to
  `tls.rootCertificates` but does not counter an environment disabling TLS
  verification. The strict custom-CA fixture temporarily removes the variable;
  client-to-proxy TLS in the integration fixtures uses
  `rejectUnauthorized: false`, so it is not a guest trust test.
- **Connection accounting has a rejection gap.** `trackConnection()` increments
  first, then writes 503/destroys over-limit sockets and returns before adding
  their close-decrement listener. Rejected increments remain in the count.
  The integration fixture asserts one 503, not recovery of the counter. This
  is a source observation, not an untested exploit claim. Defaults are 256
  connections and rate limiting off; configured per-client-IP rate checks
  return 429 for outer HTTP requests/CONNECTs, not each MITM inner request.
- Response sanitization strips HSTS, HPKP/report-only, and Expect-CT from
  HTTP/MITM responses, not opaque tunnels. Logs append to `userData/proxy.log`
  with truncation above 10 MB **at startup**, not continuous rotation.
  `getStats()` exposes connection and per-host byte counters; the counters are
  not a complete resource-accounting guarantee.

### Current tests and invocation scope

`package.json` currently defines these separate commands, to be invoked from
`sandbox/` (`test:egress` passed for this update; integration was **not run**):

```sh
npm run test:egress
npm run test:egress:integration
```

- `test:egress` runs only `test/egress-proxy.unit.ts`: host policy and
  normalization, secret resolution/env validation, header mismatch/replacement,
  body replacement, and response sanitization assertions. It does not run the
  integration suite or prove cross-host body authorization.
- `test:egress:integration` runs `test/egress-proxy.integration.ts`: leaf SAN,
  signature and cache assertions; Basic auth; CONNECT host policy; MITM
  header/body injection with Content-Length repair and a delayed response;
  one over-limit 503; outer-request rate limiting; strict custom upstream CA;
  and log sink assertions. The certificate fixture asserts CA subject and
  leaf signing behavior, not every CA property mentioned in its comments.
- The integration suite's upstream fixture helper still invokes host `openssl`.
  `testMitmSecretInjection` uses a self-signed upstream without a custom CA and
  inherits upstream verification behavior from the host environment. The old
  command prefix `NODE_TLS_REJECT_UNAUTHORIZED=0` disabled verification to
  accommodate that fixture; it is **not** a secure production setting or
  evidence of strict verification. The package command itself does not add
  this override; no clean-environment pass is claimed here. The separate
  custom-CA case explicitly removes the override for its upstream assertion.
- Guest-side CA trust, mandatory network mediation, cross-host body policy,
  and connection-count recovery are not established by these assertions.
  See [HARDENING.md](../HARDENING.md) for the filesystem/traversal test scope,
  `contextIsolation: true` / `nodeIntegration: false` / `sandbox: false`,
  startup-only sync marker and archive clearing/host preference (not durability
  guarantees), unimplemented snapshot backend/no-op IPC, and app RAM default
  4096 MB versus the boot fixture's 512 MB.

## Config shape (`sandbox.config.json`)

The current `SandboxAppConfig` supports an `egress` section. Use strict JSON:
comments or trailing commas cause `loadAppConfig()` to silently return empty
configuration and discard the intended policy. This example enables host
filtering without provisioning credentials:

```json
{
  "egress": {
    "policy": "allowlist",
    "allowHosts": ["pypi.org", "*.pythonhosted.org"],
    "denyHosts": [],
    "allowPorts": [80, 443],
    "allowAll": false,
    "enableMitm": false,
    "secrets": []
  }
}
```

Secret specs support `env`, one of `value` / `fromFile` / `fromEnv`, and `hosts`.
Review the credential limitations above before adding real values. Secret host
patterns do not automatically add entries to the global allowlist.

Additional current fields include `listenPort`, `listenHost`, `caCertFile`,
`maxConnections`, `rateLimitPerMin`, and secret `fromFile`. Config type comments
are not substitutes for the handler semantics described above.

## Historical implementation task record

The phase/task identifiers below preserve the original work breakdown.
Checkboxes record historical implementation tasks, **not tests run for this
update, audited guarantees, or proof that every original goal was met**.
Current source and limitations above take precedence over the original intent.

### Phase A — Basic CONNECT/forward proxy

Original goal: add a host HTTP proxy with configurable hostname policy and guest
setup, testable on the host without a QEMU boot. This did not establish forced
network mediation.

- [x] **A1. Create `src/main/egress-proxy.ts`.** Node HTTP server with CONNECT,
  plain forwarding, Basic token auth, and host matching; default listener
  `0.0.0.0`, reachable through the guest's SLIRP gateway.
- [x] **A2. Extend `src/config.ts`.** Add egress, secret specification/resolution,
  and runtime configuration types.
- [x] **A3. Wire into `src/main/main.ts`.** Resolve secrets, generate placeholders
  and auth token, start/stop the proxy, and pass config to `VmManager`.
- [x] **A4. Pass proxy config to QEMU.** Kernel cmdline carries proxy port/token
  and comma-separated `ENV=placeholder` mappings (not JSON).
- [x] **A5. Guest proxy configuration.** `mount-share.sh` writes profile scripts
  for HTTP(S) proxy variables, bypass list, and secret placeholders.
- [x] **A6. Update `docs/qemu.md`.** Historical architecture documentation task;
  current architecture and historical proposals are now separated there.
- [x] **A7. Update `HARDENING.md`.** Current notes now distinguish proxy policy
  from network enforcement and source observations from test assertions.
- [x] **A8. Add basic proxy tests.** Unit assertions are in
  `test/egress-proxy.unit.ts`; historical counts/pass reports are not current
  verification. Guest curl/policy and WebDAV smoke checks require a VM and
  were not performed for this update.

### Phase B — MITM interception and secret injection

Original goal: terminate TLS for declared secret hosts, replace placeholders,
then forward upstream over TLS. Current behavior also includes plain-HTTP
injection and the authorization limitations described above.

- [x] **B1. MITM CA generation/storage.** Generate when needed, then persist/reuse
  `userData/mitm-ca/mitm-ca-cert.pem` and `mitm-ca-key.pem`; not ephemeral.
- [x] **B2. Leaf generation/cache.** Pure-Node signing with DNS/IP SANs and
  normalized-host-hash disk cache. No snapshot sizing or performance claims.
- [x] **B3. MITM CONNECT handler.** Select secret-host interception, TLS-terminate,
  parse HTTP, rewrite, repair Content-Length, and forward HTTPS. Upstream
  verification remains environment-dependent; chunked MITM bodies get 411.
- [x] **B4. Placeholder validation helpers.** Header mismatch throws
  `PlaceholderViolation`; body replacement lacks per-secret host validation.
  This task does not establish universal unauthorized-placeholder rejection.
- [x] **B5. Add secret injection integration fixture.** Host-side header/body
  assertions exist; suite/environment scope is documented above, not a guest
  trust or clean-environment pass claim.
- [x] **B6. Guest CA setup.** Deliver via `opt/org.valencebox.mitm-ca` and read
  its guest sysfs `raw` file; install system CA and set `NODE_EXTRA_CA_CERTS`.
  Share config uses the separate `opt/org.valencebox.config` entry.

### Phase C — Operational polish

- [x] **C1. Timeouts/connection handling.** Main and inner HTTP server timeout
  configuration, upstream TCP connect timeout, and TCP keepalive exist. They
  do not establish complete connection pooling/resource protection.
- [x] **C2. Logging/observability.** Event log sink, startup truncation, per-host
  counters, and `VERBOSE`-gated DEBUG output exist.
- [x] **C3. Error handling.** TLS handshake timeout and error/close handlers,
  upstream 502 handling, and MITM mid-stream drop handling exist; no blanket
  robustness guarantee is made.
- [x] **C4. Unit suite.** Helper assertions in `test/egress-proxy.unit.ts`.
- [x] **C5. Integration suite.** Host-side proxy assertions in
  `test/egress-proxy.integration.ts`; not QEMU smoke verification.
- [x] **C6. Documentation.** Historical multi-document update task; current
  implementation notes are not a declaration that hardening is complete.

### Phase D — Historical post-review hardening tasks

This is a record of earlier hardening work, not a new audit or a declaration
that all HIGH/MEDIUM findings are resolved. The current body authorization,
plaintext injection, TLS environment, and connection accounting limitations
remain explicitly documented above. Obsolete source line numbers and prior
exploit/resolution claims are not carried forward as current evidence.

- [x] **D1. Remove configurable certificate subprocess selection.** Superseded
  by D7's runtime pure-Node generation; no host `OPENSSL` selector is used there.
- [x] **D2. Validate secret env names.** POSIX-style env-name regex in
  `resolveSecrets()`; unit assertions include invalid names.
- [x] **D3. Remove eval from guest secret parsing.** Profile generation uses
  `printf` and direct `export` for validated names/generated placeholders.
- [x] **D4. Forward URL port/protocol handling.** `forwardRequest()` parses URL
  port/path and chooses HTTP or HTTPS, rather than hardcoding port 443.
- [x] **D5. Enforce `allowPorts`.** Checks exist in CONNECT and forwarding;
  `none`/`allowAll` host bypass does not bypass them.
- [x] **D6. Normalize bare IPv6 hosts.** Helper preserves bare IPv6; unit
  assertions cover normalization, not full CONNECT IPv6 parsing/routing.
- [x] **D7. Pure-Node runtime certificates.** Async `ensureMitmCa()` and
  `ensureLeafCertificate()` use `selfsigned` / `@peculiar/x509`; the integration
  upstream fixture still uses `openssl`.
- [x] **D8. Connection/rate limits.** Rejection code and selected assertions exist;
  the rejected-socket count decrement gap remains, as noted above.
- [x] **D9. Custom upstream CA.** `caCertFile` supports `~` and extends Node root
  certificates; verification can still be disabled by the host environment.
- [x] **D10. Response sanitization.** Defined headers stripped in HTTP/MITM paths,
  with helper assertions; opaque CONNECT traffic is unaffected.
- [x] **D11. File-sourced secrets.** `fromFile` supports `~`, trims trailing
  whitespace, rejects empty/unreadable files, and takes priority over `fromEnv`
  but not inline `value`; unit assertions cover selected cases.
