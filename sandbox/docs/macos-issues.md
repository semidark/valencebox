# macOS (Apple Silicon) — Known Issues, Workarounds, And Gaps

Captured during Phase 1+2 Apple Silicon bring-up (Phases 4-5 of PLAN.md). This
doc lives alongside `build-from-source.md` and `qemu.md`.

---

## 1. No HVF For x86_64 Guests On ARM Hosts

**Issue.** Apple's `Hypervisor.framework` on Apple Silicon only exposes
`aarch64` CPU virtualization. `qemu-system-x86_64 -accel hvf` on an ARM Mac
fails with `"HVF is not supported on this machine"`.

**Impact.** The x86_64 guest runs under **TCG, thread=multi** (pure emulation)
on macOS. Boot is ~10-15s to serial login vs ~2s under KVM on Linux.

**Status.** Accepted. The aarch64 guest VM (Phase 9) uses HVF for acceleration.
The x86_64 host emulation path is inherently limited and is the TCG fallback.

---

## 2. Entropy Starvation Under TCG

**Issue.** Under TCG, `/dev/random` and `/dev/urandom` have no hardware RNG to
seed the kernel CSPRNG. davfs2's HTTPS library blocks on `/dev/random` for
~86s before `mount.davfs` times out.

**Fix.** Add `virtio-rng-pci` (on `pc`) or `virtio-rng-device` (on `microvm`)
to the QEMU device list. The guest kernel probes it as `/dev/hwrng` and the
`rngd` daemon (if present) or the kernel's internal `add_hwgenerator_randomness`
feeds the entropy pool.

See commit `70c85bf`; troubleshooting entry in `build-from-source.md`.

---

## 3. Unison Archive Corrupted On Guest Shutdown

**Issue.** When the guest is shut down via ACPI (`QMP system_powerdown`), the
`unison` process is killed mid-write, truncating its binary archive at
`/root/.unison/*`. On next boot, unison refuses to start:

```
Error: End_of_file exception raised in loading archive
```

This causes an infinite retry loop that also prevents the WebDAV mount from
stabilizing.

**Fix.** Delete the unison archive on every guest startup:

```sh
rm -f /root/.unison/*
```

Safe because the host directory is canonical and the workspace qcow2 is a
rebuildable cache. See commit `ae8bb68`.

**Residual risk.** If `unison` was mid-sync when killed, the next boot might
re-sync both sides (harmless but costs ~2s of work).

---

## 4. davfs2 Does Not Support Inotify

**Issue.** The guest mounts the host WebDAV share via `davfs2`, which is a FUSE
filesystem. The Linux kernel's `inotify` mechanism only fires for changes the
FUSE daemon explicitly reports via `fuse_lowlevel_notify_*`. davfs2 does not
call any notification callbacks, so `inotifywait -r /host-workspace` **silently
never fires**.

The earlier design assumed inotify on the WebDAV mount for guest-to-host change
detection. This does not work.

**Fix.** Use `unison -repeat 2` (2 second poll) for both directions. The WebDAV
mount is only written to by the host HTTP server — changes appear within 2s.

**Performance note.** A 2s poll on the qcow2 side (`/workspace`) is fast because
the ext4 filesystem is local. The WebDAV side (`/host-workspace`) is polled by
unison over FUSE, which translates to HTTP `PROPFIND` requests. For very large
trees this may be slow, but it's functionally correct.

---

## 5. `app.isPackaged` Guard (Asset Path Resolution)

**Issue.** Electron's `app` module is only available in the main process. When
running code through `tsx` (e.g., tests, scripts), `require('electron')` returns
an object with `app === undefined`. Calling `app.isPackaged` throws:

```
TypeError: Cannot read properties of undefined (reading 'isPackaged')
```

**Fix.** Add a guard in `asset-paths.ts` that checks for `app` before accessing
`.isPackaged`:

```ts
function isDev(): boolean {
  if (typeof app === "undefined") return true;
  return !app.isPackaged;
}
```

See commit `e467468`.

---

## 6. Bundled `qemu-img` Resolution

**Issue.** `scripts/build-guest.sh` creates the guest root and workspace disk
images with `qemu-img`. On a fresh checkout with no host QEMU installed, no
`qemu-img` is on `$PATH`. The script failed silently.

**Fix.** Resolve `qemu-img` from `sandbox/resources/qemu/<platform>/qemu-img`
first, fall back to `$PATH`. The `<platform>` is `darwin` on macOS.

See commit `c9c7e16`.

---

## 7. SSH Cipher/KEX Restrictions Under TCG

**Issue.** Under TCG, asymmetric crypto operations are very slow. Using default
OpenSSH ciphers (AES-GCM, etc.) causes multi-second delays per SSH command. The
Ed25519 host key generation itself takes ~10 CPU seconds at first boot.

**Fix.** In `/etc/ssh/sshd_config`:
- Host key: Ed25519 only (no RSA/DSA/ECDSA)
- Ciphers: `chacha20-poly1305@openssh.com` only
- KEX: `curve25519-sha256` only
- MACs: `umac-64-etm@openssh.com` only

These are the fastest options under software emulation.

---

## 8. `microvm` + TCG Incompatibility

**Issue.** `-machine microvm` has no HPET or ACPI PM timer. Under TCG the guest
relies on these timers for TSC calibration and fails to keep reliable time.

**Fix.** Dynamic machine selection: `microvm` only when HW acceleration is
available (KVM/HVF/WHPX), `pc` (i440fx) under TCG. The `pc` machine provides
HPET + ACPI PM timer.

```ts
const machine = hasHwAccel ? "microvm" : "pc";
```

Implemented inline in `qemu.ts` `buildArgs` (the `useMicrovm` boolean derived
from accel selection).

---

## 9. Boot Time Under TCG On Apple Silicon

**Measured.** ~10.6s from QEMU spawn to serial login prompt
(`test/boot.test.ts`). Breakdown:

| Phase | Time |
|-------|------|
| QEMU startup + BIOS | ~1s |
| Kernel decompress + init | ~4s |
| OpenRC boot | ~4s |
| Login prompt | ~1.6s |

This is ~5x slower than KVM on Linux (~2s) but within acceptable range for a
developer VM that stays running.

**Note.** First boot is slower because SSH host key generation adds ~10s. The
test uses a pre-seeded image so this is not reflected in the 10.6s figure.

---

## 10. HVF Entitlement For aarch64 Acceleration

**Issue.** `qemu-system-aarch64 -accel hvf` fails with
`Error: HV_DENIED (0xfae94007)` unless the binary carries the
`com.apple.security.hypervisor` code-signing entitlement. Ad-hoc signed binaries
without it are denied by `Hypervisor.framework`.

**Fix.** `scripts/build-qemu.sh` signs `qemu-system-aarch64` with an entitlements
plist checked into the repo at `sandbox/resources/qemu/hvf-entitlement.plist`:

```xml
<key>com.apple.security.hypervisor</key><true/>
```

Ad-hoc signing (`codesign --sign - --entitlements <plist>`) is enough for dev; no
Apple Developer identity required. Under HVF the aarch64 guest boots to login in
well under 1 s (vs ~25 s under TCG).

**HV_DENIED even with the entitlement:** ensure the *spawning* process is allowed
to create VMs. Terminal/Electron dev runs inherit it; a hardened-runtime packaged
app needs the same entitlement on the outer app too (Phase 11).

---

## 11. Guest Wall-Clock Time From The Host RTC (No NTP)

**Issue.** The aarch64 guest booted with a wildly wrong clock (e.g. `Jun 5` when
the host said `Jul 18`). QEMU's `-machine virt` exposes a PL031 RTC seeded from
the host clock, but Ubuntu's `linux-image-virtual` does **not** ship the
`rtc-pl031` driver in the base `linux-modules` package — it lives in
`linux-modules-extra`. With no driver there is no `/dev/rtc0`, so the kernel
starts at its build epoch and never reads host time. (x86-64 `pc` is unaffected:
`rtc_cmos` is built in.)

**Fix (stable, apt-managed).** On arm64 the Dockerfile installs
`linux-modules-extra-${KREL}` where `${KREL}` is derived from the *installed*
kernel. apt version-locks the two packages: a kernel upgrade forces a matching
extra-modules package (apt refuses a mismatch), so this survives kernel bumps —
unlike hand-copying a version-stamped `.ko`, and without needing DKMS (which is
for out-of-tree source modules, not this in-tree one). `rtc_pl031` is added to
`/etc/initramfs-tools/modules` so the RTC is up early; the kernel logs
`rtc-pl031 ...: setting system clock to <host time>` at boot.

**Size control.** Pulling `linux-modules-extra` also flips `initramfs-tools` into
`MODULES=most` behaviour, ballooning the initramfs to ~48 MB. We set
`MODULES=list` in `initramfs.conf` (our device set is fixed: virtio + ext4 +
rtc), bringing it back to ~7 MB. The aggressive kernel-module strip in the
Dockerfile trims the on-disk extras bulk; `drivers/rtc` is preserved.

**No NTP.** `systemd-timesyncd` stays masked. Time comes purely from the
host-seeded RTC at boot on both arches — no network dependency.

---

## 12. Remaining Gaps

- **Signing and notarization.** QEMU binaries and bundled dylibs must be signed
  (`codesign`) and notarized before the packaged app can be distributed outside
  the development team. Without signing, macOS may quarantine or refuse to
  launch the QEMU subprocess. See PLAN.md Phase 7.
- **Electron UI integration on macOS.** The boot smoke test (`test/boot.test.ts`)
  uses `VmManager` directly. The full Electron IPC path (serial input from
  xterm.js renderer → main process → QEMU serial socket) is not tested on macOS
  outside interactive use.
- **macOS app lifecycle.** macOS quits apps by default when the last window is
  closed (`NSApplicationQuitOnClose`). Ensure the app handles `window-all-closed`
  correctly — it should keep running if the VM is active, or shut down cleanly.
- **Firewall prompts.** On first run, macOS may prompt to allow QEMU network
  connections (`/usr/libexec/ApplicationFirewall`). The QEMU subprocess uses
  SLIRP (user-mode networking) and does not accept inbound connections (except
  the SSH hostfwd on 127.0.0.1:2222), but macOS may still prompt.
- **docs/qemu.md staleness.** The machine-selection table and accel auto-detect
  descriptions in `qemu.md` predate the macOS bring-up and may contain
  assumptions about HVF availability for x86_64. (Marked stale — will be
  rewritten in Phase 7 as part of the multi-arch doc update.)
