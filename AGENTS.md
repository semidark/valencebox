# AGENTS.md

## Repo shape

- **Product** is entirely in `sandbox/` (TypeScript/Electron). Root has no manifests; `cd sandbox` for all dev work.
- `env86/` is a git submodule used **only to extract build-time v86 assets** (`libv86.js`, `v86.wasm`, `seabios.bin`, `vgabios.bin`). Do not edit `env86/` to change product behavior.

## Bootstrap (order matters)

```sh
git submodule update --init                  # fetch env86 submodule
make -C env86 all                            # build v86 assets (Go + Docker required, slow first time)
cd sandbox
npm install
npm run images                               # build guest (sync-agent, Alpine 3.18.6, ext4 disks + kernel)
npm run build
npm start                                    # launch Electron app
```

- `npm run images` requires **Docker** and **Go**. Builds Go sync-agent as `GOOS=linux GOARCH=386 CGO_ENABLED=0`, spins up `--platform=linux/386` Alpine, extracts kernel/initramfs, generates two ext4 disks. Outputs are gitignored; regenerate rather than commit.

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

- **Everything is 32-bit x86**: guest is Alpine **pinned to 3.18.6** (newer `mkinitfs` breaks boot); Go agent must stay `GOARCH=386`.
- `src/shared/protocol.ts` mirrors `guest/sync-agent/frame.go` framing — **change both together**; 256 KiB frame cap.
- Disks are IDE (`/dev/sda|sdb`), not virtio-blk. Guest detects mount point via `blkid`.
- `src/main/vm.ts` virtio-console writer is deliberately **paced** (<4 KiB slices, waits for free RX descriptor) — do not "optimize" it; v86 silently drops bytes if the ring is full.
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
