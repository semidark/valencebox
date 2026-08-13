# ValenceBox

> [!NOTE]
> **Experimental**
>
> ValenceBox runs a QEMU-backed x86-64 or aarch64 Linux microVM inside an
> Electron app, providing an isolated coding sandbox for an AI agent with
> native-speed file I/O, bidirectional host↔guest file sync, and controlled
> network egress over SLIRP.

A secure, high-performance coding sandbox for an AI agent: an x86-64 or aarch64
Ubuntu 24.04 microVM running under QEMU inside an Electron app. The agent is
isolated from the host but gets native-speed file I/O against a real ext4 disk,
bidirectional host↔guest file sync via WebDAV + unison, and controlled network
access over loopback SLIRP.

## Layout

| Path | What it is |
|------|------------|
| [`sandbox/`](sandbox/) | **The product.** The Electron app: QEMU subprocess wrapper, WebDAV host share, xterm.js terminal, guest images. Start here — see [`sandbox/README.md`](sandbox/README.md). |
| [`scripts/build-qemu.sh`](scripts/build-qemu.sh) / [`scripts/build-qemu.ps1`](scripts/build-qemu.ps1) | Build QEMU from source. Produces a self-contained `sandbox/resources/qemu/<platform>/` tree with binary, firmware, and dylibs. |

## License

AGPL-3.0-only — see [`LICENSE`](LICENSE). Third-party attributions (xterm.js,
QEMU firmware blobs) are listed in
[`sandbox/THIRD_PARTY_LICENSES.md`](sandbox/THIRD_PARTY_LICENSES.md).

## Quick start

```sh
# Build QEMU (once)
bash ../scripts/build-qemu.sh   # or: pwsh ../scripts/build-qemu.ps1 on Windows

cd sandbox
npm install
npm run images                  # build guest disk images (needs Docker)
npm run build                   # compile TS -> dist/
npm start                       # launch the app

# point the sandbox at a real project instead of the default workspace:
WORKSPACE_DIR=~/src/myproject npm start
```

Full build, test, and architecture docs live in
[`sandbox/README.md`](sandbox/README.md), with the security model in
[`sandbox/HARDENING.md`](sandbox/HARDENING.md).

## Guests

| Arch | Default on | Acceleration |
|------|------------|--------------|
| **x86-64** | Linux, Windows, macOS fallback | KVM / WHPX / TCG |
| **aarch64** | Apple Silicon (macOS) | HVF (signed app) / TCG |

The aarch64 guest is selected automatically on Apple Silicon when the QEMU
binary and arm64 guest images are present. x86-64 TCG is the fallback path.
See [`sandbox/docs/qemu.md`](sandbox/docs/qemu.md) for details.
