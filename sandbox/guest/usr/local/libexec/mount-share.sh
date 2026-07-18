#!/bin/sh
# Format workspace qcow2 if needed, write WebDAV secrets from kernel cmdline.
set -e

# Always ensure /host-workspace mount point exists
mkdir -p /host-workspace

# Format workspace disk if not already formatted
if [ -b /dev/vdb ]; then
  mkfs.ext4 -F -q /dev/vdb 2>/dev/null || true
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