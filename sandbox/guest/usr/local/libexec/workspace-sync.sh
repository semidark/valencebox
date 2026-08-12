#!/bin/sh
# Bidir sync loop between /workspace (native qcow2) and /host-workspace (WebDAV).
# Uses unison -repeat with marker-file guard.
set -e

HOME=/root; export HOME
mkdir -p /root/.unison

# Wait for /workspace mount (belt-and-suspenders with systemd unit deps)
for i in $(seq 30); do
  mountpoint -q /workspace && break
  sleep 1
done
mountpoint -q /workspace || exit 1

# Mount WebDAV share with retries
share_url=$(grep -v '^#' /etc/davfs2/secrets 2>/dev/null | grep -v '^$' | head -1 | awk '{print $1}')
[ -n "$share_url" ] || exit 1

# Helper: check if /host-workspace is a usable mount (not stale FUSE).
# A stale davfs mount passes `mountpoint -q` but any I/O returns ENOTCONN
# ("Transport endpoint is not connected").
host_ws_ok() {
  mountpoint -q /host-workspace && ls /host-workspace >/dev/null 2>&1
}

# If davfs left /host-workspace stale ("Transport endpoint not connected"),
# force-unmount it. Regular `umount` cannot detach a broken FUSE endpoint;
# `umount -l` (lazy) detaches the namespace entry. Also remove davfs's stale
# pidfile which blocks remount ("already mounted" error).
if mountpoint -q /host-workspace && ! ls /host-workspace >/dev/null 2>&1; then
  umount -l /host-workspace 2>/dev/null || true
  rm -f /var/run/mount.davfs/host-workspace.pid
fi

for attempt in 1 2 3; do
  host_ws_ok && break
  mount -t davfs "$share_url" /host-workspace 2>/dev/null && break
  sleep 5
done
host_ws_ok || exit 1

# Wait for sync marker (host writes this after starting the WebDAV server)
while ! [ -f /host-workspace/.valence-sync-marker ]; do
  sleep 2
done

# Rebuild unison archive on each start (qcow2 is a host-canonical cache)
rm -f /root/.unison/*

# Repeat sync loop — exec replaces shell so systemd tracks unison directly.
# NOTE: &> is a bashism; this script runs under dash (#!/bin/sh). Use POSIX
# redirect: >/var/log/unison.log 2>&1
exec unison /host-workspace /workspace \
  -batch -auto -prefer /host-workspace -repeat 2 \
  -ignore 'Name node_modules' \
  -ignore 'Name .git' \
  -ignore 'Name .DS_Store' \
  -ignore 'Name lost+found' \
  -ignore 'Name .valence-sync-marker' \
  >/var/log/unison.log 2>&1
