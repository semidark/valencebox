#!/bin/sh
# Build the guest: sync-agent (Rust) → docker image → ext4 disk
# images + kernel/initramfs extracted for direct v86 bzimage boot.
set -e
cd "$(dirname "$0")/.."

mkdir -p images assets/v86

echo "==> copying v86 runtime assets from build/v86"
V86_ASSETS="../build/v86"
missing=""
for f in libv86.js v86.wasm seabios.bin vgabios.bin; do
	if [ ! -f "$V86_ASSETS/$f" ]; then missing="$missing $f"; fi
done
if [ -n "$missing" ]; then
	echo "ERROR: v86 assets not built:$missing" >&2
	echo "  Run first (from the repo root):" >&2
	echo "    git submodule update --init v86 && ./scripts/build-v86.sh" >&2
	exit 1
fi
for f in libv86.js v86.wasm seabios.bin vgabios.bin; do
	cp "$V86_ASSETS/$f" "assets/v86/$f"
done

echo "==> building sync-agent (Rust, i686-unknown-linux-musl, inside Docker)"
docker run --rm \
  --platform=linux/amd64 \
  -v "$PWD/guest/sync-agent-rust:/src" \
  -v "$PWD/guest:/output" \
  rust:alpine \
  sh -c "
    apk add musl-dev &&
    rustup target add i686-unknown-linux-musl &&
    cd /src &&
    cargo build --target i686-unknown-linux-musl --release &&
    cp target/i686-unknown-linux-musl/release/sync-agent /output/sync-agent.bin &&
    cargo build --target i686-unknown-linux-musl --release --bin blake2sum &&
    cp target/i686-unknown-linux-musl/release/blake2sum /output/blake2sum.bin
  "

echo "==> building guest docker image"
docker build \
  --platform=linux/386 \
  -t sandbox-guest \
  -f guest/Dockerfile guest

echo "==> exporting rootfs"
docker rm -f sandbox-export >/dev/null 2>&1 || true
docker create --platform=linux/386 --name sandbox-export sandbox-guest >/dev/null
docker export sandbox-export -o images/rootfs.tar
docker rm sandbox-export >/dev/null

echo "==> creating ext4 images (inside container for mkfs.ext4 -d)"
docker run --rm -e WORKSPACE_MB -v "$PWD/images:/images" alpine:3.20 sh -ec '
	apk add -q e2fsprogs
	mkdir /fs && tar -xf /images/rootfs.tar -C /fs
	echo sandbox > /fs/etc/hostname
	printf "127.0.0.1\tlocalhost sandbox\n" > /fs/etc/hosts
	cp /fs/boot/vmlinuz-lts /images/vmlinuz.bin
	cp /fs/boot/initramfs-lts /images/initramfs.bin
	rm -rf /fs/boot/* /fs/.dockerenv
	# Root image headroom: 25% slack + 32 MiB (was 12.5% + 16 MiB, which
	# filled / to 100% on first boot — ext4 metadata + first-boot writes
	# (logs, run state) consumed the headroom). The rootfs sees limited
	# runtime writes (sync-agent writes hdb, not hda) but OpenRC scratch
	# and apk cache land here; keep some breathing room.
	SZ=$(du -sm /fs | cut -f1); SZ=$((SZ + SZ / 4 + 32))
	rm -f /images/alpine-root.img /images/workspace.img
	mkfs.ext4 -q -d /fs -L sandboxroot /images/alpine-root.img "${SZ}M"
	# Workspace disk size is configurable (128 MiB default); override with
	# WORKSPACE_MB=<n> when running `npm run images`. The guest runs npm
	# install inside /workspace, so 128 is tight for big Node projects —
	# bump via the env var when you need more room.
	WSZ="${WORKSPACE_MB:-128}"
	mkfs.ext4 -q -L workspace /images/workspace.img "${WSZ}M"
	chmod 644 /images/*.img /images/vmlinuz.bin /images/initramfs.bin
'
rm -f images/rootfs.tar
ls -lh images/
