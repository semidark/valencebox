# QEMU Rewrite Plan

Pivot ValenceBox from **v86** (in-process WASM JIT, 32-bit guest) to **vanilla
QEMU** (`qemu-system-x86_64` as a bundled host subprocess, 64-bit guest).

This document is the source of truth for the rewrite. Each phase is
**self-contained and testable early** — do not start a phase before the previous
one's checkboxes are green.

---

## Why

- **Escape the 32-bit trap.** v86 forces the entire stack to x86-32 (Alpine
  3.22.5, `i686-unknown-linux-musl` Rust agent, 32-bit toolchains). QEMU runs a
  native x86-64 guest.
- **Escape the WASM-JIT ceiling.** v86 is a single-threaded WASM interpreter/JIT
  with no path to hardware acceleration. QEMU can use host virtualization when
  available and multi-threaded TCG when not.
- **Non-admin users.** Everything ships inside the Electron app — bundled QEMU
  binary + firmware + guest images. No system QEMU, no installs, no root.

## Final architecture (target state)

```
Electron main (Node)
 ├─ QEMU subprocess: qemu-system-x86_64
 │    -accel <hw>,-accel tcg,thread=multi   (auto-fallback, see Phase 1)
 │    -machine <microvm|pc>  -smp N  -m NNNN  -nographic  -no-reboot
 │    │   microvm when hw-accel (kvmclock provides TSC)
 │    │   pc when TCG fallback (needs HPET for TSC calibration)
 │    ├─ drives: -device <virtio-blk-device|virtio-blk-pci>
 │    ├─ net:    -device <virtio-net-device|virtio-net-pci>
 │    ├─ serial tcp:127.0.0.1:<port>,server,nowait
 │    ├─ qmp    tcp:127.0.0.1:<port>,server,nowait
 │    └─ -nic user (SLIRP, open egress for now)
├─ WebDAV server (pure Node, no TLS, token-based auth)
  │    listens on 127.0.0.1:<random_port> — token prevents other
  │    local users from accessing the workspace on a multi-user host
  ├─ fw_cfg metadata channel (secure bootstrapping)
  │    passes <port> + <token> into guest without exposing them
  │    on the QEMU command line (file-backed fw_cfg entry)
  └─ Snapshot manager (QMP migrate-to-file + zstd)

Guest (Ubuntu 24.04 x86-64)
 ├─ / on /dev/vda (root qcow2)
 ├─ /workspace on /dev/vdb (workspace qcow2)   ← native ext4, fast
 ├─ mounts host HTTP share via SLIRP (10.0.2.2) at /host-workspace
 ├─ unison -repeat 2 bridge: /host-workspace ⇄ /workspace
 │    ├─ guest→host: inotify on local qcow2 (prompt)
 │    └─ host→guest: periodic poll ~2s (no inotify over network)
 └─ systemd serial-getty login shell on ttyS0
```

> **⚠️ Stale — x86_64-only design. To be rewritten in Phase 7 (multi-arch).**
> The table below describes the x86_64 TCG guest only. On Apple Silicon the
> default will switch to an aarch64 guest under HVF (Phase 9). HVF is **not**
> available for x86_64 guests on macOS — see `macos-issues.md`.

### Confirmed decisions

| Topic | Decision |
|---|---|
| Machine type | `pc` (i440fx, PCI/ACPI/HPET — microvm has no HPET, fails under TCG) |
| Emulator | vanilla `qemu-system-x86_64`, bundled per-platform |
| Acceleration | auto-detect: `kvm`/`whpx` if available, else `tcg,thread=multi` (HVF is aarch64-only) |
| Guest | Ubuntu 24.04, `linux-image-virtual` kernel, virtio devices |
| Host↔guest share | **WebDAV over plain HTTP** (no TLS) over SLIRP — token-based auth for multi-user safety |
| Working tree | native qcow2 (`/dev/vdb`), mirrored via in-guest rsync/inotify |
| Source of truth | **host dir is canonical**; qcow2 is a synced cache |
| Egress | SLIRP user-mode, **open for now** (filtering deferred) |
| Snapshots | QMP `migrate` to zstd file (RAM + device state only) |
| Terminal | PTY channel over virtio-serial + Python daemon, serial fallback |
| Guest PTY agent | `pty-daemon.py` — Python daemon using `pty.fork()`, `select()`, framed protocol over `/dev/virtio-ports/pty` |
| Platforms | Linux + macOS + Windows from day one |

### Machine type: dynamic (microvm or pc)

The machine type is selected at runtime based on whether hardware acceleration
is available:

| Accel | Machine | Rationale |
|---|---|---|
| KVM / WHPX | `microvm` | kvmclock provides reliable TSC — HPET not needed |
| TCG (fallback) | `pc` (i440fx) | microvm lacks HPET; guest cannot calibrate TSC under TCG |
| HVF (aarch64-only, Phase 9) | `microvm` (or `virt`) | TBD — Phase 9 will determine microvm viability under HVF |

Under hardware acceleration, the guest uses kvmclock (KVM) or analogous
paravirtual clocksource, so microvm's missing HPET is irrelevant. Under TCG,
`-machine pc` provides HPET + ACPI PM timer for working TSC calibration.

> **Note on HVF:** On macOS, HVF only virtualizes aarch64 guests (same-arch as
> Apple Silicon). The x86_64 guest always uses TCG. HVF for aarch64 is Phase 9.

**Virtio transport** matches the machine type:
- `microvm` → `virtio-*-device` (mmio)
- `pc` → `virtio-*-pci`

The `reboot=t` kernel parameter (triple-fault reboot for `-no-reboot`) is
appended automatically when using microvm.

Revisit microvm-under-TCG once QEMU implements TSC frequency via CPUID
([upstream issue #2381](https://gitlab.com/qemu-project/qemu/-/issues/2381)).

### Why not 9p / virtiofs

No QEMU host-filesystem passthrough works on Windows. Verified against QEMU
source (`fsdev/meson.build`): 9p/virtfs `local` backend compiles only on
`linux`, `darwin`, `freebsd`. virtiofsd is Linux-only. The Windows 9p host
patches (Bin Meng, 2022) were never merged. A plain-HTTP network share over
SLIRP is the only transport that works identically on all three hosts with no
privileges — hence the native-qcow2 + in-guest sync design.

### Why plain HTTP (not SSH/rsync-daemon)

The guest CPU is emulated (no guest-side AES-NI under TCG). SSH cannot disable
encryption (`none` cipher removed from OpenSSH), so every synced byte pays a
software-crypto tax for a channel that never leaves the host. Plain HTTP over
loopback SLIRP has zero crypto cost and needs no extra host binaries (pure Node
server).

### Why WebDAV (not a custom HTTP REST API)

Rather than writing a custom file-server REST API (`GET /file/...`, `PUT
/file/...`, etc.), we use the open-source WebDAV library
[`nephele`](https://www.npmjs.com/package/nephele). The server setup is ~10
lines of glue:

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
| Other host user reads token file | `chmod 0600` on host temp dir; denied by OS |
| Eavesdrop loopback traffic | Requires root/admin on all three OSes |
| TLS crypto overhead in emulated CPU | No TLS; plain HTTP over loopback — zero cipher cost |

### Host↔guest security boundary (summary)

The shared workspace dir is reachable *only* by:
- The Electron process (owns the temp file, starts the server)
- QEMU (reads the file via fw_cfg, passes it to the guest)
- The guest (reads fw_cfg sysfs, mounts with davfs2)

No other local user, no network, no admin privileges needed.

---

## What gets deleted vs. kept

**Deleted (Phase 9)**
- `v86/` submodule, `scripts/build-v86.sh`, `scripts/Dockerfile.v86`, the `max_cache_bytes` fork
- `src/main/vm.ts`, `bridge.ts`, `data-plane.ts`, `manifest.ts`, `sync-manager.ts`
- `src/main/snapshot.ts`, `sandbox.ts`, `wisp.ts`, `doh.ts`, `terminal.ts`
- `src/shared/protocol.ts` (framed dual-channel protocol)
- Tests: `manifest.unit.ts`, `hydrate-channel-switch.unit.ts`, `sync.test.ts`, `dataplane.test.ts`, `net.test.ts`, `memcheck.adhoc.ts`
- `PROTOCOL.md`, `docs/data-plane-architecture.md`, `docs/switch-to-v86-fork.md`
- Deps: `@mercuryworkshop/wisp-js`, `blakejs`, `ws` (no longer imported)

**Rewritten (Phase 9)**
- `src/main/vm-manager.ts` (QEMU subprocess + QMP, replaces `vm.ts`)
- `src/main/main.ts` (simplified orchestration, uses VmManager directly)
- `guest/Dockerfile`, `scripts/build-guest.sh` (x86-64 + arm64, virtio, unison sync)
- `guest/usr/local/libexec/mount-share.sh`, `workspace-sync.sh`

**Keep / adapt**
- Electron shell, `src/main/preload.ts`, `src/main/terminal.ts`, `src/shared/ipc.ts`
- Renderer / xterm UI (fed from QEMU serial socket)
- `chokidar` (host-side change detection), `@mongodb-js/zstd` (snapshot compression)

---

## Phases

Every phase ends with a **verification** you can run before moving on. Check the
boxes as you go.

### Phase 0 — Prep & scaffolding

Goal: land the plan, carve out space, keep the tree buildable.

- [x] Commit this plan and the AGENTS.md update
- [x] Add a `resources/qemu/<platform>/` layout convention (empty dirs + README) for bundled binaries
- [x] Add `sandbox.config.json` schema stub for new knobs (`accel`, `workspaceDir`, `memMb`, `smp`) — no wiring yet
- [x] Decide QEMU source per platform (portable build vs. distro binary) and document in `resources/qemu/README.md`

**Verify:** `npm run build` still passes on the untouched v86 tree.

### Phase 1 — QEMU boots to a serial login

Goal: `qemu-system-x86_64` launches a throwaway Ubuntu ISO/qcow2 and reaches a
login prompt over a Unix serial socket. **No sync, no snapshots, no workspace.**

**Status: Phase 1 complete — QEMU binary vendored, asset resolver written,
`qemu.ts` spawns `-M pc` (i440fx) over serial+QMP TCP sockets with accel
priority, `VmManager` bridges serial I/O to renderer, and the x86-64 guest image
now boots to a serial login prompt (built in Phase 4).**

Note: `-machine pc` is used instead of microvm because microvm lacks HPET.
Under TCG (no KVM/HVF/WHPX), the guest kernel cannot calibrate TSC and hangs.
`pc` provides HPET + ACPI PM timer for working TSC calibration under TCG.

- [x] Vendor a QEMU binary into `resources/qemu/linux/` for dev (Linux first)
- [x] Write `src/main/qemu.ts` — spawns QEMU microvm with serial+QMP sockets, accel priority list
- [x] Write `src/main/vm-manager.ts` — wraps QEMU process, connects serial socket, exposes events
- [x] Rewire `main.ts` — replaces `Sandbox`+v86 with `VmManager`; IPC handlers for serial I/O only
- [x] Implement the accel priority list: `kvm`/`hvf`/`whpx` then `tcg,thread=multi`
- [x] Boot a proper x86-64 Ubuntu root qcow2 (deferred to Phase 4 — guest image build)
- [x] Wire the serial Unix socket into the existing xterm renderer (`onSerial` / input)
- [x] Cross-platform binary/asset path resolver (dev vs `process.resourcesPath`)

Key details:
- PC machine uses `-device virtio-blk-pci` (PCI) — standard PCI bus with HPET/ACPI
- NIC uses explicit `-netdev user,id=net0 -device virtio-net-pci,netdev=net0`
- Shutdown via QMP `system_powerdown` then SIGTERM/SIGKILL fallback
- Serial and QMP over TCP (`127.0.0.1:port`) for cross-platform compatibility

Built binary (`resources/qemu/linux/qemu-system-x86_64`):
- 86 MB, static-pie linked (musl), ELF x86-64, QEMU 9.2.4
- Features: KVM, SLIRP, zstd, QMP
- Firmware blobs extracted:
  - `bios-microvm.bin` — qboot BIOS (primary machine type)
  - `bios-256k.bin` — SeaBIOS (kept for compatibility/debug)
  - `linuxboot.bin`, `linuxboot_dma.bin` — option ROMs for direct kernel boot
  - `vgabios-stdvga.bin` — VGA BIOS (unused in `-nographic`)
- Build script: `scripts/build-qemu.sh` — Alpine 3.20 Docker, libslirp 4.8.0 from source

### pc smoke test (manual, 2026-07-13)

Current boot command (x86-64 qcow2, verified with root auto-login + read-write root, TCG):

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
| No serial output with `-nodefaults -serial stdio` | microvm with `-nodefaults` omits the ISA serial device. `-serial stdio` attaches to it and produces nothing. | Use `-serial unix:...,server,nowait` + `nc -U` to read (what the app does). |
| KVM not available on this machine | No `/dev/kvm` access | `-accel tcg,thread=multi` fallback works, guest boots in ~8s |
| Read-only root filesystem | Ubuntu's initramfs `init` uses kernel's built-in mount logic which defaults to `ro`. `rootflags=rw` appends to mount options but doesn't override the kernel's `ro` default — the bare `rw` token is required | Add bare `rw` to `-append` (not just `rootflags=rw`) |
| Kernels need initramfs with virtio modules | Ubuntu's generic kernel has `virtio_blk` built-in, but `virtio_mmio` (for microvm) is a module. Initramfs must include it. | Explicit module list in `/etc/initramfs-tools/modules` at build time |
| No boot at all without initramfs | `ext4` is a module, not built-in on Ubuntu's generic kernel. Kernel can't mount root without loading it. | Keep `-initrd` — initramfs provides kmod + modules and performs `switch_root` to `/dev/vda` |

Result: boots to `sandbox login:` prompt with root auto-login on serial, full OpenRC, networking, writable root.

Accel snippet (auto branch checks availability before adding HW accel):

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

**Verify (`test:boot`):** spawn QEMU, assert Ubuntu login prompt appears on the
serial socket within a timeout. Assert clean shutdown via QMP `quit` (or process
kill). Runs on both a KVM host and a TCG-only host (`accel=tcg` forced).

### Phase 2 — QMP control plane

Goal: structured lifecycle control over the QMP Unix socket, independent of the
serial console.

- [x] Write `src/main/qmp.ts` — JSON-lines QMP client over Unix socket with:
      - Capability negotiation (`qmp_capabilities`)
      - Ordered command queue (no concurrent `execute()` races)
      - Event forwarding (`SHUTDOWN`, `RESET`, etc.)
      - `system_powerdown` for graceful guest shutdown
- [x] Integrate QMP into `QemuProcess.start()` — connect + handshake after socket ready
- [x] Refactor `QemuProcess.stop()` — QMP `system_powerdown` first, then SIGTERM/SIGKILL
- [x] Add `query-status` lifecycle helper (used in `stop()` before `system_powerdown`)
- [x] Surface QMP events through `VmManager` → `main.ts`
- [x] Write a unit test: start QEMU, connect QMP, `query-status`, `system_powerdown`, assert clean exit

### Phase 3 — Host WebDAV share server

Goal: expose the canonical host workspace dir on loopback via a standard
WebDAV protocol with token-based auth. **Standalone — testable without any VM.**

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
port, they get `401`; they cannot brute-force the 32-character random token.

**Why not write a custom REST server:** WebDAV is a standard protocol with
battle-tested clients on every platform (davfs2, macOS Finder, Windows Explorer,
GNOME Files, KDE Dolphin). Using `nephele` gives us a full RFC 4918
implementation in ~20 lines of glue code — no custom `GET /file/`, no path
traversal bugs to write, no PROPFIND parsing. The Nephele packages are actively
maintained (SciActive Inc, Apache-2.0, 10 transitive deps for the core, 3 for
the custom authenticator).

- [x] `npm install nephele @nephele/adapter-file-system @nephele/authenticator-custom`
- [x] New `src/main/http-share.ts`: generate token + port, start Express + Nephele
- [x] Random free port on `127.0.0.1` (use `net.createServer().listen(0)` pattern)
- [x] Write `{"port":<n>,"token":"..."}` to a temp file with `0600` permissions
- [ ] `chokidar` watch on workspace dir → notify guest of changes (optional optimization for Phase 6)
- [ ] Honor `WORKSPACE_DIR` env / config
- [ ] Path scope: `FileSystemAdapter({ root })` naturally rejects traversal (adapters control namespace)

**Verify (`test:share`):** start the server against a temp dir; use `curl` to
`PROPFIND` with no auth (→ `401`), then with `-u valence:<token>` to list,
create (`PUT`), read (`GET`), delete. Assert path traversal is rejected.
No VM required.

### Phase 4 — Guest image (x86-64) + in-guest sync

Goal: rebuild the guest for QEMU and run the rsync/inotify bridge inside it.

**Secure bootstrapping:** the guest needs the WebDAV server's random port and
token. These are passed via QEMU's **fw_cfg** firmware configuration channel
— the port and token are **never** on the QEMU command line (invisible in
`ps` / Task Manager to other local users).

Host side (Electron, before spawning QEMU):

    # writes {"port":<n>,"token":"..."} to /tmp/valence-<uuid>/config.json
    # chmod 0600 /tmp/valence-<uuid>/config.json
    qemu-system-x86_64 ... \
      -fw_cfg name=opt/org.valencebox.config,file=/tmp/valence-<uuid>/config.json

Guest side (Ubuntu boot script):

    modprobe qemu_fw_cfg 2>/dev/null || true
    CONFIG=$(cat /sys/firmware/qemu_fw_cfg/by_name/opt/org.valencebox.config/raw)
    PORT=$(echo "$CONFIG" | grep -o '"port":[0-9]*' | grep -o '[0-9]*')
    TOKEN=$(echo "$CONFIG" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

**Guest-side WebDAV client:** [`davfs2`](https://packages.ubuntu.com/noble/davfs2)
(`apt install davfs2`). It mounts a WebDAV resource as a FUSE filesystem and works
with plain HTTP (no TLS). The guest mounts the host's Nephele server via SLIRP:

    echo "http://10.0.2.2:$PORT/ valence $TOKEN" >> /etc/davfs2/secrets
    mount -t davfs http://10.0.2.2:$PORT/ /host-workspace

Since auth is handled via Basic + token, configure `/etc/davfs2/davfs2.conf`:
- `use_locks 0` (no locking needed for a single-user sync bridge)
- No TLS settings needed — `http://` URLs are treated as plain HTTP
- `secrets ''` means davfs2 reads from the default secrets file, not env

- [x] Rewrite `guest/Dockerfile`: Ubuntu 24.04, `linux-image-virtual` kernel + modules
- [x] Initramfs features: `virtio_blk`, `virtio_net`, `ext4`
- [x] Read-only root fix: add `rootflags=rw` to kernel cmdline (initramfs defaults to `ro`)
- [x] Root fs on `/dev/vda`; workspace qcow2 on `/dev/vdb` mounted at `/workspace`
- [x] Install `davfs2`, `rsync`, `inotify-tools` in the guest
- [x] Configure `/etc/davfs2/davfs2.conf`: `use_locks 0`
- [x] Boot-time init script that reads fw_cfg config, writes davfs2 secrets,
      then mounts the WebDAV share
- [x] OpenRC service `workspace-sync`:
       1. wait for WebDAV mount at `/host-workspace`
       2. `inotifywait` loop on `/workspace` → `rsync` to `/host-workspace` (guest→host, prompt)
       3. ~2s poll `rsync` `/host-workspace` → `/workspace` (host→guest, poll-bound)
       4. exclude `node_modules`, `.git`, `.DS_Store`, `.sync-tmp`, `lost+found`
- [x] Serial getty autologin on `ttyS0`
- [x] Rewrite `scripts/build-guest.sh`: output `root.qcow2` + empty `workspace.qcow2` (no Rust, no v86 assets); honor `WORKSPACE_MB`

### Phase 5 — Snapshots via QMP

Goal: warm-boot snapshots of RAM + device state (workspace is host-canonical, so
it is **not** part of the snapshot).

- [ ] Rewrite `src/main/snapshot.ts`
- [ ] Save: QMP `migrate-set-capabilities` → `migrate "exec:zstd -o <tmp>"` → wait for `MIGRATION` completed → atomic rename to `<name>.snap.zst`
- [ ] Write `<name>.meta.json`: guest image digest, QEMU version, timestamp, RAM size
- [ ] Restore: launch QEMU with `-incoming "exec:zstd -dc <file>"`, then `cont`
- [ ] Refuse restore on image-digest / QEMU-version mismatch

**Verify (`test:snapshot`):** boot, create a marker file in `/workspace` and an
in-RAM marker (e.g. an env/process), save, kill QEMU, restore, assert the guest
resumes with RAM state intact.

### Phase 6 — Orchestration + egress + config

Goal: wire the pieces into the app lifecycle and restore user-facing config.

- [ ] Rewrite `src/main/sandbox.ts` / `main.ts` to drive: HTTP share → QEMU spawn → QMP ready → serial to UI
- [ ] `-nic user` open egress (document as temporary regression vs. old allowlist)
- [ ] `sandbox.config.json`: `accel` (override/force), `workspaceDir`, `memMb`, `smp`, `egress` (placeholder)
- [ ] Clean shutdown ordering: stop sync → snapshot (optional) → `system_powerdown` → stop HTTP server

**Verify (`test:e2e`):** full cold-boot → edit round-trip → snapshot → restore →
shutdown, driven through the app orchestration layer.

### Phase 7 — Packaging (all 3 platforms)

Goal: self-contained installers with QEMU + firmware + images bundled.

- [ ] electron-builder config; `resources/qemu/<platform>/qemu-system-x86_64` (+ libs)
- [ ] Bundle firmware blobs: `bios-256k.bin`, `vgabios-stdvga.bin`, virtio option ROMs
- [ ] Bundle guest images: `root.qcow2`, template `workspace.qcow2`
- [ ] Make executables relocatable (RPATH / `LD_LIBRARY_PATH` / `DYLD_*` shims)
- [ ] **Prototype the Windows bundle early** — biggest packaging risk (WHPX + portable QEMU + DLLs)
- [ ] Verify accel fallback in the packaged app on each OS (KVM/HVF/WHPX present and absent)
- [ ] Update `THIRD_PARTY_LICENSES.md` (QEMU GPLv2)

**Verify:** install the packaged app on Linux/macOS/Windows; cold-boot to a
working terminal; confirm hw-accel is used when available and TCG otherwise.

### Phase 8 — Docs & cleanup

- [ ] Rewrite `HARDENING.md`: host-canonical dir, plain-HTTP loopback share, open egress (temporary), no agent/relay
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
2. **WHPX perf** on Windows is modest — higher VM-exit cost than KVM/HVF,
   sometimes barely above TCG. Be transparent in docs; TCG fallback still works.
3. **`/dev/kvm` access on Linux** gates KVM at runtime (user must be in `kvm`
   group). Binary must be *built* with `--enable-kvm` (+ `hvf`/`whpx` per OS);
   it checks availability at runtime and falls back to TCG.
4. **host→guest latency** is poll-bound (~2s). Acceptable for source edits;
   documented. inotify cannot cross the network share.
5. **Open egress** is a security regression vs. today's DNS-gate + IP-pin
   allowlist. Re-add a filtering proxy in a later phase.
6. **qcow2 double disk usage** (host canonical copy + guest qcow2 mirror) is
   expected by design.
7. **TCG defaults** (`-smp`, `tb-size`, MTTCG) need validation against a real
   npm/cargo build workload before locking in.
