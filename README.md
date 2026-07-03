# ValenceBox

> **Experimental Proof of Concept**
>
> ValenceBox is an experiment to explore how far a WebAssembly-based Linux
> sandbox can be pushed inside an Electron app. It is **not production-ready**
> and comes with significant limitations:
>
> - **Memory:** WASM does not support dynamic memory allocation, so despite v86
>   supporting memory ballooning, the VM cannot resize its RAM at runtime.
>   Memory management is suboptimal.
> - **CPU:** v86 emulates a single-core 32-bit x86 CPU only. SMP (multi-core)
>   is not implemented.
> - **File sync:** The workspace sync engine was built from scratch and is
>   alpha-quality at best. Conflicts, large trees, and edge cases are handled
>   minimally.
> - **Unknowns:** This was written as a personal exploration. There are likely
>   undiscovered bugs, race conditions, and security gaps.

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

## License

AGPL-3.0-only — see [`LICENSE`](LICENSE). This project bundles the
AGPL-licensed [`wisp-js`](https://github.com/MercuryWorkshop/wisp-js) client
in-process for its egress relay, which is why the whole project is licensed
AGPL-3.0 rather than a permissive license. See
[`sandbox/THIRD_PARTY_LICENSES.md`](sandbox/THIRD_PARTY_LICENSES.md) for
attributions of other bundled/vendored components (v86 assets, xterm.js).

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
