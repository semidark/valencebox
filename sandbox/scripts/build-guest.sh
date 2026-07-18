#!/bin/sh
# Build the Ubuntu guest rootfs for QEMU direct kernel boot.
# Supports x86-64 (default) and arm64 (--arch arm64) targets.
# Output: root.qcow2, vmlinuz.bin, initramfs.bin, workspace.qcow2
# On arm64: root-arm64.qcow2, vmlinuz-arm64.bin, initramfs-arm64.bin, workspace-arm64.qcow2
set -e
cd "$(dirname "$0")/.."

ARCH=""
SUFFIX=""
PLATFORM_FLAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --arch)
      shift
      ARCH="$1"
      shift
      ;;
    *)
      echo "unknown option: $1"
      echo "usage: $0 [--arch amd64|arm64]"
      exit 1
      ;;
  esac
done

# Default to host architecture
if [ -z "$ARCH" ]; then
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "unsupported host arch: $ARCH"; exit 1 ;;
  esac
fi

case "$ARCH" in
  amd64)
    SUFFIX=""
    PLATFORM_FLAG="linux/amd64"
    ;;
  arm64)
    SUFFIX="-arm64"
    PLATFORM_FLAG="linux/arm64"
    ;;
  *)
    echo "unsupported target arch: $ARCH (use amd64 or arm64)"
    exit 1
    ;;
esac

GUEST_ARCH_LABEL=$(echo "$ARCH" | sed 's/amd64/x86-64/')

# Register QEMU user-mode emulators for cross-arch Docker builds (e.g., arm64 on
# x86-64 host). Idempotent — safe to run every build.
if [ "$ARCH" != "amd64" ]; then
  docker run --privileged --rm tonistiigi/binfmt --install "$ARCH" 2>/dev/null || true
fi

# Resolve qemu-img: prefer bundled, fall back to PATH
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
QEMU_IMG=./resources/qemu/$PLATFORM/qemu-img
[ -x "$QEMU_IMG" ] || QEMU_IMG=qemu-img

mkdir -p images

echo "==> building guest docker image ($GUEST_ARCH_LABEL Ubuntu, linux-image-virtual)"
if [ "$ARCH" = "arm64" ]; then
  docker buildx build \
    --platform="$PLATFORM_FLAG" \
    -t sandbox-guest-"$ARCH" \
    -f guest/Dockerfile \
    --load \
    guest
else
  docker build \
    --platform="$PLATFORM_FLAG" \
    -t sandbox-guest \
    -f guest/Dockerfile guest
fi

echo "==> exporting rootfs"
docker rm -f sandbox-export-"$ARCH" >/dev/null 2>&1 || true
docker create --platform="$PLATFORM_FLAG" --name sandbox-export-"$ARCH" \
  $( [ "$ARCH" = "arm64" ] && echo "sandbox-guest-arm64" || echo "sandbox-guest" ) \
  >/dev/null
docker export sandbox-export-"$ARCH" -o images/rootfs"$SUFFIX".tar
docker rm sandbox-export-"$ARCH" >/dev/null

echo "==> creating root${SUFFIX}.qcow2"
rm -f "images/root${SUFFIX}.qcow2"
# Clean stale root-owned .ssh from previous failed builds
docker run --rm --platform=linux/amd64 \
  -v /tmp:/tmproot \
  ubuntu:24.04 sh -c "rm -rf /tmproot/sandbox-rootfs${SUFFIX} 2>/dev/null || true"
mkdir -p "/tmp/sandbox-rootfs${SUFFIX}"
tar -xf "images/rootfs${SUFFIX}.tar" -C "/tmp/sandbox-rootfs${SUFFIX}" --numeric-owner

# Set hostname and hosts
echo sandbox > "/tmp/sandbox-rootfs${SUFFIX}/etc/hostname"
printf "127.0.0.1\tlocalhost sandbox\n" > "/tmp/sandbox-rootfs${SUFFIX}/etc/hosts"

# Generate vm-debug SSH keypair and inject the public key into the guest.
# The private key is saved to images/vm-debug for host-side SSH access.
mkdir -p images
if [ ! -f images/vm-debug ]; then
  ssh-keygen -t ed25519 -f images/vm-debug -N '' -q -C 'vm-debug@valencebox'
fi
mkdir -p "/tmp/sandbox-rootfs${SUFFIX}/root/.ssh"
cp images/vm-debug.pub "/tmp/sandbox-rootfs${SUFFIX}/root/.ssh/authorized_keys"
chmod 700 "/tmp/sandbox-rootfs${SUFFIX}/root/.ssh"
chmod 600 "/tmp/sandbox-rootfs${SUFFIX}/root/.ssh/authorized_keys"

# Remove unnecessary files before creating fs
rm -f "/tmp/sandbox-rootfs${SUFFIX}/.dockerenv" 2>/dev/null || true

# Extract kernel + initramfs from exported rootfs
KREL=$(ls "/tmp/sandbox-rootfs${SUFFIX}/lib/modules" 2>/dev/null | head -1)
if [ -z "$KREL" ]; then
  echo "ERROR: no kernel modules found in exported rootfs" >&2
  exit 1
fi
cp "/tmp/sandbox-rootfs${SUFFIX}/boot/vmlinuz-$KREL" "images/vmlinuz${SUFFIX}.bin"
cp "/tmp/sandbox-rootfs${SUFFIX}/boot/initrd.img-$KREL" "images/initramfs${SUFFIX}.bin"
rm -rf "/tmp/sandbox-rootfs${SUFFIX}/boot/*"

# Root image size: at least 5 GiB for growth (qcow2 is sparse). 25% slack.
MIN_ROOT_MB=5120
SZ=$(du -sm "/tmp/sandbox-rootfs${SUFFIX}" | cut -f1); SZ=$((SZ + SZ / 4))
[ "$SZ" -lt "$MIN_ROOT_MB" ] && SZ=$MIN_ROOT_MB

# Create raw ext4 image via Docker, then convert to qcow2.
# The mkfs container runs as root and fixes ownership of SSH authorized_keys
# (created by the build user) inline before embedding them in the image.
dd if=/dev/zero of="/tmp/sandbox-rootfs${SUFFIX}.img" bs=1M count="$SZ" status=none
docker run --rm --platform="$PLATFORM_FLAG" \
  -v "/tmp/sandbox-rootfs${SUFFIX}:/rootfs" \
  -v "/tmp/sandbox-rootfs${SUFFIX}.img:/rootfs.img" \
  ubuntu:24.04 sh -c '
    apt-get update -qq && apt-get install -y -qq e2fsprogs >/dev/null
    chown -R root:root /rootfs/root/.ssh
    mkfs.ext4 -q -d /rootfs -L sandboxroot /rootfs.img
  '
"$QEMU_IMG" convert -f raw -O qcow2 "/tmp/sandbox-rootfs${SUFFIX}.img" "images/root${SUFFIX}.qcow2"
rm -f "/tmp/sandbox-rootfs${SUFFIX}.img"

# Workspace disk
WSZ="${WORKSPACE_MB:-1024}"
rm -f "images/workspace${SUFFIX}.qcow2"
"$QEMU_IMG" create -f qcow2 "images/workspace${SUFFIX}.qcow2" "${WSZ}M"

# Clean up (root-owned .ssh from prior build may block host rm; ignore errors)
rm -rf "/tmp/sandbox-rootfs${SUFFIX}" 2>/dev/null || true
rm -f "images/rootfs${SUFFIX}.tar"

echo "==> done"
ls -lh images/ | grep -- "${SUFFIX}" || ls -lh images/