# PLAN

This file tracks the execution plan for Apple Silicon macOS support and the
follow-on Debian/aarch64/FEX work.

`docs/qemu.md` remains the source of truth for the current QEMU rewrite
architecture and invariants. This file is the working checklist for the next
phases.

## Decisions

- Phase 1 target host is Apple Silicon macOS only.
- Intel Macs are out of scope.
- Phase 1 guest remains the current `x86_64` Linux guest.
- Phase 1 macOS runtime uses `qemu-system-x86_64` with `-accel tcg,thread=multi`.
- Phase 1 macOS runtime uses `-machine pc` only.
- `microvm` is out of scope for phase 1.
- End-user runtime must not depend on Homebrew or `$PATH`.
- `scripts/build-qemu.sh darwin` builds QEMU from source on macOS and stages a
  portable dylib bundle into `sandbox/resources/qemu/darwin/`.
- Fresh source builds on Apple Silicon must not require a separately installed
  host `qemu-img` binary.
- Signing and notarization are deferred until packaged app distribution becomes
  a real requirement.

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
- [ ] Verify guest-to-host sync works.
- [ ] Verify host-to-guest sync works.
- [x] Verify the Electron UI can send serial input and receive serial output.
- [ ] Verify the app can start, run, and stop cleanly on macOS from source.
- [ ] Capture macOS-specific runtime bugs, workarounds, and remaining gaps.

Notes:
- Keep this phase limited to features that already exist in the current QEMU
  rewrite.
- Do not make snapshot work a gate for macOS bring-up if snapshot support is
  still pending globally.

## Phase 6 - Tests And Cleanup

Goal: lock in the macOS path with focused tests and remove stale assumptions.

- [ ] Add tests for QEMU binary and firmware path resolution.
- [ ] Add tests for darwin accelerator and machine-selection policy.
- [ ] Add or rewrite a boot smoke test that exercises the `QemuProcess` /
  `VmManager` path rather than the legacy `v86` VM path.
- [ ] Verify the macOS path manually after a clean rebuild of QEMU assets.
- [ ] Remove or update stale comments and docs that imply macOS uses HVF in the
  current phase 1 design.
- [ ] Update `docs/qemu.md` and related docs once the macOS behavior is real.

Notes:
- Prefer small, targeted tests over large new harnesses.
- Keep legacy `v86` paths out of new macOS validation work.

## Phase 7 - Packaging Readiness

Goal: prepare for packaged app testing without making signing a prerequisite for
local development.

- [ ] Ensure bundled QEMU assets are included in packaged app resources.
- [ ] Ensure bundled QEMU assets remain outside `asar`.
- [ ] Verify the packaged app can locate and spawn the bundled darwin QEMU tree.
- [ ] Add signing of nested QEMU binaries and dylibs when packaged app
  distribution becomes necessary.
- [ ] Add notarization only when distributing packaged macOS builds externally.

Notes:
- This phase is intentionally after source-build bring-up.
- Local development from a Git checkout should not wait on signing.

## Phase 8 - Debian Guest Migration Prep

Goal: prepare the current `x86_64` VM infrastructure for a later switch from
Alpine to Debian.

- [ ] Inventory Alpine-specific assumptions in the guest build and boot flow.
- [ ] Inventory OpenRC- and busybox-specific assumptions in guest init and
  service management.
- [ ] Separate guest image naming and kernel/initrd path assumptions from host
  runtime wiring where needed.
- [ ] Decide the Debian guest build approach.
- [ ] Decide the Debian init and service model.
- [ ] Decide the minimum Debian package set needed to preserve the current
  WebDAV and sync model.

Notes:
- Debian migration is a prerequisite for the later FEX-on-aarch64 plan.
- Keep the current host-side WebDAV, fw_cfg, and sync design unless Debian
  forces a concrete change.

## Phase 9 - Debian x86_64 Guest Migration

Goal: replace the Alpine guest with a Debian-based `x86_64` guest while keeping
the current host-side `qemu-system-x86_64` design.

- [ ] Replace the Alpine guest build with a Debian-based guest build.
- [ ] Replace Alpine kernel and initramfs assumptions with Debian equivalents.
- [ ] Replace Alpine package installation and guest provisioning steps.
- [ ] Replace Alpine/OpenRC guest service wiring with the chosen Debian service
  model.
- [ ] Restore serial login, workspace disk mount, WebDAV mount, and sync.
- [ ] Verify the Debian `x86_64` guest on Linux, Windows, and macOS.

Notes:
- Keep this phase on the existing `x86_64` guest architecture.
- Do not mix the `aarch64` VM work into this phase.

## Phase 10 - Multi-Arch Build And Runtime Abstraction

Goal: make both the build pipeline and the host runtime capable of selecting
different QEMU binaries, machine profiles, firmware sets, and guest images.

- [ ] Introduce a build-script abstraction for selecting and staging multiple
  QEMU system binaries.
- [ ] Introduce a resource-layout abstraction that can hold more than one QEMU
  system binary and its matching firmware set.
- [ ] Introduce a packaging abstraction for including multiple QEMU system
  binaries and their resources.
- [ ] Introduce a runtime abstraction for QEMU host binary selection.
- [ ] Introduce a runtime abstraction for guest architecture and machine
  profile.
- [ ] Introduce a runtime abstraction for firmware, kernel, initrd, and image
  paths.
- [ ] Preserve the existing `x86_64` path while adding the new abstractions.
- [ ] Verify the abstractions still keep Linux, Windows, and macOS `x86_64`
  working.

Notes:
- This phase must land before any `qemu-system-aarch64` implementation work.
- This phase should make `qemu-system-aarch64` support possible without
  destabilizing the current `x86_64` path.
- Avoid premature generalization before the Debian guest migration lands.

## Phase 11 - Accelerated aarch64 VM Path

Goal: add a new Apple Silicon path based on an `aarch64` guest VM.

- [ ] Build and bundle the required `qemu-system-aarch64` host artifact.
- [ ] Define the Apple Silicon `aarch64` machine, firmware, and device profile.
- [ ] Boot a Debian arm64 guest on Apple Silicon with hardware acceleration.
- [ ] Restore the host WebDAV share and `/workspace` sync model on the new arm64
  guest path.
- [ ] Keep the existing `x86_64` guest path available until the new arm64 path
  is ready to replace it.

Notes:
- This phase is about the VM architecture change only.
- Do not begin FEX integration until the accelerated arm64 VM path is stable.

## Phase 12 - x86_64 Userspace Support Via FEX

Goal: support `x86_64` userspace workloads inside the new Debian arm64 guest.

- [ ] Install and configure FEX in the Debian arm64 guest.
- [ ] Define the guest-side workflow for running `x86_64` tools under FEX.
- [ ] Verify the expected developer workflows still work in the new guest.
- [ ] Measure performance and compatibility against the pure emulated `x86_64`
  phase 1 path.
- [ ] Decide when the old pure emulated `x86_64` VM path can be deprecated.

Notes:
- FEX support is the last step, not the first.
- Keep an escape hatch to the pure emulated `x86_64` path until the arm64 + FEX
  path is proven.
