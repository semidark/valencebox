# MITM Egress Proxy — Implementation Plan

Replaces the current open SLIRP egress (`-nic user` with no filtering) with a
host-process HTTP CONNECT forward proxy that enforces an allowlist/denylist
policy, optionally performs TLS interception (MITM) for secret injection, and
integrates with the existing `sandbox.config.json` configuration.

## Architecture

```
Guest (Ubuntu 24.04)
  eth0 ── SLIRP (QEMU -nic user)
            │  HTTP_PROXY=http://valencebox:<token>@10.0.2.2:<port>/
            │  HTTPS_PROXY=http://valencebox:<token>@10.0.2.2:<port>/
            │  no_proxy=127.0.0.1,localhost,10.0.2.2,::1
            │
            ▼
EgressProxy (Node.js, Electron main process)
  ┌─ CONNECT <host>:<port>
  │   ├─ authenticate via Proxy-Authorization
  │   ├─ hostAllowed(host)? → deny / allow
  │   ├─ isSecretHost(host)? → MITM path (TLS terminate, replace placeholders, re-encrypt)
  │   └─ else → plain tunnel
  │
  └─ GET/POST/PUT/... <url>
      ├─ authenticate
      ├─ hostAllowed(host)? → deny / allow
      └─ forward request, return response
```

## Config shape (`sandbox.config.json`)

Extends the existing `SandboxAppConfig` with an `egress` section:

```jsonc
{
  "egress": {
    "policy": "allowlist",            // "allowlist" | "denylist" | "none"
    "allowHosts": ["pypi.org", "*.pythonhosted.org"],
    "denyHosts": [],
    "allowPorts": [80, 443],
    "allowAll": false,                // bypass all filtering (open egress)
    "enableMitm": false,              // true = enable TLS interception for secret hosts
    "secrets": [
      // Inline value (for automation):
      { "env": "MY_SECRET",    "value": "s3cr3t",           "hosts": ["service.example.com"] },
      // Read from host environment variable at startup (recommended):
      { "env": "GITHUB_TOKEN", "fromEnv": "GITHUB_TOKEN",   "hosts": ["api.github.com"] }
    ]
  }
}
```

When `egress` is absent or policy is `"none"`, the proxy still starts (for
consistency) but allows all traffic.

## Current state

- **Phase A is complete.** The host-process `EgressProxy` (`egress-proxy.ts`)
  runs in the Electron main process, enforces allowlist/denylist host policy,
  authenticates per-session tokens, and configures the guest environment via
  kernel cmdline + `fw_cfg`. Unit + integration tests pass (`npm run test:egress`).
- **Phase B is complete.** TLS interception (MITM) with leaf certificate generation,
  secret placeholder replacement in headers/body, chunked body rejection, guest CA
  trust via `fw_cfg`, and end-to-end integration test. Requires `openssl` on host;
  pure-Node fallback tracked in Phase C.
- **WebDAV share config** moved from kernel cmdline to `fw_cfg` (`opt/org.valencebox.config/raw`).
  MITM CA cert passed via `fw_cfg` (`opt/org.valencebox/mitm-ca-cert.pem`).
- **HARDENING.md** has been updated for the QEMU/proxy architecture.

## Phase A — Basic CONNECT proxy (no MITM)

Goal: a runnable HTTP CONNECT forward proxy that enforces an allowlist/denylist
on hostnames, replaces the WISP-based egress described in HARDENING.md.

**All Phase A tasks are pure TypeScript / shell / docs and can be done entirely
inside the valencebox sandbox without booting a QEMU VM.** The proxy class
(`egress-proxy.ts`) is a plain Node.js HTTP server testable with standard unit
tests; config changes are compile-time only; guest shell scripts are
self-contained; doc updates are prose.

### Tasks

- [x] **A1. Create `sandbox/src/main/egress-proxy.ts`**
  - `EgressProxy` class using Node `http` module
  - `CONNECT` handler: authenticate → `hostAllowed()` → tunnel
  - Plain HTTP forward handler (GET, POST, etc.)
  - Auth token verification (HMAC-compare)
  - Policy checking: `hostAllowed(host, policy, allowHosts, denyHosts)`
  - Listen on `0.0.0.0:<port>` (reachable from guest via SLIRP gateway `10.0.2.2`)

- [x] **A2. Extend `sandbox/src/config.ts`**
  - Add `EgressConfig` interface (policy, allowHosts, denyHosts, allowPorts, allowAll, enableMitm, secrets)
  - Add `SecretSpec` interface (env, value?, fromEnv?, hosts)
  - Extend `SandboxAppConfig` with `egress?: EgressConfig`

- [x] **A3. Wire proxy into `sandbox/src/main/main.ts`**
  - `loadAppConfig` already reads `sandbox.config.json` — extend to consume `egress` section
  - Resolve secret values (inline `value` or read from `process.env[fromEnv]`)
  - Generate random placeholders for each secret
  - Instantiate `EgressProxy`, call `proxy.start()`, pass the proxy port to VmManager
  - Shut down proxy in `before-quit`

- [x] **A4. Pass proxy config to QEMU guest**
  - Add `proxyPort` field to `QemuOptions` / `VmManagerOptions`
  - In `qemu.ts` `buildArgs`, emit `valencebox.proxy_port=<port>` in kernel cmdline
  - Also emit `valencebox.proxy_token=<token>` so the guest can authenticate
  - Emit `valencebox.secrets=<json>` with the placeholder→env mapping

- [x] **A5. Guest-side proxy configuration**
  - In `mount-share.sh`, parse `valencebox.proxy_port=` and `valencebox.secrets=` from `/proc/cmdline`
  - Write `/etc/profile.d/valencebox-proxy.sh` with `HTTP_PROXY`, `HTTPS_PROXY`, `no_proxy`, and secret env vars (with placeholders)
  - Ensure `no_proxy=127.0.0.1,localhost,10.0.2.2,::1` so WebDAV share traffic bypasses the proxy

- [x] **A6. Update `sandbox/docs/qemu.md`**
  - Remove or update risk #5 ("Open egress is a security regression")
  - Document the proxy architecture with a diagram
  - Note: basic egress filtering is implemented; MITM + secret injection is Phase B

- [x] **A7. Update `HARDENING.md`**
  - Replace the stale WISP/DNS-gate/IP-pin egress section
  - Document: proxy-enforced allowlist/denylist, auth token, no TAP, no root
  - Note: MITM secret injection is gated behind `enableMitm: true` (Phase B)

- [x] **A8. Verify basic proxy works (unit tests)**
  - Core logic tested: `hostAllowed` (9 cases), `generatePlaceholder`/`resolveSecrets` (4 cases),
    `rewriteHeaders` (4 cases), `rewriteBody` (2 cases), config structure (1 case)
  - 21 unit tests pass in `test/egress-proxy.unit.ts` (`npm run test:egress`)
  - **End-to-end verification requires a real QEMU guest** (this sandbox has no QEMU):
    - SSH in, `curl -v https://pypi.org` (works), `curl -v https://example.com` (blocked)
    - Confirm WebDAV sync works with `no_proxy`
    - `npm start` → guest boots, syncs, proxy applies policy

## Phase B — MITM TLS interception + secret injection

Goal: for allowlisted hosts declared in `secrets[*].hosts`, the proxy terminates
TLS, replaces placeholder strings with real credentials, and re-encrypts to the
upstream. Requires an ephemeral CA and on-the-fly leaf certificate generation.

### Tasks

- [x] **B1. MITM CA generation**
  - Generate an ephemeral RSA 2048-bit CA keypair at proxy startup if `enableMitm: true`
  - Store CA cert + key in `app.getPath("userData")/mitm-ca/` (persisted across restarts)
  - File permissions: `0o600` for key, `0o644` for cert
  - If CA already exists on disk, reuse it (stable CA = stable leaf cert cache)
  - Self-signed CA with `basicConstraints=CA:TRUE`
  - *Implementation note:* uses `openssl` subprocess; pure-Node fallback tracked in Phase C.

- [x] **B2. Leaf certificate generation**
  - On-the-fly per-hostname leaf certs, cached to disk
  - Cert cache dir: `app.getPath("userData")/mitm-ca/certs/`
  - Cache key: SHA256 of hostname
  - Leaf cert validity: 365 days, SHA256, SAN: `DNS:<hostname>` or `IP:<addr>`
  - *Implementation note:* uses `openssl` subprocess; pure-Node fallback tracked in Phase C.

- [x] **B3. MITM CONNECT handler**
  - In `egress-proxy.ts`: if `enableMitm && isSecretHost(host)` → MITM path
  - TLS-terminate the client connection with the leaf cert
  - Parse the plaintext HTTP request from the guest via a private `http.Server`
  - For headers and body: scan and replace all occurrences of any placeholder with the real secret value
  - Block request if a placeholder appears for a secret not authorized for this host (403)
  - Re-encrypt with upstream CA verification (set `NODE_TLS_REJECT_UNAUTHORIZED=0` for self-signed upstreams)
  - Forward the modified request via Node `https` module
  - Stream response back through the MITM path
  - Chunked transfer-encoding rejected with 411 on secret hosts
  - Keep-alive is handled natively by the `http.Server`

- [x] **B4. Secret placeholder validation**
  - If a placeholder appears in a request to a host not in the secret's `hosts` list → 403 Forbidden
  - Log the blocked attempt with details (env name, host)
  - Reject chunked transfer-encoding on secret hosts (must read/modify entire body)
  - Implemented: `rewriteHeaders()` throws `PlaceholderViolation` for unauthorized hosts;
    chunked body rejected with 411 in `handleMitmRequest`.

- [x] **B5. Verify secret injection**
  - Integration test `testMitmSecretInjection` validates end-to-end: CONNECT → TLS handshake → HTTP request with placeholder → upstream receives real value
  - Test runs in `test/egress-proxy.integration.ts` (`NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx test/egress-proxy.integration.ts`)
  - *Note:* guest-side curl verification requires a QEMU boot and is tracked in Phase C.

- [x] **B6. Guest CA trust**
  - CA cert passed to guest via `fw_cfg` entry `opt/org.valencebox/mitm-ca-cert.pem`
  - In `mount-share.sh`, writes the CA cert to `/usr/local/share/ca-certificates/valencebox-mitm.crt` and runs `update-ca-certificates`
  - Also sets `NODE_EXTRA_CA_CERTS` in `/etc/profile.d/valencebox-proxy.sh` — Node.js's bundled undici (used by `EnvHttpProxyAgent` in prime-agent and other Node tools) does not reliably pick up the system CA bundle after `update-ca-certificates`; the explicit env var bypasses this
  - WebDAV share config also moved to `fw_cfg` (`opt/org.valencebox.config/raw`) — kernel cmdline now only carries proxy port/token/secrets

## Phase C — Polish and hardening

### Tasks

- [ ] **C1. Proxy connection pooling and timeouts**
  - Upstream connection timeout (default 10s)
  - Idle timeout for client connections (default 60s)
  - Limit concurrent connections (configurable, default 256)

- [ ] **C2. Logging and observability**
  - Log: DENY/CONNECT/MITM events with timestamps
  - Optional: per-host traffic counters (bytes in/out)
  - Log file path: `app.getPath("userData")/proxy.log`
  - Rotate log on startup (append, truncate > 10 MB)

- [ ] **C3. Error handling robustness**
  - Handle upstream SSL verification failures gracefully (log, 502 Bad Gateway)
  - Handle guest TLS handshake failures (log, close connection)
  - Handle unexpected EOF, socket errors, timeouts

- [ ] **C4. Unit test suite**
  - Test `hostAllowed()` with allowlist, denylist, wildcards, exact matches
  - Test `mergeEgressConfig()` — policy merging, secret resolution, placeholder generation
  - Test placeholder replacement in headers and body
  - Test MITM cert generation and caching
  - Test auth token verification (valid token, invalid token, missing token)

- [ ] **C5. Integration / smoke test**
  - Boot a QEMU guest with the proxy enabled
  - Verify blocked host returns 403 from `curl` inside guest
  - Verify allowed host returns real data
  - Verify secret injection: guest sees placeholder, proxy replaces it
  - Verify WebDAV sync still works (no_proxy bypass)
  - Verify `no_proxy` env var is correctly set in the guest

- [ ] **C6. Documentation**
  - `sandbox/docs/mitm-plan.md` — this file, maintain as the plan evolves
  - Update `sandbox/README.md` with egress proxy config documentation
  - Update `AGENTS.md` with proxy usage notes
  - Update `sandbox/docs/qemu.md` risk table (risk #5 resolved)

## Phase D — Security hardening (post-audit fixes)

Security review findings and hardening items identified during the
`feat/mitm-proxy` branch security audit. All HIGH and MEDIUM items should be
resolved before merging to main.

### Tasks

- [x] **D1. Remove OPENSSL env var injection**
  - `process.env.OPENSSL` allowed arbitrary binary execution as the CA signing
    step, exposing the MITM CA private key. Hardcoded to `"openssl"`.
  - File: `sandbox/src/main/egress-proxy.ts:353`

- [x] **D2. Validate env_name in resolveSecrets()**
  - Secret environment variable names from user config are validated against
    `^[a-zA-Z_][a-zA-Z0-9_]*$` to prevent shell injection via the guest's
    `mount-share.sh` eval path.
  - File: `sandbox/src/main/egress-proxy.ts:101`

- [x] **D3. Remove eval in mount-share.sh secrets parsing**
  - Replaced `eval "export ${env_name}=\"${env_val}\""` with direct
    `export "${env_name}=${env_val}"` and `printf` for the profile script.
    Combined with D2, this closes the guest-side shell injection vector.
  - File: `sandbox/guest/usr/local/libexec/mount-share.sh:104–109`

- [x] **D4. Fix forwardRequest hardcoded port 443**
  - Parses `req.url` as an absolute URL to extract the real target port and
    path, instead of always forwarding to port 443. Also selects the correct
    protocol module (`http` vs `https`) based on the URL scheme.
  - File: `sandbox/src/main/egress-proxy.ts:570–608`

- [x] **D5. Enforce allowPorts in CONNECT and forward handlers**
  - The `allowPorts` field was defined in `EgressRuntimeConfig` but never
    checked. Now both `handleConnect` and `forwardRequest` reject connections
    to ports not in the allow list.
  - Files: `sandbox/src/main/egress-proxy.ts:622`, `sandbox/src/main/egress-proxy.ts:560`

- [x] **D6. Fix normalizeHost for bare IPv6 addresses**
  - Bare IPv6 like `::1` was incorrectly stripped to empty string by the
    port-stripping logic. Added a guard that detects multiple colons (IPv6)
    before attempting port removal.
  - File: `sandbox/src/main/egress-proxy.ts:35–43`

- [ ] **D7. Pure-Node fallback for certificate generation**
  - MITM CA and leaf cert generation currently require `openssl` on the host.
    Implement a pure-Node fallback using Node's `crypto` module to eliminate
    the subprocess dependency entirely.

- [ ] **D8. Rate limiting and connection limits**
  - Add configurable per-client rate limiting and max concurrent connections
    to prevent resource exhaustion from a compromised guest.

- [ ] **D9. Custom upstream CA support**
  - Add a `caCert` option in `EgressConfig` to supply a custom CA bundle for
    upstream connections that use internal/self-signed certificates.

- [ ] **D10. Response header sanitization**
  - Strip or rewrite `Strict-Transport-Security`, `Public-Key-Pins`, and
    `Expect-CT` headers from upstream responses to prevent interference with
    the proxy's MITM TLS termination.

- [x] **D11. Add fromFile secret source**
  - Added `fromFile?: string` to `SecretSpec` so secrets can be read from disk
    files (e.g. `~/.secrets/gh.key`). Supports `~` expansion to the user's
    home directory. Priority: `value` > `fromFile` > `fromEnv`.
  - Files: `sandbox/src/config.ts:25–32`, `sandbox/src/main/egress-proxy.ts:105–145`
