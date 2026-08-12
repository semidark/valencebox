#!/bin/sh
# Format workspace qcow2 if needed, write WebDAV secrets from kernel cmdline,
# and mount /workspace.
set -e

mkdir -p /workspace /host-workspace

# Format workspace disk safely ONLY if not already formatted (prevents data
# loss on reboot). blkid exits non-zero when no filesystem is detected.
if [ -b /dev/vdb ]; then
  if ! blkid /dev/vdb >/dev/null 2>&1; then
    echo "Formatting /dev/vdb as ext4..."
    mkfs.ext4 -F -q /dev/vdb
  fi
fi

# Explicitly mount /workspace if not already mounted. On a subsequent boot
# systemd may mount it early via the fstab-generated workspace.mount, but on
# the very first boot (disk unformatted at fstab parse time) we must handle it.
if [ -b /dev/vdb ] && ! mountpoint -q /workspace; then
  echo "Mounting /dev/vdb on /workspace..."
  mount -o noatime /dev/vdb /workspace
fi

# Read port/token from kernel cmdline (set by host in qemu.ts -append)
port=$(sed -n 's/.*valencebox\.port=\([0-9]*\).*/\1/p' /proc/cmdline)
token=$(sed -n 's/.*valencebox\.token=\([a-f0-9]*\).*/\1/p' /proc/cmdline)

if [ -n "$port" ] && [ -n "$token" ]; then
  mkdir -p /etc/davfs2
  echo "http://10.0.2.2:${port}/ valence ${token}" > /etc/davfs2/secrets
  chmod 0600 /etc/davfs2/secrets
  chown 0:0 /etc/davfs2/secrets 2>/dev/null || true
  chown 0:0 /etc/davfs2 2>/dev/null || true

  mkdir -p /var/cache/davfs2
  chmod 0700 /var/cache/davfs2
fi