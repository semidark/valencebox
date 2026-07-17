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
Phase 8  — Accelerated aarch64 Ubuntu Guest (HVF)
Phase 9  — x86_64 Userspace Support Via FEX
Phase 10 — Packaging Readiness (signing + notarization, last)
```

This is a reorder from an earlier draft: packaging/signing (previously Phase 7)
now runs last, after FEX works. The old "Debian x86_64 migration" phases are
folded into Phase 8 — there is no separate x86_64-Alpine-to-Debian step; the new
accelerated guest is Ubuntu arm64 from the start.

## Decisions

- Phase 1 target host is Apple Silicon macOS only.
- Intel Macs are out of scope.
- The current `x86_64` guest under `-accel tcg,thread=multi` + `-machine pc`
  becomes the **fallback** path once the aarch64 guest lands. It is kept working,
  not deleted.
- **The default guest on Apple Silicon is aarch64 under HVF**, falling back to the
  emulated `x86_64` guest only when aarch64 assets or HVF are unavailable.
- Prefer `-machine microvm` for the aarch64 guest if it works under HVF; otherwise
  use `-machine virt`. Decide when Phase 8 reaches bring-up.
- The aarch64 guest is **Ubuntu arm64** (glibc), chosen so FEX's official apt
  packages install cleanly.
- The aarch64 guest boots via **direct `-kernel`/`-initrd`** (no UEFI/pflash disk
  boot), matching the current x86_64 approach.
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
  a real requirement (Phase 10).

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
  (Phase 8) lands.

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
  `VmManager` path rather than the legacy `v86` VM path (`test/boot.test.ts`).
- [ ] ~~Verify the macOS path manually after a clean rebuild of QEMU assets.~~ *(skip
  — Phase 8 forces a full rebuild-and-verify cycle anyway)*
- [x] Remove or update stale comments and docs that imply macOS uses HVF in the
  current x86_64 design.
- [x] Fix known doc drift: nonexistent `resolveMachine()` referenced in
  `macos-issues.md` (logic is inline in `buildArgs`); configure-flag mismatch in
  `build-from-source.md` vs `build-qemu.sh`.
- [ ] ~~Update `docs/qemu.md` and related docs once the macOS behavior is real.~~ *(skip
  — `qemu.md` gets a full rewrite in Phase 7 for the multi-arch world)*

Notes:
- Prefer small, targeted tests over large new harnesses.
- Keep legacy `v86` paths out of new macOS validation work.

## Phase 7 - Multi-Arch Build And Runtime Abstraction

Goal: make both the build pipeline and the host runtime capable of selecting
different QEMU binaries, machine profiles, firmware sets, and guest images, so an
`aarch64` guest can be added without destabilizing the `x86_64` fallback.

- [ ] Introduce a `GuestProfile` abstraction capturing every arch-specific value
  (qemu binary name, machine type, `-cpu`, accel priority, firmware, console
  device, virtio transport, kernel/initrd/root image paths).
- [ ] Parameterize `asset-paths.ts` binary + firmware resolution by arch (drop
  the hardcoded `qemu-system-x86_64` / `pc-bios` assumptions).
- [ ] Refactor `qemu.ts` `buildArgs` to drive off the profile; add support for
  `-cpu` selection and an arch-aware console/cmdline.
- [ ] Refactor `checkAccel` so darwin+aarch64 returns `hvf` while darwin+x86_64
  stays `tcg`.
- [ ] Add a `guest: "aarch64" | "x86_64"` selector in `config.ts`, auto-selecting
  aarch64 on Apple Silicon with x86_64 fallback.
- [ ] Introduce a build-script abstraction for selecting and staging multiple
  QEMU system binaries and their matching firmware sets.
- [ ] Introduce a resource-layout convention that holds more than one QEMU system
  binary + firmware + guest image set.
- [ ] Preserve the existing `x86_64` path while adding the new abstractions.
- [ ] Verify the abstractions still keep Linux, Windows, and macOS `x86_64`
  working.

Notes:
- This phase must land before any `qemu-system-aarch64` implementation work.
- Avoid premature generalization; only abstract the values the aarch64 path needs.

## Phase 8 - Accelerated aarch64 Ubuntu Guest (HVF)

Goal: add a native, HVF-accelerated `aarch64` Ubuntu guest and make it the
default on Apple Silicon. This folds in the former "Debian migration" phases —
the new guest is Ubuntu arm64 from the start; there is no x86_64-guest migration.

- [ ] Add an `aarch64-softmmu` target and `--enable-hvf` to the darwin QEMU
  build; stage `qemu-system-aarch64` alongside the existing x86_64 tree.
- [ ] Build an Ubuntu arm64 guest image (`buildx --platform=linux/arm64`) with an
  arm64 kernel + initrd for direct `-kernel` boot.
- [ ] Select `-machine microvm` under HVF if viable; otherwise `-machine virt`.
- [ ] Boot the Ubuntu arm64 guest to a serial login on Apple Silicon under HVF
  (`console=ttyAMA0`, root on `/dev/vda`).
- [ ] Restore the WebDAV share, fw_cfg config channel, `/workspace` mount, and
  unison sync on the arm64 guest.
- [ ] Verify QMP lifecycle and clean shutdown on the arm64 path.
- [ ] Keep the emulated `x86_64` guest available as the documented fallback.

Notes:
- Reuse the host-side WebDAV, fw_cfg, and sync design unchanged; only the guest
  arch, kernel, console, and machine profile change.
- Direct `-kernel`/`-initrd` boot only; no UEFI/pflash disk boot.

## Phase 9 - x86_64 Userspace Support Via FEX

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
- Keep an escape hatch to the emulated `x86_64` path until aarch64 + FEX is proven.

## Phase 10 - Packaging Readiness

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
