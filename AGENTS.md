# AGENTS.md

## Active: QEMU-backed microVM (`-machine pc` or `virt`)

The product runs **QEMU** (`qemu-system-x86_64` or `qemu-system-aarch64` as a
bundled host subprocess, 64-bit guest). **`sandbox/docs/qemu.md` is the source
of truth.**

Machine type selection:
- **pc** (i440fx) on x86-64 — provides HPET + ACPI PM timer for TSC
  calibration under TCG; microvm is not used (HPET-less microvm needs reliable
  kvmclock which TCG cannot provide).
- **virt** (GICv3) on aarch64 — works with both HVF and TCG.

Acceleration auto-detects: `kvm` (Linux) / `hvf` (macOS) / `whpx` (Windows)
with `tcg,thread=multi` fallback.

## Repo shape

- **Product** is entirely in `sandbox/` (TypeScript/Electron). Root has no
  manifests; `cd sandbox` for all dev work.
- QEMU is a **bundled binary** under `resources/qemu/<platform>/`, built by
  `scripts/build-qemu.sh`.

## Target architecture (QEMU) — summary

Full detail in `sandbox/docs/qemu.md`. In brief:

- Guest is **Ubuntu 24.04** (x86-64 or aarch64) with virtio-blk root + workspace
  disks, direct kernel boot via QEMU, HTTP/WebDAV host share over loopback
  SLIRP.
- **Host↔guest share is plain HTTP over loopback SLIRP** (pure-Node server, no
  TLS). The guest mirrors the HTTP share into the native qcow2 working tree
  with **unison**.
- **Host directory is canonical**; the qcow2 working tree is a fast synced cache.
- Snapshots via **QMP `migrate` to a zstd file** (RAM + device state only; the
  workspace is host-canonical and excluded).
- Target platforms: **Linux + macOS + Windows** from day one.

## Bootstrap

```sh
cd sandbox
npm install
npm run images                  # x86-64 + arm64 root.qcow2 + workspace.qcow2
npm run build
npm start
```

## Build

- `npm run build` = `tsc -p .` → `node scripts/copy-renderer.js`
  - TS is `strict`, CommonJS target
  - No bundler: xterm.js is vendored as UMD globals into `dist/renderer/vendor/`
  - Adding renderer deps requires updating `copy-renderer.js` with the exact asset paths
  - No ESLint/Prettier config; match existing code style

## Linux sandbox note

- Electron's `chrome-sandbox` SUID helper requires root ownership + mode `4755`.
  On dev machines where `sudo chown` is inconvenient, use
  `npm run start:no-sandbox` instead of `npm start` (adds `--no-sandbox`).

## Testing

- No umbrella test target; run suites individually.
- **Current suites:** `test:boot` (QEMU reaches serial login), `test:unit`
  (guest-profile + golden-args), `test:qmp` (QMP protocol), `test:egress`
  (egress proxy policy, secrets, and MITM helpers).
- **Future suites** (see `docs/qemu.md` phase verifications): `test:share` (HTTP
  share round-trip, no VM), `test:snapshot` (QMP migrate save/restore),
  `test:e2e`, `test:ui`.
- Env knobs: `SCRATCH=/path` (test dirs, default `/tmp`), `VERBOSE=1` (verbose
  logging everywhere — guest serial, WebDAV share requests, QMP events). Add
  `ACCEL=tcg` to force software emulation in accel-agnostic tests.

## SSH debug access

When a VM is running (via `npm start` or `test:boot`), you can SSH in for
interactive debugging.

```sh
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -p 2222 root@127.0.0.1
```

- Forwarded via `hostfwd` in the `-netdev user` argument (port 2222 → guest 22).
- Only Ed25519 host key; `chacha20-poly1305` cipher, `curve25519-sha256` kex
- `vm-debug` SSH public key baked into `/root/.ssh/authorized_keys`
- Works as long as QEMU SSH hostfwd is active (i.e., the app is running)
- **Configurable via `sandbox.config.json` → `portForwards`.** Default is
  `[{ hostPort: 2222, guestPort: 22, label: "SSH debug access" }]`. Set
  `portForwards: []` to disable, or add custom forwards alongside SSH.

## Cross-cutting constraints

- **Guest is x86-64 or aarch64.** No more `i686`; use virtio drivers.
- **Disks are virtio-blk** (`/dev/vda` root, `/dev/vdb` workspace), not IDE.
- **Host↔guest sync is WebDAV + unison** (poll-based). inotify cannot cross the
  network share. Do not "fix" this with a filesystem passthrough — none works
  on Windows.
- **All guest HTTP/HTTPS egress goes through the host-process `EgressProxy`.**
  No direct SLIRP routing past the proxy.
- **WebDAV share traffic bypasses the proxy.** The guest sets
  `no_proxy=127.0.0.1,localhost,10.0.2.2,::1`; the share server listens on the
  SLIRP gateway address.
- **Host dir is canonical.** Treat the qcow2 working tree as a rebuildable
  cache; never make it the sole source of truth.
- **Bundle, don't assume.** QEMU binary + firmware blobs + guest images ship
  inside the app; resolve paths via `process.resourcesPath` in production, dev
  paths otherwise.
- **Keep the accel fallback intact.** Always append `tcg,thread=multi` last so
  hosts without KVM/HVF/WHPX still boot.

## Workspace sync

- `WORKSPACE_DIR=~/src/project npm start` points the guest `/workspace` at a
  host dir served over plain-HTTP WebDAV and mirrored into the qcow2 working
  tree by unison (**not** a live mount).
- Never synced at any depth: `node_modules`, `.git`, `.DS_Store`,
  `lost+found`. Run `npm install` inside the guest.
- Workspace disk sizing via `WORKSPACE_MB=<n> npm run images`.

## Egress config (sandbox.config.json)

Place in the Electron `userData` dir (`~/.config/ValenceBox/` on Linux).

- Egress is **mediated by the host-process `EgressProxy`** running in the
  Electron main process (`sandbox/src/main/egress-proxy.ts`). It implements an
  HTTP CONNECT forward proxy plus plain HTTP forwarding, with per-session token
  authentication and allowlist/denylist host filtering.
- When `egress` is absent or `policy` is `"none"`, the proxy still starts but
  allows all traffic (same behaviour as the old open SLIRP).
- Example configuration:

  ```jsonc
  {
    "egress": {
      "policy": "allowlist",            // "allowlist" | "denylist" | "none"
      "allowHosts": ["pypi.org", "*.pythonhosted.org"],
      "denyHosts": [],
      "allowPorts": [80, 443],          // not yet enforced
      "allowAll": false,                // bypass all filtering
      "enableMitm": false,              // TLS interception for secret injection
      "listenPort": 0,                  // 0 = OS-assigned
      "secrets": [
        { "env": "GITHUB_TOKEN", "fromEnv": "GITHUB_TOKEN", "hosts": ["api.github.com"] }
      ]
    },
    "portForwards": [
      { "hostPort": 2222, "guestPort": 22, "label": "SSH debug access" },
      { "hostPort": 8080, "guestPort": 80, "label": "HTTP dev server" }
    ]
  }
  ```

- The proxy listens on `0.0.0.0:<port>`; the guest reaches it via the SLIRP
  gateway at `10.0.2.2:<port>` with `HTTP_PROXY`/`HTTPS_PROXY`.
- The guest `no_proxy=127.0.0.1,localhost,10.0.2.2,::1` ensures WebDAV share
  traffic bypasses the proxy.
- **MITM TLS interception (Phase B) is complete.** When `enableMitm: true` and a
  secret host is matched, the proxy TLS-terminates the connection, replaces
  placeholders in headers/body, and re-encrypts to the upstream. Guest CA trust
  is handled via `fw_cfg` — the CA cert is injected into the guest at boot and
  installed via `update-ca-certificates`. MITM CA and leaf certificates are
  generated in pure Node (`selfsigned` → `@peculiar/x509`) — no `openssl`
  required on the host.
- Other config knobs per `docs/qemu.md`: `accel`, `workspaceDir`, `memMb`,
  `smp`, `balloonMinMb`, `portForwards`.

## Egress proxy files

- `sandbox/src/main/egress-proxy.ts` — proxy server, policy checks, placeholder
  rewriting, MITM CA/leaf helpers.
- `sandbox/src/config.ts` — `EgressConfig`, `EgressRuntimeConfig`, `SecretSpec`,
  `ResolvedSecret`.
- `sandbox/src/main/main.ts` — builds runtime config, starts/stops proxy,
  passes proxy port/token to `VmManager`.
- `sandbox/src/main/qemu.ts` — emits `valencebox.proxy_port`,
  `valencebox.proxy_token`, `valencebox.secrets` on the kernel cmdline.
  WebDAV share config and MITM CA cert passed via `-fw_cfg` entries.
- `sandbox/guest/usr/local/libexec/mount-share.sh` — guest boot script that
  reads the cmdline and `fw_cfg`, writes `/etc/profile.d/valencebox-proxy.sh`,
  installs MITM CA cert, and starts unison sync.
- `sandbox/test/egress-proxy.unit.ts` — unit tests (`npm run test:egress`).
- `sandbox/test/egress-proxy.integration.ts` — integration tests (CA gen, auth,
  policy, MITM secret injection). Run with `NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx test/egress-proxy.integration.ts`.
- `sandbox/docs/mitm-plan.md` — implementation plan.
- `sandbox/HARDENING.md` — security invariants.

## Key docs

- **`sandbox/docs/qemu.md` — the rewrite plan and source of truth. Start here.**
- `sandbox/docs/mitm-plan.md` — MITM egress proxy plan and current status.
- `sandbox/README.md` — architecture overview.
- `sandbox/HARDENING.md` — security model and invariants.
