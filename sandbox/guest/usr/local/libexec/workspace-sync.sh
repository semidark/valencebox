#!/bin/sh
# Bidir sync loop between /workspace (native qcow2) and /host-workspace (WebDAV).
# Uses unison -repeat with marker-file guard.
set -e

HOME=/root; export HOME
mkdir -p /root/.unison /host-workspace

# Wait for /workspace mount (belt-and-suspenders with systemd unit deps)
for i in $(seq 30); do
  mountpoint -q /workspace && break
  sleep 1
done
mountpoint -q /workspace || exit 1

# Mount WebDAV share with retries
share_url=$(grep -v '^#' /etc/davfs2/secrets 2>/dev/null | grep -v '^$' | head -1 | awk '{print $1}')
[ -n "$share_url" ] || exit 1

for attempt in 1 2 3; do
  mountpoint -q /host-workspace && break
  mount -t davfs "$share_url" /host-workspace 2>/dev/null && break
  sleep 5
done
mountpoint -q /host-workspace || exit 1

# Wait for sync marker (host writes this after starting the WebDAV server)
while ! [ -f /host-workspace/.valence-sync-marker ]; do
  sleep 2
done

# Rebuild unison archive on each start (qcow2 is a host-canonical cache)
rm -f /root/.unison/*

# Repeat sync loop — exec replaces shell so systemd tracks unison directly
exec unison /host-workspace /workspace \
  -batch -auto -prefer /host-workspace -repeat 2 \
  -ignore 'Name node_modules' \
  -ignore 'Name .git' \
  -ignore 'Name .DS_Store' \
  -ignore 'Name lost+found' \
  -ignore 'Name .valence-sync-marker' \
  &>/var/log/unison.log
