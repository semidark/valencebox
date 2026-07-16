#!/bin/sh
# Build the x86-64 Alpine guest: Docker image → root.qcow2 + workspace.qcow2
# Extracts vmlinuz-virt and initramfs-virt for microvm direct kernel boot.
set -e
cd "$(dirname "$0")/.."

mkdir -p images

echo "==> building guest docker image (x86-64 Alpine, linux-virt)"
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
# --numeric-owner avoids issues with Docker-exported UIDs (e.g. bbsuid busybox
# symlink with non-matching ownership) causing mkfs.ext4 -d to fail with
# "Permission denied" on the copy.
tar -xf images/rootfs.tar -C /tmp/sandbox-rootfs --numeric-owner

# Set hostname and hosts
echo sandbox > /tmp/sandbox-rootfs/etc/hostname
printf "127.0.0.1\tlocalhost sandbox\n" > /tmp/sandbox-rootfs/etc/hosts

# Remove unnecessary files before creating fs
rm -f /tmp/sandbox-rootfs/.dockerenv 2>/dev/null || true
# bbsuid is ---s--x--x owned by root — mkfs.ext4 -d can't create it as non-root.
# Relax to 755; the guest doesn't need suid binaries.
chmod 0755 /tmp/sandbox-rootfs/bin/bbsuid 2>/dev/null || true

# Extract kernel + initramfs from exported rootfs
cp /tmp/sandbox-rootfs/boot/vmlinuz-virt images/vmlinuz.bin
cp /tmp/sandbox-rootfs/boot/initramfs-virt images/initramfs.bin
rm -rf /tmp/sandbox-rootfs/boot/*

# Root image size: 25% slack + 32 MiB headroom
SZ=$(du -sm /tmp/sandbox-rootfs | cut -f1); SZ=$((SZ + SZ / 4 + 32))

# Create raw ext4 image via Docker (no host e2fsprogs needed), then convert to qcow2
dd if=/dev/zero of=/tmp/sandbox-rootfs.img bs=1M count="$SZ" status=none
docker run --rm --platform=linux/amd64 \
  -v /tmp/sandbox-rootfs:/rootfs:ro \
  -v /tmp/sandbox-rootfs.img:/rootfs.img \
  alpine:3.21 sh -c 'apk add --quiet e2fsprogs && mkfs.ext4 -q -d /rootfs -L sandboxroot /rootfs.img'
qemu-img convert -f raw -O qcow2 /tmp/sandbox-rootfs.img images/root.qcow2
rm -f /tmp/sandbox-rootfs.img

# Workspace disk
WSZ="${WORKSPACE_MB:-1024}"
rm -f images/workspace.qcow2
qemu-img create -f qcow2 images/workspace.qcow2 "${WSZ}M"

# Clean up
rm -rf /tmp/sandbox-rootfs images/rootfs.tar

echo "==> done"
ls -lh images/
