# tab-microvm

A bare-minimum microVM that runs in a browser tab, built on
[env86](https://github.com/progrium/env86) (which wraps the
[v86](https://github.com/copy/v86) x86-in-WebAssembly emulator).

What you get: a login shell (root / root) with bash on a serial-style text
console. No sound, no graphics stack, no USB, no printers/parallel port, no
wireless/bluetooth — the corresponding kernel modules are deleted from the
image.

## Layout

- `env86/` — cloned upstream tool (built with `make -C env86 all`)
- `guest/Dockerfile` — the minimal 32-bit guest (kernel, bash, agetty, OpenRC)
- `vm/` — generated env86 image (9p filesystem + image.json)
- `www/` — generated static site; open in a browser tab to run the VM

## Build & run

```sh
make tool    # build env86 CLI + assets (needs Go + Docker; slow first time)
make image   # build guest/Dockerfile -> ./vm
make boot    # sanity-check locally: serial console in your terminal
make www     # generate static browser build -> ./www
make serve   # serve on http://localhost:8086 — open in a tab, log in
```

Login: `root` / password `root`.

## Iteration ideas

- Pipe serial0 to xterm.js in `www/index.html` instead of the VGA text screen
- `env86 boot --save` to snapshot a booted state for near-instant tab loads
- Networking in the tab via `env86 network` relay + `/root/networking.sh`
- Replace Alpine kernel with a custom tinyconfig build (9p/virtio/serial only)
- Trim userland further (drop OpenRC for a hand-rolled inittab-only init)
