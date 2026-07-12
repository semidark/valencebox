# AGENTS.md

## ⚠️ Active rewrite: v86 → QEMU

The product is mid-pivot from **v86** (in-process WASM JIT, 32-bit guest) to
**vanilla QEMU** (`qemu-system-x86_64` as a bundled host subprocess, 64-bit
guest). **`sandbox/docs/qemu.md` is the source of truth** for the target
architecture, the phased execution plan, and progress checkboxes. Read it before
touching `vm.ts`, `snapshot.ts`, `sandbox.ts`, the guest image, or packaging.

Many facts below describe the **legacy v86 stack** that is being torn out. They
are marked **(LEGACY — being removed)**. Do not build new work on them; follow
`docs/qemu.md` instead. As phases land, migrate the corresponding notes here from
LEGACY to current.

## Repo shape

- **Product** is entirely in `sandbox/` (TypeScript/Electron). Root has no
  manifests; `cd sandbox` for all dev work.
- **(LEGACY — being removed)** `v86/` is a git submodule (fork
  [`semidark/v86`](https://github.com/semidark/v86)) used only to build v86
  assets. The QEMU rewrite removes the submodule, `scripts/build-v86.sh`, and
  `assets/v86/`. QEMU will be a **bundled binary** under
  `resources/qemu/<platform>/`, not a built-from-source submodule.

## Target architecture (QEMU) — summary

Full detail in `sandbox/docs/qemu.md`. In brief:

- `qemu-system-x86_64` spawned by Electron main; `-machine q35`, virtio devices,
  `-nographic`, serial + QMP over Unix sockets, `-nic user` (SLIRP).
- **Acceleration auto-detects**: `kvm` (Linux) / `hvf` (macOS) / `whpx` (Windows)
  via an `-accel` priority list, falling back to `-accel tcg,thread=multi`. Users
  get hardware virtualization when available, full software emulation otherwise.
- Guest is **Alpine x86-64** with the `linux-virt` kernel; root on `/dev/vda`,
  workspace qcow2 on `/dev/vdb` mounted at `/workspace`.
- **Host↔guest share is plain HTTP over loopback SLIRP** (pure-Node server, no
  TLS). No 9p, no virtiofs (neither works on Windows). The guest mirrors the
  HTTP share into the native qcow2 working tree with **rsync + inotifywait**.
- **Host directory is canonical**; the qcow2 working tree is a fast synced cache.
- Snapshots via **QMP `migrate` to a zstd file** (RAM + device state only; the
  workspace is host-canonical and excluded).
- Target platforms: **Linux + macOS + Windows** from day one.

## Bootstrap

**Current (legacy v86 stack, still what builds today):**

```sh
git submodule update --init
./scripts/build-v86.sh          # (LEGACY) build v86 assets (Docker, slow)
cd sandbox
npm install
npm run images                  # (LEGACY) 32-bit guest, Rust sync-agent, ext4 disks
npm run build
npm start
```

**Target (QEMU — see `docs/qemu.md`, being built phase by phase):**

```sh
cd sandbox
npm install
# vendor/bundle a qemu-system-x86_64 into resources/qemu/<platform>/
npm run images                  # x86-64 Alpine root.qcow2 + empty workspace.qcow2
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
- **(LEGACY — being removed):** `test:bridge`, `test:sync`, `test:dataplane`,
  and the `manifest` / `hydrate-channel-switch` unit tests exercise the v86
  sync-agent/data-plane stack and go away with it.
- **Target suites** (see `docs/qemu.md` phase verifications): `test:boot` (QEMU
  reaches serial login), `test:share` (HTTP share round-trip, no VM),
  `test:sync` (host↔guest mirror), `test:snapshot` (QMP migrate save/restore),
  `test:e2e`, `test:ui`.
- Env knobs: `SCRATCH=/path` (test dirs, default `/tmp`), `VERBOSE=1` (stream
  guest serial). Add `ACCEL=tcg` to force software emulation in accel-agnostic
  tests.

## Cross-cutting constraints

### Target (QEMU) — enforce these

- **Guest is x86-64.** No more `i686`/`--platform=linux/386`; use `linux-virt`
  and virtio drivers.
- **Disks are virtio-blk** (`/dev/vda` root, `/dev/vdb` workspace), not IDE.
- **Never disable share encryption by switching to SSH** — the share is plain
  HTTP precisely because the emulated guest has no AES-NI under TCG; encryption
  over loopback would waste compute for nothing. If you need auth, scope by
  loopback binding + path, not TLS.
- **host→guest sync is poll-based (~2s).** inotify cannot cross the network
  share; only the guest-local qcow2 side gets inotify. Do not "fix" this with a
  filesystem passthrough — none works on Windows.
- **Host dir is canonical.** Treat the qcow2 working tree as a rebuildable
  cache; never make it the sole source of truth.
- **Bundle, don't assume.** QEMU binary + firmware blobs
  (`bios-256k.bin`, `vgabios-stdvga.bin`) + guest images ship inside the app;
  resolve paths via `process.resourcesPath` in production, dev paths otherwise.
- **Keep the accel fallback intact.** Always append `tcg,thread=multi` last so
  hosts without KVM/HVF/WHPX still boot.

### (LEGACY — being removed)

- Everything-32-bit-x86; Alpine 3.22.5 pin; `i686-unknown-linux-musl` agent.
- `src/shared/protocol.ts` ↔ `guest/sync-agent-rust/src/frame.rs` framing
  (256 KiB frame cap) — both deleted in the rewrite.
- IDE disks (`/dev/sda|sdb`) + `blkid` mount detection.
- Paced virtio-console writer in `vm.ts` (v86 drops bytes on a full ring).
- `hda`/`hdb` `max_cache_bytes` caps + `flushDisks()` to bound v86's disk
  `block_cache` — a v86-specific host-RAM leak; irrelevant under QEMU.
- DNS-gate + IP-pin egress allowlist in `wisp.ts` / `doh.ts` — the WISP relay
  and DoH gate are removed; QEMU uses `-nic user` (open egress) initially, with
  a filtering proxy deferred (see `docs/qemu.md` risk #5).

## Workspace sync

- `WORKSPACE_DIR=~/src/project npm start` points the guest `/workspace` at a host
  dir. Under QEMU this is served over the **plain-HTTP loopback share** and
  mirrored into the qcow2 working tree by the in-guest rsync/inotify service
  (**not** a live mount).
- Never synced at any depth: `node_modules`, `.git`, `.DS_Store`, `.sync-tmp`,
  `lost+found`. Run `npm install` inside the guest.
- Workspace disk sizing via `WORKSPACE_MB=<n> npm run images`. Bump if a guest
  `npm install` runs it out of space.

## Egress config (sandbox.config.json)

Place in the Electron `userData` dir (`~/.config/ValenceBox/` on Linux).

- **Current/target:** egress is **open** via `-nic user` (SLIRP). The old
  allowlist (`allowAll`/`extraHosts`/`extraPorts`, parsed in `main.ts`) is a
  **(LEGACY — being removed)** wisp.ts feature; a QEMU-side filtering proxy is a
  future phase.
- New config knobs land per `docs/qemu.md`: `accel` (force/override backend),
  `workspaceDir`, `memMb`, `smp`.

## Key docs

- **`sandbox/docs/qemu.md` — the rewrite plan and source of truth. Start here.**
- `sandbox/README.md` — architecture overview (being rewritten for QEMU).
- `HARDENING.md` — security model and invariants (being rewritten: host-canonical
  dir, plain-HTTP loopback share, open egress as a temporary regression).
- **(LEGACY — being removed)** `PROTOCOL.md`, `docs/data-plane-architecture.md`,
  `docs/switch-to-v86-fork.md` — describe the v86 sync-agent stack.
