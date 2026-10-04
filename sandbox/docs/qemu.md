# QEMU Implementation and Rewrite Plan

ValenceBox now uses **vanilla QEMU** (`qemu-system-x86_64` or
`qemu-system-aarch64` as a host subprocess, 64-bit Ubuntu guest), replacing
**v86** (in-process WASM JIT, 32-bit guest).

The current implementation summary below is distinct from the **historical
rewrite phases and future proposals** later in this document. Phase checkboxes
record rewrite work; they are not proof of current runtime behavior or successful
testing on every supported host. Implementation references are
`src/main/{guest-profile,qemu,qmp,main,vm-manager}.ts`, the guest scripts and
systemd units, and the test bodies named below.

---

## Rewrite motivation

- **Escape the 32-bit trap.** v86 forces the entire stack to x86-32 (Alpine
  3.22.5, `i686-unknown-linux-musl` Rust agent, 32-bit toolchains). QEMU runs a
  64-bit x86-64 or aarch64 guest.
- **Escape the WASM-JIT ceiling.** v86 is a single-threaded WASM interpreter/JIT
  with no path to hardware acceleration. QEMU can use host virtualization when
  available and multi-threaded TCG when not.
- **Non-admin runtime target.** The packaging goal is bundled QEMU, firmware
  and guest images with no system QEMU install or root required to run the app.
  This is not a claim that all installers are complete; source builds require
  the build-time dependencies listed in `build-from-source.md`.

## Current implementation

```text
Electron main (Node)
 ├─ QEMU subprocess: qemu-system-x86_64 or qemu-system-aarch64
 │    ├─ machine/profile: x86 microvm (HW or bare tcg), pc (tcg,thread=multi); ARM virt
 │    ├─ drives: root + workspace qcow2 via virtio-blk
 │    ├─ net: -netdev user (SLIRP) + virtio-net
 │    ├─ serial + QMP + PTY: Unix sockets on Linux/macOS; loopback TCP on Windows
 │    └─ QMP client: lifecycle/events + balloon control (not a snapshot backend)
 ├─ WebDAV server: plain HTTP, Basic auth with per-session token
 │    └─ 127.0.0.1:<random_port>; port/token delivered via file-backed fw_cfg
 └─ EgressProxy: authenticated HTTP/CONNECT proxy, optional MITM secret injection
      └─ guest proxy environment is configuration, not enforced network isolation

Guest (Ubuntu 24.04, x86-64 or aarch64, systemd)
 ├─ / on /dev/vda (root qcow2)
 ├─ /workspace on /dev/vdb (native ext4, formatted on first boot)
 ├─ workspace-sync mounts WebDAV at /host-workspace via SLIRP (10.0.2.2)
 ├─ unison -repeat 2: /host-workspace ⇄ /workspace (poll-based)
 ├─ PTY daemon on /dev/virtio-ports/pty
 └─ root auto-login via serial-getty: ttyS0 (x86) or ttyAMA0 (ARM)
```

### Guest architecture and acceleration are separate choices

`selectGuest()` honors an explicit `sandbox.config.json` `guest` setting.
Otherwise, on Apple Silicon it selects aarch64 when the aarch64 QEMU binary and
ARM root image are present; `main.ts` then uses the matching workspace, kernel
and initramfs paths. The auto-selection probe checks the binary and root image,
not the complete image set, so all matching assets still need to be staged.
Missing ARM assets cause auto-selection to choose x86-64; other hosts default
to x86-64.

Acceleration is resolved **after** architecture selection. With ARM assets
selected, explicitly choosing `accel: "tcg"` means **same-architecture ARM TCG**,
not an automatic switch to x86-64. The resolver assumes HVF availability rather
than probing it; startup-time failure is not guaranteed to recover via TCG
(see the machine/CPU caveats below). In this application's macOS
resolver, HVF is selected only for aarch64 on Apple Silicon; x86-64 uses TCG.
This describes the resolver, not a claim that QEMU generally cannot accelerate
x86 guests on Intel Macs.

### Current decisions and limits

| Topic | Implementation |
|---|---|
| Emulator | `qemu-system-x86_64` or `qemu-system-aarch64`; bundled binary preferred, `$PATH` fallback in the resolver |
| Guest | Ubuntu 24.04, `linux-image-virtual`, initramfs, virtio devices, systemd |
| Host↔guest share | Plain-HTTP WebDAV over SLIRP, authenticated with a per-session token |
| Working tree | Native qcow2 (`/dev/vdb`), mirrored by in-guest **unison**, not rsync/inotify |
| Source of truth | Host dir is canonical; qcow2 is a synced cache, but still mutable disk state relevant to any future RAM restore |
| Egress | Proxy-aware clients use `EgressProxy`; default host policy is `none`, configured port restrictions still apply; direct SLIRP bypass is not blocked |
| Snapshots | **Unimplemented in the QEMU app.** Legacy `saveSnapshot` IPC handler in `main.ts` is a no-op; no QEMU save/restore backend |
| Terminal | PTY channel over virtio-serial + Python daemon, serial fallback |
| Platforms | Linux/macOS/Windows code paths and packaging targets; no claim that every host/arch/accelerator combination has been tested |

### Current verification scope

- `test:unit`: guest profile/selection and argument construction without a VM;
  not cross-platform boot validation.
- `test:qmp`: minimal frozen x86 QEMU, connect/capabilities, query status and
  process-stop assertion; not graceful guest powerdown or snapshot verification.
- `test:boot`: x86 serial login, hostname, workspace disk and systemd unit state;
  no host share/proxy or actual file-sync round-trip. Details are in Phases 1–2.
- `test:share`: host WebDAV auth/CRUD/traversal checks without a guest (Phase 3).
- `test:ui`: existing **legacy renderer-stub** script (`ui-smoke.js` plus
  `fake-preload.js`), replaying old restored/sync/conflict/Wisp and serial/input
  events. It does not exercise QEMU, snapshots or the full current PTY API.
  Hidden/offscreen Electron still needs a usable display session (`DISPLAY` /
  Xvfb on Linux). The harness disables context isolation and enables Node
  integration, unlike the app: it is not a renderer security audit.
- `test:snapshot` / `test:e2e`: proposed names only; no current npm scripts.

Coverage descriptions come from test bodies. For this docs-only update,
`test:unit`, `test:share`, `test:egress`, and `tsc --noEmit -p .` passed.
Integration, QMP, boot, UI and full builds were not run. See
`build-from-source.md` for runnable commands and their limits.

### Machine selection and virtio transport

`QemuProcess` resolves the accelerator list before constructing arguments and
passes its first entry to `GuestProfile.machineFor()`. The supported profile
mappings are:

| Guest / resolved accel | Machine | Virtio transport / details |
|---|---|---|
| x86-64 hardware-accel branch (KVM / WHPX when resolved available) | `microvm` | `virtio-*-device` (MMIO); adds `reboot=t` |
| x86-64 `tcg,thread=multi` (including forced `accel=tcg`) | `pc` (i440fx) | `virtio-*-pci`; HPET + ACPI PM timer for TSC calibration |
| aarch64 HVF | `virt,gic-version=3` | `virtio-*-pci`, CPU `host`, console `ttyAMA0` |
| aarch64 `tcg,thread=multi` | `virt,gic-version=3` | `virtio-*-pci`, CPU `max`, console `ttyAMA0` |

The ARM profile never selects microvm, under either HVF or TCG. The x86 profile's
TCG mapping is specifically for `tcg,thread=multi`. In **macOS x86-64 auto mode**,
`checkAccel()` returns bare `tcg` as available; the resolver emits
`["tcg", "tcg,thread=multi"]`, and the profile maps that first bare entry to
**microvm**, not `pc`. This is a current mapping gap, not a verified boot path;
forced `accel: "tcg"` resolves `tcg,thread=multi` and selects `pc`. Apple Silicon
ARM HVF is reported available without probing initialization; explicitly forcing
TCG selects ARM `virt`/CPU `max`, while HVF startup failure may fail launch with
preselected CPU `host`. Hardware candidates retain TCG last, but machine
and CPU arguments are chosen **before launch**, not rebuilt if QEMU rejects a
hardware candidate at startup. An unavailable candidate resolved to software
emulation and a runtime accelerator failure are therefore not equivalent.

The historical reason for using x86 `pc` under TCG is that microvm lacks HPET
and the guest had TSC calibration failures. KVM's kvmclock motivated the hardware
microvm branch; this is not evidence that WHPX/microvm has been boot-tested.
See [upstream issue #2381](https://gitlab.com/qemu-project/qemu/-/issues/2381).
`test:unit` checks profiles and argument construction only, not live VM boots.

### Historical transport rationale: why not 9p / virtiofs

The rewrite plan recorded that QEMU's 9p/virtfs `local` backend was limited to
`linux`, `darwin`, `freebsd` (`fsdev/meson.build`), virtiofsd was Linux-only,
and the Windows 9p host patches (Bin Meng, 2022) had not been merged. This
motivated plain-HTTP WebDAV over SLIRP as a common transport without host
filesystem passthrough. It is design rationale, not proof of identical runtime
behavior or completed testing on Linux/macOS/Windows.

### Why plain HTTP (not SSH/rsync-daemon)

Under TCG the guest CPU is emulated, so SSH encryption adds software-crypto
cost. SSH cannot disable
encryption (`none` cipher removed from OpenSSH), so every synced byte pays a
software-crypto tax for a channel that never leaves the host. Plain HTTP over
loopback SLIRP has zero crypto cost and needs no extra host binaries (pure Node
server).

### Why WebDAV (not a custom HTTP REST API)

Rather than writing a custom file-server REST API (`GET /file/...`, `PUT
/file/...`, etc.), we use the open-source WebDAV library
[`nephele`](https://www.npmjs.com/package/nephele). The server setup is ~10
lines of glue in the original sketch below. **This unauthenticated sketch is
historical, not the current server or a safe workspace-server recipe.** Current
`http-share.ts` uses custom token auth and binds explicitly to `127.0.0.1`;
see Phase 3 for the authenticated design.

```ts
import express from 'express';
import nepheleServer from 'nephele';
import FileSystemAdapter from '@nephele/adapter-file-system';
import InsecureAuthenticator from '@nephele/authenticator-none';

const app = express();
app.use('/', nepheleServer({
  adapter: new FileSystemAdapter({ root: workspacePath }),
  authenticator: new InsecureAuthenticator(),
}));
app.listen(port);
```

WebDAV (RFC 4918) is a standard protocol with clients on every OS: davfs2
(Ubuntu/Linux), macOS Finder, Windows Explorer, GNOME Files, KDE Dolphin. Using
it means the guest mounts the share with `mount -t davfs` — no custom sync
agent protocol, no bespoke CONNECT/BPROPPATCH parsing. The Nephele package is
actively maintained (SciActive Inc, Apache-2.0, 10 transitive deps).

### Why token-based auth (not wide-open loopback)

On a multi-user host, every local user can reach `127.0.0.1:<PORT>` — an
unauthenticated server would expose the workspace to anyone who can scan ports.
We close this gap with a **per-session random token**:

1. **Host:** at startup, Electron generates a random token (32 hex chars,
   `crypto.randomBytes`) and a random free loopback port. The Nephele server
   uses `@nephele/authenticator-custom` to require Basic auth
   (username `valence`, password = token). Unauthenticated requests get `401`.
2. **Guest:** the port and token are **never** on the QEMU command line (visible
   in `ps`). Instead they are written to a temp file with `0600` permissions
   and passed via QEMU's **fw_cfg** firmware configuration channel:
   `-fw_cfg name=opt/org.valencebox.config,file=<path>`.
   The guest reads them from
   `/sys/firmware/qemu_fw_cfg/by_name/opt/org.valencebox.config/raw`,
   writes them into `/etc/davfs2/secrets`, and mounts the share with
   `mount -t davfs http://10.0.2.2:<PORT> /host-workspace`.

| Threat | Mitigation |
|---|---|
| Other host user scans ports | Server replies `401` — need the token to access files |
| Token on `ps aux` / Task Manager | Not on command line; file-backed fw_cfg entry |
| Other host user reads share token file | Host share config file created with mode `0600`; privileged/same-user processes are outside this protection |
| Eavesdrop loopback traffic | Plain HTTP provides no confidentiality against a host actor able to capture traffic; loopback is not a privileged-host security boundary |
| TLS crypto overhead in emulated CPU | No TLS; plain HTTP over loopback — zero cipher cost |

### Host↔guest security boundary (summary)

The WebDAV server binds to host loopback and requires the session token.
The host writes the share config file with mode `0600`; QEMU delivers it via
fw_cfg and the guest writes davfs2 secrets with mode `0600`. This limits
unauthenticated access to the **share endpoint**; it is not a claim that only
Electron/QEMU/the guest can access the underlying host directory. Its owner's
other processes and privileged host users remain outside that protection.

`EgressProxy` enforces auth, host policy and configured ports only for traffic
sent to it. Guest `HTTP_PROXY`/`HTTPS_PROXY` variables configure cooperating
clients, and `no_proxy=127.0.0.1,localhost,10.0.2.2,::1` lets local/WebDAV traffic
bypass it. QEMU still uses unrestricted user-mode SLIRP: there is no network
rule forcing arbitrary guest sockets through the proxy. The proxy defaults to
`0.0.0.0` (configurable), unlike the loopback-only share. Neither these controls
nor the smoke tests constitute a security audit.

---

## Historical cleanup plan: what gets deleted vs. kept

The lists below preserve the Phase 9 cleanup intentions, not an inventory of
files confirmed absent today. Legacy IPC/dependencies may remain; in particular,
remaining snapshot references do not implement QEMU snapshots.

**Planned deletion (Phase 9)**
- `v86/` submodule, `scripts/build-v86.sh`, `scripts/Dockerfile.v86`, the `max_cache_bytes` fork
- `src/main/vm.ts`, `bridge.ts`, `data-plane.ts`, `manifest.ts`, `sync-manager.ts`
- `src/main/snapshot.ts`, `sandbox.ts`, `wisp.ts`, `doh.ts`, `terminal.ts`
- `src/shared/protocol.ts` (framed dual-channel protocol)
- Tests: `manifest.unit.ts`, `hydrate-channel-switch.unit.ts`, `sync.test.ts`, `dataplane.test.ts`, `net.test.ts`, `memcheck.adhoc.ts`
- `PROTOCOL.md`, `docs/data-plane-architecture.md`, `docs/switch-to-v86-fork.md`
- Deps: `@mercuryworkshop/wisp-js`, `blakejs`, `ws` (no longer imported)

**Rewrite scope (Phase 9)**
- `src/main/vm-manager.ts` (QEMU subprocess + QMP, replaces `vm.ts`)
- `src/main/main.ts` (simplified orchestration, uses VmManager directly)
- `guest/Dockerfile`, `scripts/build-guest.sh` (x86-64 + arm64, virtio, unison sync)
- `guest/usr/local/libexec/mount-share.sh`, `workspace-sync.sh`

**Keep / adapt**
- Electron shell, `src/main/preload.ts`, `src/main/terminal.ts`, `src/shared/ipc.ts`
- Renderer / xterm UI (fed from QEMU serial socket)
- `chokidar` (host-side change detection), `@mongodb-js/zstd` (snapshot compression)

---

## Historical rewrite phases and future work

These phases retain the original rollout sequence and progress notes. Corrected
current behavior is called out where the implementation superseded the plan.
Only commands present in `package.json` are runnable today. Phase 5 snapshots
and the snapshot-inclusive Phase 6 end-to-end verification remain **future
proposals**, not implemented features or test suites.

### Phase 0 — Prep & scaffolding

Goal: land the plan, carve out space, keep the tree buildable.

- [x] Commit this plan and the AGENTS.md update
- [x] Add a `resources/qemu/<platform>/` layout convention (empty dirs + README) for bundled binaries
- [x] Add `sandbox.config.json` schema stub for new knobs (`accel`, `workspaceDir`, `memMb`, `smp`) — no wiring yet
- [x] Decide QEMU source per platform (portable build vs. distro binary) and document in `resources/qemu/README.md`

**Historical verification:** `npm run build` on the then-current v86 tree.
Today the same build script compiles the QEMU app and copies renderer assets.

### Phase 1 — QEMU boots to a serial login

Goal: `qemu-system-x86_64` launches a throwaway Ubuntu ISO/qcow2 and reaches a
login prompt over a Unix serial socket. **No sync, no snapshots, no workspace.**

**Historical milestone: the x86-64 guest reached a serial login prompt under
TCG after switching that path to `pc` (i440fx).** The current implementation
selects machine and transport by guest profile and resolved acceleration (see
above): x86 hardware branch → microvm, x86 `tcg,thread=multi` → pc, ARM → virt;
Unix sockets on Linux/macOS, loopback TCP on Windows. This milestone does not
establish successful boots on every platform/accelerator.

- [x] Vendor a QEMU binary into `resources/qemu/linux/` for dev (Linux first)
- [x] Write `src/main/qemu.ts` — spawns profile-selected QEMU with serial+QMP sockets and accel resolution
- [x] Write `src/main/vm-manager.ts` — wraps QEMU process, connects serial socket, exposes events
- [x] Rewire `main.ts` — replaces `Sandbox`+v86 with `VmManager`; IPC handlers for serial I/O only
- [x] Implement platform/arch-specific accel resolution with `tcg,thread=multi` last (see current selection limits above)
- [x] Boot a proper x86-64 Ubuntu root qcow2 (deferred to Phase 4 — guest image build)
- [x] Wire the serial Unix socket into the existing xterm renderer (`onSerial` / input)
- [x] Cross-platform binary/asset path resolver (dev vs `process.resourcesPath`)

Key details:
- PC machine uses `-device virtio-blk-pci` (PCI) — standard PCI bus with HPET/ACPI
- NIC uses explicit `-netdev user,id=net0 -device virtio-net-pci,netdev=net0`
- Port forwarding via QEMU `hostfwd` rules inside the `-netdev` argument.
  Configured through `sandbox.config.json` → `portForwards` array. Default:
  SSH (2222→22) for debug access. Binds to `127.0.0.1` unless overridden.
- Shutdown via QMP `system_powerdown` then SIGTERM/SIGKILL fallback
- Current serial, QMP and PTY transports: Unix sockets on Linux/macOS; loopback TCP on Windows

Built binary (`resources/qemu/linux/qemu-system-x86_64`):
- 86 MB, static-pie linked (musl), ELF x86-64, QEMU 9.2.4
- Features: KVM, SLIRP, zstd, QMP
- Firmware blobs extracted:
  - `bios-microvm.bin` — qboot BIOS (primary machine type)
  - `bios-256k.bin` — SeaBIOS (kept for compatibility/debug)
  - `linuxboot.bin`, `linuxboot_dma.bin` — option ROMs for direct kernel boot
  - `vgabios-stdvga.bin` — VGA BIOS (unused in `-nographic`)
- Build script: `scripts/build-qemu.sh` — Alpine 3.20 Docker, libslirp 4.8.0 from source

### Historical pc smoke test (manual, 2026-07-13)

Recorded x86-64 TCG boot command, not the complete current app invocation.
This manual observation is specific to that environment, not a cross-platform
validation:

```
./sandbox/resources/qemu/linux/qemu-system-x86_64 \
  -L ./sandbox/resources/qemu/linux/pc-bios \
  -M pc -accel tcg,thread=multi -m 512 -smp 2 \
  -kernel sandbox/images/vmlinuz.bin \
  -initrd sandbox/images/initramfs.bin \
  -append "console=ttyS0 root=/dev/vda rootfstype=ext4 rw quiet systemd.show_status=0" \
  -nodefaults -no-user-config -nographic -no-reboot \
  -drive id=root,file=sandbox/images/root.qcow2,format=qcow2,if=none \
  -device virtio-blk-pci,drive=root \
  -netdev user,id=net0 \
  -device virtio-net-pci,netdev=net0
```

**Key findings (documented for future reference):**

| Issue | Root cause | Fix |
|---|---|---|
| No serial output with `-nodefaults -serial stdio` | microvm with `-nodefaults` omits the ISA serial device. `-serial stdio` attaches to it and produces nothing. | The manual workaround used a Unix serial socket + `nc -U`; current app transports are described above. |
| KVM not available on this machine | No `/dev/kvm` access | `-accel tcg,thread=multi` fallback works, guest boots in ~8s |
| Read-only root filesystem | Ubuntu's initramfs `init` uses kernel's built-in mount logic which defaults to `ro`. `rootflags=rw` appends to mount options but doesn't override the kernel's `ro` default — the bare `rw` token is required | Add bare `rw` to `-append` (not just `rootflags=rw`) |
| Kernels need initramfs with virtio modules | Ubuntu's generic kernel has `virtio_blk` built-in, but `virtio_mmio` (for microvm) is a module. Initramfs must include it. | Explicit module list in `/etc/initramfs-tools/modules` at build time |
| No boot at all without initramfs | `ext4` is a module, not built-in on Ubuntu's generic kernel. Kernel can't mount root without loading it. | Keep `-initrd` — initramfs provides kmod + modules and performs `switch_root` to `/dev/vda` |

Recorded result: `sandbox login:` prompt with root auto-login on serial,
networking and writable root. The Ubuntu guest uses **systemd**, not OpenRC.

Historical simplified accel snippet (current code also uses guest architecture
and explicit overrides when resolving candidates):

```ts
const accels: string[] = [];
{
  const info = QemuProcess.checkAccel(process.platform);
  if (info.available) accels.push(info.name);
}
accels.push("tcg,thread=multi");   // always last (fallback)
// → ["kvm", "tcg,thread=multi"] when KVM available
// → ["tcg,thread=multi"] when no HW accel → machine selects pc
```

**Current verification (`npm run test:boot`):** `test/boot.test.ts` explicitly
uses the **x86-64** profile and unsuffixed images, defaulting to TCG (`ACCEL`
can override it). It waits for the serial login prompt and root auto-login,
checks hostname `sandbox`, `/workspace` mounted from `/dev/vdb` as ext4, and
active `mount-share` / `workspace-sync` systemd units. Cleanup calls
`VmManager.stop()`. It does **not** start a host WebDAV share or proxy, verify
file synchronization, test ARM/HVF, or prove graceful guest shutdown.

### Phase 2 — QMP control plane

Goal: structured lifecycle control independent of the serial console.
Current QMP transport is Unix on Linux/macOS and loopback TCP on Windows.

- [x] Write `src/main/qmp.ts` — JSON-lines QMP client with:
      - Capability negotiation (`qmp_capabilities`)
      - Ordered command queue (no concurrent `execute()` races)
      - Event forwarding (`SHUTDOWN`, `RESET`, etc.)
      - `system_powerdown` for graceful guest shutdown
- [x] Integrate QMP into `QemuProcess.start()` — connect + handshake after socket ready
- [x] Refactor `QemuProcess.stop()` — QMP `system_powerdown` first, then SIGTERM/SIGKILL
- [x] Add `query-status` lifecycle helper (used in `stop()` before `system_powerdown`)
- [x] Surface QMP events through `VmManager` → `main.ts`
- [x] Write `test/qmp.test.ts`: start frozen QEMU, negotiate QMP, query status, call `stop()`, assert process no longer running

**Current verification (`npm run test:qmp`):** starts a minimal x86-64 VM
with `freeze: true` (`-S`), no guest kernel/disks, and TCG by default (`ACCEL`
can override). `QemuProcess.start()` connects QMP and negotiates capabilities;
the test calls `query-status`, prints its result, then calls `stop()` and checks
`qemu.running` is false. In the normal frozen/prelaunch state,
`status.running` is false, so `stop()` skips `system_powerdown` and uses the
process termination fallback. The test's shutdown log text is therefore not
proof of graceful QMP guest powerdown. It covers neither boot, snapshots nor
the full QMP protocol/error/event surface. The generic client and its balloon
helpers are **not** a snapshot backend.

### Phase 3 — Host WebDAV share server

Goal: expose the canonical host workspace dir on loopback via a standard
WebDAV protocol with token-based auth. **Standalone — testable without any VM.**
The following snippet is the original auth design sketch; the current
`HttpShare.start()` wraps it in an HTTP server bound explicitly to `127.0.0.1`.

**Stack:** [`nephele`](https://www.npmjs.com/package/nephele) (WebDAV server
middleware for Express) +
[`@nephele/adapter-file-system`](https://www.npmjs.com/package/@nephele/adapter-file-system)
(filesystem backend) +
[`@nephele/authenticator-custom`](https://www.npmjs.com/package/@nephele/authenticator-custom)
(Basic auth with a per-session random token).

```ts
import express from 'express';
import nepheleServer from 'nephele';
import FileSystemAdapter from '@nephele/adapter-file-system';
import CustomAuthenticator, { User } from '@nephele/authenticator-custom';
import { randomBytes } from 'crypto';

const token = randomBytes(16).toString('hex');  // 32 hex chars
const port = await getRandomFreePort();

const app = express();
app.use('/', nepheleServer({
  adapter: new FileSystemAdapter({ root: workspacePath }),
  authenticator: new CustomAuthenticator({
    getUser: async (username) => {
      if (username === 'valence') return new User({ username });
      return null;
    },
    authBasic: async (user, password) => {
      return password === token;
    },
    realm: 'ValenceBox Workspace',
  }),
}));
app.listen(port);
```

Features we get for free:
- Standard `GET`, `PUT`, `DELETE`, `MKCOL`, `PROPFIND`, `COPY`, `MOVE`
- Directory listings, property management (etags, mtimes)
- Locking (can disable via `locks: 'disallow'` if clients don't need it)

The `port` and `token` must reach the guest securely (Phase 4). They are
written to a temp JSON file with `0600` permissions and passed via QEMU's
`fw_cfg` channel — never on the command line. If another host user scans the
port without credentials, they get `401`; the random token is intended to make
brute-force guessing impractical, not provide a verified access-control guarantee.

**Why not write a custom REST server:** WebDAV is a standard protocol with
battle-tested clients on every platform (davfs2, macOS Finder, Windows Explorer,
GNOME Files, KDE Dolphin). Using `nephele` gives us a full RFC 4918
implementation without bespoke `GET /file/` handlers or PROPFIND parsing.
Delegating to a library does not prove absence of path traversal bugs. The Nephele packages are actively
maintained (SciActive Inc, Apache-2.0, 10 transitive deps for the core, 3 for
the custom authenticator).

- [x] `npm install nephele @nephele/adapter-file-system @nephele/authenticator-custom`
- [x] New `src/main/http-share.ts`: generate token + port, start Express + Nephele
- [x] Random free port on `127.0.0.1` (use `net.createServer().listen(0)` pattern)
- [x] Write `{"port":<n>,"token":"..."}` to a temp file with `0600` permissions
- [ ] `chokidar` watch on workspace dir → notify guest of changes (optional optimization for Phase 6; deferred — unison 2s poll already covers host→guest)
- [x] Honor `WORKSPACE_DIR` env / config (`workspace.ts` `resolveWorkspaceDir`: `cfg.workspaceDir` → `WORKSPACE_DIR` env → persistent `<userData>/workspace`)
- [x] Share adapter root and selected traversal assertions added in `test:share`: raw PUT/GET paths return errors; encoded PUT cases check specified outside sentinel paths remain absent. These tests do not prove encoded writes were clamped, or general path/symlink confinement.

**Verify (`test:share`):** `test/share.test.ts` boots `HttpShare` against a
temp dir; asserts `PROPFIND` no-auth/wrong-token/wrong-user → `401`,
authenticated list → `207`, `PUT`/`GET`/`MKCOL`/`DELETE` host round-trip,
unauthenticated PUT rejection, selected raw traversal errors, and absence of
selected outside sentinel files after encoded PUTs. No VM required. Encoded
reads, symlinks and filesystem races are not covered; see `../HARDENING.md`.

### Phase 4 — Guest image (x86-64) + in-guest sync

Historical goal: rebuild the guest for QEMU with bidirectional workspace sync.
The original rsync/inotify bridge proposal was superseded by **unison** and
**systemd**, with both x86-64 and ARM images now supported by the build script.

**Secure bootstrapping:** the guest needs the WebDAV server's random port and
token. These are passed via QEMU's **fw_cfg** firmware configuration channel
— the port and token are **never** on the QEMU command line (invisible in
`ps` / Task Manager to other local users).

Historical bootstrapping sketch (illustrative, not standalone commands).
Current `main.ts` writes `share-config.json` inside its temporary `userData`
VM directory; `mount-share.sh` reads it and writes secrets, and
`workspace-sync.sh` performs the WebDAV mount.

```sh
# Host sketch: write {"port":<n>,"token":"..."} with mode 0600, then pass the file
qemu-system-x86_64 ... \
  -fw_cfg name=opt/org.valencebox.config,file=<share-config.json>

# Guest sketch: read fw_cfg metadata
modprobe qemu_fw_cfg 2>/dev/null || true
CONFIG=$(cat /sys/firmware/qemu_fw_cfg/by_name/opt/org.valencebox.config/raw)
PORT=$(echo "$CONFIG" | grep -o '"port":[0-9]*' | grep -o '[0-9]*')
TOKEN=$(echo "$CONFIG" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
```

**Guest-side WebDAV client:** [`davfs2`](https://packages.ubuntu.com/noble/davfs2)
(`apt install davfs2`). It mounts a WebDAV resource as a FUSE filesystem and works
with plain HTTP (no TLS). The guest mounts the host's Nephele server via SLIRP:

```sh
# Historical mount sketch; current scripts write secrets with mode 0600 first
echo "http://10.0.2.2:$PORT/ valence $TOKEN" > /etc/davfs2/secrets
chmod 0600 /etc/davfs2/secrets
mount -t davfs http://10.0.2.2:$PORT/ /host-workspace
```

Since auth is handled via Basic + token, configure `/etc/davfs2/davfs2.conf`:
- `use_locks 0` (no locking needed for a single-user sync bridge)
- No TLS settings needed — `http://` URLs are treated as plain HTTP
- `secrets ''` means davfs2 reads from the default secrets file, not env

- [x] Rewrite `guest/Dockerfile`: Ubuntu 24.04, `linux-image-virtual` kernel + modules
- [x] Initramfs features: `virtio_blk`, `virtio_net`, `ext4`
- [x] Read-only root fix: add bare `rw` to kernel cmdline; `rootflags=rw` alone does not override the kernel's default `ro`
- [x] Root fs on `/dev/vda`; workspace qcow2 on `/dev/vdb` mounted at `/workspace`
- [x] Install `davfs2`, `unison` and `e2fsprogs` in the guest (current Dockerfile does not install rsync/inotify-tools)
- [x] Configure `/etc/davfs2/davfs2.conf`: `use_locks 0`
- [x] `mount-share.service` runs `mount-share.sh`: format `/dev/vdb` only if unformatted, mount `/workspace`, read share fw_cfg and write davfs2 secrets; configure proxy environment and optional MITM CA
- [x] systemd `workspace-sync.service` runs `workspace-sync.sh`:
       1. wait for `/workspace`, mount/retry WebDAV at `/host-workspace`
       2. wait for `.valence-sync-marker`, clear unison archives on each start
       3. `unison -batch -auto -prefer /host-workspace -repeat 2` mirrors both directions by polling; host wins conflicts
       4. ignore `node_modules`, `.git`, `.DS_Store`, `lost+found`, `.valence-sync-marker` at any depth
- [x] systemd serial-getty root autologin on `ttyS0` (x86) and `ttyAMA0` (ARM)
- [x] Rewrite `scripts/build-guest.sh`: root qcow2 + kernel/initramfs + empty workspace qcow2; honor `WORKSPACE_MB`

**Current build targets:** `npm run images` builds only the host architecture;
`npm run images -- --arch amd64` or `--arch arm64` selects one explicitly.
`npm run images:all` builds both. x86 files are unsuffixed; ARM files use
`-arm64` (`root-arm64.qcow2`, `workspace-arm64.qcow2`, `vmlinuz-arm64.bin`,
`initramfs-arm64.bin`). The workspace starts unformatted and is made ext4 on
first guest boot. See `build-from-source.md` for the Apple Silicon commands.

### Phase 5 — Snapshots via QMP (future proposal, unimplemented)

**Current status:** the QEMU app has no snapshot save/restore implementation.
`main.ts` retains only a no-op legacy `saveSnapshot` IPC handler. `QmpClient`
provides generic QMP commands/lifecycle and balloon helpers, not migration
or snapshot orchestration.

Future goal: warm-boot snapshots of RAM + device state **paired with compatible
disk state**. A RAM/device migration stream alone does not capture the mutable
root or workspace qcow2 contents. The guest's filesystem caches, pending writes
and open files refer to those disks: restoring old RAM against disks changed
since the save can corrupt data or produce inconsistent state. Calling the host
workspace canonical does **not** make such a restore safe, nor does checking
only the base image digest. A future backend needs a coordinated disk checkpoint
or equivalent consistency mechanism for all writable disks, plus handling for
external WebDAV/unison/session state before resuming synchronization.

Revised future migration sketch (QMP migration + zstd compression), not an
executable feature specification:

- [ ] Implement a QEMU snapshot backend with coordinated RAM/device/disk checkpoints and sync quiescing
- [ ] Save: QMP migration to a compressed file, monitor completion, atomically publish the checkpoint
- [ ] Metadata: guest architecture, machine/CPU/accelerator compatibility, QEMU version, RAM size, image identity and matching writable-disk checkpoint identities
- [ ] Restore: validate all compatibility and disk-state requirements, reconnect/reconcile external services, then resume
- [ ] Refuse incompatible or inconsistent restores, including changed disks without matching checkpoints

**Proposed future verification (suggested name `test:snapshot`, not a current
npm script):** create both disk and RAM markers, save a coordinated checkpoint,
change disk state, then verify safe restoration or rejection. Cover root and
workspace consistency, external sync reconciliation and incompatible restores,
not just survival of an in-RAM marker.

### Phase 6 — Orchestration + egress + config

Goal: wire the pieces into the app lifecycle and restore user-facing config.

**Current implementation (supersedes the original placeholders):** `main.ts`
loads config and resolves guest/workspace, starts the WebDAV share and sync
marker, starts the egress proxy, writes fw_cfg files, then starts `VmManager`
and bridges serial/PTY to the UI. Config wires `guest`, `accel`, `workspaceDir`,
`memMb`, `smp`, balloon settings, `portForwards` and `egress`; egress is not just
a placeholder. App `ready` reflects QEMU/QMP startup, not completed guest boot
or a successful sync round-trip.

The proxy has auth, host/port filtering and optional MITM secret injection
(`mitm-plan.md`). This does **not** remove unrestricted SLIRP routes: clients
can bypass proxy environment variables. WebDAV/local addresses are in `no_proxy`.

Current quit ordering is VM stop → proxy stop → share stop → runtime cleanup.
Each stage logs its duration and has a deadline; failures do not skip later
stages. Repeated quit requests share one shutdown operation. A 40-second overall
watchdog force-stops resources and calls `app.exit`; completed shutdown also uses
`app.exit` so a renderer close handler cannot prevent exit. QMP commands time out
and reject on disconnect, including queued requests. `QemuProcess.stop()` queries
status, attempts `system_powerdown` if running, then falls back to SIGTERM/SIGKILL.
The proxy/share destroy their sockets on stop, including CONNECT/TLS and upstream
connections. Runtime cleanup unlinks only known sockets/fw_cfg files and removes
the directory only if empty; it never recursively deletes workspace data.
Default workspaces now persist at `<userData>/workspace`. Legacy
`qemu-*/workspace` directories are retained and can be reused via `workspaceDir`.
`npm run test:shutdown` builds the app and covers QMP failures/deadlines, signal
exits, failed/stalled cleanup stages, active proxy/share sockets, workspace
retention, and repeated quit under a real Electron main process. It does not
replace full guest synchronization or long-running VM lifecycle coverage.
There is no coordinated sync flush or snapshot
step; the original sync-stop/snapshot ordering remains a future design task.

**Proposed future verification (suggested name `test:e2e`, not a current npm
script):** app-driven cold boot, bidirectional edit round-trip, coordinated
snapshot/restore and shutdown. Existing `test:boot` is not this test.

### Phase 7 — Packaging (all 3 platforms; target, not a tested matrix)

Goal: self-contained installers with QEMU + firmware + images bundled.
These are planned acceptance criteria, not a claim that each installer or
accelerator/architecture combination has been validated.

- [ ] electron-builder config; `resources/qemu/<platform>/qemu-system-x86_64` (+ libs)
- [ ] Bundle firmware blobs: `bios-256k.bin`, `vgabios-stdvga.bin`, virtio option ROMs
- [ ] Bundle guest images: `root.qcow2`, template `workspace.qcow2`
- [ ] Make executables relocatable (RPATH / `LD_LIBRARY_PATH` / `DYLD_*` shims)
- [ ] **Prototype the Windows bundle early** — biggest packaging risk (WHPX + portable QEMU + DLLs)
- [ ] Verify accel fallback in the packaged app on each OS (KVM/HVF/WHPX present and absent)
- [ ] Update `THIRD_PARTY_LICENSES.md` (QEMU GPLv2)

**Proposed packaging verification:** install on Linux/macOS/Windows and test
cold boot to a working terminal for each supported guest/accelerator path,
including forced TCG and unavailable-hardware cases. Argument/unit coverage
alone does not satisfy this matrix.

### Phase 8 — Docs & cleanup

- [x] Rewrite `HARDENING.md`: host-canonical dir, plain-HTTP loopback share, proxy-mediated egress, no agent/relay
- [ ] Rewrite `README.md`: new architecture + measured boot/snapshot timings
- [ ] Delete `PROTOCOL.md`, `docs/data-plane-architecture.md`, `docs/switch-to-v86-fork.md` (obsolete)
- [ ] Remove dead deps from `package.json`; update test script list
- [ ] Final `AGENTS.md` pass against the shipped reality

---

## PTY channel (virtio-serial)

The terminal uses a dedicated PTY channel over **virtio-serial** (not SSH, not the
serial console) to avoid crypto overhead under TCG and provide TIOCSWINSZ resize.

### Architecture

```
Electron (PtyChannel)
  │  Unix socket (pty.sock)
  ▼
QEMU (-chardev socket → -device virtserialport,chardev=pty,name=pty)
  │  virtio-serial bus, port "pty"
  ▼
Guest (/dev/virtio-ports/pty → udev symlink)
  │
  ├─ pty-daemon.py (opens port, forks bash on PTY slave)
  │    ├─ port_fd: reads frames from host via virtio-serial
  │    └─ master_fd: reads bash output from PTY master
  └─ bash --login (on /dev/pts/N, PTY slave)
```

### Framed protocol

All data on the virtio-serial port is framed:

```
[u32:payload_len][u8:type][payload...]
```

| Type | Value | Direction | Payload |
|---|---|---|---|
| PTY_DATA | 1 | bidir | arbitrary bytes written to/from the PTY |
| PTY_RESIZE | 2 | host→guest | `[u16:cols][u16:rows]` → TIOCSWINSZ |
| PTY_CLOSE | 3 | host→guest | (empty) SIGTERM child shell |
| PTY_EXITED | 4 | guest→host | (empty) child shell exited; peer should close |

### Guest daemon

**`guest/usr/local/libexec/pty-daemon.py`** — Python 3 only, no external deps.

1. Opens `/dev/virtio-ports/pty` (created by udev rule based on `name=pty`)
2. Calls `pty.fork()` — child execs `bash --login`, parent keeps master fd
3. `select()` loop: reads host input from port_fd → writes to master_fd;
   reads bash output from master_fd → wraps in frame → writes to port_fd
4. Handles PTY_RESIZE via `TIOCSWINSZ`, PTY_CLOSE via `kill(pid, SIGTERM)`

### Host channel

The PTY chardev uses a Unix socket on Linux/macOS and loopback TCP on Windows;
the Unix socket in the architecture sketch above represents the Unix hosts.

**`src/main/pty-channel.ts`** — `PtyChannel` extends `EventEmitter`.

- Connects to QEMU's chardev socket with retry (60 attempts, 1s interval = 60s
  total — covers TCG slow boot, backlog races)
- Framed protocol with 16 MB sanity cap and 64 KB accumulator cap
- Emits `"data"` (guest→renderer), `"closed"` (disconnect), `"error"`
- `sendInput()` / `resize()` methods for host→guest framing

### Renderer integration

**`src/renderer/renderer.ts`** — the terminal starts in serial mode and
transitions to PTY mode on first `pty:data` event:

- `onPtyData`: sets `usingPty = true`, resets terminal, sends resize,
  flushes any keystrokes buffered before PTY was ready
- `onPtyClosed`: reverts to serial fallback
- `term.onData`: routes keystrokes to PTY or serial based on `usingPty`
  (bypasses the `isReady` gate for PTY input)
- Input during boot is buffered in `pendingPtyInput[]` and drained on PTY
  connection

### Systemd unit

**`guest/etc/systemd/system/pty-daemon.service`** — `Restart=always` with 1s
restart interval. No device dependency: the daemon retries `open()` internally
(via systemd restart) if the virtio-serial port isn't ready yet.

### Key decisions

| Question | Decision | Rationale |
|---|---|---|
| `virtconsole` vs `virtserialport` | `virtserialport` | `virtconsole` creates a kernel-console-only port (`hvcX`) that requires kernel console binding for bidirectional data. `virtserialport` exposes a proper character device at `/dev/virtio-ports/pty` |
| Device path | `/dev/virtio-ports/pty` | Stable udev symlink based on `name=pty` QEMU arg, not a hardcoded vport number (which depends on enumeration order) |
| Python vs Go/C | Python | Ubuntu guest ships Python 3. stdlib has `pty`, `termios`, `select`. No compile step needed |
| Retry duration | 60s | Under TCG, boot takes 60s+. The QEMU chardev socket exists early but the guest daemon only opens the port after `multi-user.target` is reached |
| Framed protocol | No padding/CRC | Loopback virtio-serial within single host — no network errors to detect |

### Findings (PTY implementation)

| Issue | Root cause | Fix |
|---|---|---|
| `connect EAGAIN` | QEMU chardev socket uses `listen(fd, 1)` — backlog overflow from prior zombie connections | Add retry loop with `EAGAIN` detection |
| No PTY data flow | `-device virtconsole` creates a console-only port. Guest `/dev/hvc0` open succeeds but QEMU bridges no data | Switch to `-device virtserialport`; daemon opens `/dev/virtio-ports/pty` |
| PTY daemon inactive | Systemd unit had `Requires=dev-hvc0.device` — with `virtserialport`, hvc0 never appears, so daemon never starts | Remove device dependency; use `Restart=always` retry |
| Renderer input blocked during boot | `isReady` gate on `term.onData` dropped all keystrokes until VM phase="ready" | PTY input bypasses `isReady`; boot keystrokes buffered in `pendingPtyInput` |
| Frame OOM vulnerability | No upper bound on `payloadLen` in frame header — malformed frame could grow buffer indefinitely | 16 MB frame cap + 64 KB accumulator cap + disconnect on violation |

## Known risks / follow-ups

1. **QEMU bundling per-OS** is the biggest lift (portable binaries + firmware +
   relocatable libs). Prototype Windows early (Phase 7, but de-risk in Phase 1).
2. **WHPX performance and machine compatibility** need live Windows validation;
   the hardware/microvm argument branch is not proof of a working or fast boot.
3. **`/dev/kvm` access on Linux** gates KVM resolution (often via `kvm` group
   membership). QEMU must also be built with the relevant accelerator enabled.
   Unavailable candidates resolve to TCG; startup-time fallback retains the
   preselected machine/CPU arguments, as described above.
4. **Sync latency** is poll-bound in both directions (`unison -repeat 2`),
   with additional davfs/network caching effects. No inotify bridge is used;
   the polling interval is not a measured end-to-end latency guarantee.
5. **Proxy bypass remains possible.** `EgressProxy` implements authenticated
   HTTP/CONNECT forwarding, host/port filtering and optional MITM secret
   injection for traffic sent to it. Guest proxy variables do not enforce
   routing; direct SLIRP sockets and `no_proxy` traffic bypass it. See
   `mitm-plan.md` and `../HARDENING.md` for related design/security context;
   historical no-bypass assertions are not guarantees of the current code.
6. **qcow2 double disk usage** (host canonical copy + guest qcow2 mirror) is
   expected by design.
7. **TCG defaults** (`-smp`, `tb-size`, MTTCG) need validation against a real
   npm/cargo build workload before locking in.
