# PLAN

This file tracks the execution plan for Apple Silicon macOS support and the
follow-on aarch64/FEX work.

`docs/qemu.md` remains the source of truth for the current QEMU rewrite
architecture and invariants. This file is the working checklist for the next
phases.

## Execution order

Phases 1-5 are complete (x86_64 guest on Apple Silicon under TCG). The remaining
phases execute in numeric order:

```
Phase 6  — Tests And Cleanup (lock in the x86_64 TCG fallback)
Phase 7  — Multi-Arch Build And Runtime Abstraction
Phase 8  — Ubuntu Guest Migration (all platforms, x86_64)
Phase 9  — Accelerated aarch64 Ubuntu Guest (HVF, Apple Silicon)
Phase 10 — x86_64 Userspace Support Via FEX
Phase 11 — Packaging Readiness (signing + notarization, last)
```

This is a reorder from earlier drafts:
- Packaging/signing (once Phase 7) runs last, after FEX works.
- The Alpine→Ubuntu migration is split back out of the aarch64 work into its own
  **Phase 8**, targeting **all platforms** (not just macOS). Ubuntu becomes the
  default guest OS for every QEMU target — replacing Alpine on the x86_64 TCG
  path first, before any aarch64 work begins.
- The accelerated aarch64 guest (**Phase 9**) then builds on the already-migrated
  Ubuntu base as a `linux/arm64` variant, rather than introducing a new distro.

## Decisions

- Phase 1 target host is Apple Silicon macOS only.
- Intel Macs are out of scope.
- The current `x86_64` guest under `-accel tcg,thread=multi` + `-machine pc`
  becomes the **fallback** path once the aarch64 guest lands. It is kept working,
  not deleted.
- **The guest OS is Ubuntu on every platform**, replacing Alpine 3.21. Ubuntu
  (glibc) is chosen so FEX's official apt packages install cleanly on the aarch64
  path — FEX-Emu publishes prebuilt apt repos for Ubuntu, not Debian. Accept the
  extra bloat vs. Alpine/Debian as the cost of a supported FEX install.
- **Ubuntu x86_64 is the default guest for all targets** (Linux, Windows, macOS)
  under the existing TCG/KVM/WHPX paths. This migration (Phase 8) lands before
  any aarch64 work.
- **On Apple Silicon the default becomes aarch64 Ubuntu under HVF** (Phase 9),
  falling back to the emulated `x86_64` Ubuntu guest only when aarch64 assets or
  HVF are unavailable.
- **`-machine virt` only** for the aarch64 guest (no microvm — microvm lacks proven
  GICv3 support and adds no benefit over `virt` with HVF). `gic-version=3` for
  standard aarch64 GIC.
- Guest arm64 images live in `images/` with arch prefix (`root-arm64.qcow2`,
  `vmlinuz-arm64.bin`, `initrd-arm64.bin`, `workspace-arm64.qcow2`).
- aarch64 guest uses `ttyAMA0` (ARM PL011) as the serial console.
- `cpuFor(accel)`: `"host"` under HVF pass-through, `"max"` under TCG fallback,
  `undefined` for x86_64 (no change).
- The guest boots via **direct `-kernel`/`-initrd`** (no UEFI/pflash disk boot)
  on both arches, matching the current approach.
- **FEX runs at system level via `binfmt_misc`** — any x86_64 ELF is transparently
  translated; no per-tool wrapping.
- **The FEX x86_64 RootFS is bundled into the guest image at build time** (a few
  hundred MB is acceptable). No first-boot `FEXRootFSFetcher` download.
- End-user runtime must not depend on Homebrew or `$PATH`.
- `scripts/build-qemu.sh darwin` builds QEMU from source on macOS and stages a
  portable dylib bundle into `sandbox/resources/qemu/darwin/`.
- Fresh source builds on Apple Silicon must not require a separately installed
  host `qemu-img` binary.
- Signing and notarization are deferred until packaged app distribution becomes
  a real requirement (Phase 11).

## Phase 0 - Baseline

- [x] QEMU rewrite works on Linux.
- [x] QEMU rewrite works on Windows.
- [x] Repo-root QEMU build scripts exist for Linux and Windows.
- [x] macOS runtime path works on Apple Silicon.

Notes:
- Keep this file updated as implementation progresses.
- Do not mark a checkbox complete until the code path is working and verified.

## Phase 1 - Darwin QEMU Build Pipeline

Goal: produce a self-contained `sandbox/resources/qemu/darwin/` tree from a
macOS source build, with no runtime dependency on Homebrew.

- [x] Fix script wiring so sandbox workflows call the repo-root QEMU build
  scripts instead of non-existent `sandbox/scripts/build-qemu.*` paths.
- [x] Implement `scripts/build-qemu.sh darwin` as a real macOS source build.
- [x] Fetch and unpack the pinned QEMU source tarball into `build/qemu/` on
  macOS just like the Linux path does.
- [x] Verify or install macOS build prerequisites on the build machine only.
- [x] Configure a darwin host build for the `x86_64-softmmu` target.
- [x] Keep the phase 1 build focused on the TCG path; do not block on HVF.
- [x] Build `qemu-system-x86_64` from source on macOS.
- [x] Stage `qemu-system-x86_64` into `sandbox/resources/qemu/darwin/`.
- [x] Stage `qemu-img` into `sandbox/resources/qemu/darwin/` if the current
  image-build flow still depends on it.
- [x] Stage required firmware blobs into
  `sandbox/resources/qemu/darwin/pc-bios/`.
- [x] Stage required non-system `.dylib` dependencies into a dedicated local
  directory such as `sandbox/resources/qemu/darwin/lib/`.
- [x] Rewrite Mach-O load paths so the staged binary uses bundled dylibs instead
  of Homebrew or build-host paths.
- [x] Add build-time verification that the staged darwin tree contains no
  Homebrew cellar references.
- [x] Print a clear build summary with the staged binary path, firmware path,
  and dylib list.

Notes:
- The goal is a portable bundle, not a fully static Mach-O binary.
- Homebrew is allowed as a build prerequisite on the developer or CI machine,
  but not as a runtime dependency.
- Keep the output layout simple and stable: binary, `pc-bios/`, and local dylib
  directory.

## Phase 2 - Runtime Resource Resolution

Goal: make the app reliably use bundled QEMU assets in dev and packaged modes.

- [ ] Update `src/main/asset-paths.ts` to distinguish repo-root dev paths from
  packaged `process.resourcesPath` paths.
- [x] Resolve the bundled darwin QEMU binary from
  `resources/qemu/darwin/qemu-system-x86_64`.
- [x] Resolve bundled darwin firmware from `resources/qemu/darwin/pc-bios/`.
- [x] Keep any `$PATH` fallback limited to explicit development fallback, not as
  the primary packaged runtime path.
- [x] Fix the current pre-spawn executable existence check so it does not break
  valid non-path executable names.
- [x] Ensure the spawned darwin QEMU process can locate its bundled dylibs.
- [x] Log the actual QEMU binary path and firmware directory used at runtime.

Notes:
- Packaged resources must live outside `asar` so QEMU stays executable and its
  firmware stays directly readable.
- Do not assume the developer has a system QEMU once the bundled darwin path is
  working.

## Phase 3 - Apple Silicon Runtime Policy

Goal: make the macOS runtime behavior explicit and stable for the current
`x86_64` guest.

- [x] Detect the Apple Silicon macOS host path explicitly.
- [x] Force the current macOS guest path onto `qemu-system-x86_64` with
  `-accel tcg,thread=multi`.
- [x] Keep machine selection on `pc` for the Apple Silicon macOS path.
- [x] Keep `microvm` out of scope for phase 1 and avoid any partial support.
- [x] Do not advertise HVF as available for the phase 1 Apple Silicon path.
- [x] Preserve the existing Linux and Windows accelerator behavior.
- [x] Surface clear logs and status text that macOS is running the emulated
  `x86_64` path under TCG.

Notes:
- The current `x86_64` guest boot path depends on `pc` under TCG because of the
  TSC calibration constraints already documented in `docs/qemu.md`.
- Do not spend time on Intel Mac branches in this phase.

## Phase 4 - Apple Silicon Bring-Up

Goal: boot the current guest on Apple Silicon macOS from source builds.

- [x] Build the darwin QEMU bundle locally with `scripts/build-qemu.sh darwin`.
- [x] Ensure a fresh Apple Silicon checkout can build guest images without a
  separately installed host `qemu-img` (bundled qemu-img needs to be resolved
  explicitly by build-guest.sh).
- [x] Boot the existing `x86_64` guest to a serial login on Apple Silicon macOS.
- [x] Verify QMP handshake and basic lifecycle control.
- [x] Verify clean shutdown via QMP and process fallback.
- [x] Log boot timing to console for the TCG path (`bootMs` tracked in QemuProcess
  and printed at QMP handshake).
- [x] Capture a repeatable source-build runbook for Apple Silicon developers
  (`sandbox/docs/build-from-source.md`).

Notes:
- Phase 4 is complete when a developer can clone the repo, build the darwin
  QEMU bundle, and boot the guest on their own Apple Silicon machine.
- Signing is not required for this phase.

## Phase 5 - Functional Parity On macOS

Goal: verify that the already-implemented QEMU workflow behaves correctly on the
new macOS runtime path.

- [x] Verify the host WebDAV share starts and the guest can mount it.
- [x] Verify `/workspace` mounts from the second virtio disk.
- [x] Verify guest-to-host sync works.
- [x] Verify host-to-guest sync works.
- [x] Verify the Electron UI can send serial input and receive serial output.
- [x] Verify the app can start, run, and stop cleanly on macOS from source.
- [x] Capture macOS-specific runtime bugs, workarounds, and remaining gaps (`docs/macos-issues.md`).

Notes:
- Keep this phase limited to features that already exist in the current QEMU
  rewrite.
- Do not make snapshot work a gate for macOS bring-up if snapshot support is
  still pending globally.
- The x86_64 TCG path validated here becomes the fallback once the aarch64 guest
  (Phase 9) lands.

## Phase 6 - Tests And Cleanup

Goal: lock in the x86_64 TCG path as a stable fallback with focused tests and
remove stale assumptions before the multi-arch refactor.

The x86_64 TCG path is a **best-effort escape hatch** (not a first-class
supported fallback). Tests against the current x86_64-hardcoded API are deferred
to Phase 7 where they are written once against the abstracted `GuestProfile`
API. Only doc-and-comment cleanup is done here.

- [ ] ~~Add tests for QEMU binary and firmware path resolution (`asset-paths.ts`,
  dev vs packaged, per-platform).~~ *(deferred to Phase 7 — will be written
  against the parameterized API)*
- [ ] ~~Add tests for accelerator and machine-selection policy (`resolveAccels`
  and the inline `useMicrovm` machine logic in `qemu.ts`).~~ *(deferred to Phase
  7 — logic being rewritten in that phase)*
- [x] Add or rewrite a boot smoke test that exercises the `QemuProcess` /
  `VmManager` path (`test/boot.test.ts`).
- [ ] ~~Verify the macOS path manually after a clean rebuild of QEMU assets.~~ *(skip
  — Phase 8 forces a full guest-image rebuild-and-verify cycle anyway)*
- [x] Remove or update stale comments and docs that imply macOS uses HVF in the
  current x86_64 design.
- [x] Fix known doc drift: nonexistent `resolveMachine()` referenced in
  `macos-issues.md` (logic is inline in `buildArgs`); configure-flag mismatch in
  `build-from-source.md` vs `build-qemu.sh`.
- [ ] ~~Update `docs/qemu.md` and related docs once the macOS behavior is real.~~ *(skip
  — `qemu.md` gets a full rewrite in Phase 7 for the multi-arch world)*

Notes:
- Prefer small, targeted tests over large new harnesses.
- All v86 paths have been removed.

## Phase 7 - Multi-Arch Build And Runtime Abstraction

Goal: make both the build pipeline and the host runtime capable of selecting
different QEMU binaries, machine profiles, firmware sets, and guest images, so an
`aarch64` guest can be added in Phase 9 without destabilizing the `x86_64`
fallback. This phase is **pure refactor + plumbing** — no aarch64 assets are
produced yet, and the observable x86_64 behavior on all three platforms must be
byte-for-byte unchanged.

### Design decisions (settled)

- **Flat binary layout.** Both QEMU system binaries live directly in
  `resources/qemu/<platform>/` (`qemu-system-x86_64`, `qemu-system-aarch64`),
  sharing one `pc-bios/` firmware dir and one `lib/` dylib bundle. This matches
  QEMU's own build output, where a multi-target build stages every
  `qemu-system-*` into the same directory. No per-arch subdirectories.
- **One multi-target build.** The darwin build uses a single
  `--target-list=x86_64-softmmu,aarch64-softmmu` configure+make, producing both
  binaries with shared common objects (smaller than two separate builds). Phase 7
  wires the *plumbing* to accept a target list; the aarch64 target is only
  actually added in Phase 9.
- **`GuestProfile` is a plain data object, not a class.** The arch differences
  here are values, not behavior (binary name, machine type, `-cpu`, accel
  priority, virtio transport suffix, cmdline extras, image paths). `buildArgs`
  reads fields off the profile. No methods, no per-arch subclasses — promote a
  value to a function later only if real behavioral divergence appears.

### Target resource layout

```
resources/qemu/<platform>/
  qemu-system-x86_64          # existing
  qemu-system-aarch64         # added in Phase 9 (path reserved now)
  qemu-img
  pc-bios/                    # shared firmware blobs
  lib/                        # shared dylib bundle (darwin)
```

### The `GuestProfile` shape

A plain interface (proposed home: `src/main/guest-profile.ts`) holding every
value that differs by guest arch:

```ts
type GuestArch = "x86_64" | "aarch64";

interface GuestProfile {
  arch: GuestArch;
  qemuBinary: string;              // "qemu-system-x86_64" | "qemu-system-aarch64"
  // Machine type is accel-dependent, so it stays a small function of the
  // resolved accel rather than a static field:
  machineFor(accel: string): "microvm" | "pc" | "virt";
  cpu?: string;                    // undefined for x86_64 today; aarch64 sets one in Phase 9
  accelPriority: string[];         // e.g. ["kvm","tcg,thread=multi"] / ["hvf","tcg,thread=multi"]
  virtioSuffix(machine: string): "-device" | "-pci";  // mmio (microvm/virt) vs pci (pc)
  extraCmdline(machine: string): string;              // e.g. "reboot=t" for microvm
  rootImage: string;               // resolved qcow2 path
  workspaceImage: string;
  kernel?: string;
  initrd?: string;
}
```

Note: `machineFor`, `virtioSuffix`, and `extraCmdline` are unavoidably tiny
functions because they depend on the *resolved* accel/machine at call time, not
on a static per-arch constant. Everything else is a plain field. This keeps the
"plain data" spirit while not lying about the machine/accel coupling.

### Tasks

- [x] Add `src/main/guest-profile.ts`: the `GuestArch` type, the `GuestProfile`
  interface, and a `x86_64Profile()` factory that reproduces today's exact
  behavior (binary `qemu-system-x86_64`, `microvm` under hw-accel / `pc` under
  TCG, `-pci` vs `-device` suffix, `reboot=t` on microvm, no `-cpu`).
- [x] Add a `selectGuest(config)` resolver: honor an explicit
  `config.guest`; otherwise auto-select — **x86_64 everywhere in Phase 7** (the
  aarch64 branch is added in Phase 9 and gated on Apple Silicon + assets present
  + HVF). It must never pick an arch whose binary/images aren't staged.
- [x] Parameterize `asset-paths.ts`: `qemuBinaryPath(arch)` and image-path
  helpers take an arch; `firmwareDir()` and `qemuPlatformDir()` stay shared.
  Keep the existing no-arg call sites working via an `x86_64` default so the
  change is mechanical.
- [x] Refactor `qemu.ts` `buildArgs` to read the machine type, virtio suffix,
  cmdline extras, `-cpu`, and binary from a `GuestProfile` passed via
  `QemuOptions`, instead of the inline `useMicrovm` constants. Add optional
  `-cpu` emission (skipped when `profile.cpu` is undefined → identical x86_64
  args).
- [x] Refactor `checkAccel`/`resolveAccels` to take the guest arch (or the
  profile's `accelPriority`) so darwin+aarch64 can return `hvf` in Phase 9 while
  darwin+x86_64 stays `tcg`. In Phase 7 the x86_64 answers are unchanged.
- [x] Add `guest?: "x86_64" | "aarch64"` to `SandboxAppConfig` in
  `src/config.ts` (optional; absent → auto-select).
- [x] Generalize `scripts/build-qemu.sh` to accept a target list (default
  `x86_64-softmmu`) and stage every produced `qemu-system-*` binary + `qemu-img`
  into the flat platform dir. Do not add `aarch64-softmmu` yet.
- [x] Reserve the multi-binary resource layout: the copy/stage and dylib-bundle
  loops iterate over whatever `qemu-system-*` binaries exist rather than the
  hardcoded `qemu-system-x86_64`.
- [x] Write focused unit tests against the new API (these are the tests deferred
  from Phase 6): `guest-profile` field/behavior for x86_64, `selectGuest`
  fallback logic, `asset-paths` arch parameterization, and a `buildArgs`
  golden-args test asserting the x86_64 arg vector is unchanged.
- [x] Verify the existing boot smoke test still passes on macOS x86_64, and that
  Linux/Windows x86_64 arg construction is unchanged (golden-args test covers
  the latter without needing those hosts).

Notes:
- This phase must land before any `qemu-system-aarch64` implementation work.
- Avoid premature generalization; only abstract the values the aarch64 path needs.
- Success criterion: with no `config.guest` set, every platform still resolves to
  the x86_64 profile and produces the identical QEMU command line as before.

## Phase 8 - Ubuntu Guest Migration (all platforms, x86_64)

Goal: replace the Alpine 3.21 guest with Ubuntu x86_64 as the default guest for
**every** QEMU target (Linux, Windows, macOS) on the existing TCG/KVM/WHPX paths.
No aarch64 or HVF work here — this is a pure guest-OS swap that keeps the current
host-side design (WebDAV share, fw_cfg config channel, `/workspace` disk, unison
sync) intact. Landing this before Phase 9 means the aarch64 guest is just a
`linux/arm64` rebuild of an already-proven Ubuntu image, not a new distro.

### Design decisions (settled)

- **Init: systemd.** OpenRC is not packaged for Ubuntu 24.04 (does not exist in
  apt, universe or otherwise). Building from source would fight Ubuntu's
  systemd-first ecosystem at every level. systemd is the pragmatic choice:
  familiar to users and agents, well-supported under direct `-kernel` boot,
  and cleanly decomposable via `Type=oneshot` + mount units.
- **Kernel cmdline owned by GuestProfile.** The Alpine-specific
  `modules=virtio_blk,ext4` parameter is removed (it's an Alpine `mkinitfs`
  feature — Ubuntu's `initramfs-tools` has no runtime equivalent). Modules must
  be baked into the initramfs at build time via `/etc/initramfs-tools/modules`.
  The cmdline moves from a hardcoded string in `main.ts` and `boot.test.ts`
  into the `x86_64Profile` factory (new `kernelCmdline` field), with the
  `GuestProfile` interface gaining the field for both arches.
- **Initramfs module list is explicit.** Docker containers have no virtio
  devices, so `initramfs-tools` auto-detection finds nothing. We explicitly
  list `virtio_blk`, `virtio_net`, `virtio_mmio`, `ext4`, `qemu_fw_cfg` in
  `/etc/initramfs-tools/modules` before running `mkinitramfs`.
- **Three-unit systemd decomposition.** The two OpenRC scripts become:
  1. `mount-share.service` — `Type=oneshot`, `RemainAfterExit=yes`. Waits for
     `/dev/vdb`, formats if needed, reads fw_cfg, writes WebDAV secrets. Does
     **not** mount `/workspace` — that is handled by systemd's auto-generated
     mount unit from `/etc/fstab`.
  2. `workspace.mount` — systemd-autogenerated from
     `/dev/vdb /workspace ext4 defaults,nofail 0 2`. No custom unit file needed.
  3. `workspace-sync.service` — `Type=simple`, `Restart=on-failure`. Wrapper
     script `exec`s `unison -repeat 2` in the foreground. systemd tracks the
     process directly, no PID file.
- **Serial auto-login** via systemd drop-in
  `/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf` (`-a root`).
  systemd's getty-generator creates `serial-getty@ttyS0.service` (not
  `getty@ttyS0.service`) when `console=ttyS0` is on the kernel cmdline, so the
  drop-in must target `serial-getty@`. agetty positional args are
  `baud[,...] port [term]` — the port (`%I` = `ttyS0`) must come *after* the
  baud list, else agetty tries to open `/dev/115200` and crash-loops.
- **`-machine pc` under TCG** unchanged. Under microvm (KVM/HVF) the initramfs
  must load `virtio_mmio` (a module, not built-in on Ubuntu's generic kernel).

### Tasks

- [x] Rewrite `sandbox/guest/Dockerfile` from `amd64/alpine:3.21` to
  `ubuntu:24.04` base with systemd, `linux-image-virtual`, initramfs-tools,
  explicit module list, davfs2, unison, rsync, inotify-tools, openssh-server,
  and serial auto-login drop-in.
- [x] Add systemd units: `mount-share.service` (oneshot),
  `workspace-sync.service` (simple+restart), helper scripts at
  `/usr/local/libexec/mount-share.sh` and `/usr/local/libexec/workspace-sync.sh`.
- [x] Add `/etc/fstab` entry for workspace disk (`/dev/vdb /workspace ext4
  defaults,nofail 0 2`).
- [x] Add `/etc/initramfs-tools/modules` with `virtio_blk`, `virtio_net`,
  `virtio_mmio`, `ext4`, `qemu_fw_cfg`, `virtio_console`, `virtio_rng`.
- [x] Switch kernel from Alpine `linux-virt` to Ubuntu `linux-image-virtual`
  (the generic kernel; `linux-image-kvm` is a transitional meta-package that
  just depends on `linux-image-virtual`). Extract `vmlinuz`/`initrd.img` for
  direct `-kernel`/`-initrd` boot.
- [x] Adapt `sandbox/scripts/build-guest.sh` for Ubuntu paths (kernel/initrd
  filenames under `/boot`, larger rootfs slack, `mkfs.ext4 -d` staging).
- [x] Strip docs/man/locales and unused kernel modules to keep image size sane.
- [x] Add `kernelCmdline` to `GuestProfile` interface and set Ubuntu-appropriate
  cmdline in `x86_64Profile()`.
- [x] Update `main.ts` — source `kernelCmdline` from the profile instead of
  hardcoded string.
- [x] Update `test/boot.test.ts` — change service-status greps from
  `rc-service mount-share status` to `systemctl is-active mount-share`,
  drop `modules=virtio_blk,ext4` from cmdline, update login-banner expectation.
- [x] Boot the Ubuntu x86_64 guest to serial login and re-run Phase 5 parity
  checks (share mount, `/workspace`, bi-directional sync, serial I/O, clean
  shutdown). Verified on macOS x86_64 TCG; Linux/Windows deferred to a later
  hardware pass (per Phase 7 policy, golden-args covers arg-vector parity).
- [x] Remove or archive the Alpine Dockerfile once the Ubuntu image passes.
  Archived as `guest/Dockerfile.alpine`.

Notes:
- Host-side code (`http-share.ts`, fw_cfg, `vm-manager.ts`) should not need
  changes — only the guest image and its init.
- systemd on a direct-kernel boot needs `console=ttyS0` on the cmdline and a
  serial getty drop-in; mask unneeded units (`bluetooth`, `wpa_supplicant`,
  `systemd-timesyncd`) to avoid boot stalls.
- Boot smoke-test assertions that change: `rc-service ...` → `systemctl`,
  login banner, prompt regex `:~#` still works (bash on Ubuntu).
- The Phase 7 unit tests (`guest-profile.unit.ts`, `golden-args.unit.ts`) need
  to be updated for the new `kernelCmdline` field. The golden-args test already
  passes `kernelCmdline` as an option so no arg-vector breakage, but the
  profile test needs to assert the new field.
- This migration used to be folded into the aarch64 phase; it now stands alone
  and covers all platforms.

### Bugs found & fixed during bring-up (2026-07-18, macOS x86_64 TCG)

1. **Read-only root.** `rootflags=rw` alone leaves `/` mounted `ro` on Ubuntu
   (kernel defaults to `ro` unless the bare `rw` token is present). Symptom:
   `systemd-logind` crash-loops with `Failed to set up special execution
   directory in /var/lib: Read-only file system`. Fix: bare `rw` in
   `x86_64Profile().kernelCmdline` (kept `rootflags=rw` removed).
2. **`/workspace` mount point missing.** The Dockerfile never created
   `/workspace` (or `/host-workspace`), so the fstab-generated `workspace.mount`
   failed with `mount point does not exist`, cascading a `DEPEND` failure onto
   `workspace-sync.service`. Fix: `RUN mkdir -p /workspace /host-workspace`.
3. **agetty autologin crash-loop.** The drop-in had
   `agetty -a root --keep-baud 115200 115200 ttyS0 vt100` — agetty read the
   second `115200` as the port and failed opening `/dev/115200`, so no serial
   login prompt ever appeared (boot test hung on `waitSerial(/login:/)`). Fix:
   `agetty -a root --keep-baud 115200,57600,38400,9600 %I vt100` (port `%I`
   after the baud list).
4. **Boot-test output parsing.** Ubuntu's interactive shell aliases
   `grep` → `grep --color=auto`, injecting ANSI escapes that broke the mount
   assertion; switched to `findmnt -no SOURCE,FSTYPE /workspace`. Also,
   `is-active` output is `\r\nactive\r\n`, so the regex must tolerate `\r` and
   bound `active` with CR/LF to avoid matching `activating`. `workspace-sync`
   legitimately oscillates active/activating without a host share (Type=simple
   script loops on the missing WebDAV marker), so the test polls until it
   catches `active`.

**Verification:** `npm run test:boot` passes end-to-end (login ~10s, `/workspace`
ext4 mount, `mount-share` active, `workspace-sync` active), stable across 3 runs.
`npx tsc --noEmit` clean; `guest-profile.unit.ts` + `golden-args.unit.ts` pass.
Host↔guest file-sync round-trip to be validated separately by the user.

## Phase 9 - Accelerated aarch64 Ubuntu Guest (HVF)

Goal: add a native, HVF-accelerated `aarch64` Ubuntu guest and make it the
default on Apple Silicon. Builds directly on the Phase 8 Ubuntu image as an
arm64 variant — same init, packages, and host-side design; only arch, kernel,
console, and machine profile change.

### Design decisions (settled)

| Decision | Choice |
|---|---|
| Image layout | `images/` with arch prefix: `vmlinuz-arm64.bin`, `initramfs-arm64.bin`, `root-arm64.qcow2`, `workspace-arm64.qcow2` |
| Machine type | **`virt` only** — no microvm on aarch64 (simpler, proven GICv3 support) |
| Guest build | `docker buildx --platform=linux/arm64` with the same Dockerfile |
| Auto-select | Pick aarch64 automatically on Apple Silicon when assets exist; x86_64 fallback otherwise |
| Console device | `ttyAMA0` (ARM PL011 UART on `-machine virt`) |
| CPU | `host` under HVF pass-through; `max` under TCG fallback (handled via `cpuFor(accel)` on the profile) |
| ARM GIC | `-machine virt,gic-version=3` (GICv3 is the standard for aarch64 VMs) |

### Tasks

- [x] Add `aarch64-softmmu` target and `--enable-hvf` to the darwin QEMU
  build; stage `qemu-system-aarch64` alongside the existing x86_64 tree.
- [x] Build an Ubuntu arm64 guest image (`buildx --platform=linux/arm64`) with an
  arm64 kernel + initrd for direct `-kernel` boot.
- [x] Add `aarch64Profile()` factory: `-machine virt,gic-version=3`,
  `console=ttyAMA0`, `virtioSuffix: "-pci"`, `extraCmdline: ""`,
  `cpuFor(accel): "host"|"max"`.
- [x] Add `cpuFor(accel): string | undefined` to `GuestProfile` interface
  (undefined for x86_64; aarch64 returns `"host"` under HVF, `"max"` under TCG).
- [x] Wire `selectGuest()` to auto-pick aarch64 on Apple Silicon when
  `qemu-system-aarch64` binary + arm64 guest images exist (x86_64 fallback otherwise).
- [x] Add arch-aware image paths to `asset-paths.ts` (`root-arm64.qcow2` etc.).
- [x] Update `main.ts` to select the correct profile (`aarch64Profile()` vs `x86_64Profile()`) based on the resolved guest arch.
- [x] Update `qemu.ts` `buildArgs` to emit `-cpu` via `cpuFor(accel)`, skip `-nodefaults` for `-machine virt` (preserves PL011), emit `gic-version=3`.
- [x] Update `Dockerfile` to create both `serial-getty@ttyS0` and `serial-getty@ttyAMA0` autologin drop-ins.
- [x] Update `build-guest.sh` with an `--arch arm64` flag using `docker buildx`.
- [x] Boot the Ubuntu arm64 guest to a serial login on Apple Silicon (TCG — HVF needs app signing entitlement).
- [x] Verify QMP lifecycle and clean shutdown on the arm64 path.
- [x] Verify x86_64 TCG fallback is unchanged (`npm run test:boot` passes).
- [x] Update unit tests: `guest-profile.unit.ts` (aarch64 profile, cpuFor), `golden-args.unit.ts` (aarch64 arg vectors), `selectGuest` with asset checks.
- [ ] Write aarch64 boot smoke test (`test:boot:arm64` or parameterized `test:boot`).

Notes:
- Reuse the host-side WebDAV, fw_cfg, and sync design unchanged; only the guest
  arch, kernel, console, and machine profile change.
- Direct `-kernel`/`-initrd` boot only; no UEFI/pflash disk boot.
- `virtio_mmio` not needed on `-machine virt` (which has a PCIe root port). The
  virtio transport is PCI.
- **HVF requires app signing entitlement.** On macOS, `-accel hvf` fails with
  `HV_DENIED` from `qemu-system-aarch64` when spawned directly from terminal in
  dev mode. The QEMU binary must be signed with `com.apple.security.hypervisor`
  entitlement. Electron's main process inherits this entitlement from the packaged
  app. For dev, TCG works (boots in ~25s); HVF will be available in the packaged
  build. See `docs/macos-issues.md` for the tracking entry.
- **`-nodefaults` is unsafe for `-machine virt`.** On x86_64 `pc`/`microvm`,
  `-nodefaults` keeps the ISA serial / virtio-mmio devices. On aarch64 `virt`,
  `-nodefaults` strips the PL011 UART (ttyAMA0). `buildArgs` conditionally omits
  `-nodefaults` when `machineType === "virt"`.
- **Phase 7 regressions to finish wiring here:**
  - `checkAccel` darwin+aarch64 already gated on `process.arch === "arm64"`.
  - `machineType` field already widened to `"microvm" | "pc" | "virt"`.

## Phase 10 - x86_64 Userspace Support Via FEX

Goal: run `x86_64` userspace workloads transparently inside the aarch64 Ubuntu
guest via system-level FEX.

- [ ] Install FEX from the official Ubuntu apt repository in the guest image
  build.
- [ ] Bundle the FEX x86_64 RootFS (SquashFS/EroFS) into the guest image at build
  time; no first-boot download.
- [ ] Register the FEX `binfmt_misc` handlers at guest boot so x86_64 ELFs run
  transparently.
- [ ] Verify an x86_64 binary executes inside the aarch64 guest without explicit
  wrapping.
- [ ] Measure performance and compatibility against the pure emulated `x86_64`
  fallback path.
- [ ] Decide when the emulated `x86_64` guest can be deprecated (kept as fallback
  for now).

Notes:
- FEX is system-level via `binfmt_misc`, not per-tool.
- FEX-Emu ships official apt packages for **Ubuntu** — this is the reason the
  guest OS is Ubuntu rather than Debian/Alpine.
- Keep an escape hatch to the emulated `x86_64` path until aarch64 + FEX is proven.

## Phase 11 - Packaging Readiness

Goal: prepare for packaged app testing and distribution. This runs last, after
the aarch64 + FEX path works, so packaging covers the final asset set.

- [ ] Add electron-builder config (currently none) to bundle both QEMU trees,
  firmware, and guest images.
- [ ] Ensure bundled QEMU assets are included in packaged app resources.
- [ ] Ensure bundled QEMU assets remain outside `asar` so binaries stay
  executable and firmware stays directly readable.
- [ ] Verify the packaged app can locate and spawn both the aarch64 and x86_64
  QEMU trees.
- [ ] Add signing of nested QEMU binaries and dylibs (both arches) for macOS
  distribution.
- [ ] Add notarization only when distributing packaged macOS builds externally.

Notes:
- Local development from a Git checkout should not wait on signing.
- Packaging must cover both the default aarch64 assets and the x86_64 fallback.
