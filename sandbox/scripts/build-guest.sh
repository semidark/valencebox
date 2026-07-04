#!/bin/sh
# Build the guest: sync-agent (Go, linux/386) → docker image → ext4 disk
# images + kernel/initramfs extracted for direct v86 bzimage boot.
set -e
cd "$(dirname "$0")/.."

mkdir -p images assets/v86

echo "==> copying v86 runtime assets from env86 submodule"
ENV86_ASSETS="../env86/assets"
missing=""
for f in libv86.js v86.wasm seabios.bin vgabios.bin; do
	if [ ! -f "$ENV86_ASSETS/$f" ]; then missing="$missing $f"; fi
done
if [ -n "$missing" ]; then
	echo "ERROR: env86 assets not built:$missing" >&2
	echo "  Run first (from the repo root):" >&2
	echo "    git submodule update --init && make -C env86 all" >&2
	exit 1
fi
for f in libv86.js v86.wasm seabios.bin vgabios.bin; do
	cp "$ENV86_ASSETS/$f" "assets/v86/$f"
done

echo "==> building sync-agent (Rust, i686-unknown-linux-musl)"
(cd guest/sync-agent-rust && cargo build --target i686-unknown-linux-musl --release)
cp guest/sync-agent-rust/target/i686-unknown-linux-musl/release/sync-agent guest/sync-agent.bin

echo "==> building guest docker image"
docker build --platform=linux/386 -t sandbox-guest -f guest/Dockerfile guest

echo "==> exporting rootfs"
docker rm -f sandbox-export >/dev/null 2>&1 || true
docker create --platform=linux/386 --name sandbox-export sandbox-guest >/dev/null
docker export sandbox-export -o images/rootfs.tar
docker rm sandbox-export >/dev/null

echo "==> creating ext4 images (inside container for mkfs.ext4 -d)"
docker run --rm -v "$PWD/images:/images" alpine:3.20 sh -ec '
	apk add -q e2fsprogs
	mkdir /fs && tar -xf /images/rootfs.tar -C /fs
	echo sandbox > /fs/etc/hostname
	printf "127.0.0.1\tlocalhost sandbox\n" > /fs/etc/hosts
	cp /fs/boot/vmlinuz-lts /images/vmlinuz.bin
	cp /fs/boot/initramfs-lts /images/initramfs.bin
	rm -rf /fs/boot/* /fs/.dockerenv
	SZ=$(du -sm /fs | cut -f1); SZ=$((SZ + SZ / 4 + 64))
	rm -f /images/alpine-root.img /images/workspace.img
	mkfs.ext4 -q -d /fs -L sandboxroot /images/alpine-root.img "${SZ}M"
	mkfs.ext4 -q -L workspace /images/workspace.img 512M
	chmod 644 /images/*.img /images/vmlinuz.bin /images/initramfs.bin
'
rm -f images/rootfs.tar
ls -lh images/
