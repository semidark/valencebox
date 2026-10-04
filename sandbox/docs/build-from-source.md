# Build From Source (Apple Silicon)

Manual build instructions aligned with the current scripts. The app can use
an aarch64 guest on Apple Silicon, while the current `test:qmp` and `test:boot`
bodies explicitly use x86-64. Building both QEMU targets and image sets below
supports those separate paths; these instructions are not evidence that every
platform or accelerator has been tested.

Architecture selection is asset/config driven, not HVF driven. With ARM assets
selected, forcing `accel: "tcg"` uses **ARM TCG**. The resolver assumes ARM HVF
availability on Apple Silicon; startup initialization failure is not guaranteed
to recover because CPU arguments are chosen before launch. See `qemu.md`.

## Prerequisites

- macOS (Apple Silicon)
- Xcode Command Line Tools (`xcode-select --install`)
- [Homebrew](https://brew.sh)
- Docker with Buildx and Linux amd64/arm64 container support (Docker Desktop or OrbStack); the guest builder uses Docker for filesystem creation and attempts privileged binfmt registration for ARM
- Node.js 20+ (LTS)

Install build-time dependencies for QEMU:

```sh
brew install meson ninja pkg-config pixman glib libslirp zstd
```

## Steps

### 1. Clone

```sh
git clone git@github.com:semidark/valencebox.git
cd valencebox
```

No submodule init needed — the QEMU rewrite removed the old v86 submodule.

### 2. Build both QEMU system targets

```sh
TARGET_LIST=x86_64-softmmu,aarch64-softmmu bash scripts/build-qemu.sh darwin
```

What the current Darwin branch does:
- Fetches QEMU 9.2.4 by default (`QEMU_VERSION` can override), with source at
  `build/qemu/qemu-9.2.4/` and an in-source `build/` directory
- Uses the supplied `TARGET_LIST`, with `--enable-slirp`, `--enable-zstd`,
  `--enable-hvf` and headless macOS flags
- Builds and stages `qemu-system-x86_64`, `qemu-system-aarch64` and `qemu-img`
  under `sandbox/resources/qemu/darwin/`, using `sysctl -n hw.logicalcpu` jobs
- Bundles runtime dylibs into `sandbox/resources/qemu/darwin/lib/`, rewriting
  binary references to `@executable_path/lib/` and dylib dependencies to `@loader_path/`
- Ad-hoc signs the outputs, applying `hvf-entitlement.plist` to the aarch64 binary
- Copies the script's selected firmware blobs into `pc-bios/`

Without `TARGET_LIST`, the script defaults to **x86_64-softmmu only**, even on
Apple Silicon. Enabling HVF in a build does not make the app select x86 HVF;
the macOS resolver uses HVF only for aarch64 on Apple Silicon. Build time depends
on the machine, cache and downloads.

Verify:

```sh
ls -lh sandbox/resources/qemu/darwin/qemu-system-x86_64 sandbox/resources/qemu/darwin/qemu-system-aarch64 sandbox/resources/qemu/darwin/qemu-img
otool -L sandbox/resources/qemu/darwin/qemu-system-x86_64
otool -L sandbox/resources/qemu/darwin/qemu-system-aarch64
otool -L sandbox/resources/qemu/darwin/qemu-img
codesign -d --entitlements :- sandbox/resources/qemu/darwin/qemu-system-aarch64
```

The `otool` output should show `@executable_path/lib/` references, not
Homebrew Cellar paths. Look for:

```
@executable_path/lib/libglib-2.0.0.dylib
@executable_path/lib/libpixman-1.0.dylib
...
```

Homebrew paths in **runtime dependency** entries indicate incomplete bundling.
A bundled dylib's own `LC_ID_DYLIB` identity may still use its original Homebrew
path; that is not itself a runtime dependency. System `/usr/lib/` and `/System/`
references are expected. Check transitive dependencies in the staged `lib/`
directory too; the script's verification output is not a substitute for a
relocation test.

### 3. Build the guest images

```sh
cd sandbox
npm run images:all
```

`images:all` builds **amd64 then arm64**. In contrast, `npm run images` builds
**only the host architecture** (ARM on Apple Silicon); it does not build both.
For a single explicit target, use `npm run images -- --arch amd64` or
`npm run images -- --arch arm64`.

What happens for each target:
- Builds Ubuntu 24.04 from `guest/Dockerfile` (`sandbox-guest` for amd64,
  `sandbox-guest-arm64` for ARM), exports its rootfs and extracts kernel/initramfs
- Creates a sparse qcow2 root with ext4, sized with 25% slack and at least 5 GiB
- Creates an **unformatted** workspace qcow2 (default 1 GiB, configurable with
  `WORKSPACE_MB`); guest `mount-share.service` formats it as ext4 on first boot
- Prefers the bundled Darwin `qemu-img` from step 2, otherwise uses `$PATH`
- Generates `images/vm-debug` SSH keys if absent and embeds the public key

x86 outputs are `root.qcow2`, `workspace.qcow2`, `vmlinuz.bin`, `initramfs.bin`.
ARM outputs use `-arm64`: `root-arm64.qcow2`, `workspace-arm64.qcow2`,
`vmlinuz-arm64.bin`, `initramfs-arm64.bin`.

**Rebuilding replaces the target root and workspace images**, losing changes
stored only in them. Build times vary, especially with cross-architecture Docker
emulation. The script also uses `/tmp/sandbox-rootfs*` scratch paths; its work
is not confined to the clone.

Verify:

```sh
ls -lh images/*.qcow2 images/vmlinuz*.bin images/initramfs*.bin
```

### 4. Install npm deps and build TypeScript

```sh
npm install
npm run build
```

`build` runs `tsc -p .` and `node scripts/copy-renderer.js`, producing
`dist/main/main.js` and renderer assets. `npm start` also runs this build before
launching Electron. No snapshot backend or additional test scripts are generated.

### 5. Run the QEMU smoke tests

The QMP and boot suites below use the **x86-64** profile and default to TCG,
including on Apple Silicon. They are not ARM/HVF smoke tests or a platform
matrix. `ACCEL` can override their accelerator setting. These descriptions come
from the test bodies, not a claim that they were run as part of this docs update.

QMP/boot tests auto-create temporary scratch storage and delete their entire
`SCRATCH` directory during cleanup. Omit `SCRATCH` or use only a dedicated
disposable directory; never point it at a project or shared temp root.

**Quick signal (fastest):**

```sh
npm run test:qmp
```

`test/qmp.test.ts` starts minimal x86 QEMU **frozen at prelaunch** (`-S`), with
no guest kernel/disks. Startup connects QMP and negotiates capabilities; the test
calls `query-status`, prints the result, calls `stop()` and asserts the process
is no longer running. For frozen/non-running status, `stop()` skips
`system_powerdown` and falls back to process termination. Its shutdown log line
is **not proof of graceful QMP guest powerdown**. It does not test guest boot,
balloon behavior, snapshots or the full QMP protocol/error/event surface.

**Full boot test (slow):**

```sh
npm run test:boot
```

`test/boot.test.ts` waits for Ubuntu serial login and **root auto-login**, checks
hostname `sandbox`, `/workspace` mounted from `/dev/vdb` as ext4, and active
`mount-share` / `workspace-sync` systemd units. It does **not** start a host
WebDAV share or proxy and does not verify actual host↔guest synchronization,
PTY traffic, legacy agent HELLO/PING, snapshots or restore. An active sync unit
alone is not evidence that unison is transferring files. Boot time varies; the
login timeout is 120 seconds.

Add `VERBOSE=1` to stream guest serial output:

```sh
VERBOSE=1 npm run test:boot
```

**No current snapshot or snapshot-inclusive end-to-end suite:** `package.json`
has no `test:snapshot` or `test:e2e` scripts. Those names in the rewrite phases
are future proposals. QEMU app snapshots are unimplemented; the legacy
`saveSnapshot` IPC handler is a no-op, and the QMP client is not a snapshot
backend. A future RAM/device restore must also match compatible writable root
and workspace disk state. A host-canonical workspace does not make restoring
old RAM against changed disks safe.

**Other current scripts (separate scopes):** `test:unit` checks profiles and
argument construction without booting a VM; `test:share` checks host WebDAV
auth/CRUD/traversal without a guest. Neither substitutes for a live sync
round-trip or cross-platform VM validation.

**UI smoke script (legacy renderer stub, not QEMU integration):**

```sh
npm run test:ui
```

`test/ui-smoke.js` loads the built renderer with `test/fake-preload.js`, replays
legacy restored/sync/conflict/Wisp status and serial/input events, and checks
DOM/xterm state. The stub does not exercise the live QEMU backend or the full
current PTY/balloon/clipboard API, so it is not a reliable current app acceptance
test. Its hidden/offscreen window still needs a usable Electron display
session (on Linux, a display server such as Xvfb and `DISPLAY`). The harness
uses `contextIsolation: false` and `nodeIntegration: true`, unlike the app:
this is **not a renderer security audit**, nor a snapshot/restore test.

### 6. Launch the app

```sh
npm start
```

Set `WORKSPACE_DIR` to an existing host directory to serve it over WebDAV and
mirror it into the guest's native `/workspace` disk (not a live passthrough
mount). An explicit `workspaceDir` in app config takes precedence:

```sh
WORKSPACE_DIR=~/src/my-project npm start
```

## What success looks like

A successful `test:boot` run reports these checks (elapsed time varies):

```text
booting...
✓ boot to login prompt in <elapsed>s
✓ root login (bash)
✓ hostname set
✓ /workspace mounted from second disk (ext4)
✓ mount-share service started
✓ workspace-sync service started
ALL BOOT TESTS PASSED
```

After `npm start`, the Electron window should show serial boot output and then
the PTY login shell when its daemon is ready; serial root auto-login is the
fallback. No `root` / `root` password entry is required. A working terminal or
app `ready` status does not by itself verify workspace sync or egress isolation.
On Apple Silicon the app auto-selects ARM when its binary/root image are staged
(unless `guest` is explicitly configured); the matching kernel/initramfs and
workspace must also exist. ARM uses `virt` with PCI virtio devices under HVF or
TCG. x86 `tcg,thread=multi` (forced `accel: "tcg"`) selects `pc`; macOS x86
auto mode instead emits bare `tcg` first and currently maps that to `microvm`.
Resolved x86 hardware acceleration also selects `microvm`. This auto-mode
mapping gap is not a verified boot path; see `qemu.md` for fallback caveats.

## Cleaning up

Stop the app before removing generated outputs. QEMU build caches live under
repo-root `build/qemu/`; staged binaries and guest images live in `sandbox/`.
The guest builder also uses `/tmp/sandbox-rootfs*` scratch paths and Docker
images/containers. App runtime state (config, logs and optional MITM CA) lives
in Electron's `userData` directory, not solely in the clone.

Guest Docker images can be cleaned separately when no longer needed:

```sh
docker rmi sandbox-guest sandbox-guest-arm64
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `otool` shows Homebrew runtime dependencies | Dylib bundling failed in step 2; rebuild QEMU (a dylib's own identity path is not a runtime dependency) |
| QEMU crashes with "no suitable firmware" | Missing `pc-bios/` files in `resources/qemu/darwin/` |
| `qemu-img` not found | Bundled `qemu-img` missing and none on `$PATH` |
| Missing x86 images after `npm run images` on Apple Silicon | That command builds ARM only; use `images:all` or `images -- --arch amd64` for the current boot test |
| App unexpectedly selects x86-64 | Check explicit `guest` config and staged aarch64 binary/root image; HVF absence alone does not change architecture |
| ARM HVF startup fails | Check the binary's HVF entitlement and host support; force `accel: "tcg"` in app config for ARM TCG (test `ACCEL` does not configure the app) |
| Docker filesystem creation fails | Ensure Docker/Buildx works for the selected Linux architecture; the builder also invokes an amd64 cleanup container |
| `npm run test:boot` hangs | Use `VERBOSE=1`, check x86 assets, kernel/initramfs, serial login and systemd service state; an active sync unit does not prove sync |
| `npm run test:ui` fails | Build renderer assets first, provide a display session (`DISPLAY` on Linux), and account for the legacy stub/API expectations; not a QEMU or security verdict |
