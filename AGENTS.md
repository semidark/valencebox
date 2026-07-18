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
  (guest-profile + golden-args), `test:qmp` (QMP protocol).
- **Future suites** (see `docs/qemu.md` phase verifications): `test:share` (HTTP
  share round-trip, no VM), `test:snapshot` (QMP migrate save/restore),
  `test:e2e`, `test:ui`.
- Env knobs: `SCRATCH=/path` (test dirs, default `/tmp`), `VERBOSE=1` (stream
  guest serial). Add `ACCEL=tcg` to force software emulation in accel-agnostic
  tests.

## SSH debug access

When a VM is running (via `npm start` or `test:boot`), you can SSH in for
interactive debugging.

```sh
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -p 2222 root@127.0.0.1
```

- Forwarded via `-netdev user,hostfwd=tcp:127.0.0.1:2222-:22`
- Only Ed25519 host key; `chacha20-poly1305` cipher, `curve25519-sha256` kex
- `vm-debug` SSH public key baked into `/root/.ssh/authorized_keys`
- **TODO: gate behind a config flag before release** (currently always on)
- Works as long as QEMU SSH hostfwd is active (i.e., the app is running)

## Cross-cutting constraints

- **Guest is x86-64 or aarch64.** No more `i686`; use virtio drivers.
- **Disks are virtio-blk** (`/dev/vda` root, `/dev/vdb` workspace), not IDE.
- **Host↔guest sync is WebDAV + unison** (poll-based). inotify cannot cross the
  network share. Do not "fix" this with a filesystem passthrough — none works
  on Windows.
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

- Egress is **open** via `-nic user` (SLIRP). A filtering proxy is deferred
  (see `docs/qemu.md` risk #5).
- New config knobs per `docs/qemu.md`: `accel`, `workspaceDir`, `memMb`, `smp`.

## Key docs

- **`sandbox/docs/qemu.md` — the rewrite plan and source of truth. Start here.**
- `sandbox/README.md` — architecture overview.
- `HARDENING.md` — security model and invariants.
