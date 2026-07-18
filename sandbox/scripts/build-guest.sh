#!/bin/sh
# Build the x86-64 Ubuntu guest: Docker image → root.qcow2 + workspace.qcow2
# Extracts vmlinuz and initrd.img for direct kernel boot.
set -e
cd "$(dirname "$0")/.."

# Resolve qemu-img: prefer bundled, fall back to PATH
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
QEMU_IMG=./resources/qemu/$PLATFORM/qemu-img
[ -x "$QEMU_IMG" ] || QEMU_IMG=qemu-img

mkdir -p images

echo "==> building guest docker image (x86-64 Ubuntu, linux-image-virtual)"
docker build \
  --platform=linux/amd64 \
  -t sandbox-guest \
  -f guest/Dockerfile guest

echo "==> exporting rootfs"
docker rm -f sandbox-export >/dev/null 2>&1 || true
docker create --platform=linux/amd64 --name sandbox-export sandbox-guest >/dev/null
docker export sandbox-export -o images/rootfs.tar
docker rm sandbox-export >/dev/null

echo "==> creating root.qcow2"
rm -f images/root.qcow2
mkdir -p /tmp/sandbox-rootfs
# --numeric-owner avoids issues with Docker-exported UIDs
tar -xf images/rootfs.tar -C /tmp/sandbox-rootfs --numeric-owner

# Set hostname and hosts
echo sandbox > /tmp/sandbox-rootfs/etc/hostname
printf "127.0.0.1\tlocalhost sandbox\n" > /tmp/sandbox-rootfs/etc/hosts

# Remove unnecessary files before creating fs
rm -f /tmp/sandbox-rootfs/.dockerenv 2>/dev/null || true

# Extract kernel + initramfs from exported rootfs
# Ubuntu names them vmlinuz-<version> and initrd.img-<version>
KREL=$(ls /tmp/sandbox-rootfs/lib/modules 2>/dev/null | head -1)
if [ -z "$KREL" ]; then
  echo "ERROR: no kernel modules found in exported rootfs" >&2
  exit 1
fi
cp "/tmp/sandbox-rootfs/boot/vmlinuz-$KREL" images/vmlinuz.bin
cp "/tmp/sandbox-rootfs/boot/initrd.img-$KREL" images/initramfs.bin
rm -rf /tmp/sandbox-rootfs/boot/*

# Root image size: at least 5 GiB for growth (qcow2 is sparse, so host
# consumption tracks actual data). 25% slack above that for future upgrades.
MIN_ROOT_MB=5120
SZ=$(du -sm /tmp/sandbox-rootfs | cut -f1); SZ=$((SZ + SZ / 4))
[ "$SZ" -lt "$MIN_ROOT_MB" ] && SZ=$MIN_ROOT_MB

# Create raw ext4 image via Docker, then convert to qcow2
dd if=/dev/zero of=/tmp/sandbox-rootfs.img bs=1M count="$SZ" status=none
docker run --rm --platform=linux/amd64 \
  -v /tmp/sandbox-rootfs:/rootfs:ro \
  -v /tmp/sandbox-rootfs.img:/rootfs.img \
  ubuntu:24.04 sh -c 'apt-get update -qq && apt-get install -y -qq e2fsprogs >/dev/null && mkfs.ext4 -q -d /rootfs -L sandboxroot /rootfs.img'
"$QEMU_IMG" convert -f raw -O qcow2 /tmp/sandbox-rootfs.img images/root.qcow2
rm -f /tmp/sandbox-rootfs.img

# Workspace disk
WSZ="${WORKSPACE_MB:-1024}"
rm -f images/workspace.qcow2
"$QEMU_IMG" create -f qcow2 images/workspace.qcow2 "${WSZ}M"

# Clean up
rm -rf /tmp/sandbox-rootfs images/rootfs.tar

echo "==> done"
ls -lh images/
