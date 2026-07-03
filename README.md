# tab-microvm

A secure, high-performance coding sandbox for an AI agent: a stripped 32-bit
Alpine Linux microVM running in WebAssembly ([v86](https://github.com/copy/v86))
inside an Electron app. The agent is isolated from the host but gets native-speed
file I/O against a real ext4 disk, bidirectional host↔guest file sync, and a
single allowlisted, proxied egress path.

## Layout

| Path | What it is |
|------|------------|
| [`sandbox/`](sandbox/) | **The product.** The Electron app: headless v86, virtio-console sync engine, Go sync-agent guest, zstd snapshots, WISP egress. Start here — see [`sandbox/README.md`](sandbox/README.md). |
| [`env86/`](https://github.com/progrium/env86) | Git submodule, used only as a **build tool**. The product copies four prebuilt v86 runtime assets (`libv86.js`, `v86.wasm`, `seabios.bin`, `vgabios.bin`) out of `env86/assets/`; it does not use the env86 CLI at runtime. |

## Quick start

```sh
git submodule update --init   # fetch env86
make -C env86 all             # build v86 assets (needs Go + Docker; slow first time)

cd sandbox
npm install
npm run images                # build guest disk images (needs Docker + Go)
npm run build
npm start                     # launch the app

# point the sandbox at a real project instead of the default workspace:
WORKSPACE_DIR=~/src/myproject npm start
```

Full build, test, and architecture docs live in
[`sandbox/README.md`](sandbox/README.md), with the sync wire format in
[`sandbox/PROTOCOL.md`](sandbox/PROTOCOL.md) and the security model in
[`sandbox/HARDENING.md`](sandbox/HARDENING.md).

## Why 32-bit Alpine

v86 emulates a **32-bit** x86 CPU only, so the guest is 32-bit Alpine (pinned
to 3.18.6 — newer mkinitfs breaks boot here). 64-bit guests such as Fedora
CoreOS cannot run on v86 regardless of build tricks.
