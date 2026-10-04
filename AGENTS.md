# AGENTS.md

## Active: QEMU-backed VM (`-machine microvm`, `pc`, or `virt`)

The product runs **QEMU** (`qemu-system-x86_64` or `qemu-system-aarch64` as a
bundled host subprocess, 64-bit guest). Current source and `sandbox/package.json`
define implemented behavior and runnable commands; `sandbox/docs/qemu.md`
separates the current architecture from historical plans.

Machine selection in `sandbox/src/main/guest-profile.ts`:
- **microvm** on x86-64 when the resolved accelerator is hardware acceleration;
  uses MMIO virtio devices and adds `reboot=t`.
- **pc** (i440fx) on x86-64 with resolved `tcg,thread=multi` (including forced
  `accel: "tcg"`); uses PCI virtio devices and timers needed for TCG boot.
- **Current mapping gap:** macOS x86-64 auto mode resolves bare `tcg` first,
  which the profile maps to `microvm`, not `pc`. Do not infer a verified boot
  path from the TCG fallback list.
- **virt** on aarch64 with HVF or TCG; the current profile uses PCI virtio devices.

Acceleration detection considers host/guest compatibility: `kvm` (Linux),
`hvf` (macOS), or `whpx` (Windows), with `tcg,thread=multi` fallback. Apple
Silicon selects aarch64 when its binary and root image are present. Forced
`accel: "tcg"` keeps that architecture; HVF initialization failure may fail
launch because the resolver assumes availability and preselects CPU arguments.
This describes selection logic, not verified boots or guaranteed runtime fallback.

## Repo shape

- **Product** is entirely in `sandbox/` (TypeScript/Electron). Root has no
  manifests; `cd sandbox` for all dev work.
- QEMU is a **bundled binary** under `resources/qemu/<platform>/`, built by
  `scripts/build-qemu.sh`.

## Current architecture (QEMU) — summary

Full detail in `sandbox/docs/qemu.md`. In brief:

- Guest is **Ubuntu 24.04** (x86-64 or aarch64) with virtio-blk root + workspace
  disks, direct kernel boot via QEMU, HTTP/WebDAV host share over loopback
  SLIRP.
- **Host↔guest share is plain HTTP over loopback SLIRP** (pure-Node server, no
  TLS). The guest mirrors the HTTP share into the native qcow2 working tree
  with **unison**.
- **Host directory is canonical by design**; the qcow2 working tree is a synced
  cache. Guest edits are not durable on the host until synchronization succeeds.
- **Snapshots are not implemented.** The legacy `saveSnapshot` IPC handler is
  a no-op. QMP migration/compression is a future proposal, not a working backend;
  future RAM/device-state restore also requires compatible writable-disk state.
- Target platforms: **Linux + macOS + Windows**; this is not a claim of verified
  packaging or boot coverage on every platform.

## Bootstrap

```sh
cd sandbox
npm install
npm run images:all              # build both x86-64 and arm64 assets (Docker)
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

- No umbrella test target; run suites individually. `sandbox/package.json` is
  the authority for executable script names.
- **Current suites:** `test:unit` (guest-profile + golden-args), `test:egress`
  (proxy policy/rewriting helpers), `test:egress:integration` (proxy sockets,
  certificates, auth and injection), `test:share` (WebDAV auth/CRUD/traversal,
  no VM), `test:qmp` (frozen QEMU query-status and process stop), and `test:boot`
  (x86-64 serial login, disk layout and service status; no host share or sync
  round-trip). QMP tests do not test snapshot save/restore.
- **Existing legacy suite:** `test:ui` uses a stub preload and old renderer
  fields. Requires built renderer assets and Electron/display prerequisites;
  does not verify the live VM lifecycle or production security settings.
- **Future proposals only:** `test:snapshot` and `test:e2e` do not exist as npm
  scripts. No current suite replaces full lifecycle/snapshot coverage.
- `VERBOSE=1` enables extra logs. `ACCEL=tcg` forces TCG in QMP/boot tests
  (their default). Those tests delete their entire `SCRATCH` directory during
  cleanup: omit `SCRATCH` for auto-created temporary storage, or use a dedicated
  disposable directory, never a project or shared temp root.

## SSH debug access

When the app VM is running via `npm start` with the default port forwards,
you can SSH in for interactive debugging. `test:boot` does not configure the
app's default SSH forward.

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
- **Proxy policy applies to requests sent through `EgressProxy`.** Guest proxy
  environment variables do not enforce mandatory egress; current unrestricted
  SLIRP permits direct connections by clients that ignore them.
- **WebDAV share traffic uses a separate direct path.** Guest `no_proxy` includes
  `127.0.0.1,localhost,10.0.2.2,::1`. The share binds host loopback and is reached
  through SLIRP at `10.0.2.2`; this exception is not an isolation mechanism.
- **Host dir is canonical.** Treat the qcow2 working tree as a rebuildable
  cache; never make it the sole source of truth.
- **Bundle, don't assume.** QEMU binary + firmware blobs + guest images ship
  inside the app; resolve paths via `process.resourcesPath` in production, dev
  paths otherwise.
- **Keep the accelerator fallback candidate intact.** Append `tcg,thread=multi`
  last, but do not promise successful fallback: bare-`tcg` mapping and preselected
  CPU/machine arguments can still prevent a working launch.

## Workspace sync

- `WORKSPACE_DIR=~/src/project npm start` points the guest `/workspace` at a
  host dir served over plain-HTTP WebDAV and mirrored into the qcow2 working
  tree by unison. `/workspace` is not a passthrough mount; `/host-workspace`
  is a guest WebDAV mount. Host conflict preference does not guarantee lossless
  sync or protection against mount loss after sync starts.
- Never synced at any depth: `node_modules`, `.git`, `.DS_Store`,
  `lost+found`. Run `npm install` inside the guest.
- Workspace disk sizing via `WORKSPACE_MB=<n> npm run images`.

## Egress config (sandbox.config.json)

Place in the Electron `userData` dir (`~/.config/ValenceBox/` on Linux).

- Egress is **mediated by the host-process `EgressProxy`** running in the
  Electron main process (`sandbox/src/main/egress-proxy.ts`). It implements an
  HTTP CONNECT forward proxy plus plain HTTP forwarding, with per-session token
  authentication and allowlist/denylist host filtering.
- When `egress` is absent or `policy` is `"none"`, the proxy still starts and
  skips host filtering (including deny rules). Authentication and nonempty
  `allowPorts` checks still apply; `allowAll` bypasses host filtering only.
- Configuration must be strict JSON. The annotated `jsonc` example below is
  explanatory: remove comments before saving it. The current strict `JSON.parse`
  loader silently falls back to `{}` for invalid JSON, discarding the policy.
  This placeholder-free example enables host policy without provisioning secrets:

  ```jsonc
  {
    "egress": {
      "policy": "allowlist",            // "allowlist" | "denylist" | "none"
      "allowHosts": ["pypi.org", "*.pythonhosted.org"],
      "denyHosts": [],
      "allowPorts": [80, 443],          // enforced for proxied requests; [] = no port restriction
      "allowAll": false,                // bypass host filtering only
      "enableMitm": false,              // TLS interception for secret injection
      "listenPort": 0,                  // 0 = OS-assigned
      "secrets": []
    },
    "portForwards": [
      { "hostPort": 2222, "guestPort": 22, "label": "SSH debug access" },
      { "hostPort": 8080, "guestPort": 80, "label": "HTTP dev server" }
    ]
  }
  ```

- The proxy listens on `0.0.0.0:<port>`; the guest reaches it via the SLIRP
  gateway at `10.0.2.2:<port>` with `HTTP_PROXY`/`HTTPS_PROXY`.
- The guest sets `no_proxy=127.0.0.1,localhost,10.0.2.2,::1` for clients that
  honor it, including the direct WebDAV share path.
- **Optional MITM TLS interception is implemented, not security-audited.** When `enableMitm: true` and a
  secret host is matched, the proxy TLS-terminates the connection, replaces
  placeholders in headers/body, and re-encrypts to the upstream. Guest CA trust
  is handled via `fw_cfg` — the CA cert is injected into the guest at boot and
  installed via `update-ca-certificates`. MITM CA and leaf certificates are
  generated in pure Node (`selfsigned` → `@peculiar/x509`) — no `openssl`
  required by runtime certificate generation. The CA persists across restarts.
  Plain HTTP secret-host requests also rewrite credentials, even with MITM off.
  Body host authorization, TLS verification and upstream secret echo limitations
  are documented in `sandbox/HARDENING.md`; do not promise the guest can never
  recover a secret.
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
  installs MITM CA cert, and mounts `/workspace`. The separate `workspace-sync`
  systemd service runs `workspace-sync.sh` and unison.
- `sandbox/test/egress-proxy.unit.ts` — unit tests (`npm run test:egress`).
- `sandbox/test/egress-proxy.integration.ts` — integration tests (CA gen, auth,
  policy, MITM secret injection). Use `npm run test:egress:integration`; the
  self-signed injection fixture currently needs a test-only
  `NODE_TLS_REJECT_UNAUTHORIZED=0` override for the full suite. Never set that
  override for normal app use; integration fixtures also require `openssl`.
- `sandbox/docs/mitm-plan.md` — implementation plan.
- `sandbox/HARDENING.md` — implementation evidence, limitations and follow-ups (not an audit).

## Key docs

- **`sandbox/docs/qemu.md` — current implementation summary plus historical rewrite plan.**
- `sandbox/docs/mitm-plan.md` — MITM egress proxy plan and current status.
- `sandbox/README.md` — architecture overview.
- `sandbox/HARDENING.md` — security-relevant implementation evidence and known gaps.
