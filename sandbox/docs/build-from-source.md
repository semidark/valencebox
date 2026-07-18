# Build From Source (Apple Silicon)

One-shot validation: clone the repo on a fresh Apple Silicon Mac and get the
guest booting. Intentionally manual — we'll know after this run whether it's
worth scripting.

## Prerequisites

- macOS (Apple Silicon)
- Xcode Command Line Tools (`xcode-select --install`)
- [Homebrew](https://brew.sh)
- Docker (for guest image build; Docker Desktop or OrbStack)
- Node.js 20+ (LTS)

Install build-time dependencies for QEMU:

```sh
brew install meson ninja pkg-config pixman glib
```

## Steps

### 1. Clone

```sh
git clone git@github.com:semidark/valencebox.git
cd valencebox
```

No submodule init needed — the QEMU rewrite removed the old v86 submodule.

### 2. Build the QEMU binary

```sh
bash scripts/build-qemu.sh darwin
```

What happens:
- Fetches QEMU 9.2.4 source tarball to `build/qemu-9.2.4/src/`
- Configures with `--target-list=x86_64-softmmu --enable-slirp --enable-zstd`
  and macOS-specific flags
- Builds `qemu-system-x86_64` and `qemu-img` with `make -j$(hw.logicalcpu)`
- Bundles runtime dylibs (glib, pixman, etc.) into
  `sandbox/resources/qemu/darwin/lib/`
- Ad-hoc code-signs the binary
- Copies firmware blobs to `sandbox/resources/qemu/darwin/pc-bios/`

Expected: ~5-10 minutes on an M-series Mac.

Verify:

```sh
ls -lh sandbox/resources/qemu/darwin/qemu-system-x86_64
otool -L sandbox/resources/qemu/darwin/qemu-system-x86_64 | head -5
```

The `otool` output should show `@executable_path/lib/` references, not
Homebrew Cellar paths. Look for:

```
@executable_path/lib/libglib-2.0.0.dylib
@executable_path/lib/libpixman-1.0.dylib
...
```

If any line says `/usr/local/Cellar/...` or `/opt/homebrew/Cellar/...`, the
dylib bundling step failed — the binary will not work on a machine without
Homebrew.

### 3. Build the guest images

```sh
cd sandbox
npm run images
```

What happens:
- Builds the Ubuntu 24.04 guest Docker image (`guest/Dockerfile`)
- Exports the rootfs, extracts `vmlinuz` + `initrd.img`
- Creates `images/root.qcow2` (ext4, auto-sized)
- Creates `images/workspace.qcow2` (default 1 GiB, override with
  `WORKSPACE_MB=<n>`)
- Uses the **bundled** `qemu-img` from step 2 (falls back to `$PATH`)

Expected: ~2-3 minutes (depends on Docker pull speed).

Verify:

```sh
ls -lh images/*.qcow2 images/vmlinuz.bin images/initramfs.bin
```

### 4. Install npm deps and build TypeScript

```sh
npm install
npm run build
```

Expected: ~30s. Verifies `dist/main/main.js` exists.

### 5. Run the QEMU smoke tests

These test the QEMU integration without needing the full Electron UI.

**Quick signal (fastest):**

```sh
npm run test:qmp
```

Verifies: QEMU process starts, QMP socket connects, capabilities negotiated,
`query-status` returns, VM shuts down cleanly. Takes ~2s under TCG.

**Full boot test (slow):**

```sh
npm run test:boot
```

Verifies: boots Ubuntu to serial login, root login works, `/workspace` is
mounted from the second virtio disk, sync-agent service
is running. Takes ~30-60s under TCG.

Add `VERBOSE=1` to stream guest serial output:

```sh
VERBOSE=1 npm run test:boot
```

**Snapshot test:**

```sh
npm run test:snapshot
```

**End-to-end test (orchestrator lifecycle):**

```sh
npm run test:e2e
```

**UI smoke test (headless Electron):**

```sh
npm run test:ui
```

### 6. Launch the app

```sh
npm start
```

Add `WORKSPACE_DIR=<path>` to map a host directory into the guest:

```sh
WORKSPACE_DIR=~/src/my-project npm start
```

## What success looks like

After `test:boot` passes, you should see:

```
booting…
✓ boot to login prompt in 37.2s
✓ root login (bash)
✓ /workspace mounted from second disk (ext4)
✓ /dev/virtio-ports/pty present
✓ sync-agent service started
✓ guest HELLO: ...
✓ PING acked in ...ms
✓ 10 pings: min ...ms max ...ms
ALL BOOT TESTS PASSED
```

After `npm start`, the Electron window opens. The serial console shows an
Ubuntu login prompt. Typing `root` / `root` logs you into the guest.

## Cleaning up

Everything is local to the clone. Remove it with:

```sh
cd /tmp  # or wherever
rm -rf valencebox
```

Docker images can be cleaned separately:

```sh
docker rmi sandbox-guest 2>/dev/null
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `otool` shows Homebrew paths | Dylib bundling failed in step 2; rebuild QEMU |
| QEMU crashes with "no suitable firmware" | Missing `pc-bios/` files in `resources/qemu/darwin/` |
| `qemu-img` not found | Bundled `qemu-img` missing and none on `$PATH` |
| Docker build fails on `mkfs.ext4` | Docker not running or not x86-64 emulation capable |
| `npm run test:boot` hangs | Entropy starvation (missing virtio-rng); check for `/dev/random` blocking in serial log |
| `npm run test:ui` fails | No display server; needs `DISPLAY` on Linux |
