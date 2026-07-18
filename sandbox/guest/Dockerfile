# ── Single-stage: x86-64 Ubuntu guest rootfs ──
# Produces a bootable rootfs for QEMU microvm/pc with virtio-blk root,
# workspace qcow2 mount, WebDAV host share, and bidir sync service.
FROM ubuntu:24.04

ENV HOSTNAME=sandbox

# Prevent dpkg from trying to ask interactive questions when building
ENV DEBIAN_FRONTEND=noninteractive

# Base system: kernel, initramfs, systemd, networking
RUN apt-get update && apt-get install -y --no-install-recommends \
    linux-image-virtual \
    initramfs-tools \
    systemd \
    systemd-sysv \
    dbus \
    openssh-server \
    dhcpcd5 \
    curl \
    ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# davfs2, unison, rsync, inotify-tools for workspace share + sync
RUN apt-get update && apt-get install -y --no-install-recommends \
    davfs2 \
    unison \
    rsync \
    inotify-tools \
    e2fsprogs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Explicit initramfs module list. Docker containers have no virtio devices,
# so initramfs-tools auto-detection finds nothing — we must list them here.
# virtio_mmio is needed for -machine microvm (non-PCI transport);
# virtio_blk/ virtio_net are built-in on x86_64 but listed for safety;
# port/token passed via kernel cmdline (no fw_cfg needed).
RUN printf '%s\n' \
    virtio_blk \
    virtio_net \
    virtio_mmio \
    ext4 \
    virtio_console \
    virtio_rng \
    > /etc/initramfs-tools/modules

# Rebuild initramfs with the explicit module list baked in
RUN KREL=$(ls /lib/modules | head -1) && \
    mkinitramfs -o /boot/initrd.img-"$KREL" "$KREL"

# Strip irrelevant kernel modules (microvm/pc: no sound, GPU, USB, wireless)
RUN KREL=$(ls /lib/modules | head -1) && \
    cd /lib/modules/$KREL/kernel && \
    rm -rf sound \
           drivers/gpu drivers/media drivers/usb drivers/bluetooth \
           drivers/staging drivers/infiniband drivers/isdn drivers/pcmcia \
           drivers/parport drivers/char/lp* drivers/thunderbolt \
           drivers/net/wireless drivers/net/wwan drivers/net/can \
           drivers/net/dsa \
           drivers/hid drivers/input/joystick drivers/input/touchscreen \
           drivers/input/tablet drivers/iio drivers/leds drivers/mmc \
           drivers/mtd drivers/w1 drivers/watchdog drivers/xen \
           drivers/video net/bluetooth net/wireless net/mac80211 \
           net/nfc net/6lowpan net/ieee802154 net/qrtr net/rfkill \
           drivers/char/agp drivers/char/ipmi drivers/char/hw_random \
           drivers/char/tpm drivers/char/mwave drivers/char/drm \
           drivers/gpio drivers/platform drivers/soc \
           drivers/scsi/aic7xxx drivers/scsi/aic79xx drivers/scsi/megaraid \
           drivers/scsi/mpt3sas drivers/scsi/hpsa drivers/scsi/qla2xxx \
           drivers/scsi/lpfc drivers/scsi/be2iscsi drivers/scsi/csiostor \
           drivers/scsi/bfa drivers/scsi/bnx2fc drivers/scsi/qedi \
           drivers/scsi/qedf drivers/scsi/fnic drivers/scsi/isci \
           fs/nfs fs/nfsd fs/cifs fs/ceph fs/smb_client fs/ksmbd \
           fs/btrfs fs/xfs fs/f2fs fs/reiserfs fs/jfs fs/hfs fs/hfsplus \
           fs/ocfs2 fs/ocfs2_dlm fs/isofs fs/udf fs/exfat fs/gfs2 && \
    depmod $KREL

# Create mount points for fstab-generated workspace.mount and WebDAV mount-share
RUN mkdir -p /workspace /host-workspace

# davfs2 config: no locking, no Expect:100 (SLIRP), short timeouts, cache on root fs
RUN mkdir -p /etc/davfs2 && \
    printf '[DEFAULT]\nuse_locks 0\nuse_expect100 0\nconnect_timeout 10\nread_timeout 30\ncache_dir /var/cache/davfs2\ncache_size 50\n' > /etc/davfs2/davfs2.conf && \
    chmod 0644 /etc/davfs2/davfs2.conf && chown 0:0 /etc/davfs2 /etc/davfs2/davfs2.conf

# Serial console: systemd serial-getty generator creates
# serial-getty@ttyS0.service when console=ttyS0 is on the kernel cmdline.
# Override it to add -a root (auto-login). agetty positional args are
# `baud_rate[,...] port [term]`, so the baud list comes first, then %I
# (the systemd instance name = ttyS0). Putting the port second is critical —
# `agetty --keep-baud 115200 115200 ttyS0` makes agetty treat the second
# 115200 as the port and fail with "cannot open /dev/115200".
RUN mkdir -p /etc/systemd/system/serial-getty@ttyS0.service.d && \
    printf '[Service]\nExecStart=\nExecStart=-/sbin/agetty -a root --keep-baud 115200,57600,38400,9600 %%I vt100\nType=idle\n' \
    > /etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf

# Mask unneeded systemd units that could stall in a VM with no hardware
RUN systemctl mask \
    bluetooth.service \
    wpa_supplicant.service \
    systemd-timesyncd.service \
    systemd-resolved.service \
    systemd-networkd-wait-online.service \
    fstrim.timer

# /etc/hosts and hostname are set in build-guest.sh after docker export
# (Docker overlayfs prevents in-place editing of /etc/hosts in the base image).
RUN echo sandbox > /etc/hostname

# motd
RUN printf '\nsandbox login ready (x86-64, Ubuntu 24.04)\n' > /etc/motd

# fstab: workspace qcow2 disk mounted at /workspace by systemd automagically
RUN printf '/dev/vdb  /workspace  ext4  defaults,noatime,nofail  0  2\n' >> /etc/fstab

# SSH: lightweight host key (ed25519-only), fast ciphers, root key auth
RUN rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub && \
    ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N '' && \
    printf 'HostKey /etc/ssh/ssh_host_ed25519_key\nPasswordAuthentication no\nPermitRootLogin prohibit-password\nClientAliveInterval 30\nCiphers chacha20-poly1305@openssh.com\nKexAlgorithms curve25519-sha256\nMACs umac-64-etm@openssh.com\n' > /etc/ssh/sshd_config && \
    mkdir -p /root/.ssh && chmod 700 /root/.ssh && \
    echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILoZlOBpFYYHSL2ZQzNABGxbs4P3DNmufyFiWG9EjJ03 vm-debug@valencebox' > /root/.ssh/authorized_keys && \
    chmod 600 /root/.ssh/authorized_keys

# DHCP on eth0 via dhcpcd (systemd-networkd is masked)
RUN systemctl enable dhcpcd

# Enable SSH
RUN systemctl enable ssh

# Copy systemd unit files for mount-share and workspace-sync
COPY etc/systemd/system/mount-share.service /etc/systemd/system/mount-share.service
COPY etc/systemd/system/workspace-sync.service /etc/systemd/system/workspace-sync.service
RUN systemctl enable mount-share && systemctl enable workspace-sync

# Copy helper scripts
COPY usr/local/libexec/mount-share.sh /usr/local/libexec/mount-share.sh
COPY usr/local/libexec/workspace-sync.sh /usr/local/libexec/workspace-sync.sh
RUN chmod +x /usr/local/libexec/mount-share.sh /usr/local/libexec/workspace-sync.sh

# Strip bloat
RUN rm -rf /usr/share/man /usr/share/doc /usr/share/info /usr/share/i18n \
    /usr/share/zoneinfo/iso3166.rst /usr/share/licenses \
    /var/cache/* /tmp/* /root/.cache /var/lib/apt/lists/*
