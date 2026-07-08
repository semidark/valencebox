# AGENTS.md

## Repo shape

- **Product** is entirely in `sandbox/` (TypeScript/Electron). Root has no manifests; `cd sandbox` for all dev work.
- `v86/` is a git submodule pointing at [`semidark/v86`](https://github.com/semidark/v86), a fork of `copy/v86` used **only to build v86 assets** (`libv86.js`, `v86.wasm`, `seabios.bin`, `vgabios.bin`). The fork carries one patch on top of upstream: a bound on `AsyncXHRBuffer`'s disk `block_cache` (opt-in `max_cache_bytes`), fixing unbounded host memory growth from cumulative guest disk I/O — see [semidark/v86#1](https://github.com/semidark/v86/pull/1). Do not edit `v86/` locally to change product behavior; patches belong in the fork.

## Bootstrap (order matters)

```sh
git submodule update --init                  # fetch the v86 submodule
./scripts/build-v86.sh                       # build v86 assets (Docker required, slow first time)
cd sandbox
npm install
npm run images                               # build guest (sync-agent Rust, Alpine 3.18.6, ext4 disks + kernel)
npm run build
npm start                                    # launch Electron app
```

- `./scripts/build-v86.sh` builds the pinned `v86/` submodule (Closure Compiler + Rust/wasm32, via Docker) into `build/v86/`; `npm run images` copies those four assets into `sandbox/assets/v86/`.
- `npm run images` builds Rust sync-agent targeting `i686-unknown-linux-musl`, spins up `--platform=linux/386` Alpine, extracts kernel/initramfs, generates two ext4 disks. Outputs are gitignored; regenerate rather than commit.

## Build

- `npm run build` = `tsc -p .` → `node scripts/copy-renderer.js`
  - TS is `strict`, CommonJS target
  - No bundler: xterm.js is vendored as UMD globals into `dist/renderer/vendor/`
  - Adding renderer deps requires updating `copy-renderer.js` with the exact asset paths
  - No ESLint/Prettier config; match existing code style

## Testing

- No umbrella test target. Run individual test suite: `npm run test:unit` (fast, pure); `test:boot|sync|snapshot|net|dataplane|e2e` (VM tests, need `npm run images` built first); `test:ui` (Electron offscreen).
- Env knobs: `SCRATCH=/path` (test dirs, default `/tmp`), `VERBOSE=1` (stream guest serial).

## Cross-cutting constraints (easy to break)

- **Everything is 32-bit x86**: guest is Alpine **pinned to 3.18.6** (newer `mkinitfs` breaks boot); Rust agent must target `i686-unknown-linux-musl`.
- `src/shared/protocol.ts` mirrors `guest/sync-agent-rust/src/frame.rs` framing — **change both together**; 256 KiB frame cap.
- Disks are IDE (`/dev/sda|sdb`), not virtio-blk. Guest detects mount point via `blkid`.
- `src/main/vm.ts` virtio-console writer is deliberately **paced** (<4 KiB slices, waits for free RX descriptor) — do not "optimize" it; v86 silently drops bytes if the ring is full.
- `hda`/`hdb` are configured with `max_cache_bytes` (see `src/main/vm.ts`) to bound v86's disk `block_cache`, and `SandboxVM.flushDisks()` is called after hydration and in `SnapshotManager.save()` to proactively reclaim it — without this, host RAM grows unboundedly with cumulative guest disk I/O (see `v86/` fork patch above).
- Security invariants (no live host mount, DNS-gate + IP-pin egress allowlist) live in `HARDENING.md`. Preserve when touching `sync-manager.ts`, `wisp.ts`, `doh.ts`, `data-plane.ts`.

## Workspace sync

- `WORKSPACE_DIR=~/src/project npm start` points guest `/workspace` at a host dir (synced bidirectionally, **not mounted**).
- Never synced at any depth: `node_modules`, `.git`, `.DS_Store`, `.sync-tmp`, `lost+found`. Run `npm install` inside the guest.
- Workspace disk is 512 MB.

## Key docs

- `sandbox/README.md` — architecture overview, measured boot/hydrate/snapshot timings.
- `PROTOCOL.md` — framed wire format between host and sync-agent.
- `HARDENING.md` — security model and invariants.
- `docs/data-plane-architecture.md` — why two sync channels (console + TCP), data-plane VIP trick, batching strategy.
