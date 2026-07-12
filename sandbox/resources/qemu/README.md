# Bundled QEMU binaries

Each platform directory (`linux/`, `darwin/`, `win32/`) contains
`qemu-system-x86_64` and any needed shared libraries / DLLs for that platform.

## Source

### Linux

On Debian/Ubuntu: `apt install qemu-system-x86` and symlink the binary.
For a portable build, use the QEMU project's own `--enable-static`:

```sh
# From QEMU source tree
./configure --target-list=x86_64-softmmu --enable-static --enable-kvm
make -j$(nproc)
```

The static binary has no runtime library dependencies and works on any Linux
kernel ≥ the build host's glibc minimum. It includes KVM support if built with
`--enable-kvm` (runtime-detected via `/dev/kvm`).

Prebuilt static binaries can be obtained from:
- https://github.com/marcan/qemu-static (community builds)
- QEMU release tarballs + `--enable-static`

### macOS

Build from source with `--enable-hvf` or use Homebrew: `brew install qemu`.
The Homebrew binary has HVF support and is portable as long as its dylib deps
are bundled.

### Windows

Build from source with `--enable-whpx` or use a prebuilt Windows binary from
https://qemu.weilnetz.de/ — ensure WHPX acceleration is compiled in.

## Dev workflow

During development the code first checks for a binary in this tree, then falls
back to `$PATH` (allowing the use of a system-installed QEMU).

## Firmware blobs

QEMU looks for firmware in its own `pc-bios/` directory relative to the
binary's install prefix. When bundling a portable build, copy these files
alongside the binary:
- `bios-256k.bin`
- `vgabios-stdvga.bin`
- `edk2-x86_64-code.fd` (UEFI, if needed)
- virtio option ROMs (`efi-virtio.rom`, etc.)
